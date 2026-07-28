import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { gzipSync } from 'node:zlib'

import { createPrototypeReviewApp } from '../server/app.mjs'
import { injectReviewBridge, normalizeModuleCredentials, REVIEW_BRIDGE_SCRIPT } from '../server/review-bridge.mjs'

async function fixture(options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'prototype-review-server-'))
  const { app, store } = await createPrototypeReviewApp({ dataDir, secureCookie: false, ...options })
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance))
  })
  const base = `http://127.0.0.1:${server.address().port}`

  async function request(url, options = {}) {
    const headers = new Headers(options.headers)
    if (options.cookie) headers.set('cookie', options.cookie)
    let body = options.body
    if (body && !(body instanceof FormData) && typeof body !== 'string') {
      headers.set('content-type', 'application/json')
      body = JSON.stringify(body)
    }
    const response = await fetch(`${base}${url}`, { method: options.method ?? (body ? 'POST' : 'GET'), headers, body })
    const contentType = response.headers.get('content-type') ?? ''
    const data = contentType.includes('application/json') ? await response.json() : await response.text()
    return { response, data, cookie: response.headers.get('set-cookie')?.split(';', 1)[0] }
  }

  async function login(username, password, remember = false) {
    const result = await request('/api/auth/login', { body: { username, password, remember } })
    assert.equal(result.response.status, 200, JSON.stringify(result.data))
    assert.ok(result.cookie)
    return result.cookie
  }

  return {
    dataDir, store, base, request, login,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      await rm(dataDir, { recursive: true, force: true })
    }
  }
}

function action(type, payload = {}) {
  return { body: { type, payload } }
}

test('review bridge injection is idempotent, comment-safe, quote-aware and normalizes module credentials', () => {
  const source = '<!-- <head>伪标签</head> --><html><head data-note="a>b"><script src="classic.js"></script></head><body></body></html>'
  const injected = injectReviewBridge(source)
  assert.match(injected, /^<script data-prototype-review-bridge="1">/)
  assert.ok(injected.indexOf('data-prototype-review-bridge="1"') < injected.indexOf('src="classic.js"'))
  assert.equal((injectReviewBridge(injected).match(/data-prototype-review-bridge="1"/g) ?? []).length, 1)
  assert.equal(injectReviewBridge(injected), injected)

  const withoutHead = injectReviewBridge('<!doctype html><html><body>页面</body></html>')
  assert.match(withoutHead, /^<!doctype html><script data-prototype-review-bridge="1">/i)

  const fakeMarker = injectReviewBridge('<!doctype html><html><head><script data-prototype-review-bridge="1"></script></head></html>')
  assert.equal((fakeMarker.match(/data-prototype-review-bridge="1"/g) ?? []).length, 2)
  assert.match(fakeMarker, /^<!doctype html><script data-prototype-review-bridge="1">/i)

  const trustedTag = `<script data-prototype-review-bridge="1">${REVIEW_BRIDGE_SCRIPT}</script>`
  const buriedTrustedTag = injectReviewBridge(`<!--${trustedTag}--><html><head></head><body></body></html>`)
  assert.match(buriedTrustedTag, /^<script data-prototype-review-bridge="1">/)
  assert.equal((buriedTrustedTag.match(/data-prototype-review-bridge="1"/g) ?? []).length, 2)

  const preHeadScript = injectReviewBridge('<!doctype html><script>window.preHead = true</script><html><head></head></html>')
  assert.ok(preHeadScript.indexOf('new MessageChannel()') < preHeadScript.indexOf('window.preHead = true'))
  assert.match(REVIEW_BRIDGE_SCRIPT, /function viewIdentity\(\)/)
  assert.match(REVIEW_BRIDGE_SCRIPT, /view: viewIdentity\(\)/)
  assert.match(REVIEW_BRIDGE_SCRIPT, /aria-selected="true"/)
  assert.match(REVIEW_BRIDGE_SCRIPT, /function installStorageShim\(name\)/)
  assert.match(REVIEW_BRIDGE_SCRIPT, /installStorageShim\('localStorage'\)/)
  assert.match(REVIEW_BRIDGE_SCRIPT, /installStorageShim\('sessionStorage'\)/)

  const rawText = normalizeModuleCredentials('<xmp><script type="module" src="fake.js"></script></xmp><script type="module" src="real.js" crossorigin defer></script>')
  assert.doesNotMatch(rawText.slice(0, rawText.indexOf('</xmp>')), /use-credentials/)
  assert.match(rawText.slice(rawText.indexOf('</xmp>')), /crossorigin="use-credentials" defer/)

  const modules = normalizeModuleCredentials([
    '<link rel="modulepreload" href="./assets/chunk.js" crossorigin="anonymous">',
    '<script type="module" src="./assets/app.js"></script>',
  ].join(''))
  assert.equal((modules.match(/crossorigin="use-credentials"/g) ?? []).length, 2)
  assert.doesNotMatch(modules, /crossorigin="anonymous"/)
})

function gitOutput(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.once('error', reject)
    child.once('close', (code) => code === 0
      ? resolve(Buffer.concat(stdout).toString('utf8').trim())
      : reject(new Error(Buffer.concat(stderr).toString('utf8').trim())))
  })
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function makeStoredZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [entryName, value] of Object.entries(entries)) {
    const name = Buffer.from(entryName)
    const data = Buffer.from(value)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + data.length
  }
  const centralData = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(entries).length, 8)
  end.writeUInt16LE(Object.keys(entries).length, 10)
  end.writeUInt32LE(centralData.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralData, end])
}

function makeTarGzip(entries) {
  const chunks = []
  for (const [name, value] of Object.entries(entries)) {
    const data = Buffer.from(value)
    const header = Buffer.alloc(512)
    Buffer.from(name).copy(header)
    for (const [offset, length, number] of [[100, 8, 0o644], [108, 8, 0], [116, 8, 0], [124, 12, data.length], [136, 12, 0]]) {
      const octal = Number(number).toString(8).padStart(length - 1, '0')
      header.write(octal, offset, length - 1, 'ascii')
    }
    header.fill(0x20, 148, 156)
    header[156] = '0'.charCodeAt(0)
    header.write('ustar\0', 257, 6, 'ascii')
    header.write('00', 263, 2, 'ascii')
    let checksum = 0
    for (const byte of header) checksum += byte
    header.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii')
    header[154] = 0
    header[155] = 0x20
    chunks.push(header, data)
    const padding = (512 - (data.length % 512)) % 512
    if (padding) chunks.push(Buffer.alloc(padding))
  }
  chunks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(chunks))
}

test('authentication, bootstrap filtering, protected seed prototype and logout form a real session flow', async (t) => {
  const fx = await fixture()
  t.after(() => fx.close())

  const health = await fx.request('/api/health')
  assert.equal(health.response.status, 200)
  assert.equal(health.data.data.status, 'ok')

  assert.equal((await fx.request('/api/bootstrap')).response.status, 401)
  assert.equal((await fx.request('/api/auth/login', { body: { username: 'admin', password: 'wrong-password' } })).response.status, 401)

  const adminLogin = await fx.request('/api/auth/login', { body: { username: 'admin', password: 'admin123', remember: true } })
  assert.match(adminLogin.response.headers.get('set-cookie'), /Max-Age=2592000/)
  assert.equal(adminLogin.data.data.currentUser.role, 'admin')
  const adminCookie = adminLogin.cookie
  const adminBootstrap = await fx.request('/api/bootstrap', { cookie: adminCookie })
  assert.equal(adminBootstrap.data.ok, true)
  assert.equal(adminBootstrap.data.data.currentUser.role, 'admin')
  assert.equal(adminBootstrap.data.data.users.find((user) => user.id === 'user-alex').username, 'alex')
  assert.ok(adminBootstrap.data.data.products.every((product) => product.accessCode))

  const linCookie = await fx.login('lin', 'review123')
  const linBootstrap = await fx.request('/api/bootstrap', { cookie: linCookie })
  assert.deepEqual(linBootstrap.data.data.products.map((product) => product.id), ['product-customer-center'])
  assert.equal(linBootstrap.data.data.products[0].accessCode, '')
  assert.ok(linBootstrap.data.data.users.every((user) => user.username === ''))

  const prototype = await fx.request('/prototype-files/product-customer-center/20260722143000/index.html', { cookie: linCookie })
  assert.equal(prototype.response.status, 200)
  assert.match(prototype.data, /<html|<!doctype/i)
  assert.match(prototype.data, /button|客户管理中心/i)
  assert.match(prototype.data, /data-prototype-review-bridge="1"/)
  assert.match(prototype.data, /prototype-review-host/)
  assert.match(prototype.data, /prototype-review-bridge/)
  assert.match(prototype.data, /new MessageChannel\(\)/)
  assert.match(prototype.data, /candidate\.addEventListener\('message'/)
  assert.match(prototype.data, /\['hello', 'hit-test', 'resolve'\]/)
  assert.doesNotMatch(prototype.response.headers.get('content-security-policy'), /allow-same-origin/)

  const logout = await fx.request('/api/auth/logout', { cookie: linCookie, body: {} })
  assert.equal(logout.data.data.loggedOut, true)
  assert.equal((await fx.request('/api/bootstrap', { cookie: linCookie })).response.status, 401)
})

test('signed preview capability is scoped, revocable, expiring and serves opaque-origin resources without cookies', async (t) => {
  let capabilityNow = Date.now()
  const fx = await fixture({
    capabilitySecret: Buffer.alloc(32, 7),
    capabilityTtlMs: 1_000,
    capabilityNow: () => capabilityNow,
  })
  t.after(() => fx.close())
  const lin = await fx.login('lin', 'review123')
  const alex = await fx.login('alex', 'product123')
  const productId = 'product-customer-center'
  const version = '20260722143000'
  const releaseDir = path.join(fx.store.releaseRoot, productId, version)
  await mkdir(path.join(releaseDir, 'assets'), { recursive: true })
  await writeFile(path.join(releaseDir, 'index.html'), '<!doctype html><html><head><link rel="modulepreload" href="./assets/app.js"><script type="module" src="./assets/app.js"></script></head><body>signed preview</body></html>')
  await writeFile(path.join(releaseDir, 'assets', 'app.js'), 'document.body.dataset.capability="loaded"')

  assert.equal((await fx.request('/api/prototype-capability', { body: { productId, version } })).response.status, 401)
  assert.equal((await fx.request('/api/prototype-capability', {
    cookie: lin,
    body: { productId: 'product-data-dashboard', version: '20260722093000' },
  })).response.status, 403)

  const auditBefore = fx.store.read().audit.length
  const issued = await fx.request('/api/prototype-capability', { cookie: lin, body: { productId, version } })
  assert.equal(issued.response.status, 200, JSON.stringify(issued.data))
  assert.match(issued.response.headers.get('cache-control'), /no-store/)
  assert.ok(new Date(issued.data.data.expiresAt).getTime() <= capabilityNow + 1_000)
  const signedUrl = new URL(issued.data.data.url, fx.base)
  assert.match(signedUrl.pathname, /^\/prototype-cap\/[^/]+\/product-customer-center\/20260722143000\/index\.html$/)
  assert.equal(signedUrl.search, '')

  const html = await fx.request(signedUrl.pathname)
  assert.equal(html.response.status, 200)
  assert.match(html.data, /data-prototype-review-bridge="1"/)
  assert.equal((html.data.match(/crossorigin="anonymous"/g) ?? []).length, 2)
  assert.doesNotMatch(html.data, /crossorigin="use-credentials"/)
  assert.doesNotMatch(html.response.headers.get('content-security-policy'), /allow-same-origin/)
  assert.equal(html.response.headers.get('referrer-policy'), 'no-referrer')

  const assetPath = new URL('./assets/app.js', signedUrl).pathname
  const asset = await fx.request(assetPath, { headers: { origin: 'null' } })
  assert.equal(asset.response.status, 200)
  assert.match(asset.data, /dataset\.capability/)
  assert.equal(asset.response.headers.get('access-control-allow-origin'), 'null')
  assert.equal(asset.response.headers.get('access-control-allow-credentials'), null)
  assert.match(asset.response.headers.get('vary'), /Origin/)
  assert.equal(asset.response.headers.get('referrer-policy'), 'no-referrer')
  assert.equal((await fx.request(assetPath, { method: 'HEAD', headers: { origin: 'null' } })).response.status, 200)
  assert.equal((await fx.request(assetPath, { method: 'POST', body: {} })).response.status, 405)

  const pathParts = signedUrl.pathname.split('/')
  const token = pathParts[2]
  const [tokenBody, tokenSignature] = token.split('.')
  const tamperedToken = `${tokenBody}.${tokenSignature[0] === 'A' ? 'B' : 'A'}${tokenSignature.slice(1)}`
  const tamperedParts = [...pathParts]
  tamperedParts[2] = tamperedToken
  assert.equal((await fx.request(tamperedParts.join('/'))).response.status, 401)
  const crossProductParts = [...pathParts]
  crossProductParts[3] = 'product-data-dashboard'
  assert.equal((await fx.request(crossProductParts.join('/'))).response.status, 403)
  const crossVersionParts = [...pathParts]
  crossVersionParts[4] = '20260721100000'
  assert.equal((await fx.request(crossVersionParts.join('/'))).response.status, 403)
  const signedDirectory = signedUrl.pathname.slice(0, signedUrl.pathname.lastIndexOf('/') + 1)
  assert.equal((await fx.request(`${signedDirectory}%2e%2e%2f%2e%2e%2fstate.json`)).response.status, 400)
  assert.equal(fx.store.read().audit.length, auditBefore)

  assert.equal((await fx.request('/api/action', {
    cookie: alex,
    ...action('product.memberRevoke', { productId, userId: 'user-lin' }),
  })).response.status, 200)
  assert.equal((await fx.request(signedUrl.pathname)).response.status, 403)
  assert.equal((await fx.request('/api/action', {
    cookie: alex,
    ...action('product.memberAdd', { productId, userId: 'user-lin' }),
  })).response.status, 200)

  const sessionBound = await fx.request('/api/prototype-capability', { cookie: lin, body: { productId, version } })
  assert.equal(sessionBound.response.status, 200)
  await fx.request('/api/auth/logout', { cookie: lin, body: {} })
  assert.equal((await fx.request(new URL(sessionBound.data.data.url, fx.base).pathname)).response.status, 401)

  const renewedSession = await fx.login('lin', 'review123')
  const expiring = await fx.request('/api/prototype-capability', { cookie: renewedSession, body: { productId, version } })
  assert.equal(expiring.response.status, 200)
  capabilityNow += 1_001
  assert.equal((await fx.request(new URL(expiring.data.data.url, fx.base).pathname)).response.status, 401)
})

test('server enforces RBAC, durable grants, ownership and all action families', async (t) => {
  const fx = await fixture()
  t.after(() => fx.close())
  const admin = await fx.login('admin', 'admin123')
  const alex = await fx.login('alex', 'product123')
  const lin = await fx.login('lin', 'review123')

  const lastAdminRole = await fx.request('/api/action', { cookie: admin, ...action('user.update', { userId: 'user-admin', role: 'user' }) })
  assert.equal(lastAdminRole.response.status, 409)
  assert.equal(lastAdminRole.data.error.code, 'LAST_ADMIN_REQUIRED')
  const lastAdminToggle = await fx.request('/api/action', { cookie: admin, ...action('user.toggle', { userId: 'user-admin', enabled: false }) })
  assert.equal(lastAdminToggle.response.status, 409)
  assert.equal(lastAdminToggle.data.error.code, 'LAST_ADMIN_REQUIRED')

  const forbiddenDraft = await fx.request('/api/action', { cookie: lin, ...action('product.saveDraft', { name: '越权产品', manager: '林悦' }) })
  assert.equal(forbiddenDraft.response.status, 403)

  const draftResult = await fx.request('/api/action', {
    cookie: alex,
    ...action('product.saveDraft', { name: '移动工作台', manager: '李经理', description: '移动端评审', longNote: '验证导航', accessCode: 'mobile2026' })
  })
  assert.equal(draftResult.response.status, 200)
  const draftId = draftResult.data.data.id
  assert.equal(draftResult.data.data.state, 'draft')

  const draftUpdate = await fx.request('/api/action', { cookie: alex, ...action('product.update', { productId: draftId, description: '更新后的说明', accessCode: 'mobile-next', accessCodeExpiresAt: '2032-01-01T00:00:00.000Z' }) })
  assert.equal(draftUpdate.data.data.description, '更新后的说明')
  assert.equal(draftUpdate.data.data.accessCodeExpiresAt, '2032-01-01T00:00:00.000Z')
  assert.equal((await fx.request('/api/action', { cookie: alex, ...action('product.reviewState', { productId: draftId, reviewState: 'reviewing' }) })).data.data.reviewState, 'reviewing')
  assert.equal((await fx.request('/api/action', { cookie: alex, ...action('product.memberAdd', { productId: draftId, userId: 'user-lin' }) })).response.status, 200)
  assert.equal((await fx.request('/api/action', { cookie: alex, ...action('product.copyAccessCode', { productId: draftId }) })).data.data.accessCode, 'mobile-next')
  const trashed = (await fx.request('/api/action', { cookie: alex, ...action('product.state', { productId: draftId, state: 'trash' }) })).data.data
  assert.equal(trashed.state, 'trash')
  assert.match(trashed.trashedAt, /^\d{4}-\d{2}-\d{2}T/)
  const restored = (await fx.request('/api/action', { cookie: alex, ...action('product.restore', { productId: draftId }) })).data.data
  assert.equal(restored.state, 'offline')
  assert.equal(restored.trashedAt, undefined)
  assert.equal((await fx.request('/api/action', { cookie: alex, ...action('product.transfer', { productId: draftId, ownerId: 'user-admin' }) })).data.data.ownerId, 'user-admin')
  assert.equal((await fx.request('/api/action', { cookie: alex, ...action('product.update', { productId: draftId, name: '不应成功' }) })).response.status, 403)
  assert.equal((await fx.request('/api/action', { cookie: admin, ...action('product.state', { productId: draftId, state: 'trash' }) })).response.status, 200)
  const purged = await fx.request('/api/action', { cookie: admin, ...action('product.purge', { productId: draftId }) })
  assert.equal(purged.response.status, 200)
  assert.equal(purged.data.data.id, draftId)
  assert.equal((await fx.request('/api/bootstrap', { cookie: admin })).data.data.products.some((item) => item.id === draftId), false)
  assert.equal((await fx.request('/api/action', { cookie: admin, ...action('product.purge', { productId: draftId }) })).response.status, 404)

  const accessUpdate = await fx.request('/api/action', { cookie: alex, ...action('product.accessCode', { productId: 'product-customer-center', accessCode: 'alpha-new', expiresAt: '2030-01-01T00:00:00.000Z' }) })
  assert.equal(accessUpdate.data.data.codeVersion, 2)
  assert.equal(accessUpdate.data.data.accessCodeExpiresAt, '2030-01-01T00:00:00.000Z')
  assert.equal((await fx.request('/prototype-files/product-customer-center/20260722143000/index.html', { cookie: lin })).response.status, 200)
  assert.equal((await fx.request('/api/action', { cookie: lin, ...action('access.redeem', { code: 'alpha2026' }) })).response.status, 400)
  assert.equal((await fx.request('/api/action', { cookie: lin, ...action('access.redeem', { code: 'alpha-new' }) })).response.status, 200)
  assert.equal((await fx.request('/api/action', { cookie: alex, ...action('product.accessCode', { productId: 'product-customer-center', accessCode: 'alpha-expired', accessCodeExpiresAt: '2020-01-01T00:00:00.000Z' }) })).response.status, 200)
  assert.equal((await fx.request('/prototype-files/product-customer-center/20260722143000/index.html', { cookie: lin })).response.status, 200)
  const expiredRedeem = await fx.request('/api/action', { cookie: lin, ...action('access.redeem', { code: 'alpha-expired' }) })
  assert.equal(expiredRedeem.response.status, 409)
  assert.equal(expiredRedeem.data.error.code, 'ACCESS_CODE_EXPIRED')
  assert.equal((await fx.request('/api/action', { cookie: alex, ...action('product.accessCode', { productId: 'product-customer-center', accessCode: 'alpha-current', accessCodeExpiresAt: '' }) })).response.status, 200)
  assert.equal((await fx.request('/api/action', { cookie: alex, ...action('product.memberRevoke', { productId: 'product-customer-center', userId: 'user-lin' }) })).response.status, 200)
  assert.equal((await fx.request('/api/action', { cookie: lin, ...action('access.redeem', { code: 'alpha-current' }) })).response.status, 403)
  assert.equal((await fx.request('/api/action', { cookie: alex, ...action('product.memberAdd', { productId: 'product-customer-center', userId: 'user-lin' }) })).response.status, 200)

  const annotationResult = await fx.request('/api/action', {
    cookie: lin,
    ...action('annotation.create', { productId: 'product-customer-center', content: '新的评审批注', anchor: { kind: 'region', x: 0.2, y: 0.3, width: 0.2, height: 0.1 } })
  })
  const annotationId = annotationResult.data.data.id
  assert.equal((await fx.request('/api/action', { cookie: lin, ...action('annotation.update', { annotationId, content: '更新后的批注' }) })).response.status, 200)
  assert.equal((await fx.request('/api/action', { cookie: alex, ...action('annotation.update', { annotationId, content: '负责人不能改写他人文字' }) })).response.status, 403)
  assert.equal((await fx.request('/api/action', { cookie: alex, ...action('annotation.status', { id: annotationId, status: 'resolved' }) })).response.status, 200)
  assert.equal((await fx.request('/api/action', { cookie: admin, ...action('annotation.status', { id: annotationId, status: 'resolved' }) })).data.data.status, 'resolved')

  const replyResult = await fx.request('/api/action', { cookie: lin, ...action('reply.create', { annotationId, content: '补充说明' }) })
  const replyId = replyResult.data.data.id
  assert.equal((await fx.request('/api/action', { cookie: alex, ...action('reply.update', { annotationId, replyId, content: '越权' }) })).response.status, 403)
  assert.equal((await fx.request('/api/action', { cookie: lin, ...action('reply.update', { annotationId, replyId, content: '更新回复' }) })).data.data.content, '更新回复')
  assert.equal((await fx.request('/api/action', { cookie: lin, ...action('reply.delete', { annotationId, replyId }) })).data.data.deleted, true)
  assert.equal((await fx.request('/api/action', { cookie: admin, ...action('annotation.update', { annotationId, content: '管理员处置' }) })).response.status, 200)
  assert.equal((await fx.request('/api/action', { cookie: admin, ...action('annotation.delete', { annotationId }) })).data.data.deleted, true)

  const preserved = await fx.request('/api/action', {
    cookie: lin,
    ...action('annotation.create', {
      productId: 'product-customer-center',
      content: '收回权限后仍需保留',
      anchor: { kind: 'region', x: 0.15, y: 0.25, width: 0.2, height: 0.1, pageKey: '/customers', selector: '#customer-card', elementX: 0.4, elementY: 0.6, regionX: -0.2, regionY: 1.2, regionWidth: 1.2, regionHeight: 0.8 }
    })
  })
  assert.equal(preserved.data.data.anchor.pageKey, '/customers')
  assert.equal(preserved.data.data.anchor.selector, '#customer-card')
  assert.equal(preserved.data.data.anchor.regionX, -0.2)
  assert.equal(preserved.data.data.anchor.regionWidth, 1.2)
  const preservedReply = await fx.request('/api/action', { cookie: lin, ...action('reply.create', { annotationId: preserved.data.data.id, content: '我的回复也要保留' }) })
  await fx.request('/api/action', { cookie: alex, ...action('product.memberRevoke', { productId: 'product-customer-center', userId: 'user-lin' }) })
  const revokedBootstrap = await fx.request('/api/bootstrap', { cookie: lin })
  assert.ok(!revokedBootstrap.data.data.products.some((product) => product.id === 'product-customer-center'))
  assert.equal((await fx.request('/prototype-files/product-customer-center/20260722143000/index.html', { cookie: lin })).response.status, 403)
  const ownerAfterRevoke = await fx.request('/api/bootstrap', { cookie: alex })
  const retainedAnnotation = ownerAfterRevoke.data.data.annotations.find((item) => item.id === preserved.data.data.id)
  assert.equal(retainedAnnotation.authorId, 'user-lin')
  assert.equal(retainedAnnotation.replies.find((item) => item.id === preservedReply.data.data.id).authorId, 'user-lin')

  const userCreate = await fx.request('/api/action', { cookie: admin, ...action('user.create', { username: 'newpm', name: '新产品', role: 'user', job: '产品', password: 'newpm1234' }) })
  const newUserId = userCreate.data.data.id
  assert.equal((await fx.request('/api/action', { cookie: admin, ...action('user.update', { userId: newUserId, name: '新产品经理', role: 'user', job: '产品' }) })).data.data.name, '新产品经理')
  assert.equal((await fx.request('/api/action', { cookie: admin, ...action('user.toggle', { userId: newUserId, enabled: false }) })).data.data.enabled, false)
  const reset = await fx.request('/api/action', { cookie: admin, ...action('user.resetPassword', { userId: newUserId, password: 'reset1234' }) })
  assert.equal(reset.data.data.temporaryPassword, 'reset1234')

  const rollback = await fx.request('/api/action', { cookie: alex, ...action('product.rollback', { productId: 'product-customer-center', version: '20260721100000' }) })
  assert.equal(rollback.data.data.currentVersion, '20260721100000')
  assert.equal(rollback.data.data.reviewState, 'pending')
  assert.equal(rollback.data.data.versions.find((item) => item.version === '20260721100000').isCurrent, true)
  assert.equal((await fx.request('/api/action', { cookie: admin, ...action('annotation.update', { id: preserved.data.data.id, content: '历史版本不可改' }) })).response.status, 409)
  assert.equal((await fx.request('/api/action', { cookie: admin, ...action('reply.update', { annotationId: preserved.data.data.id, replyId: preservedReply.data.data.id, content: '历史回复不可改' }) })).response.status, 409)

  const profile = await fx.request('/api/action', { cookie: alex, ...action('profile.update', { name: 'Alex PM', avatar: `data:image/png;base64,${'A'.repeat(2_800_000)}` }) })
  assert.equal(profile.data.data.name, 'Alex PM')
})

test('HTML upload publishes a protected immutable version, records audit, and persists atomically', async (t) => {
  const fx = await fixture()
  t.after(() => fx.close())
  const alex = await fx.login('alex', 'product123')
  const lin = await fx.login('lin', 'review123')

  const form = new FormData()
  form.set('file', new Blob(['<!doctype html><html><body><button id="demo">可交互上传原型</button><script>demo.onclick=()=>demo.textContent="ok"</script></body></html>'], { type: 'text/html' }), 'interactive.html')
  form.set('name', '上传测试产品')
  form.set('manager', '测试产品经理')
  form.set('description', '测试上传闭环')
  form.set('longNote', '测试数据')
  form.set('accessCode', 'upload2026')
  form.set('note', '首次发布')
  const uploaded = await fx.request('/api/upload', { cookie: alex, body: form })
  assert.equal(uploaded.response.status, 200, JSON.stringify(uploaded.data))
  assert.equal(uploaded.data.data.upload.status, 'success')
  assert.match(uploaded.data.data.version.version, /^\d{14}$/)
  assert.equal(uploaded.data.data.product.state, 'online')

  const productId = uploaded.data.data.product.id
  const version = uploaded.data.data.version.version
  assert.equal(uploaded.data.data.version.gitTag, `v${version}`)
  assert.match(uploaded.data.data.version.gitCommit, /^[0-9a-f]{40}$/)
  const gitRepo = path.join(fx.dataDir, 'git', productId)
  assert.equal(await gitOutput(gitRepo, ['rev-list', '-n', '1', `v${version}`]), uploaded.data.data.version.gitCommit)
  const ownerView = await fx.request(`/prototype-files/${productId}/${version}/index.html`, { cookie: alex })
  assert.equal(ownerView.response.status, 200)
  assert.match(ownerView.response.headers.get('content-security-policy'), /sandbox allow-scripts/)
  assert.doesNotMatch(ownerView.response.headers.get('content-security-policy'), /allow-same-origin/)
  assert.match(ownerView.data, /可交互上传原型/)
  assert.equal((ownerView.data.match(/data-prototype-review-bridge="1"/g) ?? []).length, 1)
  assert.equal((await fx.request(`/prototype-files/${productId}/${version}/index.html`, { cookie: lin })).response.status, 403)
  assert.equal((await fx.request('/api/action', { cookie: lin, ...action('access.redeem', { code: 'upload2026' }) })).response.status, 200)
  assert.equal((await fx.request(`/prototype-files/${productId}/${version}/index.html`, { cookie: lin })).response.status, 200)

  const blocker = await fx.request('/api/action', {
    cookie: alex,
    ...action('annotation.create', { productId, content: '完成评审前必须解决', anchor: { kind: 'point', x: 0.1, y: 0.2 } })
  })
  assert.equal((await fx.request('/api/action', {
    cookie: alex,
    ...action('product.reviewState', { productId, reviewState: 'completed' })
  })).response.status, 409)
  await fx.request('/api/action', { cookie: alex, ...action('annotation.status', { id: blocker.data.data.id, status: 'resolved' }) })
  assert.equal((await fx.request('/api/action', {
    cookie: alex,
    ...action('product.reviewState', { id: productId, reviewState: 'completed' })
  })).data.data.reviewState, 'completed')

  const migratable = await fx.request('/api/action', {
    cookie: lin,
    ...action('annotation.create', { productId, content: '新版本继续跟进', anchor: { kind: 'region', x: 0.3, y: 0.4, width: 0.2, height: 0.1 } })
  })
  await fx.request('/api/action', { cookie: lin, ...action('annotation.status', { id: migratable.data.data.id, status: 'needs-relocation' }) })
  const sourceReply = await fx.request('/api/action', {
    cookie: alex,
    ...action('reply.create', { annotationId: migratable.data.data.id, content: '发布后继续处理' })
  })
  const reviewingBootstrap = await fx.request('/api/bootstrap', { cookie: alex })
  assert.equal(reviewingBootstrap.data.data.products.find((product) => product.id === productId).reviewState, 'reviewing')

  const persisted = JSON.parse(await readFile(path.join(fx.dataDir, 'state.json'), 'utf8'))
  assert.equal(persisted.products.find((product) => product.id === productId).currentVersion, version)
  assert.ok(persisted.uploads.some((item) => item.productId === productId && item.status === 'success'))
  assert.ok(persisted.audit.some((item) => item.action === 'product.publish' && item.targetName === '上传测试产品'))

  const invalidForm = new FormData()
  invalidForm.set('file', new Blob(['not a zip']), 'unsafe.zip')
  invalidForm.set('productId', productId)
  const failed = await fx.request('/api/upload', { cookie: alex, body: invalidForm })
  assert.equal(failed.response.status, 400)
  assert.equal(failed.data.error.message, '发布失败')
  assert.ok(fx.store.read().uploads.some((item) => item.productId === productId && item.status === 'failed'))

  const zipForm = new FormData()
  zipForm.set('file', new Blob([makeStoredZip({
    'prototype/index.html': '<!doctype html><html><head><link rel="modulepreload" href="./assets/app.js"><script type="module" src="./assets/app.js"></script></head><body><button>ZIP 原型</button></body></html>',
    'prototype/assets/app.js': 'document.body.dataset.loaded="yes"'
  })], { type: 'application/zip' }), 'prototype.zip')
  zipForm.set('productId', productId)
  zipForm.set('name', '上传测试产品二期')
  zipForm.set('manager', '测试产品负责人')
  zipForm.set('description', '发布时同步更新资料')
  zipForm.set('longNote', '二期长期说明')
  zipForm.set('accessCode', 'upload-next')
  zipForm.set('accessCodeExpiresAt', '2031-01-01T00:00:00.000Z')
  zipForm.set('note', 'ZIP 更新')
  const zipUpload = await fx.request('/api/upload', { cookie: alex, body: zipForm })
  assert.equal(zipUpload.response.status, 200, JSON.stringify(zipUpload.data))
  const zipVersion = zipUpload.data.data.version.version
  assert.equal(zipUpload.data.data.version.gitTag, `v${zipVersion}`)
  assert.equal(await gitOutput(gitRepo, ['rev-list', '-n', '1', `v${zipVersion}`]), zipUpload.data.data.version.gitCommit)
  assert.equal(zipUpload.data.data.product.reviewState, 'pending')
  assert.equal(zipUpload.data.data.product.name, '上传测试产品二期')
  assert.equal(zipUpload.data.data.product.accessCode, 'upload-next')
  assert.equal(zipUpload.data.data.product.accessCodeExpiresAt, '2031-01-01T00:00:00.000Z')
  const zipHtml = await fx.request(`/prototype-files/${productId}/${zipVersion}/index.html`, { cookie: alex })
  assert.match(zipHtml.data, /ZIP 原型/)
  assert.match(zipHtml.data, /data-prototype-review-bridge="1"/)
  assert.equal((zipHtml.data.match(/crossorigin="use-credentials"/g) ?? []).length, 2)
  const unauthenticatedAsset = await fx.request(`/prototype-files/${productId}/${zipVersion}/assets/app.js`, { headers: { origin: 'null' } })
  assert.equal(unauthenticatedAsset.response.status, 401)
  assert.equal(unauthenticatedAsset.response.headers.get('access-control-allow-origin'), null)
  const zipAsset = await fx.request(`/prototype-files/${productId}/${zipVersion}/assets/app.js`, { cookie: alex, headers: { origin: 'null' } })
  assert.equal(zipAsset.response.status, 200)
  assert.doesNotMatch(zipAsset.data, /data-prototype-review-bridge/)
  assert.equal(zipAsset.response.headers.get('access-control-allow-origin'), null)
  assert.equal(zipAsset.response.headers.get('access-control-allow-credentials'), null)
  assert.equal((await fx.request(`/prototype-files/${productId}/${zipVersion}/index.html`, { cookie: lin })).response.status, 200)
  const afterPublish = fx.store.read()
  const migrated = afterPublish.annotations.find((annotation) => annotation.productId === productId && annotation.version === zipVersion)
  assert.equal(migrated.originId, migratable.data.data.id)
  assert.equal(migrated.status, 'needs-relocation')
  assert.equal(migrated.replies[0].originId, sourceReply.data.data.id)
  assert.ok(afterPublish.annotations.some((annotation) => annotation.id === blocker.data.data.id && annotation.version === version && annotation.status === 'resolved'))
  assert.ok(!afterPublish.annotations.some((annotation) => annotation.version === zipVersion && annotation.originId === blocker.data.data.id))

  const traversalForm = new FormData()
  traversalForm.set('file', new Blob([makeStoredZip({ '../index.html': '<html>bad</html>' })], { type: 'application/zip' }), 'traversal.zip')
  traversalForm.set('productId', productId)
  assert.equal((await fx.request('/api/upload', { cookie: alex, body: traversalForm })).response.status, 400)
  const tagsBeforeRollback = await gitOutput(gitRepo, ['tag', '--list', 'v*'])
  assert.equal((await fx.request('/api/action', { cookie: alex, ...action('product.rollback', { productId, version }) })).response.status, 200)
  assert.equal(await gitOutput(gitRepo, ['tag', '--list', 'v*']), tagsBeforeRollback)
})

test('HTML upload normalizes UTF-16 and GBK files so previews remain readable', async (t) => {
  const fx = await fixture()
  t.after(() => fx.close())
  const alex = await fx.login('alex', 'product123')

  async function uploadHtml(bytes, fileName, name) {
    const form = new FormData()
    form.set('file', new Blob([bytes], { type: 'text/html' }), fileName)
    form.set('name', name)
    form.set('manager', '编码兼容测试')
    form.set('description', '验证非 UTF-8 HTML 可以正常发布和预览')
    form.set('longNote', '')
    form.set('accessCode', `${name}-code`)
    form.set('note', '编码兼容发布')
    return fx.request('/api/upload', { cookie: alex, body: form })
  }

  const utf16Source = '<!doctype html><html><head><meta charset="utf-16"></head><body>UTF-16 原型可预览</body></html>'
  const utf16Bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(utf16Source, 'utf16le')])
  const utf16Upload = await uploadHtml(utf16Bytes, 'utf16-prototype.html', 'utf16-product')
  assert.equal(utf16Upload.response.status, 200, JSON.stringify(utf16Upload.data))
  const utf16Product = utf16Upload.data.data.product
  const utf16Preview = await fx.request(`/prototype-files/${utf16Product.id}/${utf16Product.currentVersion}/index.html`, { cookie: alex })
  assert.equal(utf16Preview.response.status, 200)
  assert.match(utf16Preview.data, /UTF-16 原型可预览/)
  assert.doesNotMatch(utf16Preview.data, /\u0000/)

  const gbkBytes = Buffer.concat([
    Buffer.from('<!doctype html><html><head><meta charset="gbk"></head><body>GBK '),
    Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
    Buffer.from(' prototype</body></html>'),
  ])
  const gbkUpload = await uploadHtml(gbkBytes, 'gbk-prototype.html', 'gbk-product')
  assert.equal(gbkUpload.response.status, 200, JSON.stringify(gbkUpload.data))
  const gbkProduct = gbkUpload.data.data.product
  const gbkPreview = await fx.request(`/prototype-files/${gbkProduct.id}/${gbkProduct.currentVersion}/index.html`, { cookie: alex })
  assert.equal(gbkPreview.response.status, 200)
  assert.match(gbkPreview.data, /GBK 中文 prototype/)

  const invalidUpload = await uploadHtml(Buffer.from('这不是 HTML'), 'invalid.html', 'invalid-product')
  assert.equal(invalidUpload.response.status, 400)
  assert.equal(invalidUpload.data.error.code, 'PUBLISH_FAILED')
  assert.match(invalidUpload.data.error.message, /未找到可渲染的 HTML 标签/)
})

test('TAR.GZ source upload publishes a built extensionless entry', async (t) => {
  const fx = await fixture({
    sourceBuilder: async (_sourceDir, destination) => {
      await mkdir(path.join(destination, '_next', 'static'), { recursive: true })
      await writeFile(path.join(destination, 'dashboard.html'), '<!doctype html><html><body><main>源码构建原型</main></body></html>')
      await writeFile(path.join(destination, '_next', 'static', 'app.js'), 'document.body.dataset.ready="yes"')
      return { entryPath: 'dashboard', routes: ['dashboard'] }
    },
  })
  t.after(() => fx.close())
  const alex = await fx.login('alex', 'product123')
  const form = new FormData()
  form.set('file', new Blob([makeTarGzip({
    'projects/package.json': '{"dependencies":{"next":"16.1.1"}}',
    'projects/src/app/page.tsx': 'export default function Page(){return null}',
    'projects/assets/AI??????.md': 'legacy filename',
  })], { type: 'application/gzip' }), 'source-project.tar.gz')
  form.set('name', '源码包上传测试')
  form.set('manager', '测试产品经理')
  form.set('accessCode', 'source2026')
  form.set('note', '源码构建发布')

  const uploaded = await fx.request('/api/upload', { cookie: alex, body: form })
  assert.equal(uploaded.response.status, 200, JSON.stringify(uploaded.data))
  assert.match(uploaded.data.data.version.entryUrl, /\/dashboard$/)
  const page = await fx.request(new URL(uploaded.data.data.version.entryUrl, fx.base).pathname, { cookie: alex })
  assert.equal(page.response.status, 200)
  assert.match(page.data, /源码构建原型/)
  assert.match(page.data, /data-prototype-review-bridge="1"/)
})

test('password change uses scrypt credentials and revokes all prior sessions', async (t) => {
  const fx = await fixture()
  t.after(() => fx.close())
  const alex = await fx.login('alex', 'product123')
  const changed = await fx.request('/api/action', { cookie: alex, ...action('password.change', { currentPassword: 'product123', newPassword: 'product4567' }) })
  assert.equal(changed.response.status, 200)
  assert.equal((await fx.request('/api/bootstrap', { cookie: alex })).response.status, 401)
  assert.equal((await fx.request('/api/auth/login', { body: { username: 'alex', password: 'product123' } })).response.status, 401)
  assert.ok(await fx.login('alex', 'product4567'))
})

test('annotation detail attachments and admin-only system releases persist through bootstrap', async (t) => {
  const fx = await fixture()
  t.after(() => fx.close())
  const admin = await fx.login('admin', 'admin123')
  const lin = await fx.login('lin', 'review123')
  const image = {
    id: 'image-test-1',
    name: 'review.png',
    type: 'image/png',
    size: 8,
    dataUrl: 'data:image/png;base64,iVBORw0K',
  }

  const createdAnnotation = await fx.request('/api/action', {
    cookie: lin,
    ...action('annotation.create', {
      productId: 'product-customer-center',
      version: '20260722143000',
      content: '元素说明支持长文本与图片。',
      attachments: [image],
      anchor: { kind: 'point', x: 0.35, y: 0.42, pageKey: '/index.html' },
    }),
  })
  assert.equal(createdAnnotation.response.status, 200, JSON.stringify(createdAnnotation.data))
  assert.equal(createdAnnotation.data.data.attachments[0].name, 'review.png')

  const reply = await fx.request('/api/action', {
    cookie: admin,
    ...action('reply.create', {
      annotationId: createdAnnotation.data.data.id,
      content: '已收到，图片信息清晰。',
      attachments: [{ ...image, id: 'image-test-2' }],
    }),
  })
  assert.equal(reply.response.status, 200, JSON.stringify(reply.data))
  assert.equal(reply.data.data.attachments.length, 1)

  const createdRelease = await fx.request('/api/action', {
    cookie: admin,
    ...action('systemRelease.create', {
      version: '1.1.0',
      title: '批注详情升级',
      content: '批注改为详情弹窗，并支持图片与长文本回复。',
      releasedAt: '2026-07-23T08:00:00.000Z',
    }),
  })
  assert.equal(createdRelease.response.status, 200, JSON.stringify(createdRelease.data))
  const releaseId = createdRelease.data.data.id

  const forbidden = await fx.request('/api/action', {
    cookie: lin,
    ...action('systemRelease.create', {
      version: '1.1.1',
      title: '无权限版本',
      content: '普通用户不能创建。',
    }),
  })
  assert.equal(forbidden.response.status, 403)

  const adminBootstrap = await fx.request('/api/bootstrap', { cookie: admin })
  assert.ok(adminBootstrap.data.data.systemReleases.some((item) => item.id === releaseId))
  const persistedAnnotation = adminBootstrap.data.data.annotations.find((item) => item.id === createdAnnotation.data.data.id)
  assert.equal(persistedAnnotation.attachments.length, 1)
  assert.equal(persistedAnnotation.replies[0].attachments.length, 1)

  const linBootstrap = await fx.request('/api/bootstrap', { cookie: lin })
  assert.deepEqual(linBootstrap.data.data.systemReleases, [])

  const updated = await fx.request('/api/action', {
    cookie: admin,
    ...action('systemRelease.update', {
      releaseId,
      version: '1.1.0',
      title: '批注详情与版本记录升级',
      content: '更新后的版本说明。',
      releasedAt: '2026-07-23T09:00:00.000Z',
    }),
  })
  assert.equal(updated.response.status, 200)
  assert.equal(updated.data.data.title, '批注详情与版本记录升级')

  const removed = await fx.request('/api/action', {
    cookie: admin,
    ...action('systemRelease.delete', { releaseId }),
  })
  assert.equal(removed.response.status, 200)
  assert.ok(!fx.store.read().systemReleases.some((item) => item.id === releaseId))
})
