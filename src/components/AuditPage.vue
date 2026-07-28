<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ChevronRight, Download, FileSearch, Search, ShieldCheck } from 'lucide-vue-next'
import type { AuditLog, BootstrapState } from '../contracts'
import PageState from './PageState.vue'
import PaginationBar from './PaginationBar.vue'
import StatusPill from './StatusPill.vue'
import UiModal from './UiModal.vue'
import UiSelect from './UiSelect.vue'

const props = defineProps<{ state: BootstrapState; loading: boolean; error: string }>()
const emit = defineEmits<{ retry: []; notify: [message: string, tone?: 'success' | 'error' | 'info'] }>()

const query = ref('')
const actor = ref('')
const result = ref('')
const page = ref(1)
const pageSize = 10
const selected = ref<AuditLog | null>(null)
const actorOptions = computed(() => [
  { value: '', label: '全部操作人' },
  ...props.state.users.map((user) => ({ value: user.id, label: user.name })),
])
const resultOptions = [
  { value: '', label: '全部结果' },
  { value: 'success', label: '成功' },
  { value: 'failed', label: '失败' },
]
const userName = (id: string) => props.state.users.find((item) => item.id === id)?.name ?? '系统'
const actionLabels: Record<string, string> = {
  'auth.login': '登录系统', 'auth.logout': '退出登录',
  'profile.update': '更新个人资料', 'password.change': '修改密码', 'access.redeem': '兑换产品授权',
  'user.create': '创建账号', 'user.update': '更新账号', 'user.toggle': '变更账号状态', 'user.resetPassword': '重置账号密码',
  'product.saveDraft': '创建产品草稿', 'product.update': '更新产品', 'product.transfer': '移交管理权',
  'product.state': '变更产品状态', 'product.restore': '恢复产品', 'product.purge': '永久删除产品', 'product.accessCode': '更新访问码',
  'product.memberAdd': '添加授权成员', 'product.memberRevoke': '收回成员权限', 'product.reviewState': '更新评审状态',
  'product.rollback': '回滚产品版本', 'product.publish': '发布产品版本',
  'annotation.create': '创建批注', 'annotation.update': '更新批注', 'annotation.delete': '删除批注', 'annotation.status': '更新批注状态',
  'reply.create': '创建回复', 'reply.update': '更新回复', 'reply.delete': '删除回复',
}
const actionName = (action: string) => actionLabels[action] ?? action

const filtered = computed(() => props.state.audit.filter((log) => {
  const q = query.value.trim().toLowerCase()
  return (!q || log.action.toLowerCase().includes(q) || log.targetName.toLowerCase().includes(q) || log.detail.toLowerCase().includes(q))
    && (!actor.value || log.actorId === actor.value)
    && (!result.value || log.result === result.value)
}))
const paged = computed(() => filtered.value.slice((page.value - 1) * pageSize, page.value * pageSize))
watch([query, actor, result], () => { page.value = 1 })

function formatDate(value: string) { return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value)) }

function exportCsv() {
  const escape = (value: string) => `"${value.replaceAll('"', '""')}"`
  const rows = [['时间', '操作人', '动作', '对象', '结果', '详情'], ...filtered.value.map((log) => [formatDate(log.createdAt), userName(log.actorId), log.action, log.targetName, log.result === 'success' ? '成功' : '失败', log.detail])]
  const blob = new Blob([`\uFEFF${rows.map((row) => row.map(escape).join(',')).join('\n')}`], { type: 'text/csv;charset=utf-8' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = `操作记录-${new Date().toISOString().slice(0, 10)}.csv`
  link.click()
  URL.revokeObjectURL(link.href)
  emit('notify', `已导出 ${filtered.value.length} 条脱敏记录`, 'success')
}
</script>

<template>
  <section>
    <div class="flex flex-wrap items-end justify-between gap-5"><div><p class="eyebrow">AUDIT TRAIL</p><h1 class="page-title">操作记录</h1><p class="page-description">追踪产品、账号、版本和批注的关键动作。</p></div><button class="secondary-button" type="button" :disabled="!filtered.length" @click="exportCsv"><Download class="h-4 w-4" />导出当前结果</button></div>
    <div class="filter-bar mt-7"><div class="flex flex-wrap items-center gap-3"><label class="input-shell min-w-64 flex-1"><Search class="h-4 w-4 text-slate-400" /><input v-model="query" aria-label="搜索操作记录" placeholder="搜索动作、对象或详情" /></label><UiSelect v-if="state.currentUser.role === 'admin'" v-model="actor" :options="actorOptions" aria-label="筛选操作人" /><UiSelect v-model="result" :options="resultOptions" aria-label="筛选操作结果" /></div></div>
    <div class="glass-card mt-6 p-5 sm:p-6">
      <PageState v-if="loading" mode="loading" />
      <PageState v-else-if="error" mode="error" :description="error" @retry="emit('retry')" />
      <PageState v-else-if="!paged.length" mode="empty" title="没有操作记录" description="关键操作发生后会显示在这里。" />
      <div v-else class="data-table-shell"><div class="data-table-head grid grid-cols-[1fr_.85fr_1.15fr_1.3fr_.65fr_.45fr] items-center gap-4"><span>操作时间</span><span>操作人</span><span>操作动作</span><span>业务对象</span><span>执行结果</span><span class="text-right">详情</span></div><button v-for="log in paged" :key="log.id" class="data-table-row grid w-full grid-cols-[1fr_.85fr_1.15fr_1.3fr_.65fr_.45fr] items-center gap-4 text-left" type="button" :aria-label="`查看 ${actionName(log.action)} 的操作详情`" @click="selected = log"><span class="data-cell data-cell-time" data-label="操作时间">{{ formatDate(log.createdAt) }}</span><span class="data-cell data-cell-person" data-label="操作人"><span class="avatar-mini">{{ userName(log.actorId).slice(0,1) }}</span><span class="truncate">{{ userName(log.actorId) }}</span></span><span class="data-cell data-cell-primary" data-label="操作动作"><strong class="data-cell-title">{{ actionName(log.action) }}</strong><small class="data-cell-subtitle font-mono">{{ log.action }}</small></span><span class="data-cell data-cell-primary" data-label="业务对象"><strong class="data-cell-title font-medium" :title="log.targetName">{{ log.targetName }}</strong><small class="data-cell-subtitle">{{ log.targetType }}</small></span><span class="data-cell" data-label="执行结果"><StatusPill :value="log.result" /></span><span class="data-cell data-cell-action" data-label="详情"><span>查看</span><ChevronRight /></span></button></div>
      <PaginationBar v-if="!loading && !error" :page="page" :page-size="pageSize" :total="filtered.length" @change="page = $event" />
    </div>

    <UiModal :open="Boolean(selected)" title="操作详情" description="敏感凭证和访问码已脱敏。" size="md" @close="selected = null"><div v-if="selected" class="space-y-5"><div class="flex items-center gap-3 rounded-2xl bg-indigo-50 p-4"><div class="grid h-10 w-10 place-items-center rounded-xl bg-white text-indigo-600"><ShieldCheck class="h-5 w-5" /></div><div class="min-w-0"><p class="text-sm font-semibold text-slate-900">{{ actionName(selected.action) }}</p><p class="mt-1 truncate font-mono text-[11px] text-slate-500">{{ selected.action }}</p><p class="mt-1 text-xs text-slate-500">{{ formatDate(selected.createdAt) }} · {{ userName(selected.actorId) }}</p></div><StatusPill class="ml-auto" :value="selected.result" /></div><dl class="detail-list"><div><dt>对象类型</dt><dd>{{ selected.targetType }}</dd></div><div><dt>对象名称</dt><dd>{{ selected.targetName }}</dd></div><div><dt>对象标识</dt><dd class="break-all font-mono">{{ selected.targetId }}</dd></div><div><dt>操作详情</dt><dd class="whitespace-pre-wrap leading-6">{{ selected.detail }}</dd></div></dl><div v-if="selected.result === 'failed'" class="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700"><FileSearch class="mb-2 h-5 w-5" />该动作未成功执行，业务数据保持操作前状态。</div></div></UiModal>
  </section>
</template>
