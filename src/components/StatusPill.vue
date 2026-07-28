<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{ value: string; context?: 'default' | 'upload' }>(), { context: 'default' })

const labels: Record<string, string> = {
  draft: '草稿', online: '已上架', offline: '已下架', trash: '回收站',
  pending: '待评审', reviewing: '评审中', completed: '评审完成',
  success: '成功', failed: '失败', open: '未解决', resolved: '已解决',
  'needs-relocation': '待重新定位', admin: '超级管理员', user: '普通用户',
}

const tone = computed(() => {
  if (['online', 'success', 'completed', 'resolved'].includes(props.value)) return 'bg-emerald-50 text-emerald-700 ring-emerald-600/15'
  if (['failed', 'trash'].includes(props.value)) return 'bg-rose-50 text-rose-700 ring-rose-600/15'
  if (['reviewing', 'needs-relocation'].includes(props.value)) return 'bg-violet-50 text-violet-700 ring-violet-600/15'
  if (['offline'].includes(props.value)) return 'bg-slate-100 text-slate-600 ring-slate-500/15'
  return 'bg-amber-50 text-amber-700 ring-amber-600/15'
})

const label = computed(() => {
  if (props.context === 'upload' && props.value === 'success') return '发布成功'
  if (props.context === 'upload' && props.value === 'failed') return '发布失败'
  return labels[props.value] ?? props.value
})
</script>

<template>
  <span :class="['inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset', tone]">
    <span class="mr-1.5 h-1.5 w-1.5 rounded-full bg-current opacity-75" />
    {{ label }}
  </span>
</template>
