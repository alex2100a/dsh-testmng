import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SUPPORT_RANGE,
  TESTED_DSH,
  classifyDshVersion,
  compareVersions,
  detectDshVersion,
  inSupportRange,
  parseVersion,
  resetDshVersionCache,
} from '../../server/compat.js'

test('compat: parse and compare semver subset', () => {
  assert.equal(parseVersion('v0.2.2').raw, '0.2.2')
  assert.equal(parseVersion('0.2.2-rc.3').pre.join('.'), 'rc.3')
  assert.equal(parseVersion('0.2.2-rc.3+build').raw, '0.2.2-rc.3')
  assert.equal(parseVersion('nope'), undefined)
  assert.equal(compareVersions('0.2.1', '0.2.2-rc.1'), -1)
  assert.equal(compareVersions('0.2.2-rc.1', '0.2.2'), -1)
  assert.equal(compareVersions('0.2.2-rc.2', '0.2.2-rc.10'), -1)
  assert.equal(compareVersions('0.2.2-rc', '0.2.2-rc.1'), -1)
  assert.equal(compareVersions('0.2.2-rc.3+build', '0.2.2-rc.3'), 0)
})

test('compat: DSH includePrerelease range semantics', () => {
  assert.equal(SUPPORT_RANGE, '>=0.2.1 <0.3.0')
  assert.equal(inSupportRange('0.2.0'), false)
  assert.equal(inSupportRange('0.2.1-alpha.1'), false)
  assert.equal(inSupportRange('0.2.1-rc.1'), false)
  assert.equal(inSupportRange('0.2.1'), true)
  assert.equal(inSupportRange('0.2.2-rc.1'), true)
  assert.equal(inSupportRange('0.3.0-rc.1'), true)
  assert.equal(inSupportRange('0.3.0'), false)
})

test('compat: classify supported/untested/incompatible/unknown', () => {
  assert.equal(classifyDshVersion('0.2.2-rc.1').status, 'supported')
  assert.equal(classifyDshVersion('0.2.2-rc.3').status, 'supported')
  assert.equal(classifyDshVersion('0.2.1').status, 'untested')
  assert.equal(classifyDshVersion('0.2.2-rc.5').status, 'untested')
  assert.equal(classifyDshVersion('0.3.0-rc.1').status, 'untested')
  assert.equal(classifyDshVersion('0.2.1-rc.1').status, 'incompatible')
  assert.equal(classifyDshVersion('0.2.0').status, 'incompatible')
  assert.equal(classifyDshVersion('0.3.0').status, 'incompatible')
  assert.equal(classifyDshVersion(undefined).status, 'unknown')
  assert.equal(classifyDshVersion('garbage').status, 'unknown')
  assert.equal(TESTED_DSH.length, 2)
})

test('compat: detectDshVersion env/resolve/cache', () => {
  resetDshVersionCache()
  assert.equal(detectDshVersion({ env: { TMSYNC_DSH_VERSION: '0.2.2-rc.3' } }), '0.2.2-rc.3')

  resetDshVersionCache()
  const calls = []
  const version = detectDshVersion({
    env: {},
    resolve: (specifier) => {
      calls.push(specifier)
      return 'file:///C:/tmp/dsh/package.json'
    },
    readPackage: (file, expectedName) => {
      assert.match(String(file), /dsh[\\/]package\.json$/)
      assert.equal(expectedName, '@deepseek-ai/dsh-app-boot')
      return '0.2.2-rc.1'
    },
    argv1: '',
    cwd: '/tmp/no-such-cwd',
  })
  assert.equal(version, '0.2.2-rc.1')
  assert.equal(calls[0], '@deepseek-ai/dsh-app-boot/package.json')

  resetDshVersionCache()
  const unknown = detectDshVersion({
    env: {},
    resolve: () => { throw new Error('missing') },
    argv1: '',
    cwd: '/tmp/no-such-cwd',
  })
  assert.equal(unknown, undefined)
  resetDshVersionCache()
})
