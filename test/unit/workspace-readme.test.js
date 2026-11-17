import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ensureWorkspaceReadme, initWorkspace } from '../../server/workspace.js'

const LEGACY_README = `# tmsync 测试资产工作区

- 项目：Test（prj_test）
- 平台：testcasegen http://example.test
- 说明：本地是工作副本，平台是上游；先 status/拉取，再编辑；推送需要 plan + 确认。

## 自定义备注

保留我。
`

async function tempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'tmsync-readme-'))
}

test('initWorkspace 生成 README：只显示名称/编号，不显示平台内部 ID', async () => {
  const root = await tempRoot()
  await initWorkspace(root, {
    projectId: 'prj_test',
    projectName: '登录接口E2E走查-1011184201',
    projectCode: 'E2E_LOGIN_1011184201',
  })
  const text = await fs.readFile(path.join(root, 'README.md'), 'utf8')
  assert.match(text, /^<!-- tmsync:workspace-readme v3 -->/)
  assert.match(text, /^- 项目：登录接口E2E走查-1011184201$/m)
  assert.match(text, /^- 项目编号：E2E_LOGIN_1011184201$/m)
  assert.ok(!text.includes('prj_'), 'README 不应包含平台内部项目 ID')
  const workspace = JSON.parse(await fs.readFile(path.join(root, '.tmsync', 'workspace.json'), 'utf8'))
  assert.equal(workspace.projectCode, 'E2E_LOGIN_1011184201')
  await fs.rm(root, { recursive: true, force: true })
})

test('ensureWorkspaceReadme 迁移旧模板：去掉 ID、补编号、保留用户备注', async () => {
  const root = await tempRoot()
  await initWorkspace(root, { projectId: 'prj_test', projectName: 'Test' })
  await fs.writeFile(path.join(root, 'README.md'), LEGACY_README)

  const first = await ensureWorkspaceReadme(root, { projectId: 'prj_test', projectName: 'Test' }, { projectCode: 'TMSYNC_P0' })
  assert.deepEqual(first, { written: true, reason: 'legacy' })
  const text = await fs.readFile(path.join(root, 'README.md'), 'utf8')
  assert.ok(!text.includes('prj_'))
  assert.match(text, /^- 项目：Test$/m)
  assert.match(text, /^- 项目编号：TMSYNC_P0$/m)
  assert.match(text, /保留我。/)

  const second = await ensureWorkspaceReadme(root, { projectId: 'prj_test', projectName: 'Test' }, { projectCode: 'TMSYNC_P0' })
  assert.deepEqual(second, { written: false, reason: 'custom' })
  await fs.rm(root, { recursive: true, force: true })
})

test('ensureWorkspaceReadme 不覆盖用户自写 README', async () => {
  const root = await tempRoot()
  const custom = '# 我的工作区说明\n\n- 项目：自定义\n'
  await fs.writeFile(path.join(root, 'README.md'), custom)
  const result = await ensureWorkspaceReadme(root, { projectId: 'prj_test', projectName: 'Test' })
  assert.deepEqual(result, { written: false, reason: 'custom' })
  assert.equal(await fs.readFile(path.join(root, 'README.md'), 'utf8'), custom)
  await fs.rm(root, { recursive: true, force: true })
})

test('ensureWorkspaceReadme 在 README 缺失时生成', async () => {
  const root = await tempRoot()
  const result = await ensureWorkspaceReadme(root, {
    projectId: 'prj_test',
    projectName: 'Test',
    platformKind: 'testcasegen',
    platformUrl: 'http://example.test',
  })
  assert.deepEqual(result, { written: true, reason: 'missing' })
  const text = await fs.readFile(path.join(root, 'README.md'), 'utf8')
  assert.match(text, /^- 项目：Test$/m)
  assert.ok(!text.includes('prj_'))
  await fs.rm(root, { recursive: true, force: true })
})

test('ensureWorkspaceReadme 将 v2 生成模板迁移到 v3 并保留用户备注', async () => {
  const root = await tempRoot()
  const v2 = `<!-- tmsync:workspace-readme v2 -->
# tmsync 测试资产工作区

- 项目：Test
- 平台：testcasegen http://example.test

## 目录

- \`plans/\` 测试计划（v0.1 只读）
- \`defects/\` 测试缺陷（v0.1 只读）
- \`reports/\` 测试报告（只读）

## 编辑规则

3. 报告永远只读；计划/缺陷在 v0.1 只读。
4. 改完运行 \`tmsync_validate\` 与 \`tmsync_status\`。
5. 推送前必须生成 plan 并得到用户确认；不要自动推送。
6. 冲突要展示 base/local/remote，由用户决定，不要自行覆盖。
7. 平台暂不支持需求/用例/计划/缺陷的删除/归档；本地删除会被阻断。

## 自定义备注

保留我。
`
  try {
    await fs.writeFile(path.join(root, 'README.md'), v2, 'utf8')
    const result = await ensureWorkspaceReadme(root, { projectId: 'prj_test', projectName: 'Test' })
    assert.deepEqual(result, { written: true, reason: 'v2' })
    const text = await fs.readFile(path.join(root, 'README.md'), 'utf8')
    assert.match(text, /^<!-- tmsync:workspace-readme v3 -->/)
    assert.match(text, /- `plans\/` 测试计划\n/)
    assert.match(text, /- `defects\/` 测试缺陷\n/)
    assert.match(text, /计划\/缺陷可编辑/)
    assert.match(text, /保留我。/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
