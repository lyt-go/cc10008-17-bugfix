/**
 * 异常检测生命周期的公共类型。
 *
 * 说明：仓库是纯前端应用，这里用轻量的本地状态模拟“异常检测 / 时段分析”之间的联动。
 * 所有状态都是可序列化的纯对象，方便持久化到 localStorage，也方便单测直接构造。
 */

/** 单条异常检测结果。只有“当前周期”允许新增，历史周期一律只读。 */
export type AnomalyResult = {
  resultId: string
  detectorId: number
  cycleId: string
  timewindowId?: number
  periodKey?: string
  event: string
  metric: string
  value: number
  baseline: number
  deviation: number
  severity: '低' | '中' | '高'
  detectedAt: string
  /** live=正常采集；restored=修复恢复回填；faulty-read=故障期间误读时段/检测器产生的峰值偏差。 */
  source: 'live' | 'restored' | 'faulty-read'
  /** 失效结果保留审计痕迹，但不计入异常清单，也不参与汇总。 */
  invalidated: boolean
}

/** 检测周期：current 可写；historical 在停用时冻结，只读。 */
export type AnomalyCycle = {
  cycleId: string
  kind: 'current' | 'historical'
  openedAt: string
  closedAt?: string
  readOnly: boolean
  results: AnomalyResult[]
}

/** 停用后由当前周期结果转出的整改清单（不会回写当前异常）。 */
export type RectificationItem = {
  itemId: string
  detectorId: number
  cycleId: string
  resultId: string
  event: string
  deviation: number
  status: '待整改'
  createdAt: string
}

/** 历史周期复核清单：停用仲裁后只读保留的历史周期。 */
export type HistoricalReviewItem = {
  reviewId: string
  detectorId: number
  cycleId: string
  resultCount: number
  falsePositiveRate: string
  status: '待复核' | '已复核'
  createdAt: string
}

/** 停用待确认快照：记录停用时刻的当前周期与冲突，供人工确认。 */
export type DeactivationSnapshot = {
  snapshotId: string
  detectorId: number
  createdAt: string
  revision: number
  status: '停用待确认' | '已确认'
  currentCycleId: string
  resultCount: number
  conflictIds: string[]
  readOnly: true
  /** 版本冲突仲裁采用的做法：停用终态 / 历史周期保留。 */
  policy: ConflictPolicy
}

/** 修复恢复的异常时段判定数据清单中的一条。 */
export type AdjudicationRecord = {
  adjudicationId: string
  adjudicationKey: string
  detectorId: number
  timewindowId: number
  periodKey: string
  resolution: '修复恢复'
  status: '已生效' | '已失效'
  revision: number
  createdAt: string
}

/** 时段配置的只读快照：跨模块读取后固化进复核数据清单。 */
export type PeriodConfigRef = {
  timewindowId: number
  configCode: string
  periodName: string
  peakThreshold: string
  anomalyMethod: string
  statusAtRead: string
}

/** 复核数据清单：按判定数据清单恢复，只读，不是新的异常结果。 */
export type ReviewDataRecord = {
  reviewDataId: string
  adjudicationId: string
  detectorId: number
  timewindowId: number
  periodKey: string
  /** 跨模块读取到的异常时段清单（同检测器、同时段配置的判定记录）。 */
  anomalyPeriodKeys: string[]
  timewindowConfig: PeriodConfigRef
  status: '待复核'
  restoredAt: string
  readOnly: true
}

export type ConflictKind =
  | 'version-conflict'
  | 'enable-disable-race'
  | 'stale-aggregation'
  | 'disabled-write'
  | 'historical-frozen'
  | 'duplicate-submit'
  | 'duplicate-result'
  | 'invalid-transition'

/** 冲突回执：被拒绝的写入，不改变检测器版本与历史误报率。 */
export type ConflictReceipt = {
  receiptId: string
  detectorId: number
  kind: ConflictKind
  action: string
  expectedRevision: number
  actualRevision: number
  at: string
  message: string
  accepted: false
  queue: 'conflict'
  linkageReceiptIds: string[]
  /** 被拒绝的旧周期汇总数据，只用于历史周期保留仲裁，永远不会回写当前周期。 */
  payload?: {
    cycleId: string
    results: AnomalyResult[]
  }
  /** 是否已被停用冲突仲裁消费；已消费的回执不会再次产生历史周期。 */
  resolved?: boolean
}

/** 写回“时段异常联动入口”的回执（含停用回执与冲突回执）。 */
export type LinkageReceipt = {
  receiptId: string
  conflictReceiptId?: string
  detectorId: number
  timewindowId: number
  kind:
    | 'detector-activation'
    | 'detector-deactivation'
    | 'deactivation'
    | 'conflict'
    | 'adjudication'
    | 'timewindow-deactivation'
    | 'timewindow-activation'
    | 'aggregation'
  accepted: boolean
  message: string
  at: string
}

export type DetectorLinkState = {
  timewindowId: number
  detectorId: number
  active: boolean
  suppressed: boolean
  updatedAt: string
  lastReceiptId?: string
}

export type TimewindowLinkage = {
  timewindowId: number
  configCode: string
  detectorLinks: Record<string, DetectorLinkState>
  receipts: LinkageReceipt[]
}

/** 检测器生命周期状态，revision 用于结构变更的乐观并发控制。 */
export type DetectorLifecycle = {
  detectorId: number
  detectorCode: string
  revision: number
  dataRevision: number
  status: string
  enabled: boolean
  openedAt: string
  enabledAt?: string
  deactivatedAt?: string
  falsePositiveRate: {
    value: string
    updatedAt: string
    revision: number
    frozen: boolean
  }
  currentCycle: AnomalyCycle | null
  historicalCycles: AnomalyCycle[]
  rectificationList: RectificationItem[]
  historicalReviewList: HistoricalReviewItem[]
  pendingSnapshot: DeactivationSnapshot | null
  conflictQueue: ConflictReceipt[]
  adjudicationList: AdjudicationRecord[]
  reviewDataList: ReviewDataRecord[]
  /** 已受理的幂等请求键，重复任务只落首份。 */
  appliedRequests: Record<string, AppliedRequest>
  linkage: {
    timewindowIds: number[]
    active: boolean
    suppressed: boolean
    suppressReason?: string
  }
}

export type AppliedRequest = {
  kind: 'adjudication' | 'aggregation'
  at: string
  referenceId: string
}

export type AnomalyLifecycleState = {
  schemaVersion: 1
  sequence: number
  detectors: Record<string, DetectorLifecycle>
  linkages: Record<string, TimewindowLinkage>
  conflictQueue: ConflictReceipt[]
}

/** 跨模块读取用的最小行结构，EntryRow 结构上可直接传入。 */
export type RowLike = Record<string, string | number | boolean>

export type DetectorRowLike = RowLike & { id: number; status: string }
export type TimewindowRowLike = RowLike & { id: number; status: string }

export type ConflictPolicy = 'deactivation-terminal' | 'historical-retention'

export type LifecycleCode =
  | 'ok'
  | 'not-found'
  | 'already-enabled'
  | 'already-disabled'
  | 'invalid-transition'
  | 'terminal-deactivated'
  | 'version-conflict'
  | 'disabled-write'
  | 'historical-frozen'
  | 'duplicate-submit'
  | 'duplicate-result'
  | 'timewindow-not-found'
  | 'timewindow-inactive'
  | 'timewindow-config-invalid'

export type RowPatch = {
  status: string
  pending: boolean
  abnormal: boolean
}

export type LifecycleOutcome<T = undefined> = {
  state: AnomalyLifecycleState
  ok: boolean
  code: LifecycleCode
  message: string
  changed: boolean
  receipt?: ConflictReceipt
  rowPatch?: RowPatch
  data?: T
}

/** 跨模块读取时段配置后的判定视图。 */
export type PeriodConfigReading = {
  timewindowId: number
  configCode: string
  periodName: string
  configStatus: string
  peakThreshold: string
  anomalyMethod: string
  detectorId: number
  detectorEnabled: boolean
  suppressed: boolean
  suppressReason: string
  readOnly: boolean
  acceptsCurrentResults: boolean
  anomalyPeriods: AdjudicationRecord[]
  receipts: LinkageReceipt[]
}
