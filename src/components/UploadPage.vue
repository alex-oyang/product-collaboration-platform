<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { Archive, CheckCircle2, Dices, FileCode2, FileUp, History, LoaderCircle, RotateCcw, Save, UploadCloud, X } from 'lucide-vue-next'
import type { BootstrapState, Product } from '../contracts'
import type { ProductUploadPayload } from '../api'
import { generateAccessCode } from '../accessCode'
import UploadRecordsModal from './UploadRecordsModal.vue'
import UiDateTimePicker from './UiDateTimePicker.vue'
import UiSelect from './UiSelect.vue'

const props = defineProps<{
  state: BootstrapState
  initialProductId?: string
  action: (type: string, payload: Record<string, unknown>) => Promise<boolean>
  publish: (payload: ProductUploadPayload) => Promise<boolean>
}>()

const emit = defineEmits<{ complete: [productId?: string] }>()

const mode = ref<'create' | 'update'>(props.initialProductId ? 'update' : 'create')
const selectedProductId = ref(props.initialProductId ?? '')
const file = ref<File | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const dragging = ref(false)
const saving = ref(false)
const publishing = ref(false)
const fileError = ref('')
const showRecords = ref(false)
const codeNeverExpires = ref(true)
const form = reactive({ name: '', manager: '', description: '', longNote: '', ownerId: props.state.currentUser.id, accessCode: '', accessCodeExpiresAt: '', versionNote: '' })

const manageableProducts = computed(() => props.state.products.filter((item) => props.state.currentUser.role === 'admin' || item.ownerId === props.state.currentUser.id))
const selectedProduct = computed(() => manageableProducts.value.find((item) => item.id === selectedProductId.value))
const manageableProductOptions = computed(() => manageableProducts.value.map((product) => ({
  value: product.id,
  label: `${product.name} · ${product.currentVersion || '尚未发布'}`,
})))
const ownerOptions = computed(() => props.state.users
  .filter((item) => item.enabled && (item.job === '产品' || item.role === 'admin'))
  .map((user) => ({ value: user.id, label: user.name })))
const canSave = computed(() => form.name.trim() && form.manager.trim() && !saving.value && !publishing.value)
const canPublish = computed(() => canSave.value && file.value && form.versionNote.trim() && form.accessCode.trim())

function fill(product?: Product) {
  form.name = product?.name ?? ''
  form.manager = product?.manager ?? ''
  form.description = product?.description ?? ''
  form.longNote = product?.longNote ?? ''
  form.ownerId = product?.ownerId ?? props.state.currentUser.id
  form.accessCode = product?.accessCode ?? ''
  form.accessCodeExpiresAt = product?.accessCodeExpiresAt ? new Date(product.accessCodeExpiresAt).toISOString().slice(0, 16) : ''
  codeNeverExpires.value = !product?.accessCodeExpiresAt
  form.versionNote = ''
  file.value = null
  fileError.value = ''
  if (fileInput.value) fileInput.value.value = ''
}

watch(selectedProduct, (product) => { if (mode.value === 'update') fill(product) }, { immediate: true })
watch(mode, (next) => {
  selectedProductId.value = next === 'update' ? (props.initialProductId ?? manageableProducts.value[0]?.id ?? '') : ''
  fill(next === 'update' ? manageableProducts.value.find((item) => item.id === selectedProductId.value) : undefined)
})

function chooseFile(candidate?: File) {
  if (!candidate) return
  const name = candidate.name.toLowerCase()
  const supported = ['.html', '.htm', '.zip', '.tar.gz', '.tgz'].some((suffix) => name.endsWith(suffix))
  if (!supported) {
    fileError.value = '仅支持 HTML、ZIP、TAR.GZ 或 TGZ 文件'
    if (fileInput.value) fileInput.value.value = ''
    return
  }
  fileError.value = ''
  file.value = candidate
}

function onDrop(event: DragEvent) {
  dragging.value = false
  chooseFile(event.dataTransfer?.files[0])
}

function fileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function randomizeAccessCode() {
  form.accessCode = generateAccessCode(props.state.products.map((item) => item.accessCode))
}

async function saveDraft() {
  if (!canSave.value) return
  saving.value = true
  const payload = { name: form.name.trim(), manager: form.manager.trim(), description: form.description.trim(), longNote: form.longNote.trim(), accessCode: form.accessCode.trim(), accessCodeExpiresAt: codeNeverExpires.value || !form.accessCodeExpiresAt ? null : new Date(form.accessCodeExpiresAt).toISOString(), ownerId: form.ownerId }
  const ok = mode.value === 'create'
    ? await props.action('product.saveDraft', payload)
    : await props.action('product.update', { productId: selectedProductId.value, ...payload })
  saving.value = false
  if (ok) emit('complete', selectedProductId.value || undefined)
}

async function publishProduct() {
  if (!canPublish.value || !file.value) return
  publishing.value = true
  const ok = await props.publish({
    mode: mode.value,
    productId: mode.value === 'update' ? selectedProductId.value : undefined,
    name: form.name.trim(),
    manager: form.manager.trim(),
    description: form.description.trim(),
    longNote: form.longNote.trim(),
    ownerId: form.ownerId,
    accessCode: form.accessCode.trim(),
    accessCodeExpiresAt: codeNeverExpires.value || !form.accessCodeExpiresAt ? null : new Date(form.accessCodeExpiresAt).toISOString(),
    versionNote: form.versionNote.trim(),
    file: file.value,
  })
  publishing.value = false
  if (ok) {
    file.value = null
    form.versionNote = ''
    emit('complete', selectedProductId.value || undefined)
  }
}
</script>

<template>
  <section>
    <div class="flex flex-wrap items-end justify-between gap-5">
      <div><p class="eyebrow">PRODUCT RELEASE</p><h1 class="page-title">产品上传</h1><p class="page-description">新建产品或为已有产品发布一个不可变版本。</p></div>
      <button class="secondary-button" type="button" @click="showRecords = true"><History class="h-4 w-4" />上传记录</button>
    </div>

    <div class="mt-7 grid gap-6 xl:grid-cols-[minmax(0,1.25fr)_360px]">
      <form class="glass-card p-6" @submit.prevent="publishProduct">
        <div class="flex rounded-2xl bg-slate-100/80 p-1">
          <button :class="['segmented-button', mode === 'create' && 'active']" type="button" @click="mode = 'create'">新建产品</button>
          <button :class="['segmented-button', mode === 'update' && 'active']" type="button" @click="mode = 'update'">更新已有产品</button>
        </div>

        <div v-if="mode === 'update'" class="mt-6">
          <label class="field-label" for="upload-product">选择产品</label>
          <UiSelect v-model="selectedProductId" class="mt-2 w-full" :options="manageableProductOptions" aria-label="选择要更新的产品" />
        </div>

        <div class="mt-6 grid gap-5 md:grid-cols-2">
          <label><span class="field-label">产品名称 <b>*</b></span><input v-model="form.name" class="form-input mt-2" maxlength="80" placeholder="例如：客户运营分析平台" /></label>
          <label><span class="field-label">项目经理 <b>*</b></span><input v-model="form.manager" class="form-input mt-2" maxlength="40" placeholder="填写项目经理姓名" /></label>
          <label class="md:col-span-2"><span class="field-label">产品简介</span><textarea v-model="form.description" class="form-textarea mt-2" rows="3" placeholder="说明产品用途和本次评审目标" /></label>
          <label class="md:col-span-2"><span class="field-label">长期备注</span><textarea v-model="form.longNote" class="form-textarea mt-2" rows="3" placeholder="长期保留的产品背景、约束或交付说明" /></label>
          <label><span class="field-label">产品负责人</span><UiSelect v-model="form.ownerId" class="mt-2 w-full" :options="ownerOptions" aria-label="选择产品负责人" :disabled="mode === 'update'" /><small v-if="mode === 'update'" class="mt-1 block text-xs text-slate-400">更新负责人请在产品详情中使用“移交管理权”。</small></label>
          <div><label class="field-label" for="product-access-code">产品访问码 <b>*</b></label><div class="mt-2 flex gap-2"><input id="product-access-code" v-model="form.accessCode" class="form-input min-w-0 flex-1 font-mono tracking-wide" autocomplete="off" placeholder="手动输入或随机生成" /><button class="secondary-button compact" type="button" :disabled="saving || publishing" @click="randomizeAccessCode"><Dices class="h-4 w-4" />随机生成</button></div></div>
          <div class="md:col-span-2 rounded-2xl border border-slate-200/70 bg-slate-50/60 p-4"><div class="flex flex-wrap items-center justify-between gap-3"><div><p class="field-label">访问码有效期</p><p class="mt-1 text-xs text-slate-400">过期后不能再兑换；已有授权与历史批注不受影响。</p></div><label class="inline-flex items-center gap-2 text-xs font-medium text-slate-600"><input v-model="codeNeverExpires" class="h-4 w-4 accent-indigo-600" type="checkbox" />长期有效</label></div><UiDateTimePicker v-if="!codeNeverExpires" v-model="form.accessCodeExpiresAt" class="mt-4" aria-label="访问码有效期" placeholder="选择访问码失效时间" /></div>
          <label class="md:col-span-2"><span class="field-label">版本说明 <b>*</b></span><textarea v-model="form.versionNote" class="form-textarea mt-2" rows="3" placeholder="本次发布修改了什么，需要重点评审什么" /></label>
        </div>

        <div class="mt-6">
          <span class="field-label">原型文件 <b>*</b></span>
          <input ref="fileInput" class="sr-only" type="file" accept=".html,.htm,.zip,.tar.gz,.tgz,text/html,application/zip,application/gzip" @change="chooseFile(($event.target as HTMLInputElement).files?.[0])" />
          <button v-if="!file" :class="['upload-drop mt-2', dragging && 'dragging']" type="button" @click="fileInput?.click()" @dragenter.prevent="dragging = true" @dragover.prevent @dragleave.prevent="dragging = false" @drop.prevent="onDrop">
            <span class="grid h-14 w-14 place-items-center rounded-2xl bg-indigo-50 text-indigo-600"><UploadCloud class="h-7 w-7" /></span>
            <span class="mt-4 text-sm font-semibold text-slate-800">选择 HTML、ZIP 或源码压缩包</span><span class="mt-1 text-xs text-slate-400">支持 .tar.gz / .tgz，点击选择或拖放文件</span><span class="mt-4 rounded-full bg-white px-3 py-1 text-[11px] text-slate-500 shadow-sm">压缩包最大 200 MB · 单文件最大 100 MB</span>
          </button>
          <div v-else class="mt-2 flex items-center gap-4 rounded-2xl border border-indigo-200 bg-indigo-50/65 p-4">
            <div class="grid h-11 w-11 place-items-center rounded-xl bg-white text-indigo-600 shadow-sm"><FileCode2 class="h-5 w-5" /></div>
            <div class="min-w-0 flex-1"><p class="truncate text-sm font-semibold text-slate-800">{{ file.name }}</p><p class="mt-1 text-xs text-slate-500">{{ fileSize(file.size) }} · 等待发布</p></div>
            <button class="icon-button" type="button" aria-label="移除文件" :disabled="publishing" @click="file = null; fileError = ''; if (fileInput) fileInput.value = ''"><X class="h-4 w-4" /></button>
          </div>
          <p v-if="fileError" class="mt-2 text-xs font-medium text-rose-600">{{ fileError }}</p>
          <p class="mt-2 text-xs leading-5 text-slate-500">Vite 项目请上传设置 <code class="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px]">base: './'</code> 后的 dist ZIP；Next.js 源码可上传 TAR.GZ / TGZ，由本机自动构建，仅上传可信项目。</p>
        </div>

        <div class="mt-7 flex flex-wrap justify-end gap-3 border-t border-slate-200/70 pt-5">
          <button class="secondary-button" type="button" :disabled="!canSave" @click="saveDraft"><LoaderCircle v-if="saving" class="h-4 w-4 animate-spin" /><Save v-else class="h-4 w-4" />{{ saving ? '正在保存' : '保存草稿' }}</button>
          <button class="primary-button" type="submit" :disabled="!canPublish"><LoaderCircle v-if="publishing" class="h-4 w-4 animate-spin" /><FileUp v-else class="h-4 w-4" />{{ publishing ? '正在发布' : '发布产品' }}</button>
        </div>
      </form>

      <aside class="space-y-4">
        <article class="glass-card p-5"><div class="flex items-center gap-3"><div class="grid h-10 w-10 place-items-center rounded-2xl bg-emerald-50 text-emerald-600"><CheckCircle2 class="h-5 w-5" /></div><div><h2 class="text-sm font-semibold text-slate-900">发布后自动留档</h2><p class="mt-1 text-xs text-slate-500">版本、文件指纹和上传人一并记录</p></div></div></article>
        <article class="glass-card p-5"><div class="flex items-center gap-3"><div class="grid h-10 w-10 place-items-center rounded-2xl bg-violet-50 text-violet-600"><RotateCcw class="h-5 w-5" /></div><div><h2 class="text-sm font-semibold text-slate-900">历史版本可回滚</h2><p class="mt-1 text-xs text-slate-500">回滚只切换当前版本，不删除后续记录</p></div></div></article>
        <article class="glass-card p-5"><div class="flex items-center gap-3"><div class="grid h-10 w-10 place-items-center rounded-2xl bg-amber-50 text-amber-600"><Archive class="h-5 w-5" /></div><div><h2 class="text-sm font-semibold text-slate-900">成功原包长期保留</h2><p class="mt-1 text-xs text-slate-500">失败临时文件按保留策略自动清理</p></div></div></article>
      </aside>
    </div>

    <UploadRecordsModal :open="showRecords" :state="state" @close="showRecords = false" />
  </section>
</template>
