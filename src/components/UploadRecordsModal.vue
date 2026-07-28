<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { FileArchive, Search } from 'lucide-vue-next'
import type { BootstrapState } from '../contracts'
import PaginationBar from './PaginationBar.vue'
import StatusPill from './StatusPill.vue'
import UiModal from './UiModal.vue'
import UiSelect from './UiSelect.vue'

const props = defineProps<{ open: boolean; state: BootstrapState; productId?: string }>()
const emit = defineEmits<{ close: [] }>()

const query = ref('')
const status = ref('')
const uploader = ref('')
const page = ref(1)
const pageSize = 6
const statusOptions = [
  { value: '', label: '全部状态' },
  { value: 'success', label: '发布成功' },
  { value: 'failed', label: '发布失败' },
]
const uploaderOptions = computed(() => [
  { value: '', label: '全部上传人' },
  ...props.state.users.map((user) => ({ value: user.id, label: user.name })),
])

const filtered = computed(() => props.state.uploads.filter((record) => {
  const q = query.value.trim().toLowerCase()
  return (!props.productId || record.productId === props.productId)
    && (!q || record.productName.toLowerCase().includes(q) || record.fileName.toLowerCase().includes(q) || (record.version ?? '').includes(q))
    && (!status.value || record.status === status.value)
    && (!uploader.value || record.uploaderId === uploader.value)
}))
const paged = computed(() => filtered.value.slice((page.value - 1) * pageSize, page.value * pageSize))
const userName = (id: string) => props.state.users.find((item) => item.id === id)?.name ?? '未知成员'

watch([query, status, uploader], () => { page.value = 1 })
watch(() => props.open, (open) => {
  if (open) { query.value = ''; status.value = ''; uploader.value = ''; page.value = 1 }
})

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

</script>

<template>
  <UiModal :open="open" title="上传记录" description="查询所有上传结果、版本和失败原因。记录不会因临时文件清理而消失。" size="xl" @close="emit('close')">
    <div class="flex flex-wrap gap-3">
      <label class="input-shell min-w-60 flex-1"><Search class="h-4 w-4 text-slate-400" /><input v-model="query" aria-label="搜索上传记录" placeholder="搜索产品、文件或版本" /></label>
      <UiSelect v-model="status" :options="statusOptions" aria-label="筛选上传状态" />
      <UiSelect v-model="uploader" :options="uploaderOptions" aria-label="筛选上传人" />
    </div>

    <div v-if="!paged.length" class="mt-5 rounded-2xl border border-dashed border-slate-200 py-16 text-center"><FileArchive class="mx-auto h-8 w-8 text-slate-300" /><p class="mt-3 text-sm font-medium text-slate-700">没有符合条件的上传记录</p><p class="mt-1 text-xs text-slate-400">调整搜索条件后再试。</p></div>
    <div v-else class="table-shell mt-5">
      <div class="table-head grid grid-cols-[minmax(0,1.55fr)_.75fr_.9fr_.7fr_.85fr] items-center gap-4"><span>产品与文件</span><span>上传人</span><span>上传时间</span><span>发布结果</span><span>生成版本</span></div>
      <div v-for="record in paged" :key="record.id" class="table-row grid grid-cols-[minmax(0,1.55fr)_.75fr_.9fr_.7fr_.85fr] items-center gap-4">
        <div class="data-cell data-cell-primary" data-label="产品与文件"><p class="data-cell-title" :title="record.productName">{{ record.productName }}</p><p class="data-cell-subtitle" :title="record.fileName">{{ record.fileName }}</p><p v-if="record.error" class="mt-1 line-clamp-1 text-[11px] text-rose-600" :title="record.error">{{ record.error }}</p></div>
        <span class="data-cell data-cell-person" data-label="上传人"><span class="avatar-mini">{{ userName(record.uploaderId).slice(0,1) }}</span><span class="truncate">{{ userName(record.uploaderId) }}</span></span>
        <span class="data-cell data-cell-time" data-label="上传时间">{{ formatDate(record.createdAt) }}</span>
        <span class="data-cell" data-label="发布结果"><StatusPill :value="record.status" context="upload" /></span>
        <span class="data-cell" data-label="生成版本"><span v-if="record.version" class="table-code">{{ record.version }}</span><span v-else class="text-xs text-slate-400">未生成</span></span>
      </div>
    </div>
    <PaginationBar :page="page" :page-size="pageSize" :total="filtered.length" @change="page = $event" />
  </UiModal>
</template>
