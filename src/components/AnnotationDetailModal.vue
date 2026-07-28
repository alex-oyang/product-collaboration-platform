<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import {
  Check,
  ImagePlus,
  LoaderCircle,
  Maximize2,
  MessageCircle,
  Minimize2,
  Pencil,
  Send,
  Trash2,
  Upload,
  X,
} from 'lucide-vue-next'

import type {
  Annotation,
  AnnotationStatus,
  ImageAttachment,
  Reply,
  User,
} from '../contracts'
import UiSelect from './UiSelect.vue'

const props = defineProps<{
  annotation: Annotation
  number: number
  users: User[]
  currentUser: User
  historical: boolean
  responsible: boolean
  pendingKey: string | null
}>()

const emit = defineEmits<{
  close: []
  notify: [message: string, tone?: 'success' | 'error' | 'info']
  update: [payload: { content: string; attachments: ImageAttachment[] }]
  status: [status: AnnotationStatus]
  delete: []
  createReply: [payload: { content: string; attachments: ImageAttachment[] }]
  updateReply: [payload: { replyId: string; content: string; attachments: ImageAttachment[] }]
  deleteReply: [reply: Reply]
}>()

const activeTab = ref<'description' | 'replies'>('description')
const maximized = ref(false)
const editingDescription = ref(false)
const descriptionDraft = ref('')
const descriptionImages = ref<ImageAttachment[]>([])
const replyDraft = ref('')
const replyImages = ref<ImageAttachment[]>([])
const editingReply = reactive<{ id: string; content: string; attachments: ImageAttachment[] }>({
  id: '',
  content: '',
  attachments: [],
})
const editingReplyActive = ref(false)
const previewImage = ref<ImageAttachment | null>(null)

const statusOptions = [
  { value: 'open', label: '未解决' },
  { value: 'resolved', label: '已解决' },
  { value: 'needs-relocation', label: '待定位' },
]

const visibleReplies = computed(() => props.annotation.replies.filter((item) => !item.deleted))
const canEditAnnotation = computed(() => !props.historical && (
  props.currentUser.role === 'admin' || props.annotation.authorId === props.currentUser.id
))
const canChangeStatus = computed(() => !props.historical && (
  props.responsible || props.annotation.authorId === props.currentUser.id
))
const replyBusy = computed(() => props.pendingKey?.startsWith('reply-') ?? false)
const annotationBusy = computed(() => props.pendingKey?.startsWith('annotation-') ?? false)

watch(() => props.annotation.id, () => {
  activeTab.value = 'description'
  maximized.value = false
  editingDescription.value = false
  replyDraft.value = ''
  replyImages.value = []
  editingReplyActive.value = false
}, { immediate: true })

function userName(id: string) {
  return props.users.find((item) => item.id === id)?.name ?? '已停用成员'
}

function initials(id: string) {
  return userName(id).trim().slice(0, 2).toUpperCase() || '成员'
}

function formatTime(value: string) {
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

function canManageReply(reply: Reply) {
  return !props.historical && (
    props.currentUser.role === 'admin' || reply.authorId === props.currentUser.id
  )
}

function startDescriptionEdit() {
  descriptionDraft.value = props.annotation.content
  descriptionImages.value = [...(props.annotation.attachments ?? [])]
  editingDescription.value = true
}

function saveDescription() {
  const content = descriptionDraft.value.trim()
  if (!content) {
    emit('notify', '元素说明不能为空。', 'info')
    return
  }
  emit('update', { content, attachments: descriptionImages.value })
}

function startReplyEdit(reply: Reply) {
  editingReply.id = reply.id
  editingReply.content = reply.content
  editingReply.attachments = [...(reply.attachments ?? [])]
  editingReplyActive.value = true
}

function cancelReplyEdit() {
  editingReplyActive.value = false
  editingReply.id = ''
  editingReply.content = ''
  editingReply.attachments = []
}

function saveReplyEdit() {
  const content = editingReply.content.trim()
  if (!content) {
    emit('notify', '回复内容不能为空。', 'info')
    return
  }
  emit('updateReply', {
    replyId: editingReply.id,
    content,
    attachments: editingReply.attachments,
  })
}

function sendReply() {
  const content = replyDraft.value.trim()
  if (!content) {
    emit('notify', '请输入回复内容。', 'info')
    return
  }
  emit('createReply', { content, attachments: replyImages.value })
}

function changeStatus(value: string) {
  emit('status', value as AnnotationStatus)
}

function resetReplyComposer() {
  replyDraft.value = ''
  replyImages.value = []
}

function onOperationComplete(kind: 'annotation' | 'reply-create' | 'reply-update') {
  if (kind === 'annotation') editingDescription.value = false
  if (kind === 'reply-create') resetReplyComposer()
  if (kind === 'reply-update') cancelReplyEdit()
}

defineExpose({ onOperationComplete })

function fileToAttachment(file: File) {
  return new Promise<ImageAttachment>((resolve, reject) => {
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
      reject(new Error('仅支持 PNG、JPG、WEBP 或 GIF 图片。'))
      return
    }
    if (file.size > 4 * 1024 * 1024) {
      reject(new Error('单张图片不能超过 4 MB。'))
      return
    }
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('图片读取失败，请重新选择。'))
    reader.onload = () => resolve({
      id: `local-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name: file.name,
      type: file.type,
      size: file.size,
      dataUrl: String(reader.result),
    })
    reader.readAsDataURL(file)
  })
}

async function addImages(event: Event, target: 'description' | 'reply' | 'reply-edit') {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (!files.length) return
  const current = target === 'description'
    ? descriptionImages.value
    : target === 'reply'
      ? replyImages.value
      : editingReply.attachments
  if (current.length + files.length > 3) {
    emit('notify', '每处最多上传 3 张图片。', 'info')
    return
  }
  try {
    const next = [...current, ...await Promise.all(files.map(fileToAttachment))]
    if (target === 'description') descriptionImages.value = next
    else if (target === 'reply') replyImages.value = next
    else editingReply.attachments = next
    await nextTick()
  } catch (error) {
    emit('notify', error instanceof Error ? error.message : '图片上传失败。', 'error')
  }
}

function removeImage(target: 'description' | 'reply' | 'reply-edit', id: string) {
  if (target === 'description') descriptionImages.value = descriptionImages.value.filter((item) => item.id !== id)
  else if (target === 'reply') replyImages.value = replyImages.value.filter((item) => item.id !== id)
  else editingReply.attachments = editingReply.attachments.filter((item) => item.id !== id)
}
</script>

<template>
  <div class="annotation-detail-backdrop" @mousedown.self="emit('close')">
    <section class="annotation-detail-modal glass-surface" :class="{ 'is-maximized': maximized }" role="dialog" aria-modal="true" aria-label="批注详情">
      <header class="detail-header">
        <div class="detail-identity">
          <span class="detail-number">{{ number }}</span>
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <h2>批注详情</h2>
              <span class="detail-status" :class="`is-${annotation.status}`">{{ statusOptions.find((item) => item.value === annotation.status)?.label }}</span>
            </div>
            <p>{{ userName(annotation.authorId) }} · {{ formatTime(annotation.updatedAt || annotation.createdAt) }}</p>
          </div>
        </div>
        <div class="detail-header-actions">
          <button v-if="canEditAnnotation && activeTab === 'description' && !editingDescription" class="detail-icon-button" type="button" title="编辑元素说明" @click="startDescriptionEdit"><Pencil /></button>
          <button class="detail-icon-button" type="button" :title="maximized ? '还原窗口' : '放大窗口'" @click="maximized = !maximized">
            <Minimize2 v-if="maximized" /><Maximize2 v-else />
          </button>
          <button class="detail-icon-button" type="button" title="关闭详情" @click="emit('close')"><X /></button>
        </div>
      </header>

      <nav class="detail-tabs" role="tablist" aria-label="批注详情">
        <button type="button" role="tab" :aria-selected="activeTab === 'description'" :class="{ active: activeTab === 'description' }" @click="activeTab = 'description'">
          元素说明
          <span v-if="annotation.attachments?.length">{{ annotation.attachments.length }}</span>
        </button>
        <button type="button" role="tab" :aria-selected="activeTab === 'replies'" :class="{ active: activeTab === 'replies' }" @click="activeTab = 'replies'">
          批注回复
          <span>{{ visibleReplies.length }}</span>
        </button>
      </nav>

      <div class="detail-body">
        <div v-if="activeTab === 'description'" class="description-pane">
          <div v-if="editingDescription" class="description-editor">
            <label>
              <span>元素说明</span>
              <textarea v-model="descriptionDraft" rows="10" maxlength="5000" placeholder="说明该元素的业务含义、问题、影响和修改建议…"></textarea>
            </label>
            <div class="image-grid">
              <button v-for="image in descriptionImages" :key="image.id" class="image-item" type="button" @click="previewImage = image">
                <img :src="image.dataUrl" :alt="image.name" />
                <span class="remove-image" title="移除图片" @click.stop="removeImage('description', image.id)"><X /></span>
              </button>
              <label v-if="descriptionImages.length < 3" class="image-upload">
                <ImagePlus /><span>上传图片</span><small>最多 3 张</small>
                <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple @change="addImages($event, 'description')" />
              </label>
            </div>
            <div class="editor-actions">
              <span>{{ descriptionDraft.length }}/5000</span>
              <button type="button" :disabled="annotationBusy" @click="editingDescription = false">取消</button>
              <button class="primary" type="button" :disabled="annotationBusy || !descriptionDraft.trim()" @click="saveDescription">
                <LoaderCircle v-if="annotationBusy" class="spin" />保存修改
              </button>
            </div>
          </div>
          <template v-else>
            <article class="description-copy">{{ annotation.content }}</article>
            <div v-if="annotation.attachments?.length" class="image-grid read-only">
              <button v-for="image in annotation.attachments" :key="image.id" class="image-item" type="button" @click="previewImage = image">
                <img :src="image.dataUrl" :alt="image.name" />
              </button>
            </div>
            <div v-else class="description-empty-image"><ImagePlus /><span>这条说明没有附加图片</span></div>
          </template>
        </div>

        <div v-else class="reply-pane">
          <div v-if="!visibleReplies.length" class="reply-empty">
            <MessageCircle /><strong>还没有回复</strong><p>围绕这条元素说明开始讨论。</p>
          </div>
          <article v-for="reply in visibleReplies" :key="reply.id" class="reply-card">
            <span class="reply-avatar">{{ initials(reply.authorId) }}</span>
            <div class="reply-content">
              <header><strong>{{ userName(reply.authorId) }}</strong><time>{{ formatTime(reply.updatedAt || reply.createdAt) }}</time></header>
              <template v-if="editingReplyActive && editingReply.id === reply.id">
                <textarea v-model="editingReply.content" rows="4" maxlength="5000"></textarea>
                <div class="image-grid compact-grid">
                  <button v-for="image in editingReply.attachments" :key="image.id" class="image-item" type="button" @click="previewImage = image">
                    <img :src="image.dataUrl" :alt="image.name" />
                    <span class="remove-image" @click.stop="removeImage('reply-edit', image.id)"><X /></span>
                  </button>
                  <label v-if="editingReply.attachments.length < 3" class="image-upload compact-upload">
                    <ImagePlus /><span>添加图片</span>
                    <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple @change="addImages($event, 'reply-edit')" />
                  </label>
                </div>
                <div class="reply-edit-actions">
                  <button type="button" @click="cancelReplyEdit">取消</button>
                  <button class="primary" type="button" :disabled="replyBusy || !editingReply.content.trim()" @click="saveReplyEdit">
                    <LoaderCircle v-if="replyBusy" class="spin" />保存
                  </button>
                </div>
              </template>
              <template v-else>
                <p>{{ reply.content }}</p>
                <div v-if="reply.attachments?.length" class="image-grid compact-grid read-only">
                  <button v-for="image in reply.attachments" :key="image.id" class="image-item" type="button" @click="previewImage = image">
                    <img :src="image.dataUrl" :alt="image.name" />
                  </button>
                </div>
                <div v-if="canManageReply(reply)" class="reply-actions">
                  <button type="button" @click="startReplyEdit(reply)">编辑</button>
                  <button class="danger" type="button" @click="emit('deleteReply', reply)">删除</button>
                </div>
              </template>
            </div>
          </article>

          <form v-if="!historical" class="reply-composer-large" @submit.prevent="sendReply">
            <div class="composer-title"><span class="reply-avatar current">{{ initials(currentUser.id) }}</span><strong>回复批注</strong></div>
            <textarea v-model="replyDraft" rows="4" maxlength="5000" placeholder="输入回复内容，支持长文本和图片…"></textarea>
            <div v-if="replyImages.length" class="image-grid compact-grid">
              <button v-for="image in replyImages" :key="image.id" class="image-item" type="button" @click="previewImage = image">
                <img :src="image.dataUrl" :alt="image.name" />
                <span class="remove-image" @click.stop="removeImage('reply', image.id)"><X /></span>
              </button>
            </div>
            <div class="reply-composer-actions">
              <label class="attachment-button">
                <Upload /><span>上传图片</span>
                <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple @change="addImages($event, 'reply')" />
              </label>
              <span>{{ replyDraft.length }}/5000 · {{ replyImages.length }}/3 张</span>
              <button class="send-button" type="submit" :disabled="replyBusy || !replyDraft.trim()">
                <LoaderCircle v-if="replyBusy" class="spin" /><Send v-else />发送回复
              </button>
            </div>
          </form>
        </div>
      </div>

      <footer class="detail-footer">
        <div>
          <span>定位方式：{{ annotation.anchor.kind === 'region' ? '区域框选' : '位置标记' }}</span>
          <span v-if="historical">历史版本只读</span>
        </div>
        <div>
          <UiSelect
            v-if="canChangeStatus"
            :model-value="annotation.status"
            :options="statusOptions"
            size="sm"
            aria-label="修改批注状态"
            @change="changeStatus"
          />
          <button v-if="canEditAnnotation" class="delete-button" type="button" :disabled="annotationBusy" @click="emit('delete')"><Trash2 />删除批注</button>
        </div>
      </footer>
    </section>

    <div v-if="previewImage" class="image-preview" @click="previewImage = null">
      <button type="button" title="关闭图片预览" @click="previewImage = null"><X /></button>
      <img :src="previewImage.dataUrl" :alt="previewImage.name" @click.stop />
      <span>{{ previewImage.name }}</span>
    </div>
  </div>
</template>

<style scoped>
.annotation-detail-backdrop { position: absolute; z-index: 35; inset: 0; display: grid; place-items: center; padding: 22px; background: rgba(24,32,58,.18); backdrop-filter: blur(3px); }
.annotation-detail-modal { display: grid; width: min(760px, calc(100% - 12px)); max-height: min(760px, calc(100% - 12px)); grid-template-rows: auto auto minmax(0,1fr) auto; overflow: hidden; border: 1px solid rgba(255,255,255,.9); border-radius: 22px; background: rgba(252,253,255,.96); box-shadow: 0 28px 75px rgba(32,42,79,.24), inset 0 1px 0 white; transition: width .2s ease, max-height .2s ease, border-radius .2s ease; }
.annotation-detail-modal.is-maximized { width: calc(100% - 18px); max-height: calc(100% - 18px); height: calc(100% - 18px); border-radius: 18px; }
.detail-header { display: flex; min-height: 72px; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 17px; border-bottom: 1px solid rgba(148,163,184,.17); }
.detail-identity { display: flex; min-width: 0; align-items: center; gap: 12px; }
.detail-number { display: grid; width: 34px; height: 34px; flex: 0 0 34px; place-items: center; border-radius: 12px; background: #4b5be7; color: white; font-size: 12px; font-weight: 800; box-shadow: 0 7px 18px rgba(75,91,231,.2); }
.detail-identity h2 { margin: 0; color: #172033; font-size: 16px; font-weight: 750; }
.detail-identity p { margin: 4px 0 0; color: #929caf; font-size: 10px; }
.detail-status { display: inline-flex; min-height: 23px; align-items: center; border-radius: 999px; padding: 0 8px; font-size: 9px; font-weight: 750; }
.detail-status.is-open { background: #fff0f4; color: #c53b69; }
.detail-status.is-resolved { background: #eaf8f2; color: #1d8063; }
.detail-status.is-needs-relocation { background: #fff6e8; color: #b56d12; }
.detail-header-actions { display: flex; align-items: center; gap: 5px; }
.detail-icon-button { display: grid; width: 34px; height: 34px; place-items: center; border: 1px solid rgba(148,163,184,.17); border-radius: 10px; background: rgba(255,255,255,.72); color: #6f7a90; transition: .16s ease; }
.detail-icon-button:hover { border-color: rgba(79,91,231,.25); background: #fff; color: #4b5be7; }
.detail-icon-button svg { width: 15px; height: 15px; }
.detail-tabs { display: flex; gap: 4px; padding: 8px 14px 0; border-bottom: 1px solid rgba(148,163,184,.14); }
.detail-tabs button { display: inline-flex; min-height: 40px; align-items: center; gap: 7px; padding: 0 14px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: #7a8498; font-size: 12px; font-weight: 650; }
.detail-tabs button:hover { color: #3c4861; }
.detail-tabs button.active { border-bottom-color: #4b5be7; color: #4352d4; }
.detail-tabs span { display: inline-grid; min-width: 19px; height: 19px; place-items: center; border-radius: 7px; background: #eef0f7; font-size: 9px; }
.detail-tabs button.active span { background: #e6e9ff; }
.detail-body { min-height: 0; overflow: auto; scrollbar-width: thin; scrollbar-color: rgba(110,121,150,.28) transparent; }
.description-pane, .reply-pane { padding: 20px; }
.description-copy { min-height: 160px; color: #3d4860; font-size: 13px; line-height: 1.9; white-space: pre-wrap; }
.description-empty-image { display: flex; min-height: 78px; align-items: center; justify-content: center; gap: 8px; margin-top: 18px; border: 1px dashed rgba(148,163,184,.25); border-radius: 14px; color: #a1a9b8; font-size: 11px; }
.description-empty-image svg { width: 16px; height: 16px; }
.description-editor label > span { display: block; margin-bottom: 8px; color: #606c83; font-size: 11px; font-weight: 700; }
.description-editor textarea, .reply-card textarea, .reply-composer-large textarea { width: 100%; resize: vertical; border: 1px solid rgba(148,163,184,.28); border-radius: 14px; background: rgba(255,255,255,.88); color: #344057; font-size: 13px; line-height: 1.7; outline: none; transition: .16s ease; }
.description-editor textarea { min-height: 210px; padding: 14px; }
.reply-card textarea, .reply-composer-large textarea { padding: 11px 12px; }
.description-editor textarea:focus, .reply-card textarea:focus, .reply-composer-large textarea:focus { border-color: rgba(79,91,231,.55); box-shadow: 0 0 0 4px rgba(79,91,231,.11); }
.image-grid { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 10px; margin-top: 14px; }
.image-item, .image-upload { position: relative; min-height: 108px; overflow: hidden; border: 1px solid rgba(148,163,184,.2); border-radius: 13px; background: #f6f8fc; }
.image-item { padding: 0; }
.image-item img { display: block; width: 100%; height: 108px; object-fit: cover; transition: transform .18s ease; }
.image-item:hover img { transform: scale(1.025); }
.remove-image { position: absolute; top: 6px; right: 6px; display: grid; width: 24px; height: 24px; place-items: center; border-radius: 8px; background: rgba(23,32,51,.72); color: white; }
.remove-image svg { width: 13px; height: 13px; }
.image-upload { display: flex; cursor: pointer; flex-direction: column; align-items: center; justify-content: center; color: #73809a; }
.image-upload:hover { border-color: rgba(79,91,231,.35); background: #f0f2ff; color: #4b5be7; }
.image-upload svg { width: 21px; height: 21px; }
.image-upload span { margin-top: 7px; font-size: 11px; font-weight: 700; }
.image-upload small { margin-top: 3px; color: #a1a9b8; font-size: 9px; }
.image-upload input, .attachment-button input { display: none; }
.editor-actions, .reply-edit-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 13px; }
.editor-actions > span { margin-right: auto; color: #a0a8b8; font-size: 10px; }
.editor-actions button, .reply-edit-actions button { min-height: 34px; padding: 0 12px; border: 0; border-radius: 10px; background: #eef1f6; color: #68738a; font-size: 11px; font-weight: 700; }
.editor-actions button.primary, .reply-edit-actions button.primary { background: #4b5be7; color: white; }
.editor-actions button:disabled, .reply-edit-actions button:disabled { opacity: .48; }
.reply-pane { display: grid; gap: 11px; }
.reply-empty { display: grid; min-height: 150px; place-items: center; align-content: center; color: #a0a9b9; text-align: center; }
.reply-empty svg { width: 28px; height: 28px; }
.reply-empty strong { margin-top: 10px; color: #637087; font-size: 12px; }
.reply-empty p { margin: 4px 0 0; font-size: 10px; }
.reply-card { display: grid; grid-template-columns: 34px minmax(0,1fr); gap: 10px; padding: 13px; border: 1px solid rgba(148,163,184,.16); border-radius: 15px; background: rgba(255,255,255,.65); }
.reply-avatar { display: grid; width: 34px; height: 34px; place-items: center; border-radius: 11px; background: #eceeff; color: #4b58d2; font-size: 9px; font-weight: 800; }
.reply-avatar.current { background: #e8f5ff; color: #277ab6; }
.reply-content { min-width: 0; }
.reply-content header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.reply-content strong { color: #364157; font-size: 11px; }
.reply-content time { color: #a0a8b7; font-size: 9px; }
.reply-content > p { margin: 8px 0 0; color: #556178; font-size: 12px; line-height: 1.7; white-space: pre-wrap; }
.reply-actions { display: flex; gap: 12px; margin-top: 9px; }
.reply-actions button { padding: 0; border: 0; background: transparent; color: #6f7b92; font-size: 9px; }
.reply-actions button:hover { color: #4b5be7; }
.reply-actions button.danger:hover { color: #dc3158; }
.compact-grid { grid-template-columns: repeat(3, minmax(0,128px)); gap: 7px; }
.compact-grid .image-item, .compact-grid .image-upload { min-height: 78px; }
.compact-grid .image-item img { height: 78px; }
.compact-upload span { margin-top: 4px; }
.reply-composer-large { margin-top: 5px; padding: 14px; border: 1px solid rgba(99,102,241,.16); border-radius: 16px; background: rgba(240,242,255,.52); }
.composer-title { display: flex; align-items: center; gap: 9px; margin-bottom: 10px; color: #445068; font-size: 11px; }
.reply-composer-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 10px; }
.reply-composer-actions > span { color: #9aa3b3; font-size: 9px; }
.attachment-button { display: inline-flex; min-height: 34px; cursor: pointer; align-items: center; gap: 6px; border-radius: 10px; padding: 0 10px; background: rgba(255,255,255,.78); color: #66738b; font-size: 10px; font-weight: 700; }
.attachment-button:hover { color: #4b5be7; }
.attachment-button svg { width: 14px; height: 14px; }
.send-button { display: inline-flex; min-height: 34px; align-items: center; gap: 6px; margin-left: auto; border: 0; border-radius: 10px; padding: 0 12px; background: #4b5be7; color: white; font-size: 10px; font-weight: 750; }
.send-button svg { width: 14px; height: 14px; }
.send-button:disabled { background: #c6ccdf; }
.detail-footer { display: flex; min-height: 60px; align-items: center; justify-content: space-between; gap: 14px; padding: 10px 17px; border-top: 1px solid rgba(148,163,184,.17); background: rgba(247,249,252,.82); }
.detail-footer > div { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.detail-footer > div:first-child span { border-radius: 8px; padding: 5px 8px; background: white; color: #8791a5; font-size: 9px; }
.delete-button { display: inline-flex; min-height: 34px; align-items: center; gap: 6px; border: 0; border-radius: 10px; padding: 0 10px; background: #fff0f4; color: #c43b61; font-size: 10px; font-weight: 700; }
.delete-button svg { width: 14px; height: 14px; }
.image-preview { position: absolute; z-index: 5; inset: 0; display: grid; place-items: center; padding: 34px; background: rgba(15,22,39,.84); }
.image-preview > button { position: absolute; top: 18px; right: 18px; display: grid; width: 38px; height: 38px; place-items: center; border: 1px solid rgba(255,255,255,.16); border-radius: 12px; background: rgba(255,255,255,.1); color: white; }
.image-preview > button svg { width: 18px; height: 18px; }
.image-preview img { max-width: 100%; max-height: calc(100% - 36px); border-radius: 12px; object-fit: contain; box-shadow: 0 20px 60px rgba(0,0,0,.35); }
.image-preview > span { position: absolute; bottom: 14px; color: rgba(255,255,255,.72); font-size: 10px; }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 720px) {
  .annotation-detail-backdrop { padding: 8px; }
  .annotation-detail-modal { width: 100%; max-height: 100%; height: 100%; border-radius: 14px; }
  .image-grid { grid-template-columns: repeat(2,minmax(0,1fr)); }
  .detail-footer { align-items: flex-start; flex-direction: column; }
  .detail-footer > div:last-child { width: 100%; justify-content: space-between; }
}
</style>
