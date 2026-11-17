#!/usr/bin/env node
/**
 * 生成发布产物到 dist/：tgz、SHA256、INSTALL.md、CHANGELOG.md、guide/ 副本。
 * 默认要求 git 工作树干净；本地试打包可加 --allow-dirty。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const allowDirty = process.argv.includes('--allow-dirty')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const { version, name } = manifest
const dist = path.join(root, 'dist')
const tarballName = `${name}-${version}.tgz`
const tarballPath = path.join(dist, tarballName)

function ok(message) {
  console.log(`[ok] ${message}`)
}

function fail(message) {
  console.error(`[FAIL] ${message}`)
  process.exit(1)
}

function walk(directory) {
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...walk(full))
    else if (entry.isFile()) files.push(full)
  }
  return files
}

// 1. 干净工作树（git 不可用时跳过）
try {
  const inside = execSync('git rev-parse --is-inside-work-tree', {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
  if (inside === 'true') {
    if (allowDirty) {
      console.warn('[warn] --allow-dirty：跳过 git 工作树校验')
    } else {
      const status = execSync('git status --porcelain', {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      if (status) {
        fail(`git 工作树不干净，请先提交（或使用 --allow-dirty）：\n${status.split('\n').slice(0, 20).join('\n')}`)
      }
      ok('git working tree is clean')
    }
  }
} catch {
  console.warn('[warn] 无法执行 git 检查，跳过干净树校验')
}

// 2. 拒绝覆盖同版本产物
fs.mkdirSync(dist, { recursive: true })
if (fs.existsSync(tarballPath)) {
  fail(`产物已存在，拒绝覆盖：${path.relative(root, tarballPath)}\n请提升版本号，或手动移除旧产物后再发布。`)
}

// 3. 打包
let packed
try {
  const stdout = execSync(`npm pack --json --pack-destination "${dist}"`, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  })
  const start = stdout.indexOf('[')
  const end = stdout.lastIndexOf(']')
  if (start === -1 || end === -1) throw new Error(stdout.slice(0, 200))
  packed = JSON.parse(stdout.slice(start, end + 1))[0]
} catch (error) {
  fail(`npm pack 失败：${error.message}`)
}

if (!fs.existsSync(tarballPath)) {
  fail(`未找到预期产物：${tarballPath}\nnpm pack 返回：${packed?.filename ?? '(unknown)'}`)
}
const size = packed?.size ?? fs.statSync(tarballPath).size
ok(`packed ${tarballName} (${size} bytes)`)

// 4. SHA256
const hash = crypto.createHash('sha256').update(fs.readFileSync(tarballPath)).digest('hex')
fs.writeFileSync(path.join(dist, `${name}-${version}.sha256`), `${hash}  ${tarballName}\n`)
ok(`sha256 ${hash}`)

// 5. 用户文档副本（INSTALL.md 自包含，无相对链接）
fs.copyFileSync(path.join(root, 'docs/guide/02-用户安装与升级.md'), path.join(dist, 'INSTALL.md'))
fs.copyFileSync(path.join(root, 'CHANGELOG.md'), path.join(dist, 'CHANGELOG.md'))
fs.cpSync(path.join(root, 'docs/guide'), path.join(dist, 'guide'), { recursive: true })
ok('copied INSTALL.md, CHANGELOG.md, guide/')

// 6. SHA256SUMS（只列本次产物）
const artifacts = [
  { relative: tarballName, absolute: tarballPath },
  { relative: 'INSTALL.md', absolute: path.join(dist, 'INSTALL.md') },
  { relative: 'CHANGELOG.md', absolute: path.join(dist, 'CHANGELOG.md') },
]
for (const file of walk(path.join(dist, 'guide'))) {
  artifacts.push({
    relative: path.relative(dist, file).replace(/\\/g, '/'),
    absolute: file,
  })
}
const sums = artifacts
  .sort((left, right) => left.relative.localeCompare(right.relative))
  .map(({ relative, absolute }) => {
    const digest = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')
    return `${digest}  ${relative}`
  })
fs.writeFileSync(path.join(dist, 'SHA256SUMS'), `${sums.join('\n')}\n`)
ok('wrote SHA256SUMS')

// 7. 下一步提示
console.log(`\n产物目录: ${dist}`)
for (const file of [tarballName, `${name}-${version}.sha256`, 'SHA256SUMS', 'INSTALL.md', 'CHANGELOG.md', 'guide/']) {
  console.log(`  ${file}`)
}
console.log(`\nSHA256: ${hash}`)
console.log('\n下一步：')
console.log(`1) 上传到不可变版本目录，例如 \\\\fileserver\\release\\tmsync\\v${version}\\ 或 https://files.example.com/tmsync/v${version}/`)
console.log('2) 冒烟安装：')
console.log(`   dsh plugin --profile tmsync-test add "${tarballPath}"`)
console.log('   dsh --profile tmsync-test --dump-config | Select-String -Pattern "tmsync|preset-tmsync"')
console.log('   dsh --profile tmsync-test --no-open --port 3091')
console.log('3) 公告附上 tarball URL 与 SHA256；URL 必须以 .tgz 结尾且不要带 query。')
