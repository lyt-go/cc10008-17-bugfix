/**
 * 异常检测生命周期：停用传播、历史周期只读、乐观并发与跨模块时段联动。
 *
 * 这里是纯函数数据层：不碰 window / DOM，状态进出都是可序列化对象，方便持久化与单测。
 * 关键底线（所有仲裁分支都必须满足）：
 *   1. 检测器一旦停用，绝不再写入新的“当前异常”。
 *   2. 停用/冲突的拒绝回执不改变检测器版本，也不覆盖历史误报率。
 *   3. 停用只把当前周期冻结为只读历史，历史周期永不因后续汇总而被改写。
 */
import type {
  AdjudicationRecord,
  AnomalyCycle,
  AnomalyLifecycleState,
  AnomalyResult,
  ConflictKind,
  ConflictPolicy,
  ConflictReceipt,
  DeactivationSnapshot,
  DetectorLifecycle,
  DetectorRowLike,
  HistoricalReviewItem,
  LifecycleCode,
  LifecycleOutcome,
  LinkageReceipt,
  PeriodConfigReading,
  PeriodConfigRef,
  RectificationItem,
  ReviewDataRecord,
  RowPatch,
  TimewindowLinkage,
  TimewindowRowLike,
} from './anomaly-types'

type Clock = string

const ENABLED = '已启用'
const DISABLED = '已停用'

/** 用 JSON 深拷贝保证 reducer 不意外改到入参。 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function now(at?: Clock): Clock {
  return at ?? new Date().toISOString()
}

function emptyCycle(detectorId: number, cycleId: string, at: Clock): AnomalyCycle {
  return {
    cycleId,
    kind: 'current',
    openedAt: at,
    readOnly: false,
    results: [],
  }
}

export function emptyLifecycle(): AnomalyLifecycleState {
  return { schemaVersion: 1, sequence: 0, detectors: {}, linkages: {}, conflictQueue: [] }
}

export function detectorState(state: AnomalyLifecycleState, detectorId: number): DetectorLifecycle | undefined {
  return state.detectors[String(detectorId)]
}

/** 从检测器行同步出生命周期壳；已存在的状态保留修订号，不覆盖生命周期状态。 */
export function ensureDetector(
  state: AnomalyLifecycleState,
  row: DetectorRowLike,
  at?: Clock,
): { state: AnomalyLifecycleState; detector: DetectorLifecycle } {
  const next = clone(state)
  const key = String(row.id)
  const existing = next.detectors[key]
  if (existing) {
    return { state: next, detector: existing }
  }
  const stamp = now(at)
  const detector: DetectorLifecycle = {
    detectorId: row.id,
    detectorCode: String(row['检测器编号'] ?? `ANOM-${String(row.id).padStart(4, '0')}`),
    revision: 1,
    dataRevision: 0,
    status: row.status,
    enabled: row.status === ENABLED,
    openedAt: stamp,
    enabledAt: row.status === ENABLED ? stamp : undefined,
    falsePositiveRate: {
      value: String(row['误报率'] ?? ''),
      updatedAt: stamp,
      revision: 1,
      frozen: row.status === DISABLED,
    },
    currentCycle:
      row.status === ENABLED ? emptyCycle(row.id, `CYCLE-${row.id}-1`, stamp) : null,
    historicalCycles: [],
    rectificationList: [],
    historicalReviewList: [],
    pendingSnapshot: null,
    conflictQueue: [],
    adjudicationList: [],
    reviewDataList: [],
    appliedRequests: {},
    linkage: {
      timewindowIds: [],
      active: row.status === ENABLED,
      suppressed: row.status !== ENABLED,
      suppressReason: row.status === DISABLED ? '检测器已停用' : undefined,
    },
  }
  next.detectors[key] = detector
  return { state: next, detector }
}

export function ensureTimewindow(
  state: AnomalyLifecycleState,
  row: TimewindowRowLike,
  detectorIds: number[],
): AnomalyLifecycleState {
  const next = clone(state)
  const key = String(row.id)
  const existing = next.linkages[key]
  const linkage: TimewindowLinkage = existing ?? {
    timewindowId: row.id,
    configCode: String(row['配置编号'] ?? `TIME-${String(row.id).padStart(4, '0')}`),
    detectorLinks: {},
    receipts: [],
  }
  linkage.configCode = String(row['配置编号'] ?? linkage.configCode)
  for (const detectorId of detectorIds) {
    const linkKey = String(detectorId)
    if (!linkage.detectorLinks[linkKey]) {
      const detectorEnabled = !!next.detectors[linkKey]?.enabled
      const configActive = String(row.status) === ENABLED
      linkage.detectorLinks[linkKey] = {
        timewindowId: row.id,
        detectorId,
        active: configActive && detectorEnabled,
        suppressed: !configActive,
        updatedAt: now(),
      }
    }
  }
  next.linkages[key] = linkage
  return next
}

function nextSequence(state: AnomalyLifecycleState): { state: AnomalyLifecycleState; sequence: number } {
  const sequence = state.sequence + 1
  return { state: { ...state, sequence }, sequence }
}

function pad(sequence: number): string {
  return String(sequence).padStart(4, '0')
}

function reject(
  state: AnomalyLifecycleState,
  detectorId: number,
  kind: ConflictKind,
  action: string,
  expectedRevision: number,
  actualRevision: number,
  message: string,
  at?: Clock,
  timewindowId?: number,
  payload?: ConflictReceipt['payload'],
): LifecycleOutcome {  const stamp = now(at)
  let next = clone(state)
  const seqState = nextSequence(next)
  next = seqState.state
  const receipt: ConflictReceipt = {
    receiptId: `CONF-${pad(seqState.sequence)}`,
    detectorId,
    kind,
    action,
    expectedRevision,
    actualRevision,
    at: stamp,
    message,
    accepted: false,
    queue: 'conflict',
    linkageReceiptIds: [],
    payload: payload ? clone(payload) : undefined,
  }
  const detector = next.detectors[String(detectorId)]
  if (detector) {
    detector.conflictQueue.push(receipt)
  }
  next.conflictQueue.push(receipt)

  const codes: Record<ConflictKind, LifecycleCode> = {
    'version-conflict': 'version-conflict',
    'enable-disable-race': 'already-enabled',
    'stale-aggregation': 'version-conflict',
    'disabled-write': 'disabled-write',
    'historical-frozen': 'historical-frozen',
    'duplicate-submit': 'duplicate-submit',
    'duplicate-result': 'duplicate-result',
    'invalid-transition': 'invalid-transition',
  }

  if (typeof timewindowId === 'number') {
    const linkageId = writeLinkageReceipt(next, timewindowId, {
      detectorId,
      kind: 'conflict',
      accepted: false,
      message: `${message}（${receipt.receiptId}）`,
      at: stamp,
      conflictReceiptId: receipt.receiptId,
    })
    const written = next.linkages[String(timewindowId)]
    const linkReceipt = written?.receipts[written.receipts.length - 1]
    if (linkReceipt) {
      receipt.linkageReceiptIds.push(linkReceipt.receiptId)
    }
    const link = written?.detectorLinks[String(detectorId)]
    if (link) {
      link.lastReceiptId = linkReceipt?.receiptId ?? linkageId
    }
  }

  return {
    state: next,
    ok: false,
    code: codes[kind],
    message,
    changed: false,
    receipt,
  }
}

function writeLinkageReceipt(
  state: AnomalyLifecycleState,
  timewindowId: number,
  input: Omit<LinkageReceipt, 'receiptId' | 'timewindowId'>,
): string {
  const key = String(timewindowId)
  const linkage = state.linkages[key]
  if (!linkage) {
    return ''
  }
  const seq = nextSequence(state)
  const receiptId = `LINK-${pad(seq.sequence)}`
  state.sequence = seq.sequence
  linkage.receipts.push({ ...input, receiptId, timewindowId })
  return receiptId
}

function detectorPatch(enabled: boolean): RowPatch {
  // 已停用是状态机的终态：停用后 pending=false（无需再处理），只保留异常标记；
  // 重新启用才需要回到待处理队列。
  return {
    status: enabled ? ENABLED : DISABLED,
    pending: enabled,
    abnormal: !enabled,
  }
}

/** 检测器结构修订校验：修订号不匹配一律拒绝，且不改动历史误报率。 */
function checkRevision(
  state: AnomalyLifecycleState,
  detector: DetectorLifecycle,
  expectedRevision: number | undefined,
  action: string,
  at?: Clock,
  timewindowId?: number,
): LifecycleOutcome | null {
  if (expectedRevision === undefined) {
    return null
  }
  if (expectedRevision === detector.revision) {
    return null
  }
  return reject(
    state,
    detector.detectorId,
    'version-conflict',
    action,
    expectedRevision,
    detector.revision,
    `检测器版本已变为 ${detector.revision}，请求基于 ${expectedRevision} 已失效，变更未受理`,
    at,
    timewindowId,
  )
}

/** 并发启用 / 停用：同一修订只接受第一个有效变更，其余进冲突队列。 */
export function transitionDetector(
  state: AnomalyLifecycleState,
  input: {
    detectorId: number
    action: 'enable' | 'disable'
    expectedRevision?: number
    at?: Clock
    timewindowId?: number
  },
): LifecycleOutcome {
  const detector = state.detectors[String(input.detectorId)]
  if (!detector) {
    return {
      state,
      ok: false,
      code: 'not-found',
      message: `没有找到编号为 ${input.detectorId} 的检测器`,
      changed: false,
    }
  }
  const stamp = now(input.at)
  const actionLabel = input.action === 'enable' ? '启用检测' : '停用检测'
  const stale = checkRevision(state, detector, input.expectedRevision, actionLabel, input.at, input.timewindowId)
  if (stale) {
    return stale
  }

  if (input.action === 'enable') {
    if (detector.enabled) {
      return reject(
        state,
        detector.detectorId,
        'enable-disable-race',
        actionLabel,
        input.expectedRevision ?? detector.revision,
        detector.revision,
        '检测器已处于启用状态，并发启用请求只接受一次有效变更，另一请求被拒绝',
        input.at,
        input.timewindowId,
      )
    }
    const next = clone(state)
    const target = next.detectors[String(input.detectorId)]
    target.revision += 1
    target.enabled = true
    target.status = ENABLED
    target.enabledAt = stamp
    target.deactivatedAt = undefined
    if (target.pendingSnapshot?.status === '停用待确认') {
      // 重新启用即视为对上一次停用的确认：快照只读留存，不再阻塞启用。
      target.pendingSnapshot = { ...target.pendingSnapshot, status: '已确认', readOnly: true }
    }
    target.linkage.active = true
    target.linkage.suppressed = false
    target.linkage.suppressReason = undefined
    target.falsePositiveRate = { ...target.falsePositiveRate, frozen: false }
    // 新开周期即视为数据版本变更：停用期内到达的旧汇总不能再写进来。
    target.dataRevision += 1
    const cycleNumber = target.historicalCycles.length + 1
    target.currentCycle = emptyCycle(target.detectorId, `CYCLE-${target.detectorId}-${cycleNumber}`, stamp)
    if (input.timewindowId !== undefined) {
      writeLinkageReceipt(next, input.timewindowId, {
        detectorId: target.detectorId,
        kind: 'detector-activation',
        accepted: true,
        message: `${target.detectorCode} 已启用`,
        at: stamp,
      })
    }
    return {
      state: next,
      ok: true,
      code: 'ok',
      message: `${target.detectorCode} 已启用，当前周期为 ${target.currentCycle.cycleId}`,
      changed: true,
      rowPatch: detectorPatch(true),
    }
  }

  // disable：冻结当前周期、产出台账、快照，并广播停用回执。
  if (!detector.enabled) {
    if (detector.status === DISABLED) {
      return reject(
        state,
        detector.detectorId,
        'invalid-transition',
        actionLabel,
        input.expectedRevision ?? detector.revision,
        detector.revision,
        '检测器已停用，重复停用请求被拒绝',
        input.at,
        input.timewindowId,
      )
    }
    return reject(
      state,
      detector.detectorId,
      'invalid-transition',
      actionLabel,
      input.expectedRevision ?? detector.revision,
      detector.revision,
      '检测器尚未启用，不能停用',
      input.at,
      input.timewindowId,
    )
  }

  const next = clone(state)
  const target = next.detectors[String(input.detectorId)]
  const cycle = target.currentCycle
  const liveResults = cycle ? cycle.results.filter((result) => !result.invalidated) : []
  target.revision += 1
  target.enabled = false
  target.status = DISABLED
  target.deactivatedAt = stamp
  target.linkage.active = false
  target.linkage.suppressed = true
  target.linkage.suppressReason = '检测器已停用'
  target.falsePositiveRate = { ...target.falsePositiveRate, frozen: true, updatedAt: stamp }
  target.currentCycle = null
  // 冻结当前周期同样是数据版本变更：停用前发出的旧周期汇总到达时会被识别为并发冲突。
  target.dataRevision += 1

  if (cycle) {
    // 停用传播：故障期间误读时段配置/检测器产生的校准偏差结果在冻结时一并失效，
    // 只保留审计痕迹，不再进入整改清单和任何汇总。
    const frozen: AnomalyCycle = {
      ...cycle,
      kind: 'historical',
      readOnly: true,
      closedAt: stamp,
      results: cycle.results.map((result) => ({
        ...result,
        invalidated: result.invalidated || result.source === 'faulty-read',
      })),
    }
    target.historicalCycles.push(frozen)

    const validResults = frozen.results.filter((result) => !result.invalidated)
    target.rectificationList.push(
      ...validResults.map<RectificationItem>((result) => ({
        itemId: `RECT-${result.resultId}`,
        detectorId: target.detectorId,
        cycleId: frozen.cycleId,
        resultId: result.resultId,
        event: result.event,
        deviation: result.deviation,
        status: '待整改',
        createdAt: stamp,
      })),
    )

    target.historicalReviewList.push({
      reviewId: `HREV-${frozen.cycleId}`,
      detectorId: target.detectorId,
      cycleId: frozen.cycleId,
      resultCount: validResults.length,
      falsePositiveRate: target.falsePositiveRate.value,
      status: '待复核',
      createdAt: stamp,
    })

    target.pendingSnapshot = {
      snapshotId: `SNAP-${frozen.cycleId}`,
      detectorId: target.detectorId,
      createdAt: stamp,
      revision: target.revision,
      status: '停用待确认',
      currentCycleId: frozen.cycleId,
      resultCount: validResults.length,
      conflictIds: target.conflictQueue.filter((receipt) => !receipt.accepted).map((r) => r.receiptId),
      readOnly: true,
      policy: 'deactivation-terminal',
    }
  }

  if (input.timewindowId !== undefined) {
    const receiptId = writeLinkageReceipt(next, input.timewindowId, {
      detectorId: target.detectorId,
      kind: 'detector-deactivation',
      accepted: true,
      message: `${target.detectorCode} 已停用，后续不再写入当前异常`,
      at: stamp,
    })
    const link = next.linkages[String(input.timewindowId)]?.detectorLinks[String(target.detectorId)]
    if (link) {
      link.active = false
      link.suppressed = true
      link.updatedAt = stamp
      link.lastReceiptId = receiptId
    }
  }

  // 故障误读的“修复恢复”判定清单随停用一起失效，不再用于恢复复核数据。
  for (const adjudication of target.adjudicationList) {
    if (adjudication.status === '已生效') {
      adjudication.status = '已失效'
    }
  }

  return {
    state: next,
    ok: true,
    code: 'ok',
    message: `${target.detectorCode} 已停用，当前周期冻结为只读历史，停用回执已写回时段联动入口`,
    changed: true,
    rowPatch: detectorPatch(false),
  }
}

/**
 * 版本冲突仲裁：停用终态 / 历史周期保留。
 *
 * 两种做法都必须满足“停用后不再产生新的当前异常”：
 *   - deactivation-terminal：停用为终态，冲突中的待汇总旧周期数据直接丢弃，只保留审计回执；
 *   - historical-retention：冲突中的旧周期结果转入只读历史周期并进入历史复核清单，绝不回写当前周期。
 */
export function resolveDeactivationConflict(
  state: AnomalyLifecycleState,
  input: {
    detectorId: number
    policy: ConflictPolicy
    at?: Clock
    timewindowId?: number
  },
): LifecycleOutcome<{ snapshot: DeactivationSnapshot | null }> {
  const detector = state.detectors[String(input.detectorId)]
  if (!detector) {
    return {
      state,
      ok: false,
      code: 'not-found',
      message: `没有找到编号为 ${input.detectorId} 的检测器`,
      changed: false,
    }
  }
  if (detector.enabled) {
    return {
      state,
      ok: false,
      code: 'invalid-transition',
      message: '检测器仍在启用状态，没有可仲裁的停用冲突',
      changed: false,
    }
  }
  const stamp = now(input.at)
  const next = clone(state)
  const target = next.detectors[String(input.detectorId)]

  const queued = target.conflictQueue.filter(
    (receipt) =>
      !receipt.accepted &&
      !receipt.resolved &&
      (receipt.kind === 'version-conflict' || receipt.kind === 'stale-aggregation'),
  )
  const conflictIds = queued.map((receipt) => receipt.receiptId)
  const oldCycleResults = queued.flatMap((receipt) => receipt.payload?.results ?? [])
  for (const receipt of target.conflictQueue) {
    if (queued.some((item) => item.receiptId === receipt.receiptId)) {
      receipt.resolved = true
    }
  }
  const globalById = new Map(next.conflictQueue.map((receipt) => [receipt.receiptId, receipt]))
  for (const receipt of queued) {
    const global = globalById.get(receipt.receiptId)
    if (global) {
      global.resolved = true
    }
  }

  if (input.policy === 'historical-retention' && oldCycleResults.length > 0) {
    const retained: AnomalyCycle = {
      cycleId: `CYCLE-${target.detectorId}-R${target.historicalCycles.length + 1}`,
      kind: 'historical',
      openedAt: stamp,
      closedAt: stamp,
      readOnly: true,
      results: oldCycleResults.map((result) => ({ ...result, invalidated: result.invalidated })),
    }
    target.historicalCycles.push(retained)
    target.historicalReviewList.push({
      reviewId: `HREV-${retained.cycleId}`,
      detectorId: target.detectorId,
      cycleId: retained.cycleId,
      resultCount: retained.results.filter((result) => !result.invalidated).length,
      falsePositiveRate: target.falsePositiveRate.value,
      status: '待复核',
      createdAt: stamp,
    })
    // 旧周期结果只进历史复核，不进整改清单，也不进入任何当前周期。
    target.rectificationList.push(
      ...retained.results.map<RectificationItem>((result) => ({
        itemId: `RECT-${result.resultId}`,
        detectorId: target.detectorId,
        cycleId: retained.cycleId,
        resultId: result.resultId,
        event: result.event,
        deviation: result.deviation,
        status: '待整改',
        createdAt: stamp,
      })),
    )
  }

  target.pendingSnapshot = {
    snapshotId: target.pendingSnapshot?.snapshotId ?? `SNAP-${target.detectorId}-${target.revision}`,
    detectorId: target.detectorId,
    createdAt: target.pendingSnapshot?.createdAt ?? stamp,
    revision: target.revision,
    status: '停用待确认',
    currentCycleId: target.pendingSnapshot?.currentCycleId ?? '',
    resultCount: target.pendingSnapshot?.resultCount ?? 0,
    conflictIds: [...new Set([...(target.pendingSnapshot?.conflictIds ?? []), ...conflictIds])],
    readOnly: true,
    policy: input.policy,
  }

  if (input.timewindowId !== undefined) {
    const receiptId = writeLinkageReceipt(next, input.timewindowId, {
      detectorId: target.detectorId,
      kind: 'deactivation',
      accepted: true,
      message:
        input.policy === 'deactivation-terminal'
          ? '按停用终态仲裁：冲突中的旧周期汇总被丢弃，停用不回滚'
          : '按历史周期保留仲裁：冲突中的旧周期结果转入只读历史，停用不回滚',
      at: stamp,
    })
    const link = next.linkages[String(input.timewindowId)]?.detectorLinks[String(target.detectorId)]
    if (link) {
      link.lastReceiptId = receiptId
      link.suppressed = true
      link.active = false
      link.updatedAt = stamp
    }
  }

  return {
    state: next,
    ok: true,
    code: 'ok',
    message:
      input.policy === 'deactivation-terminal'
        ? '冲突按停用终态仲裁完成，未写入新的当前异常'
        : '冲突按历史周期保留仲裁完成，旧周期结果只读留存，未写入新的当前异常',
    changed: true,
    data: { snapshot: target.pendingSnapshot },
  }
}

/** 刷新历史误报率：停用冻结后一律拒绝，不得被并发请求覆盖。 */
export function updateFalsePositiveRate(
  state: AnomalyLifecycleState,
  input: {
    detectorId: number
    expectedRevision?: number
    value: string
    at?: Clock
    timewindowId?: number
  },
): LifecycleOutcome {
  const detector = state.detectors[String(input.detectorId)]
  if (!detector) {
    return {
      state,
      ok: false,
      code: 'not-found',
      message: `没有找到编号为 ${input.detectorId} 的检测器`,
      changed: false,
    }
  }
  if (!detector.enabled || detector.falsePositiveRate.frozen) {
    return reject(
      state,
      detector.detectorId,
      'disabled-write',
      '更新误报率',
      input.expectedRevision ?? detector.revision,
      detector.revision,
      '检测器已停用，历史误报率已冻结，拒绝写入',
      input.at,
      input.timewindowId,
    )
  }
  const stale = checkRevision(state, detector, input.expectedRevision, '更新误报率', input.at, input.timewindowId)
  if (stale) {
    return stale
  }
  const next = clone(state)
  const target = next.detectors[String(input.detectorId)]
  target.falsePositiveRate = {
    value: input.value,
    updatedAt: now(input.at),
    revision: target.falsePositiveRate.revision + 1,
    frozen: false,
  }
  return { state: next, ok: true, code: 'ok', message: '误报率已更新', changed: true }
}

export type AggregationItem = {
  resultKey: string
  event: string
  metric: string
  value: number
  baseline: number
  deviation: number
  severity?: '低' | '中' | '高'
  timewindowId?: number
  periodKey?: string
  source?: 'live' | 'restored' | 'faulty-read'
  invalidated?: boolean
  /** 调用方声明的归属周期；与当前周期不一致时整条拒绝，不允许写入当前周期。 */
  cycleId?: string
}

/** 周期结果汇总。只有启用中的检测器 + 可写的当前周期能落数据；
 * 旧周期 / 停用后 / 版本过期的汇总一律回冲突队列。
 *
 * 故障修复点：结果归属的周期与时段配置一律以检测器当前状态为准，
 * 不接受调用方传入的历史周期号，避免旧周期 / 已停用时段被误读为当前周期。
 */
export function aggregateCycleResults(
  state: AnomalyLifecycleState,
  input: {
    detectorId: number
    dataRevision?: number
    results: AggregationItem[]
    at?: Clock
    timewindowId?: number
  },
): LifecycleOutcome<{ written: number; skipped: number }> {
  const detector = state.detectors[String(input.detectorId)]
  if (!detector) {
    return {
      state,
      ok: false,
      code: 'not-found',
      message: `没有找到编号为 ${input.detectorId} 的检测器`,
      changed: false,
    }
  }
  if (!detector.enabled || detector.status === DISABLED) {
    // 停用终态下到达的旧周期汇总：仍要带上数据版本，仲裁时才能识别为“停用与旧周期并发”。
    const staleVersion = input.dataRevision !== undefined && input.dataRevision !== detector.dataRevision
    const payload: ConflictReceipt['payload'] | undefined = staleVersion
      ? {
          cycleId: detector.currentCycle?.cycleId ?? '',
          results: input.results.map((item) =>
            toResult(detector.detectorId, item, detector.currentCycle?.cycleId ?? '', now(input.at)),
          ),
        }
      : undefined
    return {
      ...reject(
        state,
        detector.detectorId,
        staleVersion ? 'stale-aggregation' : 'disabled-write',
        '周期结果汇总',
        input.dataRevision ?? detector.dataRevision,
        detector.dataRevision,
        staleVersion
          ? '停用与旧周期汇总并发，汇总结果进入冲突队列等待停用仲裁'
          : '检测器已停用，汇总结果被拒绝，不写入新的当前异常',
        input.at,
        input.timewindowId,
        payload,
      ),
      data: { written: 0, skipped: input.results.length },
    }
  }
  if (input.dataRevision !== undefined && input.dataRevision !== detector.dataRevision) {
    const cycleId = detector.currentCycle?.cycleId ?? ''
    const payload: NonNullable<ConflictReceipt['payload']> = {
      cycleId,
      results: input.results.map((item) => toResult(detector.detectorId, item, cycleId, now(input.at))),
    }
    return {
      ...reject(
        state,
        detector.detectorId,
        'stale-aggregation',
        '周期结果汇总',
        input.dataRevision,
        detector.dataRevision,
        '汇总基于已过期的周期数据版本，结果进入冲突队列等待仲裁',
        input.at,
        input.timewindowId,
        payload,
      ),
      data: { written: 0, skipped: input.results.length },
    }
  }
  if (!detector.currentCycle) {
    return {
      ...reject(
        state,
        detector.detectorId,
        'disabled-write',
        '周期结果汇总',
        input.dataRevision ?? detector.dataRevision,
        detector.dataRevision,
        '当前周期已冻结，汇总结果被拒绝',
        input.at,
        input.timewindowId,
      ),
      data: { written: 0, skipped: input.results.length },
    }
  }

  const next = clone(state)
  const target = next.detectors[String(input.detectorId)]
  const cycle = target.currentCycle as AnomalyCycle
  const existingKeys = new Set(cycle.results.map((result) => result.resultId))
  const stamp = now(input.at)
  let written = 0
  const duplicates: string[] = []
  const deniedResults: AnomalyResult[] = []

  for (const item of input.results) {
    const result = toResult(target.detectorId, item, cycle.cycleId, stamp)
    if (existingKeys.has(result.resultId)) {
      duplicates.push(result.resultId)
      continue
    }
    // 历史周期号只允许在历史只读视图里出现；写进当前周期前必须丢弃。
    if (item.cycleId !== undefined && item.cycleId !== cycle.cycleId) {
      deniedResults.push({ ...result, source: 'faulty-read', invalidated: true })
      continue
    }
    // 时段配置必须仍处于联动可用状态，否则这次读到的时段是失效口径。
    if (item.timewindowId !== undefined && !timewindowAcceptsResults(next, item.timewindowId, target.detectorId)) {
      deniedResults.push({ ...result, source: 'faulty-read', invalidated: true })
      continue
    }
    existingKeys.add(result.resultId)
    cycle.results.push(result)
    written += 1
  }

  if (written > 0) {
    target.dataRevision += 1
  }
  if ((written > 0 || deniedResults.length > 0) && input.timewindowId !== undefined) {
    writeLinkageReceipt(next, input.timewindowId, {
      detectorId: target.detectorId,
      kind: 'aggregation',
      accepted: written > 0,
      message:
        written > 0
          ? `当前周期 ${cycle.cycleId} 写入 ${written} 条结果`
          : `汇总未写入当前周期，拒绝 ${deniedResults.length} 条历史/失效时段结果`,
      at: stamp,
    })
  }

  let latest = next
  let lastReceipt: ConflictReceipt | undefined
  for (const denied of deniedResults) {
    const rejected = reject(
      latest,
      target.detectorId,
      'historical-frozen',
      '周期结果汇总',
      input.dataRevision ?? target.dataRevision,
      target.dataRevision,
      `结果 ${denied.resultId} 指向历史周期，不得写入当前周期`,
      input.at,
      input.timewindowId,
    )
    latest = rejected.state
    lastReceipt = rejected.receipt
  }
  for (const duplicate of duplicates) {
    const denied = reject(
      latest,
      target.detectorId,
      'duplicate-result',
      '周期结果汇总',
      input.dataRevision ?? target.dataRevision,
      target.dataRevision,
      `结果 ${duplicate} 已存在于当前周期，重复结果退回冲突队列，只保留首份`,
      input.at,
      input.timewindowId,
    )
    latest = denied.state
    lastReceipt = denied.receipt
  }

  return {
    state: latest,
    ok: written > 0,
    code: written > 0 ? 'ok' : duplicates.length ? 'duplicate-result' : deniedResults.length ? 'historical-frozen' : 'ok',
    message: `写入 ${written} 条当前周期结果，拒绝 ${deniedResults.length} 条历史周期结果，跳过 ${duplicates.length} 条重复结果`,
    changed: written > 0 || duplicates.length > 0 || deniedResults.length > 0,
    receipt: lastReceipt,
    data: { written, skipped: duplicates.length },
  }
}

/** 当前周期是否还能接收该时段的异常结果（时段启用且联动未挂起）。 */
function timewindowAcceptsResults(
  state: AnomalyLifecycleState,
  timewindowId: number,
  detectorId: number,
): boolean {
  const link = state.linkages[String(timewindowId)]?.detectorLinks[String(detectorId)]
  if (!link) {
    return false
  }
  return link.active && !link.suppressed
}

function toResult(detectorId: number, item: AggregationItem, cycleId: string, at: Clock): AnomalyResult {
  return {
    resultId: item.resultKey,
    detectorId,
    cycleId,
    timewindowId: item.timewindowId,
    periodKey: item.periodKey,
    event: item.event,
    metric: item.metric,
    value: item.value,
    baseline: item.baseline,
    deviation: item.deviation,
    severity: item.severity ?? '中',
    detectedAt: at,
    source: item.source ?? 'live',
    invalidated: item.invalidated ?? false,
  }
}

/**
 * 提交“修复恢复的异常时段判定数据清单”。并发提交同一 requestKey 只落首份，
 * 其余请求回到冲突队列；停用检测器一律拒绝。
 */
export function submitAdjudication(
  state: AnomalyLifecycleState,
  input: {
    detectorId: number
    timewindowId: number
    periodKey: string
    requestKey: string
    expectedRevision?: number
    at?: Clock
  },
): LifecycleOutcome<{ adjudication: AdjudicationRecord | null }> {
  const detector = state.detectors[String(input.detectorId)]
  if (!detector) {
    return {
      state,
      ok: false,
      code: 'not-found',
      message: `没有找到编号为 ${input.detectorId} 的检测器`,
      changed: false,
      data: { adjudication: null },
    }
  }
  const stamp = now(input.at)
  if (detector.appliedRequests[input.requestKey]) {
    return {
      ...reject(
        state,
        detector.detectorId,
        'duplicate-submit',
        '提交异常时段判定',
        input.expectedRevision ?? detector.revision,
        detector.revision,
        `请求 ${input.requestKey} 已受理，重复任务回到冲突队列，只写入首份判定数据清单`,
        input.at,
        input.timewindowId,
      ),
      data: { adjudication: null },
    } satisfies LifecycleOutcome<{ adjudication: AdjudicationRecord | null }>
  }
  if (!detector.enabled || detector.status === DISABLED) {
    return {
      ...reject(
        state,
        detector.detectorId,
        'disabled-write',
        '提交异常时段判定',
        input.expectedRevision ?? detector.revision,
        detector.revision,
        '检测器已停用，判定数据不写入当前异常',
        input.at,
        input.timewindowId,
      ),
      data: { adjudication: null },
    } satisfies LifecycleOutcome<{ adjudication: AdjudicationRecord | null }>
  }
  const stale = checkRevision(state, detector, input.expectedRevision, '提交异常时段判定', input.at, input.timewindowId)
  if (stale) {
    return { ...stale, data: { adjudication: null } } satisfies LifecycleOutcome<{
      adjudication: AdjudicationRecord | null
    }>
  }
  const link = state.linkages[String(input.timewindowId)]?.detectorLinks[String(input.detectorId)]
  if (!link || !link.active || link.suppressed) {
    return {
      ...reject(
        state,
        detector.detectorId,
        'disabled-write',
        '提交异常时段判定',
        input.expectedRevision ?? detector.revision,
        detector.revision,
        `时段配置 ${input.timewindowId} 已停用或未联动，判定数据不写入当前异常`,
        input.at,
        input.timewindowId,
      ),
      data: { adjudication: null },
    } satisfies LifecycleOutcome<{ adjudication: AdjudicationRecord | null }>
  }

  const next = clone(state)
  const target = next.detectors[String(input.detectorId)]
  const seq = nextSequence(next)
  next.sequence = seq.sequence
  const adjudication: AdjudicationRecord = {
    adjudicationId: `ADJ-${pad(seq.sequence)}`,
    adjudicationKey: input.requestKey,
    detectorId: target.detectorId,
    timewindowId: input.timewindowId,
    periodKey: input.periodKey,
    resolution: '修复恢复',
    status: '已生效',
    revision: target.revision,
    createdAt: stamp,
  }
  target.adjudicationList.push(adjudication)
  target.appliedRequests[input.requestKey] = {
    kind: 'adjudication',
    at: stamp,
    referenceId: adjudication.adjudicationId,
  }

  writeLinkageReceipt(next, input.timewindowId, {
    detectorId: target.detectorId,
    kind: 'adjudication',
    accepted: true,
    message: `判定数据清单 ${adjudication.adjudicationId} 已生效`,
    at: stamp,
  })

  return {
    state: next,
    ok: true,
    code: 'ok',
    message: `判定数据清单 ${adjudication.adjudicationId} 已写入，重复请求将回到冲突队列`,
    changed: true,
    data: { adjudication },
  }
}

/**
 * 按判定数据清单恢复复核数据清单。跨模块读取时段配置与异常时段清单，
 * 复核数据只读，不是新的当前异常。
 */
export function restoreReviewData(
  state: AnomalyLifecycleState,
  input: {
    detectorId: number
    timewindowRow?: TimewindowRowLike
    at?: Clock
  },
): LifecycleOutcome<{ restored: ReviewDataRecord[]; skipped: number }> {
  const detector = state.detectors[String(input.detectorId)]
  if (!detector) {
    return {
      state,
      ok: false,
      code: 'not-found',
      message: `没有找到编号为 ${input.detectorId} 的检测器`,
      changed: false,
      data: { restored: [], skipped: 0 },
    }
  }
  const stamp = now(input.at)
  if (!input.timewindowRow) {
    return {
      state,
      ok: false,
      code: 'timewindow-not-found',
      message: '没有读取到时段配置，复核数据清单无法恢复',
      changed: false,
      data: { restored: [], skipped: 0 },
    }
  }
  if (String(input.timewindowRow.status) !== ENABLED) {
    return {
      ...reject(
        state,
        detector.detectorId,
        'disabled-write',
        '恢复复核数据清单',
        detector.revision,
        detector.revision,
        `时段配置 ${String(input.timewindowRow.status)}，不可作为异常时段恢复复核`,
        input.at,
        input.timewindowRow.id,
      ),
      data: { restored: [], skipped: 0 },
    } satisfies LifecycleOutcome<{ restored: ReviewDataRecord[]; skipped: number }>
  }

  const next = clone(state)
  const target = next.detectors[String(input.detectorId)]
  const existing = new Set(target.reviewDataList.map((item) => item.adjudicationId))
  const config = toPeriodConfigRef(input.timewindowRow)
  const validAdjudications = target.adjudicationList.filter(
    (item) => item.timewindowId === input.timewindowRow!.id && item.status === '已生效',
  )
  const periodKeys = validAdjudications.map((item) => item.periodKey)

  const restored: ReviewDataRecord[] = []
  let skipped = 0
  for (const adjudication of validAdjudications) {
    if (existing.has(adjudication.adjudicationId)) {
      skipped += 1
      continue
    }
    const record: ReviewDataRecord = {
      reviewDataId: `REV-${adjudication.adjudicationId}`,
      adjudicationId: adjudication.adjudicationId,
      detectorId: target.detectorId,
      timewindowId: adjudication.timewindowId,
      periodKey: adjudication.periodKey,
      anomalyPeriodKeys: [...new Set(periodKeys)].sort(),
      timewindowConfig: { ...config },
      status: '待复核',
      restoredAt: stamp,
      readOnly: true,
    }
    target.reviewDataList.push(record)
    existing.add(adjudication.adjudicationId)
    restored.push(record)
  }

  return {
    state: next,
    ok: true,
    code: 'ok',
    message: `复核数据清单恢复 ${restored.length} 条，跳过 ${skipped} 条已存在记录`,
    changed: restored.length > 0,
    data: { restored, skipped },
  }
}

function toPeriodConfigRef(row: TimewindowRowLike): PeriodConfigRef {
  return {
    timewindowId: row.id,
    configCode: String(row['配置编号'] ?? ''),
    periodName: String(row['时段名称'] ?? ''),
    peakThreshold: String(row['峰值阈值'] ?? ''),
    anomalyMethod: String(row['异常判定方法'] ?? ''),
    statusAtRead: String(row.status ?? ''),
  }
}

/** 跨模块读取：时段配置 + 异常时段清单 + 联动回执，给异常检测判定是否还能写入。 */
export function readPeriodConfig(
  state: AnomalyLifecycleState,
  input: { detectorId: number; timewindowRow: TimewindowRowLike | undefined },
): PeriodConfigReading {
  const detector = state.detectors[String(input.detectorId)]
  const row = input.timewindowRow
  const linkage = row ? state.linkages[String(row.id)] : undefined
  const link = linkage?.detectorLinks[String(input.detectorId)]
  const configActive = !!row && String(row.status) === ENABLED
  const detectorEnabled = !!detector?.enabled
  const suppressed = !configActive || !detectorEnabled || !link?.active || !!link?.suppressed
  let suppressReason = ''
  if (!row) {
    suppressReason = '时段配置不存在'
  } else if (!configActive) {
    suppressReason = `时段配置${String(row.status)}，不再接收当前异常`
  } else if (!detector) {
    suppressReason = '检测器生命周期未登记'
  } else if (!detectorEnabled) {
    suppressReason = '检测器已停用'
  } else if (!link) {
    suppressReason = '时段与检测器尚未建立联动'
  } else if (!link.active || link.suppressed) {
    suppressReason = '时段异常联动已停用'
  }

  return {
    timewindowId: row?.id ?? -1,
    configCode: String(row?.['配置编号'] ?? ''),
    periodName: String(row?.['时段名称'] ?? ''),
    configStatus: String(row?.status ?? '不存在'),
    peakThreshold: String(row?.['峰值阈值'] ?? ''),
    anomalyMethod: String(row?.['异常判定方法'] ?? ''),
    detectorId: input.detectorId,
    detectorEnabled,
    suppressed,
    suppressReason,
    readOnly: suppressed,
    acceptsCurrentResults: !suppressed,
    anomalyPeriods: detector
      ? detector.adjudicationList.filter((item) => item.timewindowId === (row?.id ?? -1))
      : [],
    receipts: linkage?.receipts ?? [],
  }
}

/** 时段停用传播：把联动检测器挂起，并写回回执；不会新建当前异常。 */
export function propagateTimewindowDeactivation(
  state: AnomalyLifecycleState,
  input: { timewindowId: number; at?: Clock; action?: 'deactivate' | 'activate' },
): LifecycleOutcome<{ affectedDetectorIds: number[] }> {
  const linkage = state.linkages[String(input.timewindowId)]
  if (!linkage) {
    return {
      state,
      ok: false,
      code: 'timewindow-not-found',
      message: `没有找到编号为 ${input.timewindowId} 的时段配置`,
      changed: false,
      data: { affectedDetectorIds: [] },
    }
  }
  const stamp = now(input.at)
  const action = input.action ?? 'deactivate'
  const next = clone(state)
  const target = next.linkages[String(input.timewindowId)]
  const affected: number[] = []
  for (const [key, link] of Object.entries(target.detectorLinks)) {
    const detector = next.detectors[key]
    if (!detector) {
      continue
    }
    link.active = action === 'activate' && detector.enabled
    link.suppressed = action === 'deactivate'
    link.updatedAt = stamp
    if (action === 'deactivate') {
      detector.linkage.suppressed = true
      detector.linkage.suppressReason = '时段配置已停用'
      affected.push(detector.detectorId)
    } else {
      detector.linkage.suppressed = !detector.enabled
      detector.linkage.suppressReason = detector.enabled ? undefined : '检测器已停用'
      affected.push(detector.detectorId)
    }
  }
  const receiptId = writeLinkageReceipt(next, target.timewindowId, {
    detectorId: 0,
    kind: action === 'deactivate' ? 'timewindow-deactivation' : 'timewindow-activation',
    accepted: true,
    message:
      action === 'deactivate'
        ? `时段配置 ${target.configCode} 已停用，联动检测器停止接收当前异常`
        : `时段配置 ${target.configCode} 已启用，联动检测器恢复接收`,
    at: stamp,
  })
  for (const detectorId of affected) {
    const link = next.linkages[String(target.timewindowId)]?.detectorLinks[String(detectorId)]
    if (link) {
      link.lastReceiptId = receiptId
    }
  }
  return {
    state: next,
    ok: true,
    code: 'ok',
    message:
      action === 'deactivate'
        ? `时段停用已传播到 ${affected.length} 个检测器，未写入任何当前异常`
        : `时段启用已传播到 ${affected.length} 个检测器`,
    changed: true,
    data: { affectedDetectorIds: affected },
  }
}

/** 清单视图：只统计未失效的结果；停用后新增数为 0 是硬约束。 */
export function listCurrentAnomalies(
  state: AnomalyLifecycleState,
  detectorId: number,
): AnomalyResult[] {
  const detector = state.detectors[String(detectorId)]
  if (!detector?.currentCycle) {
    return []
  }
  return detector.currentCycle.results.filter((result) => !result.invalidated)
}

export function listHistoricalAnomalies(
  state: AnomalyLifecycleState,
  detectorId: number,
): AnomalyResult[] {
  const detector = state.detectors[String(detectorId)]
  if (!detector) {
    return []
  }
  return detector.historicalCycles.flatMap((cycle) => cycle.results).filter((result) => !result.invalidated)
}

/** 停用待确认快照的确认动作：只改快照状态，不影响历史周期与当前异常。 */
export function confirmDeactivationSnapshot(
  state: AnomalyLifecycleState,
  input: { detectorId: number; at?: Clock; timewindowId?: number },
): LifecycleOutcome<{ snapshot: DeactivationSnapshot | null }> {
  const detector = state.detectors[String(input.detectorId)]
  if (!detector) {
    return {
      state,
      ok: false,
      code: 'not-found',
      message: `没有找到编号为 ${input.detectorId} 的检测器`,
      changed: false,
      data: { snapshot: null },
    }
  }
  if (!detector.pendingSnapshot) {
    return {
      state,
      ok: false,
      code: 'invalid-transition',
      message: '检测器没有待确认的停用快照',
      changed: false,
      data: { snapshot: null },
    }
  }
  const next = clone(state)
  const target = next.detectors[String(input.detectorId)]
  target.pendingSnapshot = {
    ...target.pendingSnapshot!,
    status: '已确认',
    readOnly: true,
  }
  if (input.timewindowId !== undefined) {
    writeLinkageReceipt(next, input.timewindowId, {
      detectorId: target.detectorId,
      kind: 'deactivation',
      accepted: true,
      message: `停用待确认快照 ${target.pendingSnapshot.snapshotId} 已确认`,
      at: now(input.at),
    })
  }
  return {
    state: next,
    ok: true,
    code: 'ok',
    message: `停用待确认快照 ${target.pendingSnapshot.snapshotId} 已确认，检测器保持停用`,
    changed: true,
    data: { snapshot: target.pendingSnapshot },
  }
}

/** 看板摘要：停用检测器的新增异常恒为 0。 */
export function lifecycleSummary(state: AnomalyLifecycleState, detectorId: number) {
  const detector = state.detectors[String(detectorId)]
  if (!detector) {
    return null
  }
  const current = listCurrentAnomalies(state, detectorId)
  return {
    detectorId,
    enabled: detector.enabled,
    status: detector.status,
    revision: detector.revision,
    currentCycleId: detector.currentCycle?.cycleId ?? '',
    currentAnomalyCount: current.length,
    historicalResultCount: listHistoricalAnomalies(state, detectorId).filter((r) => !r.invalidated).length,
    rectificationCount: detector.rectificationList.length,
    historicalReviewCount: detector.historicalReviewList.length,
    pendingSnapshotStatus: detector.pendingSnapshot?.status ?? '',
    conflictCount: detector.conflictQueue.length,
    falsePositiveRate: detector.falsePositiveRate.value,
    falsePositiveRateFrozen: detector.falsePositiveRate.frozen,
    adjudicationCount: detector.adjudicationList.length,
    reviewDataCount: detector.reviewDataList.length,
  }
}
