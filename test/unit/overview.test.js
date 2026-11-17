import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { initWorkspace } from '../../server/workspace.js'
import { createTmsyncService } from '../../server/service.js'
import { configPath, maskToken, writeConfig } from '../../server/config.js'
import { VERSION } from '../../server/version.js'

test('overview: masked config, counts and compatibility', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tmsync-overview-root-'))
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmsync-overview-data-'))
  let service = null
  try {
    await initWorkspace(root, { projectId: 'prj_test', projectName: 'Test' })
    await writeConfig(dataDir, {
      platform: { mcpUrl: 'http://127.0.0.1:9/mcp', token: 'mcp_1234567890abcdef' },
      projects: { prj_test: { name: 'Test', code: 'T', localRoot: root, platformKind: 'testcasegen', linkedAt: new Date().toISOString() } },
    })
    service = createTmsyncService({ dataDir, dshVersion: '0.2.2-rc.1' })
    const value = await service.overview()
    assert.equal(value.info.version, VERSION)
    assert.equal(value.info.compatibility.status, 'supported')
    assert.equal(value.config.platform.hasToken, true)
    assert.equal(value.config.platform.token, '****')
    assert.equal(value.counts.projects, 1)
    assert.equal(value.counts.workspaces, 1)
    assert.equal(value.configError, null)
    const serialized = JSON.stringify(value)
    assert.equal(serialized.includes('1234567890'), false)
    assert.equal(serialized.includes('mcp_'), false)
  } finally {
    try { service?.dispose() } catch { /* ignore */ }
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('overview: corrupt config reports configError without throwing', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmsync-overview-bad-'))
  let service = null
  try {
    await fs.writeFile(configPath(dataDir), '{ not json', 'utf8')
    service = createTmsyncService({ dataDir })
    const value = await service.overview()
    assert.equal(value.configError.code, 'config_corrupt')
    assert.equal(value.counts.projects, 0)
    assert.equal(value.info.ok, false)
  } finally {
    try { service?.dispose() } catch { /* ignore */ }
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('maskToken never exposes a prefix/suffix', () => {
  assert.equal(maskToken('mcp_1234567890abcdef'), '****')
  assert.equal(maskToken('short'), '****')
  assert.equal(maskToken(''), '')
})
