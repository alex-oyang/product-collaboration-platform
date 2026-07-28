<script setup lang="ts">
import { CircleAlert, Inbox, LoaderCircle, RefreshCw } from 'lucide-vue-next'

withDefaults(defineProps<{
  mode: 'loading' | 'empty' | 'error'
  title?: string
  description?: string
}>(), {
  title: '',
  description: '',
})

const emit = defineEmits<{ retry: [] }>()
</script>

<template>
  <div class="grid min-h-64 place-items-center rounded-3xl border border-dashed border-slate-200 bg-white/35 p-8 text-center">
    <div>
      <LoaderCircle v-if="mode === 'loading'" class="mx-auto h-8 w-8 animate-spin text-indigo-500" />
      <Inbox v-else-if="mode === 'empty'" class="mx-auto h-8 w-8 text-slate-300" />
      <CircleAlert v-else class="mx-auto h-8 w-8 text-rose-500" />
      <h3 class="mt-4 text-sm font-semibold text-slate-800">{{ title || (mode === 'loading' ? '正在载入数据' : mode === 'empty' ? '暂时没有内容' : '数据载入失败') }}</h3>
      <p class="mx-auto mt-1 max-w-sm text-sm leading-6 text-slate-500">{{ description || (mode === 'loading' ? '请稍候，正在同步最新状态。' : mode === 'empty' ? '调整筛选条件，或创建第一条内容。' : '检查网络后重新尝试。') }}</p>
      <button v-if="mode === 'error'" class="secondary-button mt-5" type="button" @click="emit('retry')"><RefreshCw class="h-4 w-4" />重新载入</button>
    </div>
  </div>
</template>
