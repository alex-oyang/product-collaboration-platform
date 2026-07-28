import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { gzipSync } from 'node:zlib'

import { extractTarSafely, safeTarEntryName, TAR_LIMITS } from '../server/tar.mjs'

function writeOctal(block, offset, length, value) {
  const text = Number(value).toString(8).padStart(length - 1, '0')
  block.write(text.slice(-(length - 1)), offset, length - 1, 'ascii')
  block[offset + length - 1] = 0
}

function tarHeader({ name, type = '0', size = 0 }) {
  const block = Buffer.alloc(512)
  const nameBytes = Buffer.from(name)
  if (nameBytes.length > 100) throw new Error('Test header names must fit in the legacy field')
  nameBytes.copy(block, 0)
  writeOctal(block, 100, 8, type === '5' ? 0o755 : 0o644)
  writeOctal(block, 108, 8, 0)
  writeOctal(block, 116, 8, 0)
  writeOctal(block, 124, 12, size)
  writeOctal(block, 136, 12, 0)
  block.fill(0x20, 148, 156)
  block[156] = type.charCodeAt(0)
  block.write('ustar\0', 257, 6, 'ascii')
  block.write('00', 263, 2, 'ascii')
  let checksum = 0
  for (const byte of block) checksum += byte
  block.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii')
  block[154] = 0
  block[155] = 0x20
  return block
}

function tarBuffer(entries, { endBlocks = 2, trailing = Buffer.alloc(0) } = {}) {
  const chunks = []
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '')
    const declaredSize = entry.size ?? data.length
    chunks.push(tarHeader({ ...entry, size: declaredSize }))
    if (data.length) chunks.push(data)
    const padding = (512 - (data.length % 512)) % 512
    if (padding) chunks.push(Buffer.alloc(padding))
  }
  if (endBlocks) chunks.push(Buffer.alloc(512 * endBlocks))
  if (trailing.length) chunks.push(trailing)
  return Buffer.concat(chunks)
}

function tarGzip(entries, options) {
  return gzipSync(tarBuffer(entries, options))
}

function paxRecord(key, value) {
  const body = `${key}=${value}\n`
  let length = Buffer.byteLength(body) + 2
  while (true) {
    const record = `${length} ${body}`
    const actual = Buffer.byteLength(record)
    if (actual === length) return record
    length = actual
  }
}

async function sandbox(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'safe-tar-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return {
    root,
    archive: path.join(root, 'project.tgz'),
    destination: path.join(root, 'output'),
  }
}

test('extractTarSafely normalizes one top-level directory and supports PAX and GNU long names', async (t) => {
  const fx = await sandbox(t)
  const paxPath = `projects/src/${'segment-'.repeat(13)}page.tsx`
  const gnuPath = `projects/lib/${'nested/'.repeat(15)}helper.ts`
  const archive = tarGzip([
    { name: 'projects/', type: '5' },
    { name: 'projects/package.json', data: '{"name":"demo"}' },
    { name: 'PaxHeaders/page', type: 'x', data: paxRecord('path', paxPath) },
    { name: 'projects/pax-placeholder', data: 'pax' },
    { name: '././@LongLink', type: 'L', data: Buffer.from(`${gnuPath}\0`) },
    { name: 'projects/gnu-placeholder', data: 'gnu' },
  ])
  await writeFile(fx.archive, archive)

  const result = await extractTarSafely(fx.archive, fx.destination)

  assert.equal(result.root, 'projects')
  assert.equal(await readFile(path.join(fx.destination, 'package.json'), 'utf8'), '{"name":"demo"}')
  assert.equal(await readFile(path.join(fx.destination, paxPath.slice('projects/'.length)), 'utf8'), 'pax')
  assert.equal(await readFile(path.join(fx.destination, gnuPath.slice('projects/'.length)), 'utf8'), 'gnu')
  await assert.rejects(readFile(path.join(fx.destination, 'projects', 'package.json')))
})

test('extractTarSafely preserves multiple top-level entries', async (t) => {
  const fx = await sandbox(t)
  await writeFile(fx.archive, tarGzip([
    { name: 'README.md', data: 'readme' },
    { name: 'projects/app/page.tsx', data: 'page' },
  ]))

  const result = await extractTarSafely(fx.archive, fx.destination)
  assert.equal(result.root, null)
  assert.equal(await readFile(path.join(fx.destination, 'README.md'), 'utf8'), 'readme')
  assert.equal(await readFile(path.join(fx.destination, 'projects', 'app', 'page.tsx'), 'utf8'), 'page')
})

test('extractTarSafely can normalize legacy Windows-incompatible names for trusted source packages', async (t) => {
  const fx = await sandbox(t)
  await writeFile(fx.archive, tarGzip([
    { name: 'projects/', type: '5' },
    { name: 'projects/assets/AI??????.md', data: 'legacy name' },
    { name: 'projects/package.json', data: '{"name":"demo"}' },
  ]))

  await extractTarSafely(fx.archive, fx.destination, { portableNames: true })
  assert.equal(await readFile(path.join(fx.destination, 'assets', 'AI______.md'), 'utf8'), 'legacy name')
})

test('extractTarSafely rejects unsafe paths and preserves an existing destination', async (t) => {
  const cases = [
    '../escape.txt',
    '/absolute.txt',
    'C:/drive.txt',
    'projects\\backslash.txt',
    'projects/.git/config',
    'projects/NUL.txt',
    'projects/bad?.txt',
    'projects/trailing./file.txt',
  ]
  for (const name of cases) {
    await t.test(name, async (t) => {
      const fx = await sandbox(t)
      await mkdir(fx.destination, { recursive: true })
      await writeFile(path.join(fx.destination, 'sentinel.txt'), 'keep')
      await writeFile(fx.archive, tarGzip([{ name, data: 'bad' }]))
      await assert.rejects(extractTarSafely(fx.archive, fx.destination), /TAR/)
      assert.equal(await readFile(path.join(fx.destination, 'sentinel.txt'), 'utf8'), 'keep')
    })
  }
})

test('extractTarSafely rejects links, devices, special entries and duplicate files', async (t) => {
  for (const type of ['1', '2', '3', '4', '6', '7', 'K', 'S']) {
    await t.test(`type ${type}`, async (t) => {
      const fx = await sandbox(t)
      await writeFile(fx.archive, tarGzip([{ name: 'projects/item', type }]))
      await assert.rejects(extractTarSafely(fx.archive, fx.destination), /TAR/)
    })
  }

  await t.test('duplicate file', async (t) => {
    const fx = await sandbox(t)
    await writeFile(fx.archive, tarGzip([
      { name: 'projects/item.txt', data: 'one' },
      { name: 'projects/item.txt', data: 'two' },
    ]))
    await assert.rejects(extractTarSafely(fx.archive, fx.destination), /重复条目/)
  })
})

test('extractTarSafely rejects unsafe extended metadata and malformed termination', async (t) => {
  await t.test('PAX sparse metadata', async (t) => {
    const fx = await sandbox(t)
    await writeFile(fx.archive, tarGzip([
      { name: 'PaxHeaders/item', type: 'x', data: paxRecord('GNU.sparse.size', '1') },
      { name: 'projects/item', data: 'x' },
    ]))
    await assert.rejects(extractTarSafely(fx.archive, fx.destination), /PAX/)
  })

  await t.test('global PAX path override', async (t) => {
    const fx = await sandbox(t)
    await writeFile(fx.archive, tarGzip([
      { name: 'GlobalPaxHeader', type: 'g', data: paxRecord('path', 'projects/override') },
      { name: 'projects/item', data: 'x' },
    ]))
    await assert.rejects(extractTarSafely(fx.archive, fx.destination), /全局 PAX/)
  })

  await t.test('GNU long name without NUL terminator', async (t) => {
    const fx = await sandbox(t)
    await writeFile(fx.archive, tarGzip([
      { name: '././@LongLink', type: 'L', data: 'projects/item' },
      { name: 'projects/item', data: 'x' },
    ]))
    await assert.rejects(extractTarSafely(fx.archive, fx.destination), /终止符/)
  })

  await t.test('missing TAR end blocks', async (t) => {
    const fx = await sandbox(t)
    await writeFile(fx.archive, tarGzip([{ name: 'projects/item', data: 'x' }], { endBlocks: 0 }))
    await assert.rejects(extractTarSafely(fx.archive, fx.destination), /结束标记/)
  })

  await t.test('non-zero data after TAR end blocks', async (t) => {
    const fx = await sandbox(t)
    await writeFile(fx.archive, tarGzip(
      [{ name: 'projects/item', data: 'x' }],
      { trailing: Buffer.from([1]) },
    ))
    await assert.rejects(extractTarSafely(fx.archive, fx.destination), /非零数据/)
  })
})

test('extractTarSafely enforces stricter entry, file and total limits', async (t) => {
  await t.test('entry count', async (t) => {
    const fx = await sandbox(t)
    await writeFile(fx.archive, tarGzip([
      { name: 'projects/a', data: 'a' },
      { name: 'projects/b', data: 'b' },
      { name: 'projects/c', data: 'c' },
    ]))
    await assert.rejects(extractTarSafely(fx.archive, fx.destination, {
      limits: { maxEntries: 2 },
    }), /条目数量/)
  })

  await t.test('single file', async (t) => {
    const fx = await sandbox(t)
    await writeFile(fx.archive, tarGzip([{ name: 'projects/big', data: '12345' }]))
    await assert.rejects(extractTarSafely(fx.archive, fx.destination, {
      limits: { maxFileBytes: 4 },
    }), /单文件/)
  })

  await t.test('total bytes', async (t) => {
    const fx = await sandbox(t)
    await writeFile(fx.archive, tarGzip([
      { name: 'projects/a', data: '1234' },
      { name: 'projects/b', data: '567' },
    ]))
    await assert.rejects(extractTarSafely(fx.archive, fx.destination, {
      limits: { maxTotalBytes: 6 },
    }), /总大小/)
  })

  await t.test('hard ceilings cannot be relaxed', async (t) => {
    const fx = await sandbox(t)
    await writeFile(fx.archive, tarGzip([{
      name: 'projects/oversized',
      size: TAR_LIMITS.maxFileBytes + 1,
    }]))
    await assert.rejects(extractTarSafely(fx.archive, fx.destination, {
      limits: { maxFileBytes: TAR_LIMITS.maxFileBytes + 1 },
    }), /单文件/)
  })

  assert.deepEqual(TAR_LIMITS, {
    maxEntries: 10_000,
    maxFileBytes: 100 * 1024 * 1024,
    maxTotalBytes: 200 * 1024 * 1024,
  })
})

test('safeTarEntryName accepts portable relative paths and rejects unsafe names', () => {
  assert.equal(safeTarEntryName('projects/app/page.tsx'), 'projects/app/page.tsx')
  assert.throws(() => safeTarEntryName('../escape'), /TAR/)
  assert.throws(() => safeTarEntryName('projects/COM1.log'), /TAR/)
  assert.throws(() => safeTarEntryName('projects/bad|name'), /TAR/)
})
