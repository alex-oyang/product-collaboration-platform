<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch } from 'vue'
import {
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock3,
} from 'lucide-vue-next'

const props = withDefaults(defineProps<{
  modelValue: string
  ariaLabel?: string
  placeholder?: string
  disabled?: boolean
  clearable?: boolean
}>(), {
  ariaLabel: '选择日期和时间',
  placeholder: '请选择日期和时间',
  disabled: false,
  clearable: true,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  change: [value: string]
}>()

interface CalendarDay {
  key: string
  date: Date
  day: number
  currentMonth: boolean
  today: boolean
  selected: boolean
}

const rootRef = ref<HTMLElement | null>(null)
const triggerRef = ref<HTMLButtonElement | null>(null)
const panelRef = ref<HTMLElement | null>(null)
const open = ref(false)
const panelStyle = ref<Record<string, string>>({})
const portalTarget = shallowRef<Element | string>('body')
const panelId = useId()
const viewYear = ref(new Date().getFullYear())
const viewMonth = ref(new Date().getMonth())
const selectedDate = ref<Date | null>(null)
const hour = ref(9)
const minute = ref(0)

const weekdays = ['一', '二', '三', '四', '五', '六', '日']
const monthLabel = computed(() => `${viewYear.value}年${viewMonth.value + 1}月`)
const displayValue = computed(() => {
  const parsed = parseLocalValue(props.modelValue)
  if (!parsed) return ''
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(parsed)
})

const calendarDays = computed<CalendarDay[]>(() => {
  const first = new Date(viewYear.value, viewMonth.value, 1)
  const mondayOffset = (first.getDay() + 6) % 7
  const start = new Date(viewYear.value, viewMonth.value, 1 - mondayOffset)
  const today = new Date()
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index)
    return {
      key: `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`,
      date,
      day: date.getDate(),
      currentMonth: date.getMonth() === viewMonth.value,
      today: sameDay(date, today),
      selected: Boolean(selectedDate.value && sameDay(date, selectedDate.value)),
    }
  })
})

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate()
}

function parseLocalValue(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]))
  return Number.isNaN(date.getTime()) ? null : date
}

function localValue(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function syncDraft() {
  const parsed = parseLocalValue(props.modelValue) ?? new Date()
  selectedDate.value = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate())
  viewYear.value = parsed.getFullYear()
  viewMonth.value = parsed.getMonth()
  hour.value = parsed.getHours()
  minute.value = parsed.getMinutes()
}

function positionPanel() {
  if (!triggerRef.value) return
  const rect = triggerRef.value.getBoundingClientRect()
  const viewportGap = 12
  const triggerGap = 8
  const width = Math.min(364, window.innerWidth - viewportGap * 2)
  const maxPanelHeight = Math.max(240, window.innerHeight - viewportGap * 2)
  const panelHeight = Math.min(panelRef.value?.scrollHeight ?? 492, maxPanelHeight)
  const availableAbove = rect.top - viewportGap - triggerGap
  const availableBelow = window.innerHeight - rect.bottom - viewportGap - triggerGap
  const left = Math.min(Math.max(viewportGap, rect.left), window.innerWidth - width - viewportGap)
  let top: number

  if (availableBelow >= panelHeight) {
    top = rect.bottom + triggerGap
  } else if (availableAbove >= panelHeight) {
    top = rect.top - triggerGap - panelHeight
  } else if (availableAbove > availableBelow) {
    top = viewportGap
  } else {
    top = window.innerHeight - viewportGap - panelHeight
  }

  panelStyle.value = {
    left: `${left}px`,
    top: `${Math.max(viewportGap, top)}px`,
    bottom: 'auto',
    width: `${width}px`,
    maxHeight: `${maxPanelHeight}px`,
  }
}

function show() {
  if (props.disabled) return
  syncDraft()
  open.value = true
  void nextTick(() => {
    positionPanel()
    window.requestAnimationFrame(positionPanel)
  })
}

function close(focusTrigger = false) {
  open.value = false
  if (focusTrigger) void nextTick(() => triggerRef.value?.focus())
}

function toggle() {
  if (open.value) close()
  else show()
}

function moveMonth(delta: number) {
  const next = new Date(viewYear.value, viewMonth.value + delta, 1)
  viewYear.value = next.getFullYear()
  viewMonth.value = next.getMonth()
}

function selectDay(item: CalendarDay) {
  selectedDate.value = new Date(item.date.getFullYear(), item.date.getMonth(), item.date.getDate())
  viewYear.value = item.date.getFullYear()
  viewMonth.value = item.date.getMonth()
}

function useToday() {
  const now = new Date()
  selectedDate.value = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  viewYear.value = now.getFullYear()
  viewMonth.value = now.getMonth()
}

function useNow() {
  const now = new Date()
  selectedDate.value = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  viewYear.value = now.getFullYear()
  viewMonth.value = now.getMonth()
  hour.value = now.getHours()
  minute.value = now.getMinutes()
}

function adjustTime(target: 'hour' | 'minute', delta: number) {
  if (target === 'hour') hour.value = (hour.value + delta + 24) % 24
  else minute.value = (minute.value + delta + 60) % 60
}

function normalizeTime(target: 'hour' | 'minute', event: Event) {
  const input = event.target as HTMLInputElement
  const value = Number.parseInt(input.value, 10)
  if (target === 'hour') hour.value = Number.isFinite(value) ? Math.min(23, Math.max(0, value)) : 0
  else minute.value = Number.isFinite(value) ? Math.min(59, Math.max(0, value)) : 0
  input.value = String(target === 'hour' ? hour.value : minute.value).padStart(2, '0')
}

function confirm() {
  const base = selectedDate.value ?? new Date()
  const value = localValue(new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour.value, minute.value))
  emit('update:modelValue', value)
  emit('change', value)
  close(true)
}

function clear() {
  emit('update:modelValue', '')
  emit('change', '')
  close(true)
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && open.value) {
    event.preventDefault()
    close(true)
  } else if ((event.key === 'Enter' || event.key === ' ') && !open.value) {
    event.preventDefault()
    show()
  } else if (event.key === 'Enter' && open.value && event.target === panelRef.value) {
    event.preventDefault()
    confirm()
  }
}

function handleDocumentPointer(event: PointerEvent) {
  const path = event.composedPath()
  if (rootRef.value && !path.includes(rootRef.value) && (!panelRef.value || !path.includes(panelRef.value))) close()
}

function updatePortalTarget() {
  portalTarget.value = document.fullscreenElement ?? 'body'
  if (open.value) void nextTick(positionPanel)
}

function handleViewportChange() {
  if (open.value) positionPanel()
}

watch(() => props.disabled, (disabled) => {
  if (disabled) close()
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
  <div ref="rootRef" class="ui-date-time" :class="{ 'is-open': open, 'is-disabled': disabled }">
    <button
      ref="triggerRef"
      class="ui-date-time__trigger"
      type="button"
      role="combobox"
      :aria-label="ariaLabel"
      :aria-controls="panelId"
      :aria-expanded="open"
      aria-haspopup="dialog"
      :disabled="disabled"
      @click="toggle"
      @keydown="handleKeydown"
    >
      <CalendarDays :size="17" aria-hidden="true" />
      <span :class="{ placeholder: !displayValue }">{{ displayValue || placeholder }}</span>
      <span class="ui-date-time__chevron" aria-hidden="true"><ChevronDown :size="15" /></span>
    </button>

    <Teleport :to="portalTarget">
      <Transition name="ui-date-time-panel">
        <section
          v-if="open"
          :id="panelId"
          ref="panelRef"
          class="ui-date-time__panel"
          :style="panelStyle"
          role="dialog"
          :aria-label="ariaLabel"
          tabindex="-1"
          @keydown="handleKeydown"
        >
          <header class="calendar-header">
            <div>
              <small>选择日期</small>
              <strong>{{ monthLabel }}</strong>
            </div>
            <div>
              <button type="button" title="上个月" @click="moveMonth(-1)"><ChevronLeft /></button>
              <button type="button" title="回到今天" @click="useToday">今</button>
              <button type="button" title="下个月" @click="moveMonth(1)"><ChevronRight /></button>
            </div>
          </header>

          <div class="calendar-grid week-row" aria-hidden="true">
            <span v-for="day in weekdays" :key="day">{{ day }}</span>
          </div>
          <div class="calendar-grid" role="grid" :aria-label="monthLabel">
            <button
              v-for="item in calendarDays"
              :key="item.key"
              class="calendar-day"
              :class="{ muted: !item.currentMonth, today: item.today, selected: item.selected }"
              type="button"
              role="gridcell"
              :aria-label="`${item.date.getFullYear()}年${item.date.getMonth() + 1}月${item.day}日`"
              :aria-selected="item.selected"
              @click="selectDay(item)"
            >
              {{ item.day }}
            </button>
          </div>

          <div class="time-section">
            <div class="time-label"><span><Clock3 /></span><div><strong>选择时间</strong><small>24 小时制</small></div></div>
            <div class="time-control">
              <div class="time-stepper">
                <button type="button" aria-label="小时加一" @click="adjustTime('hour', 1)"><ChevronUp /></button>
                <input :value="String(hour).padStart(2, '0')" inputmode="numeric" maxlength="2" aria-label="小时" @blur="normalizeTime('hour', $event)" @keydown.enter="normalizeTime('hour', $event)" />
                <button type="button" aria-label="小时减一" @click="adjustTime('hour', -1)"><ChevronDown /></button>
              </div>
              <b>:</b>
              <div class="time-stepper">
                <button type="button" aria-label="分钟加一" @click="adjustTime('minute', 1)"><ChevronUp /></button>
                <input :value="String(minute).padStart(2, '0')" inputmode="numeric" maxlength="2" aria-label="分钟" @blur="normalizeTime('minute', $event)" @keydown.enter="normalizeTime('minute', $event)" />
                <button type="button" aria-label="分钟减一" @click="adjustTime('minute', -1)"><ChevronDown /></button>
              </div>
            </div>
          </div>

          <footer class="calendar-footer">
            <button v-if="clearable" class="clear-button" type="button" @click="clear">清空</button>
            <button class="now-button" type="button" @click="useNow">此刻</button>
            <button class="confirm-button" type="button" @click="confirm">确认</button>
          </footer>
        </section>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.ui-date-time { display: block; width: 100%; color: #27324a; }
.ui-date-time__trigger { display: flex; width: 100%; height: 44px; align-items: center; gap: 10px; padding: 0 8px 0 13px; border: 1px solid rgba(148,163,184,.32); border-radius: 13px; background: linear-gradient(180deg,rgba(255,255,255,.96),rgba(250,251,255,.84)); color: #334155; box-shadow: inset 0 1px 0 rgba(255,255,255,.96),0 2px 8px rgba(53,65,106,.045); transition: border-color .16s ease,box-shadow .16s ease,background .16s ease; }
.ui-date-time__trigger > svg { flex: 0 0 auto; color: #7b879c; }
.ui-date-time__trigger > span:nth-child(2) { min-width: 0; flex: 1; overflow: hidden; font-size: 13px; font-weight: 620; text-align: left; text-overflow: ellipsis; white-space: nowrap; }
.ui-date-time__trigger .placeholder { color: #97a2b5; font-weight: 540; }
.ui-date-time__trigger:hover:not(:disabled) { border-color: rgba(99,102,241,.36); background: #fff; box-shadow: 0 5px 16px rgba(75,91,231,.08); }
.ui-date-time.is-open .ui-date-time__trigger,.ui-date-time__trigger:focus-visible { border-color: rgba(79,70,229,.62); outline: none; background: #fff; box-shadow: 0 0 0 4px rgba(79,91,231,.12),0 7px 20px rgba(79,91,231,.08); }
.ui-date-time__chevron { display: inline-grid; width: 28px; height: 28px; flex: 0 0 auto; place-items: center; border-radius: 9px; background: #f1f3f8; color: #64748b; transition: transform .18s ease,background .16s ease,color .16s ease; }
.ui-date-time.is-open .ui-date-time__chevron { transform: rotate(180deg); background: #e9edff; color: #4338ca; }
.ui-date-time.is-disabled { opacity: .62; }
.ui-date-time__trigger:disabled { cursor: not-allowed; background: rgba(241,245,249,.76); box-shadow: none; }
.ui-date-time__panel { position: fixed; z-index: 250; overflow: auto; padding: 12px; border: 1px solid rgba(255,255,255,.96); border-radius: 20px; background: rgba(255,255,255,.97); box-shadow: 0 24px 64px rgba(34,44,79,.2),0 4px 14px rgba(34,44,79,.08),inset 0 1px 0 #fff; backdrop-filter: blur(24px) saturate(150%); scrollbar-width: thin; scrollbar-color: rgba(110,121,150,.25) transparent; }
.calendar-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 4px 4px 12px; }
.calendar-header small,.calendar-header strong { display: block; }
.calendar-header small { color: #9aa4b5; font-size: 9px; font-weight: 650; letter-spacing: .08em; }
.calendar-header strong { margin-top: 3px; color: #222d45; font-size: 15px; font-weight: 750; }
.calendar-header > div:last-child { display: flex; align-items: center; gap: 4px; }
.calendar-header button { display: grid; width: 32px; height: 32px; place-items: center; border: 0; border-radius: 10px; background: #f3f5f9; color: #6e7990; font-size: 11px; font-weight: 750; transition: .15s ease; }
.calendar-header button:hover { background: #e9edff; color: #4352d4; }
.calendar-header svg { width: 15px; height: 15px; }
.calendar-grid { display: grid; grid-template-columns: repeat(7,minmax(0,1fr)); gap: 3px; }
.week-row { margin-bottom: 5px; }
.week-row span { display: grid; height: 24px; place-items: center; color: #9aa4b5; font-size: 9px; font-weight: 700; }
.calendar-day { position: relative; display: grid; aspect-ratio: 1; min-height: 34px; place-items: center; border: 0; border-radius: 11px; background: transparent; color: #445068; font-size: 11px; font-weight: 650; transition: background .14s ease,color .14s ease,transform .14s ease; }
.calendar-day:hover { background: #eef1ff; color: #4050d5; transform: translateY(-1px); }
.calendar-day.muted { color: #c1c7d2; }
.calendar-day.today::after { content: ""; position: absolute; bottom: 4px; width: 4px; height: 4px; border-radius: 50%; background: #5968f4; }
.calendar-day.selected { background: linear-gradient(145deg,#6070f8,#4757df); color: white; box-shadow: 0 7px 16px rgba(75,91,231,.23); }
.calendar-day.selected::after { background: white; }
.time-section { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 11px; padding: 11px 12px; border: 1px solid rgba(148,163,184,.16); border-radius: 15px; background: linear-gradient(135deg,rgba(244,246,255,.9),rgba(249,247,255,.8)); }
.time-label { display: flex; min-width: 0; align-items: center; gap: 9px; }
.time-label > span { display: grid; width: 32px; height: 32px; flex: 0 0 auto; place-items: center; border-radius: 10px; background: white; color: #5665e8; box-shadow: 0 4px 12px rgba(75,91,231,.08); }
.time-label svg { width: 15px; height: 15px; }
.time-label strong,.time-label small { display: block; }
.time-label strong { color: #47536a; font-size: 10px; }
.time-label small { margin-top: 2px; color: #9ba4b5; font-size: 8px; }
.time-control { display: flex; align-items: center; gap: 6px; }
.time-control > b { color: #5b6780; font-size: 16px; }
.time-stepper { display: grid; grid-template-columns: 22px 36px 22px; align-items: center; overflow: hidden; border: 1px solid rgba(148,163,184,.2); border-radius: 11px; background: white; }
.time-stepper button { display: grid; width: 22px; height: 32px; place-items: center; border: 0; background: #f5f7fb; color: #7c879b; }
.time-stepper button:hover { background: #e9edff; color: #4352d4; }
.time-stepper svg { width: 13px; height: 13px; }
.time-stepper input { width: 36px; height: 32px; border: 0; outline: 0; background: white; color: #2c3850; font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size: 12px; font-weight: 750; text-align: center; }
.calendar-footer { display: flex; align-items: center; gap: 7px; margin-top: 11px; padding-top: 11px; border-top: 1px solid rgba(148,163,184,.15); }
.calendar-footer button { min-height: 35px; border: 0; border-radius: 10px; padding: 0 12px; font-size: 10px; font-weight: 750; }
.clear-button { background: transparent; color: #8a95a8; }
.clear-button:hover { background: #fff0f4; color: #c33d63; }
.now-button { margin-left: auto; background: #eef1ff; color: #4655d8; }
.confirm-button { background: #4b5be7; color: white; box-shadow: 0 6px 16px rgba(75,91,231,.18); }
.confirm-button:hover { background: #3d4dd4; }
.ui-date-time-panel-enter-active,.ui-date-time-panel-leave-active { transition: opacity .15s ease,transform .15s ease; transform-origin: top center; }
.ui-date-time-panel-enter-from,.ui-date-time-panel-leave-to { opacity: 0; transform: translateY(-5px) scale(.985); }
@media (max-width: 480px) {
  .ui-date-time__panel { border-radius: 17px; }
  .time-section { align-items: flex-start; flex-direction: column; }
  .time-control { align-self: stretch; justify-content: center; }
}
@media (prefers-reduced-motion: reduce) {
  .ui-date-time__trigger,.ui-date-time__chevron,.calendar-day,.ui-date-time-panel-enter-active,.ui-date-time-panel-leave-active { transition: none; }
}
</style>
