<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { TriangleAlert, X } from 'lucide-vue-next'

const props = withDefaults(defineProps<{
  open: boolean
  title: string
  description?: string
  size?: 'sm' | 'md' | 'lg' | 'xl'
  busy?: boolean
  closeOnBackdrop?: boolean
  tone?: 'default' | 'warning' | 'danger'
}>(), {
  size: 'md',
  busy: false,
  closeOnBackdrop: true,
  tone: 'default',
})

const emit = defineEmits<{ close: [] }>()
const panel = ref<HTMLElement | null>(null)

const widths = {
  sm: 'max-w-md',
  md: 'max-w-xl',
  lg: 'max-w-3xl',
  xl: 'max-w-5xl',
}

function close() {
  if (!props.busy) emit('close')
}

function onKeydown(event: KeyboardEvent) {
  if (!props.open) return
  if (event.key === 'Escape') close()
  if (event.key !== 'Tab' || !panel.value) return
  const focusable = Array.from(panel.value.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
  if (!focusable.length) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

watch(() => props.open, async (open) => {
  document.body.style.overflow = open ? 'hidden' : ''
  if (open) {
    await nextTick()
    panel.value?.querySelector<HTMLElement>('[autofocus], button, input, select, textarea')?.focus()
  }
})

onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
  document.body.style.overflow = ''
})
</script>

<template>
  <Teleport to="body">
    <Transition name="modal-fade">
      <div v-if="open" class="modal-backdrop" role="presentation" @mousedown.self="closeOnBackdrop && close()">
        <section ref="panel" :role="tone === 'danger' ? 'alertdialog' : 'dialog'" aria-modal="true" :aria-label="title" :data-tone="tone" :class="['modal-panel glass-card w-full overflow-hidden', widths[size]]">
          <header class="modal-header">
            <div class="modal-title-group">
              <span v-if="tone !== 'default'" class="modal-tone-icon" aria-hidden="true"><TriangleAlert class="h-5 w-5" /></span>
              <div class="min-w-0">
                <h2 class="modal-title">{{ title }}</h2>
                <p v-if="description" class="modal-description">{{ description }}</p>
              </div>
            </div>
            <button class="icon-button modal-close" type="button" aria-label="关闭" :disabled="busy" @click="close">
              <X class="h-5 w-5" />
            </button>
          </header>
          <div class="modal-body">
            <slot />
          </div>
          <footer v-if="$slots.footer" class="modal-footer">
            <slot name="footer" />
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>
