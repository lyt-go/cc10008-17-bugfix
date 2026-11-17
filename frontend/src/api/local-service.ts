import { MODULE_BY_KEY } from '@/data/modules'
import {
  allRows,
  listRows,
  readLifecycleState,
  resetLifecycleState,
  resetRows,
  saveLifecycleState,
  saveRows,
} from '@/data/local-store'
import {
  aggregateCycleResults,
  confirmDeactivationSnapshot,
  detectorState,
  ensureDetector,
  ensureTimewindow,
  lifecycleSummary,
  listCurrentAnomalies,
  listHistoricalAnomalies,
  propagateTimewindowDeactivation,
  readPeriodConfig,
  resolveDeactivationConflict,
  restoreReviewData,
  submitAdjudication,
  transitionDetector,
  updateFalsePositiveRate,
} from '@/data/anomaly-lifecycle'
import type { AggregationItem } from '@/data/anomaly-lifecycle'
import type {
  AnomalyLifecycleState,
  ConflictPolicy,
  ConflictReceipt,
  DetectorLifecycle,
  LifecycleOutcome,
  PeriodConfigReading,
  TimewindowRowLike,
} from '@/data/anomaly-types'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

const ANOMALY_KEY = 'anomaly'
const TIMEWINDOW_KEY = 'timewindow'
const ANOMALY_ENABLE_ACTION = '启用检测'
const ANOMALY_DISABLE_ACTION = '停用检测'
const TIMEWINDOW_DISABLE_ACTION = '停用配置'
const TIMEWINDOW_ENABLE_ACTION = '启用配置'

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  // 异常检测与时段分析带有跨模块联动语义，统一交给生命周期层处理。
  if (key === ANOMALY_KEY) {
    return runAnomalyAction(meta, rows[index], action)
  }
  if (key === TIMEWINDOW_KEY) {
    return runTimewindowAction(meta, rows[index], action)
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// ---------------------------------------------------------------------------
// 异常检测 / 时段分析的生命周期动作
// ---------------------------------------------------------------------------

function findRow(key: string, id: number): EntryRow | undefined {
  return listRows(key).find((row) => Number(row.id) === id)
}

/** 检测器联动到的第一个启用中时段配置（读取跨模块时段配置的入口）。 */
function linkedTimewindowId(detectorId: number): number | undefined {
  const lifecycle = readLifecycleState()
  const detector = detectorState(lifecycle, detectorId)
  const ids = detector?.linkage.timewindowIds ?? []
  for (const timewindowId of ids) {
    if (findRow(TIMEWINDOW_KEY, timewindowId)) {
      return timewindowId
    }
  }
  const fallback = listRows(TIMEWINDOW_KEY).find((row) => String(row.status) === '已启用')
  return fallback ? Number(fallback.id) : undefined
}

/** 把生命周期状态与行数据一起落盘；行数据先写，避免状态指向不存在的行。 */
function persistLifecycle(
  state: AnomalyLifecycleState,
  detectorId: number,
  patch?: { status: string; pending: boolean; abnormal: boolean },
  timewindowPatch?: { status: string; pending: boolean; abnormal: boolean },
): void {
  if (patch) {
    applyRowPatch(ANOMALY_KEY, detectorId, patch)
  }
  if (timewindowPatch) {
    const detector = detectorState(state, detectorId)
    const timewindowId = detector?.linkage.timewindowIds[0]
    if (timewindowId !== undefined) {
      applyRowPatch(TIMEWINDOW_KEY, timewindowId, timewindowPatch)
    }
  }
  saveLifecycleState(state)
}

function applyRowPatch(key: string, id: number, patch: { status: string; pending: boolean; abnormal: boolean }) {
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return
  }
  const next = [...rows]
  next[index] = { ...next[index], ...patch }
  saveRows(key, next)
}

function syncDetector(rows: EntryRow[], detectorId: number, timewindowId?: number): LifecycleOutcome {
  const lifecycle = readLifecycleState()
  const row = rows.find((item) => Number(item.id) === detectorId)
  if (!row) {
    return { state: lifecycle, ok: false, code: 'not-found', message: `没有找到编号为 ${detectorId} 的检测器`, changed: false }
  }
  let synced = ensureDetector(lifecycle, row).state
  const timewindows = timewindowId === undefined ? listRows(TIMEWINDOW_KEY) : [findRow(TIMEWINDOW_KEY, timewindowId)]
  for (const timewindow of timewindows) {
    if (!timewindow) {
      continue
    }
    synced = ensureTimewindow(synced, timewindow, [detectorId])
    const detector = synced.detectors[String(detectorId)]
    if (detector && !detector.linkage.timewindowIds.includes(Number(timewindow.id))) {
      detector.linkage.timewindowIds.push(Number(timewindow.id))
    }
  }
  return { state: synced, ok: true, code: 'ok', message: '', changed: false }
}

function runAnomalyAction(meta: ModuleMeta, row: EntryRow, action: string): ActionResult {
  const detectorId = Number(row.id)
  const rows = listRows(ANOMALY_KEY)
  const timewindowId = linkedTimewindowId(detectorId)
  const synced = syncDetector(rows, detectorId, timewindowId)
  if (!synced.ok) {
    return { ok: false, message: synced.message }
  }
  const lifecycle = synced.state
  const detector = detectorState(lifecycle, detectorId)

  if (action === ANOMALY_ENABLE_ACTION || action === ANOMALY_DISABLE_ACTION) {
    const result = transitionDetector(lifecycle, {
      detectorId,
      action: action === ANOMALY_ENABLE_ACTION ? 'enable' : 'disable',
      expectedRevision: detector?.revision,
      timewindowId,
    })
    return commitOutcome(result, detectorId, timewindowId)
  }

  // 其余动作（提交评审）沿用通用状态机，但仍同步生命周期中的状态。
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  if (String(row.status) === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  if (row.status === '已停用' && action !== ANOMALY_ENABLE_ACTION) {
    return { ok: false, message: '检测器已停用，旧周期结果不再参与流转' }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  applyRowPatch(ANOMALY_KEY, detectorId, {
    status: target,
    pending: target !== lastStatus,
    abnormal: false,
  })
  const next = ensureDetector(readLifecycleState(), { ...row, status: target }).state
  saveLifecycleState(next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

function runTimewindowAction(meta: ModuleMeta, row: EntryRow, action: string): ActionResult {
  const timewindowId = Number(row.id)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  if (String(row.status) === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const detectorIds = listRows(ANOMALY_KEY)
    .filter((detector) => String(detector.status) === '已启用')
    .map((detector) => Number(detector.id))
  let lifecycle = ensureTimewindow(readLifecycleState(), row, detectorIds)
  for (const detectorId of detectorIds) {
    lifecycle = ensureDetector(lifecycle, { ...listRows(ANOMALY_KEY).find((d) => Number(d.id) === detectorId)! }).state
    const detector = lifecycle.detectors[String(detectorId)]
    if (!detector.linkage.timewindowIds.includes(timewindowId)) {
      detector.linkage.timewindowIds.push(timewindowId)
    }
  }

  if (action === TIMEWINDOW_DISABLE_ACTION || action === TIMEWINDOW_ENABLE_ACTION) {
    const propagation = propagateTimewindowDeactivation(lifecycle, {
      timewindowId,
      action: action === TIMEWINDOW_DISABLE_ACTION ? 'deactivate' : 'activate',
    })
    if (!propagation.ok) {
      return { ok: false, message: propagation.message }
    }
    lifecycle = propagation.state
    const lastStatus = meta.statuses[meta.statuses.length - 1]
    applyRowPatch(TIMEWINDOW_KEY, timewindowId, {
      status: target,
      pending: target !== lastStatus,
      abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
    })
    saveLifecycleState(lifecycle)
    return {
      ok: true,
      message:
        action === TIMEWINDOW_DISABLE_ACTION
          ? `${meta.entity}已停用，联动检测器不再新增当前异常`
          : `${meta.entity}已启用，联动检测器恢复接收当前异常`,
    }
  }

  const lastStatus = meta.statuses[meta.statuses.length - 1]
  applyRowPatch(TIMEWINDOW_KEY, timewindowId, {
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  })
  saveLifecycleState(lifecycle)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

function commitOutcome(
  result: LifecycleOutcome<unknown>,
  detectorId: number,
  timewindowId?: number,
): ActionResult {
  if (result.ok) {
    persistLifecycle(result.state, detectorId, result.rowPatch)
    return { ok: true, message: result.message }
  }
  // 拒绝也要落冲突回执：不改进度，也不覆盖历史误报率。
  saveLifecycleState(result.state)
  const suffix = timewindowId === undefined ? '' : '，冲突回执已写回时段异常联动入口'
  return {
    ok: false,
    message: `${result.message}（${result.code}${suffix}）`,
    code: result.code,
    conflictId: result.receipt?.receiptId,
    detectorId,
  }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  if (key === ANOMALY_KEY) {
    resetLifecycleState()
  }
  return listEntries(key)
}

// ---------------------------------------------------------------------------
// 异常检测生命周期 API（页面只渲染，读写都在这里）
// ---------------------------------------------------------------------------

export type AnomalyLifecycleView = {
  detectorId: number
  detectorCode: string
  status: string
  enabled: boolean
  revision: number
  dataRevision: number
  currentCycleId: string
  currentAnomalies: ReturnType<typeof listCurrentAnomalies>
  historicalAnomalies: ReturnType<typeof listHistoricalAnomalies>
  summary: ReturnType<typeof lifecycleSummary>
  falsePositiveRate: string
  falsePositiveRateFrozen: boolean
  rectificationList: DetectorLifecycle['rectificationList']
  historicalReviewList: DetectorLifecycle['historicalReviewList']
  pendingSnapshot: DetectorLifecycle['pendingSnapshot']
  conflictQueue: ConflictReceipt[]
  adjudicationList: DetectorLifecycle['adjudicationList']
  reviewDataList: DetectorLifecycle['reviewDataList']
  periodConfigs: PeriodConfigReading[]
}

/** 读取检测器的完整生命周期视图；会顺带把种子行同步进生命周期。 */
export function loadAnomalyLifecycle(detectorId: number): AnomalyLifecycleView | null {
  const row = findRow(ANOMALY_KEY, detectorId)
  if (!row) {
    return null
  }
  const lifecycle = syncDetector(listRows(ANOMALY_KEY), detectorId).state
  saveLifecycleState(lifecycle)
  const detector = detectorState(lifecycle, detectorId)
  if (!detector) {
    return null
  }
  const periodConfigs = (detector.linkage.timewindowIds.length
    ? detector.linkage.timewindowIds
    : listRows(TIMEWINDOW_KEY).map((item) => Number(item.id))
  ).map((timewindowId) =>
    readPeriodConfig(lifecycle, {
      detectorId,
      timewindowRow: findRow(TIMEWINDOW_KEY, timewindowId),
    }),
  )
  return {
    detectorId,
    detectorCode: detector.detectorCode,
    status: detector.status,
    enabled: detector.enabled,
    revision: detector.revision,
    dataRevision: detector.dataRevision,
    currentCycleId: detector.currentCycle?.cycleId ?? '',
    currentAnomalies: listCurrentAnomalies(lifecycle, detectorId),
    historicalAnomalies: listHistoricalAnomalies(lifecycle, detectorId),
    summary: lifecycleSummary(lifecycle, detectorId)!,
    falsePositiveRate: detector.falsePositiveRate.value,
    falsePositiveRateFrozen: detector.falsePositiveRate.frozen,
    rectificationList: detector.rectificationList,
    historicalReviewList: detector.historicalReviewList,
    pendingSnapshot: detector.pendingSnapshot,
    conflictQueue: detector.conflictQueue,
    adjudicationList: detector.adjudicationList,
    reviewDataList: detector.reviewDataList,
    periodConfigs,
  }
}

function lifecycleFor(detectorId: number): AnomalyLifecycleState {
  return syncDetector(listRows(ANOMALY_KEY), detectorId, linkedTimewindowId(detectorId)).state
}

function lifecycleStep(
  detectorId: number,
  step: (lifecycle: AnomalyLifecycleState, timewindowId?: number) => LifecycleOutcome<unknown>,
): ActionResult & { state: AnomalyLifecycleState } {
  const timewindowId = linkedTimewindowId(detectorId)
  const lifecycle = lifecycleFor(detectorId)
  const result = step(lifecycle, timewindowId)
  saveLifecycleState(result.state)
  return {
    ...result,
    ok: result.ok,
    message: result.message,
    code: result.code,
    conflictId: result.receipt?.receiptId,
    detectorId,
  } as ActionResult & { state: AnomalyLifecycleState }
}

/** 写一串当前周期结果；停用后的调用只会拿到冲突回执。 */
export function aggregateAnomalyResults(
  detectorId: number,
  results: AggregationItem[],
  dataRevision?: number,
): ActionResult {
  return lifecycleStep(detectorId, (lifecycle, timewindowId) =>
    aggregateCycleResults(lifecycle, { detectorId, dataRevision, results, timewindowId }),
  )
}

/** 提交修复恢复的异常时段判定数据清单（并发同键只落首份）。 */
export function submitAnomalyAdjudication(input: {
  detectorId: number
  timewindowId: number
  periodKey: string
  requestKey: string
  expectedRevision?: number
}): ActionResult {
  return lifecycleStep(input.detectorId, (lifecycle) =>
    submitAdjudication(lifecycle, { ...input, timewindowId: input.timewindowId }),
  )
}

/** 跨模块读取时段配置与异常时段清单，按判定清单恢复复核数据清单。 */
export function restoreAnomalyReviewData(detectorId: number, timewindowId: number): ActionResult {
  const lifecycle = lifecycleFor(detectorId)
  const result = restoreReviewData(lifecycle, {
    detectorId,
    timewindowRow: findRow(TIMEWINDOW_KEY, timewindowId),
  })
  saveLifecycleState(result.state)
  return {
    ok: result.ok,
    message: result.message,
    code: result.code,
    conflictId: result.receipt?.receiptId,
    detectorId,
  }
}

/** 版本冲突仲裁：停用终态 / 历史周期保留。 */
export function resolveAnomalyDeactivationConflict(
  detectorId: number,
  policy: ConflictPolicy,
): ActionResult {
  return lifecycleStep(detectorId, (lifecycle, timewindowId) =>
    resolveDeactivationConflict(lifecycle, { detectorId, policy, timewindowId }),
  )
}

/** 确认停用待确认快照：只读留存，检测器保持停用，不产生当前异常。 */
export function confirmAnomalyDeactivationSnapshot(detectorId: number): ActionResult {
  return lifecycleStep(detectorId, (lifecycle, timewindowId) =>
    confirmDeactivationSnapshot(lifecycle, { detectorId, timewindowId }),
  )
}

/** 更新误报率；停用后冻结，拒绝写入并回冲突队列。 */export function updateAnomalyFalsePositiveRate(
  detectorId: number,
  value: string,
  expectedRevision?: number,
): ActionResult {
  return lifecycleStep(detectorId, (lifecycle, timewindowId) =>
    updateFalsePositiveRate(lifecycle, { detectorId, value, expectedRevision, timewindowId }),
  )
}

/** 跨模块读取：时段配置 + 检测器状态 + 异常时段清单，页面用来展示“是否还会新增”。 */
export function readAnomalyPeriodConfig(detectorId: number, timewindowId: number): PeriodConfigReading {
  return readPeriodConfig(readLifecycleState(), {
    detectorId,
    timewindowRow: findRow(TIMEWINDOW_KEY, timewindowId),
  })
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
