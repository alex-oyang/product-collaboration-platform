import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const BUILD_TIMEOUT_MS = 8 * 60 * 1000
const MAX_LOG_BYTES = 2 * 1024 * 1024

async function isFile(target) {
  try { return (await stat(target)).isFile() } catch { return false }
}

async function isDirectory(target) {
  try { return (await stat(target)).isDirectory() } catch { return false }
}

function appendLog(chunks, chunk) {
  const value = Buffer.from(chunk)
  chunks.push(value.length > MAX_LOG_BYTES ? value.subarray(value.length - MAX_LOG_BYTES) : value)
  let total = chunks.reduce((sum, item) => sum + item.length, 0)
  while (total > MAX_LOG_BYTES && chunks.length > 1) total -= chunks.shift().length
  if (total > MAX_LOG_BYTES) chunks[0] = chunks[0].subarray(total - MAX_LOG_BYTES)
}

function sourceBuildEnvironment() {
  const environment = { ...process.env }
  const pathValues = []
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() !== 'path') continue
    if (environment[key]) pathValues.push(environment[key])
    delete environment[key]
  }
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  environment.PATH = pathValues.join(path.delimiter) || [path.dirname(process.execPath), path.join(systemRoot, 'System32'), systemRoot].join(path.delimiter)
  environment.CI = '1'
  environment.NEXT_TELEMETRY_DISABLED = '1'
  environment.NODE_ENV = 'production'
  return environment
}

export function runBuildCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const output = []
    let timedOut = false
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: sourceBuildEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timeout = options.timeout ?? BUILD_TIMEOUT_MS
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeout)
    child.stdout.on('data', (chunk) => appendLog(output, chunk))
    child.stderr.on('data', (chunk) => appendLog(output, chunk))
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`无法启动源码构建命令（${command}）：${error.message}`, { cause: error }))
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      const log = Buffer.concat(output).toString('utf8').trim()
      const logSuffix = log ? `：${log.slice(-1200)}` : ''
      if (code === 0 && !timedOut) resolve({ log })
      else if (timedOut) reject(new Error(`源码构建超时（${timeout} 毫秒）${logSuffix}`))
      else if (signal) reject(new Error(`源码构建被终止（${signal}）${logSuffix}`))
      else reject(new Error(`源码构建失败（退出码 ${code ?? '未知'}）${logSuffix}`))
    })
  })
}

async function findNextProjectRoot(sourceDir) {
  if (await isFile(path.join(sourceDir, 'package.json'))) return sourceDir
  const entries = await readdir(sourceDir, { withFileTypes: true })
  const directories = entries.filter((entry) => entry.isDirectory())
  if (directories.length !== 1) return null
  const candidate = path.join(sourceDir, directories[0].name)
  return await isFile(path.join(candidate, 'package.json')) ? candidate : null
}

async function readNextManifest(projectRoot) {
  let manifest
  try { manifest = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8')) } catch { return null }
  const nextVersion = manifest?.dependencies?.next ?? manifest?.devDependencies?.next
  const hasNextRoutes = await Promise.all([
    path.join(projectRoot, 'src', 'app'),
    path.join(projectRoot, 'app'),
    path.join(projectRoot, 'src', 'pages'),
    path.join(projectRoot, 'pages'),
  ].map(isDirectory)).then((results) => results.some(Boolean))
  if (typeof nextVersion !== 'string' || !hasNextRoutes) return null
  return manifest
}

function fixedInstallCommand() {
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(npmCli)) {
    return {
      command: process.execPath,
      args: [npmCli, 'install', '--include=dev', '--ignore-scripts', '--prefer-offline', '--no-audit', '--no-fund'],
    }
  }
  if (process.platform !== 'win32') {
    return { command: 'pnpm', args: ['install', '--prod=false', '--ignore-scripts', '--prefer-offline', '--reporter=append-only'] }
  }
  const command = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe'
  return {
    command,
    args: ['/d', '/s', '/c', 'pnpm install --prod=false --ignore-scripts --prefer-offline --reporter=append-only'],
  }
}

function routeFromHtml(relative) {
  const normalized = relative.split(path.sep).join('/')
  if (normalized === 'index.html') return ''
  if (normalized.startsWith('_') || normalized.includes('/')) return null
  return normalized.slice(0, -'.html'.length)
}

async function listFiles(root, current = root) {
  const result = []
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const target = path.join(current, entry.name)
    if (entry.isDirectory()) result.push(...await listFiles(root, target))
    else if (entry.isFile()) result.push({ target, relative: path.relative(root, target) })
  }
  return result
}

function rewriteStaticText(source, routes, publicFiles) {
  let result = source.replaceAll('/_next/', './_next/')
  for (const publicFile of publicFiles) result = result.replaceAll(`/${publicFile}`, `./${publicFile}`)
  for (const route of [...routes].sort((a, b) => b.length - a.length)) {
    result = result.replaceAll(`/${route}`, `./${route}`)
  }
  return result
}

function rewriteStaticCss(source, cssFile, destination, publicFiles) {
  const relativeRoot = path.relative(path.dirname(cssFile), destination).split(path.sep).join('/') || '.'
  let result = source.replaceAll('/_next/', `${relativeRoot}/_next/`)
  for (const publicFile of publicFiles) {
    result = result.replaceAll(`/${publicFile}`, `${relativeRoot}/${publicFile}`)
  }
  return result
}

async function copyPublicFiles(publicRoot, destination) {
  const files = await listFiles(publicRoot)
  for (const file of files) {
    const target = path.join(destination, file.relative)
    await mkdir(path.dirname(target), { recursive: true })
    if (await isFile(target)) {
      throw new Error(`public 资源与构建产物重名：${file.relative.split(path.sep).join('/')}`)
    }
    await copyFile(file.target, target)
  }
  return files.map((file) => file.relative.split(path.sep).join('/'))
}

async function materializeNextStatic(projectRoot, destination) {
  const appRoot = path.join(projectRoot, '.next', 'server', 'app')
  const staticRoot = path.join(projectRoot, '.next', 'static')
  if (!await isDirectory(appRoot) || !await isDirectory(staticRoot)) throw new Error('Next.js 构建未生成可预览页面')

  const htmlFiles = (await listFiles(appRoot)).filter((file) => file.relative.toLowerCase().endsWith('.html'))
  const routeFiles = htmlFiles.map((file) => ({ ...file, route: routeFromHtml(file.relative) })).filter((file) => file.route !== null)
  const routes = routeFiles.map((file) => file.route).filter(Boolean)
  const preferred = routeFiles.find((file) => file.route === 'dashboard')
    ?? routeFiles.find((file) => file.route && file.route !== 'login')
    ?? routeFiles.find((file) => file.route === '')
  if (!preferred) throw new Error('Next.js 构建没有可作为入口的静态页面')

  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })
  await cp(staticRoot, path.join(destination, '_next', 'static'), { recursive: true, errorOnExist: true, force: false })

  const publicRoot = path.join(projectRoot, 'public')
  const publicFiles = await isDirectory(publicRoot) ? await copyPublicFiles(publicRoot, destination) : []

  for (const file of routeFiles) {
    const name = file.route ? `${file.route}.html` : 'root.html'
    const target = path.join(destination, name)
    if (await isFile(target)) throw new Error(`public 资源与静态页面重名：${name}`)
    const html = rewriteStaticText(await readFile(file.target, 'utf8'), routes, publicFiles)
    await writeFile(target, html, 'utf8')
  }

  const staticFiles = await listFiles(path.join(destination, '_next', 'static'))
  for (const file of staticFiles) {
    const extension = path.extname(file.target).toLowerCase()
    if (!['.js', '.json', '.css'].includes(extension)) continue
    const source = await readFile(file.target, 'utf8')
    const rewritten = extension === '.css'
      ? rewriteStaticCss(source, file.target, destination, publicFiles)
      : rewriteStaticText(source, routes, publicFiles)
    if (rewritten !== source) await writeFile(file.target, rewritten, 'utf8')
  }

  return { entryPath: preferred.route || 'root.html', routes }
}

export async function buildTrustedNextSource(sourceDir, destination, options = {}) {
  const projectRoot = await findNextProjectRoot(path.resolve(sourceDir))
  if (!projectRoot || !await readNextManifest(projectRoot)) return null
  const run = options.runCommand ?? runBuildCommand
  const install = fixedInstallCommand()
  await run(install.command, install.args, { cwd: projectRoot, timeout: options.timeout })
  const nextBin = path.join(projectRoot, 'node_modules', 'next', 'dist', 'bin', 'next')
  if (!await isFile(nextBin)) throw new Error('源码依赖安装完成，但未找到 Next.js 构建器')
  await run(process.execPath, [nextBin, 'build'], { cwd: projectRoot, timeout: options.timeout })
  return materializeNextStatic(projectRoot, destination)
}
