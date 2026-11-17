#!/usr/bin/env node
/** 检查 docs/design 下 Markdown 相对链接是否有效。 */
import fs from 'node:fs'
import path from 'node:path'

const roots = process.argv.slice(2).length ? process.argv.slice(2) : ['docs/design', 'docs/guide']
const files = []
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (entry.name.endsWith('.md')) files.push(full)
  }
}
for (const root of roots) {
  if (!fs.existsSync(root)) continue
  if (fs.statSync(root).isDirectory()) walk(root)
  else if (root.endsWith('.md')) files.push(root)
}

const broken = []
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8')
  const re = /\[[^\]]*\]\(([^)]+)\)/g
  let match
  while ((match = re.exec(text))) {
    let target = match[1].trim()
    if (!target || /^https?:/i.test(target) || target.startsWith('mailto:') || target.startsWith('#')) continue
    target = target.split('#')[0]
    if (!target) continue
    let decoded
    try { decoded = decodeURIComponent(target) } catch { decoded = target }
    const resolved = path.resolve(path.dirname(file), decoded)
    if (!fs.existsSync(resolved)) broken.push({ file, target })
  }
}

if (broken.length) {
  console.error(`broken links: ${broken.length}`)
  for (const item of broken) console.error(`- ${path.relative(process.cwd(), item.file)} -> ${item.target}`)
  process.exit(1)
}
console.log(`checked ${files.length} markdown files; broken links: 0`)
