<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ArchiveRestore, ChevronRight, LoaderCircle, Search, Trash2 } from 'lucide-vue-next'
import type { BootstrapState, Product } from '../contracts'
import PageState from './PageState.vue'
import PaginationBar from './PaginationBar.vue'
import UiModal from './UiModal.vue'

const props = defineProps<{
  state: BootstrapState
  loading: boolean
  error: string
  action: (type: string, payload: Record<string, unknown>) => Promise<boolean>
}>()

const emit = defineEmits<{
  detail: [productId: string]
  retry: []
}>()

const query = ref('')
const page = ref(1)
const pageSize = 8
const restoreTarget = ref<Product | null>(null)
const purgeTarget = ref<Product | null>(null)
const busy = ref(false)

const trashProducts = computed(() => props.state.products.filter((product) => product.state === 'trash'))
const filtered = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return trashProducts.value.filter((product) => !keyword
    || product.name.toLowerCase().includes(keyword)
    || product.manager.toLowerCase().includes(keyword)
    || userName(product.ownerId).toLowerCase().includes(keyword))
})
const paged = computed(() => filtered.value.slice((page.value - 1) * pageSize, page.value * pageSize))

watch(query, () => { page.value = 1 })
watch(() => filtered.value.length, (total) => {
  const lastPage = Math.max(1, Math.ceil(total / pageSize))
  if (page.value > lastPage) page.value = lastPage
})

function userName(id: string) {
  return props.state.users.find((user) => user.id === id)?.name ?? '未知成员'
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value))
}

function retainedSummary(product: Product) {
  const uploadCount = props.state.uploads.filter((item) => item.productId === product.id).length
  const annotationCount = props.state.annotations.filter((item) => item.productId === product.id && !item.deleted).length
  return `${product.versions.length} 个版本 · ${uploadCount} 条上传 · ${annotationCount} 条批注`
}

async function restoreProduct() {
  if (!restoreTarget.value) return
  busy.value = true
  const ok = await props.action('product.restore', { productId: restoreTarget.value.id })
  busy.value = false
  if (ok) restoreTarget.value = null
}

async function purgeProduct() {
  if (!purgeTarget.value) return
  busy.value = true
  const ok = await props.action('product.purge', { productId: purgeTarget.value.id })
  busy.value = false
  if (ok) purgeTarget.value = null
}
</script>

<template>
  <section>
    <div class="flex flex-wrap items-end justify-between gap-5">
      <div><p class="eyebrow">RECYCLE BIN</p><h1 class="page-title">回收站</h1><p class="page-description">集中查看已删除产品，并恢复为已下架状态。</p></div>
      <div class="inline-flex items-center gap-2 rounded-xl border border-rose-100 bg-rose-50/70 px-3.5 py-2.5 text-xs font-medium text-rose-700"><Trash2 class="h-4 w-4" />{{ trashProducts.length }} 个产品待处理</div>
    </div>

    <div class="filter-bar mt-7">
      <div class="flex flex-wrap items-center gap-3">
        <label class="input-shell min-w-64 flex-1"><Search class="h-4 w-4 text-slate-400" /><input v-model="query" aria-label="搜索回收站产品" placeholder="搜索产品名称、项目经理或负责人" /></label>
      </div>
    </div>

    <div class="glass-card mt-6 p-5 sm:p-6">
      <PageState v-if="loading" mode="loading" />
      <PageState v-else-if="error" mode="error" :description="error" @retry="emit('retry')" />
      <PageState v-else-if="!paged.length" mode="empty" :title="query ? '没有符合条件的产品' : '回收站为空'" :description="query ? '调整搜索条件后再试。' : '移入回收站的产品会显示在这里，并保留版本、上传记录和批注。'" />
      <div v-else class="data-table-shell">
        <div class="data-table-head grid grid-cols-[1.35fr_.85fr_.95fr_.85fr_1.25fr_.85fr] items-center gap-4"><span>产品</span><span>负责人</span><span>移入时间</span><span>当前版本</span><span>保留内容</span><span class="text-right">操作</span></div>
        <div v-for="product in paged" :key="product.id" class="data-table-row grid grid-cols-[1.35fr_.85fr_.95fr_.85fr_1.25fr_.85fr] items-center gap-4">
          <div class="data-cell data-cell-primary flex min-w-0 items-center gap-3" data-label="产品"><span class="product-mark">{{ product.name.slice(0,1) }}</span><div class="min-w-0"><p class="data-cell-title" :title="product.name">{{ product.name }}</p><p class="data-cell-subtitle">项目经理：{{ product.manager }}</p></div></div>
          <span class="data-cell data-cell-person" data-label="负责人"><span class="avatar-mini">{{ userName(product.ownerId).slice(0,1) }}</span><span class="truncate">{{ userName(product.ownerId) }}</span></span>
          <span class="data-cell data-cell-time" data-label="移入时间">{{ formatDate(product.trashedAt || product.updatedAt) }}</span>
          <span class="data-cell" data-label="当前版本"><span v-if="product.currentVersion" class="table-code">{{ product.currentVersion }}</span><span v-else class="text-xs text-slate-400">尚未发布</span></span>
          <span class="data-cell text-xs leading-5 text-slate-500" data-label="保留内容">{{ retainedSummary(product) }}</span>
          <div class="data-cell data-cell-actions" data-label="操作"><button class="text-button compact" type="button" @click="emit('detail', product.id)">查看详情<ChevronRight class="h-4 w-4" /></button><button class="secondary-button compact" type="button" @click="restoreTarget = product"><ArchiveRestore class="h-4 w-4" />恢复</button><button class="icon-button danger-icon" type="button" title="永久删除" aria-label="永久删除产品" @click="purgeTarget = product"><Trash2 class="h-4 w-4" /></button></div>
        </div>
      </div>
      <PaginationBar v-if="!loading && !error && filtered.length" :page="page" :page-size="pageSize" :total="filtered.length" @change="page = $event" />
    </div>

    <UiModal :open="Boolean(restoreTarget)" title="恢复产品" description="恢复后产品进入已下架状态，不会自动对授权成员开放。" size="sm" :busy="busy" @close="restoreTarget = null">
      <div v-if="restoreTarget" class="confirm-target"><p class="confirm-target-label">待恢复产品</p><p class="confirm-target-value">{{ restoreTarget.name }}</p><p class="mt-2 text-xs leading-5 text-slate-500">{{ retainedSummary(restoreTarget) }}将继续保留。</p></div>
      <div class="rounded-xl border border-indigo-100 bg-indigo-50/75 p-3.5 text-xs leading-5 text-indigo-700"><ArchiveRestore class="mb-2 h-4 w-4" />恢复完成后，可在产品详情检查内容，再决定是否重新上架。</div>
      <template #footer><button class="secondary-button" type="button" :disabled="busy" @click="restoreTarget = null">取消</button><button class="primary-button" type="button" :disabled="busy" @click="restoreProduct"><LoaderCircle v-if="busy" class="h-4 w-4 animate-spin" /><ArchiveRestore v-else class="h-4 w-4" />确认恢复产品</button></template>
    </UiModal>

    <UiModal :open="Boolean(purgeTarget)" title="永久删除产品" description="该操作不可恢复，请确认已不再需要此产品及其全部评审资料。" tone="danger" size="sm" :busy="busy" @close="purgeTarget = null">
      <div v-if="purgeTarget" class="confirm-target danger-target"><p class="confirm-target-label">即将永久删除</p><p class="confirm-target-value">{{ purgeTarget.name }}</p><p class="mt-2 text-xs leading-5 text-rose-700">{{ retainedSummary(purgeTarget) }}将一并删除，批注与回复也无法恢复。</p></div>
      <div class="confirm-impact"><Trash2 /><span>此操作会删除产品数据、所有版本文件、Git 版本仓库、上传记录和批注。</span></div>
      <template #footer><button class="secondary-button" type="button" :disabled="busy" @click="purgeTarget = null">取消</button><button class="danger-button" type="button" :disabled="busy" @click="purgeProduct"><LoaderCircle v-if="busy" class="h-4 w-4 animate-spin" /><Trash2 v-else class="h-4 w-4" />确认永久删除</button></template>
    </UiModal>
  </section>
</template>
