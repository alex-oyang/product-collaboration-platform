import { createWriteStream } from 'node:fs'
import { cp, mkdir, open, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import yauzl from 'yauzl'

const MAX_ENTRIES = 10_000
const MAX_FILE_BYTES = 100 * 1024 * 1024
const MAX_TOTAL_BYTES = 200 * 1024 * 1024

function safeEntryName(input) {
  const name = String(input)
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new Error('ZIP 包含非法路径')
  }
  const parts = name.split('/')
  if (parts.some((part) => part === '..' || part === '.')) throw new Error('ZIP 包含越界路径')
  if (parts.some((part) => part.toLowerCase() === '.git')) throw new Error('ZIP 不允许包含 Git 元数据')
  return parts.filter(Boolean).join('/') + (name.endsWith('/') ? '/' : '')
}

function isSymlink(entry) {
  return (((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000)
}

function openZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true, decodeStrings: true, validateEntrySizes: true }, (error, zip) => {
      if (error) reject(error)
      else resolve(zip)
    })
  })
}

function openEntry(zip, entry) {
  return new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream)))
}

export async function extractZipSafely(zipPath, destination) {
  const extraction = `${destination}.extracting`
  await rm(extraction, { recursive: true, force: true })
  await mkdir(extraction, { recursive: true })
  const zip = await openZip(zipPath)
  let count = 0
  let total = 0
  const names = []
  try {
    await new Promise((resolve, reject) => {
      let busy = false
      const fail = (error) => { try { zip.close() } catch {}; reject(error) }
      zip.on('error', fail)
      zip.on('end', resolve)
      zip.on('entry', async (entry) => {
        if (busy) return fail(new Error('ZIP 读取状态异常'))
        busy = true
        try {
          count += 1
          if (count > MAX_ENTRIES) throw new Error('ZIP 文件数量超过限制')
          const name = safeEntryName(entry.fileName)
          if (isSymlink(entry)) throw new Error('ZIP 不允许符号链接')
          const directory = name.endsWith('/')
          if (!directory) {
            if (entry.uncompressedSize > MAX_FILE_BYTES) throw new Error('ZIP 单文件超过限制')
            total += entry.uncompressedSize
            if (total > MAX_TOTAL_BYTES) throw new Error('ZIP 解压总大小超过限制')
          }
          const target = path.resolve(extraction, name)
          if (!target.startsWith(`${path.resolve(extraction)}${path.sep}`)) throw new Error('ZIP 路径越界')
          if (directory) {
            await mkdir(target, { recursive: true })
          } else {
            names.push(name)
            await mkdir(path.dirname(target), { recursive: true })
            const handle = await open(target, 'wx')
            await handle.close()
            const stream = await openEntry(zip, entry)
            await pipeline(stream, createWriteStream(target, { flags: 'w' }))
          }
          busy = false
          zip.readEntry()
        } catch (error) {
          fail(error)
        }
      })
      zip.readEntry()
    })

    const lower = names.map((name) => name.toLowerCase())
    let root = ''
    if (!lower.includes('index.html')) {
      const candidates = names.filter((name) => /^[^/]+\/index\.html$/i.test(name))
      if (candidates.length !== 1) throw new Error('ZIP 根目录必须包含 index.html')
      root = candidates[0].split('/')[0]
      if (names.some((name) => !name.startsWith(`${root}/`))) throw new Error('ZIP 只能包含一个原型根目录')
    }
    const source = root ? path.join(extraction, root) : extraction
    await rm(destination, { recursive: true, force: true })
    await mkdir(destination, { recursive: true })
    await cp(source, destination, { recursive: true, errorOnExist: true, force: false })
    const files = await readdir(destination)
    if (!files.some((name) => name.toLowerCase() === 'index.html')) throw new Error('未找到 index.html')
    return { entries: count, expandedBytes: total }
  } catch (error) {
    await rm(destination, { recursive: true, force: true }).catch(() => {})
    throw error
  } finally {
    try { zip.close() } catch {}
    await rm(extraction, { recursive: true, force: true }).catch(() => {})
  }
}
