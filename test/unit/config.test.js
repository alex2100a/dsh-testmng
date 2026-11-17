import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { configPath, readConfig, readConfigFile, writeConfig } from '../../server/config.js'

async function tempData() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'tmsync-config-'))
}

test('writeConfig: 环境变量 PAT/MCP URL 不落盘', async () => {
  const dataDir = await tempData()
  const saved = {
    token: process.env.TMSYNC_MCP_TOKEN,
    mcpUrl: process.env.TMSYNC_MCP_URL,
    platformUrl: process.env.TMSYNC_PLATFORM_URL,
  }
  process.env.TMSYNC_MCP_TOKEN = 'env-secret-token'
  process.env.TMSYNC_MCP_URL = 'http://env.example/mcp'
  process.env.TMSYNC_PLATFORM_URL = 'http://env.example'
  try {
    await writeConfig(dataDir, {
      platform: { platformUrl: 'http://file.example' },
      projects: { prj_test: { name: 'Test', localRoot: 'C:\\tmp\\ws', platformKind: 'testcasegen' } },
    })
    const raw = JSON.parse(await fs.readFile(configPath(dataDir), 'utf8'))
    assert.equal(raw.platform.token, '')
    assert.notEqual(raw.platform.mcpUrl, 'http://env.example/mcp')
    assert.equal(raw.platform.platformUrl, 'http://file.example')
    assert.ok(raw.projects.prj_test)

    const runtime = await readConfig(dataDir)
    assert.equal(runtime.platform.token, 'env-secret-token')
    assert.equal(runtime.platform.mcpUrl, 'http://env.example/mcp')
    assert.equal(runtime.platform.platformUrl, 'http://env.example')
  } finally {
    if (saved.token === undefined) delete process.env.TMSYNC_MCP_TOKEN
    else process.env.TMSYNC_MCP_TOKEN = saved.token
    if (saved.mcpUrl === undefined) delete process.env.TMSYNC_MCP_URL
    else process.env.TMSYNC_MCP_URL = saved.mcpUrl
    if (saved.platformUrl === undefined) delete process.env.TMSYNC_PLATFORM_URL
    else process.env.TMSYNC_PLATFORM_URL = saved.platformUrl
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('config: 损坏文件读取/写入 fail-closed 且原文件不变', async () => {
  const dataDir = await tempData()
  try {
    const file = configPath(dataDir)
    const broken = '{"platform":'
    await fs.writeFile(file, broken, 'utf8')
    await assert.rejects(() => readConfig(dataDir), (error) => error.code === 'config_corrupt')
    await assert.rejects(() => readConfigFile(dataDir, { strict: true }), (error) => error.code === 'config_corrupt')
    await assert.rejects(
      () => writeConfig(dataDir, { platform: { platformUrl: 'http://new.example' } }),
      (error) => error.code === 'config_corrupt',
    )
    assert.equal(await fs.readFile(file, 'utf8'), broken)
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('writeConfig: 保存前生成 .bak', async () => {
  const dataDir = await tempData()
  try {
    await writeConfig(dataDir, { platform: { platformUrl: 'http://one.example' } })
    const first = await fs.readFile(configPath(dataDir), 'utf8')
    await writeConfig(dataDir, { platform: { platformUrl: 'http://two.example' } })
    const backup = await fs.readFile(`${configPath(dataDir)}.bak`, 'utf8')
    assert.equal(backup, first)
    const current = JSON.parse(await fs.readFile(configPath(dataDir), 'utf8'))
    assert.equal(current.platform.platformUrl, 'http://two.example')
    if (process.platform !== 'win32') {
      const stat = await fs.stat(`${configPath(dataDir)}.bak`)
      assert.equal(stat.mode & 0o777, 0o600)
    }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})
