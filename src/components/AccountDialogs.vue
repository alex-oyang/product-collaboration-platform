<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Camera, Eye, EyeOff, KeyRound, LoaderCircle, ShieldCheck, TicketCheck, UserRound } from 'lucide-vue-next'
import type { BootstrapState } from '../contracts'
import UiModal from './UiModal.vue'

type Mode = 'profile' | 'password' | 'access' | null
const props = defineProps<{
  mode: Mode
  state: BootstrapState
  mandatoryPassword?: boolean
  action: (type: string, payload: Record<string, unknown>) => Promise<boolean>
}>()
const emit = defineEmits<{ close: []; redeemed: []; openPassword: [] }>()

const name = ref('')
const avatar = ref('')
const currentPassword = ref('')
const nextPassword = ref('')
const confirmPassword = ref('')
const accessCode = ref('')
const showPasswords = ref(false)
const busy = ref(false)
const passwordValid = computed(() => nextPassword.value.length >= 8 && nextPassword.value === confirmPassword.value && currentPassword.value.length > 0)

watch(() => props.mode, (mode) => {
  if (mode === 'profile') { name.value = props.state.currentUser.name; avatar.value = props.state.currentUser.avatar }
  currentPassword.value = ''; nextPassword.value = ''; confirmPassword.value = ''; accessCode.value = ''
})

function readAvatar(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file || !file.type.startsWith('image/') || file.size > 2 * 1024 * 1024) return
  const reader = new FileReader()
  reader.onload = () => { avatar.value = String(reader.result ?? '') }
  reader.readAsDataURL(file)
}

async function saveProfile() {
  if (!name.value.trim()) return
  busy.value = true
  const ok = await props.action('profile.update', { name: name.value.trim(), avatar: avatar.value })
  busy.value = false
  if (ok) emit('close')
}

async function changePassword() {
  if (!passwordValid.value) return
  busy.value = true
  const ok = await props.action('password.change', { currentPassword: currentPassword.value, newPassword: nextPassword.value })
  busy.value = false
  if (ok) emit('close')
}

async function redeem() {
  if (!accessCode.value.trim()) return
  busy.value = true
  const ok = await props.action('access.redeem', { code: accessCode.value.trim() })
  busy.value = false
  if (ok) { emit('redeemed'); emit('close') }
}
</script>

<template>
  <UiModal :open="mode === 'profile'" title="个人中心" description="管理姓名和头像；岗位与系统角色由超级管理员分配。" :busy="busy" @close="emit('close')">
    <div class="flex flex-col items-center rounded-2xl bg-slate-50 p-5 sm:flex-row sm:items-center sm:gap-5">
      <div class="relative"><img v-if="avatar" :src="avatar" class="h-20 w-20 rounded-3xl object-cover shadow-sm" alt="头像预览" /><div v-else class="grid h-20 w-20 place-items-center rounded-3xl bg-indigo-100 text-2xl font-semibold text-indigo-700">{{ name.slice(0,1) }}</div><label class="absolute -bottom-2 -right-2 grid h-9 w-9 cursor-pointer place-items-center rounded-xl border border-white bg-indigo-600 text-white shadow-md transition hover:bg-indigo-700"><Camera class="h-4 w-4" /><input class="sr-only" type="file" accept="image/*" @change="readAvatar" /></label></div>
      <div class="mt-4 text-center sm:mt-0 sm:text-left"><p class="font-semibold text-slate-900">{{ state.currentUser.name }}</p><p class="mt-1 text-sm text-slate-500">{{ state.currentUser.job }} · {{ state.currentUser.role === 'admin' ? '超级管理员' : '普通用户' }}</p><p class="mt-2 text-xs text-slate-400">头像支持 JPG、PNG、WebP，最大 2 MB。</p></div>
    </div>
    <label class="mt-5 block"><span class="field-label">姓名</span><input v-model="name" class="form-input mt-2" maxlength="40" /></label>
    <div class="mt-5 rounded-2xl border border-indigo-100 bg-indigo-50/70 p-4"><div class="flex gap-3"><ShieldCheck class="mt-0.5 h-5 w-5 shrink-0 text-indigo-600" /><div><p class="text-sm font-semibold text-indigo-950">权限信息只读</p><p class="mt-1 text-xs leading-5 text-indigo-700">岗位决定是否可上传产品，系统角色决定管理范围；本人不能自行调整。</p></div></div></div>
    <template #footer><button class="secondary-button mr-auto" type="button" @click="emit('openPassword')"><KeyRound class="h-4 w-4" />修改密码</button><button class="secondary-button" type="button" @click="emit('close')">取消</button><button class="primary-button" type="button" :disabled="busy || !name.trim()" @click="saveProfile"><LoaderCircle v-if="busy" class="h-4 w-4 animate-spin" />保存个人资料</button></template>
  </UiModal>

  <UiModal :open="mode === 'password'" :title="mandatoryPassword ? '首次登录，请修改密码' : '修改密码'" :description="mandatoryPassword ? '修改初始密码后才能进入工作台。' : '修改成功后，其他设备上的登录会话将失效。'" size="sm" :busy="busy" :close-on-backdrop="!mandatoryPassword" @close="!mandatoryPassword && emit('close')">
    <div v-if="mandatoryPassword" class="mb-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-800"><KeyRound class="mb-2 h-5 w-5" />为了保护账号安全，初始密码不能继续用于日常登录。</div>
    <div class="space-y-4">
      <label class="block"><span class="field-label">当前密码</span><div class="input-shell mt-2"><input v-model="currentPassword" class="min-w-0 flex-1" :type="showPasswords ? 'text' : 'password'" autocomplete="current-password" /><button type="button" class="text-slate-400" @click="showPasswords = !showPasswords"><EyeOff v-if="showPasswords" class="h-4 w-4" /><Eye v-else class="h-4 w-4" /></button></div></label>
      <label class="block"><span class="field-label">新密码</span><input v-model="nextPassword" class="form-input mt-2" :type="showPasswords ? 'text' : 'password'" autocomplete="new-password" placeholder="至少 8 个字符" /></label>
      <label class="block"><span class="field-label">确认新密码</span><input v-model="confirmPassword" class="form-input mt-2" :type="showPasswords ? 'text' : 'password'" autocomplete="new-password" /></label>
      <p v-if="confirmPassword && nextPassword !== confirmPassword" class="text-xs text-rose-600">两次输入的新密码不一致。</p>
    </div>
    <template #footer><button v-if="!mandatoryPassword" class="secondary-button" type="button" @click="emit('close')">取消</button><button class="primary-button" type="button" :disabled="busy || !passwordValid" @click="changePassword"><LoaderCircle v-if="busy" class="h-4 w-4 animate-spin" />保存新密码</button></template>
  </UiModal>

  <UiModal :open="mode === 'access'" title="输入授权码" description="验证成功后，产品会出现在你的产品总览中。" size="sm" :busy="busy" @close="emit('close')">
    <div class="rounded-2xl bg-indigo-50 p-5 text-center"><div class="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-white text-indigo-600 shadow-sm"><TicketCheck class="h-6 w-6" /></div><p class="mt-3 text-sm font-semibold text-indigo-950">产品访问授权</p><p class="mt-1 text-xs leading-5 text-indigo-700">授权会绑定当前账号并跨登录保留；访问码更新或到期不影响已授权成员，负责人收回权限后才会失效。</p></div>
    <label class="mt-5 block"><span class="field-label">授权码</span><div class="input-shell mt-2"><UserRound class="h-4 w-4 text-slate-400" /><input v-model="accessCode" class="font-mono tracking-wider" autocomplete="off" placeholder="请输入产品授权码" autofocus /></div></label>
    <template #footer><button class="secondary-button" type="button" @click="emit('close')">取消</button><button class="primary-button" type="button" :disabled="busy || !accessCode.trim()" @click="redeem"><LoaderCircle v-if="busy" class="h-4 w-4 animate-spin" />验证并加入产品</button></template>
  </UiModal>
</template>
