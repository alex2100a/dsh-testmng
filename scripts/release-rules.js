/** 发布检查的纯规则，供 scripts/check-release.js 与单测共用。 */
import { compareVersions } from '../server/compat.js'

export const KNOWN_OLD_VERSIONS = ['0.2.0', '0.2.1', '0.2.2', '0.2.3']

export function staleInstallVersions(current) {
  return KNOWN_OLD_VERSIONS.filter((version) => {
    if (version === current) return false
    const compared = compareVersions(version, current)
    return typeof compared === 'number' && compared < 0
  })
}

export function installPatterns(version) {
  return [
    `tmsync-${version}.tgz`,
    `tmsync/v${version}/tmsync-${version}.tgz`,
    `tmsync@${version}`,
  ]
}

export function staleInstallPatterns(current) {
  return staleInstallVersions(current).flatMap(installPatterns)
}

export function publisherPaths(env = process.env) {
  const configured = String(env.TMSYNC_PUBLISHER_PATHS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  return configured.length > 0 ? configured : ['dsh-testcat_v2']
}

export function versionFromSource(text) {
  return /VERSION\s*=\s*['"]([^'"]+)['"]/.exec(String(text || ''))?.[1]
}
