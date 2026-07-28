<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import {
  ArchiveRestore, ArrowLeft, Check, ChevronDown, Clipboard, Clock3, Copy, Eye, FileArchive,
  Dices, FileClock, FileUp, KeyRound, LoaderCircle, MoreHorizontal, PencilLine, RefreshCw, RotateCcw,
  Search, ShieldCheck, Trash2, UserPlus, UsersRound, X,
} from 'lucide-vue-next'
import { generateAccessCode } from '../accessCode'
import { copyText } from '../clipboard'
import type { BootstrapState, ProductState, ReviewState, User, VersionRecord } from '../contracts'
import PaginationBar from './PaginationBar.vue'
import PageState from './PageState.vue'
import StatusPill from './StatusPill.vue'
import UiDateTimePicker from './UiDateTimePicker.vue'
import UiModal from './UiModal.vue'
import UiSelect from './UiSelect.vue'

const props = defineProps<{
  state: BootstrapState
  productId: string
  initialDialog?: 'edit' | 'members' | 'transfer'
  action: (type: string, payload: Record<string, unknown>) => Promise<boolean>
}>()

const emit = defineEmits<{
  back: []
  review: [productId: string]
  upload: [productId: string]
  notify: [message: string, tone?: 'success' | 'error' | 'info']
}>()

type Tab = 'basic' | 'uploads' | 'versions'
const tab = ref<Tab>('basic')
const busy = ref(false)
const showEdit = ref(false)
const showMembers = ref(false)
const showTransfer = ref(false)
const showAccessCode = ref(false)
const showState = ref(false)
const showRollback = ref(false)
const revokeTarget = ref<User | null>(null)
const targetState = ref<ProductState | 'restore'>('offline')
const targetVersion = ref<VersionRecord | null>(null)
const versionQuery = ref('')
const uploadQuery = ref('')
const uploadStatus = ref('')
const versionPage = ref(1)
const uploadPage = ref(1)
const pageSize = 6
const transferOwnerId = ref('')
const addMemberId = ref('')
const nextAccessCode = ref('')
const nextAccessCodeExpiresAt = ref('')
const nextAccessNeverExpires = ref(true)
const showAccessPlain = ref(false)
const editForm = reactive({ name: '', manager: '', description: '', longNote: '' })

const product = computed(() => props.state.products.find((item) => item.id === props.productId))
const isManager = computed(() => Boolean(product.value && (props.state.currentUser.role === 'admin' || product.value.ownerId === props.state.currentUser.id)))
const canPublishVersion = computed(() => props.state.currentUser.role === 'admin' || props.state.currentUser.job === '产品')
const owner = computed(() => props.state.users.find((item) => item.id === product.value?.ownerId))
const productUploads = computed(() => props.state.uploads.filter((item) => item.productId === props.productId))
const productAnnotations = computed(() => props.state.annotations.filter((item) => item.productId === props.productId && !item.deleted))
const memberUsers = computed(() => product.value?.members.map((member) => ({ member, user: props.state.users.find((item) => item.id === member.userId) })).filter((item): item is { member: NonNullable<typeof item.member>; user: User } => Boolean(item.user)) ?? [])
const memberCandidates = computed(() => props.state.users.filter((user) => user.enabled && user.id !== product.value?.ownerId && !product.value?.members.some((item) => item.userId === user.id)))
const transferCandidates = computed(() => props.state.users.filter((user) => user.enabled && user.id !== product.value?.ownerId))
const reviewStatusOptions = [
  { value: 'pending', label: '待评审' },
  { value: 'reviewing', label: '评审中' },
  { value: 'completed', label: '评审完成' },
]
const uploadStatusOptions = [
  { value: '', label: '全部状态' },
  { value: 'success', label: '发布成功' },
  { value: 'failed', label: '发布失败' },
]
const transferOwnerOptions = computed(() => [
  { value: '', label: '请选择启用成员' },
  ...transferCandidates.value.map((user) => ({ value: user.id, label: `${user.name} · ${user.job}` })),
])
const memberCandidateOptions = computed(() => [
  { value: '', label: '选择要添加的成员' },
  ...memberCandidates.value.map((user) => ({ value: user.id, label: user.name, description: `${user.job}岗位` })),
])
const filteredVersions = computed(() => (product.value?.versions ?? []).filter((version) => {
  const q = versionQuery.value.trim().toLowerCase()
  return !q || version.version.includes(q) || version.note.toLowerCase().includes(q) || version.fileName.toLowerCase().includes(q)
}))
const pagedVersions = computed(() => filteredVersions.value.slice((versionPage.value - 1) * pageSize, versionPage.value * pageSize))
const filteredUploads = computed(() => productUploads.value.filter((record) => {
  const q = uploadQuery.value.trim().toLowerCase()
  return (!q || record.fileName.toLowerCase().includes(q) || (record.version ?? '').includes(q)) && (!uploadStatus.value || record.status === uploadStatus.value)
}))
const pagedUploads = computed(() => filteredUploads.value.slice((uploadPage.value - 1) * pageSize, uploadPage.value * pageSize))

watch([versionQuery], () => { versionPage.value = 1 })
watch([uploadQuery, uploadStatus], () => { uploadPage.value = 1 })
watch(() => props.initialDialog, (intent) => {
  if (intent === 'edit') openEdit()
  if (intent === 'members') showMembers.value = true
  if (intent === 'transfer') { transferOwnerId.value = ''; showTransfer.value = true }
}, { immediate: true })

function userName(id: string) { return props.state.users.find((item) => item.id === id)?.name ?? '未知成员' }
function formatDate(value: string) { return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) }
function fileSize(bytes: number) { return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB` }

function openEdit() {
  if (!product.value) return
  Object.assign(editForm, { name: product.value.name, manager: product.value.manager, description: product.value.description, longNote: product.value.longNote })
  showEdit.value = true
}

async function saveEdit() {
  if (!product.value || !editForm.name.trim() || !editForm.manager.trim()) return
  busy.value = true
  const ok = await props.action('product.update', { productId: product.value.id, name: editForm.name.trim(), manager: editForm.manager.trim(), description: editForm.description.trim(), longNote: editForm.longNote.trim() })
  busy.value = false
  if (ok) showEdit.value = false
}

async function transfer() {
  if (!product.value || !transferOwnerId.value) return
  busy.value = true
  const ok = await props.action('product.transfer', { productId: product.value.id, ownerId: transferOwnerId.value })
  busy.value = false
  if (ok) showTransfer.value = false
}

async function updateState() {
  if (!product.value) return
  busy.value = true
  const ok = targetState.value === 'restore'
    ? await props.action('product.restore', { productId: product.value.id })
    : await props.action('product.state', { productId: product.value.id, state: targetState.value })
  busy.value = false
  if (ok) showState.value = false
}

async function rotateAccessCode() {
  if (!product.value || nextAccessCode.value.trim().length < 4) return
  busy.value = true
  const ok = await props.action('product.accessCode', { productId: product.value.id, accessCode: nextAccessCode.value.trim(), accessCodeExpiresAt: nextAccessNeverExpires.value || !nextAccessCodeExpiresAt.value ? null : new Date(nextAccessCodeExpiresAt.value).toISOString() })
  busy.value = false
  if (ok) { nextAccessCode.value = ''; nextAccessCodeExpiresAt.value = ''; nextAccessNeverExpires.value = true; showAccessCode.value = false; showMembers.value = true }
}

async function copyAccessCode() {
  if (!product.value) return
  try {
    await copyText(product.value.accessCode)
    emit('notify', '访问码已复制', 'success')
    void props.action('product.copyAccessCode', { productId: product.value.id })
  } catch {
    showAccessPlain.value = true
    emit('notify', '复制失败，访问码已显示，请手动选择复制', 'error')
  }
}

async function addMember() {
  if (!product.value || !addMemberId.value) return
  busy.value = true
  const ok = await props.action('product.memberAdd', { productId: product.value.id, userId: addMemberId.value })
  busy.value = false
  if (ok) addMemberId.value = ''
}

async function revokeMember() {
  if (!product.value || !revokeTarget.value) return
  busy.value = true
  const ok = await props.action('product.memberRevoke', { productId: product.value.id, userId: revokeTarget.value.id })
  busy.value = false
  if (ok) { revokeTarget.value = null; showMembers.value = true }
}

function askRevoke(user: User) {
  showMembers.value = false
  revokeTarget.value = user
}

function closeRevoke() {
  revokeTarget.value = null
  showMembers.value = true
}

function openAccessUpdate() {
  nextAccessCode.value = ''
  nextAccessCodeExpiresAt.value = ''
  nextAccessNeverExpires.value = true
  showMembers.value = false
  showAccessCode.value = true
}

function randomizeAccessCode() {
  nextAccessCode.value = generateAccessCode(props.state.products.map((item) => item.accessCode))
}

function closeAccessUpdate() {
  showAccessCode.value = false
  showMembers.value = true
}

async function updateReviewState(value: string) {
  if (!product.value) return
  await props.action('product.reviewState', { productId: product.value.id, reviewState: value as ReviewState })
}

function askState(state: ProductState | 'restore') {
  targetState.value = state
  showState.value = true
}

function askRollback(version: VersionRecord) {
  targetVersion.value = version
  showRollback.value = true
}

async function rollback() {
  if (!product.value || !targetVersion.value) return
  busy.value = true
  const ok = await props.action('product.rollback', { productId: product.value.id, version: targetVersion.value.version })
  busy.value = false
  if (ok) { showRollback.value = false; targetVersion.value = null }
}
</script>

<template>
  <PageState v-if="!product" mode="error" title="找不到该产品" description="产品可能已被移除，或你的访问权限已经失效。" @retry="emit('back')" />
  <section v-else>
    <button class="text-button mb-5" type="button" @click="emit('back')"><ArrowLeft class="h-4 w-4" />返回上一页</button>
    <div class="glass-card relative z-20 overflow-visible p-6">
      <div class="flex flex-wrap items-start justify-between gap-5">
        <div class="flex min-w-0 items-start gap-4">
          <div class="product-mark large">{{ product.name.slice(0, 1) }}</div>
          <div class="min-w-0"><div class="flex flex-wrap items-center gap-2"><h1 class="text-2xl font-semibold tracking-tight text-slate-950">{{ product.name }}</h1><StatusPill :value="product.state" /><StatusPill :value="product.reviewState" /></div><p class="mt-2 max-w-3xl text-sm leading-6 text-slate-500">{{ product.description || '暂未填写产品简介。' }}</p><p class="mt-2 font-mono text-xs text-slate-400">当前版本 {{ product.currentVersion || '尚未发布' }} · 更新于 {{ formatDate(product.updatedAt) }}</p></div>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <button class="secondary-button" type="button" :disabled="product.state === 'trash'" @click="emit('review', product.id)"><Eye class="h-4 w-4" />查看原型</button>
          <button v-if="isManager && canPublishVersion && product.state !== 'trash'" class="primary-button" type="button" @click="emit('upload', product.id)"><FileUp class="h-4 w-4" />上传新版本</button>
          <div v-if="isManager" class="group/menu relative z-30 focus-within:z-[90] hover:z-[90]"><button class="icon-button" type="button" aria-label="更多管理操作"><MoreHorizontal class="h-5 w-5" /></button><div class="popover-menu right-0 top-10 z-[100] hidden group-focus-within/menu:block group-hover/menu:block"><button v-if="product.state !== 'trash'" type="button" @click="openEdit"><PencilLine class="h-4 w-4" />编辑产品</button><button v-if="product.state !== 'trash'" type="button" @click="transferOwnerId = ''; showTransfer = true"><UsersRound class="h-4 w-4" />移交管理权</button><button v-if="product.state !== 'trash'" type="button" @click="showMembers = true"><KeyRound class="h-4 w-4" />授权成员管理</button><button v-if="product.state === 'online'" type="button" @click="askState('offline')"><ArchiveRestore class="h-4 w-4" />下架产品</button><button v-if="['offline','draft'].includes(product.state)" type="button" @click="askState('online')"><Check class="h-4 w-4" />上架产品</button><button v-if="product.state !== 'trash'" class="danger" type="button" @click="askState('trash')"><Trash2 class="h-4 w-4" />移入回收站</button><button v-else type="button" @click="askState('restore')"><RefreshCw class="h-4 w-4" />恢复产品</button></div></div>
        </div>
      </div>

      <div class="mt-6 flex flex-wrap gap-2 border-t border-slate-200/70 pt-5">
        <button v-for="item in [{id:'basic',label:'基本信息',icon:Clipboard},{id:'uploads',label:'上传记录',icon:FileArchive},{id:'versions',label:'版本记录',icon:FileClock}]" :key="item.id" :class="['tab-button', tab === item.id && 'active']" type="button" @click="tab = item.id as Tab"><component :is="item.icon" class="h-4 w-4" />{{ item.label }}</button>
      </div>
    </div>

    <div v-if="tab === 'basic'" class="mt-6 grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_380px]">
      <article class="glass-card p-6"><div class="flex items-center justify-between"><div><p class="eyebrow">PRODUCT PROFILE</p><h2 class="mt-1 text-lg font-semibold text-slate-900">基本信息</h2></div><button v-if="isManager && product.state !== 'trash'" class="secondary-button compact" type="button" @click="openEdit"><PencilLine class="h-4 w-4" />编辑</button></div><dl class="mt-6 grid gap-5 sm:grid-cols-2"><div><dt>产品经理</dt><dd>{{ product.manager }}</dd></div><div><dt>产品负责人</dt><dd>{{ owner?.name || '未设置' }}</dd></div><div><dt>创建时间</dt><dd>{{ formatDate(product.createdAt) }}</dd></div><div><dt>评审状态</dt><dd><UiSelect v-if="isManager && product.state !== 'trash'" :model-value="product.reviewState" :options="reviewStatusOptions" size="sm" aria-label="更新评审状态" @change="updateReviewState" /><StatusPill v-else :value="product.reviewState" /></dd></div><div class="sm:col-span-2"><dt>产品简介</dt><dd class="leading-6">{{ product.description || '未填写' }}</dd></div><div class="sm:col-span-2"><dt>长期备注</dt><dd class="whitespace-pre-wrap leading-6">{{ product.longNote || '未填写' }}</dd></div></dl></article>
      <div class="space-y-5">
        <article class="glass-card p-5"><div class="flex items-center justify-between"><div><p class="text-sm font-semibold text-slate-900">授权成员</p><p class="mt-1 text-xs text-slate-500">当前访问码版本 v{{ product.codeVersion }}</p></div><button v-if="isManager && product.state !== 'trash'" class="text-button" type="button" @click="showMembers = true">管理<ChevronDown class="h-4 w-4 -rotate-90" /></button></div><div class="mt-4 flex flex-wrap gap-2"><span v-for="item in memberUsers.slice(0, 8)" :key="item.user.id" class="member-chip"><span class="avatar-mini">{{ item.user.name.slice(0,1) }}</span>{{ item.user.name }}</span><span v-if="!memberUsers.length" class="text-sm text-slate-400">尚无授权成员</span></div></article>
        <article class="glass-card p-5"><p class="text-sm font-semibold text-slate-900">批注进度</p><div class="mt-4 grid grid-cols-3 gap-2 text-center"><div class="metric-mini"><b>{{ productAnnotations.filter((item) => item.status === 'open').length }}</b><span>未解决</span></div><div class="metric-mini"><b>{{ productAnnotations.filter((item) => item.status === 'resolved').length }}</b><span>已解决</span></div><div class="metric-mini"><b>{{ productAnnotations.filter((item) => item.status === 'needs-relocation').length }}</b><span>待定位</span></div></div><button class="secondary-button mt-4 w-full justify-center" type="button" :disabled="product.state === 'trash'" @click="emit('review', product.id)">进入原型评审</button></article>
      </div>
    </div>

    <div v-else-if="tab === 'uploads'" class="glass-card mt-6 p-6">
      <div class="flex flex-wrap items-center justify-between gap-3"><div><h2 class="text-lg font-semibold text-slate-900">上传记录</h2><p class="mt-1 text-sm text-slate-500">成功与失败记录全部保留。</p></div><div class="flex gap-3"><label class="input-shell"><Search class="h-4 w-4 text-slate-400" /><input v-model="uploadQuery" placeholder="搜索文件或版本" /></label><UiSelect v-model="uploadStatus" :options="uploadStatusOptions" aria-label="筛选上传状态" /></div></div>
      <PageState v-if="!pagedUploads.length" class="mt-5" mode="empty" title="没有上传记录" description="上传新版本后，结果会显示在这里。" />
      <div v-else class="table-shell mt-5"><div class="table-head grid grid-cols-[minmax(0,1.45fr)_.75fr_.9fr_.7fr_.85fr] items-center gap-4"><span>上传文件</span><span>上传人</span><span>上传时间</span><span>发布结果</span><span>生成版本</span></div><div v-for="record in pagedUploads" :key="record.id" class="table-row grid grid-cols-[minmax(0,1.45fr)_.75fr_.9fr_.7fr_.85fr] items-center gap-4"><div class="data-cell data-cell-primary" data-label="上传文件"><p class="data-cell-title" :title="record.fileName">{{ record.fileName }}</p><p v-if="record.error" class="data-cell-subtitle text-rose-600" :title="record.error">{{ record.error }}</p><p v-else class="data-cell-subtitle">原型发布文件</p></div><span class="data-cell data-cell-person" data-label="上传人"><span class="avatar-mini">{{ userName(record.uploaderId).slice(0,1) }}</span><span class="truncate">{{ userName(record.uploaderId) }}</span></span><span class="data-cell data-cell-time" data-label="上传时间">{{ formatDate(record.createdAt) }}</span><span class="data-cell" data-label="发布结果"><StatusPill :value="record.status" context="upload" /></span><span class="data-cell" data-label="生成版本"><span v-if="record.version" class="table-code">{{ record.version }}</span><span v-else class="text-xs text-slate-400">未生成</span></span></div></div>
      <PaginationBar :page="uploadPage" :page-size="pageSize" :total="filteredUploads.length" @change="uploadPage = $event" />
    </div>

    <div v-else class="glass-card mt-6 p-6">
      <div class="flex flex-wrap items-center justify-between gap-3"><div><h2 class="text-lg font-semibold text-slate-900">版本记录</h2><p class="mt-1 text-sm text-slate-500">历史版本不可修改，回滚只会切换当前指针。</p></div><label class="input-shell"><Search class="h-4 w-4 text-slate-400" /><input v-model="versionQuery" placeholder="搜索版本、说明或文件" /></label></div>
      <PageState v-if="!pagedVersions.length" class="mt-5" mode="empty" title="尚未生成版本" description="成功发布产品后会生成第一条时间版本。" />
      <div v-else class="mt-5 space-y-3"><article v-for="version in pagedVersions" :key="version.id" :class="['rounded-2xl border p-4', version.isCurrent ? 'border-indigo-200 bg-indigo-50/55' : 'border-slate-200/70 bg-white/45']"><div class="flex flex-wrap items-center justify-between gap-4"><div class="flex min-w-0 items-start gap-3"><div class="grid h-10 w-10 place-items-center rounded-xl bg-white text-indigo-600 shadow-sm"><Clock3 class="h-5 w-5" /></div><div class="min-w-0"><div class="flex items-center gap-2"><p class="font-mono text-sm font-semibold text-slate-900">{{ version.version }}</p><span v-if="version.isCurrent" class="rounded-full bg-indigo-600 px-2 py-0.5 text-[10px] font-semibold text-white">当前版本</span></div><p class="mt-1 line-clamp-1 text-sm text-slate-500">{{ version.note || '未填写版本说明' }}</p><p class="mt-1 text-xs text-slate-400">{{ version.fileName }} · {{ fileSize(version.fileSize) }} · {{ userName(version.uploaderId) }} · {{ formatDate(version.createdAt) }}</p><p v-if="version.gitTag || version.gitCommit" class="mt-1 font-mono text-[10px] text-slate-400">Git {{ version.gitTag || '—' }}<template v-if="version.gitCommit"> · {{ version.gitCommit.slice(0, 8) }}</template></p></div></div><button v-if="isManager && !version.isCurrent" class="secondary-button compact" type="button" @click="askRollback(version)"><RotateCcw class="h-4 w-4" />回滚到此版本</button></div></article></div>
      <PaginationBar :page="versionPage" :page-size="pageSize" :total="filteredVersions.length" @change="versionPage = $event" />
    </div>

    <UiModal :open="showEdit" title="编辑产品" description="负责人变更需使用独立的管理权移交流程。" :busy="busy" @close="showEdit = false"><div class="grid gap-5"><label><span class="field-label">产品名称</span><input v-model="editForm.name" class="form-input mt-2" /></label><label><span class="field-label">产品经理</span><input v-model="editForm.manager" class="form-input mt-2" /></label><label><span class="field-label">产品简介</span><textarea v-model="editForm.description" class="form-textarea mt-2" rows="3" /></label><label><span class="field-label">长期备注</span><textarea v-model="editForm.longNote" class="form-textarea mt-2" rows="4" /></label></div><template #footer><button class="secondary-button" type="button" @click="showEdit = false">取消</button><button class="primary-button" type="button" :disabled="busy || !editForm.name.trim() || !editForm.manager.trim()" @click="saveEdit"><LoaderCircle v-if="busy" class="h-4 w-4 animate-spin" />保存修改</button></template></UiModal>

    <UiModal :open="showTransfer" title="移交产品管理权" description="新负责人将立即获得本产品的编辑、发布、回滚和授权管理权限。" tone="warning" size="sm" :busy="busy" @close="showTransfer = false"><div class="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-800">可移交给任意启用成员。非产品岗位成为负责人后，可从本详情页管理该产品，但不会获得全局产品上传入口。移交后，你将保留普通授权成员权限。</div><label class="mt-5 block"><span class="field-label">新负责人</span><UiSelect v-model="transferOwnerId" class="mt-2 w-full" :options="transferOwnerOptions" aria-label="选择新负责人" searchable search-placeholder="搜索成员姓名或岗位" /></label><template #footer><button class="secondary-button" type="button" :disabled="busy" @click="showTransfer = false">取消</button><button class="danger-button" type="button" :disabled="busy || !transferOwnerId" @click="transfer"><LoaderCircle v-if="busy" class="h-4 w-4 animate-spin" />确认移交管理权</button></template></UiModal>

    <UiModal :open="showMembers" title="授权成员管理" description="复制访问码，或通过姓名搜索并直接添加成员。" size="lg" :busy="busy" @close="showMembers = false"><div class="rounded-2xl bg-indigo-50/70 p-4"><div class="flex flex-wrap items-center justify-between gap-3"><div><p class="text-xs text-indigo-500">当前访问码 · v{{ product.codeVersion }}</p><p class="mt-2 font-mono text-lg font-semibold tracking-[.12em] text-indigo-950">{{ showAccessPlain ? product.accessCode : '••••••••' }}</p><p class="mt-2 text-xs text-indigo-600">{{ product.accessCodeExpiresAt ? `有效至 ${formatDate(product.accessCodeExpiresAt)}` : '长期有效' }} · 到期只影响新兑换</p></div><div class="flex gap-2"><button class="icon-button bg-white" type="button" :aria-label="showAccessPlain ? '隐藏访问码' : '显示访问码'" @click="showAccessPlain = !showAccessPlain"><Eye v-if="!showAccessPlain" class="h-4 w-4" /><X v-else class="h-4 w-4" /></button><button class="secondary-button compact bg-white" type="button" @click="copyAccessCode"><Copy class="h-4 w-4" />复制</button><button class="secondary-button compact bg-white" type="button" @click="openAccessUpdate"><RefreshCw class="h-4 w-4" />更新访问码</button></div></div></div><div class="mt-5 flex gap-3"><UiSelect v-model="addMemberId" class="min-w-0 flex-1" :options="memberCandidateOptions" aria-label="选择授权成员" searchable search-placeholder="搜索成员姓名或岗位" no-results-text="没有可添加的匹配成员" /><button class="primary-button" type="button" :disabled="busy || !addMemberId" @click="addMember"><UserPlus class="h-4 w-4" />添加成员</button></div><div class="mt-5 divide-y divide-slate-200/70 rounded-2xl border border-slate-200/70 bg-white/55"><div v-if="!memberUsers.length" class="p-8 text-center text-sm text-slate-400">尚无授权成员</div><div v-for="item in memberUsers" :key="item.user.id" class="flex items-center gap-3 p-4"><span class="avatar-mini large">{{ item.user.name.slice(0,1) }}</span><div class="min-w-0 flex-1"><p class="text-sm font-medium text-slate-800">{{ item.user.name }}</p><p class="mt-1 text-xs text-slate-400">{{ item.user.job }} · {{ item.member.source === 'code' ? '访问码授权' : item.member.source === 'transfer' ? '管理权移交保留' : '负责人添加' }}</p></div><button class="text-button danger-text" type="button" :disabled="busy" @click="askRevoke(item.user)">收回权限</button></div></div></UiModal>

    <UiModal :open="showAccessCode" title="更新产品访问码" description="新访问码和有效期只影响后续兑换，已有成员权限保持不变。" size="sm" :busy="busy" @close="closeAccessUpdate"><div class="rounded-2xl border border-indigo-100 bg-indigo-50 p-4 text-sm leading-6 text-indigo-700"><ShieldCheck class="mb-2 h-5 w-5" />访问码过期后不能再兑换；已有授权与历史批注不受影响。</div><div class="mt-5"><label class="field-label" for="next-access-code">新访问码</label><div class="mt-2 flex gap-2"><input id="next-access-code" v-model="nextAccessCode" class="form-input min-w-0 flex-1 font-mono tracking-wide" autocomplete="off" placeholder="手动输入或随机生成" /><button class="secondary-button compact" type="button" :disabled="busy" @click="randomizeAccessCode"><Dices class="h-4 w-4" />随机生成</button></div><p class="mt-2 text-xs text-slate-400">随机码会避开容易混淆的字符，生成后仍可手动修改。</p></div><div class="mt-5 rounded-2xl bg-slate-50 p-4"><label class="inline-flex items-center gap-2 text-sm font-medium text-slate-700"><input v-model="nextAccessNeverExpires" class="h-4 w-4 accent-indigo-600" type="checkbox" />长期有效</label><UiDateTimePicker v-if="!nextAccessNeverExpires" v-model="nextAccessCodeExpiresAt" class="mt-3" aria-label="访问码有效期" placeholder="选择访问码失效时间" /></div><template #footer><button class="secondary-button" type="button" @click="closeAccessUpdate">取消</button><button class="primary-button" type="button" :disabled="busy || nextAccessCode.trim().length < 4 || (!nextAccessNeverExpires && !nextAccessCodeExpiresAt)" @click="rotateAccessCode"><LoaderCircle v-if="busy" class="h-4 w-4 animate-spin" />保存新访问码</button></template></UiModal>

    <UiModal :open="Boolean(revokeTarget)" title="收回成员权限" description="该成员将立即失去此产品的访问权限。" tone="danger" size="sm" :busy="busy" @close="closeRevoke"><div v-if="revokeTarget" class="confirm-target flex items-center gap-3"><span class="avatar-mini large">{{ revokeTarget.name.slice(0,1) }}</span><div><p class="text-sm font-semibold text-slate-800">{{ revokeTarget.name }}</p><p class="mt-1 text-xs text-slate-500">{{ revokeTarget.job }} · 历史内容仍保留作者归属</p></div></div><div class="confirm-impact"><KeyRound /><span>已有批注和回复不会删除；再次访问需要重新获得授权。</span></div><template #footer><button class="secondary-button" type="button" :disabled="busy" @click="closeRevoke">取消</button><button class="danger-button" type="button" :disabled="busy" @click="revokeMember"><LoaderCircle v-if="busy" class="h-4 w-4 animate-spin" />确认收回成员权限</button></template></UiModal>

    <UiModal :open="showState" :title="targetState === 'online' ? '上架产品' : targetState === 'offline' ? '下架产品' : targetState === 'trash' ? '移入回收站' : '恢复产品'" :description="targetState === 'online' ? '有效授权成员将可以访问当前原型。' : targetState === 'offline' ? '普通成员将立即无法访问，历史数据继续保留。' : targetState === 'trash' ? '产品会立即从普通成员总览隐藏。' : '产品将恢复到已下架状态。'" :tone="targetState === 'trash' ? 'danger' : targetState === 'offline' ? 'warning' : 'default'" size="sm" :busy="busy" @close="showState = false"><div class="confirm-target"><p class="confirm-target-label">操作产品</p><p class="confirm-target-value">{{ product.name }}</p></div><div v-if="targetState === 'trash'" class="confirm-impact"><Trash2 /><span>版本、上传记录与批注不会永久删除，可从回收站恢复。</span></div><template #footer><button class="secondary-button" type="button" :disabled="busy" @click="showState = false">取消</button><button :class="targetState === 'trash' ? 'danger-button' : 'primary-button'" type="button" :disabled="busy" @click="updateState"><LoaderCircle v-if="busy" class="h-4 w-4 animate-spin" />{{ targetState === 'trash' ? '确认移入回收站' : targetState === 'offline' ? '确认下架产品' : targetState === 'online' ? '确认上架产品' : '确认恢复产品' }}</button></template></UiModal>

    <UiModal :open="showRollback" title="回滚产品版本" description="回滚只切换当前版本，目标之后的版本和上传记录仍会保留。" tone="warning" size="sm" :busy="busy" @close="showRollback = false"><div v-if="targetVersion" class="space-y-3"><div class="confirm-target"><p class="confirm-target-label">当前版本</p><p class="confirm-target-value font-mono">{{ product.currentVersion }}</p></div><div class="flex justify-center"><RotateCcw class="h-5 w-5 text-indigo-500" /></div><div class="rounded-2xl border border-indigo-200 bg-indigo-50 p-4"><p class="text-xs text-indigo-500">目标版本</p><p class="mt-1 font-mono font-semibold text-indigo-950">{{ targetVersion.version }}</p><p class="mt-2 text-xs text-indigo-700">{{ targetVersion.note }}</p></div><p class="text-xs leading-5 text-slate-500">执行期间会锁定本产品的发布与回滚操作；失败时继续使用原当前版本。</p></div><template #footer><button class="secondary-button" type="button" :disabled="busy" @click="showRollback = false">取消</button><button class="danger-button" type="button" :disabled="busy" @click="rollback"><LoaderCircle v-if="busy" class="h-4 w-4 animate-spin" />确认回滚版本</button></template></UiModal>
  </section>
</template>
