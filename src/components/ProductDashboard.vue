<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  ArchiveRestore, ArrowRight, CalendarClock, CheckCircle2, CircleDot, Clipboard,
  Eye, FileUp, FolderKanban, MoreHorizontal, PencilLine, Plus, RefreshCw, Search,
  Sparkles, Trash2, UsersRound,
} from 'lucide-vue-next'
import { copyText } from '../clipboard'
import type { BootstrapState, Product, ProductState, ReviewState } from '../contracts'
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

const emit = defineEmits<{
  upload: [productId?: string]
  detail: [productId: string, intent?: 'edit' | 'members' | 'transfer']
  review: [productId: string]
  retry: []
  notify: [message: string, tone?: 'success' | 'error' | 'info']
}>()

const search = ref('')
const owner = ref('')
const lifecycle = ref('')
const reviewState = ref('')
const openMenu = ref('')
const confirmProduct = ref<Product | null>(null)
const confirmState = ref<ProductState | 'restore' | null>(null)
const lifecycleOptions = [
  { value: '', label: '全部生命周期' },
  { value: 'draft', label: '草稿' },
  { value: 'online', label: '已上架' },
  { value: 'offline', label: '已下架' },
]
const reviewStateOptions = [
  { value: '', label: '全部评审状态' },
  { value: 'pending', label: '待评审' },
  { value: 'reviewing', label: '评审中' },
  { value: 'completed', label: '评审完成' },
]
const busy = ref(false)
const page = ref(1)
const pageSize = 20

const canCreate = computed(() => props.state.currentUser.job === '产品' || props.state.currentUser.role === 'admin')
const ownerOptions = computed(() => [...new Set(props.state.products.filter((item) => item.state !== 'trash').map((item) => item.ownerId))].map((id) => props.state.users.find((user) => user.id === id)).filter((user): user is NonNullable<typeof user> => Boolean(user)))
const ownerOptionsForSelect = computed(() => [
  { value: '', label: '全部负责人' },
  ...ownerOptions.value.map((user) => ({ value: user.id, label: user.name })),
])
const userName = (id: string) => props.state.users.find((item) => item.id === id)?.name ?? '未知成员'
const manageable = (product: Product) => props.state.currentUser.role === 'admin' || product.ownerId === props.state.currentUser.id

const filtered = computed(() => props.state.products.filter((product) => {
  const q = search.value.trim().toLowerCase()
  return product.state !== 'trash'
    && (!q || product.name.toLowerCase().includes(q))
    && (!owner.value || product.ownerId === owner.value)
    && (!lifecycle.value || product.state === lifecycle.value)
    && (!reviewState.value || product.reviewState === reviewState.value)
}))
const pagedProducts = computed(() => filtered.value.slice((page.value - 1) * pageSize, page.value * pageSize))

watch([search, owner, lifecycle, reviewState], () => {
  page.value = 1
  openMenu.value = ''
})
watch(() => filtered.value.length, (total) => {
  const lastPage = Math.max(1, Math.ceil(total / pageSize))
  if (page.value > lastPage) page.value = lastPage
})

const kpis = computed(() => {
  const activeProducts = props.state.products.filter((item) => item.state !== 'trash')
  const productIds = new Set(activeProducts.map((item) => item.id))
  const annotations = props.state.annotations.filter((item) => productIds.has(item.productId) && !item.deleted)
  return [
    { label: '可见产品', value: activeProducts.length, hint: '含负责与已授权', icon: FolderKanban, tone: 'indigo' },
    { label: '待处理批注', value: annotations.filter((item) => item.status === 'open').length, hint: '需要继续跟进', icon: CircleDot, tone: 'pink' },
    { label: '评审进行中', value: activeProducts.filter((item) => item.reviewState === 'reviewing').length, hint: '当前活跃产品', icon: UsersRound, tone: 'violet' },
    { label: '待重新定位', value: annotations.filter((item) => item.status === 'needs-relocation').length, hint: '版本变更影响', icon: CalendarClock, tone: 'blue' },
  ]
})

const confirmCopy: Record<string, { title: string; description: string; action: string }> = {
  online: { title: '上架产品', description: '上架后，有效授权成员将可以继续访问原型。', action: '确认上架' },
  offline: { title: '下架产品', description: '下架后，普通授权成员将立即无法访问，历史数据会继续保留。', action: '确认下架' },
  trash: { title: '移入回收站', description: '产品将立即从普通成员总览隐藏。', action: '确认移入回收站' },
  restore: { title: '恢复产品', description: '恢复后产品进入已下架状态，检查无误后可重新上架。', action: '确认恢复' },
}

function askState(product: Product, state: ProductState | 'restore') {
  openMenu.value = ''
  confirmProduct.value = product
  confirmState.value = state
}

async function applyState() {
  if (!confirmProduct.value || !confirmState.value) return
  busy.value = true
  const ok = confirmState.value === 'restore'
    ? await props.action('product.restore', { productId: confirmProduct.value.id })
    : await props.action('product.state', { productId: confirmProduct.value.id, state: confirmState.value })
  busy.value = false
  if (ok) {
    confirmProduct.value = null
    confirmState.value = null
  }
}

function resetFilters() {
  search.value = ''
  owner.value = ''
  lifecycle.value = ''
  reviewState.value = ''
}

async function copyCode(product: Product) {
  openMenu.value = ''
  try {
    await copyText(product.accessCode)
    emit('notify', '访问码已复制', 'success')
    void props.action('product.copyAccessCode', { productId: product.id })
  } catch {
    emit('notify', '复制失败，请进入授权成员管理查看并手动复制访问码', 'error')
  }
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}
</script>

<template>
  <section>
    <div class="flex flex-wrap items-end justify-between gap-5">
      <div>
        <p class="eyebrow">PRODUCT PORTFOLIO</p>
        <h1 class="page-title">产品总览</h1>
        <p class="page-description">查看产品状态、评审进度和需要你处理的批注。</p>
      </div>
      <button v-if="canCreate" class="primary-button" type="button" @click="emit('upload')"><Plus class="h-4 w-4" />产品上传</button>
    </div>

    <div class="mt-7 grid gap-4 xl:grid-cols-4">
      <article v-for="item in kpis" :key="item.label" class="glass-card group relative overflow-hidden p-5 transition hover:-translate-y-0.5 hover:border-indigo-200">
        <div :class="['absolute -right-8 -top-8 h-24 w-24 rounded-full blur-2xl opacity-45', item.tone === 'pink' ? 'bg-pink-200' : item.tone === 'violet' ? 'bg-violet-200' : item.tone === 'blue' ? 'bg-sky-200' : 'bg-indigo-200']" />
        <div class="relative flex items-start justify-between">
          <div><p class="text-sm font-medium text-slate-500">{{ item.label }}</p><p class="mt-3 font-mono text-3xl font-semibold tracking-tight text-slate-950">{{ item.value.toString().padStart(2, '0') }}</p><p class="mt-2 text-xs text-slate-400">{{ item.hint }}</p></div>
          <div class="grid h-10 w-10 place-items-center rounded-2xl bg-white/80 text-indigo-600 shadow-sm"><component :is="item.icon" class="h-5 w-5" /></div>
        </div>
      </article>
    </div>

    <div class="glass-card mt-6 p-5">
      <div class="flex flex-wrap items-center gap-3">
        <label class="input-shell min-w-64 flex-1"><Search class="h-4 w-4 text-slate-400" /><input v-model="search" aria-label="按产品名称搜索" placeholder="搜索产品名称" /></label>
        <UiSelect v-model="owner" :options="ownerOptionsForSelect" aria-label="筛选产品负责人"><template #prefix><UsersRound class="h-4 w-4" /></template></UiSelect>
        <UiSelect v-model="lifecycle" :options="lifecycleOptions" aria-label="筛选生命周期" />
        <UiSelect v-model="reviewState" :options="reviewStateOptions" aria-label="筛选评审状态" />
        <button class="icon-button" type="button" aria-label="清空筛选" title="清空筛选" @click="resetFilters"><RefreshCw class="h-4 w-4" /></button>
      </div>
    </div>

    <div class="mt-6">
      <PageState v-if="loading" mode="loading" />
      <PageState v-else-if="error" mode="error" :description="error" @retry="emit('retry')" />
      <PageState v-else-if="!filtered.length" mode="empty" title="没有符合条件的产品" description="调整搜索或筛选条件；产品负责人也可以进入产品上传。" />
      <div v-else class="relative isolate grid gap-4 xl:grid-cols-2 min-[1440px]:grid-cols-3">
        <article
          v-for="product in pagedProducts"
          :key="product.id"
          :class="[
            'glass-card group relative p-5 transition hover:-translate-y-0.5 hover:border-indigo-200/80',
            openMenu === product.id ? 'z-[70]' : 'z-0 hover:z-10',
          ]"
        >
          <div class="flex items-start gap-4">
            <div class="product-mark">{{ product.name.slice(0, 1) }}</div>
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2"><h2 class="truncate text-base font-semibold text-slate-950">{{ product.name }}</h2><StatusPill :value="product.state" /><StatusPill :value="product.reviewState" /></div>
              <p class="mt-2 line-clamp-2 min-h-10 text-sm leading-5 text-slate-500">{{ product.description || '暂未填写产品简介。' }}</p>
            </div>
            <div class="relative">
              <button class="icon-button" type="button" aria-label="更多操作" @click="openMenu = openMenu === product.id ? '' : product.id"><MoreHorizontal class="h-5 w-5" /></button>
              <div v-if="openMenu === product.id" class="popover-menu right-0 top-11 z-[80] max-h-[min(420px,calc(100vh-120px))] overflow-y-auto">
                <button type="button" @click="emit('detail', product.id); openMenu = ''"><Eye class="h-4 w-4" />查看详情</button>
                <button v-if="manageable(product)" type="button" @click="emit('detail', product.id, 'edit'); openMenu = ''"><PencilLine class="h-4 w-4" />编辑产品</button>
                <button v-if="manageable(product)" type="button" @click="emit('detail', product.id, 'members'); openMenu = ''"><UsersRound class="h-4 w-4" />授权成员管理</button>
                <button v-if="manageable(product)" type="button" @click="copyCode(product)"><Clipboard class="h-4 w-4" />复制访问码</button>
                <button v-if="manageable(product)" type="button" @click="emit('detail', product.id, 'transfer'); openMenu = ''"><RefreshCw class="h-4 w-4" />移交管理权</button>
                <button v-if="manageable(product) && canCreate" type="button" @click="emit('upload', product.id); openMenu = ''"><FileUp class="h-4 w-4" />上传新版本</button>
                <button v-if="manageable(product) && product.state === 'online'" type="button" @click="askState(product, 'offline')"><ArchiveRestore class="h-4 w-4" />下架产品</button>
                <button v-if="manageable(product) && ['offline', 'draft'].includes(product.state)" type="button" @click="askState(product, 'online')"><CheckCircle2 class="h-4 w-4" />上架产品</button>
                <button v-if="manageable(product) && product.state !== 'trash'" class="danger" type="button" @click="askState(product, 'trash')"><Trash2 class="h-4 w-4" />移入回收站</button>
                <button v-if="manageable(product) && product.state === 'trash'" type="button" @click="askState(product, 'restore')"><ArchiveRestore class="h-4 w-4" />恢复产品</button>
              </div>
            </div>
          </div>
          <div class="mt-5 grid grid-cols-3 gap-3 rounded-2xl border border-white/80 bg-white/45 p-3 text-xs">
            <div><p class="text-slate-400">负责人</p><p class="mt-1 truncate font-medium text-slate-700">{{ userName(product.ownerId) }}</p></div>
            <div><p class="text-slate-400">当前版本</p><p class="mt-1 font-mono font-medium text-slate-700">{{ product.currentVersion || '尚未发布' }}</p></div>
            <div><p class="text-slate-400">最近更新</p><p class="mt-1 font-medium text-slate-700">{{ formatDate(product.updatedAt) }}</p></div>
          </div>
          <div class="mt-5 flex items-center justify-between gap-4">
            <div class="flex -space-x-2"><div v-for="member in product.members.slice(0, 4)" :key="member.userId" class="grid h-7 w-7 place-items-center rounded-full border-2 border-white bg-slate-100 text-[10px] font-semibold text-slate-600" :title="userName(member.userId)">{{ userName(member.userId).slice(0, 1) }}</div><div v-if="product.members.length > 4" class="grid h-7 w-7 place-items-center rounded-full border-2 border-white bg-indigo-50 text-[10px] font-semibold text-indigo-600">+{{ product.members.length - 4 }}</div></div>
            <div class="flex items-center gap-2"><button class="secondary-button compact" type="button" @click="emit('detail', product.id)">产品详情</button><button class="text-button" type="button" :disabled="product.state === 'trash'" @click="emit('review', product.id)">查看原型<ArrowRight class="h-4 w-4" /></button></div>
          </div>
        </article>
      </div>
      <PaginationBar v-if="filtered.length" :page="page" :page-size="pageSize" :total="filtered.length" @change="page = $event; openMenu = ''" />
    </div>

    <UiModal :open="Boolean(confirmProduct && confirmState)" :title="confirmState ? confirmCopy[confirmState].title : ''" :description="confirmState ? confirmCopy[confirmState].description : ''" :tone="confirmState === 'trash' ? 'danger' : confirmState === 'offline' ? 'warning' : 'default'" size="sm" :busy="busy" @close="confirmProduct = null; confirmState = null">
      <div v-if="confirmProduct" class="confirm-target"><p class="confirm-target-label">操作产品</p><p class="confirm-target-value">{{ confirmProduct.name }}</p></div>
      <div v-if="confirmState === 'trash'" class="confirm-impact"><Trash2 /><span>版本、上传记录与批注会继续保留，可由负责人从回收站恢复。</span></div>
      <template #footer><button class="secondary-button" type="button" :disabled="busy" @click="confirmProduct = null; confirmState = null">取消</button><button :class="confirmState === 'trash' ? 'danger-button' : 'primary-button'" type="button" :disabled="busy" @click="applyState"><Sparkles v-if="busy" class="h-4 w-4 animate-spin" />{{ busy ? '正在处理' : confirmState ? confirmCopy[confirmState].action : '' }}</button></template>
    </UiModal>
  </section>
</template>
