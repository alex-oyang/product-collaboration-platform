<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import {
  CalendarDays,
  CheckCircle2,
  Clock3,
  FilePenLine,
  History,
  LoaderCircle,
  Plus,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-vue-next'

import type { BootstrapState, SystemRelease } from '../contracts'
import PageState from './PageState.vue'
import PaginationBar from './PaginationBar.vue'
import UiDateTimePicker from './UiDateTimePicker.vue'
import UiModal from './UiModal.vue'

const props = defineProps<{
  state: BootstrapState
  loading: boolean
  error: string
  action: (type: string, payload?: Record<string, unknown>) => Promise<boolean>
}>()

const emit = defineEmits<{
  retry: []
  notify: [message: string, tone?: 'success' | 'error' | 'info']
}>()

const query = ref('')
const page = ref(1)
const pageSize = 6
const formOpen = ref(false)
const editing = ref<SystemRelease | null>(null)
const deleting = ref<SystemRelease | null>(null)
const busy = ref(false)
const form = reactive({
  version: '',
  title: '',
  content: '',
  releasedAt: '',
})

const releases = computed(() => [...props.state.systemReleases].sort((a, b) => (
  new Date(b.releasedAt).getTime() - new Date(a.releasedAt).getTime()
)))
const filtered = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  if (!keyword) return releases.value
  return releases.value.filter((item) => (
    item.version.toLowerCase().includes(keyword)
    || item.title.toLowerCase().includes(keyword)
    || item.content.toLowerCase().includes(keyword)
  ))
})
const totalPages = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize)))
const paged = computed(() => filtered.value.slice((page.value - 1) * pageSize, page.value * pageSize))

watch(filtered, () => {
  if (page.value > totalPages.value) page.value = totalPages.value
})

function localDateTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

function authorName(id: string) {
  return props.state.users.find((item) => item.id === id)?.name ?? '已停用管理员'
}

function openCreate() {
  editing.value = null
  Object.assign(form, {
    version: '',
    title: '',
    content: '',
    releasedAt: localDateTime(new Date().toISOString()),
  })
  formOpen.value = true
}

function openEdit(item: SystemRelease) {
  editing.value = item
  Object.assign(form, {
    version: item.version,
    title: item.title,
    content: item.content,
    releasedAt: localDateTime(item.releasedAt),
  })
  formOpen.value = true
}

async function save() {
  if (!form.version.trim() || !form.title.trim() || !form.content.trim() || !form.releasedAt) {
    emit('notify', '请完整填写版本号、更新标题、更新内容和发布时间。', 'info')
    return
  }
  busy.value = true
  const ok = await props.action(editing.value ? 'systemRelease.update' : 'systemRelease.create', {
    ...(editing.value ? { releaseId: editing.value.id } : {}),
    version: form.version.trim(),
    title: form.title.trim(),
    content: form.content.trim(),
    releasedAt: new Date(form.releasedAt).toISOString(),
  })
  busy.value = false
  if (ok) formOpen.value = false
}

async function remove() {
  if (!deleting.value) return
  busy.value = true
  const ok = await props.action('systemRelease.delete', { releaseId: deleting.value.id })
  busy.value = false
  if (ok) deleting.value = null
}
</script>

<template>
  <section>
    <div class="flex flex-wrap items-end justify-between gap-5">
      <div>
        <p class="eyebrow">SYSTEM CHANGELOG</p>
        <h1 class="page-title">系统版本记录</h1>
        <p class="page-description">记录平台每次重要更新，便于管理员追踪能力变化。</p>
      </div>
      <button class="primary-button" type="button" @click="openCreate">
        <Plus class="h-4 w-4" />新增版本记录
      </button>
    </div>

    <div class="mt-6 grid gap-4 md:grid-cols-3">
      <article class="release-metric glass-card">
        <span class="release-metric-icon indigo"><History /></span>
        <div><small>版本记录</small><strong>{{ releases.length }}</strong><p>仅统计重要更新</p></div>
      </article>
      <article class="release-metric glass-card">
        <span class="release-metric-icon pink"><Sparkles /></span>
        <div><small>当前版本</small><strong>{{ releases[0]?.version || '—' }}</strong><p>{{ releases[0]?.title || '尚未创建记录' }}</p></div>
      </article>
      <article class="release-metric glass-card">
        <span class="release-metric-icon blue"><CalendarDays /></span>
        <div><small>最近更新</small><strong class="date-value">{{ releases[0] ? formatDate(releases[0].releasedAt).slice(0, 10) : '—' }}</strong><p>{{ releases[0] ? authorName(releases[0].authorId) : '等待首次发布' }}</p></div>
      </article>
    </div>

    <div class="filter-bar mt-5">
      <label class="input-shell max-w-xl">
        <Search class="h-4 w-4 text-slate-400" />
        <input v-model="query" type="search" placeholder="搜索版本号、标题或更新内容" @input="page = 1" />
      </label>
    </div>

    <div class="glass-card mt-5 p-5 sm:p-6">
      <PageState v-if="loading" mode="loading" />
      <PageState v-else-if="error" mode="error" :description="error" @retry="emit('retry')" />
      <PageState
        v-else-if="!paged.length"
        mode="empty"
        :title="query ? '没有符合条件的版本记录' : '还没有系统版本记录'"
        :description="query ? '调整搜索关键词后再试。' : '点击“新增版本记录”，记录平台第一次重要更新。'"
      />
      <div v-else class="release-timeline">
        <article v-for="(item, index) in paged" :key="item.id" class="release-entry">
          <div class="release-axis">
            <span><CheckCircle2 /></span>
            <i v-if="index < paged.length - 1"></i>
          </div>
          <div class="release-card">
            <header>
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2">
                  <b class="version-chip">V{{ item.version }}</b>
                  <span v-if="item.id === releases[0]?.id" class="latest-chip">最新</span>
                </div>
                <h2>{{ item.title }}</h2>
              </div>
              <div class="flex shrink-0 items-center gap-1">
                <button class="icon-button" type="button" title="编辑版本记录" @click="openEdit(item)"><FilePenLine class="h-4 w-4" /></button>
                <button class="icon-button danger-text" type="button" title="删除版本记录" @click="deleting = item"><Trash2 class="h-4 w-4" /></button>
              </div>
            </header>
            <p class="release-content">{{ item.content }}</p>
            <footer>
              <span><Clock3 />{{ formatDate(item.releasedAt) }}</span>
              <span class="avatar-mini">{{ authorName(item.authorId).slice(0, 1) }}</span>
              <span>{{ authorName(item.authorId) }}</span>
              <span v-if="item.updatedAt">已编辑</span>
            </footer>
          </div>
        </article>
      </div>
      <PaginationBar
        v-if="filtered.length > pageSize"
        class="mt-5"
        :page="page"
        :total="filtered.length"
        :page-size="pageSize"
        @change="page = $event"
      />
    </div>

    <UiModal
      :open="formOpen"
      :title="editing ? '编辑系统版本记录' : '新增系统版本记录'"
      description="仅记录会影响使用方式或业务流程的重要更新。"
      size="lg"
      :busy="busy"
      @close="formOpen = false"
    >
      <div class="grid gap-5 sm:grid-cols-2">
        <label>
          <span class="field-label">版本号 <b>*</b></span>
          <input v-model="form.version" class="form-input mt-2" placeholder="例如 1.2.0" maxlength="40" />
        </label>
        <label>
          <span class="field-label">发布时间 <b>*</b></span>
          <UiDateTimePicker v-model="form.releasedAt" class="mt-2" aria-label="系统版本发布时间" placeholder="选择发布时间" :clearable="false" />
        </label>
        <label class="sm:col-span-2">
          <span class="field-label">更新标题 <b>*</b></span>
          <input v-model="form.title" class="form-input mt-2" placeholder="一句话说明本次核心变化" maxlength="120" />
        </label>
        <label class="sm:col-span-2">
          <span class="field-label">更新内容 <b>*</b></span>
          <textarea v-model="form.content" class="form-textarea mt-2 min-h-48" placeholder="按业务变化、功能调整、使用影响分段说明…" maxlength="10000"></textarea>
          <small class="mt-2 block text-right text-xs text-slate-400">{{ form.content.length }}/10000</small>
        </label>
      </div>
      <template #footer>
        <button class="secondary-button" type="button" :disabled="busy" @click="formOpen = false">取消</button>
        <button class="primary-button" type="button" :disabled="busy" @click="save">
          <LoaderCircle v-if="busy" class="h-4 w-4 animate-spin" />{{ editing ? '保存修改' : '发布记录' }}
        </button>
      </template>
    </UiModal>

    <UiModal
      :open="Boolean(deleting)"
      title="删除系统版本记录"
      description="删除后不会影响系统功能，但该条更新说明将无法恢复。"
      tone="danger"
      size="sm"
      :busy="busy"
      @close="deleting = null"
    >
      <div v-if="deleting" class="confirm-target danger-target">
        <p class="confirm-target-label">即将删除</p>
        <p class="confirm-target-value">V{{ deleting.version }} · {{ deleting.title }}</p>
      </div>
      <template #footer>
        <button class="secondary-button" type="button" :disabled="busy" @click="deleting = null">取消</button>
        <button class="danger-button" type="button" :disabled="busy" @click="remove">
          <LoaderCircle v-if="busy" class="h-4 w-4 animate-spin" />确认删除
        </button>
      </template>
    </UiModal>
  </section>
</template>

<style scoped>
.release-metric { display: flex; min-height: 132px; align-items: center; gap: 16px; padding: 20px; transition: transform .18s ease, box-shadow .18s ease; }
.release-metric:hover { transform: translateY(-2px); box-shadow: 0 20px 55px rgba(70,82,130,.11), inset 0 1px 0 rgba(255,255,255,.94); }
.release-metric-icon { display: grid; width: 46px; height: 46px; flex: 0 0 46px; place-items: center; border-radius: 16px; }
.release-metric-icon svg { width: 21px; height: 21px; }
.release-metric-icon.indigo { background: #eceeff; color: #4b5be7; }
.release-metric-icon.pink { background: #fff0f5; color: #d14a78; }
.release-metric-icon.blue { background: #eaf5ff; color: #3181c5; }
.release-metric small, .release-metric strong, .release-metric p { display: block; }
.release-metric small { color: #8b96aa; font-size: 11px; font-weight: 650; }
.release-metric strong { margin-top: 4px; color: #172033; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 24px; line-height: 1.15; }
.release-metric strong.date-value { font-size: 18px; }
.release-metric p { max-width: 240px; margin: 7px 0 0; overflow: hidden; color: #8b96aa; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.release-timeline { display: grid; gap: 4px; }
.release-entry { display: grid; grid-template-columns: 34px minmax(0, 1fr); }
.release-axis { display: flex; flex-direction: column; align-items: center; }
.release-axis span { z-index: 1; display: grid; width: 28px; height: 28px; place-items: center; border-radius: 50%; background: linear-gradient(145deg, #6270f8, #4757df); color: white; box-shadow: 0 7px 18px rgba(75,91,231,.22); }
.release-axis span svg { width: 15px; height: 15px; }
.release-axis i { width: 1px; flex: 1; min-height: 32px; background: linear-gradient(#cfd5ff, rgba(207,213,255,.15)); }
.release-card { margin: 0 0 16px 8px; padding: 18px 19px; border: 1px solid rgba(148,163,184,.18); border-radius: 19px; background: rgba(255,255,255,.66); transition: border-color .18s ease, background .18s ease, transform .18s ease; }
.release-card:hover { border-color: rgba(99,102,241,.24); background: rgba(255,255,255,.9); transform: translateY(-1px); }
.release-card header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.release-card h2 { margin: 9px 0 0; color: #222d45; font-size: 16px; font-weight: 700; }
.version-chip, .latest-chip { display: inline-flex; min-height: 24px; align-items: center; border-radius: 8px; padding: 0 8px; font-size: 10px; font-weight: 750; }
.version-chip { background: #eceeff; color: #4453d4; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.latest-chip { background: #e8f8f1; color: #198060; }
.release-content { margin: 13px 0 0; color: #59647a; font-size: 13px; line-height: 1.8; white-space: pre-wrap; }
.release-card footer { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 15px; padding-top: 13px; border-top: 1px solid rgba(148,163,184,.15); color: #929caf; font-size: 10px; }
.release-card footer span { display: inline-flex; align-items: center; gap: 5px; }
.release-card footer svg { width: 13px; height: 13px; }
</style>
