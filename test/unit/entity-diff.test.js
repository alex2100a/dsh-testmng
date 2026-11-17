import test from 'node:test'
import assert from 'node:assert/strict'
import { diffEntities } from '../../server/service.js'

test('diffEntities: testcase 链接字段不进入通用 diff', () => {
  const diff = diffEntities(
    'testcase',
    { title: 'Same', requirementIds: ['11'], linksUnknown: false },
    { title: 'Same', requirementIds: ['12'], linksUnknown: false },
    { title: 'Same', requirementIds: [], linksUnknown: false },
  )
  assert.equal(diff.length, 0)
})

test('diffEntities: 内部字段不进入 diff', () => {
  const diff = diffEntities(
    'testcase',
    { title: 'A', sectionWarnings: ['duplicate'], legacy: true, needsFollowup: true },
    { title: 'A', sectionWarnings: [], legacy: false, needsFollowup: false },
    { title: 'A' },
  )
  assert.equal(diff.length, 0)
})

test('diffEntities: 普通字段仍能报告差异', () => {
  const diff = diffEntities('requirement', { title: 'A' }, { title: 'B' }, { title: 'A' })
  assert.equal(diff.length, 1)
  assert.equal(diff[0].field, 'title')
  assert.equal(diff[0].state, 'local')
})
