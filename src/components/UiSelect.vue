<script setup lang="ts">
import { Check, ChevronDown, Search } from 'lucide-vue-next'
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  useId,
  watch,
} from 'vue'

export interface UiSelectOption {
  value: string
  label: string
  disabled?: boolean
  description?: string
}

const props = withDefaults(defineProps<{
  modelValue: string
  options: UiSelectOption[]
  ariaLabel?: string
  placeholder?: string
  disabled?: boolean
  size?: 'sm' | 'md'
  searchable?: boolean
  searchPlaceholder?: string
  noResultsText?: string
}>(), {
  ariaLabel: '请选择',
  placeholder: '请选择',
  disabled: false,
  size: 'md',
  searchable: false,
  searchPlaceholder: '搜索选项',
  noResultsText: '没有匹配的选项',
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  change: [value: string]
}>()

const rootRef = ref<HTMLElement | null>(null)
const triggerRef = ref<HTMLButtonElement | null>(null)
const menuRef = ref<HTMLElement | null>(null)
const searchRef = ref<HTMLInputElement | null>(null)
const open = ref(false)
const activeIndex = ref(-1)
const searchQuery = ref('')
const menuStyle = ref<Record<string, string>>({})
const portalTarget = shallowRef<Element | string>('body')
const listboxId = useId()

const selectedIndex = computed(() => props.options.findIndex((option) => option.value === props.modelValue))
const selectedOption = computed(() => props.options[selectedIndex.value])
const filteredOptions = computed(() => {
  const query = searchQuery.value.trim().toLocaleLowerCase('zh-CN')
  if (!props.searchable || !query) return props.options
  return props.options.filter((option) => option.value !== '' && `${option.label} ${option.description ?? ''}`.toLocaleLowerCase('zh-CN').includes(query))
})

function firstEnabledIndex() {
  return filteredOptions.value.findIndex((option) => !option.disabled)
}

function lastEnabledIndex() {
  for (let index = filteredOptions.value.length - 1; index >= 0; index -= 1) {
    if (!filteredOptions.value[index]?.disabled) return index
  }
  return -1
}

function updatePortalTarget() {
  portalTarget.value = document.fullscreenElement ?? 'body'
  if (open.value) void nextTick(positionMenu)
}

function positionMenu() {
  const trigger = triggerRef.value
  if (!trigger) return
  const rect = trigger.getBoundingClientRect()
  const viewportGap = 12
  const searchHeight = props.searchable ? 54 : 0
  const estimatedHeight = Math.min(filteredOptions.value.length * 44 + searchHeight + 12, 340)
  const availableBelow = window.innerHeight - rect.bottom - viewportGap
  const openAbove = availableBelow < Math.min(estimatedHeight, 220) && rect.top > availableBelow
  const width = Math.min(Math.max(rect.width, props.searchable ? 260 : 176), window.innerWidth - viewportGap * 2)
  const left = Math.min(Math.max(viewportGap, rect.left), window.innerWidth - width - viewportGap)
  menuStyle.value = {
    left: `${left}px`,
    top: openAbove ? 'auto' : `${rect.bottom + 8}px`,
    bottom: openAbove ? `${window.innerHeight - rect.top + 8}px` : 'auto',
    width: `${width}px`,
    maxHeight: `${Math.max(132, Math.min(340, openAbove ? rect.top - 20 : availableBelow))}px`,
  }
}

function showMenu() {
  if (props.disabled || !props.options.length) return
  searchQuery.value = ''
  open.value = true
  void nextTick(() => {
    activeIndex.value = filteredOptions.value.findIndex((option) => option.value === props.modelValue)
    if (activeIndex.value < 0) activeIndex.value = firstEnabledIndex()
    positionMenu()
    if (props.searchable) searchRef.value?.focus()
    else menuRef.value?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  })
}

function closeMenu(focusTrigger = false) {
  if (!open.value) return
  open.value = false
  if (focusTrigger) void nextTick(() => triggerRef.value?.focus())
}

function toggleMenu() {
  if (open.value) closeMenu()
  else showMenu()
}

function selectOption(option: UiSelectOption, index: number) {
  if (option.disabled) return
  activeIndex.value = index
  if (option.value !== props.modelValue) {
    emit('update:modelValue', option.value)
    emit('change', option.value)
  }
  closeMenu(true)
}

function moveActive(step: 1 | -1) {
  if (!open.value) showMenu()
  if (!filteredOptions.value.length) return
  let index = activeIndex.value
  for (let count = 0; count < filteredOptions.value.length; count += 1) {
    index = (index + step + filteredOptions.value.length) % filteredOptions.value.length
    if (!filteredOptions.value[index]?.disabled) {
      activeIndex.value = index
      void nextTick(() => menuRef.value?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }))
      return
    }
  }
}

function handleKeydown(event: KeyboardEvent) {
  const fromSearch = event.target === searchRef.value
  if (fromSearch && !['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Tab'].includes(event.key)) return
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    moveActive(1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    moveActive(-1)
  } else if (event.key === 'Home' && open.value) {
    event.preventDefault()
    activeIndex.value = firstEnabledIndex()
  } else if (event.key === 'End' && open.value) {
    event.preventDefault()
    activeIndex.value = lastEnabledIndex()
  } else if ((event.key === 'Enter' || event.key === ' ') && open.value) {
    event.preventDefault()
    const option = filteredOptions.value[activeIndex.value]
    if (option) selectOption(option, activeIndex.value)
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    showMenu()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    closeMenu(true)
  } else if (event.key === 'Tab') {
    closeMenu()
  }
}

function handleDocumentPointer(event: PointerEvent) {
  const path = event.composedPath()
  if (rootRef.value && !path.includes(rootRef.value) && (!menuRef.value || !path.includes(menuRef.value))) closeMenu()
}

function handleViewportChange() {
  if (open.value) positionMenu()
}

watch(() => props.disabled, (disabled) => {
  if (disabled) closeMenu()
})

watch(() => props.options, () => {
  if (open.value) {
    activeIndex.value = filteredOptions.value.findIndex((option) => option.value === props.modelValue)
    if (activeIndex.value < 0) activeIndex.value = firstEnabledIndex()
    void nextTick(positionMenu)
  }
}, { deep: true })

watch(searchQuery, () => {
  if (!open.value) return
  activeIndex.value = firstEnabledIndex()
  void nextTick(positionMenu)
})

onMounted(() => {
  document.addEventListener('pointerdown', handleDocumentPointer, true)
  document.addEventListener('fullscreenchange', updatePortalTarget)
  window.addEventListener('resize', handleViewportChange, { passive: true })
  window.addEventListener('scroll', handleViewportChange, { capture: true, passive: true })
  updatePortalTarget()
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleDocumentPointer, true)
  document.removeEventListener('fullscreenchange', updatePortalTarget)
  window.removeEventListener('resize', handleViewportChange)
  window.removeEventListener('scroll', handleViewportChange, true)
})
</script>

<template>
  <div ref="rootRef" class="ui-select" :class="[`ui-select--${size}`, { 'is-open': open, 'is-disabled': disabled }]">
    <button
      ref="triggerRef"
      class="ui-select__trigger"
      type="button"
      role="combobox"
      :aria-label="ariaLabel"
      :aria-controls="listboxId"
      :aria-expanded="open"
      aria-haspopup="listbox"
      :disabled="disabled"
      @click="toggleMenu"
      @keydown="handleKeydown"
    >
      <span v-if="$slots.prefix" class="ui-select__prefix"><slot name="prefix" /></span>
      <span class="ui-select__value" :class="{ 'is-placeholder': !selectedOption }">
        {{ selectedOption?.label ?? placeholder }}
      </span>
      <span class="ui-select__chevron" aria-hidden="true">
        <ChevronDown :size="15" />
      </span>
    </button>

    <Teleport :to="portalTarget">
      <Transition name="ui-select-menu">
        <div
          v-if="open"
          :id="listboxId"
          ref="menuRef"
          class="ui-select__menu"
          :style="menuStyle"
          role="listbox"
          :aria-label="ariaLabel"
          @keydown="handleKeydown"
        >
          <label v-if="searchable" class="ui-select__search">
            <Search :size="15" aria-hidden="true" />
            <input
              ref="searchRef"
              v-model="searchQuery"
              type="search"
              :placeholder="searchPlaceholder"
              :aria-label="searchPlaceholder"
              autocomplete="off"
              @keydown="handleKeydown"
            />
          </label>
          <button
            v-for="(option, index) in filteredOptions"
            :key="option.value"
            class="ui-select__option"
            :class="{ 'is-selected': option.value === modelValue, 'is-active': index === activeIndex }"
            type="button"
            role="option"
            :aria-selected="option.value === modelValue"
            :disabled="option.disabled"
            :data-active="index === activeIndex"
            @mouseenter="!option.disabled && (activeIndex = index)"
            @click="selectOption(option, index)"
          >
            <span class="ui-select__option-copy">
              <strong>{{ option.label }}</strong>
              <small v-if="option.description">{{ option.description }}</small>
            </span>
            <span class="ui-select__check" aria-hidden="true">
              <Check v-if="option.value === modelValue" :size="15" />
            </span>
          </button>
          <div v-if="!filteredOptions.length" class="ui-select__empty">
            <Search :size="17" aria-hidden="true" />
            <span>{{ noResultsText }}</span>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.ui-select {
  display: inline-block;
  min-width: 158px;
  color: #27324a;
  vertical-align: middle;
}

.ui-select__trigger {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  gap: 10px;
  height: 44px;
  padding: 0 8px 0 13px;
  border: 1px solid rgba(148, 163, 184, .32);
  border-radius: 13px;
  background: linear-gradient(180deg, rgba(255,255,255,.96), rgba(250,251,255,.82));
  color: inherit;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.96), 0 2px 8px rgba(53,65,106,.045);
  transition: border-color .16s ease, background .16s ease, box-shadow .16s ease, transform .16s ease;
}

.ui-select__trigger:hover:not(:disabled) {
  border-color: rgba(99, 102, 241, .36);
  background: rgba(255,255,255,.98);
  box-shadow: inset 0 1px 0 #fff, 0 5px 16px rgba(75,91,231,.08);
}

.ui-select.is-open .ui-select__trigger,
.ui-select__trigger:focus-visible {
  border-color: rgba(79, 70, 229, .62);
  background: #fff;
  outline: none;
  box-shadow: 0 0 0 4px rgba(79,91,231,.12), inset 0 1px 0 #fff, 0 7px 20px rgba(79,91,231,.09);
}

.ui-select__prefix {
  display: inline-grid;
  flex: 0 0 auto;
  place-items: center;
  color: #7b879c;
}

.ui-select__value {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: #334155;
  font-size: 13px;
  font-weight: 650;
  letter-spacing: -.01em;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ui-select__value.is-placeholder { color: #94a3b8; font-weight: 550; }

.ui-select__chevron {
  display: inline-grid;
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 9px;
  background: rgba(241,245,249,.88);
  color: #64748b;
  transition: transform .18s ease, color .16s ease, background .16s ease;
}

.ui-select__trigger:hover .ui-select__chevron { background: #eef2ff; color: #4f46e5; }
.ui-select.is-open .ui-select__chevron { transform: rotate(180deg); background: #e9edff; color: #4338ca; }

.ui-select--sm { min-width: 112px; }
.ui-select--sm .ui-select__trigger { height: 34px; gap: 7px; padding: 0 6px 0 10px; border-radius: 10px; }
.ui-select--sm .ui-select__value { font-size: 11px; }
.ui-select--sm .ui-select__chevron { width: 23px; height: 23px; border-radius: 7px; }

.ui-select.is-disabled { opacity: .62; }
.ui-select__trigger:disabled {
  cursor: not-allowed;
  border-color: rgba(203,213,225,.64);
  background: rgba(241,245,249,.76);
  box-shadow: none;
}

.ui-select__menu {
  position: fixed;
  z-index: 240;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 6px;
  border: 1px solid rgba(255,255,255,.95);
  border-radius: 16px;
  background: rgba(255,255,255,.96);
  box-shadow: 0 20px 52px rgba(36,47,82,.18), 0 3px 12px rgba(36,47,82,.08), inset 0 1px 0 #fff;
  backdrop-filter: blur(22px) saturate(145%);
  overscroll-behavior: contain;
}

.ui-select__search {
  position: sticky;
  z-index: 2;
  top: 0;
  display: flex;
  height: 42px;
  align-items: center;
  gap: 8px;
  margin-bottom: 5px;
  padding: 0 10px;
  border: 1px solid rgba(148, 163, 184, .24);
  border-radius: 11px;
  background: rgba(248,250,252,.96);
  color: #8793a8;
  box-shadow: 0 5px 14px rgba(55,65,100,.045);
}

.ui-select__search:focus-within {
  border-color: rgba(79, 70, 229, .48);
  background: #fff;
  color: #4f46e5;
  box-shadow: 0 0 0 3px rgba(79,91,231,.1);
}

.ui-select__search input {
  width: 100%;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: #334155;
  font-size: 13px;
  font-weight: 550;
}

.ui-select__search input::placeholder { color: #9aa5b6; }
.ui-select__search input::-webkit-search-cancel-button { opacity: .54; }

.ui-select__option {
  display: flex;
  width: 100%;
  min-height: 42px;
  align-items: center;
  gap: 10px;
  padding: 7px 9px 7px 11px;
  border: 0;
  border-radius: 11px;
  background: transparent;
  color: #526079;
  text-align: left;
  transition: background .13s ease, color .13s ease, transform .13s ease;
}

.ui-select__option + .ui-select__option { margin-top: 2px; }
.ui-select__option.is-active:not(:disabled) { background: rgba(238,241,255,.78); color: #3544c7; }
.ui-select__option.is-selected { background: linear-gradient(135deg, rgba(232,236,255,.96), rgba(243,239,255,.88)); color: #3947cc; }
.ui-select__option:active:not(:disabled) { transform: scale(.99); }
.ui-select__option:focus-visible { outline: 2px solid rgba(79,91,231,.3); outline-offset: -2px; }
.ui-select__option:disabled { cursor: not-allowed; opacity: .45; }

.ui-select__option-copy { min-width: 0; flex: 1; }
.ui-select__option-copy strong {
  display: block;
  overflow: hidden;
  font-size: 13px;
  font-weight: 650;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ui-select__option-copy small { display: block; margin-top: 2px; color: #94a3b8; font-size: 10px; line-height: 14px; }
.ui-select__check {
  display: inline-grid;
  width: 24px;
  height: 24px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 8px;
  color: #4f46e5;
}
.ui-select__option.is-selected .ui-select__check { background: rgba(255,255,255,.82); box-shadow: inset 0 0 0 1px rgba(99,102,241,.12); }

.ui-select__empty {
  display: grid;
  min-height: 92px;
  place-items: center;
  align-content: center;
  gap: 7px;
  color: #9aa5b6;
  font-size: 12px;
}

.ui-select-menu-enter-active,
.ui-select-menu-leave-active { transition: opacity .14s ease, transform .14s ease; transform-origin: top center; }
.ui-select-menu-enter-from,
.ui-select-menu-leave-to { opacity: 0; transform: translateY(-4px) scale(.985); }

@media (max-width: 640px) {
  .ui-select__value,
  .ui-select__option-copy strong { font-size: 16px; }
}

@media (prefers-reduced-motion: reduce) {
  .ui-select__trigger,
  .ui-select__chevron,
  .ui-select__option,
  .ui-select-menu-enter-active,
  .ui-select-menu-leave-active { transition: none; }
}
</style>
