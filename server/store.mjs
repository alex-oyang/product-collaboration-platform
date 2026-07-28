import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback)

export function isoNow() {
  return new Date().toISOString()
}

export function shanghaiVersion(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(now).map(({ type, value }) => [type, value]))
  return `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}${parts.second}`
}

export async function passwordFields(password) {
  const salt = randomBytes(16).toString('hex')
  const passwordHash = Buffer.from(await scrypt(String(password), salt, 64)).toString('hex')
  return { passwordSalt: salt, passwordHash }
}

export async function verifyPassword(password, user) {
  if (!user?.passwordSalt || !user?.passwordHash) return false
  const actual = Buffer.from(await scrypt(String(password), user.passwordSalt, 64))
  const expected = Buffer.from(user.passwordHash, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function tokenHash(token) {
  return createHash('sha256').update(String(token)).digest('hex')
}

export function publicUser(user, { includeUsername = true } = {}) {
  return {
    id: user.id,
    username: includeUsername ? user.username : '',
    name: user.name,
    role: user.role,
    job: user.job,
    avatar: user.avatar,
    enabled: user.enabled,
    mustChangePassword: Boolean(user.mustChangePassword)
  }
}

function demoHtml(productName, version) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${productName}</title><style>body{font-family:system-ui,"Microsoft YaHei",sans-serif;background:#eef2ff;margin:0;padding:40px;color:#172033}.card{max-width:720px;margin:auto;background:white;border-radius:24px;padding:32px;box-shadow:0 20px 60px #33415522}button{border:0;border-radius:12px;padding:12px 18px;background:#4f46e5;color:white;font-weight:700;cursor:pointer}</style></head><body><main class="card"><p>Prototype Review System</p><h1>${productName}</h1><p>版本 ${version}</p><button id="counter">点击体验 · 0</button></main><script>let n=0;document.querySelector('#counter').addEventListener('click',e=>e.currentTarget.textContent='点击体验 · '+(++n))</script></body></html>`
}

async function makeSeed() {
  const [adminPassword, alexPassword, linPassword, wuPassword] = await Promise.all([
    passwordFields('admin123'), passwordFields('product123'),
    passwordFields('review123'), passwordFields('dev123')
  ])
  const users = [
    { id: 'user-admin', username: 'admin', name: '系统管理员', role: 'admin', job: '产品', avatar: '', enabled: true, mustChangePassword: false, ...adminPassword },
    { id: 'user-alex', username: 'alex', name: 'Alex 欧阳', role: 'user', job: '产品', avatar: '', enabled: true, mustChangePassword: false, ...alexPassword },
    { id: 'user-lin', username: 'lin', name: '林悦', role: 'user', job: '美术', avatar: '', enabled: true, mustChangePassword: false, ...linPassword },
    { id: 'user-wu', username: 'wu', name: '吴工', role: 'user', job: '研发', avatar: '', enabled: true, mustChangePassword: false, ...wuPassword }
  ]
  const products = [
    {
      id: 'product-customer-center', name: '客户管理中心', manager: '周经理',
      description: '客户档案、商机与跟进流程评审原型', longNote: '首期重点检查客户详情和商机流转。',
      ownerId: 'user-alex', accessCode: 'alpha2026', accessCodeExpiresAt: null, codeVersion: 1,
      state: 'online', reviewState: 'reviewing', currentVersion: '20260722143000',
      createdAt: '2026-07-21T08:00:00.000Z', updatedAt: '2026-07-22T06:30:00.000Z',
      members: [
        { userId: 'user-lin', source: 'code', grantedAt: '2026-07-22T01:00:00.000Z', codeVersion: 1 },
        { userId: 'user-wu', source: 'manual', grantedAt: '2026-07-22T01:10:00.000Z', codeVersion: 1 }
      ], revokedMembers: [],
      versions: [
        { id: 'version-customer-1', version: '20260721100000', note: '客户列表初版', uploaderId: 'user-alex', createdAt: '2026-07-21T02:00:00.000Z', fileName: 'customer-v1.zip', fileSize: 182400, entryUrl: '/prototype-files/product-customer-center/20260721100000/index.html', isCurrent: false },
        { id: 'version-customer-2', version: '20260722143000', note: '补充客户详情与商机流程', uploaderId: 'user-alex', createdAt: '2026-07-22T06:30:00.000Z', fileName: 'customer-v2.zip', fileSize: 238210, entryUrl: '/prototype-files/product-customer-center/20260722143000/index.html', isCurrent: true }
      ]
    },
    {
      id: 'product-data-dashboard', name: '经营数据看板', manager: '陈经理',
      description: '面向经营分析的指标与图表原型', longNote: '验证指标解释、筛选与钻取体验。',
      ownerId: 'user-admin', accessCode: 'design2026', accessCodeExpiresAt: null, codeVersion: 2,
      state: 'online', reviewState: 'pending', currentVersion: '20260722093000',
      createdAt: '2026-07-20T03:00:00.000Z', updatedAt: '2026-07-22T01:30:00.000Z',
      members: [{ userId: 'user-alex', source: 'manual', grantedAt: '2026-07-22T01:40:00.000Z', codeVersion: 2 }],
      revokedMembers: [],
      versions: [{ id: 'version-dashboard-1', version: '20260722093000', note: '首轮评审版', uploaderId: 'user-admin', createdAt: '2026-07-22T01:30:00.000Z', fileName: 'dashboard.html', fileSize: 48220, entryUrl: '/prototype-files/product-data-dashboard/20260722093000/index.html', isCurrent: true }]
    }
  ]
  return {
    schemaVersion: 3,
    users,
    products,
    uploads: [
      { id: 'upload-seed-1', productId: 'product-customer-center', productName: '客户管理中心', fileName: 'customer-v2.zip', uploaderId: 'user-alex', createdAt: '2026-07-22T06:30:00.000Z', status: 'success', version: '20260722143000' },
      { id: 'upload-seed-2', productId: 'product-data-dashboard', productName: '经营数据看板', fileName: 'dashboard-broken.zip', uploaderId: 'user-admin', createdAt: '2026-07-22T00:30:00.000Z', status: 'failed', error: '发布失败' }
    ],
    annotations: [
      {
        id: 'annotation-seed-1', productId: 'product-customer-center', version: '20260722143000', authorId: 'user-lin',
        content: '客户状态标签的对比度需要提高。', status: 'open', anchor: { kind: 'point', x: 0.32, y: 0.24 },
        createdAt: '2026-07-22T07:00:00.000Z', replies: [
          { id: 'reply-seed-1', authorId: 'user-alex', content: '已记录，下个版本统一调整。', createdAt: '2026-07-22T07:10:00.000Z' }
        ]
      },
      {
        id: 'annotation-seed-2', productId: 'product-customer-center', version: '20260721100000', authorId: 'user-wu',
        content: '历史版本接口字段说明已确认。', status: 'resolved', anchor: { kind: 'region', x: 0.55, y: 0.45, width: 0.25, height: 0.18 },
        createdAt: '2026-07-21T08:30:00.000Z', replies: []
      }
    ],
    systemReleases: [
      {
        id: 'system-release-seed-1',
        version: '1.0.0',
        title: '产品评审工作台首个可用版本',
        content: '完成产品上传、版本留档、原型评审、批注回复、成员授权和操作记录等核心闭环。',
        releasedAt: '2026-07-23T02:00:00.000Z',
        authorId: 'user-admin',
        createdAt: '2026-07-23T02:00:00.000Z'
      }
    ],
    audit: [
      { id: 'audit-seed-1', actorId: 'user-alex', action: 'product.publish', targetType: 'product', targetId: 'product-customer-center', targetName: '客户管理中心', detail: '发布版本 20260722143000', result: 'success', createdAt: '2026-07-22T06:30:00.000Z' },
      { id: 'audit-seed-2', actorId: 'user-lin', action: 'annotation.create', targetType: 'annotation', targetId: 'annotation-seed-1', targetName: '客户管理中心', detail: '新增批注', result: 'success', createdAt: '2026-07-22T07:00:00.000Z' }
    ],
    sessions: []
  }
}

export class JsonStore {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir)
    this.dbPath = path.join(this.dataDir, 'state.json')
    this.releaseRoot = path.join(this.dataDir, 'releases')
    this.gitRoot = path.join(this.dataDir, 'git')
    this.queue = Promise.resolve()
    this.state = null
  }

  async init({ demoDir } = {}) {
    await mkdir(this.dataDir, { recursive: true })
    try {
      this.state = JSON.parse(await readFile(this.dbPath, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      this.state = await makeSeed()
      await this.#write(this.state)
    }
    let normalized = false
    if (!Array.isArray(this.state.systemReleases)) {
      this.state.systemReleases = []
      normalized = true
    }
    for (const product of this.state.products) {
      if (!Object.hasOwn(product, 'accessCodeExpiresAt')) {
        product.accessCodeExpiresAt = null
        normalized = true
      }
    }
    for (const annotation of this.state.annotations) {
      if (!Array.isArray(annotation.attachments)) {
        annotation.attachments = []
        normalized = true
      }
      for (const reply of annotation.replies ?? []) {
        if (!Array.isArray(reply.attachments)) {
          reply.attachments = []
          normalized = true
        }
      }
    }
    if ((this.state.schemaVersion ?? 1) < 2) {
      this.state.schemaVersion = 2
      normalized = true
    }
    if ((this.state.schemaVersion ?? 1) < 3) {
      if (this.state.systemReleases.length === 0) {
        const author = this.state.users.find((item) => item.role === 'admin' && item.enabled) ?? this.state.users[0]
        const releasedAt = isoNow()
        this.state.systemReleases.push({
          id: `system-release-${randomUUID()}`,
          version: '1.1.0',
          title: '批注详情与系统版本记录升级',
          content: '批注改为气泡点击后打开详情，新增“元素说明 / 批注回复”页签、长文本、图片、放大、编辑和关闭能力；新增仅超级管理员可用的系统版本记录模块。',
          releasedAt,
          authorId: author.id,
          createdAt: releasedAt
        })
      }
      this.state.schemaVersion = 3
      normalized = true
    }
    if (normalized) await this.#write(this.state)
    await this.ensureReleaseFiles(demoDir)
    return this
  }

  read() {
    if (!this.state) throw new Error('Store is not initialized')
    return structuredClone(this.state)
  }

  mutate(operation) {
    const run = this.queue.then(async () => {
      const draft = structuredClone(this.state)
      const result = await operation(draft)
      await this.#write(draft)
      this.state = draft
      return structuredClone(result)
    })
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  async #write(value) {
    const temp = `${this.dbPath}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    await rename(temp, this.dbPath)
  }

  async ensureReleaseFiles(demoDir) {
    for (const product of this.state.products) {
      for (const version of product.versions) {
        const target = path.join(this.releaseRoot, product.id, version.version)
        const index = path.join(target, 'index.html')
        try {
          const info = await stat(index)
          if (info.isFile()) continue
        } catch {}
        await rm(target, { recursive: true, force: true })
        await mkdir(target, { recursive: true })
        let copied = false
        if (demoDir) {
          try {
            await cp(demoDir, target, { recursive: true, force: false, errorOnExist: false })
            copied = true
          } catch {}
        }
        if (!copied) await writeFile(index, demoHtml(product.name, version.version), 'utf8')
      }
    }
  }
}

export const ids = { random: randomUUID }
