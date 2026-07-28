<script setup lang="ts">
import { computed, nextTick, onBeforeMount, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import {
  ArrowLeft,
  Check,
  CircleDotDashed,
  Eye,
  EyeOff,
  LoaderCircle,
  MapPinOff,
  Maximize2,
  MessageSquarePlus,
  Minimize2,
  MousePointer2,
  RefreshCw,
  Scan,
  Send,
  Trash2,
  X,
} from 'lucide-vue-next'

import type {
  Annotation,
  AnnotationStatus,
  BootstrapState,
  Product,
  Reply,
  User,
} from '../contracts'
import { issuePrototypeCapability } from '../api'
import AnnotationDetailModal from './AnnotationDetailModal.vue'
import UiSelect from './UiSelect.vue'

type ReviewTool = 'cursor' | 'comment' | 'region'
type AnnotationFilter = 'open' | 'resolved' | 'needs-relocation' | 'mine'
type Point = { x: number; y: number }
type AnnotationAnchor = Annotation['anchor']
type ReviewAnchor = AnnotationAnchor & {
  pageKey?: string
  selector?: string
  elementX?: number
  elementY?: number
  regionX?: number
  regionY?: number
  regionWidth?: number
  regionHeight?: number
}

interface OverlayPosition {
  kind: 'point' | 'region'
  x: number
  y: number
  width?: number
  height?: number
}

type BridgeState = 'idle' | 'waiting' | 'ready' | 'unavailable'
type BridgeAction = 'hello' | 'hit-test' | 'resolve'

interface BridgeRect {
  left: number
  top: number
  width: number
  height: number
}

interface BridgePendingRequest {
  action: BridgeAction
  timer: number
  resolve: (payload: Record<string, unknown>) => void
  reject: (error: Error) => void
}

interface ConfirmRequest {
  title: string
  message: string
  confirmLabel: string
  danger?: boolean
  run: () => Promise<void>
}

const props = defineProps<{
  state: BootstrapState
  product: Product
  action: (type: string, payload: any) => Promise<void>
  refresh: () => Promise<void>
}>()

const emit = defineEmits<{
  back: []
}>()

const workspaceRef = ref<HTMLElement | null>(null)
const surfaceRef = ref<HTMLElement | null>(null)
const overlayRef = ref<HTMLElement | null>(null)
const frameRef = ref<HTMLIFrameElement | null>(null)
const composerRef = ref<HTMLTextAreaElement | null>(null)
const confirmButtonRef = ref<HTMLButtonElement | null>(null)
const detailModalRef = ref<InstanceType<typeof AnnotationDetailModal> | null>(null)

const selectedVersion = ref(props.product.currentVersion)
const activeTool = ref<ReviewTool>('cursor')
const showBubbles = ref(true)
const selectedAnnotationId = ref<string | null>(null)
const activeFilter = ref<AnnotationFilter>('open')
const pendingAnchor = shallowRef<ReviewAnchor | null>(null)
const pendingContent = ref('')
const dragStart = shallowRef<Point | null>(null)
const dragCurrent = shallowRef<Point | null>(null)
const editingAnnotationId = ref<string | null>(null)
const editingAnnotationContent = ref('')
const editingReply = ref<{ annotationId: string; replyId: string; content: string } | null>(null)
const replyDrafts = ref<Record<string, string>>({})
const pendingKey = ref<string | null>(null)
const confirmRequest = shallowRef<ConfirmRequest | null>(null)
const confirmPending = ref(false)
const toast = ref<{ kind: 'success' | 'error' | 'info'; message: string } | null>(null)
const isFullscreen = ref(false)
const frameReady = ref(false)
const useFallbackCanvas = ref(false)
const frameAccessLimited = ref(false)
const bridgeState = ref<BridgeState>('idle')
const previewUrl = shallowRef('')
const capabilityLoading = ref(false)
const currentPageKey = ref('/')
const legacyFallbackPageKey = ref('')
const anchorPositions = shallowRef(new Map<string, OverlayPosition>())
let frameTimer: number | undefined
let toastTimer: number | undefined
let frameHrefTimer: number | undefined
let positionFrame: number | undefined
let observedFrameWindow: Window | null = null
let observedFrameDocument: Document | null = null
let anchorResizeObserver: ResizeObserver | null = null
let bridgeRequestSequence = 0
let bridgeSession = 0
let bridgeHandshakePromise: Promise<boolean> | null = null
let bridgeResolveInFlight = false
let bridgeResolveQueued = false
let bridgePort: MessagePort | null = null
let bridgeConnectAccepted = false
let bridgePortPendingLoad = false
let capabilityRequestSequence = 0
const bridgePendingRequests = new Map<string, BridgePendingRequest>()

const currentUser = computed(() => props.state.currentUser)
const versionRecords = computed(() => [...props.product.versions].sort((a, b) => b.version.localeCompare(a.version)))
const versionOptions = computed(() => versionRecords.value.length
  ? versionRecords.value.map((version) => ({
      value: version.version,
      label: `${version.version}${version.isCurrent ? ' · 当前' : ' · 历史'}`,
    }))
  : [{ value: props.product.currentVersion, label: props.product.currentVersion || '暂无版本' }])
const annotationStatusOptions = [
  { value: 'open', label: '未解决' },
  { value: 'resolved', label: '已解决' },
  { value: 'needs-relocation', label: '待定位' },
]
const selectedVersionRecord = computed(() => (
  versionRecords.value.find((item) => item.version === selectedVersion.value) ?? null
))
const isHistorical = computed(() => selectedVersion.value !== props.product.currentVersion)
const prototypeUrl = computed(() => {
  const configured = selectedVersionRecord.value?.entryUrl?.trim()
  if (configured) {
    try {
      const resolved = new URL(configured, window.location.origin)
      if (resolved.protocol === 'http:' || resolved.protocol === 'https:') return resolved.href
    } catch {
      // Invalid or unsafe URLs use the built-in preview fallback.
    }
  }
  return '/demo/index.html'
})
const isResponsible = computed(() => (
  currentUser.value.role === 'admin'
  || currentUser.value.id === props.product.ownerId
))
const coordinateOnlyMode = computed(() => (
  frameAccessLimited.value && bridgeState.value === 'unavailable' && !useFallbackCanvas.value
))

const versionAnnotations = computed(() => props.state.annotations
  .filter((item) => (
    item.productId === props.product.id
    && item.version === selectedVersion.value
    && !item.deleted
  ))
  .sort((a, b) => a.createdAt.localeCompare(b.createdAt)))

const pageAnnotations = computed(() => versionAnnotations.value.filter((annotation) => {
  const anchor = annotation.anchor as ReviewAnchor
  if (anchor.pageKey === currentPageKey.value) return true
  if (anchor.pageKey) {
    const currentBase = currentPageKey.value.split('::view=', 1)[0]
    return anchor.pageKey === currentBase && currentPageKey.value === legacyFallbackPageKey.value
  }
  return Boolean(legacyFallbackPageKey.value) && currentPageKey.value === legacyFallbackPageKey.value
}))

const bubbleNumbers = computed(() => new Map(
  pageAnnotations.value.map((item, index) => [item.id, index + 1]),
))

const filterCounts = computed(() => ({
  open: pageAnnotations.value.filter((item) => item.status === 'open').length,
  resolved: pageAnnotations.value.filter((item) => item.status === 'resolved').length,
  'needs-relocation': pageAnnotations.value.filter((item) => (
    item.status === 'needs-relocation' || isAnchorMissing(item)
  )).length,
  mine: pageAnnotations.value.filter((item) => item.authorId === currentUser.value.id).length,
}))

const filteredAnnotations = computed(() => {
  if (activeFilter.value === 'mine') {
    return pageAnnotations.value.filter((item) => item.authorId === currentUser.value.id)
  }
  if (activeFilter.value === 'needs-relocation') {
    return pageAnnotations.value.filter((item) => (
      item.status === 'needs-relocation' || isAnchorMissing(item)
    ))
  }
  return pageAnnotations.value.filter((item) => item.status === activeFilter.value)
})

const selectedAnnotation = computed(() => (
  pageAnnotations.value.find((item) => item.id === selectedAnnotationId.value) ?? null
))

const positionedAnnotations = computed(() => pageAnnotations.value.filter((annotation) => (
  anchorPositions.value.has(annotation.id)
)))

const dragRect = computed(() => {
  if (!dragStart.value || !dragCurrent.value) return null
  const left = Math.min(dragStart.value.x, dragCurrent.value.x)
  const top = Math.min(dragStart.value.y, dragCurrent.value.y)
  return {
    left: `${left * 100}%`,
    top: `${top * 100}%`,
    width: `${Math.abs(dragCurrent.value.x - dragStart.value.x) * 100}%`,
    height: `${Math.abs(dragCurrent.value.y - dragStart.value.y) * 100}%`,
  }
})

const pendingTraceStyle = computed(() => {
  const anchor = pendingAnchor.value
  if (!anchor) return undefined
  if (anchor.kind === 'region') {
    return {
      left: `${anchor.x * 100}%`,
      top: `${anchor.y * 100}%`,
      width: `${(anchor.width ?? 0) * 100}%`,
      height: `${(anchor.height ?? 0) * 100}%`,
    }
  }
  return { left: `${anchor.x * 100}%`, top: `${anchor.y * 100}%` }
})

const composerStyle = computed(() => {
  const anchor = pendingAnchor.value
  if (!anchor) return undefined
  const centerX = anchor.x + (anchor.width ?? 0) / 2
  const centerY = anchor.y + (anchor.height ?? 0) / 2
  return {
    left: `${Math.min(Math.max(centerX * 100, 7), 68)}%`,
    top: `${Math.min(Math.max(centerY * 100, 9), 65)}%`,
  }
})

const toolOptions: Array<{ value: ReviewTool; label: string; hint: string }> = [
  { value: 'cursor', label: '鼠标', hint: '浏览并操作原型' },
  { value: 'comment', label: '批注', hint: '点击定位，或拖拽选取区域' },
  { value: 'region', label: '框选', hint: '拖拽框选批注区域' },
]

const filterOptions: Array<{ value: AnnotationFilter; label: string }> = [
  { value: 'open', label: '未解决' },
  { value: 'resolved', label: '已解决' },
  { value: 'needs-relocation', label: '待定位' },
  { value: 'mine', label: '我的' },
]

const statusMeta: Record<AnnotationStatus, { label: string; className: string }> = {
  open: { label: '未解决', className: 'is-open' },
  resolved: { label: '已解决', className: 'is-resolved' },
  'needs-relocation': { label: '待定位', className: 'is-relocation' },
}

function notify(message: string, kind: 'success' | 'error' | 'info' = 'success') {
  toast.value = { message, kind }
  if (toastTimer) window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => { toast.value = null }, 3200)
}

function userFor(id: string): User | undefined {
  return props.state.users.find((item) => item.id === id)
}

function authorName(id: string) {
  return userFor(id)?.name ?? '已停用成员'
}

function initials(id: string) {
  return authorName(id).trim().slice(0, 2).toUpperCase() || '成员'
}

function formatTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date)
}

function statusLabel(status: AnnotationStatus) {
  return statusMeta[status]?.label ?? status
}

function canEditAnnotation(annotation: Annotation) {
  return !isHistorical.value && (
    currentUser.value.role === 'admin' || annotation.authorId === currentUser.value.id
  )
}

function canChangeStatus(annotation: Annotation) {
  return !isHistorical.value && (
    isResponsible.value || annotation.authorId === currentUser.value.id
  )
}

function canManageReply(reply: Reply) {
  return !isHistorical.value && (
    currentUser.value.role === 'admin' || reply.authorId === currentUser.value.id
  )
}

function setTool(tool: ReviewTool) {
  if (isHistorical.value && tool !== 'cursor') {
    notify('历史版本为只读状态，可查看当时已完成的批注。', 'info')
    return
  }
  activeTool.value = tool
  pendingAnchor.value = null
  pendingContent.value = ''
  dragStart.value = null
  dragCurrent.value = null
}

function clamp(value: number, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value))
}

function pageKeyFromUrl(value: string) {
  try {
    const url = new URL(value, window.location.origin)
    const releasePrefix = (
      url.pathname.match(/^\/prototype-cap\/[^/]+\/[^/]+\/\d{14}(?=\/|$)/)?.[0]
      ?? url.pathname.match(/^\/prototype-files\/[^/]+\/\d{14}(?=\/|$)/)?.[0]
      ?? ''
    )
    let pathname = releasePrefix ? url.pathname.slice(releasePrefix.length) : url.pathname
    if (!pathname.startsWith('/')) pathname = `/${pathname}`
    const hash = url.hash || (String(value).includes('#') ? '#' : '')
    return `${pathname || '/'}${url.search}${hash}`
  } catch {
    return '/'
  }
}

function normalizedViewIdentity(value: unknown) {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 360)
}

function pageKeyFromView(value: string, viewIdentity?: unknown) {
  const base = pageKeyFromUrl(value)
  const view = normalizedViewIdentity(viewIdentity)
  return view ? `${base}::view=${encodeURIComponent(view)}`.slice(0, 950) : base
}

function documentViewIdentity(documentNode: Document, frameWindow: Window) {
  const compactText = (value: string | null | undefined) => String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+\d+\s*$/, '')
    .slice(0, 80)
  const identityText = (element: Element) => compactText(
    element.getAttribute('data-page-key')
    || element.getAttribute('data-route')
    || element.getAttribute('href')
    || element.getAttribute('aria-label')
    || element.textContent,
  )
  const isVisible = (element: Element) => {
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    const style = frameWindow.getComputedStyle(element)
    return style.display !== 'none' && style.visibility !== 'hidden'
  }
  const active: string[] = []
  for (const selector of [
    '[aria-current="page"]', '[role="tab"][aria-selected="true"]', '.nav-item.active', '.menu-item.active',
    '.ant-menu-item-selected', '.el-menu-item.is-active', 'nav .active', 'aside .active',
  ]) {
    for (const element of documentNode.querySelectorAll(selector)) {
      if (!isVisible(element)) continue
      const text = identityText(element)
      if (text && !active.includes(text)) active.push(text)
      if (active.length >= 4) break
    }
    if (active.length >= 4) break
  }
  const headings: string[] = []
  for (const element of documentNode.querySelectorAll('main h1, main h2, [role="main"] h1, [role="main"] h2, h1')) {
    if (!isVisible(element)) continue
    const text = compactText(element.textContent)
    if (text && !headings.includes(text)) headings.push(text)
    if (headings.length >= 2) break
  }
  return [...active.map((text) => `active=${text}`), ...headings.map((text) => `heading=${text}`)].join('|').slice(0, 360)
}

function attributeEscape(value: string) {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

function cssEscape(value: string, frameWindow?: Window | null) {
  const frameCss = (frameWindow as unknown as { CSS?: { escape?: (input: string) => string } } | null)?.CSS
  const escape = frameCss?.escape ?? (typeof CSS !== 'undefined' ? CSS.escape : undefined)
  if (escape) return escape(value)
  return value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character.codePointAt(0)?.toString(16)} `)
}

function isUniqueSelector(documentNode: Document, selector: string) {
  try {
    return documentNode.querySelectorAll(selector).length === 1
  } catch {
    return false
  }
}

function selectorForElement(element: Element, documentNode: Document, frameWindow: Window) {
  const annotationId = element.getAttribute('data-annotation-id')?.trim()
  if (annotationId) {
    const selector = `[data-annotation-id="${attributeEscape(annotationId)}"]`
    if (isUniqueSelector(documentNode, selector)) return selector
  }

  const id = element.getAttribute('id')?.trim()
  if (id) {
    const selector = `#${cssEscape(id, frameWindow)}`
    if (isUniqueSelector(documentNode, selector)) return selector
  }

  for (const attribute of ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'name', 'aria-label']) {
    const value = element.getAttribute(attribute)?.trim()
    if (!value) continue
    const selector = `${element.localName}[${attribute}="${attributeEscape(value)}"]`
    if (isUniqueSelector(documentNode, selector)) return selector
  }

  const parts: string[] = []
  let current: Element | null = element
  while (current && current !== documentNode.documentElement) {
    const currentName = current.localName
    const tag = currentName.toLowerCase()
    if (!tag) break
    const parentElement: Element | null = current.parentElement
    let part = tag
    if (parentElement) {
      const siblings = [...parentElement.children].filter((item) => item.localName === currentName)
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`
    }
    parts.unshift(part)
    const selector = parts.join(' > ')
    if (isUniqueSelector(documentNode, selector)) return selector
    current = parentElement
  }
  return parts.join(' > ') || element.localName.toLowerCase()
}

const BRIDGE_CONNECT_CHANNEL = 'prototype-review-bridge-connect'
const BRIDGE_HOST_CHANNEL = 'prototype-review-host-port'
const BRIDGE_CHANNEL = 'prototype-review-bridge-port'
const BRIDGE_VERSION = 1

function isBridgeRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isShortBridgeString(value: unknown, maximum: number) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function bridgeRect(value: unknown): BridgeRect | null {
  if (!isBridgeRecord(value)) return null
  const numbers = [value.left, value.top, value.width, value.height]
  if (!numbers.every((item) => typeof item === 'number' && Number.isFinite(item) && Math.abs(item) <= 10_000_000)) return null
  if (Number(value.width) <= 0 || Number(value.height) <= 0) return null
  return {
    left: Number(value.left), top: Number(value.top),
    width: Number(value.width), height: Number(value.height),
  }
}

function updateCurrentPageFromHref(href: string, viewIdentity?: unknown) {
  const nextPageKey = pageKeyFromView(href, viewIdentity)
  const nextBase = pageKeyFromUrl(href)
  if (!legacyFallbackPageKey.value || (
    legacyFallbackPageKey.value === nextBase && nextPageKey.startsWith(`${nextBase}::view=`)
  )) legacyFallbackPageKey.value = nextPageKey
  if (nextPageKey !== currentPageKey.value) {
    currentPageKey.value = nextPageKey
    selectedAnnotationId.value = null
    pendingAnchor.value = null
    pendingContent.value = ''
    dragStart.value = null
    dragCurrent.value = null
    anchorPositions.value = new Map()
  }
}

function validBridgeHref(value: unknown) {
  if (!isShortBridgeString(value, 4096)) return null
  try {
    const href = new URL(String(value))
    const expected = new URL(previewUrl.value, window.location.origin)
    const parts = expected.pathname.split('/')
    if (parts.length < 6 || parts[1] !== 'prototype-cap' || !parts[2]) return null
    if (decodeURIComponent(parts[3]) !== props.product.id || decodeURIComponent(parts[4]) !== selectedVersion.value) return null
    const previewBase = `${parts.slice(0, 5).join('/')}/`
    if (href.origin !== expected.origin || !expected.pathname.startsWith(previewBase) || !href.pathname.startsWith(previewBase)) return null
    return href.href
  } catch {
    return null
  }
}

function rejectBridgeRequests(message = '原型定位 bridge 已重置') {
  for (const request of bridgePendingRequests.values()) {
    window.clearTimeout(request.timer)
    request.reject(new Error(message))
  }
  bridgePendingRequests.clear()
  bridgeHandshakePromise = null
  bridgeResolveInFlight = false
  bridgeResolveQueued = false
}

function closeBridgePort(allowReconnect: boolean) {
  bridgePort?.close()
  bridgePort = null
  bridgePortPendingLoad = false
  if (allowReconnect) bridgeConnectAccepted = false
}

function invalidateBridge(message: string) {
  rejectBridgeRequests(message)
  closeBridgePort(false)
  bridgeState.value = 'unavailable'
  updateCurrentPageFromHref(prototypeUrl.value)
  scheduleAnchorRecompute()
}

function requestBridge(action: BridgeAction, payload: Record<string, unknown> = {}, timeout = 1400) {
  const target = bridgePort
  if (!target) return Promise.reject(new Error('原型定位 bridge 尚未连接'))
  const requestId = `review-${bridgeSession}-${++bridgeRequestSequence}`
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      bridgePendingRequests.delete(requestId)
      reject(new Error('原型定位 bridge 响应超时'))
    }, timeout)
    bridgePendingRequests.set(requestId, { action, timer, resolve, reject })
    try {
      target.postMessage({
        channel: BRIDGE_HOST_CHANNEL,
        version: BRIDGE_VERSION,
        action,
        requestId,
        payload,
      })
    } catch (error) {
      window.clearTimeout(timer)
      bridgePendingRequests.delete(requestId)
      reject(error instanceof Error ? error : new Error('无法联系原型定位 bridge'))
    }
  })
}

function handleBridgePortMessage(sourcePort: MessagePort, event: MessageEvent) {
  if (sourcePort !== bridgePort || !isBridgeRecord(event.data)) return
  const data = event.data
  if (data.channel !== BRIDGE_CHANNEL || data.version !== BRIDGE_VERSION || Object.keys(data).length > 7) return
  if (!['ready', 'change', 'response', 'disconnect'].includes(String(data.type)) || !isBridgeRecord(data.payload)) return
  const payload = data.payload
  const href = validBridgeHref(payload.href)
  if (!href) {
    invalidateBridge('原型定位 bridge 返回了越界页面地址')
    return
  }
  payload.href = href
  if (Object.keys(payload).length > 6) return

  if (data.type === 'disconnect') {
    bridgeSession += 1
    rejectBridgeRequests('原型页面正在导航')
    closeBridgePort(true)
    bridgeState.value = 'idle'
    frameReady.value = false
    return
  }

  if (data.type === 'response') {
    if (!isShortBridgeString(data.requestId, 80) || !['hello', 'hit-test', 'resolve'].includes(String(data.action))) return
    const request = bridgePendingRequests.get(String(data.requestId))
    if (!request || request.action !== data.action) return
    if (data.action === 'resolve' && (!Array.isArray(payload.items) || payload.items.length > 100)) return
    window.clearTimeout(request.timer)
    bridgePendingRequests.delete(String(data.requestId))
    request.resolve(payload)
    return
  }

  if (!frameReady.value) return
  if (data.type === 'change' && !['route', 'layout', 'scroll', 'resize'].includes(String(payload.reason))) return
  bridgeState.value = 'ready'
  frameAccessLimited.value = true
  updateCurrentPageFromHref(href, payload.view)
  scheduleAnchorRecompute()
}

function handleBridgeConnect(event: MessageEvent) {
  if (event.source !== frameRef.value?.contentWindow || event.origin !== 'null' || !isBridgeRecord(event.data)) return
  const data = event.data
  const incomingPort = event.ports[0]
  if (data.channel !== BRIDGE_CONNECT_CHANNEL || data.version !== BRIDGE_VERSION || data.type !== 'connect'
      || Object.keys(data).length !== 3 || event.ports.length !== 1 || !incomingPort) {
    incomingPort?.close()
    return
  }
  if (bridgeConnectAccepted) {
    incomingPort.close()
    return
  }
  bridgeConnectAccepted = true
  bridgePortPendingLoad = !frameReady.value
  bridgePort = incomingPort
  incomingPort.addEventListener('message', (message) => handleBridgePortMessage(incomingPort, message))
  incomingPort.addEventListener('messageerror', () => {
    if (incomingPort === bridgePort) invalidateBridge('原型定位 bridge 消息无法解析')
  })
  incomingPort.start()
  bridgeState.value = 'waiting'
}

function waitForBridgePort(timeout = 700) {
  if (bridgePort) return Promise.resolve(bridgePort)
  const session = bridgeSession
  return new Promise<MessagePort>((resolve, reject) => {
    const startedAt = performance.now()
    const timer = window.setInterval(() => {
      if (session !== bridgeSession) {
        window.clearInterval(timer)
        reject(new Error('原型页面已经切换'))
      } else if (bridgePort) {
        window.clearInterval(timer)
        resolve(bridgePort)
      } else if (performance.now() - startedAt >= timeout) {
        window.clearInterval(timer)
        reject(new Error('原型定位 bridge 未连接'))
      }
    }, 20)
  })
}

async function ensureBridge() {
  if (bridgeState.value === 'ready') return true
  if (bridgeHandshakePromise) return bridgeHandshakePromise
  if (!frameReady.value || useFallbackCanvas.value) return false
  bridgeState.value = 'waiting'
  const session = bridgeSession
  bridgeHandshakePromise = waitForBridgePort()
    .then(() => requestBridge('hello', {}, 1600))
    .then((payload) => {
      const href = validBridgeHref(payload.href)
      if (session !== bridgeSession || !href) return false
      bridgeState.value = 'ready'
      frameAccessLimited.value = true
      updateCurrentPageFromHref(href, payload.view)
      scheduleAnchorRecompute()
      return true
    })
    .catch(() => {
      if (session === bridgeSession) {
        closeBridgePort(false)
        bridgeState.value = 'unavailable'
        updateCurrentPageFromHref(prototypeUrl.value)
        scheduleAnchorRecompute()
      }
      return false
    })
    .finally(() => {
      if (session === bridgeSession) bridgeHandshakePromise = null
    })
  return bridgeHandshakePromise
}

function frameContext() {
  const iframe = frameRef.value
  const surface = surfaceRef.value
  if (!iframe || !surface || useFallbackCanvas.value) return null
  try {
    const frameWindow = iframe.contentWindow
    if (!frameWindow) return null
    // Accessing href is the intentional same-origin guard.
    void frameWindow.location.href
    const documentNode = iframe.contentDocument
    if (!documentNode) {
      if (frameReady.value) frameAccessLimited.value = true
      return null
    }
    frameAccessLimited.value = false
    return {
      iframe,
      surface,
      frameWindow,
      documentNode,
      frameRect: iframe.getBoundingClientRect(),
      surfaceRect: surface.getBoundingClientRect(),
    }
  } catch {
    frameAccessLimited.value = true
    return null
  }
}

function fallbackPosition(anchor: ReviewAnchor, overlayRect?: DOMRect): OverlayPosition {
  const rect = overlayRect ?? overlayRef.value?.getBoundingClientRect() ?? surfaceRef.value?.getBoundingClientRect()
  const width = rect?.width ?? 0
  const height = rect?.height ?? 0
  return anchor.kind === 'region'
    ? {
        kind: 'region', x: anchor.x * width, y: anchor.y * height,
        width: (anchor.width ?? 0) * width, height: (anchor.height ?? 0) * height,
      }
    : { kind: 'point', x: anchor.x * width, y: anchor.y * height }
}

function positionFromRect(
  anchor: ReviewAnchor,
  rect: BridgeRect,
  frameRect: DOMRect,
  overlayRect: DOMRect,
): OverlayPosition {
  const frameOffsetX = frameRect.left - overlayRect.left
  const frameOffsetY = frameRect.top - overlayRect.top
  if (anchor.kind === 'region' && Number.isFinite(anchor.regionX) && Number.isFinite(anchor.regionY)
      && Number.isFinite(anchor.regionWidth) && Number.isFinite(anchor.regionHeight)) {
    return {
      kind: 'region',
      x: frameOffsetX + rect.left + rect.width * Number(anchor.regionX),
      y: frameOffsetY + rect.top + rect.height * Number(anchor.regionY),
      width: rect.width * Number(anchor.regionWidth),
      height: rect.height * Number(anchor.regionHeight),
    }
  }
  if (Number.isFinite(anchor.elementX) && Number.isFinite(anchor.elementY)) {
    return {
      kind: 'point',
      x: frameOffsetX + rect.left + rect.width * Number(anchor.elementX),
      y: frameOffsetY + rect.top + rect.height * Number(anchor.elementY),
    }
  }
  return fallbackPosition(anchor, overlayRect)
}

function scheduleAnchorRecompute() {
  if (positionFrame) return
  positionFrame = window.requestAnimationFrame(() => {
    positionFrame = undefined
    recomputeAnchorPositions()
  })
}

function recomputeAnchorPositions() {
  const positions = new Map<string, OverlayPosition>()
  const overlayRect = overlayRef.value?.getBoundingClientRect() ?? surfaceRef.value?.getBoundingClientRect()
  const previousPositions = anchorPositions.value
  // Element anchors remain the primary source of truth. During an asynchronous
  // bridge refresh, keep the last valid element position instead of flashing back
  // to the viewport percentage captured when the annotation was created.
  for (const annotation of pageAnnotations.value) {
    const anchor = annotation.anchor as ReviewAnchor
    const previous = anchor.selector ? previousPositions.get(annotation.id) : undefined
    positions.set(annotation.id, previous ?? fallbackPosition(anchor, overlayRect))
  }
  const context = frameContext()
  anchorResizeObserver?.disconnect()
  if (surfaceRef.value) anchorResizeObserver?.observe(surfaceRef.value)
  if (overlayRef.value) anchorResizeObserver?.observe(overlayRef.value)
  if (frameRef.value) anchorResizeObserver?.observe(frameRef.value)

  if (!context) {
    if (bridgeState.value === 'ready' && bridgeResolveInFlight) {
      bridgeResolveQueued = true
      return
    }
    anchorPositions.value = positions
    if (!useFallbackCanvas.value && bridgeState.value === 'ready') void resolveAnchorsThroughBridge(positions)
    else if (!useFallbackCanvas.value && bridgeState.value !== 'unavailable') {
      void ensureBridge().then((ready) => { if (ready) scheduleAnchorRecompute() })
    }
    return
  }

  anchorResizeObserver?.observe(context.documentNode.documentElement)
  for (const annotation of pageAnnotations.value) {
    const anchor = annotation.anchor as ReviewAnchor
    if (!anchor.selector) continue

    let target: Element | null = null
    try { target = context.documentNode.querySelector(anchor.selector) } catch { target = null }
    if (!target) continue
    const rect = target.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue
    anchorResizeObserver?.observe(target)
    if (!overlayRect) continue
    positions.set(annotation.id, positionFromRect(anchor, rect, context.frameRect, overlayRect))
  }
  anchorPositions.value = positions
}

async function resolveAnchorsThroughBridge(basePositions: Map<string, OverlayPosition>) {
  if (bridgeResolveInFlight) {
    bridgeResolveQueued = true
    return
  }
  const iframe = frameRef.value
  const surface = surfaceRef.value
  const overlay = overlayRef.value
  if (!iframe || !surface || !overlay || bridgeState.value !== 'ready') return
  const targets = pageAnnotations.value
    .map((annotation) => ({ annotation, anchor: annotation.anchor as ReviewAnchor }))
    .filter((item) => Boolean(item.anchor.selector))
  if (!targets.length) return

  bridgeResolveInFlight = true
  const session = bridgeSession
  const requestedPageKey = currentPageKey.value
  try {
    const chunks: Array<typeof targets> = []
    for (let index = 0; index < targets.length; index += 100) chunks.push(targets.slice(index, index + 100))
    const responses = await Promise.all(chunks.map((chunk) => requestBridge('resolve', {
      items: chunk.map(({ annotation, anchor }) => ({ id: annotation.id, selector: anchor.selector })),
    })))
    if (session !== bridgeSession || bridgeState.value !== 'ready') return

    const positions = new Map(basePositions)
    const targetById = new Map(targets.map((item) => [item.annotation.id, item]))
    const frameRect = iframe.getBoundingClientRect()
    const overlayRect = overlay.getBoundingClientRect()
    for (const response of responses) {
      const responseHref = validBridgeHref(response.href)
      if (!responseHref) continue
      const responsePageKey = pageKeyFromView(responseHref, response.view)
      if (responsePageKey !== requestedPageKey) {
        updateCurrentPageFromHref(responseHref, response.view)
        bridgeResolveQueued = true
        continue
      }
      if (!Array.isArray(response.items)) continue
      for (const rawItem of response.items) {
        if (!isBridgeRecord(rawItem) || !isShortBridgeString(rawItem.id, 160)) continue
        const target = targetById.get(String(rawItem.id))
        const rect = bridgeRect(rawItem.rect)
        if (!target || !rect) continue
        positions.set(target.annotation.id, positionFromRect(target.anchor, rect, frameRect, overlayRect))
      }
    }
    if (requestedPageKey === currentPageKey.value) anchorPositions.value = positions
  } catch {
    if (session === bridgeSession) invalidateBridge('原型定位 bridge 元素解析失败')
  } finally {
    if (session === bridgeSession) {
      bridgeResolveInFlight = false
      if (bridgeResolveQueued) {
        bridgeResolveQueued = false
        scheduleAnchorRecompute()
      }
    }
  }
}

function syncFramePage() {
  if (!frameReady.value) return
  const context = frameContext()
  if (!context) {
    if (bridgeState.value === 'ready' || bridgeState.value === 'waiting') return
    if (frameAccessLimited.value) updateCurrentPageFromHref(prototypeUrl.value)
    scheduleAnchorRecompute()
    return
  }
  updateCurrentPageFromHref(
    context.frameWindow.location.href,
    documentViewIdentity(context.documentNode, context.frameWindow),
  )
  scheduleAnchorRecompute()
}

function detachFrameListeners() {
  if (observedFrameWindow) {
    try {
      observedFrameWindow.removeEventListener('hashchange', syncFramePage)
      observedFrameWindow.removeEventListener('popstate', syncFramePage)
      observedFrameWindow.removeEventListener('scroll', scheduleAnchorRecompute)
    } catch {
      // A navigation can make a previously same-origin frame inaccessible.
    }
  }
  observedFrameDocument?.removeEventListener('scroll', scheduleAnchorRecompute, true)
  observedFrameWindow = null
  observedFrameDocument = null
}

function attachFrameListeners() {
  detachFrameListeners()
  const context = frameContext()
  if (!context) return
  observedFrameWindow = context.frameWindow
  observedFrameDocument = context.documentNode
  context.frameWindow.addEventListener('hashchange', syncFramePage)
  context.frameWindow.addEventListener('popstate', syncFramePage)
  context.frameWindow.addEventListener('scroll', scheduleAnchorRecompute, { passive: true })
  context.documentNode.addEventListener('scroll', scheduleAnchorRecompute, { capture: true, passive: true })
}

function anchorFromHit(
  fallback: ReviewAnchor,
  selector: string,
  rect: BridgeRect,
  start: Point,
  end: Point,
  isDrag: boolean,
  frameRect: DOMRect,
  surfaceRect: DOMRect,
): ReviewAnchor {
  const width = Math.abs(end.x - start.x)
  const height = Math.abs(end.y - start.y)
  const center = isDrag
    ? { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
    : end
  const frameX = surfaceRect.left + center.x * surfaceRect.width - frameRect.left
  const frameY = surfaceRect.top + center.y * surfaceRect.height - frameRect.top

  if (!isDrag) {
    return {
      ...fallback,
      selector,
      elementX: clamp((frameX - rect.left) / rect.width),
      elementY: clamp((frameY - rect.top) / rect.height),
    }
  }

  const selectionLeft = surfaceRect.left + Math.min(start.x, end.x) * surfaceRect.width - frameRect.left
  const selectionTop = surfaceRect.top + Math.min(start.y, end.y) * surfaceRect.height - frameRect.top
  return {
    ...fallback,
    selector,
    regionX: (selectionLeft - rect.left) / rect.width,
    regionY: (selectionTop - rect.top) / rect.height,
    regionWidth: width * surfaceRect.width / rect.width,
    regionHeight: height * surfaceRect.height / rect.height,
  }
}

async function buildReviewAnchor(start: Point, end: Point, isDrag: boolean): Promise<ReviewAnchor> {
  const width = Math.abs(end.x - start.x)
  const height = Math.abs(end.y - start.y)
  const makeFallback = (pageKey = currentPageKey.value): ReviewAnchor => isDrag
    ? {
        kind: 'region', x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width, height, pageKey,
      }
    : { kind: 'point', x: end.x, y: end.y, pageKey }
  const fallback = makeFallback()
  const iframe = frameRef.value
  const surface = surfaceRef.value
  if (!iframe || !surface) return fallback
  const frameRect = iframe.getBoundingClientRect()
  const surfaceRect = surface.getBoundingClientRect()
  const center = isDrag ? { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 } : end
  const frameX = surfaceRect.left + center.x * surfaceRect.width - frameRect.left
  const frameY = surfaceRect.top + center.y * surfaceRect.height - frameRect.top

  const context = frameContext()
  if (context) {
    updateCurrentPageFromHref(
      context.frameWindow.location.href,
      documentViewIdentity(context.documentNode, context.frameWindow),
    )
    const target = context.documentNode.elementFromPoint(frameX, frameY)
    if (!target) return makeFallback()
    const rect = target.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return makeFallback()
    const selector = selectorForElement(target, context.documentNode, context.frameWindow)
    return anchorFromHit(makeFallback(), selector, rect, start, end, isDrag, frameRect, surfaceRect)
  }

  const bridgeAttemptSession = bridgeSession
  if (await ensureBridge()) {
    try {
      const requestFrameRect = iframe.getBoundingClientRect()
      const requestSurfaceRect = surface.getBoundingClientRect()
      const requestFrameX = requestSurfaceRect.left + center.x * requestSurfaceRect.width - requestFrameRect.left
      const requestFrameY = requestSurfaceRect.top + center.y * requestSurfaceRect.height - requestFrameRect.top
      const response = await requestBridge('hit-test', { x: requestFrameX, y: requestFrameY })
      const responseHref = validBridgeHref(response.href)
      if (responseHref) updateCurrentPageFromHref(responseHref, response.view)
      const responseFallback = makeFallback()
      if (!isBridgeRecord(response.hit) || !isShortBridgeString(response.hit.selector, 2000)) return responseFallback
      const rect = bridgeRect(response.hit.rect)
      if (!rect) return responseFallback
      const latestFrameRect = iframe.getBoundingClientRect()
      const latestSurfaceRect = surface.getBoundingClientRect()
      return anchorFromHit(responseFallback, String(response.hit.selector), rect, start, end, isDrag, latestFrameRect, latestSurfaceRect)
    } catch {
      if (bridgeAttemptSession === bridgeSession) invalidateBridge('原型定位 bridge 命中测试失败')
    }
  }

  notify('当前原型未提供安全定位 bridge，本条批注将仅使用坐标定位。', 'info')
  return makeFallback()
}

function isAnchorMissing(annotation: Annotation) {
  const anchor = annotation.anchor as ReviewAnchor
  return Boolean(
    anchor.selector
    && frameReady.value
    && !useFallbackCanvas.value
    && (!frameAccessLimited.value || bridgeState.value === 'ready')
    && !anchorPositions.value.has(annotation.id),
  )
}

function pointFromEvent(event: PointerEvent): Point | null {
  const element = surfaceRef.value
  if (!element) return null
  const rect = element.getBoundingClientRect()
  if (!rect.width || !rect.height) return null
  return {
    x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
  }
}

function handlePointerDown(event: PointerEvent) {
  if (activeTool.value === 'cursor' || isHistorical.value || pendingKey.value) return
  const point = pointFromEvent(event)
  if (!point) return
  pendingAnchor.value = null
  pendingContent.value = ''
  dragStart.value = point
  dragCurrent.value = point
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
}

function handlePointerMove(event: PointerEvent) {
  if (!dragStart.value) return
  const point = pointFromEvent(event)
  if (point) dragCurrent.value = point
}

async function finishSelection(event: PointerEvent) {
  const start = dragStart.value
  const end = pointFromEvent(event) ?? dragCurrent.value
  dragStart.value = null
  dragCurrent.value = null
  if (!start || !end) return
  const width = Math.abs(end.x - start.x)
  const height = Math.abs(end.y - start.y)
  const isDrag = Math.hypot(width, height) >= 0.018

  if (activeTool.value === 'region' && (!isDrag || width < 0.012 || height < 0.012)) {
    notify('选区太小，请按住鼠标拖出一个区域。', 'info')
    return
  }

  const selectionSession = bridgeSession
  const anchor = await buildReviewAnchor(start, end, isDrag)
  if (selectionSession !== bridgeSession) return
  pendingAnchor.value = anchor
  void nextTick(() => composerRef.value?.focus())
}

function cancelSelection() {
  pendingAnchor.value = null
  pendingContent.value = ''
  dragStart.value = null
  dragCurrent.value = null
}

async function execute(key: string, type: string, payload: any, successMessage: string) {
  if (pendingKey.value) return false
  pendingKey.value = key
  try {
    await props.action(type, payload)
    await props.refresh()
    notify(successMessage)
    return true
  } catch (error) {
    notify(error instanceof Error ? error.message : '操作未完成，请稍后重试。', 'error')
    return false
  } finally {
    pendingKey.value = null
  }
}

async function createAnnotation() {
  const content = pendingContent.value.trim()
  const anchor = pendingAnchor.value
  if (!anchor || !content) {
    notify('写下批注内容后再保存。', 'info')
    composerRef.value?.focus()
    return
  }
  const saved = await execute('annotation-create', 'annotation.create', {
    productId: props.product.id,
    version: selectedVersion.value,
    content,
    anchor,
  }, '批注已添加。')
  if (saved) {
    cancelSelection()
    activeTool.value = 'cursor'
  }
}

function selectAnnotation(annotation: Annotation) {
  selectedAnnotationId.value = annotation.id
}

function startEditAnnotation(annotation: Annotation) {
  editingAnnotationId.value = annotation.id
  editingAnnotationContent.value = annotation.content
}

function cancelEditAnnotation() {
  editingAnnotationId.value = null
  editingAnnotationContent.value = ''
}

async function saveAnnotationEdit(annotation: Annotation) {
  const content = editingAnnotationContent.value.trim()
  if (!content) {
    notify('批注内容不能为空。', 'info')
    return
  }
  const saved = await execute(`annotation-edit-${annotation.id}`, 'annotation.update', {
    id: annotation.id,
    content,
  }, '批注已更新。')
  if (saved) cancelEditAnnotation()
}

async function presentDeleteConfirm(request: ConfirmRequest) {
  if (document.fullscreenElement === workspaceRef.value) {
    try {
      await document.exitFullscreen()
      await nextTick()
    } catch {
      notify('请先退出全屏，再执行删除操作。', 'info')
      return
    }
  }
  confirmRequest.value = request
  await nextTick()
  confirmButtonRef.value?.focus()
}

function requestAnnotationDelete(annotation: Annotation) {
  void presentDeleteConfirm({
    title: '删除这条批注？',
    message: '批注会从当前评审中移除，相关操作仍保留在系统记录中。',
    confirmLabel: '删除批注',
    danger: true,
    run: async () => {
      const removed = await execute(`annotation-delete-${annotation.id}`, 'annotation.delete', {
        id: annotation.id,
      }, '批注已删除。')
      if (removed && selectedAnnotationId.value === annotation.id) selectedAnnotationId.value = null
    },
  })
}

async function changeStatus(annotation: Annotation, nextValue: string) {
  const value = nextValue as AnnotationStatus
  if (value === annotation.status) return
  await execute(`annotation-status-${annotation.id}`, 'annotation.status', {
    id: annotation.id,
    status: value,
  }, `批注已更新为“${statusLabel(value)}”。`)
}

async function updateAnnotationFromDetail(payload: { content: string; attachments: Annotation['attachments'] }) {
  const annotation = selectedAnnotation.value
  if (!annotation) return
  const saved = await execute(`annotation-edit-${annotation.id}`, 'annotation.update', {
    id: annotation.id,
    content: payload.content,
    attachments: payload.attachments ?? [],
  }, '元素说明已更新。')
  if (saved) detailModalRef.value?.onOperationComplete('annotation')
}

async function createReplyFromDetail(payload: { content: string; attachments: Reply['attachments'] }) {
  const annotation = selectedAnnotation.value
  if (!annotation) return
  const saved = await execute(`reply-create-${annotation.id}`, 'reply.create', {
    annotationId: annotation.id,
    content: payload.content,
    attachments: payload.attachments ?? [],
  }, '回复已发送。')
  if (saved) detailModalRef.value?.onOperationComplete('reply-create')
}

async function updateReplyFromDetail(payload: { replyId: string; content: string; attachments: Reply['attachments'] }) {
  const annotation = selectedAnnotation.value
  if (!annotation) return
  const saved = await execute(`reply-edit-${payload.replyId}`, 'reply.update', {
    annotationId: annotation.id,
    replyId: payload.replyId,
    content: payload.content,
    attachments: payload.attachments ?? [],
  }, '回复已更新。')
  if (saved) detailModalRef.value?.onOperationComplete('reply-update')
}

async function createReply(annotation: Annotation) {
  const content = (replyDrafts.value[annotation.id] ?? '').trim()
  if (!content) {
    notify('请输入回复内容。', 'info')
    return
  }
  const saved = await execute(`reply-create-${annotation.id}`, 'reply.create', {
    annotationId: annotation.id,
    content,
  }, '回复已发送。')
  if (saved) replyDrafts.value = { ...replyDrafts.value, [annotation.id]: '' }
}

function startEditReply(annotation: Annotation, reply: Reply) {
  editingReply.value = { annotationId: annotation.id, replyId: reply.id, content: reply.content }
}

async function saveReplyEdit() {
  const item = editingReply.value
  if (!item) return
  const content = item.content.trim()
  if (!content) {
    notify('回复内容不能为空。', 'info')
    return
  }
  const saved = await execute(`reply-edit-${item.replyId}`, 'reply.update', {
    annotationId: item.annotationId,
    replyId: item.replyId,
    content,
  }, '回复已更新。')
  if (saved) editingReply.value = null
}

function requestReplyDelete(annotation: Annotation, reply: Reply) {
  void presentDeleteConfirm({
    title: '删除这条回复？',
    message: '删除后，该回复将不再出现在批注讨论中。',
    confirmLabel: '删除回复',
    danger: true,
    run: async () => {
      await execute(`reply-delete-${reply.id}`, 'reply.delete', {
        annotationId: annotation.id,
        replyId: reply.id,
      }, '回复已删除。')
    },
  })
}

async function confirmAction() {
  if (!confirmRequest.value || confirmPending.value) return
  confirmPending.value = true
  try {
    await confirmRequest.value.run()
    confirmRequest.value = null
  } finally {
    confirmPending.value = false
  }
}

async function refreshReview() {
  if (pendingKey.value) return
  pendingKey.value = 'refresh'
  try {
    await props.refresh()
    await nextTick()
    if (await renewPreviewCapability()) notify('评审内容已刷新。')
  } catch (error) {
    notify(error instanceof Error ? error.message : '刷新失败，请稍后重试。', 'error')
  } finally {
    pendingKey.value = null
  }
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await workspaceRef.value?.requestFullscreen()
  } catch {
    notify('浏览器未允许进入全屏。', 'error')
  }
}

function handleFullscreenChange() {
  isFullscreen.value = document.fullscreenElement === workspaceRef.value
  if (isFullscreen.value) confirmRequest.value = null
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  if (confirmRequest.value) confirmRequest.value = null
  else if (pendingAnchor.value || dragStart.value) cancelSelection()
  else if (activeTool.value !== 'cursor') setTool('cursor')
}

function handleFrameLoad() {
  const connectedForThisLoad = bridgePortPendingLoad ? bridgePort : null
  bridgeSession += 1
  rejectBridgeRequests('原型页面已完成新一轮导航')
  if (bridgePort && bridgePort !== connectedForThisLoad) closeBridgePort(true)
  bridgePortPendingLoad = false
  bridgeState.value = 'idle'
  frameReady.value = true
  useFallbackCanvas.value = false
  if (frameTimer) window.clearTimeout(frameTimer)
  try {
    const bodyText = frameRef.value?.contentDocument?.body?.textContent?.trim() ?? ''
    if (/^(?:Cannot\s+(?:GET|HEAD)|Not Found)/i.test(bodyText)) useFallbackCanvas.value = true
  } catch {
    // The iframe remains usable if a future deployment serves it from another origin.
  }
  if (useFallbackCanvas.value) {
    detachFrameListeners()
    closeBridgePort(true)
    updateCurrentPageFromHref(prototypeUrl.value)
    scheduleAnchorRecompute()
    return
  }
  const context = frameContext()
  if (context) {
    syncFramePage()
    attachFrameListeners()
  } else {
    detachFrameListeners()
    void ensureBridge().then((ready) => {
      if (ready) scheduleAnchorRecompute()
    })
  }
  scheduleAnchorRecompute()
}

function handleFrameError() {
  detachFrameListeners()
  bridgeSession += 1
  rejectBridgeRequests('原型加载失败')
  closeBridgePort(true)
  frameReady.value = false
  useFallbackCanvas.value = true
  bridgeState.value = 'idle'
  updateCurrentPageFromHref(prototypeUrl.value)
  scheduleAnchorRecompute()
}

function armFrameFallback() {
  detachFrameListeners()
  bridgeSession += 1
  rejectBridgeRequests()
  closeBridgePort(true)
  frameReady.value = false
  useFallbackCanvas.value = false
  frameAccessLimited.value = false
  bridgeState.value = 'idle'
  legacyFallbackPageKey.value = ''
  currentPageKey.value = pageKeyFromUrl(prototypeUrl.value)
  anchorPositions.value = new Map()
  if (frameTimer) window.clearTimeout(frameTimer)
  frameTimer = window.setTimeout(() => {
    if (!frameReady.value) {
      useFallbackCanvas.value = true
      legacyFallbackPageKey.value = currentPageKey.value
      scheduleAnchorRecompute()
    }
  }, 5000)
}

function validatedCapabilityUrl(value: string, productId: string, version: string) {
  const url = new URL(value, window.location.origin)
  const parts = url.pathname.split('/')
  if (url.origin !== window.location.origin || url.username || url.password || url.search || url.hash) {
    throw new Error('服务端返回的安全预览地址不正确')
  }
  if (parts.length < 6 || parts[1] !== 'prototype-cap' || !parts[2] || !parts[5]) {
    throw new Error('服务端返回的安全预览地址不正确')
  }
  if (decodeURIComponent(parts[3]) !== productId || decodeURIComponent(parts[4]) !== version) {
    throw new Error('服务端返回的安全预览范围不正确')
  }
  return url.href
}

async function renewPreviewCapability() {
  const requestSequence = ++capabilityRequestSequence
  const productId = props.product.id
  const version = selectedVersion.value
  previewUrl.value = ''
  capabilityLoading.value = true
  armFrameFallback()
  if (!version || !selectedVersionRecord.value) {
    if (frameTimer) window.clearTimeout(frameTimer)
    capabilityLoading.value = false
    useFallbackCanvas.value = true
    legacyFallbackPageKey.value = currentPageKey.value
    notify('当前版本没有可加载的原型文件。', 'error')
    return false
  }
  try {
    const capability = await issuePrototypeCapability(productId, version)
    if (requestSequence !== capabilityRequestSequence
      || productId !== props.product.id
      || version !== selectedVersion.value) return false
    previewUrl.value = validatedCapabilityUrl(capability.url, productId, version)
    capabilityLoading.value = false
    return true
  } catch (error) {
    if (requestSequence !== capabilityRequestSequence) return false
    if (frameTimer) window.clearTimeout(frameTimer)
    capabilityLoading.value = false
    useFallbackCanvas.value = true
    legacyFallbackPageKey.value = currentPageKey.value
    notify(error instanceof Error ? error.message : '无法建立安全预览，请稍后重试。', 'error')
    return false
  }
}

function bubbleStyle(annotation: Annotation) {
  const position = anchorPositions.value.get(annotation.id)
  if (!position) return undefined
  return { left: `${position.x}px`, top: `${position.y}px` }
}

function regionStyle(annotation: Annotation) {
  const position = anchorPositions.value.get(annotation.id)
  if (!position) return undefined
  return {
    left: `${position.x}px`,
    top: `${position.y}px`,
    width: `${position.width ?? 0}px`,
    height: `${position.height ?? 0}px`,
  }
}

watch(
  () => [props.product.id, props.product.currentVersion] as const,
  ([id, current], previous) => {
    if (!previous || previous[0] !== id || !props.product.versions.some((item) => item.version === selectedVersion.value)) {
      selectedVersion.value = current
    }
    selectedAnnotationId.value = null
    setTool('cursor')
  },
  { immediate: true },
)

watch(selectedVersion, () => {
  selectedAnnotationId.value = null
  activeFilter.value = 'open'
  setTool('cursor')
})

watch(
  [() => props.product.id, selectedVersion, prototypeUrl],
  () => { void renewPreviewCapability() },
  { immediate: true },
)

watch(pageAnnotations, scheduleAnchorRecompute, { flush: 'post' })

watch(isHistorical, (historical) => {
  if (historical) setTool('cursor')
})

onBeforeMount(() => {
  window.addEventListener('message', handleBridgeConnect)
})

onMounted(() => {
  document.addEventListener('fullscreenchange', handleFullscreenChange)
  window.addEventListener('keydown', handleKeydown)
  window.addEventListener('resize', scheduleAnchorRecompute, { passive: true })
  anchorResizeObserver = new ResizeObserver(scheduleAnchorRecompute)
  frameHrefTimer = window.setInterval(syncFramePage, 500)
  scheduleAnchorRecompute()
})

onBeforeUnmount(() => {
  capabilityRequestSequence += 1
  detachFrameListeners()
  bridgeSession += 1
  rejectBridgeRequests('评审页面已关闭')
  closeBridgePort(true)
  document.removeEventListener('fullscreenchange', handleFullscreenChange)
  window.removeEventListener('keydown', handleKeydown)
  window.removeEventListener('message', handleBridgeConnect)
  window.removeEventListener('resize', scheduleAnchorRecompute)
  if (frameTimer) window.clearTimeout(frameTimer)
  if (toastTimer) window.clearTimeout(toastTimer)
  if (frameHrefTimer) window.clearInterval(frameHrefTimer)
  if (positionFrame) window.cancelAnimationFrame(positionFrame)
  anchorResizeObserver?.disconnect()
})
</script>

<template>
  <section ref="workspaceRef" class="review-workspace" :class="{ 'is-fullscreen': isFullscreen }">
    <header class="review-toolbar glass-surface">
      <button class="icon-button back-button" type="button" title="返回产品详情" @click="emit('back')">
        <ArrowLeft :size="18" aria-hidden="true" />
        <span>产品详情</span>
      </button>

      <div class="product-identity">
        <span class="product-mark" aria-hidden="true">{{ product.name.slice(0, 1) }}</span>
        <div class="identity-copy">
          <strong>{{ product.name }}</strong>
          <UiSelect v-model="selectedVersion" class="version-picker-ui" :options="versionOptions" size="sm" aria-label="切换评审版本" />
        </div>
      </div>

      <div class="toolbar-divider" aria-hidden="true"></div>
      <div class="toolbar-spacer"></div>

      <div class="tool-segment" aria-label="评审批注工具">
        <button
          v-for="option in toolOptions"
          :key="option.value"
          class="tool-button"
          :class="{ 'is-active': activeTool === option.value }"
          type="button"
          :aria-pressed="activeTool === option.value"
          :title="isHistorical && option.value !== 'cursor' ? '历史版本仅支持查看' : option.hint"
          :disabled="isHistorical && option.value !== 'cursor'"
          @click="setTool(option.value)"
        >
          <MousePointer2 v-if="option.value === 'cursor'" :size="17" aria-hidden="true" />
          <MessageSquarePlus v-else-if="option.value === 'comment'" :size="17" aria-hidden="true" />
          <Scan v-else :size="17" aria-hidden="true" />
          <span>{{ option.label }}</span>
        </button>
      </div>

      <button
        class="tool-button utility-button"
        type="button"
        :aria-pressed="showBubbles"
        :title="showBubbles ? '隐藏全部批注气泡' : '显示全部批注气泡'"
        @click="showBubbles = !showBubbles"
      >
        <Eye v-if="showBubbles" :size="17" aria-hidden="true" />
        <EyeOff v-else :size="17" aria-hidden="true" />
        <span>{{ showBubbles ? '隐藏气泡' : '显示气泡' }}</span>
      </button>
      <button
        class="icon-button"
        type="button"
        title="刷新评审内容"
        :disabled="pendingKey === 'refresh'"
        @click="refreshReview"
      >
        <LoaderCircle v-if="pendingKey === 'refresh'" class="spin" :size="18" aria-hidden="true" />
        <RefreshCw v-else :size="18" aria-hidden="true" />
        <span class="sr-only">刷新</span>
      </button>
      <button class="icon-button" type="button" :title="isFullscreen ? '退出全屏' : '进入全屏'" @click="toggleFullscreen">
        <Minimize2 v-if="isFullscreen" :size="18" aria-hidden="true" />
        <Maximize2 v-else :size="18" aria-hidden="true" />
        <span class="sr-only">{{ isFullscreen ? '退出全屏' : '进入全屏' }}</span>
      </button>
    </header>

    <div class="review-stage">
      <main class="prototype-pane">
        <div ref="surfaceRef" class="prototype-surface">
          <iframe
            v-if="previewUrl"
            v-show="!useFallbackCanvas"
            ref="frameRef"
            class="prototype-frame"
            :src="previewUrl"
            :title="`${product.name} ${selectedVersion} 原型`"
            @load="handleFrameLoad"
            @error="handleFrameError"
          ></iframe>

          <div v-if="capabilityLoading && !useFallbackCanvas" class="preview-loading" role="status">
            <LoaderCircle class="spin" :size="22" aria-hidden="true" />
            <span>正在建立安全预览</span>
          </div>

          <div v-if="useFallbackCanvas" class="fallback-prototype" aria-label="内置原型预览画布">
            <aside class="fallback-sidebar">
              <div class="fallback-logo">P</div>
              <span v-for="item in 5" :key="item" :class="{ active: item === 2 }"></span>
            </aside>
            <div class="fallback-page">
              <div class="fallback-topline">
                <div><small>PRODUCT SPACE</small><h2>{{ product.name }}</h2></div>
                <span class="fallback-avatar">{{ initials(currentUser.id) }}</span>
              </div>
              <div class="fallback-banner">
                <div><span>评审中的版本</span><strong>{{ selectedVersion }}</strong></div>
                <button type="button" tabindex="-1">查看发布说明</button>
              </div>
              <div class="fallback-metrics">
                <article><span>流程完成度</span><strong>76%</strong><i style="--meter: 76%"></i></article>
                <article><span>待确认交互</span><strong>12</strong><em>较上轮 -3</em></article>
                <article><span>本轮评审人</span><strong>{{ product.members.length + 1 }}</strong><em>协同评审中</em></article>
              </div>
              <div class="fallback-content">
                <article class="fallback-chart">
                  <div><strong>核心流程覆盖</strong><span>近 7 个版本</span></div>
                  <div class="chart-bars"><i v-for="height in [38, 52, 45, 68, 61, 82, 76]" :key="height" :style="{ height: `${height}%` }"></i></div>
                </article>
                <article class="fallback-list">
                  <strong>最近更新</strong>
                  <p v-for="(line, index) in ['完成关键路径串联', '优化异常状态提示', '补齐版本回退说明']" :key="line">
                    <span>{{ index + 1 }}</span>{{ line }}<time>今天</time>
                  </p>
                </article>
              </div>
            </div>
          </div>

          <div
            class="selection-layer"
            :class="{ 'is-selecting': activeTool !== 'cursor' && !isHistorical }"
            @pointerdown="handlePointerDown"
            @pointermove="handlePointerMove"
            @pointerup="finishSelection"
            @pointercancel="cancelSelection"
          ></div>

          <div v-if="dragRect" class="drag-selection" :style="dragRect"></div>

          <div
            v-if="pendingAnchor"
            class="pending-anchor-trace"
            :class="pendingAnchor.kind === 'region' ? 'is-region' : 'is-point'"
            :style="pendingTraceStyle"
            aria-hidden="true"
          ><span v-if="pendingAnchor.kind === 'region'">待保存</span></div>

          <div v-if="showBubbles" ref="overlayRef" class="annotation-overlay">
            <div
              v-for="annotation in positionedAnnotations"
              :key="`anchor-${annotation.id}`"
              class="annotation-anchor"
            >
              <button
                v-if="annotation.anchor.kind === 'point'"
                class="annotation-bubble"
                :class="[
                  statusMeta[annotation.status].className,
                  { 'is-selected': selectedAnnotationId === annotation.id },
                ]"
                :style="bubbleStyle(annotation)"
                type="button"
                :aria-label="`批注 ${bubbleNumbers.get(annotation.id)}：${annotation.content}`"
                @click="selectAnnotation(annotation)"
              >
                {{ bubbleNumbers.get(annotation.id) }}
              </button>
              <button
                v-else
                class="annotation-region"
                :class="[
                  statusMeta[annotation.status].className,
                  { 'is-selected': selectedAnnotationId === annotation.id },
                ]"
                :style="regionStyle(annotation)"
                type="button"
                :aria-label="`区域批注 ${bubbleNumbers.get(annotation.id)}：${annotation.content}`"
                @click="selectAnnotation(annotation)"
              >
                <span>{{ bubbleNumbers.get(annotation.id) }}</span>
              </button>
            </div>
          </div>

          <form
            v-if="pendingAnchor"
            class="annotation-composer glass-surface"
            :style="composerStyle"
            @submit.prevent="createAnnotation"
          >
            <div class="composer-head">
              <span class="composer-avatar">{{ initials(currentUser.id) }}</span>
              <strong>添加批注</strong>
              <button type="button" title="取消" @click="cancelSelection"><X :size="16" /></button>
            </div>
            <textarea
              ref="composerRef"
              v-model="pendingContent"
              rows="3"
              maxlength="1000"
              placeholder="说清楚问题、影响和建议…"
              aria-label="批注内容"
            ></textarea>
            <div class="composer-actions">
              <span>{{ pendingContent.length }}/1000</span>
              <button type="submit" :disabled="!pendingContent.trim() || pendingKey === 'annotation-create'">
                <LoaderCircle v-if="pendingKey === 'annotation-create'" class="spin" :size="15" />
                <Send v-else :size="15" />
                保存批注
              </button>
            </div>
          </form>

          <div v-if="isHistorical" class="history-notice glass-surface">
            <CircleDotDashed :size="16" aria-hidden="true" />
            历史版本只读，可查看当时未解决及已完成批注
          </div>

          <div v-if="coordinateOnlyMode" class="frame-access-notice glass-surface">
            <MapPinOff :size="16" aria-hidden="true" />
            当前原型未提供安全定位 bridge，仅支持坐标批注
          </div>

        </div>
      </main>
    </div>

    <AnnotationDetailModal
      v-if="selectedAnnotation"
      ref="detailModalRef"
      :annotation="selectedAnnotation"
      :number="bubbleNumbers.get(selectedAnnotation.id) ?? 1"
      :users="state.users"
      :current-user="currentUser"
      :historical="isHistorical"
      :responsible="isResponsible"
      :pending-key="pendingKey"
      @close="selectedAnnotationId = null"
      @notify="notify"
      @update="updateAnnotationFromDetail"
      @status="changeStatus(selectedAnnotation, $event)"
      @delete="requestAnnotationDelete(selectedAnnotation)"
      @create-reply="createReplyFromDetail"
      @update-reply="updateReplyFromDetail"
      @delete-reply="requestReplyDelete(selectedAnnotation, $event)"
    />

    <Transition name="toast">
      <div v-if="toast" class="toast" :class="`is-${toast.kind}`" role="status" aria-live="polite">
        <Check v-if="toast.kind === 'success'" :size="17" aria-hidden="true" />
        <CircleDotDashed v-else-if="toast.kind === 'info'" :size="17" aria-hidden="true" />
        <X v-else :size="17" aria-hidden="true" />
        {{ toast.message }}
      </div>
    </Transition>

    <Teleport to="body">
      <div v-if="confirmRequest && !isFullscreen" class="confirm-backdrop" @mousedown.self="confirmRequest = null">
        <section class="confirm-dialog glass-surface" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
          <div class="confirm-icon" :class="{ danger: confirmRequest.danger }">
            <Trash2 v-if="confirmRequest.danger" :size="20" aria-hidden="true" />
            <CircleDotDashed v-else :size="20" aria-hidden="true" />
          </div>
          <h2 id="confirm-title">{{ confirmRequest.title }}</h2>
          <p>{{ confirmRequest.message }}</p>
          <div class="confirm-actions">
            <button type="button" :disabled="confirmPending" @click="confirmRequest = null">取消</button>
            <button
              ref="confirmButtonRef"
              type="button"
              :class="{ danger: confirmRequest.danger }"
              :disabled="confirmPending"
              @click="confirmAction"
            >
              <LoaderCircle v-if="confirmPending" class="spin" :size="15" />
              {{ confirmRequest.confirmLabel }}
            </button>
          </div>
        </section>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.review-workspace {
  --ink: #182238;
  --muted: #68738c;
  --line: rgba(117, 131, 165, .18);
  --glass: rgba(255, 255, 255, .78);
  --primary: #4f5cf6;
  --primary-deep: #3947dc;
  --success: #16856a;
  --warning: #c57a16;
  --danger: #d33d52;
  position: relative;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  width: 100%;
  /* App 顶栏 68px + 页面上下各 16px，避免工作区随页面滚动到粘性顶栏下方。 */
  height: calc(100vh - 100px);
  height: calc(100dvh - 100px);
  min-height: 560px;
  overflow: hidden;
  color: var(--ink);
  border: 1px solid rgba(255, 255, 255, .84);
  border-radius: 24px;
  background: rgba(232, 237, 247, .76);
  box-shadow: 0 24px 70px rgba(57, 67, 111, .14), inset 0 1px 0 rgba(255, 255, 255, .9);
}

.review-workspace.is-fullscreen {
  height: 100vh;
  height: 100dvh;
  min-height: 100vh;
  min-height: 100dvh;
  border: 0;
  border-radius: 0;
}

.glass-surface {
  border: 1px solid rgba(255, 255, 255, .78);
  background: var(--glass);
  box-shadow: 0 12px 36px rgba(55, 67, 112, .1), inset 0 1px 0 rgba(255, 255, 255, .86);
  backdrop-filter: blur(20px) saturate(135%);
}

.review-toolbar {
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: 64px;
  padding: 9px 12px;
  border-width: 0 0 1px;
  border-radius: 0;
}

button, select, textarea { font: inherit; }
button { color: inherit; }
button:focus-visible, select:focus-visible, textarea:focus-visible {
  outline: 3px solid rgba(79, 92, 246, .28);
  outline-offset: 2px;
}

.icon-button, .tool-button, .back-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 40px;
  border: 1px solid transparent;
  border-radius: 12px;
  background: transparent;
  color: #59647c;
  transition: color .18s ease, background .18s ease, border-color .18s ease, transform .18s ease;
}

.icon-button { width: 40px; padding: 0; }
.back-button { width: auto; padding: 0 12px; font-size: 13px; font-weight: 700; }
.icon-button:hover, .tool-button:hover, .back-button:hover { background: rgba(255,255,255,.76); color: var(--ink); }
.icon-button:active, .tool-button:active { transform: translateY(1px); }
.icon-button:disabled, .tool-button:disabled { cursor: not-allowed; opacity: .45; }

.product-identity { display: flex; align-items: center; gap: 10px; min-width: 210px; max-width: 300px; padding: 0 8px; }
.product-mark {
  display: grid;
  flex: 0 0 38px;
  width: 38px;
  height: 38px;
  place-items: center;
  border-radius: 13px;
  background: #5361f1;
  color: white;
  font-weight: 800;
  box-shadow: 0 8px 18px rgba(79, 92, 246, .25);
}
.identity-copy { min-width: 0; }
.identity-copy > strong { display: block; overflow: hidden; font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
.version-picker-ui { min-width: 178px; max-width: 210px; margin-top: 3px; }
.toolbar-divider { width: 1px; height: 28px; margin: 0 4px; background: var(--line); }
.toolbar-spacer { flex: 1; min-width: 8px; }

.tool-segment { display: inline-flex; gap: 3px; padding: 3px; border: 1px solid rgba(123,135,166,.13); border-radius: 14px; background: rgba(232,236,246,.72); }
.tool-button { min-width: 70px; padding: 0 11px; font-size: 12px; font-weight: 700; }
.tool-button.is-active { border-color: rgba(79, 92, 246, .16); background: white; color: var(--primary-deep); box-shadow: 0 5px 14px rgba(61, 71, 126, .1); }
.utility-button { min-width: auto; }

.review-stage { position: relative; display: block; min-height: 0; }
.review-stage.drawer-is-open { grid-template-columns: none; }
.prototype-pane { width: 100%; height: 100%; min-width: 0; min-height: 0; padding: 12px; }
.prototype-surface { position: relative; width: 100%; height: 100%; min-height: 0; overflow: hidden; border: 1px solid rgba(135,147,177,.19); border-radius: 18px; background: white; box-shadow: 0 8px 28px rgba(60,71,111,.08); }
.prototype-frame { display: block; width: 100%; height: 100%; border: 0; background: white; }
.preview-loading { position: absolute; inset: 0; display: grid; place-content: center; justify-items: center; gap: 10px; color: #66708a; font-size: 12px; font-weight: 700; background: linear-gradient(145deg, #fff, #f7f8fc); }

.selection-layer { position: absolute; z-index: 5; inset: 0; pointer-events: none; }
.selection-layer.is-selecting { cursor: crosshair; pointer-events: auto; background: rgba(79, 92, 246, .018); }
.drag-selection { position: absolute; z-index: 7; border: 2px solid var(--primary); border-radius: 8px; background: rgba(79, 92, 246, .12); box-shadow: 0 0 0 9999px rgba(34, 43, 74, .08); pointer-events: none; }
.pending-anchor-trace { position: absolute; z-index: 10; pointer-events: none; }
.pending-anchor-trace.is-point { width: 32px; height: 32px; transform: translate(-50%, -50%); border: 3px solid white; border-radius: 999px; background: var(--primary); box-shadow: 0 0 0 5px rgba(79,92,246,.2), 0 8px 22px rgba(53,65,164,.34); }
.pending-anchor-trace.is-point::after { content: "+"; display: grid; height: 100%; place-items: center; color: white; font-size: 18px; font-weight: 800; }
.pending-anchor-trace.is-region { min-width: 18px; min-height: 18px; border: 2px solid var(--primary); border-radius: 9px; background: rgba(79,92,246,.14); box-shadow: 0 0 0 4px rgba(79,92,246,.12); }
.pending-anchor-trace.is-region span { position: absolute; top: -30px; left: 0; padding: 4px 8px; border-radius: 8px; background: var(--primary-deep); color: white; font-size: 10px; font-weight: 750; white-space: nowrap; }

.annotation-overlay { position: absolute; z-index: 9; inset: 0; overflow: hidden; pointer-events: none; }
.annotation-anchor { position: absolute; inset: 0; pointer-events: none; }
.annotation-bubble {
  position: absolute;
  display: grid;
  width: 28px;
  height: 28px;
  padding: 0;
  place-items: center;
  transform: translate(-50%, -50%);
  border: 2px solid white;
  border-radius: 999px;
  background: var(--primary);
  color: white;
  font-size: 12px;
  font-weight: 800;
  box-shadow: 0 7px 18px rgba(53, 65, 164, .34);
  pointer-events: auto;
  transition: transform .18s ease, box-shadow .18s ease;
}
.annotation-bubble::after { content: ""; position: absolute; inset: -6px; border: 1px solid rgba(79,92,246,.24); border-radius: inherit; }
.annotation-bubble:hover, .annotation-bubble.is-selected { transform: translate(-50%, -50%) scale(1.13); box-shadow: 0 10px 24px rgba(53,65,164,.4); }
.annotation-bubble.is-resolved { background: var(--success); }
.annotation-bubble.is-relocation { background: var(--warning); }

.annotation-region { position: absolute; padding: 0; border: 2px solid var(--primary); border-radius: 8px; background: rgba(79,92,246,.1); pointer-events: auto; }
.annotation-region > span { position: absolute; top: -14px; left: -14px; display: grid; width: 28px; height: 28px; place-items: center; border: 2px solid white; border-radius: 50%; background: var(--primary); color: white; font-size: 12px; font-weight: 800; box-shadow: 0 7px 18px rgba(53,65,164,.3); }
.annotation-region.is-resolved { border-color: var(--success); background: rgba(22,133,106,.08); }
.annotation-region.is-resolved > span { background: var(--success); }
.annotation-region.is-relocation { border-color: var(--warning); border-style: dashed; background: rgba(197,122,22,.08); }
.annotation-region.is-relocation > span { background: var(--warning); }
.annotation-region.is-selected { box-shadow: 0 0 0 4px rgba(79,92,246,.16); }

.annotation-composer { position: absolute; z-index: 14; width: min(330px, 42%); min-width: 280px; overflow: hidden; border-radius: 17px; transform: translate(10px, 10px); }
.composer-head { display: flex; align-items: center; gap: 9px; padding: 12px 13px 8px; }
.composer-head strong { flex: 1; font-size: 13px; }
.composer-head button { display: grid; width: 28px; height: 28px; padding: 0; place-items: center; border: 0; border-radius: 8px; background: transparent; color: var(--muted); }
.composer-head button:hover { background: rgba(104,115,140,.1); }
.composer-avatar, .reply-avatar { display: grid; flex: 0 0 28px; width: 28px; height: 28px; place-items: center; border-radius: 10px; background: #e7eaff; color: var(--primary-deep); font-size: 10px; font-weight: 800; }
.annotation-composer textarea { display: block; width: calc(100% - 24px); margin: 0 12px; padding: 10px 11px; resize: vertical; border: 1px solid rgba(115,128,160,.2); border-radius: 11px; background: rgba(255,255,255,.78); color: var(--ink); font-size: 13px; line-height: 1.55; }
.composer-actions { display: flex; align-items: center; justify-content: space-between; padding: 9px 12px 12px; }
.composer-actions > span { color: #9299aa; font-size: 10px; }
.composer-actions button { display: inline-flex; align-items: center; gap: 6px; min-height: 34px; padding: 0 12px; border: 0; border-radius: 10px; background: var(--primary); color: white; font-size: 12px; font-weight: 750; box-shadow: 0 7px 16px rgba(79,92,246,.24); }
.composer-actions button:disabled { opacity: .5; cursor: not-allowed; }

.history-notice { position: absolute; z-index: 8; top: 14px; left: 50%; display: flex; align-items: center; gap: 7px; padding: 8px 12px; transform: translateX(-50%); border-radius: 999px; color: #59647c; font-size: 11px; font-weight: 650; pointer-events: none; }
.frame-access-notice { position: absolute; z-index: 8; bottom: 15px; left: 50%; display: flex; align-items: center; gap: 7px; padding: 8px 12px; transform: translateX(-50%); border-radius: 999px; color: #8a5a17; font-size: 11px; font-weight: 700; pointer-events: none; }
.drawer-peek { position: absolute; z-index: 16; top: 15px; right: 15px; display: flex; align-items: center; gap: 7px; min-height: 38px; padding: 0 12px; border-radius: 13px; color: #566079; font-size: 12px; font-weight: 750; opacity: .66; transition: opacity .18s ease, transform .18s ease, background .18s ease; }
.drawer-peek:hover, .drawer-peek:focus-visible { opacity: 1; transform: translateY(-1px); background: white; }
.drawer-peek b { display: grid; min-width: 20px; height: 20px; padding: 0 5px; place-items: center; border-radius: 999px; background: var(--primary); color: white; font-size: 10px; }

.annotation-drawer { position: absolute; z-index: 18; top: 12px; right: 12px; bottom: 12px; display: grid; width: min(390px, calc(100% - 24px)); grid-template-rows: auto auto minmax(0, 1fr); min-width: 0; min-height: 0; margin: 0; overflow: hidden; border-color: rgba(207,214,232,.8); border-radius: 18px; background: rgba(250,252,255,.94); box-shadow: 0 20px 55px rgba(40,51,91,.18), inset 0 1px 0 white; }
.drawer-topline { display: flex; align-items: center; min-height: 58px; padding: 9px 10px 8px 15px; border-bottom: 1px solid var(--line); }
.drawer-summary { display: flex; flex: 1; align-items: baseline; gap: 8px; }
.drawer-summary > span { font-size: 13px; font-weight: 800; }
.drawer-summary small { max-width: 220px; overflow: hidden; color: #8992a7; font-family: "Cascadia Mono", Consolas, monospace; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.filter-tabs { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; padding: 9px 10px; border-bottom: 1px solid var(--line); }
.filter-tabs button { min-width: 0; min-height: 36px; padding: 0 5px; border: 1px solid transparent; border-radius: 10px; background: transparent; color: #727d93; font-size: 11px; font-weight: 700; white-space: nowrap; }
.filter-tabs button span { margin-left: 2px; color: #a1a8b8; font-size: 9px; }
.filter-tabs button:hover { background: rgba(238,241,248,.8); color: var(--ink); }
.filter-tabs button.is-active { border-color: rgba(79,92,246,.13); background: #eef0ff; color: var(--primary-deep); }
.filter-tabs button.is-active span { color: var(--primary); }

.annotation-scroll { min-height: 0; padding: 10px; overflow: auto; scrollbar-width: thin; scrollbar-color: rgba(110,121,150,.28) transparent; }
.annotation-card { margin-bottom: 9px; padding: 12px; border: 1px solid rgba(119,132,163,.16); border-radius: 15px; background: rgba(255,255,255,.64); box-shadow: 0 5px 16px rgba(68,78,119,.045); cursor: pointer; transition: border-color .18s ease, background .18s ease, transform .18s ease; }
.annotation-card:hover { border-color: rgba(79,92,246,.24); background: rgba(255,255,255,.9); transform: translateY(-1px); }
.annotation-card.is-selected { border-color: rgba(79,92,246,.42); background: white; box-shadow: 0 9px 24px rgba(67,77,126,.09); }
.annotation-card-head { display: flex; align-items: center; gap: 8px; }
.number-dot { display: grid; flex: 0 0 25px; width: 25px; height: 25px; place-items: center; border-radius: 50%; background: var(--primary); color: white; font-size: 10px; font-weight: 800; }
.annotation-author { min-width: 0; flex: 1; }
.annotation-author strong, .annotation-author time { display: block; }
.annotation-author strong { overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.annotation-author time { margin-top: 1px; color: #949cad; font-size: 9px; }
.status-pill { padding: 4px 7px; border-radius: 999px; background: #fff3dc; color: #aa6612; font-size: 9px; font-weight: 800; }
.status-pill.is-open { background: #eef0ff; color: #4553d6; }
.status-pill.is-resolved { background: #e7f6f1; color: #13745d; }
.status-pill.is-relocation { background: #fff1dc; color: #aa6612; }
.annotation-content { margin: 10px 2px 8px; color: #39435a; font-size: 12px; line-height: 1.65; white-space: pre-wrap; }
.annotation-context { display: flex; align-items: center; gap: 7px; color: #9098aa; font-size: 9px; }
.annotation-context span + span::before { content: "·"; margin-right: 7px; }
.annotation-context .missing-anchor { display: inline-flex; align-items: center; gap: 3px; color: #b16a11; font-weight: 750; }

.annotation-detail { margin-top: 11px; padding-top: 10px; border-top: 1px solid var(--line); }
.annotation-commands { display: flex; align-items: center; gap: 5px; margin-bottom: 9px; }
.annotation-commands button { display: inline-flex; align-items: center; gap: 4px; min-height: 29px; padding: 0 8px; border: 0; border-radius: 8px; background: #f2f4f9; color: #69748b; font-size: 10px; font-weight: 700; }
.annotation-commands button:hover { background: #e9ecf4; color: var(--ink); }
.annotation-commands .danger-text { margin-left: auto; color: var(--danger); }
.status-select-ui { min-width: 108px; }

.inline-edit textarea, .reply-edit textarea { width: 100%; padding: 8px 9px; resize: vertical; border: 1px solid rgba(79,92,246,.28); border-radius: 9px; background: white; color: var(--ink); font-size: 12px; line-height: 1.5; }
.inline-edit > div, .reply-edit > div { display: flex; justify-content: flex-end; gap: 5px; margin-top: 5px; }
.inline-edit button, .reply-edit button { min-height: 28px; padding: 0 8px; border: 0; border-radius: 8px; background: #eef1f6; color: #677188; font-size: 10px; font-weight: 700; }
.inline-edit .primary-small, .reply-edit button[type="submit"] { background: var(--primary); color: white; }

.reply-thread { display: grid; gap: 9px; margin: 8px 0 10px; }
.reply-item { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 8px; }
.reply-item > div { min-width: 0; padding: 8px 9px; border-radius: 10px; background: #f5f6fa; }
.reply-meta { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.reply-meta strong { font-size: 10px; }
.reply-meta time { color: #9ba2b1; font-size: 8px; }
.reply-item p { margin: 5px 0 0; color: #4d576c; font-size: 11px; line-height: 1.55; white-space: pre-wrap; }
.reply-actions { display: flex; gap: 8px; margin-top: 5px; }
.reply-actions button { padding: 0; border: 0; background: transparent; color: #7b8498; font-size: 9px; }
.reply-actions button:hover { color: var(--primary); }
.reply-composer { display: grid; grid-template-columns: 28px minmax(0, 1fr) 30px; gap: 7px; align-items: end; }
.reply-composer textarea { min-height: 34px; max-height: 100px; padding: 8px 9px; resize: vertical; border: 1px solid rgba(119,132,163,.18); border-radius: 10px; background: #f7f8fb; color: var(--ink); font-size: 11px; line-height: 1.45; }
.reply-composer button { display: grid; width: 30px; height: 30px; padding: 0; place-items: center; border: 0; border-radius: 9px; background: var(--primary); color: white; }
.reply-composer button:disabled { background: #c9cedc; cursor: not-allowed; }
.reply-avatar.current { background: #e7eaff; }

.drawer-empty { display: grid; min-height: 260px; padding: 38px 28px; place-items: center; align-content: center; text-align: center; color: #929aac; }
.drawer-empty svg { margin-bottom: 10px; color: #8490c8; }
.drawer-empty strong { color: #505b73; font-size: 13px; }
.drawer-empty p { max-width: 250px; margin: 6px 0 0; font-size: 11px; line-height: 1.6; }

.fallback-prototype { position: absolute; inset: 0; display: grid; grid-template-columns: 64px minmax(0, 1fr); overflow: hidden; background: #f7f8fb; }
.fallback-sidebar { display: flex; flex-direction: column; align-items: center; gap: 18px; padding: 20px 0; background: #1f2941; }
.fallback-logo { display: grid; width: 32px; height: 32px; margin-bottom: 8px; place-items: center; border-radius: 10px; background: #6874ff; color: white; font-weight: 900; }
.fallback-sidebar > span { width: 25px; height: 25px; border-radius: 8px; background: rgba(255,255,255,.1); }
.fallback-sidebar > span.active { background: #6572ff; box-shadow: 0 6px 16px rgba(84,98,255,.35); }
.fallback-page { min-width: 0; padding: 28px 34px; overflow: auto; }
.fallback-topline { display: flex; align-items: center; justify-content: space-between; }
.fallback-topline small { color: #9ca4b5; font-size: 9px; font-weight: 800; letter-spacing: .16em; }
.fallback-topline h2 { margin: 4px 0 0; color: #202b43; font-size: clamp(19px, 2.2vw, 28px); }
.fallback-avatar { display: grid; width: 38px; height: 38px; place-items: center; border-radius: 13px; background: #e7eaff; color: #4c59dd; font-size: 11px; font-weight: 800; }
.fallback-banner { display: flex; align-items: center; justify-content: space-between; margin-top: 24px; padding: 18px 20px; border-radius: 16px; background: #283653; color: white; box-shadow: 0 12px 28px rgba(35,49,82,.16); }
.fallback-banner span, .fallback-banner strong { display: block; }
.fallback-banner span { color: #acb6d2; font-size: 10px; }
.fallback-banner strong { margin-top: 4px; font-family: "Cascadia Mono", monospace; font-size: 15px; }
.fallback-banner button { min-height: 34px; padding: 0 12px; border: 1px solid rgba(255,255,255,.18); border-radius: 9px; background: rgba(255,255,255,.08); color: white; font-size: 10px; }
.fallback-metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-top: 16px; }
.fallback-metrics article { position: relative; min-height: 112px; padding: 16px; overflow: hidden; border: 1px solid #edf0f5; border-radius: 15px; background: white; box-shadow: 0 7px 20px rgba(63,73,110,.05); }
.fallback-metrics span, .fallback-metrics strong, .fallback-metrics em { display: block; }
.fallback-metrics span { color: #8a94a8; font-size: 10px; }
.fallback-metrics strong { margin-top: 9px; color: #27324a; font-size: 23px; }
.fallback-metrics em { margin-top: 8px; color: #658070; font-size: 9px; font-style: normal; }
.fallback-metrics i { position: absolute; right: 16px; bottom: 17px; left: 16px; height: 4px; border-radius: 4px; background: #edf0f6; }
.fallback-metrics i::after { content: ""; display: block; width: var(--meter); height: 100%; border-radius: inherit; background: #6370f3; }
.fallback-content { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(240px, .75fr); gap: 14px; margin-top: 14px; }
.fallback-content article { min-height: 230px; padding: 17px; border: 1px solid #edf0f5; border-radius: 15px; background: white; box-shadow: 0 7px 20px rgba(63,73,110,.05); }
.fallback-chart > div:first-child { display: flex; justify-content: space-between; color: #27324a; font-size: 11px; }
.fallback-chart > div:first-child span { color: #929bac; font-size: 9px; }
.chart-bars { display: flex; height: 150px; align-items: end; gap: 8%; padding: 22px 10px 0; border-bottom: 1px solid #eef1f6; }
.chart-bars i { flex: 1; min-width: 8px; border-radius: 6px 6px 2px 2px; background: #7180f6; opacity: .78; }
.fallback-list > strong { font-size: 11px; }
.fallback-list p { display: grid; grid-template-columns: 22px minmax(0,1fr) auto; gap: 8px; align-items: center; margin: 13px 0; color: #586279; font-size: 9px; }
.fallback-list p > span { display: grid; width: 22px; height: 22px; place-items: center; border-radius: 7px; background: #f0f2fb; color: #5764df; font-weight: 800; }
.fallback-list time { color: #a0a7b5; }

.toast { position: absolute; z-index: 40; right: 18px; bottom: 18px; display: flex; align-items: center; gap: 8px; max-width: 420px; min-height: 42px; padding: 0 14px; border: 1px solid rgba(255,255,255,.8); border-radius: 13px; background: rgba(26,36,58,.9); color: white; box-shadow: 0 14px 34px rgba(29,38,67,.25); backdrop-filter: blur(18px); font-size: 12px; font-weight: 650; }
.toast.is-success svg { color: #75dfbf; }
.toast.is-info svg { color: #b7c0ff; }
.toast.is-error svg { color: #ff9cad; }
.toast-enter-active, .toast-leave-active { transition: opacity .2s ease, transform .2s ease; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateY(8px); }

.confirm-backdrop { position: fixed; z-index: 200; inset: 0; display: grid; padding: 24px; place-items: center; background: rgba(25,34,55,.42); backdrop-filter: blur(7px); }
.confirm-dialog { width: min(430px, 100%); padding: 26px; border: 1px solid rgba(203,213,225,.9) !important; border-radius: 22px; background: #fff !important; color: #172033 !important; box-shadow: 0 28px 80px rgba(20,28,48,.28), inset 0 1px 0 #fff !important; backdrop-filter: none !important; }
.confirm-icon { display: grid; width: 42px; height: 42px; place-items: center; border-radius: 13px; background: #eef0ff; color: #4b59e0; }
.confirm-icon.danger { background: #ffeaee; color: var(--danger); }
.confirm-dialog h2 { margin: 16px 0 0; color: #111827; font-size: 19px; font-weight: 800; }
.confirm-dialog p { margin: 9px 0 0; color: #526079; font-size: 13px; line-height: 1.7; }
.confirm-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 22px; }
.confirm-actions button { display: inline-flex; align-items: center; gap: 6px; min-height: 38px; padding: 0 14px; border: 1px solid rgba(112,124,153,.18); border-radius: 11px; background: white; color: #5f6980; font-size: 12px; font-weight: 750; }
.confirm-actions button:last-child { border-color: transparent; background: var(--primary); color: white; }
.confirm-actions button.danger { background: var(--danger); }

.spin { animation: spin .8s linear infinite; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
@keyframes spin { to { transform: rotate(360deg); } }

@media (max-width: 1260px) {
  .annotation-drawer { width: min(360px, calc(100% - 24px)); }
  .product-identity { min-width: 180px; }
  .tool-button { min-width: 62px; padding-inline: 9px; }
  .utility-button span { display: none; }
}

@media (max-width: 980px) {
  .annotation-drawer { width: min(340px, calc(100% - 24px)); }
  .back-button span, .tool-button span { display: none; }
  .back-button, .tool-button { width: 40px; min-width: 40px; padding: 0; }
  .product-identity { min-width: 150px; }
  .fallback-metrics { grid-template-columns: 1fr 1fr; }
  .fallback-content { grid-template-columns: 1fr; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; }
}
</style>
