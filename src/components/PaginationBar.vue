<script setup lang="ts">
import { computed } from 'vue'
import { ChevronLeft, ChevronRight } from 'lucide-vue-next'

const props = defineProps<{ page: number; pageSize: number; total: number }>()
const emit = defineEmits<{ change: [page: number] }>()

const totalPages = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)))
const pageItems = computed<Array<number | string>>(() => {
  const total = totalPages.value
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1)
  const candidates = [...new Set([1, total, props.page - 1, props.page, props.page + 1]
    .filter((item) => item >= 1 && item <= total))].sort((a, b) => a - b)
  const items: Array<number | string> = []
  candidates.forEach((item, index) => {
    const previous = candidates[index - 1]
    if (previous && item - previous > 1) items.push(`ellipsis-${previous}`)
    items.push(item)
  })
  return items
})
</script>

<template>
  <div class="table-pagination">
    <span class="table-pagination-summary">共 {{ total }} 条记录 · 每页 {{ pageSize }} 条</span>
    <div class="flex items-center gap-1.5" role="navigation" aria-label="分页导航">
      <button class="icon-button" type="button" aria-label="上一页" :disabled="page <= 1" @click="emit('change', page - 1)"><ChevronLeft class="h-4 w-4" /></button>
      <template v-for="item in pageItems" :key="item">
        <button v-if="typeof item === 'number'" class="pagination-page" :class="{ active: item === page }" type="button" :aria-label="`第 ${item} 页`" :aria-current="item === page ? 'page' : undefined" @click="emit('change', item)">{{ item }}</button>
        <span v-else class="pagination-ellipsis" aria-hidden="true">…</span>
      </template>
      <button class="icon-button" type="button" aria-label="下一页" :disabled="page >= totalPages" @click="emit('change', page + 1)"><ChevronRight class="h-4 w-4" /></button>
    </div>
  </div>
</template>
