import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalEntity, parseFile, renderFile, validateEntity, contentHash } from '../../server/codec.js'

test('requirement render/parse round-trip', () => {
  const entity = canonicalEntity('requirement', {
    id: '11',
    projectId: 'prj_test',
    catalogId: '14',
    code: 'REQ-0001',
    title: 'Login',
    description: '登录接口',
    acceptanceCriteria: '- 空用户名提示',
    priority: 'P1',
    status: 'draft',
  })
  const text = renderFile('requirement', entity)
  const parsed = parseFile('requirement', text, 'requirements/14-认证/11-login.md')
  assert.equal(parsed.title, 'Login')
  assert.equal(parsed.description, '登录接口')
  assert.equal(parsed.acceptanceCriteria, '- 空用户名提示')
  assert.equal(parsed.catalogId, '14')
  assert.equal(parsed.priority, 'P1')
  assert.equal(contentHash('requirement', parsed), contentHash('requirement', entity))
})

test('empty sections use em dash and parse back as empty', () => {
  const entity = canonicalEntity('requirement', { id: '12', projectId: 'prj_test', catalogId: '13', title: 'Empty', description: '', acceptanceCriteria: '' })
  const parsed = parseFile('requirement', renderFile('requirement', entity))
  assert.equal(parsed.description, '')
  assert.equal(parsed.acceptanceCriteria, '')
})

test('case steps table round-trip', () => {
  const entity = canonicalEntity('testcase', {
    id: '23', projectId: 'prj_test', catalogId: '13', code: 'TC-0001', title: 'Login',
    type: 'api', priority: 'P2', status: 'active', requirementIds: ['11'],
    steps: [{ no: 1, action: '调用登录', expected: '200' }],
    testData: { request: { method: 'POST' } },
  })
  const parsed = parseFile('testcase', renderFile('testcase', entity))
  assert.equal(parsed.title, 'Login')
  assert.equal(parsed.steps.length, 1)
  assert.equal(parsed.steps[0].action, '调用登录')
  assert.equal(parsed.steps[0].expected, '200')
  assert.deepEqual(parsed.requirementIds, ['11'])
  assert.deepEqual(parsed.testData, { request: { method: 'POST' } })
  assert.equal(contentHash('testcase', parsed), contentHash('testcase', entity))
})

test('validation catches missing catalog and bad enum', () => {
  const entity = canonicalEntity('requirement', { id: '13', projectId: 'prj_test', title: 'X', priority: '高', status: 'draft' })
  const result = validateEntity('requirement', entity, { editableKinds: ['requirement'] })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.field === 'catalogId'))
  assert.ok(result.errors.some((error) => error.field === 'priority'))
})

test('report read-only warning', () => {
  const entity = canonicalEntity('test-report', { id: '10', projectId: 'prj_test', name: 'RPT', status: 'exported' })
  const result = validateEntity('test-report', entity, { editableKinds: ['requirement'] })
  assert.equal(result.ok, true)
  assert.ok(result.warnings.some((warning) => warning.field === 'readOnly'))
})

test('正文中的 ## 行/连续空行/字面 \\## 可 round-trip', () => {
  const entity = canonicalEntity('requirement', {
    id: '21', projectId: 'prj_test', catalogId: '14', title: 'Fidelity',
    description: 'a\n\n\nb\n## 验收标准\nc\n\\## literal', acceptanceCriteria: 'ok',
  })
  const text = renderFile('requirement', entity)
  const parsed = parseFile('requirement', text)
  assert.equal(parsed.description, 'a\n\n\nb\n## 验收标准\nc\n\\## literal')
  assert.equal(parsed.sectionWarnings.length, 0)
  assert.equal(contentHash('requirement', parsed), contentHash('requirement', entity))
})

test('test-plan.description 也做章节转义', () => {
  const entity = canonicalEntity('test-plan', {
    id: '9', projectId: 'prj_test', name: 'Plan', description: 'x\n## 质量门禁\ny', caseRefs: [],
  })
  const parsed = parseFile('test-plan', renderFile('test-plan', entity))
  assert.equal(parsed.description, 'x\n## 质量门禁\ny')
  assert.equal(parsed.sectionWarnings.length, 0)
})

test('未知/重复章节产生 warnings 且 validate 报错', () => {
  const raw = `---\n${JSON.stringify({ tmsync: 1, kind: 'requirement', id: '22', projectId: 'prj_test', catalogId: '14', code: 'REQ-22' })}\n---\n# Title\n\n## 描述\n\nx\n\n## 备注\n\ny\n\n## 描述\n\nz\n`
  const parsed = parseFile('requirement', raw)
  assert.ok(parsed.sectionWarnings.some((warning) => warning.code === 'unknown-section'))
  assert.ok(parsed.sectionWarnings.some((warning) => warning.code === 'duplicate-section'))
  const result = validateEntity('requirement', parsed, { editableKinds: ['requirement'] })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.field === 'sections'))
})

test('标题换行被单行化', () => {
  const entity = canonicalEntity('requirement', { id: '23', projectId: 'prj_test', catalogId: '14', title: 'line1\nline2' })
  assert.equal(entity.title, 'line1 line2')
  const text = renderFile('requirement', entity)
  assert.ok(text.startsWith('---\n'))
  assert.match(text, /^# line1 line2$/m)
})
