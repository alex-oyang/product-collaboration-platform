import { createReadStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createGunzip } from 'node:zlib'

const TAR_BLOCK_BYTES = 512
const MAX_METADATA_BYTES = 1024 * 1024
const MAX_PAX_RECORDS = 10_000
const MAX_PAX_KEY_BYTES = 256

export const TAR_LIMITS = Object.freeze({
  maxEntries: 10_000,
  maxFileBytes: 100 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
})

const decoder = new TextDecoder('utf-8', { fatal: true })

function archiveError(message) {
  return new Error(`TAR ${message}`)
}

function stricterLimit(value, ceiling, label) {
  if (value == null) return ceiling
  const numeric = Number(value)
  if (!Number.isSafeInteger(numeric) || numeric <= 0) throw new TypeError(`${label} must be a positive integer`)
  return Math.min(numeric, ceiling)
}

function extractionLimits(options = {}) {
  const requested = options.limits ?? {}
  return {
    maxEntries: stricterLimit(requested.maxEntries, TAR_LIMITS.maxEntries, 'maxEntries'),
    maxFileBytes: stricterLimit(requested.maxFileBytes, TAR_LIMITS.maxFileBytes, 'maxFileBytes'),
    maxTotalBytes: stricterLimit(requested.maxTotalBytes, TAR_LIMITS.maxTotalBytes, 'maxTotalBytes'),
  }
}

function decodeUtf8(buffer, label) {
  try {
    return decoder.decode(buffer)
  } catch {
    throw archiveError(`${label}不是有效的 UTF-8`)
  }
}

function textField(block, start, length, label) {
  const field = block.subarray(start, start + length)
  const end = field.indexOf(0)
  return decodeUtf8(end >= 0 ? field.subarray(0, end) : field, label)
}

function numericField(field, label) {
  if (field[0] & 0x80) {
    if (field[0] & 0x40) throw archiveError(`${label}不能为负数`)
    let result = BigInt(field[0] & 0x7f)
    for (let index = 1; index < field.length; index += 1) result = (result << 8n) | BigInt(field[index])
    if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw archiveError(`${label}超过安全整数范围`)
    return Number(result)
  }

  const raw = field.toString('ascii').replace(/\0.*$/s, '').trim()
  if (!raw) return 0
  if (!/^[0-7]+$/.test(raw)) throw archiveError(`${label}格式不正确`)
  const result = BigInt(`0o${raw}`)
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw archiveError(`${label}超过安全整数范围`)
  return Number(result)
}

function validChecksum(block) {
  const expected = numericField(block.subarray(148, 156), '校验和')
  let actual = 0
  for (let index = 0; index < TAR_BLOCK_BYTES; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : block[index]
  }
  return expected === actual
}

function headerFrom(block) {
  if (!validChecksum(block)) throw archiveError('头部校验失败')
  const magic = textField(block, 257, 6, '格式标识').trim()
  if (magic && magic !== 'ustar') throw archiveError('格式不受支持')
  const name = textField(block, 0, 100, '路径')
  const prefix = textField(block, 345, 155, '路径前缀')
  const typeByte = block[156]
  return {
    name: prefix ? `${prefix}/${name}` : name,
    size: numericField(block.subarray(124, 136), '文件大小'),
    type: typeByte === 0 ? '0' : String.fromCharCode(typeByte),
  }
}

function unsafeWindowsSegment(segment) {
  if (/[<>:"|?*]/.test(segment) || /[. ]$/.test(segment)) return true
  const stem = segment.split('.')[0].toUpperCase()
  return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)
}

export function safeTarEntryName(input, { metadata = false } = {}) {
  const raw = String(input)
  if (!raw || raw.length > 8192 || raw.includes('\0') || raw.includes('\\') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
    throw archiveError('包含非法路径')
  }
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw archiveError('路径包含控制字符')

  const trailingSlash = raw.endsWith('/')
  const parts = raw.split('/')
  if (trailingSlash) parts.pop()
  if (!parts.length || parts.some((part) => !part)) throw archiveError('路径格式不正确')
  if (parts.some((part) => part === '..' || (!metadata && part === '.'))) throw archiveError('包含越界路径')
  if (parts.some((part) => part.toLowerCase() === '.git')) throw archiveError('不允许包含 Git 元数据')
  if (parts.some((part) => (
    Buffer.byteLength(part, 'utf8') > 255
    || (!(metadata && part === '.') && unsafeWindowsSegment(part))
  ))) {
    throw archiveError('路径无法安全写入文件系统')
  }
  return parts.join('/')
}

function compatibleTarEntryName(input, { metadata = false, portableNames = false } = {}) {
  if (!portableNames) return safeTarEntryName(input, { metadata })
  const raw = String(input)
  if (!raw || raw.includes('\0') || raw.includes('\\') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw) || /[\u0000-\u001f\u007f]/.test(raw)) {
    return safeTarEntryName(raw, { metadata })
  }
  const portable = raw.split('/').map((segment) => {
    if (!segment || segment === '.' || segment === '..' || segment.toLowerCase() === '.git') return segment
    let next = segment.replace(/[<>:"|?*]/g, '_').replace(/[. ]+$/g, '_')
    const stem = next.split('.')[0].toUpperCase()
    if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) next = `_${next}`
    return next
  }).join('/')
  return safeTarEntryName(portable, { metadata })
}

function canonicalName(name) {
  return name.normalize('NFC').toLocaleLowerCase('en-US')
}

function registerPath(registry, name, kind) {
  const parts = name.split('/')
  for (let index = 1; index <= parts.length; index += 1) {
    const display = parts.slice(0, index).join('/')
    const canonical = canonicalName(display)
    const nextKind = index === parts.length ? kind : 'directory'
    const existing = registry.get(canonical)
    if (existing) {
      if (existing.display !== display) throw archiveError('包含大小写或 Unicode 冲突路径')
      if (existing.kind !== nextKind) throw archiveError('包含文件与目录冲突')
      if (index === parts.length) throw archiveError('包含重复条目')
    } else {
      registry.set(canonical, { display, kind: nextKind })
    }
  }
}

function decimalSize(value) {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw archiveError('PAX 文件大小格式不正确')
  const size = BigInt(value)
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw archiveError('PAX 文件大小超过安全整数范围')
  return Number(size)
}

function parsePax(buffer) {
  const values = new Map()
  let offset = 0
  let recordCount = 0
  while (offset < buffer.length) {
    recordCount += 1
    if (recordCount > MAX_PAX_RECORDS) throw archiveError('PAX 记录数量过多')
    const space = buffer.indexOf(0x20, offset)
    if (space < 0) throw archiveError('PAX 记录缺少长度')
    const lengthText = buffer.subarray(offset, space).toString('ascii')
    if (!/^[1-9]\d*$/.test(lengthText)) throw archiveError('PAX 记录长度格式不正确')
    const length = Number(lengthText)
    const end = offset + length
    if (!Number.isSafeInteger(length) || end > buffer.length || buffer[end - 1] !== 0x0a) {
      throw archiveError('PAX 记录长度不正确')
    }
    const record = buffer.subarray(space + 1, end - 1)
    const equals = record.indexOf(0x3d)
    if (equals <= 0) throw archiveError('PAX 记录格式不正确')
    const key = decodeUtf8(record.subarray(0, equals), 'PAX 键')
    const value = decodeUtf8(record.subarray(equals + 1), 'PAX 值')
    if (Buffer.byteLength(key, 'utf8') > MAX_PAX_KEY_BYTES) throw archiveError('PAX 键过长')
    if (values.has(key)) throw archiveError('PAX 记录包含重复键')
    values.set(key, value)
    offset = end
  }
  return values
}

function validatePax(values, { global = false } = {}) {
  for (const key of values.keys()) {
    const normalized = key.toLowerCase()
    if (normalized.includes('sparse') || normalized.endsWith('linkpath')) {
      throw archiveError('不允许 PAX 链接或稀疏文件元数据')
    }
    if (normalized === 'schily.devmajor' || normalized === 'schily.devminor') {
      throw archiveError('不允许 PAX 设备元数据')
    }
  }
  if (global && ['path', 'size'].some((key) => values.has(key))) {
    throw archiveError('全局 PAX 不允许覆盖路径或大小')
  }
}

function longName(buffer) {
  const nul = buffer.indexOf(0)
  if (nul < 0) throw archiveError('GNU 长路径缺少终止符')
  const value = decodeUtf8(buffer.subarray(0, nul), 'GNU 长路径').replace(/\n$/, '')
  if (buffer.subarray(nul + 1).some((byte) => byte !== 0)) throw archiveError('GNU 长路径格式不正确')
  return value
}

class StreamReader {
  constructor(stream, maximumRawBytes) {
    this.iterator = stream[Symbol.asyncIterator]()
    this.chunk = Buffer.alloc(0)
    this.offset = 0
    this.rawBytes = 0
    this.maximumRawBytes = maximumRawBytes
  }

  async nextChunk() {
    const result = await this.iterator.next()
    if (result.done) return false
    const chunk = Buffer.isBuffer(result.value) ? result.value : Buffer.from(result.value)
    this.rawBytes += chunk.length
    if (this.rawBytes > this.maximumRawBytes) throw archiveError('解压数据超过硬限制')
    this.chunk = chunk
    this.offset = 0
    return true
  }

  async readExactly(length, { allowEof = false } = {}) {
    if (length === 0) return Buffer.alloc(0)
    const output = Buffer.allocUnsafe(length)
    let written = 0
    while (written < length) {
      if (this.offset >= this.chunk.length && !await this.nextChunk()) {
        if (allowEof && written === 0) return null
        throw archiveError('内容被截断')
      }
      const available = Math.min(length - written, this.chunk.length - this.offset)
      this.chunk.copy(output, written, this.offset, this.offset + available)
      this.offset += available
      written += available
    }
    return output
  }

  async writeExactly(length, handle) {
    let remaining = length
    let position = 0
    while (remaining > 0) {
      if (this.offset >= this.chunk.length && !await this.nextChunk()) throw archiveError('文件内容被截断')
      const available = Math.min(remaining, this.chunk.length - this.offset)
      let localOffset = this.offset
      let localRemaining = available
      while (localRemaining > 0) {
        const result = await handle.write(this.chunk, localOffset, localRemaining, position)
        if (!result.bytesWritten) throw archiveError('无法写入解压文件')
        localOffset += result.bytesWritten
        localRemaining -= result.bytesWritten
        position += result.bytesWritten
      }
      this.offset += available
      remaining -= available
    }
  }

  async assertOnlyZeros() {
    while (true) {
      if (this.offset >= this.chunk.length && !await this.nextChunk()) return
      for (; this.offset < this.chunk.length; this.offset += 1) {
        if (this.chunk[this.offset] !== 0) throw archiveError('结束标记后包含非零数据')
      }
    }
  }
}

async function exists(target) {
  try {
    await lstat(target)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function normalizedRoot(entries) {
  if (!entries.length || !entries.some((entry) => entry.kind === 'file')) throw archiveError('没有可解压的文件')
  const roots = new Map()
  for (const entry of entries) {
    const first = entry.name.split('/')[0]
    const canonical = canonicalName(first)
    const previous = roots.get(canonical)
    if (previous && previous !== first) throw archiveError('顶层目录存在大小写冲突')
    roots.set(canonical, first)
  }
  if (roots.size !== 1) return ''
  const root = [...roots.values()][0]
  const topLevel = entries.find((entry) => entry.name === root)
  const hasNested = entries.some((entry) => entry.name.startsWith(`${root}/`))
  return hasNested && (!topLevel || topLevel.kind === 'directory') ? root : ''
}

async function installExtraction(source, destination, staging) {
  const destinationPath = path.resolve(destination)
  if (destinationPath === path.parse(destinationPath).root) throw new TypeError('Refusing to replace a filesystem root')
  await mkdir(path.dirname(destinationPath), { recursive: true })
  const backup = path.join(path.dirname(destinationPath), `.${path.basename(destinationPath)}.backup-${randomUUID()}`)
  const hadDestination = await exists(destinationPath)
  if (hadDestination) await rename(destinationPath, backup)
  try {
    await rename(source, destinationPath)
  } catch (error) {
    if (hadDestination) await rename(backup, destinationPath).catch(() => {})
    throw error
  }
  if (hadDestination) await rm(backup, { recursive: true, force: true })
  if (path.resolve(source) !== path.resolve(staging)) await rm(staging, { recursive: true, force: true })
}

export async function extractTarSafely(archivePath, destination, options = {}) {
  const limits = extractionLimits(options)
  const portableNames = options.portableNames === true
  const destinationPath = path.resolve(destination)
  if (destinationPath === path.parse(destinationPath).root) throw new TypeError('Refusing to extract to a filesystem root')
  await mkdir(path.dirname(destinationPath), { recursive: true })
  const staging = await mkdtemp(path.join(path.dirname(destinationPath), `.${path.basename(destinationPath)}.extracting-`))
  const gunzip = createGunzip()
  const sourceStream = createReadStream(archivePath)
  sourceStream.on('error', (error) => gunzip.destroy(error))
  sourceStream.pipe(gunzip)
  const maximumRawBytes = limits.maxTotalBytes + limits.maxEntries * TAR_BLOCK_BYTES * 2 + 1024 * 1024
  const reader = new StreamReader(gunzip, maximumRawBytes)
  const registry = new Map()
  const entries = []
  let entryCount = 0
  let expandedBytes = 0
  let budgetBytes = 0
  let zeroBlocks = 0
  let pendingPax = null
  let pendingLongName = ''

  try {
    while (true) {
      const block = await reader.readExactly(TAR_BLOCK_BYTES, { allowEof: true })
      if (!block) throw archiveError('缺少结束标记')
      if (block.every((byte) => byte === 0)) {
        zeroBlocks += 1
        if (zeroBlocks < 2) continue
        if (pendingPax || pendingLongName) throw archiveError('元数据后缺少文件条目')
        await reader.assertOnlyZeros()
        break
      }
      if (zeroBlocks) throw archiveError('结束标记不完整')

      entryCount += 1
      if (entryCount > limits.maxEntries) throw archiveError('条目数量超过限制')
      const header = headerFrom(block)
      const metadataType = ['x', 'g', 'L'].includes(header.type)
      const headerName = compatibleTarEntryName(header.name, { metadata: metadataType, portableNames })
      let payloadSize = header.size

      if (metadataType) {
        if (pendingPax || pendingLongName) throw archiveError('元数据条目顺序不正确')
        if (header.size > Math.min(MAX_METADATA_BYTES, limits.maxFileBytes)) throw archiveError('元数据条目过大')
        budgetBytes += header.size
        if (budgetBytes > limits.maxTotalBytes) throw archiveError('解压总大小超过限制')
        const payload = await reader.readExactly(header.size)
        if (header.type === 'x') {
          pendingPax = parsePax(payload)
          validatePax(pendingPax)
        } else if (header.type === 'g') {
          const global = parsePax(payload)
          validatePax(global, { global: true })
        } else {
          pendingLongName = longName(payload)
        }
      } else {
        let size = header.size
        const name = compatibleTarEntryName(pendingPax?.get('path') ?? (pendingLongName || headerName), { portableNames })
        if (pendingPax?.has('size')) size = decimalSize(pendingPax.get('size'))
        payloadSize = size
        const directory = header.type === '5'
        const regular = header.type === '0'
        if (['1', '2', '3', '4', '6', 'K'].includes(header.type)) throw archiveError('不允许链接、设备或特殊文件')
        if (!directory && !regular) throw archiveError(`不支持条目类型 ${JSON.stringify(header.type)}`)
        if (directory && size !== 0) throw archiveError('目录条目不能包含数据')
        if (regular && size > limits.maxFileBytes) throw archiveError('单文件超过限制')
        budgetBytes += size
        if (budgetBytes > limits.maxTotalBytes) throw archiveError('解压总大小超过限制')

        const kind = directory ? 'directory' : 'file'
        registerPath(registry, name, kind)
        const stagingPath = path.resolve(staging)
        const target = path.resolve(stagingPath, name)
        const relativeTarget = path.relative(stagingPath, target)
        if (!relativeTarget || relativeTarget === '..' || relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) {
          throw archiveError('路径越界')
        }
        if (directory) {
          await mkdir(target, { recursive: true })
        } else {
          await mkdir(path.dirname(target), { recursive: true })
          const handle = await open(target, 'wx', 0o644)
          try {
            await reader.writeExactly(size, handle)
          } finally {
            await handle.close()
          }
          expandedBytes += size
        }
        entries.push({ name, kind })
        pendingPax = null
        pendingLongName = ''
      }

      const padding = (TAR_BLOCK_BYTES - (payloadSize % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES
      if (padding) await reader.readExactly(padding)
    }

    const root = normalizedRoot(entries)
    const installSource = root ? path.join(staging, root) : staging
    if (root && !(await lstat(installSource)).isDirectory()) throw archiveError('顶层目录无效')
    await installExtraction(installSource, destinationPath, staging)
    return { entries: entryCount, expandedBytes, root: root || null }
  } catch (error) {
    sourceStream.destroy()
    gunzip.destroy()
    throw error
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}
