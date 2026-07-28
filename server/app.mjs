import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { access, cp, mkdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import express from 'express'
import multer from 'multer'

import {
  JsonStore, ids, isoNow, passwordFields, publicUser, shanghaiVersion, tokenHash, verifyPassword
} from './store.mjs'
import { extractZipSafely } from './zip.mjs'
import { extractTarSafely } from './tar.mjs'
import { createGitSnapshot } from './git.mjs'
import { normalizeHtmlFile, readHtmlFile } from './html.mjs'
import { injectReviewBridge } from './review-bridge.mjs'
import { buildTrustedNextSource } from './source-build.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = path.resolve(__dirname, '..')
const COOKIE_NAME = 'prs_session'
const JOBS = new Set(['产品', '美术', '研发', 'UE', '项目', '其他'])
const ROLES = new Set(['admin', 'user'])
const PRODUCT_STATES = new Set(['draft', 'online', 'offline', 'trash'])
const REVIEW_STATES = new Set(['pending', 'reviewing', 'completed'])
const ANNOTATION_STATES = new Set(['open', 'resolved', 'needs-relocation'])
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024
const DEFAULT_CAPABILITY_TTL_MS = 2 * 60 * 60 * 1000
const MAX_CAPABILITY_TTL_MS = 2 * 60 * 60 * 1000

class ApiError extends Error {
  constructor(status, code, message, fields) {
    super(message)
    this.status = status
    this.code = code
    this.fields = fields
  }
}

function fail(status, code, message, fields) {
  throw new ApiError(status, code, message, fields)
}

function text(value, field, { optional = false, max = 5000 } = {}) {
  if (value == null && optional) return undefined
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > max) {
    fail(400, 'VALIDATION_ERROR', '提交内容不符合要求', { [field]: `${field} 格式不正确` })
  }
  return value.trim()
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function parseCookies(header = '') {
  return Object.fromEntries(String(header).split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf('=')
    if (index < 0) return [part, '']
    try { return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))] } catch { return [part.slice(0, index), ''] }
  }))
}

function sessionCookie(token, maxAge, secure) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAge / 1000)}${secure ? '; Secure' : ''}`
}

function clearCookie(secure) {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`
}

function capabilitySecret(value) {
  const secret = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value ?? randomBytes(32))
  if (secret.length < 16) throw new TypeError('Prototype capability secret must contain at least 16 bytes')
  return secret
}

function signCapability(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${signature}`
}

function verifyCapability(rawToken, secret, now) {
  if (typeof rawToken !== 'string' || rawToken.length > 2048) {
    fail(401, 'INVALID_PREVIEW_CAPABILITY', '安全预览凭证无效')
  }
  const parts = rawToken.split('.')
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) {
    fail(401, 'INVALID_PREVIEW_CAPABILITY', '安全预览凭证无效')
  }
  const expected = createHmac('sha256', secret).update(parts[0]).digest()
  const actual = Buffer.from(parts[1], 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    fail(401, 'INVALID_PREVIEW_CAPABILITY', '安全预览凭证无效')
  }
  let payload
  try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) } catch {
    fail(401, 'INVALID_PREVIEW_CAPABILITY', '安全预览凭证无效')
  }
  const valid = payload && payload.version === 1
    && ['productId', 'releaseVersion', 'userId', 'sessionId', 'nonce'].every((key) => (
      typeof payload[key] === 'string' && payload[key].length > 0 && payload[key].length <= 500
    ))
    && Number.isSafeInteger(payload.issuedAt)
    && Number.isSafeInteger(payload.expiresAt)
    && payload.expiresAt > payload.issuedAt
  if (!valid) fail(401, 'INVALID_PREVIEW_CAPABILITY', '安全预览凭证无效')
  if (payload.expiresAt <= now) fail(401, 'PREVIEW_CAPABILITY_EXPIRED', '安全预览凭证已过期，请刷新后重试')
  return payload
}

function releaseRelativePath(requestPath) {
  let relative
  try { relative = decodeURIComponent(requestPath || '/index.html').replace(/^\/+/, '') || 'index.html' } catch {
    fail(400, 'INVALID_PATH', '文件路径不正确')
  }
  if (relative.includes('\0') || relative.includes('\\')) fail(400, 'INVALID_PATH', '文件路径不正确')
  return relative
}

function releaseTarget(releaseRoot, productId, version, requestPath) {
  const root = path.resolve(releaseRoot, productId, version)
  const target = path.resolve(root, releaseRelativePath(requestPath))
  if (!target.startsWith(`${root}${path.sep}`)) fail(400, 'INVALID_PATH', '文件路径不正确')
  return target
}

async function servedReleaseTarget(releaseRoot, productId, version, requestPath) {
  const target = releaseTarget(releaseRoot, productId, version, requestPath)
  if (await fileExists(target)) return target
  if (!path.extname(target) && await fileExists(`${target}.html`)) return `${target}.html`
  return target
}

function safePublishedEntry(releaseDir, input) {
  const entryPath = releaseRelativePath(`/${String(input || 'index.html')}`)
  const root = path.resolve(releaseDir)
  const target = path.resolve(root, entryPath)
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('发布入口路径不安全')
  return entryPath
}

function versionEntryUrl(productId, version, entryPath) {
  const encodedEntry = entryPath.split('/').map((segment) => encodeURIComponent(segment)).join('/')
  return `/prototype-files/${encodeURIComponent(productId)}/${encodeURIComponent(version)}/${encodedEntry}`
}

async function staticArchiveRoot(sourceDir) {
  for (const relativeEntry of ['index.html', 'dist/index.html', 'out/index.html']) {
    const entry = path.join(sourceDir, ...relativeEntry.split('/'))
    if (await fileExists(entry)) return path.dirname(entry)
  }
  return null
}

function versionEntryPath(record, productId, version) {
  try {
    const entry = new URL(record.entryUrl, 'http://prototype-review.local')
    const prefix = `/prototype-files/${encodeURIComponent(productId)}/${encodeURIComponent(version)}/`
    if (entry.origin !== 'http://prototype-review.local' || !entry.pathname.startsWith(prefix)) return 'index.html'
    return releaseRelativePath(entry.pathname.slice(prefix.length))
  } catch {
    return 'index.html'
  }
}

function findUser(state, id) {
  const user = state.users.find((item) => item.id === id)
  if (!user) fail(404, 'USER_NOT_FOUND', '用户不存在')
  return user
}

function findProduct(state, id) {
  const product = state.products.find((item) => item.id === id)
  if (!product) fail(404, 'PRODUCT_NOT_FOUND', '产品不存在')
  return product
}

function findAnnotation(state, id) {
  const annotation = state.annotations.find((item) => item.id === id)
  if (!annotation || annotation.deleted) fail(404, 'ANNOTATION_NOT_FOUND', '批注不存在')
  return annotation
}

function isAdmin(user) { return user.role === 'admin' }
function canUpload(user) { return isAdmin(user) || user.job === '产品' }
function canManage(user, product) { return isAdmin(user) || product.ownerId === user.id }
function currentMember(product, userId) {
  return product.members.some((member) => member.userId === userId)
}
function canView(user, product) {
  if (canManage(user, product)) return true
  return product.state === 'online' && currentMember(product, user.id)
}

function requireAdmin(user) {
  if (!isAdmin(user)) fail(403, 'FORBIDDEN', '仅超级管理员可以执行此操作')
}

function requireUploader(user) {
  if (!canUpload(user)) fail(403, 'FORBIDDEN', '仅产品岗位或超级管理员可以上传发布')
}

function requireManager(user, product) {
  if (!canManage(user, product)) fail(403, 'FORBIDDEN', '只有产品负责人或超级管理员可以管理该产品')
}

function requireViewer(user, product) {
  if (!canView(user, product)) fail(403, 'FORBIDDEN', '尚未获得该产品的访问权限')
}

function enabledAdminCount(state) {
  return state.users.filter((user) => user.enabled && user.role === 'admin').length
}

function audit(state, actorId, action, targetType, targetId, targetName, detail, result = 'success') {
  const record = {
    id: randomUUID(), actorId, action, targetType, targetId, targetName,
    detail, result, createdAt: isoNow()
  }
  state.audit.unshift(record)
  return record
}

function sanitizeProduct(product, user) {
  const manager = canManage(user, product)
  const copy = structuredClone(product)
  delete copy.revokedMembers
  if (!manager) {
    copy.accessCode = ''
    copy.accessCodeExpiresAt = null
    copy.members = []
  }
  return copy
}

function bootstrapFor(state, user) {
  const visibleProducts = state.products.filter((product) => canView(user, product))
  const visibleIds = new Set(visibleProducts.map((product) => product.id))
  return {
    currentUser: publicUser(user),
    users: state.users.filter((item) => item.enabled || isAdmin(user)).map((item) => isAdmin(user)
      ? publicUser(item)
      : { id: item.id, username: '', name: item.name, job: item.job, avatar: item.avatar, enabled: item.enabled }),
    products: visibleProducts.map((product) => sanitizeProduct(product, user)),
    uploads: state.uploads.filter((item) => isAdmin(user) || visibleIds.has(item.productId) || (!item.productId && item.uploaderId === user.id)),
    annotations: state.annotations.filter((item) => visibleIds.has(item.productId)),
    systemReleases: isAdmin(user) ? state.systemReleases : [],
    audit: isAdmin(user) ? state.audit : state.audit.filter((item) => item.actorId === user.id)
  }
}

function validateAnchor(raw) {
  const anchor = object(raw)
  if (!['point', 'region'].includes(anchor.kind)) fail(400, 'VALIDATION_ERROR', '批注锚点类型不正确')
  for (const key of ['x', 'y']) {
    if (!Number.isFinite(anchor[key]) || anchor[key] < 0 || anchor[key] > 1) fail(400, 'VALIDATION_ERROR', '批注坐标不正确')
  }
  const result = { kind: anchor.kind, x: anchor.x, y: anchor.y }
  if (anchor.kind === 'region') {
    for (const key of ['width', 'height']) {
      if (!Number.isFinite(anchor[key]) || anchor[key] <= 0 || anchor[key] > 1) fail(400, 'VALIDATION_ERROR', '批注区域不正确')
      result[key] = anchor[key]
    }
  }
  for (const [key, max] of [['pageKey', 1000], ['selector', 2000]]) {
    if (anchor[key] != null) result[key] = text(anchor[key], key, { optional: true, max }) ?? ''
  }
  for (const key of ['elementX', 'elementY']) {
    if (anchor[key] != null) {
      if (!Number.isFinite(anchor[key]) || anchor[key] < 0 || anchor[key] > 1) fail(400, 'VALIDATION_ERROR', '元素内批注坐标不正确')
      result[key] = anchor[key]
    }
  }
  for (const key of ['regionX', 'regionY']) {
    if (anchor[key] != null) {
      if (!Number.isFinite(anchor[key]) || anchor[key] < -10 || anchor[key] > 10) fail(400, 'VALIDATION_ERROR', '元素相对批注坐标不正确')
      result[key] = anchor[key]
    }
  }
  for (const key of ['elementWidth', 'elementHeight', 'regionWidth', 'regionHeight']) {
    if (anchor[key] != null) {
      if (!Number.isFinite(anchor[key]) || anchor[key] <= 0 || anchor[key] > 10) fail(400, 'VALIDATION_ERROR', '元素批注区域不正确')
      result[key] = anchor[key]
    }
  }
  return result
}

function imageAttachments(raw) {
  if (raw == null) return []
  if (!Array.isArray(raw) || raw.length > 3) fail(400, 'VALIDATION_ERROR', '每次最多上传 3 张图片')
  return raw.map((item) => {
    const attachment = object(item)
    const type = text(attachment.type, 'attachment.type', { max: 80 })
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type)) {
      fail(400, 'VALIDATION_ERROR', '仅支持 PNG、JPG、WEBP 或 GIF 图片')
    }
    const size = Number(attachment.size)
    if (!Number.isFinite(size) || size <= 0 || size > 4 * 1024 * 1024) {
      fail(400, 'VALIDATION_ERROR', '单张图片不能超过 4 MB')
    }
    const dataUrl = text(attachment.dataUrl, 'attachment.dataUrl', { max: 5_700_000 })
    if (!dataUrl.startsWith(`data:${type};base64,`)) fail(400, 'VALIDATION_ERROR', '图片数据格式不正确')
    return {
      id: attachment.id ? text(attachment.id, 'attachment.id', { max: 100 }) : `image-${randomUUID()}`,
      name: text(attachment.name || '批注图片', 'attachment.name', { max: 180 }),
      type,
      size,
      dataUrl
    }
  })
}

function accessCodeExpiry(value, field = 'accessCodeExpiresAt') {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    fail(400, 'VALIDATION_ERROR', '访问码有效期不正确', { [field]: '请选择有效的日期时间' })
  }
  return new Date(value).toISOString()
}

function dateTimeValue(value, field = 'releasedAt') {
  const raw = text(value, field, { max: 80 })
  const timestamp = Date.parse(raw)
  if (Number.isNaN(timestamp)) fail(400, 'VALIDATION_ERROR', '发布时间不正确', { [field]: '请选择有效的日期时间' })
  return new Date(timestamp).toISOString()
}

function productInput(payload, actor, state) {
  const ownerId = payload.ownerId && isAdmin(actor) ? payload.ownerId : actor.id
  const owner = findUser(state, ownerId)
  if (owner.job !== '产品' && owner.role !== 'admin') fail(400, 'INVALID_OWNER', '产品负责人必须是产品岗位或超级管理员')
  return {
    name: text(payload.name, 'name', { max: 120 }),
    manager: text(payload.manager, 'manager', { max: 80 }),
    description: text(payload.description ?? '', 'description', { optional: true, max: 1000 }) ?? '',
    longNote: text(payload.longNote ?? '', 'longNote', { optional: true, max: 5000 }) ?? '',
    ownerId,
    accessCode: text(payload.accessCode || randomBytes(4).toString('hex'), 'accessCode', { max: 64 }),
    accessCodeExpiresAt: accessCodeExpiry(payload.accessCodeExpiresAt ?? payload.expiresAt)
  }
}

async function executeAction(state, actorId, type, rawPayload) {
  const actor = findUser(state, actorId)
  if (!actor.enabled) fail(401, 'ACCOUNT_DISABLED', '账号已停用')
  const payload = object(rawPayload)

  switch (type) {
    case 'profile.update': {
      const before = actor.name
      if (payload.name != null) actor.name = text(payload.name, 'name', { max: 80 })
      if (payload.avatar != null) actor.avatar = text(payload.avatar, 'avatar', { optional: true, max: 3_000_000 }) ?? ''
      audit(state, actor.id, type, 'user', actor.id, actor.name, `个人资料由“${before}”更新为“${actor.name}”`)
      return publicUser(actor)
    }
    case 'password.change': {
      const currentPassword = text(payload.currentPassword, 'currentPassword', { max: 256 })
      const newPassword = text(payload.newPassword, 'newPassword', { max: 256 })
      if (newPassword.length < 8) fail(400, 'WEAK_PASSWORD', '新密码至少需要 8 位')
      if (!await verifyPassword(currentPassword, actor)) fail(400, 'INVALID_PASSWORD', '当前密码不正确')
      Object.assign(actor, await passwordFields(newPassword), { mustChangePassword: false })
      state.sessions = state.sessions.filter((session) => session.userId !== actor.id)
      audit(state, actor.id, type, 'user', actor.id, actor.name, '修改登录密码并撤销已有会话')
      return { changed: true, sessionsRevoked: true }
    }
    case 'access.redeem': {
      const code = text(payload.code, 'code', { max: 64 })
      const product = state.products.find((item) => item.accessCode === code && item.state === 'online')
      if (!product) fail(400, 'INVALID_ACCESS_CODE', '访问码无效')
      if (product.accessCodeExpiresAt && new Date(product.accessCodeExpiresAt).getTime() <= Date.now()) {
        fail(409, 'ACCESS_CODE_EXPIRED', '访问码已过期，请联系产品负责人')
      }
      if (product.ownerId === actor.id) return sanitizeProduct(product, actor)
      if ((product.revokedMembers ?? []).some((item) => item.userId === actor.id && item.codeVersion === product.codeVersion)) {
        fail(403, 'GRANT_REVOKED', '当前访问码下的授权已被收回')
      }
      product.members = product.members.filter((member) => member.userId !== actor.id)
      product.members.push({ userId: actor.id, source: 'code', grantedAt: isoNow(), codeVersion: product.codeVersion })
      product.updatedAt = isoNow()
      audit(state, actor.id, type, 'product', product.id, product.name, '通过访问码获得产品权限')
      return sanitizeProduct(product, actor)
    }
    case 'user.create': {
      requireAdmin(actor)
      const username = text(payload.username, 'username', { max: 40 }).toLowerCase()
      if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(username)) fail(400, 'VALIDATION_ERROR', '用户名格式不正确')
      if (state.users.some((user) => user.username.toLowerCase() === username)) fail(409, 'USERNAME_EXISTS', '用户名已存在')
      if (!ROLES.has(payload.role) || !JOBS.has(payload.job)) fail(400, 'VALIDATION_ERROR', '角色或岗位不正确')
      const password = text(payload.password, 'password', { max: 256 })
      if (password.length < 8) fail(400, 'WEAK_PASSWORD', '密码至少需要 8 位')
      const user = {
        id: `user-${randomUUID()}`, username, name: text(payload.name, 'name', { max: 80 }),
        role: payload.role, job: payload.job, avatar: payload.avatar ? String(payload.avatar) : '', enabled: true,
        mustChangePassword: true, ...await passwordFields(password)
      }
      state.users.push(user)
      audit(state, actor.id, type, 'user', user.id, user.name, `创建账号 ${username}`)
      return publicUser(user)
    }
    case 'user.update': {
      requireAdmin(actor)
      const user = findUser(state, payload.userId ?? payload.id)
      if (payload.name != null) user.name = text(payload.name, 'name', { max: 80 })
      if (payload.role != null) {
        if (!ROLES.has(payload.role)) fail(400, 'VALIDATION_ERROR', '系统角色不正确')
        if (user.enabled && user.role === 'admin' && payload.role !== 'admin' && enabledAdminCount(state) <= 1) {
          fail(409, 'LAST_ADMIN_REQUIRED', '系统必须保留至少一个已启用的超级管理员')
        }
        user.role = payload.role
      }
      if (payload.job != null) {
        if (!JOBS.has(payload.job)) fail(400, 'VALIDATION_ERROR', '岗位不正确')
        user.job = payload.job
      }
      if (payload.avatar != null) user.avatar = String(payload.avatar)
      audit(state, actor.id, type, 'user', user.id, user.name, '更新账号资料和权限')
      return publicUser(user)
    }
    case 'user.toggle': {
      requireAdmin(actor)
      const user = findUser(state, payload.userId ?? payload.id)
      const nextEnabled = payload.enabled == null ? !user.enabled : Boolean(payload.enabled)
      if (!nextEnabled && user.enabled && user.role === 'admin' && enabledAdminCount(state) <= 1) {
        fail(409, 'LAST_ADMIN_REQUIRED', '系统必须保留至少一个已启用的超级管理员')
      }
      if (user.id === actor.id && !nextEnabled) fail(400, 'CANNOT_DISABLE_SELF', '不能停用当前登录账号')
      user.enabled = nextEnabled
      if (!user.enabled) state.sessions = state.sessions.filter((session) => session.userId !== user.id)
      audit(state, actor.id, type, 'user', user.id, user.name, user.enabled ? '启用账号' : '停用账号')
      return publicUser(user)
    }
    case 'user.resetPassword': {
      requireAdmin(actor)
      const user = findUser(state, payload.userId ?? payload.id)
      const generated = payload.password ? text(payload.password, 'password', { max: 256 }) : `Temp-${randomBytes(5).toString('hex')}`
      if (generated.length < 8) fail(400, 'WEAK_PASSWORD', '密码至少需要 8 位')
      Object.assign(user, await passwordFields(generated), { mustChangePassword: true })
      state.sessions = state.sessions.filter((session) => session.userId !== user.id)
      audit(state, actor.id, type, 'user', user.id, user.name, '重置密码并撤销已有会话')
      return { user: publicUser(user), temporaryPassword: generated }
    }
    case 'product.saveDraft': {
      requireUploader(actor)
      const input = productInput(payload, actor, state)
      const now = isoNow()
      const product = {
        id: `product-${randomUUID()}`, ...input, codeVersion: 1, state: 'draft', reviewState: 'pending',
        currentVersion: '', createdAt: now, updatedAt: now, members: [], versions: [], revokedMembers: []
      }
      state.products.unshift(product)
      audit(state, actor.id, type, 'product', product.id, product.name, '创建产品草稿')
      return sanitizeProduct(product, actor)
    }
    case 'product.update': {
      const product = findProduct(state, payload.productId ?? payload.id)
      requireManager(actor, product)
      for (const [key, max] of [['name', 120], ['manager', 80], ['description', 1000], ['longNote', 5000]]) {
        if (payload[key] != null) product[key] = text(payload[key], key, { optional: key === 'description' || key === 'longNote', max }) ?? ''
      }
      const hasAccessCode = payload.accessCode != null
      const hasExpiry = Object.hasOwn(payload, 'accessCodeExpiresAt') || Object.hasOwn(payload, 'expiresAt')
      if (hasAccessCode || hasExpiry) {
        const nextAccessCode = hasAccessCode ? text(payload.accessCode, 'accessCode', { max: 64 }) : product.accessCode
        const nextExpiry = hasExpiry ? accessCodeExpiry(payload.accessCodeExpiresAt ?? payload.expiresAt) : (product.accessCodeExpiresAt ?? null)
        if (nextAccessCode !== product.accessCode || nextExpiry !== (product.accessCodeExpiresAt ?? null)) {
          product.accessCode = nextAccessCode
          product.accessCodeExpiresAt = nextExpiry
          product.codeVersion += 1
        }
      }
      product.updatedAt = isoNow()
      audit(state, actor.id, type, 'product', product.id, product.name, hasAccessCode || hasExpiry ? '更新产品资料与访问码配置；已有成员授权保留' : '更新产品资料')
      return sanitizeProduct(product, actor)
    }
    case 'product.transfer': {
      const product = findProduct(state, payload.productId ?? payload.id)
      requireManager(actor, product)
      const nextOwner = findUser(state, payload.ownerId)
      if (!nextOwner.enabled) fail(400, 'INVALID_OWNER', '新负责人必须是已启用成员')
      const oldOwner = product.ownerId
      product.ownerId = nextOwner.id
      product.members = product.members.filter((member) => member.userId !== oldOwner && member.userId !== nextOwner.id)
      if (oldOwner !== nextOwner.id) product.members.push({ userId: oldOwner, source: 'transfer', grantedAt: isoNow(), codeVersion: product.codeVersion })
      product.updatedAt = isoNow()
      audit(state, actor.id, type, 'product', product.id, product.name, `管理权转交给 ${nextOwner.name}`)
      return sanitizeProduct(product, actor)
    }
    case 'product.state': {
      const product = findProduct(state, payload.productId ?? payload.id)
      requireManager(actor, product)
      if (!PRODUCT_STATES.has(payload.state)) fail(400, 'VALIDATION_ERROR', '产品状态不正确')
      if (payload.state === 'online' && !product.currentVersion) fail(409, 'NO_RELEASE', '没有成功版本的产品不能上架')
      product.state = payload.state
      product.updatedAt = isoNow()
      if (payload.state === 'trash') product.trashedAt = product.updatedAt
      else delete product.trashedAt
      audit(state, actor.id, type, 'product', product.id, product.name, `产品状态变更为 ${payload.state}`)
      return sanitizeProduct(product, actor)
    }
    case 'product.restore': {
      const product = findProduct(state, payload.productId ?? payload.id)
      requireManager(actor, product)
      if (product.state !== 'trash') fail(409, 'NOT_IN_TRASH', '产品不在回收站')
      product.state = 'offline'
      product.updatedAt = isoNow()
      delete product.trashedAt
      audit(state, actor.id, type, 'product', product.id, product.name, '从回收站恢复为已下架')
      return sanitizeProduct(product, actor)
    }
    case 'product.purge': {
      const product = findProduct(state, payload.productId ?? payload.id)
      requireManager(actor, product)
      if (product.state !== 'trash') fail(409, 'NOT_IN_TRASH', '只有回收站中的产品可以永久删除')
      const summary = {
        id: product.id,
        name: product.name,
        versions: product.versions.length,
        uploads: state.uploads.filter((item) => item.productId === product.id).length,
        annotations: state.annotations.filter((item) => item.productId === product.id).length,
      }
      state.products = state.products.filter((item) => item.id !== product.id)
      state.uploads = state.uploads.filter((item) => item.productId !== product.id)
      state.annotations = state.annotations.filter((item) => item.productId !== product.id)
      audit(state, actor.id, type, 'product', product.id, product.name, `永久删除产品及其 ${summary.versions} 个版本、${summary.uploads} 条上传记录、${summary.annotations} 条批注`)
      return summary
    }
    case 'product.accessCode': {
      const product = findProduct(state, payload.productId ?? payload.id)
      requireManager(actor, product)
      product.accessCode = text(payload.accessCode, 'accessCode', { max: 64 })
      product.accessCodeExpiresAt = accessCodeExpiry(payload.accessCodeExpiresAt ?? payload.expiresAt)
      product.codeVersion += 1
      product.updatedAt = isoNow()
      audit(state, actor.id, type, 'product', product.id, product.name, product.accessCodeExpiresAt ? `更新访问码，有效期至 ${product.accessCodeExpiresAt}；已有成员授权保留` : '更新访问码为长期有效；已有成员授权保留')
      return sanitizeProduct(product, actor)
    }
    case 'product.memberAdd': {
      const product = findProduct(state, payload.productId ?? payload.id)
      requireManager(actor, product)
      const user = findUser(state, payload.userId)
      if (!user.enabled) fail(409, 'ACCOUNT_DISABLED', '不能授权已停用用户')
      product.members = product.members.filter((member) => member.userId !== user.id)
      product.members.push({ userId: user.id, source: 'manual', grantedAt: isoNow(), codeVersion: product.codeVersion })
      product.revokedMembers = (product.revokedMembers ?? []).filter((item) => !(item.userId === user.id && item.codeVersion === product.codeVersion))
      product.updatedAt = isoNow()
      audit(state, actor.id, type, 'product', product.id, product.name, `授权成员 ${user.name}`)
      return sanitizeProduct(product, actor)
    }
    case 'product.memberRevoke': {
      const product = findProduct(state, payload.productId ?? payload.id)
      requireManager(actor, product)
      if (payload.userId === product.ownerId) fail(400, 'CANNOT_REVOKE_OWNER', '不能收回产品负责人的权限')
      const user = findUser(state, payload.userId)
      product.members = product.members.filter((member) => member.userId !== user.id)
      product.revokedMembers ??= []
      product.revokedMembers.push({ userId: user.id, codeVersion: product.codeVersion, revokedAt: isoNow() })
      product.updatedAt = isoNow()
      audit(state, actor.id, type, 'product', product.id, product.name, `收回成员 ${user.name} 的权限`)
      return sanitizeProduct(product, actor)
    }
    case 'product.reviewState': {
      const product = findProduct(state, payload.productId ?? payload.id)
      requireManager(actor, product)
      if (!REVIEW_STATES.has(payload.reviewState)) fail(400, 'VALIDATION_ERROR', '评审状态不正确')
      if (payload.reviewState === 'completed') {
        const unresolvedCount = state.annotations.filter((annotation) => (
          annotation.productId === product.id
          && annotation.version === product.currentVersion
          && !annotation.deleted
          && ['open', 'needs-relocation'].includes(annotation.status)
        )).length
        if (unresolvedCount > 0) {
          fail(409, 'UNRESOLVED_ANNOTATIONS', `当前版本仍有 ${unresolvedCount} 条未解决或待定位批注`)
        }
      }
      product.reviewState = payload.reviewState
      product.updatedAt = isoNow()
      audit(state, actor.id, type, 'product', product.id, product.name, `评审状态变更为 ${payload.reviewState}`)
      return sanitizeProduct(product, actor)
    }
    case 'product.rollback': {
      const product = findProduct(state, payload.productId ?? payload.id)
      requireManager(actor, product)
      const version = product.versions.find((item) => item.version === payload.version)
      if (!version) fail(404, 'VERSION_NOT_FOUND', '目标版本不存在')
      product.versions.forEach((item) => { item.isCurrent = item.id === version.id })
      product.currentVersion = version.version
      product.reviewState = 'pending'
      product.updatedAt = isoNow()
      audit(state, actor.id, type, 'version', version.id, product.name, `回滚到版本 ${version.version}`)
      return sanitizeProduct(product, actor)
    }
    case 'product.copyAccessCode': {
      const product = findProduct(state, payload.productId ?? payload.id)
      requireManager(actor, product)
      audit(state, actor.id, type, 'product', product.id, product.name, '复制产品访问码')
      return { accessCode: product.accessCode, codeVersion: product.codeVersion }
    }
    case 'systemRelease.create': {
      requireAdmin(actor)
      const version = text(payload.version || shanghaiVersion(), 'version', { max: 40 })
      if (state.systemReleases.some((item) => item.version === version)) fail(409, 'VERSION_EXISTS', '该系统版本号已存在')
      const now = isoNow()
      const release = {
        id: `system-release-${randomUUID()}`,
        version,
        title: text(payload.title, 'title', { max: 120 }),
        content: text(payload.content, 'content', { max: 10_000 }),
        releasedAt: payload.releasedAt ? dateTimeValue(payload.releasedAt) : now,
        authorId: actor.id,
        createdAt: now
      }
      state.systemReleases.unshift(release)
      audit(state, actor.id, type, 'systemRelease', release.id, release.title, `发布系统版本 ${release.version}`)
      return release
    }
    case 'systemRelease.update': {
      requireAdmin(actor)
      const release = state.systemReleases.find((item) => item.id === (payload.releaseId ?? payload.id))
      if (!release) fail(404, 'SYSTEM_RELEASE_NOT_FOUND', '系统版本记录不存在')
      const nextVersion = payload.version == null ? release.version : text(payload.version, 'version', { max: 40 })
      if (state.systemReleases.some((item) => item.id !== release.id && item.version === nextVersion)) {
        fail(409, 'VERSION_EXISTS', '该系统版本号已存在')
      }
      release.version = nextVersion
      if (payload.title != null) release.title = text(payload.title, 'title', { max: 120 })
      if (payload.content != null) release.content = text(payload.content, 'content', { max: 10_000 })
      if (payload.releasedAt != null) release.releasedAt = dateTimeValue(payload.releasedAt)
      release.updatedAt = isoNow()
      audit(state, actor.id, type, 'systemRelease', release.id, release.title, `更新系统版本 ${release.version}`)
      return release
    }
    case 'systemRelease.delete': {
      requireAdmin(actor)
      const release = state.systemReleases.find((item) => item.id === (payload.releaseId ?? payload.id))
      if (!release) fail(404, 'SYSTEM_RELEASE_NOT_FOUND', '系统版本记录不存在')
      state.systemReleases = state.systemReleases.filter((item) => item.id !== release.id)
      audit(state, actor.id, type, 'systemRelease', release.id, release.title, `删除系统版本 ${release.version}`)
      return release
    }
    case 'annotation.create': {
      const product = findProduct(state, payload.productId)
      requireViewer(actor, product)
      const version = payload.version || product.currentVersion
      if (version !== product.currentVersion) fail(409, 'HISTORICAL_READ_ONLY', '历史版本仅支持查看')
      const annotation = {
        id: `annotation-${randomUUID()}`, productId: product.id, version, authorId: actor.id,
        content: text(payload.content, 'content', { max: 5000 }), status: 'open', anchor: validateAnchor(payload.anchor),
        createdAt: isoNow(), attachments: imageAttachments(payload.attachments), replies: []
      }
      state.annotations.unshift(annotation)
      if (product.reviewState === 'completed') {
        product.reviewState = 'reviewing'
        product.updatedAt = isoNow()
      }
      audit(state, actor.id, type, 'annotation', annotation.id, product.name, '新增批注')
      return annotation
    }
    case 'annotation.update': {
      const annotation = findAnnotation(state, payload.annotationId ?? payload.id)
      const product = findProduct(state, annotation.productId)
      requireViewer(actor, product)
      if (annotation.version !== product.currentVersion) fail(409, 'HISTORICAL_READ_ONLY', '历史版本仅支持查看')
      if (!isAdmin(actor) && annotation.authorId !== actor.id) fail(403, 'FORBIDDEN', '只能编辑自己的批注')
      if (payload.content != null) annotation.content = text(payload.content, 'content', { max: 5000 })
      if (payload.attachments != null) annotation.attachments = imageAttachments(payload.attachments)
      annotation.updatedAt = isoNow()
      audit(state, actor.id, type, 'annotation', annotation.id, product.name, '编辑批注')
      return annotation
    }
    case 'annotation.delete': {
      const annotation = findAnnotation(state, payload.annotationId ?? payload.id)
      const product = findProduct(state, annotation.productId)
      requireViewer(actor, product)
      if (annotation.version !== product.currentVersion) fail(409, 'HISTORICAL_READ_ONLY', '历史版本仅支持查看')
      if (!isAdmin(actor) && annotation.authorId !== actor.id) fail(403, 'FORBIDDEN', '只能删除自己的批注')
      annotation.deleted = true
      annotation.updatedAt = isoNow()
      audit(state, actor.id, type, 'annotation', annotation.id, product.name, '逻辑删除批注')
      return annotation
    }
    case 'annotation.status': {
      const annotation = findAnnotation(state, payload.annotationId ?? payload.id)
      const product = findProduct(state, annotation.productId)
      requireViewer(actor, product)
      if (annotation.version !== product.currentVersion) fail(409, 'HISTORICAL_READ_ONLY', '历史版本仅支持查看')
      if (!ANNOTATION_STATES.has(payload.status)) fail(400, 'VALIDATION_ERROR', '批注状态不正确')
      if (!canManage(actor, product) && annotation.authorId !== actor.id) fail(403, 'FORBIDDEN', '只有批注作者、产品负责人或超级管理员可以处理批注状态')
      annotation.status = payload.status
      annotation.updatedAt = isoNow()
      audit(state, actor.id, type, 'annotation', annotation.id, product.name, `批注状态变更为 ${payload.status}`)
      return annotation
    }
    case 'reply.create': {
      const annotation = findAnnotation(state, payload.annotationId ?? payload.id)
      const product = findProduct(state, annotation.productId)
      requireViewer(actor, product)
      if (annotation.version !== product.currentVersion) fail(409, 'HISTORICAL_READ_ONLY', '历史版本仅支持查看')
      const reply = {
        id: `reply-${randomUUID()}`,
        authorId: actor.id,
        content: text(payload.content, 'content', { max: 5000 }),
        attachments: imageAttachments(payload.attachments),
        createdAt: isoNow()
      }
      annotation.replies.push(reply)
      annotation.updatedAt = isoNow()
      audit(state, actor.id, type, 'reply', reply.id, product.name, '回复批注')
      return reply
    }
    case 'reply.update':
    case 'reply.delete': {
      const annotation = findAnnotation(state, payload.annotationId ?? payload.threadId)
      const product = findProduct(state, annotation.productId)
      requireViewer(actor, product)
      if (annotation.version !== product.currentVersion) fail(409, 'HISTORICAL_READ_ONLY', '历史版本仅支持查看')
      const reply = annotation.replies.find((item) => item.id === payload.replyId && !item.deleted)
      if (!reply) fail(404, 'REPLY_NOT_FOUND', '回复不存在')
      if (!isAdmin(actor) && reply.authorId !== actor.id) fail(403, 'FORBIDDEN', '只能管理自己的回复')
      if (type === 'reply.update') {
        if (payload.content != null) reply.content = text(payload.content, 'content', { max: 5000 })
        if (payload.attachments != null) reply.attachments = imageAttachments(payload.attachments)
      } else reply.deleted = true
      reply.updatedAt = isoNow()
      annotation.updatedAt = isoNow()
      audit(state, actor.id, type, 'reply', reply.id, product.name, type === 'reply.update' ? '编辑回复' : '逻辑删除回复')
      return reply
    }
    default:
      fail(400, 'UNKNOWN_ACTION', '不支持的操作类型')
  }
}

async function fileExists(target) {
  try { return (await stat(target)).isFile() } catch { return false }
}

function nextVersion(product) {
  let now = new Date()
  let version = shanghaiVersion(now)
  while (product?.versions.some((item) => item.version === version)) {
    now = new Date(now.getTime() + 1000)
    version = shanghaiVersion(now)
  }
  return version
}

export async function createPrototypeReviewApp(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? DEFAULT_ROOT)
  const dataDir = path.resolve(options.dataDir ?? process.env.PROTOTYPE_REVIEW_DATA_DIR ?? path.join(rootDir, 'data'))
  const distDir = path.resolve(options.distDir ?? path.join(rootDir, 'dist'))
  const publicDir = path.resolve(options.publicDir ?? path.join(rootDir, 'public'))
  const tempDir = path.join(dataDir, 'temp')
  const store = options.store ?? await new JsonStore(dataDir).init({ demoDir: path.join(publicDir, 'demo') })
  await mkdir(tempDir, { recursive: true })
  const upload = multer({ dest: tempDir, limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } })
  const app = express()
  const secureCookie = options.secureCookie ?? process.env.NODE_ENV === 'production'
  const previewCapabilitySecret = capabilitySecret(options.capabilitySecret)
  const requestedCapabilityTtl = Number(options.capabilityTtlMs ?? DEFAULT_CAPABILITY_TTL_MS)
  if (!Number.isFinite(requestedCapabilityTtl) || requestedCapabilityTtl <= 0) {
    throw new TypeError('Prototype capability TTL must be a positive number')
  }
  const previewCapabilityTtl = Math.min(Math.floor(requestedCapabilityTtl), MAX_CAPABILITY_TTL_MS)
  const capabilityClock = typeof options.capabilityNow === 'function' ? options.capabilityNow : Date.now
  const sourceBuilder = options.sourceBuilder ?? buildTrustedNextSource
  const allowSourceBuilds = options.allowSourceBuilds ?? process.env.PROTOTYPE_ALLOW_SOURCE_BUILDS !== '0'
  let publishQueue = Promise.resolve()

  app.disable('x-powered-by')
  app.use(express.json({ limit: '20mb' }))

  app.get('/api/health', (_req, res) => res.json({
    ok: true,
    data: { status: 'ok', app: 'product-collaboration-platform', pid: process.pid, time: isoNow() }
  }))

  app.post('/api/auth/login', async (req, res, next) => {
    try {
      const username = text(req.body?.username, 'username', { max: 80 }).toLowerCase()
      const password = text(req.body?.password, 'password', { max: 256 })
      const remember = Boolean(req.body?.remember)
      const snapshot = store.read()
      const user = snapshot.users.find((item) => item.username.toLowerCase() === username)
      if (!user || !user.enabled || !await verifyPassword(password, user)) fail(401, 'INVALID_CREDENTIALS', '账号或密码不正确')
      const token = randomBytes(32).toString('base64url')
      const maxAge = remember ? 30 * 24 * 60 * 60 * 1000 : 8 * 60 * 60 * 1000
      await store.mutate((state) => {
        state.sessions = state.sessions.filter((session) => new Date(session.expiresAt).getTime() > Date.now())
        state.sessions.push({ id: randomUUID(), tokenHash: tokenHash(token), userId: user.id, createdAt: isoNow(), expiresAt: new Date(Date.now() + maxAge).toISOString(), remember })
        audit(state, user.id, 'auth.login', 'user', user.id, user.name, remember ? '登录并保持 30 天' : '登录 8 小时')
        return null
      })
      res.setHeader('Set-Cookie', sessionCookie(token, maxAge, secureCookie))
      const committed = store.read()
      res.json({ ok: true, data: bootstrapFor(committed, findUser(committed, user.id)) })
    } catch (error) { next(error) }
  })

  async function authenticate(req, _res, next) {
    try {
      const token = parseCookies(req.headers.cookie)[COOKIE_NAME]
      if (!token) fail(401, 'UNAUTHENTICATED', '请先登录')
      const snapshot = store.read()
      const session = snapshot.sessions.find((item) => item.tokenHash === tokenHash(token) && new Date(item.expiresAt).getTime() > Date.now())
      if (!session) fail(401, 'SESSION_EXPIRED', '登录状态已失效')
      const user = snapshot.users.find((item) => item.id === session.userId && item.enabled)
      if (!user) fail(401, 'ACCOUNT_DISABLED', '账号不可用')
      req.auth = { userId: user.id, sessionId: session.id, tokenHash: session.tokenHash }
      next()
    } catch (error) { next(error) }
  }

  app.post('/api/auth/logout', authenticate, async (req, res, next) => {
    try {
      await store.mutate((state) => {
        const user = findUser(state, req.auth.userId)
        state.sessions = state.sessions.filter((session) => session.id !== req.auth.sessionId)
        audit(state, user.id, 'auth.logout', 'user', user.id, user.name, '退出当前设备')
        return null
      })
      res.setHeader('Set-Cookie', clearCookie(secureCookie))
      res.json({ ok: true, data: { loggedOut: true } })
    } catch (error) { next(error) }
  })

  app.get('/api/bootstrap', authenticate, (req, res, next) => {
    try {
      const state = store.read()
      const user = findUser(state, req.auth.userId)
      res.json({ ok: true, data: bootstrapFor(state, user) })
    } catch (error) { next(error) }
  })

  app.post('/api/prototype-capability', authenticate, (req, res, next) => {
    try {
      const productId = text(req.body?.productId, 'productId', { max: 500 })
      const releaseVersion = text(req.body?.version, 'version', { max: 80 })
      const state = store.read()
      const user = findUser(state, req.auth.userId)
      const product = findProduct(state, productId)
      requireViewer(user, product)
      const version = product.versions.find((item) => item.version === releaseVersion)
      if (!version) fail(404, 'VERSION_NOT_FOUND', '版本不存在')
      const issuedAt = Math.floor(capabilityClock())
      const boundSession = state.sessions.find((item) => item.id === req.auth.sessionId && item.userId === user.id)
      const sessionExpiresAt = boundSession ? new Date(boundSession.expiresAt).getTime() : 0
      const expiresAt = Math.min(issuedAt + previewCapabilityTtl, sessionExpiresAt)
      if (!Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
        fail(401, 'SESSION_EXPIRED', '登录状态已失效')
      }
      const token = signCapability({
        version: 1,
        productId: product.id,
        releaseVersion: version.version,
        userId: user.id,
        sessionId: req.auth.sessionId,
        issuedAt,
        expiresAt,
        nonce: randomBytes(12).toString('base64url'),
      }, previewCapabilitySecret)
      const entryPath = versionEntryPath(version, product.id, version.version)
        .split('/').map((segment) => encodeURIComponent(segment)).join('/')
      const baseUrl = `/prototype-cap/${encodeURIComponent(token)}/${encodeURIComponent(product.id)}/${encodeURIComponent(version.version)}/`
      res.setHeader('Cache-Control', 'no-store')
      res.json({ ok: true, data: { url: `${baseUrl}${entryPath}`, expiresAt: new Date(expiresAt).toISOString() } })
    } catch (error) { next(error) }
  })

  app.post('/api/action', authenticate, async (req, res, next) => {
    const type = typeof req.body?.type === 'string' ? req.body.type : ''
    try {
      if (!type) fail(400, 'VALIDATION_ERROR', '缺少操作类型')
      const result = await store.mutate((state) => executeAction(state, req.auth.userId, type, req.body?.payload))
      if (type === 'product.purge' && result?.id && /^[A-Za-z0-9_-]+$/.test(result.id)) {
        await Promise.all([
          rm(path.join(store.releaseRoot, result.id), { recursive: true, force: true }),
          rm(path.join(store.gitRoot, result.id), { recursive: true, force: true }),
        ])
      }
      res.json({ ok: true, data: result })
    } catch (error) {
      if (type) {
        await store.mutate((state) => {
          const user = state.users.find((item) => item.id === req.auth.userId)
          if (user) audit(state, user.id, type, 'action', type, type, error.message, 'failed')
          return null
        }).catch(() => {})
      }
      next(error)
    }
  })

  app.post('/api/upload', authenticate, upload.single('file'), async (req, res, next) => {
    const run = publishQueue.then(async () => {
      const file = req.file
      if (!file) fail(400, 'FILE_REQUIRED', '请选择 HTML、ZIP、TAR.GZ 或 TGZ 文件')
      let releaseDir = null
      let sourceDir = null
      let gitSnapshot = null
      try {
        const snapshot = store.read()
        const actor = findUser(snapshot, req.auth.userId)
        requireUploader(actor)
        const existing = req.body.productId ? findProduct(snapshot, req.body.productId) : null
        if (existing) requireManager(actor, existing)
        const productId = existing?.id ?? `product-${randomUUID()}`
        const productName = existing?.name ?? text(req.body.name, 'name', { max: 120 })
        const version = nextVersion(existing)
        releaseDir = path.join(store.releaseRoot, productId, version)
        const fileName = file.originalname.toLowerCase()
        const extension = path.extname(fileName)
        let entryPath = 'index.html'
        await mkdir(path.dirname(releaseDir), { recursive: true })
        if (extension === '.html' || extension === '.htm') {
          await mkdir(releaseDir, { recursive: true })
          await normalizeHtmlFile(file.path, path.join(releaseDir, 'index.html'))
        } else if (extension === '.zip') {
          await extractZipSafely(file.path, releaseDir)
        } else if (fileName.endsWith('.tar.gz') || fileName.endsWith('.tgz')) {
          sourceDir = path.join(tempDir, `source-${randomUUID()}`)
          await extractTarSafely(file.path, sourceDir, { portableNames: true })
          const staticRoot = await staticArchiveRoot(sourceDir)
          if (staticRoot) {
            await cp(staticRoot, releaseDir, { recursive: true, errorOnExist: true, force: false })
          } else {
            if (!allowSourceBuilds) throw new Error('当前环境未开启源码包构建')
            const buildResult = await sourceBuilder(sourceDir, releaseDir)
            if (!buildResult) throw new Error('压缩包中未找到可发布的 HTML、Vite 构建产物或 Next.js 源码项目')
            entryPath = safePublishedEntry(releaseDir, buildResult.entryPath)
          }
        } else {
          throw new Error('仅支持 HTML、ZIP、TAR.GZ 或 TGZ 文件')
        }

        const entryTarget = path.resolve(releaseDir, entryPath)
        const resolvedEntry = await fileExists(entryTarget)
          ? entryTarget
          : (!path.extname(entryTarget) && await fileExists(`${entryTarget}.html`) ? `${entryTarget}.html` : '')
        if (!resolvedEntry) throw new Error('发布包缺少可访问的入口页面')

        gitSnapshot = await createGitSnapshot({ gitRoot: store.gitRoot, productId, version, sourceDir: releaseDir })

        const result = await store.mutate((state) => {
          const currentActor = findUser(state, actor.id)
          requireUploader(currentActor)
          let product = state.products.find((item) => item.id === productId)
          if (product) requireManager(currentActor, product)
          if (!product) {
            const input = productInput(req.body, currentActor, state)
            const now = isoNow()
            product = { id: productId, ...input, codeVersion: 1, state: 'draft', reviewState: 'pending', currentVersion: '', createdAt: now, updatedAt: now, members: [], versions: [], revokedMembers: [] }
            state.products.unshift(product)
          } else {
            for (const [key, max] of [['name', 120], ['manager', 80], ['description', 1000], ['longNote', 5000]]) {
              if (req.body[key] != null) product[key] = text(req.body[key], key, { optional: key === 'description' || key === 'longNote', max }) ?? ''
            }
            const hasAccessCode = req.body.accessCode != null && req.body.accessCode !== ''
            const hasExpiry = Object.hasOwn(req.body, 'accessCodeExpiresAt') || Object.hasOwn(req.body, 'expiresAt')
            const nextAccessCode = hasAccessCode ? text(req.body.accessCode, 'accessCode', { max: 64 }) : product.accessCode
            const nextExpiry = hasExpiry ? accessCodeExpiry(req.body.accessCodeExpiresAt ?? req.body.expiresAt) : (product.accessCodeExpiresAt ?? null)
            if (nextAccessCode !== product.accessCode || nextExpiry !== (product.accessCodeExpiresAt ?? null)) {
              product.accessCode = nextAccessCode
              product.accessCodeExpiresAt = nextExpiry
              product.codeVersion += 1
            }
          }
          const previousVersion = product.currentVersion
          const annotationsToMigrate = previousVersion
            ? state.annotations.filter((annotation) => (
              annotation.productId === product.id
              && annotation.version === previousVersion
              && !annotation.deleted
              && ['open', 'needs-relocation'].includes(annotation.status)
            ))
            : []
          product.versions.forEach((item) => { item.isCurrent = false })
          const record = {
            id: `version-${randomUUID()}`, version, note: String(req.body.note ?? ''), uploaderId: currentActor.id,
            createdAt: isoNow(), fileName: file.originalname, fileSize: file.size,
            entryUrl: versionEntryUrl(product.id, version, entryPath), isCurrent: true,
            gitTag: gitSnapshot.gitTag, gitCommit: gitSnapshot.gitCommit
          }
          product.versions.unshift(record)
          product.currentVersion = version
          product.state = 'online'
          product.reviewState = 'pending'
          product.updatedAt = isoNow()
          const migratedAt = isoNow()
          const migratedAnnotations = annotationsToMigrate.map((annotation) => ({
            ...structuredClone(annotation),
            id: `annotation-${randomUUID()}`,
            originId: annotation.originId ?? annotation.id,
            version,
            createdAt: migratedAt,
            updatedAt: undefined,
            replies: (annotation.replies ?? []).filter((reply) => !reply.deleted).map((reply) => ({
              ...structuredClone(reply),
              id: `reply-${randomUUID()}`,
              originId: reply.originId ?? reply.id,
              createdAt: migratedAt,
              updatedAt: undefined
            }))
          }))
          state.annotations.unshift(...migratedAnnotations)
          const uploadRecord = {
            id: `upload-${randomUUID()}`, productId: product.id, productName: product.name, fileName: file.originalname,
            uploaderId: currentActor.id, createdAt: isoNow(), status: 'success', version
          }
          state.uploads.unshift(uploadRecord)
          audit(state, currentActor.id, 'product.publish', 'version', record.id, product.name, `发布版本 ${version}，迁移 ${migratedAnnotations.length} 条未解决批注`)
          return { product: sanitizeProduct(product, currentActor), upload: uploadRecord, version: record }
        })
        return result
      } catch (error) {
        console.error(`[prototype-upload] ${file.originalname}:`, error)
        const failureMessage = typeof error?.message === 'string' && error.message.startsWith('HTML 文件')
          ? error.message
          : '发布失败'
        if (gitSnapshot) await gitSnapshot.rollback().catch(() => {})
        if (releaseDir) await rm(releaseDir, { recursive: true, force: true }).catch(() => {})
        await store.mutate((state) => {
          const actor = state.users.find((item) => item.id === req.auth.userId)
          if (!actor) return null
          const product = req.body.productId ? state.products.find((item) => item.id === req.body.productId) : null
          const productId = product?.id ?? ''
          const productName = product?.name ?? String(req.body.name ?? '未创建产品')
          const uploadRecord = { id: `upload-${randomUUID()}`, productId, productName, fileName: file.originalname, uploaderId: actor.id, createdAt: isoNow(), status: 'failed', error: failureMessage }
          state.uploads.unshift(uploadRecord)
          audit(state, actor.id, 'product.publish', 'product', productId, productName, failureMessage, 'failed')
          return null
        }).catch(() => {})
        if (error instanceof ApiError) throw error
        fail(400, 'PUBLISH_FAILED', failureMessage)
      } finally {
        await rm(file.path, { force: true }).catch(() => {})
        if (sourceDir) await rm(sourceDir, { recursive: true, force: true }).catch(() => {})
      }
    })
    publishQueue = run.then(() => undefined, () => undefined)
    try { res.json({ ok: true, data: await run }) } catch (error) { next(error) }
  })

  app.use('/prototype-cap/:capability/:productId/:version', async (req, res, next) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') fail(405, 'METHOD_NOT_ALLOWED', '安全预览仅支持读取')
      const now = Math.floor(capabilityClock())
      const capability = verifyCapability(req.params.capability, previewCapabilitySecret, now)
      if (capability.productId !== req.params.productId || capability.releaseVersion !== req.params.version) {
        fail(403, 'PREVIEW_SCOPE_MISMATCH', '安全预览凭证与请求资源不匹配')
      }
      const state = store.read()
      const session = state.sessions.find((item) => (
        item.id === capability.sessionId
        && item.userId === capability.userId
        && new Date(item.expiresAt).getTime() > now
      ))
      if (!session) fail(401, 'PREVIEW_SESSION_REVOKED', '安全预览会话已失效，请刷新后重试')
      const user = state.users.find((item) => item.id === capability.userId && item.enabled)
      if (!user) fail(401, 'ACCOUNT_DISABLED', '账号不可用')
      const product = findProduct(state, capability.productId)
      requireViewer(user, product)
      if (!product.versions.some((item) => item.version === capability.releaseVersion)) {
        fail(404, 'VERSION_NOT_FOUND', '版本不存在')
      }
      const target = await servedReleaseTarget(store.releaseRoot, product.id, capability.releaseVersion, req.path)
      if (!await fileExists(target)) fail(404, 'FILE_NOT_FOUND', '原型文件不存在')
      if (req.headers.origin === 'null') {
        res.setHeader('Access-Control-Allow-Origin', 'null')
        res.vary('Origin')
      }
      res.setHeader('Cache-Control', 'private, no-store')
      res.setHeader('Referrer-Policy', 'no-referrer')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Content-Security-Policy', "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads; object-src 'none'; base-uri 'self'")
      if (['.html', '.htm'].includes(path.extname(target).toLowerCase())) {
        const html = await readHtmlFile(target)
        res.type('html').send(injectReviewBridge(html, { moduleCrossorigin: 'anonymous' }))
        return
      }
      res.sendFile(target)
    } catch (error) { next(error) }
  })

  app.use('/prototype-files/:productId/:version', authenticate, async (req, res, next) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') fail(405, 'METHOD_NOT_ALLOWED', '不支持该请求方法')
      const state = store.read()
      const user = findUser(state, req.auth.userId)
      const product = findProduct(state, req.params.productId)
      requireViewer(user, product)
      if (!product.versions.some((item) => item.version === req.params.version)) fail(404, 'VERSION_NOT_FOUND', '版本不存在')
      const target = await servedReleaseTarget(store.releaseRoot, product.id, req.params.version, req.path)
      if (!await fileExists(target)) fail(404, 'FILE_NOT_FOUND', '原型文件不存在')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Content-Security-Policy', "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads; object-src 'none'; base-uri 'self'")
      if (['.html', '.htm'].includes(path.extname(target).toLowerCase())) {
        const html = await readHtmlFile(target)
        res.type('html').send(injectReviewBridge(html))
        return
      }
      res.sendFile(target)
    } catch (error) { next(error) }
  })

  try {
    await access(distDir)
    app.use(express.static(distDir, { index: false }))
    app.use((req, res, next) => {
      if (req.method === 'GET' && !req.path.startsWith('/api/') && !req.path.startsWith('/prototype-files/') && !req.path.startsWith('/prototype-cap/')) {
        return res.sendFile(path.join(distDir, 'index.html'))
      }
      next()
    })
  } catch {}

  app.use((req, _res, next) => next(new ApiError(404, 'NOT_FOUND', '请求的资源不存在')))
  app.use((error, _req, res, _next) => {
    if (error instanceof multer.MulterError) {
      return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ ok: false, error: { code: error.code, message: '上传失败' } })
    }
    const status = Number.isInteger(error?.status) ? error.status : 500
    if (status >= 500) console.error(error)
    res.status(status).json({ ok: false, error: { code: error?.code ?? 'INTERNAL_ERROR', message: status >= 500 ? '服务器处理失败' : error.message, ...(error?.fields ? { fields: error.fields } : {}) } })
  })

  return { app, store }
}

export { ApiError, bootstrapFor, executeAction }
