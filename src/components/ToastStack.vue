<script setup lang="ts">
import { CheckCircle2, CircleAlert, Info, X } from 'lucide-vue-next'

export interface ToastItem {
  id: number
  tone: 'success' | 'error' | 'info'
  message: string
}

defineProps<{ items: ToastItem[] }>()
const emit = defineEmits<{ dismiss: [id: number] }>()
</script>

<template>
  <Teleport to="body">
    <div class="fixed right-6 top-6 z-[140] flex w-[360px] max-w-[calc(100vw-3rem)] flex-col gap-3" aria-live="polite">
      <TransitionGroup name="toast">
        <div v-for="item in items" :key="item.id" class="flex items-start gap-3 rounded-2xl border border-white/90 bg-white/90 p-4 shadow-[0_18px_48px_rgba(38,49,90,.16)] backdrop-blur-xl">
          <CheckCircle2 v-if="item.tone === 'success'" class="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
          <CircleAlert v-else-if="item.tone === 'error'" class="mt-0.5 h-5 w-5 shrink-0 text-rose-600" />
          <Info v-else class="mt-0.5 h-5 w-5 shrink-0 text-indigo-600" />
          <p class="min-w-0 flex-1 text-sm font-medium leading-6 text-slate-700">{{ item.message }}</p>
          <button class="text-slate-400 transition hover:text-slate-700" type="button" aria-label="关闭提示" @click="emit('dismiss', item.id)"><X class="h-4 w-4" /></button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>
