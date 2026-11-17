import test from 'node:test'
import assert from 'node:assert/strict'
import { installPatterns, publisherPaths, staleInstallPatterns, staleInstallVersions, versionFromSource } from '../../scripts/release-rules.js'

test('release rules: current version is never stale', () => {
  assert.deepEqual(staleInstallVersions('0.2.2'), ['0.2.0', '0.2.1'])
  assert.equal(staleInstallPatterns('0.2.2').includes('tmsync-0.2.2.tgz'), false)
  assert.deepEqual(staleInstallVersions('0.2.3'), ['0.2.0', '0.2.1', '0.2.2'])
  assert.equal(staleInstallPatterns('0.2.3').includes('tmsync-0.2.2.tgz'), true)
  assert.deepEqual(installPatterns('0.2.2'), ['tmsync-0.2.2.tgz', 'tmsync/v0.2.2/tmsync-0.2.2.tgz', 'tmsync@0.2.2'])
})

test('release rules: publisher paths env and version source', () => {
  assert.deepEqual(publisherPaths({ TMSYNC_PUBLISHER_PATHS: 'a,b' }), ['a', 'b'])
  assert.deepEqual(publisherPaths({}), ['dsh-testcat_v2'])
  assert.equal(versionFromSource("export const VERSION = '0.2.2'\n"), '0.2.2')
  assert.equal(versionFromSource('nothing'), undefined)
})
