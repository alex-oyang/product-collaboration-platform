<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { Check, Copy, KeyRound, LoaderCircle, PencilLine, Plus, Search, ShieldCheck, TriangleAlert, UserCheck, UserX } from 'lucide-vue-next'
import { copyText } from '../clipboard'
import type { BootstrapState, JobType, SystemRole, User } from '../contracts'
import PageState from './PageState.vue'
import PaginationBar from './PaginationBar.vue'
import StatusPill from './StatusPill.vue'
import UiModal from './UiModal.vue'
import UiSelect from './UiSelect.vue'

const props = defineProps<{
  state: BootstrapState
  loading: boolean
  error: string
  action: (type: string, payload: Record<string, unknown>) => Promise<boolean>
}>()
const emit = defineEmits<{ retry: []; notify: [message: string, tone?: 'success' | 'error' | 'info'] }>()

const query = ref('')
const roleFilter = ref('')
const jobFilter = ref('')
const statusFilter = ref('')
const page = ref(1)
const pageSize = 8
const showForm = ref(false)
const editing = ref<User | null>(null)
const toggling = ref<User | null>(null)
const resetting = ref<User | null>(null)
const busy = ref(false)
const resetPassword = ref('')
const credential = ref<{ title: string; username: string; password: string } | null>(null)
const form = reactive<{ username: string; name: string; role: SystemRole; job: JobType; password: string }>({ username: '', name: '', role: 'user', job: '其他', password: '' })
const jobs: JobType[] = ['产品', '美术', '研发', 'UE', '项目', '其他']
const roleOptions = [
  { value: '', label: '全部角色' },
  { value: 'user', label: '普通用户' },
  { value: 'admin', label: '超级管理员' },
]
const accountRoleOptions = roleOptions.slice(1)
const jobOptions = [{ value: '', label: '全部岗位' }, ...jobs.map((job) => ({ value: job, label: job }))]
const accountJobOptions = jobOptions.slice(1)
const statusOptions = [
  { value: '', label: '全部状态' },
  { value: 'enabled', label: '已启用' },
  { value: 'disabled', label: '已停用' },
]

const filtered = computed(() => props.state.users.filter((user) => {
  const q = query.value.trim().toLowerCase()
  return (!q || user.name.toLowerCase().includes(q) || user.username.toLowerCase().includes(q))
    && (!roleFilter.value || user.role === roleFilter.value)
    && (!jobFilter.value || user.job === jobFilter.value)
    && (!statusFilter.value || (statusFilter.value === 'enabled' ? user.enabled : !user.enabled))
}))
const paged = computed(() => filtered.value.slice((page.value - 1) * pageSize, page.value * pageSize))
watch([query, roleFilter, jobFilter, statusFilter], () => { page.value = 1 })

function randomPassword() { return `Temp@${crypto.getRandomValues(new Uint32Array(1))[0].toString(36).slice(0, 6)}A9` }
function openCreate() { editing.value = null; Object.assign(form, { username: '', name: '', role: 'user', job: '其他', password: randomPassword() }); showForm.value = true }
function openEdit(user: User) { editing.value = user; Object.assign(form, { username: user.username, name: user.name, role: user.role, job: user.job, password: '' }); showForm.value = true }

async function saveUser() {
  if (!form.name.trim() || (!editing.value && (!form.username.trim() || form.password.length < 8))) return
  busy.value = true
  const ok = editing.value
    ? await props.action('user.update', { userId: editing.value.id, name: form.name.trim(), role: form.role, job: form.job })
    : await props.action('user.create', { username: form.username.trim(), name: form.name.trim(), role: form.role, job: form.job, password: form.password })
  busy.value = false
  if (ok) {
    if (!editing.value) credential.value = { title: '账号创建成功', username: form.username.trim(), password: form.password }
    showForm.value = false
  }
}

async function toggleUser() {
  if (!toggling.value) return
  busy.value = true
  const ok = await props.action('user.toggle', { userId: toggling.value.id, enabled: !toggling.value.enabled })
  busy.value = false
  if (ok) toggling.value = null
}

function openReset(user: User) { resetting.value = user; resetPassword.value = randomPassword() }
async function applyReset() {
  if (!resetting.value || resetPassword.value.length < 8) return
  busy.value = true
  const password = resetPassword.value
  const ok = await props.action('user.resetPassword', { userId: resetting.value.id, password })
  busy.value = false
  if (ok) { credential.value = { title: '密码重置成功', username: resetting.value.username, password }; resetting.value = null }
}

async function copyCredential() {
  if (!credential.value) return
  try {
    await copyText(`账号：${credential.value.username}\n临时密码：${credential.value.password}`)
    emit('notify', '账号与临时密码已复制', 'success')
  } catch { emit('notify', '复制失败，请手动选择账号和临时密码', 'error') }
}

async function copyCredentialField(label: string, value: string) {
  try {
    await copyText(value)
    emit('notify', `${label}已复制`, 'success')
  } catch {
    emit('notify', `复制失败，请手动选择${label}`, 'error')
  }
}
</script>

<template>
  <section>
    <div class="flex flex-wrap items-end justify-between gap-5"><div><p class="eyebrow">ACCOUNT & RBAC</p><h1 class="page-title">账号管理</h1><p class="page-description">统一创建账号，分配系统角色与岗位，并管理账号状态。</p></div><button class="primary-button" type="button" @click="openCreate"><Plus class="h-4 w-4" />创建账号</button></div>
    <div class="filter-bar mt-7"><div class="flex flex-wrap items-center gap-3"><label class="input-shell min-w-64 flex-1"><Search class="h-4 w-4 text-slate-400" /><input v-model="query" aria-label="搜索账号" placeholder="搜索姓名或账号" /></label><UiSelect v-model="roleFilter" :options="roleOptions" aria-label="筛选系统角色" /><UiSelect v-model="jobFilter" :options="jobOptions" aria-label="筛选岗位" /><UiSelect v-model="statusFilter" :options="statusOptions" aria-label="筛选账号状态" /></div></div>
    <div class="glass-card mt-6 p-5 sm:p-6">
      <PageState v-if="loading" mode="loading" />
      <PageState v-else-if="error" mode="error" :description="error" @retry="emit('retry')" />
      <PageState v-else-if="!paged.length" mode="empty" title="没有符合条件的账号" description="调整筛选条件，或创建一个新账号。" />
      <div v-else class="data-table-shell"><div class="data-table-head grid grid-cols-[1.4fr_.75fr_.85fr_.75fr_1.05fr] items-center gap-4"><span>成员账号</span><span>岗位</span><span>系统角色</span><span>账号状态</span><span class="text-right">账号操作</span></div><div v-for="user in paged" :key="user.id" class="data-table-row grid grid-cols-[1.4fr_.75fr_.85fr_.75fr_1.05fr] items-center gap-4"><div class="data-cell data-cell-primary flex min-w-0 items-center gap-3" data-label="成员账号"><span class="avatar-mini large">{{ user.name.slice(0,1) }}</span><div class="min-w-0"><p class="data-cell-title">{{ user.name }}</p><p class="data-cell-subtitle font-mono">@{{ user.username }}</p></div></div><span class="data-cell text-sm font-medium text-slate-600" data-label="岗位">{{ user.job }}</span><span class="data-cell" data-label="系统角色"><StatusPill :value="user.role" /></span><span class="data-cell" data-label="账号状态"><span :class="['inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold', user.enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500']"><span class="h-1.5 w-1.5 rounded-full bg-current" />{{ user.enabled ? '已启用' : '已停用' }}</span></span><div class="data-cell data-cell-actions" data-label="账号操作"><button class="icon-button" type="button" title="编辑账号" :aria-label="`编辑 ${user.name} 的账号`" @click="openEdit(user)"><PencilLine class="h-4 w-4" /></button><button class="icon-button" type="button" title="重置密码" :aria-label="`重置 ${user.name} 的密码`" @click="openReset(user)"><KeyRound class="h-4 w-4" /></button><button class="icon-button" type="button" :title="user.enabled ? '停用账号' : '启用账号'" :aria-label="`${user.enabled ? '停用' : '启用'} ${user.name} 的账号`" :disabled="user.id === state.currentUser.id" @click="toggling = user"><UserX v-if="user.enabled" class="h-4 w-4 text-rose-500" /><UserCheck v-else class="h-4 w-4 text-emerald-600" /></button></div></div></div>
      <PaginationBar v-if="!loading && !error" :page="page" :page-size="pageSize" :total="filtered.length" @change="page = $event" />
    </div>

    <UiModal :open="showForm" :title="editing ? '编辑账号' : '创建账号'" :description="editing ? '岗位和系统角色变更将在保存后立即生效。' : '新账号首次登录后必须修改临时密码。'" :busy="busy" @close="showForm = false"><div class="grid gap-5 sm:grid-cols-2"><label><span class="field-label">登录账号</span><input v-model="form.username" class="form-input mt-2" :disabled="Boolean(editing)" placeholder="例如 alex.ouyang" /></label><label><span class="field-label">成员姓名</span><input v-model="form.name" class="form-input mt-2" placeholder="填写真实姓名" /></label><label><span class="field-label">系统角色</span><UiSelect v-model="form.role" class="mt-2 w-full" :options="accountRoleOptions" aria-label="选择系统角色" /></label><label><span class="field-label">岗位</span><UiSelect v-model="form.job" class="mt-2 w-full" :options="accountJobOptions" aria-label="选择岗位" /></label><label v-if="!editing" class="sm:col-span-2"><span class="field-label">临时密码</span><input v-model="form.password" class="form-input mt-2 font-mono" /><small class="mt-1 block text-xs text-slate-400">至少 8 位；创建成功后请安全发送给成员。</small></label></div><div v-if="form.role === 'admin'" class="mt-5 rounded-2xl border border-indigo-200 bg-indigo-50 p-4 text-sm leading-6 text-indigo-700"><ShieldCheck class="mb-2 h-5 w-5" />超级管理员可以管理全部产品、批注、账号和操作记录，请谨慎分配。</div><template #footer><button class="secondary-button" type="button" @click="showForm = false">取消</button><button class="primary-button" type="button" :disabled="busy || !form.name.trim() || (!editing && (!form.username.trim() || form.password.length < 8))" @click="saveUser"><LoaderCircle v-if="busy" class="h-4 w-4 animate-spin" />{{ editing ? '保存修改' : '创建账号' }}</button></template></UiModal>

    <UiModal :open="Boolean(toggling)" :title="toggling?.enabled ? '停用账号' : '启用账号'" :description="toggling?.enabled ? '停用后，该成员的全部会话立即失效，历史归属继续保留。' : '启用后，该成员可再次登录系统。'" :tone="toggling?.enabled ? 'danger' : 'default'" size="sm" :busy="busy" @close="toggling = null"><div v-if="toggling" class="confirm-target flex items-center gap-3"><span class="avatar-mini large">{{ toggling.name.slice(0,1) }}</span><div><p class="text-sm font-semibold text-slate-800">{{ toggling.name }}</p><p class="mt-1 text-xs text-slate-500">@{{ toggling.username }} · {{ toggling.job }}</p></div></div><template #footer><button class="secondary-button" type="button" :disabled="busy" @click="toggling = null">取消</button><button :class="toggling?.enabled ? 'danger-button' : 'primary-button'" type="button" :disabled="busy" @click="toggleUser"><LoaderCircle v-if="busy" class="h-4 w-4 animate-spin" />{{ toggling?.enabled ? '确认停用账号' : '确认启用账号' }}</button></template></UiModal>

    <UiModal :open="Boolean(resetting)" title="重置账号密码" description="这会立即撤销该账号的全部现有会话。" tone="danger" size="sm" :busy="busy" @close="resetting = null"><div v-if="resetting" class="confirm-target"><p class="confirm-target-label">操作账号</p><p class="confirm-target-value">{{ resetting.name }} · @{{ resetting.username }}</p><p class="mt-2 text-xs leading-5 text-slate-500">新临时密码需通过安全渠道发送，成员下次登录必须修改密码。</p></div><div class="confirm-impact"><TriangleAlert /><span>确认后无法恢复原密码，所有已登录设备都会退出。</span></div><label class="mt-5 block"><span class="field-label">新临时密码</span><input v-model="resetPassword" class="form-input mt-2 font-mono" /></label><template #footer><button class="secondary-button" type="button" :disabled="busy" @click="resetting = null">取消</button><button class="danger-button" type="button" :disabled="busy || resetPassword.length < 8" @click="applyReset"><LoaderCircle v-if="busy" class="h-4 w-4 animate-spin" />确认重置并退出设备</button></template></UiModal>

    <UiModal :open="Boolean(credential)" :title="credential?.title || '临时凭证'" description="临时密码仅在本次弹窗显示，关闭后无法再次查看。" size="sm" :close-on-backdrop="false" @close="credential = null"><div v-if="credential" class="rounded-2xl border border-emerald-200 bg-emerald-50 p-5"><div class="flex items-center gap-2 text-sm font-semibold text-emerald-800"><Check class="h-5 w-5" />请安全发送给对应成员</div><dl class="mt-5 space-y-4"><div><dt class="text-xs text-emerald-600">登录账号</dt><dd class="mt-1 flex items-center gap-2"><span class="min-w-0 flex-1 select-all truncate font-mono text-base font-semibold text-emerald-950">{{ credential.username }}</span><button class="icon-button shrink-0 bg-white/80" type="button" aria-label="复制登录账号" title="复制登录账号" @click="copyCredentialField('登录账号', credential.username)"><Copy class="h-4 w-4" /></button></dd></div><div><dt class="text-xs text-emerald-600">临时密码</dt><dd class="mt-1 flex items-center gap-2"><span class="min-w-0 flex-1 select-all break-all font-mono text-base font-semibold tracking-wide text-emerald-950">{{ credential.password }}</span><button class="icon-button shrink-0 bg-white/80" type="button" aria-label="复制临时密码" title="复制临时密码" @click="copyCredentialField('临时密码', credential.password)"><Copy class="h-4 w-4" /></button></dd></div></dl></div><p class="mt-4 text-xs leading-5 text-slate-500">成员首次登录后必须修改密码。系统不会再次回显这条临时密码。</p><template #footer><button class="secondary-button" type="button" @click="copyCredential"><Copy class="h-4 w-4" />复制账号与密码</button><button class="primary-button" type="button" @click="credential = null">我已保存，关闭</button></template></UiModal>
  </section>
</template>
