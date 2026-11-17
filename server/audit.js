/**
 * 同步审计日志：~/.dsh/tmsync/logs/YYYY-MM.jsonl。
 * 只记录操作摘要，不记录 token、字段值、测试数据正文。
 */
import fs from 'node:fs/promises'
import path from 'node:path'

function monthFile(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}.jsonl`
}

export async function appendLog(dataDir, entry) {
  try {
    const dir = path.join(dataDir, 'logs')
    await fs.mkdir(dir, { recursive: true })
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry })
    await fs.appendFile(path.join(dir, monthFile()), `${line}\n`, 'utf8')
  } catch {
    // 日志失败不阻塞同步
  }
}

export async function readLogs(dataDir, limit = 50) {
  try {
    const dir = path.join(dataDir, 'logs')
    const files = (await fs.readdir(dir)).filter((name) => name.endsWith('.jsonl')).sort().slice(-3)
    const entries = []
    for (const file of files) {
      const text = await fs.readFile(path.join(dir, file), 'utf8')
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try { entries.push(JSON.parse(line)) } catch { /* skip */ }
      }
    }
    return entries.slice(-limit)
  } catch {
    return []
  }
}
