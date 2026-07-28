import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { buildTrustedNextSource, runBuildCommand } from '../server/source-build.mjs'

async function sandbox(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'source-build-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return {
    root,
    source: path.join(root, 'source'),
    project: path.join(root, 'source', 'projects'),
    destination: path.join(root, 'release'),
  }
}

async function writeText(target, content = '') {
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, content, 'utf8')
}

async function fakeNextProject(fx) {
  await writeText(path.join(fx.project, 'package.json'), JSON.stringify({
    name: 'offline-next-fixture',
    dependencies: { next: '16.1.1' },
  }))
  await mkdir(path.join(fx.project, 'src', 'app'), { recursive: true })
  await writeText(path.join(fx.project, 'node_modules', 'next', 'dist', 'bin', 'next'), '# fake next binary')

  const html = [
    '<!doctype html>',
    '<script src="/_next/static/chunks/app.js"></script>',
    '<img src="/assets/logo.svg">',
    '<a href="/dashboard">Dashboard</a>',
    '<a href="/login?from=dashboard">Login</a>',
  ].join('')
  await writeText(path.join(fx.project, '.next', 'server', 'app', 'dashboard.html'), html)
  await writeText(path.join(fx.project, '.next', 'server', 'app', 'login.html'), '<a href="/dashboard">返回</a>')
  await writeText(path.join(fx.project, '.next', 'server', 'app', 'index.html'), '<a href="/dashboard">进入</a>')
  await writeText(
    path.join(fx.project, '.next', 'static', 'chunks', 'app.js'),
    'const chunk="/_next/static/chunks/lazy.js";const route="/dashboard";',
  )
  await writeText(
    path.join(fx.project, '.next', 'static', 'css', 'app.css'),
    '.hero{background:url(/assets/logo.svg)}.icon{mask:url(/_next/static/media/icon.svg)}',
  )
  await writeText(path.join(fx.project, 'public', 'assets', 'logo.svg'), '<svg/>')
}

test('buildTrustedNextSource materializes a local Next.js build with stable entry and resource paths', async (t) => {
  const fx = await sandbox(t)
  await fakeNextProject(fx)
  await writeText(path.join(fx.destination, 'stale.txt'), 'remove me')

  const calls = []
  const result = await buildTrustedNextSource(fx.source, fx.destination, {
    runCommand: async (command, args, options) => {
      calls.push({ command, args, options })
      return { log: 'stubbed' }
    },
  })

  assert.equal(result.entryPath, 'dashboard')
  assert.deepEqual(new Set(result.routes), new Set(['dashboard', 'login']))
  assert.equal(calls.length, 2)
  assert.match(calls[0].args.join(' '), /install .*--ignore-scripts .*--prefer-offline/)
  assert.equal(calls[0].options.cwd, fx.project)
  assert.equal(calls[1].command, process.execPath)
  assert.deepEqual(calls[1].args, [path.join(fx.project, 'node_modules', 'next', 'dist', 'bin', 'next'), 'build'])

  const dashboard = await readFile(path.join(fx.destination, 'dashboard.html'), 'utf8')
  assert.match(dashboard, /src="\.\/_next\/static\/chunks\/app\.js"/)
  assert.match(dashboard, /src="\.\/assets\/logo\.svg"/)
  assert.match(dashboard, /href="\.\/dashboard"/)
  assert.match(dashboard, /href="\.\/login\?from=dashboard"/)
  assert.equal(await readFile(path.join(fx.destination, 'root.html'), 'utf8'), '<a href="./dashboard">进入</a>')
  assert.equal(await readFile(path.join(fx.destination, 'assets', 'logo.svg'), 'utf8'), '<svg/>')
  await assert.rejects(readFile(path.join(fx.destination, 'public', 'assets', 'logo.svg')))
  await assert.rejects(readFile(path.join(fx.destination, 'stale.txt')))

  assert.equal(
    await readFile(path.join(fx.destination, '_next', 'static', 'chunks', 'app.js'), 'utf8'),
    'const chunk="./_next/static/chunks/lazy.js";const route="./dashboard";',
  )
  assert.equal(
    await readFile(path.join(fx.destination, '_next', 'static', 'css', 'app.css'), 'utf8'),
    '.hero{background:url(../../../assets/logo.svg)}.icon{mask:url(../../../_next/static/media/icon.svg)}',
  )
})

test('buildTrustedNextSource recognizes app and pages layouts and leaves unsupported sources untouched', async (t) => {
  const fx = await sandbox(t)
  await writeText(path.join(fx.source, 'package.json'), JSON.stringify({ name: 'plain-project' }))
  await mkdir(path.join(fx.source, 'app'), { recursive: true })
  await writeText(path.join(fx.destination, 'sentinel.txt'), 'keep')
  let called = false

  const result = await buildTrustedNextSource(fx.source, fx.destination, {
    runCommand: async () => { called = true },
  })

  assert.equal(result, null)
  assert.equal(called, false)
  assert.equal(await readFile(path.join(fx.destination, 'sentinel.txt'), 'utf8'), 'keep')
})

test('buildTrustedNextSource reports a missing Next.js builder after the stubbed install step', async (t) => {
  const fx = await sandbox(t)
  await writeText(path.join(fx.source, 'package.json'), JSON.stringify({ dependencies: { next: '16.1.1' } }))
  await mkdir(path.join(fx.source, 'pages'), { recursive: true })
  let calls = 0

  await assert.rejects(
    buildTrustedNextSource(fx.source, fx.destination, {
      runCommand: async () => { calls += 1 },
    }),
    /源码依赖安装完成，但未找到 Next\.js 构建器/,
  )
  assert.equal(calls, 1)
})

test('runBuildCommand returns actionable local process failure and startup errors', async () => {
  await assert.rejects(
    runBuildCommand(process.execPath, ['-e', 'process.stderr.write("fixture failed");process.exit(7)']),
    /源码构建失败（退出码 7）：fixture failed/,
  )
  await assert.rejects(
    runBuildCommand(`missing-source-builder-${process.pid}`, []),
    /无法启动源码构建命令/,
  )
})
