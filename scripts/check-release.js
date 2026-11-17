#!/usr/bin/env node
/**
 * 发布前静态校验：版本一致性、包名引用、打包文件白名单与发布机路径泄露。
 * 不执行测试；由 `npm run release:check` 串联 test:unit 与 check:links。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { SUPPORT_RANGE, TESTED_DSH, inSupportRange, parseVersion } from '../server/compat.js'
import { publisherPaths, staleInstallPatterns, versionFromSource } from './release-rules.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const notes = []

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8')
}

function exists(relative) {
  return fs.existsSync(path.join(root, relative))
}

function ok(message) {
  console.log(`[ok] ${message}`)
}

function fail(message) {
  failures.push(message)
  console.error(`[FAIL] ${message}`)
}

function check(condition, message) {
  if (condition) ok(message)
  else fail(message)
}

const manifest = JSON.parse(read('package.json'))
const { version, name } = manifest

// 1. 身份与 bundle 元数据
check(name === 'tmsync', `package name is tmsync (got ${String(name)})`)
if (manifest.private === true) {
  ok('package is private (prevents accidental npm publish)')
} else {
  console.warn('[warn] package is not private: intended for registry publishing only')
}
check(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version), `version is valid semver (${version})`)
check(typeof manifest.engines?.dsh === 'string' && manifest.engines.dsh.length > 0, 'engines.dsh is declared')
check(manifest.engines?.dsh === SUPPORT_RANGE, `engines.dsh matches server/compat.js (${SUPPORT_RANGE})`)
const tested = Array.isArray(TESTED_DSH) ? TESTED_DSH : []
check(tested.length > 0 && tested.every((item) => parseVersion(item) !== undefined && inSupportRange(item)), 'TESTED_DSH entries are valid and in range')
check(new Set(tested.map((item) => parseVersion(item)?.raw)).size === tested.length, 'TESTED_DSH has no duplicates')
const releases = manifest.dsh?.compatibility?.dshReleases
check(releases !== null && typeof releases === 'object' && !Array.isArray(releases), 'dsh.compatibility.dshReleases is an object')
if (releases !== null && typeof releases === 'object' && !Array.isArray(releases)) {
  const keys = Object.keys(releases)
  check(keys.length > 0 && keys.every((item) => parseVersion(item) !== undefined && inSupportRange(item)), 'dshReleases keys are valid and in range')
  check(new Set(keys.map((item) => parseVersion(item)?.raw)).size === keys.length, 'dshReleases has no duplicate versions')
}
check(manifest.dsh?.client?.platform === 'web', 'dsh.client.platform is web')

const patches = manifest.dsh?.bundle?.patch
check(
  Array.isArray(patches)
    && patches.includes('./cordis.patch.yml')
    && patches.includes('./preset/tmsync/preset.patch.yml'),
  'dsh.bundle.patch lists both bundle patches',
)

// 2. 版本单一来源与多处一致
check(versionFromSource(read('server/version.js')) === version, `server/version.js VERSION matches ${version}`)
check(read('server/mcp.js').includes('version: VERSION'), 'server/mcp.js uses VERSION')
check(read('server/service.js').includes('version: VERSION'), 'server/service.js info uses VERSION')
check(read('README.md').includes(`当前为 **v${version}**`), `README.md shows 当前为 **v${version}**`)
check(
  new RegExp(`^## v${version.replace(/\./g, '\\.')}(?:\\s|$)`, 'm').test(read('CHANGELOG.md')),
  `CHANGELOG.md has a v${version} section`,
)
const guideReadme = read('docs/guide/README.md')
const guideInstall = read('docs/guide/02-用户安装与升级.md')
const installPatterns = [`v${version}/tmsync-${version}.tgz`, `tmsync-${version}.tgz`, `tmsync@${version}`]
for (const pattern of installPatterns) {
  check(guideReadme.includes(pattern) || guideInstall.includes(pattern), `docs/guide shows install pattern ${pattern}`)
}
for (const stale of staleInstallPatterns(version)) {
  check(!guideReadme.includes(stale) && !guideInstall.includes(stale) && !read('README.md').includes(stale), `no stale install reference ${stale}`)
}
for (const workflow of ['.github/workflows/pr-checks.yml', '.github/workflows/release.yml']) {
  check(exists(workflow), `workflow exists: ${workflow}`)
}

// 3. preset/宿主引用的包名（改 scope 时必须同步修改）
const cordis = read('cordis.patch.yml')
check(/name:\s*['"]tmsync['"]/.test(cordis), "cordis.patch.yml references 'tmsync'")
const preset = read('preset/tmsync/preset.patch.yml')
check(
  preset.includes("'tmsync/tools'") || preset.includes('"tmsync/tools"'),
  "preset.patch.yml references 'tmsync/tools'",
)
check(
  preset.includes("resolve('tmsync/package.json')") || preset.includes('resolve("tmsync/package.json")'),
  "preset.patch.yml resolves 'tmsync/package.json'",
)

// 4. 运行必需文件
const required = [
  'lib/index.js',
  'lib/client.js',
  'lib/tools.js',
  'server/routes.js',
  'public/index.html',
  'public/app.js',
  'public/style.css',
  'preset/tmsync/preset.patch.yml',
  'cordis.patch.yml',
  'README.md',
  'CHANGELOG.md',
  'docs/guide/README.md',
  'docs/guide/01-打包与发布.md',
  'docs/guide/02-用户安装与升级.md',
]
for (const file of required) check(exists(file), `required file exists: ${file}`)

// 5. npm pack 白名单
let pack
try {
  const stdout = execSync('npm pack --dry-run --json', {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  })
  const start = stdout.indexOf('[')
  const end = stdout.lastIndexOf(']')
  if (start === -1 || end === -1) throw new Error(`unexpected npm pack output: ${stdout.slice(0, 200)}`)
  pack = JSON.parse(stdout.slice(start, end + 1))[0]
} catch (error) {
  fail(`npm pack --dry-run failed: ${error.message}`)
}

if (pack) {
  const files = pack.files.map((entry) => entry.path)
  const present = new Set(files)
  check(files.length > 0, `npm pack lists files (${files.length})`)
  for (const file of required) check(present.has(file), `packed file present: ${file}`)

  const forbiddenPrefixes = [
    'node_modules/',
    'test/',
    'docs/design/',
    'scripts/',
    'data/',
    '.tmsync/',
    '.git/',
  ]
  for (const prefix of forbiddenPrefixes) {
    check(!files.some((file) => file.startsWith(prefix)), `pack excludes ${prefix}`)
  }
  for (const file of ['config.json', 'pnpm-lock.yaml']) {
    check(!files.includes(file), `pack excludes ${file}`)
  }

  const textExtensions = new Set(['.js', '.json', '.yml', '.yaml', '.md', '.html', '.css', '.txt'])
  const sensitivePaths = publisherPaths()
  let leaked = false
  for (const file of files) {
    if (!textExtensions.has(path.extname(file).toLowerCase())) continue
    const text = read(file)
    for (const marker of sensitivePaths) {
      if (text.includes(marker)) {
        leaked = true
        fail(`packed file ${file} contains publisher path ${JSON.stringify(marker)}`)
      }
    }
  }
  if (!leaked) ok('packed files contain no publisher-local paths')

  notes.push(`tarball: ${pack.filename} (${pack.size} bytes, ${files.length} files)`)
}

if (failures.length > 0) {
  console.error(`\nrelease check failed: ${failures.length} problem(s)`)
  process.exit(1)
}

for (const note of notes) console.log(note)
console.log('\nrelease check passed')
