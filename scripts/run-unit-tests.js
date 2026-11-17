/**
 * 串行运行 test/unit 下的 node:test 文件；避免 Windows 通配符差异。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const dir = path.resolve('test/unit')
const files = fs.readdirSync(dir).filter((name) => name.endsWith('.test.js')).sort().map((name) => path.join(dir, name))
if (files.length === 0) {
  console.error('没有找到 test/unit/*.test.js')
  process.exit(1)
}
let failed = false
for (const file of files) {
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', file], { stdio: 'inherit' })
    child.on('exit', (value) => resolve(value ?? 1))
  })
  if (code !== 0) failed = true
}
process.exit(failed ? 1 : 0)
