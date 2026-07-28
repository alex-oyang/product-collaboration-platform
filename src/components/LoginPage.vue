<script setup lang="ts">
import { computed, ref } from 'vue'
import { ArrowRight, Eye, EyeOff, Layers3, LoaderCircle, LockKeyhole, ShieldCheck, UserRound } from 'lucide-vue-next'

const props = defineProps<{ loading: boolean; error: string }>()
const emit = defineEmits<{ submit: [input: { username: string; password: string; remember: boolean }] }>()

const remembered = localStorage.getItem('prototype-review-username') ?? ''
const username = ref(remembered)
const password = ref('')
const remember = ref(Boolean(remembered))
const showPassword = ref(false)
const canSubmit = computed(() => username.value.trim().length > 0 && password.value.length > 0 && !props.loading)

function submit() {
  if (!canSubmit.value) return
  if (remember.value) localStorage.setItem('prototype-review-username', username.value.trim())
  else localStorage.removeItem('prototype-review-username')
  emit('submit', { username: username.value.trim(), password: password.value, remember: remember.value })
}
</script>

<template>
  <main class="relative grid min-h-screen overflow-hidden lg:grid-cols-[1.05fr_.95fr]">
    <section class="relative hidden overflow-hidden bg-[linear-gradient(145deg,#eef3ff_0%,#f7f4ff_52%,#fdf5fb_100%)] px-16 py-14 text-slate-900 lg:flex lg:flex-col lg:justify-between">
      <div class="absolute -left-16 top-28 h-80 w-80 rounded-full bg-indigo-300/30 blur-3xl" />
      <div class="absolute -right-20 bottom-0 h-96 w-96 rounded-full bg-fuchsia-200/35 blur-3xl" />
      <div class="relative flex items-center gap-3">
        <div class="grid h-11 w-11 place-items-center rounded-2xl border border-white/90 bg-white/65 text-indigo-600 shadow-sm"><Layers3 class="h-6 w-6" /></div>
        <div><p class="font-semibold">项目产品协作平台</p><p class="text-xs text-indigo-500">Prototype review workspace</p></div>
      </div>
      <div class="relative max-w-xl">
        <p class="text-xs font-semibold uppercase tracking-[.28em] text-indigo-600">From release to resolution</p>
        <h1 class="mt-5 text-5xl font-semibold leading-[1.1] tracking-[-.04em]">让每次原型评审，<br />都有版本、有回应、有结论。</h1>
        <p class="mt-6 max-w-lg text-base leading-8 text-slate-600">集中管理产品原型、版本和批注。产品负责人发布更新，评审成员在同一个界面完成定位、讨论与闭环。</p>
      </div>
      <div class="relative grid grid-cols-3 gap-4 text-sm">
        <div class="rounded-2xl border border-white/90 bg-white/55 p-4 shadow-sm backdrop-blur-xl"><ShieldCheck class="mb-3 h-5 w-5 text-emerald-600" /><p class="font-medium">内网可信访问</p><p class="mt-1 text-xs text-slate-500">权限随账号即时生效</p></div>
        <div class="rounded-2xl border border-white/90 bg-white/55 p-4 shadow-sm backdrop-blur-xl"><Layers3 class="mb-3 h-5 w-5 text-indigo-600" /><p class="font-medium">版本不可变</p><p class="mt-1 text-xs text-slate-500">发布与回滚可追溯</p></div>
        <div class="rounded-2xl border border-white/90 bg-white/55 p-4 shadow-sm backdrop-blur-xl"><LockKeyhole class="mb-3 h-5 w-5 text-pink-600" /><p class="font-medium">批注有归属</p><p class="mt-1 text-xs text-slate-500">只管理自己的内容</p></div>
      </div>
    </section>

    <section class="grid place-items-center px-6 py-12 sm:px-12">
      <form class="glass-card w-full max-w-md p-8 sm:p-10" @submit.prevent="submit">
        <div class="mb-8 lg:hidden"><p class="text-lg font-semibold text-slate-900">项目产品协作平台</p></div>
        <p class="eyebrow">WELCOME BACK</p>
        <h2 class="mt-2 text-3xl font-semibold tracking-[-.03em] text-slate-950">登录工作台</h2>
        <p class="mt-2 text-sm leading-6 text-slate-500">使用管理员分配的账号继续评审。</p>

        <div v-if="error" class="mt-6 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700" role="alert">{{ error }}</div>

        <label class="field-label mt-7" for="login-username">账号</label>
        <div class="input-shell mt-2"><UserRound class="h-4 w-4 text-slate-400" /><input id="login-username" v-model="username" autocomplete="username" placeholder="请输入账号" autofocus /></div>

        <label class="field-label mt-5" for="login-password">密码</label>
        <div class="input-shell mt-2"><LockKeyhole class="h-4 w-4 text-slate-400" /><input id="login-password" v-model="password" :type="showPassword ? 'text' : 'password'" autocomplete="current-password" placeholder="请输入密码" /><button class="text-slate-400 transition hover:text-slate-700" type="button" :aria-label="showPassword ? '隐藏密码' : '显示密码'" @click="showPassword = !showPassword"><EyeOff v-if="showPassword" class="h-4 w-4" /><Eye v-else class="h-4 w-4" /></button></div>

        <label class="mt-5 inline-flex cursor-pointer items-center gap-2 text-sm text-slate-600"><input v-model="remember" class="h-4 w-4 rounded border-slate-300 accent-indigo-600" type="checkbox" />记住账号并保持登录</label>

        <button class="primary-button mt-7 w-full justify-center" type="submit" :disabled="!canSubmit">
          <LoaderCircle v-if="loading" class="h-4 w-4 animate-spin" />
          <template v-else>进入工作台<ArrowRight class="h-4 w-4" /></template>
        </button>
        <p class="mt-5 text-center text-xs leading-5 text-slate-400">账号由超级管理员统一创建。系统不会保存明文密码。</p>
      </form>
    </section>
  </main>
</template>
