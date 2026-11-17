import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { appendLog, readLogs } from '../../server/audit.js'

test('audit log append/read keeps only summary fields', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmsync-audit-'))
  await appendLog(dir, { op: 'pull', projectId: 'prj_test', written: 2, conflicts: 1 })
  await appendLog(dir, { op: 'push', projectId: 'prj_test', created: 1 })
  const logs = await readLogs(dir, 10)
  assert.equal(logs.length, 2)
  assert.equal(logs[0].op, 'pull')
  assert.equal(logs[0].written, 2)
  assert.equal(logs[1].op, 'push')
  await fs.rm(dir, { recursive: true, force: true })
})
