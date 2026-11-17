import test from 'node:test'
import assert from 'node:assert/strict'
import { renderStatusText } from '../../lib/tools.js'

test('tmsync_status 文本：显示项目名称，不显示平台内部 ID', () => {
  const text = renderStatusText({
    projectId: 'prj_test',
    projectName: '登录接口E2E走查-1011184201',
    root: 'D:/ws',
    summary: { same: 2, 'local-modified': 1 },
    remoteCheckedAt: '2026-11-17T00:00:00.000Z',
  }, [])
  assert.equal(text.split('\n')[0], '项目 登录接口E2E走查-1011184201')
  assert.ok(!text.includes('prj_'))
})

test('tmsync_status 文本：项目名为空时使用中性文案', () => {
  const text = renderStatusText({
    projectId: 'prj_test',
    projectName: '',
    root: 'D:/ws',
    summary: {},
    remoteCheckedAt: '',
  }, [])
  assert.equal(text.split('\n')[0], '项目 当前项目')
  assert.ok(!text.includes('prj_'))
})
