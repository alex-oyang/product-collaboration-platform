<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import {
  Activity, ChevronDown, CircleUserRound, ClipboardList, Cloud, FileUp,
  History, LayoutDashboard, LoaderCircle, LogOut, Menu, PanelLeftClose, ShieldCheck, TicketCheck, Trash2, UsersRound,
} from 'lucide-vue-next'
import type { BootstrapState, Product } from './contracts'
import type { ProductUploadPayload } from './api'
import { ApiError, getBootstrap, login, logout, performAction, uploadProduct } from './api'
import AccountDialogs from './components/AccountDialogs.vue'
import AuditPage from './components/AuditPage.vue'
import LoginPage from './components/LoginPage.vue'
import ProductDashboard from './components/ProductDashboard.vue'
import ProductDetail from './components/ProductDetail.vue'
import PrototypeReview from './components/PrototypeReview.vue'
import RecycleBinPage from './components/RecycleBinPage.vue'
import SystemReleasePage from './components/SystemReleasePage.vue'
import ToastStack, { type ToastItem } from './components/ToastStack.vue'
import UploadPage from './components/UploadPage.vue'
import UserAdminPage from './components/UserAdminPage.vue'

type Page = 'dashboard' | 'upload' | 'trash' | 'audit' | 'users' | 'releases' | 'detail' | 'review'
type AccountDialog = 'profile' | 'password' | 'access' | null
type DetailIntent = 'edit' | 'members' | 'transfer' | undefined

const state = shallowRef<BootstrapState | null>(null)
const staticPreview = import.meta.env.VITE_STATIC_PREVIEW === 'true'
const page = ref<Page>('dashboard')
const selectedProductId = ref('')
const uploadProductId = ref('')
const detailIntent = ref<DetailIntent>()
const detailReturnPage = ref<'dashboard' | 'trash'>('dashboard')
const loading = ref(true)
const refreshing = ref(false)
const pageError = ref('')
const loginLoading = ref(false)
const loginError = ref('')
const userMenu = ref(false)
const accountDialog = ref<AccountDialog>(null)
const sidebarOpen = ref(true)
const toasts = ref<ToastItem[]>([])
let toastId = 0

const currentProduct = computed<Product | undefined>(() => state.value?.products.find((item) => item.id === selectedProductId.value))
const canUpload = computed(() => Boolean(state.value && (state.value.currentUser.job === '产品' || state.value.currentUser.role === 'admin')))
const trashCount = computed(() => state.value?.products.filter((item) => item.state === 'trash').length ?? 0)
const canAccessTrash = computed(() => Boolean(state.value && (
  state.value.currentUser.role === 'admin'
  || state.value.currentUser.job === '产品'
  || state.value.products.some((item) => item.ownerId === state.value?.currentUser.id)
)))
const mandatoryPassword = computed(() => Boolean(state.value?.currentUser.mustChangePassword))
const pageLabel = computed(() => ({ dashboard: '产品总览', upload: '产品上传', trash: '回收站', audit: '操作记录', users: '账号管理', releases: '系统版本记录', detail: '产品详情', review: '原型评审' }[page.value]))

const navItems = computed(() => [
  { id: 'dashboard' as Page, label: '产品总览', icon: LayoutDashboard, visible: true, count: 0 },
  { id: 'upload' as Page, label: '产品上传', icon: FileUp, visible: canUpload.value, count: 0 },
  { id: 'trash' as Page, label: '回收站', icon: Trash2, visible: canAccessTrash.value, count: trashCount.value },
  { id: 'audit' as Page, label: '操作记录', icon: ClipboardList, visible: true, count: 0 },
  { id: 'users' as Page, label: '账号管理', icon: UsersRound, visible: state.value?.currentUser.role === 'admin', count: 0 },
  { id: 'releases' as Page, label: '系统版本记录', icon: History, visible: state.value?.currentUser.role === 'admin', count: 0 },
].filter((item) => item.visible))

const successMessages: Record<string, string> = {
  'profile.update': '个人资料已保存',
  'password.change': '密码已修改',
  'access.redeem': '授权成功，产品已加入总览',
  'user.create': '账号已创建', 'user.update': '账号信息已保存', 'user.toggle': '账号状态已更新', 'user.resetPassword': '密码已重置',
  'product.saveDraft': '产品草稿已保存', 'product.update': '产品资料已保存', 'product.transfer': '产品管理权已移交',
  'product.state': '产品状态已更新', 'product.restore': '产品已恢复为下架状态', 'product.purge': '产品已永久删除', 'product.accessCode': '访问码已更新，已有成员权限保持不变',
  'product.memberAdd': '成员已获得访问权限', 'product.memberRevoke': '成员权限已收回', 'product.reviewState': '评审状态已更新', 'product.rollback': '版本回滚成功',
  'annotation.create': '批注已创建', 'annotation.update': '批注已保存', 'annotation.delete': '批注已删除', 'annotation.status': '批注状态已更新',
  'reply.create': '回复已发送', 'reply.update': '回复已保存', 'reply.delete': '回复已删除',
  'systemRelease.create': '系统版本记录已发布', 'systemRelease.update': '系统版本记录已保存', 'systemRelease.delete': '系统版本记录已删除',
}

function notify(message: string, tone: ToastItem['tone'] = 'info') {
  const id = ++toastId
  toasts.value = [...toasts.value, { id, message, tone }]
  window.setTimeout(() => dismissToast(id), 4200)
}
function dismissToast(id: number) { toasts.value = toasts.value.filter((item) => item.id !== id) }

async function refresh(silent = false) {
  if (!silent) refreshing.value = true
  try {
    state.value = await getBootstrap()
    pageError.value = ''
  } catch (error) {
    if (!state.value) return
    pageError.value = error instanceof Error ? error.message : '无法同步最新数据'
  } finally {
    refreshing.value = false
  }
}

async function bootstrap() {
  loading.value = true
  if (staticPreview) {
    loginError.value = ''
    loading.value = false
    return
  }
  try {
    state.value = await getBootstrap()
  } catch (error) {
    if (error instanceof ApiError && ['UNAUTHORIZED', 'AUTH_REQUIRED', 'SESSION_EXPIRED'].includes(error.code)) state.value = null
    else if (error instanceof ApiError && error.message.includes('登录')) state.value = null
    else loginError.value = error instanceof Error ? error.message : '系统初始化失败'
  } finally {
    loading.value = false
  }
}

async function handleLogin(input: { username: string; password: string; remember: boolean }) {
  loginLoading.value = true
  loginError.value = ''
  try {
    state.value = await login(input.username, input.password, input.remember)
    if (!state.value?.currentUser) state.value = await getBootstrap()
    page.value = 'dashboard'
    notify('登录成功', 'success')
  } catch (error) {
    loginError.value = error instanceof Error ? error.message : '账号或密码不正确'
  } finally { loginLoading.value = false }
}

async function runAction(type: string, payload: Record<string, unknown> = {}): Promise<boolean> {
  try {
    await performAction(type, payload)
    if (type === 'password.change') {
      state.value = null
      accountDialog.value = null
      page.value = 'dashboard'
      notify('密码已修改，请使用新密码重新登录', 'success')
      return true
    }
    await refresh(true)
    if (type !== 'product.copyAccessCode') notify(successMessages[type] ?? '操作已完成', 'success')
    return true
  } catch (error) {
    notify(error instanceof Error ? error.message : '操作失败，请稍后重试', 'error')
    return false
  }
}

async function publish(payload: ProductUploadPayload): Promise<boolean> {
  try {
    await uploadProduct(payload)
    await refresh(true)
    notify('产品发布成功，已生成新的时间版本', 'success')
    return true
  } catch (error) {
    notify(error instanceof Error ? error.message : '发布失败，当前线上版本没有变化', 'error')
    return false
  }
}

async function handleLogout() {
  userMenu.value = false
  try { await logout() } catch { /* session is cleared locally even if the endpoint is unreachable */ }
  state.value = null
  page.value = 'dashboard'
  selectedProductId.value = ''
}

function navigate(next: Page) {
  page.value = next
  userMenu.value = false
  detailIntent.value = undefined
  if (next !== 'upload') uploadProductId.value = ''
}

function openUpload(productId = '') {
  uploadProductId.value = productId
  page.value = 'upload'
}

function openDetail(productId: string, intent?: DetailIntent) {
  detailReturnPage.value = 'dashboard'
  selectedProductId.value = productId
  detailIntent.value = intent
  page.value = 'detail'
}

function openTrashDetail(productId: string) {
  detailReturnPage.value = 'trash'
  selectedProductId.value = productId
  detailIntent.value = undefined
  page.value = 'detail'
}

function openReview(productId: string) {
  selectedProductId.value = productId
  page.value = 'review'
}

async function reviewAction(type: string, payload: Record<string, unknown>) {
  const ok = await runAction(type, payload)
  if (!ok) throw new Error('操作未完成，请根据提示检查后重试')
}

watch(mandatoryPassword, (mandatory) => { if (mandatory) accountDialog.value = 'password' }, { immediate: true })
onMounted(bootstrap)
</script>

<template>
  <div v-if="loading" class="grid min-h-screen place-items-center"><div class="glass-card flex items-center gap-3 px-6 py-4 text-sm font-medium text-slate-700"><LoaderCircle class="h-5 w-5 animate-spin text-indigo-600" />正在启动项目产品协作平台</div></div>
  <LoginPage v-else-if="!state" :loading="loginLoading" :error="loginError" :preview-mode="staticPreview" @submit="handleLogin" />
  <div v-else class="min-h-screen">
    <aside :class="['fixed inset-y-0 left-0 z-50 flex w-[252px] flex-col border-r border-white/80 bg-white/68 p-4 shadow-[18px_0_55px_rgba(79,88,128,.07)] backdrop-blur-2xl transition-transform', !sidebarOpen && '-translate-x-full']">
      <div class="flex items-center gap-3 px-2 py-3"><div class="grid h-11 w-11 place-items-center rounded-2xl bg-indigo-600 text-white shadow-glow"><Activity class="h-6 w-6" /></div><div><p class="text-sm font-semibold text-slate-950">项目产品协作平台</p><p class="mt-0.5 text-[10px] uppercase tracking-[.15em] text-indigo-500">Review workspace</p></div></div>
      <nav class="mt-7 space-y-1.5" aria-label="主导航"><button v-for="item in navItems" :key="item.id" :class="['nav-item', page === item.id && 'active']" type="button" @click="navigate(item.id)"><component :is="item.icon" class="h-[18px] w-[18px]" /><span>{{ item.label }}</span><span v-if="item.count" class="ml-auto inline-grid min-w-5 place-items-center rounded-full bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold text-rose-600">{{ item.count }}</span><span v-else-if="page === item.id" class="ml-auto h-1.5 w-1.5 rounded-full bg-indigo-600" /></button></nav>
      <div class="mt-auto rounded-2xl border border-emerald-100 bg-emerald-50/65 p-3"><div class="flex items-center gap-2 text-xs font-medium text-emerald-700"><Cloud class="h-4 w-4" />内网服务正常</div><p class="mt-1 pl-6 text-[10px] text-emerald-600/75">权限与数据已同步</p></div>
    </aside>

    <div :class="['min-h-screen transition-[margin] duration-200', sidebarOpen ? 'ml-[252px]' : 'ml-0']">
      <header class="sticky top-0 z-40 flex h-17 items-center border-b border-white/80 bg-[#f6f8fc]/72 px-6 backdrop-blur-xl">
        <button class="icon-button mr-3" type="button" :aria-label="sidebarOpen ? '收起侧栏' : '展开侧栏'" @click="sidebarOpen = !sidebarOpen"><PanelLeftClose v-if="sidebarOpen" class="h-5 w-5" /><Menu v-else class="h-5 w-5" /></button>
        <div><p class="text-xs text-slate-400">工作台 / {{ pageLabel }}</p><p class="mt-0.5 text-sm font-semibold text-slate-800">{{ pageLabel }}</p></div>
        <div class="ml-auto flex items-center gap-3"><div v-if="refreshing" class="hidden items-center gap-2 text-xs text-slate-400 sm:flex"><LoaderCircle class="h-3.5 w-3.5 animate-spin" />正在同步</div><div class="relative"><button class="flex items-center gap-3 rounded-2xl border border-white/90 bg-white/65 px-2.5 py-2 text-left shadow-sm transition hover:bg-white" type="button" aria-haspopup="menu" :aria-expanded="userMenu" @click="userMenu = !userMenu"><img v-if="state.currentUser.avatar" :src="state.currentUser.avatar" class="h-8 w-8 rounded-xl object-cover" alt="" /><span v-else class="grid h-8 w-8 place-items-center rounded-xl bg-indigo-100 text-xs font-semibold text-indigo-700">{{ state.currentUser.name.slice(0,1) }}</span><span class="hidden sm:block"><b class="block text-xs font-semibold text-slate-800">{{ state.currentUser.name }}</b><small class="block text-[10px] text-slate-400">{{ state.currentUser.job }}</small></span><ChevronDown class="h-4 w-4 text-slate-400" /></button><div v-if="userMenu" class="popover-menu right-0 top-13 w-48"><button type="button" @click="accountDialog = 'profile'; userMenu = false"><CircleUserRound class="h-4 w-4" />个人中心</button><button type="button" @click="accountDialog = 'access'; userMenu = false"><TicketCheck class="h-4 w-4" />输入授权码</button><button class="danger" type="button" @click="handleLogout"><LogOut class="h-4 w-4" />退出登录</button></div></div></div>
      </header>

      <main :class="page === 'review' ? 'p-4' : 'mx-auto max-w-[1560px] p-6 lg:p-8'">
        <ProductDashboard v-if="page === 'dashboard'" :state="state" :loading="refreshing" :error="pageError" :action="runAction" @upload="openUpload" @detail="openDetail" @review="openReview" @retry="refresh" @notify="notify" />
        <UploadPage v-else-if="page === 'upload' && canUpload" :key="uploadProductId || 'new'" :state="state" :initial-product-id="uploadProductId" :action="runAction" :publish="publish" @complete="refresh(true)" />
        <RecycleBinPage v-else-if="page === 'trash' && canAccessTrash" :state="state" :loading="refreshing" :error="pageError" :action="runAction" @detail="openTrashDetail" @retry="refresh" />
        <AuditPage v-else-if="page === 'audit'" :state="state" :loading="refreshing" :error="pageError" @retry="refresh" @notify="notify" />
        <UserAdminPage v-else-if="page === 'users' && state.currentUser.role === 'admin'" :state="state" :loading="refreshing" :error="pageError" :action="runAction" @retry="refresh" @notify="notify" />
        <SystemReleasePage v-else-if="page === 'releases' && state.currentUser.role === 'admin'" :state="state" :loading="refreshing" :error="pageError" :action="runAction" @retry="refresh" @notify="notify" />
        <ProductDetail v-else-if="page === 'detail'" :key="`${selectedProductId}-${detailIntent ?? 'none'}`" :state="state" :product-id="selectedProductId" :initial-dialog="detailIntent" :action="runAction" @back="navigate(detailReturnPage)" @review="openReview" @upload="openUpload" @notify="notify" />
        <PrototypeReview v-else-if="page === 'review' && currentProduct" :state="state" :product="currentProduct" :action="reviewAction" :refresh="() => refresh(true)" @back="openDetail(selectedProductId)" />
        <div v-else class="glass-card grid min-h-96 place-items-center p-8 text-center"><div><ShieldCheck class="mx-auto h-9 w-9 text-indigo-500" /><p class="mt-4 text-sm font-semibold text-slate-800">你没有访问此页面的权限</p><button class="secondary-button mt-5" type="button" @click="navigate('dashboard')">返回产品总览</button></div></div>
      </main>
    </div>

    <AccountDialogs :mode="accountDialog" :state="state" :mandatory-password="mandatoryPassword" :action="runAction" @close="accountDialog = null" @open-password="accountDialog = 'password'" @redeemed="navigate('dashboard')" />
  </div>
  <ToastStack :items="toasts" @dismiss="dismissToast" />
</template>
