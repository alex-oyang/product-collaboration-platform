import { spawn } from 'node:child_process'
import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'

function runGit(cwd, args, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.once('error', reject)
    child.once('close', (code) => {
      const result = { code, stdout: Buffer.concat(stdout).toString('utf8').trim(), stderr: Buffer.concat(stderr).toString('utf8').trim() }
      if (code === 0 || allowFailure) resolve(result)
      else reject(new Error(`Git 命令失败：${result.stderr || result.stdout || code}`))
    })
  })
}

function productRepo(gitRoot, productId) {
  if (!/^[A-Za-z0-9_-]+$/.test(productId)) throw new Error('产品 Git 路径不正确')
  const root = path.resolve(gitRoot)
  const repo = path.resolve(root, productId)
  if (!repo.startsWith(`${root}${path.sep}`)) throw new Error('产品 Git 路径越界')
  return repo
}

export async function createGitSnapshot({ gitRoot, productId, version, sourceDir }) {
  if (!/^\d{14}$/.test(version)) throw new Error('Git 版本号必须是 14 位时间')
  const repo = productRepo(gitRoot, productId)
  const tag = `v${version}`
  await mkdir(gitRoot, { recursive: true })
  let createdRepo = false
  try {
    await runGit(repo, ['rev-parse', '--git-dir'])
  } catch {
    await mkdir(repo, { recursive: true })
    await runGit(repo, ['init'])
    await runGit(repo, ['config', 'user.name', 'Prototype Review System'])
    await runGit(repo, ['config', 'user.email', 'prototype-review@local.invalid'])
    await runGit(repo, ['config', 'core.autocrlf', 'false'])
    createdRepo = true
  }

  const previous = await runGit(repo, ['rev-parse', 'HEAD'], { allowFailure: true })
  const previousHead = previous.code === 0 ? previous.stdout : ''
  const rollback = async () => {
    await runGit(repo, ['tag', '-d', tag], { allowFailure: true }).catch(() => {})
    if (createdRepo && !previousHead) await rm(repo, { recursive: true, force: true }).catch(() => {})
    else if (previousHead) {
      await runGit(repo, ['reset', '--hard', previousHead], { allowFailure: true }).catch(() => {})
      await runGit(repo, ['clean', '-fdx'], { allowFailure: true }).catch(() => {})
    }
  }
  try {
    for (const entry of await readdir(repo, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      await rm(path.join(repo, entry.name), { recursive: true, force: true })
    }
    await cp(sourceDir, repo, { recursive: true, force: true })
    await runGit(repo, ['add', '--all'])
    await runGit(repo, ['commit', '--allow-empty', '-m', `Publish ${tag}`])
    const commit = (await runGit(repo, ['rev-parse', 'HEAD'])).stdout
    await runGit(repo, ['tag', '-a', tag, '-m', `Prototype release ${tag}`, commit])
    return { gitTag: tag, gitCommit: commit, repo, rollback }
  } catch (error) {
    await rollback()
    throw error
  }
}
