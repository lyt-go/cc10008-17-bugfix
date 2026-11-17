<template>
  <section class="page" data-module="anomaly">
    <header class="page-head">
      <div>
        <h2>异常检测管理</h2>
        <p class="page-desc">配置行为异常检测器，识别突增突降、模式漂移和离群行为。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记检测器</button>
        <button class="btn" type="button" @click="exportRows">导出异常检测清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <button class="link" type="button" @click="selectDetector(row)">检测详情</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无异常检测数据，可先登记检测器</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条异常检测记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <section v-if="detail" class="detail-panel" data-role="detector-detail">
      <header class="page-head">
        <div>
          <h3>{{ detail.detectorCode }} 检测详情</h3>
          <p class="page-desc">
            状态：{{ detail.status }} · 修订号 {{ detail.revision }} · 数据版本 {{ detail.dataRevision }}
            · 历史误报率 {{ detail.falsePositiveRate }}{{ detail.falsePositiveRateFrozen ? '（已冻结）' : '' }}
          </p>
        </div>
        <div class="page-actions">
          <button class="btn" type="button" @click="refreshDetail()">刷新详情</button>
        </div>
      </header>

      <div class="stat-row">
        <article class="stat-card">
          <span class="stat-label">当前异常</span>
          <strong class="stat-value" data-role="current-count">{{ detail.currentAnomalies.length }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">历史周期结果</span>
          <strong class="stat-value">{{ detail.historicalAnomalies.length }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">整改清单</span>
          <strong class="stat-value">{{ detail.rectificationList.length }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">历史复核清单</span>
          <strong class="stat-value">{{ detail.historicalReviewList.length }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">冲突队列</span>
          <strong class="stat-value" data-role="conflict-count">{{ detail.conflictQueue.length }}</strong>
        </article>
      </div>

      <p v-if="detail.pendingSnapshot" class="snapshot-line" data-role="snapshot">
        停用待确认快照：{{ detail.pendingSnapshot.snapshotId }} ·
        状态「{{ detail.pendingSnapshot.status }}」 ·
        仲裁做法「{{ policyLabel(detail.pendingSnapshot.policy) }}」 ·
        关联冲突 {{ detail.pendingSnapshot.conflictIds.length }} 条 · 只读
        <button
          v-if="detail.pendingSnapshot.status === '停用待确认'"
          class="btn"
          type="button"
          @click="confirmSnapshot"
        >
          确认快照
        </button>
      </p>

      <div class="filter-bar">
        <label class="filter-item">
          <span>时段配置</span>
          <select v-model.number="selectedTimewindowId">
            <option v-for="config in detail.periodConfigs" :key="config.timewindowId" :value="config.timewindowId">
              {{ config.configCode }} {{ config.periodName }}（{{ config.configStatus }}）
            </option>
          </select>
        </label>
        <label class="filter-item">
          <span>判定时段键</span>
          <input v-model="periodKey" placeholder="如 2026-09-03T08" />
        </label>
        <button class="btn" type="button" @click="submitAdjudicationEntry">提交修复恢复判定</button>
        <button class="btn" type="button" @click="restoreReviewEntry">恢复复核数据清单</button>
        <button class="btn" type="button" @click="aggregateEntry">汇总当前周期结果</button>
      </div>

      <p v-if="activePeriod" class="period-line" data-role="period-reading">
        时段 「{{ activePeriod.periodName }}」 峰值阈值 {{ activePeriod.peakThreshold }} /
        {{ activePeriod.anomalyMethod }} ·
        {{ activePeriod.acceptsCurrentResults ? '可写入当前异常' : `已抑制：${activePeriod.suppressReason}` }}
        · 异常时段 {{ activePeriod.anomalyPeriods.length }} 条
      </p>

      <template v-if="!detail.enabled">
        <div class="filter-bar">
          <button class="btn" type="button" @click="arbitrate('deactivation-terminal')">按停用终态仲裁</button>
          <button class="btn" type="button" @click="arbitrate('historical-retention')">按历史周期保留仲裁</button>
        </div>
      </template>

      <h4>当前异常清单</h4>
      <table class="data-table">
        <thead>
          <tr><th>结果编号</th><th>事件</th><th>指标</th><th>偏差</th><th>来源</th><th>周期</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in detail.currentAnomalies" :key="item.resultId">
            <td>{{ item.resultId }}</td>
            <td>{{ item.event }}</td>
            <td>{{ item.metric }}</td>
            <td>{{ item.deviation }}</td>
            <td>{{ item.source }}</td>
            <td>{{ item.cycleId }}</td>
          </tr>
          <tr v-if="!detail.currentAnomalies.length">
            <td colspan="6" class="empty-state">停用或未启用时不会产生新的当前异常</td>
          </tr>
        </tbody>
      </table>

      <h4>修复恢复的异常时段判定数据清单</h4>
      <table class="data-table">
        <thead>
          <tr><th>判定编号</th><th>请求键</th><th>时段键</th><th>状态</th><th>修订号</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in detail.adjudicationList" :key="item.adjudicationId">
            <td>{{ item.adjudicationId }}</td>
            <td>{{ item.adjudicationKey }}</td>
            <td>{{ item.periodKey }}</td>
            <td>{{ item.status }}</td>
            <td>{{ item.revision }}</td>
          </tr>
          <tr v-if="!detail.adjudicationList.length">
            <td colspan="5" class="empty-state">暂无判定数据</td>
          </tr>
        </tbody>
      </table>

      <h4>复核数据清单（只读）</h4>
      <table class="data-table">
        <thead>
          <tr><th>复核编号</th><th>时段键</th><th>异常时段</th><th>时段配置</th><th>状态</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in detail.reviewDataList" :key="item.reviewDataId">
            <td>{{ item.reviewDataId }}</td>
            <td>{{ item.periodKey }}</td>
            <td>{{ item.anomalyPeriodKeys.join('、') }}</td>
            <td>{{ item.timewindowConfig.configCode }} / 阈值 {{ item.timewindowConfig.peakThreshold }}</td>
            <td>{{ item.status }}</td>
          </tr>
          <tr v-if="!detail.reviewDataList.length">
            <td colspan="5" class="empty-state">暂无复核数据，可按判定清单恢复</td>
          </tr>
        </tbody>
      </table>

      <h4>冲突回执</h4>
      <table class="data-table">
        <thead>
          <tr><th>回执编号</th><th>类型</th><th>动作</th><th>版本</th><th>说明</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in detail.conflictQueue" :key="item.receiptId">
            <td>{{ item.receiptId }}</td>
            <td>{{ item.kind }}</td>
            <td>{{ item.action }}</td>
            <td>{{ item.expectedRevision }} → {{ item.actualRevision }}</td>
            <td>{{ item.message }}</td>
          </tr>
          <tr v-if="!detail.conflictQueue.length">
            <td colspan="5" class="empty-state">暂无冲突</td>
          </tr>
        </tbody>
      </table>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  aggregateAnomalyResults,
  confirmAnomalyDeactivationSnapshot,
  downloadEntries,
  listEntries,
  loadAnomalyLifecycle,
  moduleMeta,
  resolveAnomalyDeactivationConflict,
  restoreAnomalyReviewData,
  runAction as applyAction,
  submitAnomalyAdjudication,
} from '@/api/local-service'
import type { AnomalyLifecycleView } from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('anomaly')
const columns = ["检测器编号", "监控事件", "异常模式", "灵敏度", "最小支持量", "检测窗口分", "确认状态", "误报率"]
const actions = ["提交检测器评审", "启用检测", "停用检测"]
const statuses = ["草稿", "检测器评审中", "已启用", "已停用"]
const stats = [{"label": "检测器总数", "value": 0}, {"label": "已启用检测器", "value": 0}, {"label": "评审中检测器", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const detail = ref<AnomalyLifecycleView | null>(null)
const selectedTimewindowId = ref(0)
const periodKey = ref('')
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const activePeriod = computed(
  () => detail.value?.periodConfigs.find((item) => item.timewindowId === selectedTimewindowId.value) ?? null,
)

function policyLabel(policy: string) {
  return policy === 'historical-retention' ? '历史周期保留' : '停用终态'
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '检测器登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
  }
  reload()
  refreshDetail(Number(row.id))
}

function selectDetector(row: EntryRow) {
  refreshDetail(Number(row.id))
}

function refreshDetail(id?: number) {
  const target = id ?? detail.value?.detectorId
  if (!target) {
    return
  }
  const view = loadAnomalyLifecycle(target)
  detail.value = view
  if (!view) {
    return
  }
  if (!view.periodConfigs.some((item) => item.timewindowId === selectedTimewindowId.value)) {
    selectedTimewindowId.value = view.periodConfigs[0]?.timewindowId ?? 0
  }
  if (!periodKey.value) {
    periodKey.value = `PERIOD-${target}-1`
  }
}

function report(result: { ok: boolean; message: string }) {
  errorMessage.value = result.ok ? '' : result.message
  refreshDetail()
  reload()
}

function submitAdjudicationEntry() {
  if (!detail.value) {
    return
  }
  report(
    submitAnomalyAdjudication({
      detectorId: detail.value.detectorId,
      timewindowId: selectedTimewindowId.value,
      periodKey: periodKey.value,
      requestKey: `${detail.value.detectorId}:${selectedTimewindowId.value}:${periodKey.value}`,
      expectedRevision: detail.value.revision,
    }),
  )
}

function restoreReviewEntry() {
  if (!detail.value) {
    return
  }
  report(restoreAnomalyReviewData(detail.value.detectorId, selectedTimewindowId.value))
}

function aggregateEntry() {
  if (!detail.value) {
    return
  }
  report(
    aggregateAnomalyResults(
      detail.value.detectorId,
      [
        {
          resultKey: `P-${detail.value.detectorId}-${detail.value.dataRevision + 1}`,
          event: 'page.view',
          metric: 'pv',
          value: 320,
          baseline: 100,
          deviation: 3.2,
          timewindowId: selectedTimewindowId.value,
          periodKey: periodKey.value,
        },
      ],
      detail.value.dataRevision,
    ),
  )
}

function arbitrate(policy: 'deactivation-terminal' | 'historical-retention') {
  if (!detail.value) {
    return
  }
  report(resolveAnomalyDeactivationConflict(detail.value.detectorId, policy))
}

function confirmSnapshot() {
  if (!detail.value) {
    return
  }
  report(confirmAnomalyDeactivationSnapshot(detail.value.detectorId))
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '异常检测列表读取失败'
  }
}

onMounted(() => {
  reload()
  const enabled = rows.value.find((row) => String(row.status) === '已启用') ?? rows.value[0]
  if (enabled) {
    refreshDetail(Number(enabled.id))
  }
})
</script>

<style scoped>
.detail-panel {
  margin-top: 20px;
  padding: 14px 16px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.detail-panel h4 { margin: 16px 0 6px; font-size: 13px; }
.snapshot-line { font-size: 12px; color: #b42318; margin: 0 0 8px; }
.period-line { font-size: 12px; color: var(--muted); margin: 0 0 8px; }
</style>
