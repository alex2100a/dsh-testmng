/**
 * P2 推送：plan（只读）与 apply（写平台）。v0.1 只开放需求/用例；
 * 计划/缺陷/报告保持只读。无删除/归档。
 */
import {
  contentHash,
  KIND_META,
  renderFile,
  relativePathFor,
} from './codec.js'
import {
  catalogPathMap,
  catalogPathOf,
  computeStatus,
  readBaseline,
  readState,
  readWorkspace,
  scanLocal,
  writeBaseline,
  writeState,
} from './workspace.js'
import { safeJoin, sha256, stableStringify, writeAtomic } from './files.js'
import { buildLinkCache, cacheUsable, diffLinks, normalizeIds, patchLinkCache, readLinkCache, sameIds } from './links.js'
import { detectLegacy, patchLegacyCache } from './legacy.js'

function fieldsOf(kind) {
  return {
    requirement: ['title', 'description', 'acceptanceCriteria', 'priority', 'catalogId'],
    testcase: ['title', 'precondition', 'steps', 'type', 'priority', 'catalogId', 'testData', 'executableSpec'],
    'test-plan': ['name', 'description', 'executorType', 'planKind', 'environment', 'qualityGate', 'entryCriteria', 'exitCriteria'],
    defect: ['title', 'description', 'severity', 'priority', 'caseId', 'planId', 'requirementId'],
  }[kind] ?? []
}

function changed(base, local, fields) {
  const patch = {}
  for (const field of fields) {
    if (stableStringify(base?.[field] ?? null) !== stableStringify(local?.[field] ?? null)) patch[field] = local?.[field] ?? null
  }
  return patch
}

function sameVersion(remote, base) {
  const rv = remote?.version === null || remote?.version === undefined ? null : String(remote.version)
  const bv = base?.baseVersion === null || base?.baseVersion === undefined
    ? (base?.version === null || base?.version === undefined ? null : String(base.version))
    : String(base.baseVersion)
  if (rv !== null && bv !== null) return rv === bv
  const baseRevision = base?.baseRevision ?? base?.remote?.updatedAt ?? base?.updatedAt
  return String(remote?.updatedAt ?? '') === String(baseRevision ?? '')
}

function planIdFor(projectId, operations) {
  return `plan-${sha256(`${projectId}:${stableStringify(operations)}:${Date.now()}`).slice(0, 16)}`
}

function localFromScan(localScan, entry) {
  return localScan[entry.kind]?.byId.get(String(entry.id ?? entry.localId)) ?? null
}

export async function planPush({
  root,
  adapter,
  projectId,
  editableKinds = [],
  scope = {},
  concurrency = 2,
  linkSync = true,
  linkCacheTtlMs = 300_000,
}) {
  const workspace = await readWorkspace(root)
  if (!workspace) throw new Error('不是 tmsync 工作区')
  const localScan = await scanLocal(root)
  const status = await computeStatus({ root, adapter, projectId, editableKinds, concurrency, localScan })
  const kindFilter = scope.kind ? new Set([scope.kind]) : null
  const idFilter = Array.isArray(scope.ids) && scope.ids.length ? new Set(scope.ids.map(String)) : null
  const operations = []
  const blocked = []
  const conflicts = []
  const warnings = []
  const suppressedUnlinks = []
  const testcaseState = linkSync ? await readState(root, 'testcase') : { entities: {} }
  const planState = await readState(root, 'test-plan')
  const remoteCaseIds = new Set(status.entries.filter((entry) => entry.kind === 'testcase' && entry.existsRemote).map((entry) => String(entry.id)))
  const remotePlanIds = new Set(status.entries.filter((entry) => entry.kind === 'test-plan' && entry.existsRemote).map((entry) => String(entry.id)))
  const remoteRequirementIds = new Set(status.entries.filter((entry) => entry.kind === 'requirement' && entry.existsRemote).map((entry) => String(entry.id)))
  let linkCache = null
  let linkCacheTried = false

  async function ensureLinkCache({ force = false } = {}) {
    if (!linkSync) return null
    if (linkCacheTried && !force) return linkCache
    linkCacheTried = true
    if (force) {
      try {
        linkCache = await buildLinkCache({ root, adapter, projectId, concurrency })
      } catch {
        linkCache = null
      }
      return linkCache
    }
    linkCache = await readLinkCache(root, { projectId, maxAgeMs: linkCacheTtlMs })
    if (!cacheUsable(linkCache, { projectId, maxAgeMs: linkCacheTtlMs })) {
      try {
        linkCache = await buildLinkCache({ root, adapter, projectId, concurrency })
      } catch {
        linkCache = null
      }
    }
    return linkCache
  }

  function linkTargetsValid(cache, ids) {
    if (!cache || cache.complete !== true) return false
    return normalizeIds(ids).every((id) => Object.prototype.hasOwnProperty.call(cache.byRequirement, String(id)))
  }

  for (const entry of status.entries) {
    if (kindFilter && !kindFilter.has(entry.kind)) continue
    if (idFilter && !idFilter.has(String(entry.id ?? entry.localId))) continue
    if (!['local-added', 'local-modified', 'local-deleted', 'readonly-modified', 'conflict', 'invalid'].includes(entry.status)) continue
    if (!KIND_META[entry.kind]?.editable || !editableKinds.includes(entry.kind)) {
      blocked.push({ kind: entry.kind, id: entry.id, path: entry.path, reason: entry.status === 'readonly-modified' ? 'readonly' : 'kind-not-editable' })
      continue
    }
    if (entry.status === 'local-deleted') {
      blocked.push({ kind: entry.kind, id: entry.id, path: entry.path, reason: 'delete-unsupported' })
      continue
    }
    if (entry.status === 'invalid') {
      blocked.push({ kind: entry.kind, id: entry.id, path: entry.path, reason: 'invalid-file' })
      continue
    }
    if (entry.status === 'conflict') {
      conflicts.push({ kind: entry.kind, id: entry.id, path: entry.path, reason: 'local-and-remote-changed' })
      continue
    }
    const local = localFromScan(localScan, entry)
    if (!local) {
      blocked.push({ kind: entry.kind, id: entry.id, path: entry.path, reason: 'local-file-missing' })
      continue
    }
    if ((local.sectionWarnings?.length || 0) > 0) {
      blocked.push({ kind: entry.kind, id: local.id ?? local.localId, path: entry.path, reason: 'markdown-section-invalid', sections: local.sectionWarnings })
      continue
    }
    if (entry.status === 'local-added') {
      if ((entry.kind === 'requirement' || entry.kind === 'testcase') && !local.catalogId) {
        blocked.push({ kind: entry.kind, id: local.localId, path: entry.path, reason: 'catalog-required' })
        continue
      }
      const localIds = entry.kind === 'testcase' ? normalizeIds(local.requirementIds) : []
      const planRefs = entry.kind === 'test-plan' ? (Array.isArray(local.caseRefs) ? local.caseRefs : []) : []
      if (planRefs.length) {
        const missing = planRefs.map((ref) => String(ref.caseId)).filter((caseId) => !remoteCaseIds.has(caseId))
        if (missing.length) {
          blocked.push({ kind: entry.kind, id: local.localId, path: entry.path, reason: 'case-not-pushed', cases: missing })
          continue
        }
      }
      if (entry.kind === 'defect') {
        const checks = [
          ['caseId', remoteCaseIds],
          ['planId', remotePlanIds],
          ['requirementId', remoteRequirementIds],
        ]
        const missing = []
        for (const [field, known] of checks) {
          const value = local[field]
          if (value !== null && value !== undefined && value !== '' && !known.has(String(value))) missing.push({ field, id: String(value) })
        }
        if (missing.length) {
          blocked.push({ kind: entry.kind, id: local.localId, path: entry.path, reason: 'association-not-pushed', associations: missing })
          continue
        }
        if (['rejected', 'reopened'].includes(local.status) && !local.statusComment) {
          blocked.push({ kind: entry.kind, id: local.localId, path: entry.path, reason: 'status-comment-required', status: local.status })
          continue
        }
      }
      if (localIds.length) {
        const cache = await ensureLinkCache({ force: true })
        if (!cache || cache.complete !== true) {
          blocked.push({ kind: entry.kind, id: local.localId, path: entry.path, reason: 'links-cache-incomplete' })
          continue
        }
        if (!linkTargetsValid(cache, localIds)) {
          blocked.push({ kind: entry.kind, id: local.localId, path: entry.path, reason: 'link-target-missing' })
          continue
        }
      }
      operations.push({
        action: 'create',
        kind: entry.kind,
        localId: local.localId,
        path: entry.path,
        catalogId: local.catalogId === null || local.catalogId === undefined ? null : String(local.catalogId),
        title: local.title || local.name,
        localStatus: (entry.kind === 'requirement' || entry.kind === 'testcase') ? (local.status || null) : null,
        fields: Object.fromEntries(fieldsOf(entry.kind).map((field) => [field, local[field] ?? null])),
        localHash: local.localHash || null,
      })
      if (entry.kind === 'testcase') {
        for (const requirementId of localIds) {
          operations.push({ action: 'link', kind: 'testcase', id: local.localId, caseId: local.localId, requirementId })
        }
        operations.push({
          action: 'link-baseline',
          kind: 'testcase',
          id: local.localId,
          path: entry.path,
          requirementIds: localIds,
          armed: true,
        })
      }
      if (entry.kind === 'test-plan' && planRefs.length) {
        operations.push({
          action: 'plan-case-add',
          kind: 'test-plan',
          id: local.localId,
          path: entry.path,
          caseIds: planRefs.map((ref) => String(ref.caseId)),
          localHash: local.localHash || null,
        })
        for (const ref of planRefs) {
          const dependsOn = normalizeIds(ref.dependsOn)
          if (!dependsOn.length) continue
          operations.push({
            action: 'plan-case-deps',
            kind: 'test-plan',
            id: local.localId,
            path: entry.path,
            caseId: String(ref.caseId),
            dependsOn,
            localHash: local.localHash || null,
          })
        }
      }
      continue
    }
    if (entry.status === 'local-modified') {
      const base = await readBaseline(root, entry.kind, entry.id)
      if (!base) {
        conflicts.push({ kind: entry.kind, id: entry.id, path: entry.path, reason: 'missing-baseline' })
        continue
      }
      const legacy = detectLegacy(entry.kind, base, local)
      if (legacy.legacy) {
        blocked.push({ kind: entry.kind, id: entry.id, path: entry.path, reason: legacy.reason || 'legacy-format-diff' })
        continue
      }
      if (entry.remoteState === 'modified' || entry.remoteState === 'deleted') {
        conflicts.push({ kind: entry.kind, id: entry.id, path: entry.path, reason: `remote-${entry.remoteState}` })
        continue
      }
      const linkOps = []
      const planCaseOps = []
      let baselineOp = null
      let planCaseBlocked = false
      if (entry.kind === 'testcase') {
        const stateEntry = testcaseState.entities[String(entry.id)] || {}
        const localIds = normalizeIds(local.requirementIds)
        const baseIds = stateEntry.baseRequirementIds === undefined ? null : stateEntry.baseRequirementIds
        const armed = stateEntry.linksArmed === true
        const linkChanged = baseIds === null ? localIds.length > 0 : !sameIds(localIds, baseIds)
        if (linkChanged) {
          const cache = await ensureLinkCache({ force: true })
          if (!cache || cache.complete !== true) {
            blocked.push({ kind: entry.kind, id: entry.id, path: entry.path, reason: 'links-cache-incomplete' })
            continue
          }
          if (!linkTargetsValid(cache, localIds)) {
            blocked.push({ kind: entry.kind, id: entry.id, path: entry.path, reason: 'link-target-missing' })
            continue
          }
          const remoteIds = normalizeIds(cache.byCase[String(entry.id)] ?? [])
          const diff = diffLinks({ localIds, baseIds, remoteIds, armed })
          if (diff.conflict) {
            conflicts.push({ kind: entry.kind, id: entry.id, path: entry.path, reason: 'links-changed-remotely' })
            continue
          }
          for (const requirementId of diff.links) {
            linkOps.push({ action: 'link', kind: 'testcase', id: String(entry.id), caseId: String(entry.id), requirementId })
          }
          for (const requirementId of diff.unlinks) {
            linkOps.push({ action: 'unlink', kind: 'testcase', id: String(entry.id), caseId: String(entry.id), requirementId })
          }
          for (const item of diff.suppressed) {
            suppressedUnlinks.push({ caseId: String(entry.id), ...item })
          }
          baselineOp = { action: 'link-baseline', kind: 'testcase', id: String(entry.id), path: entry.path, requirementIds: diff.baselineAfter, armed: diff.armedAfter }
        } else if (linkSync && baseIds !== null) {
          baselineOp = { action: 'link-baseline', kind: 'testcase', id: String(entry.id), path: entry.path, requirementIds: baseIds, armed }
        }
      }
      if (entry.kind === 'test-plan') {
        const localRefs = Array.isArray(local.caseRefs) ? local.caseRefs : []
        const stateEntry = planState.entities[String(entry.id)] || {}
        let basePlanCases = stateEntry.planCases
        if (basePlanCases === null || basePlanCases === undefined || stateEntry.planCasesComplete === false) {
          const remotePlan = await adapter.getEntity(projectId, 'test-plan', entry.id)
          if (remotePlan.planCasesComplete === false) {
            blocked.push({ kind: entry.kind, id: entry.id, path: entry.path, reason: 'plan-cases-incomplete' })
            continue
          }
          const remoteCases = Array.isArray(remotePlan.planCases) ? remotePlan.planCases : []
          const localIds = new Set(localRefs.map((ref) => String(ref.caseId)))
          const missing = remoteCases.map((item) => String(item.caseId)).filter((caseId) => !localIds.has(caseId))
          if (missing.length) {
            blocked.push({ kind: entry.kind, id: entry.id, path: entry.path, reason: 'plan-cases-baseline-missing', cases: missing })
            planCaseBlocked = true
          } else {
            basePlanCases = remoteCases
          }
        }
        if (!planCaseBlocked) {
          const baseMap = new Map((basePlanCases || []).map((item) => [String(item.caseId), item]))
          const localMap = new Map(localRefs.map((ref) => [String(ref.caseId), ref]))
          const additions = [...localMap.keys()].filter((caseId) => !baseMap.has(caseId))
          const removals = [...baseMap.keys()].filter((caseId) => !localMap.has(caseId))
          const missingRemote = additions.filter((caseId) => !remoteCaseIds.has(caseId))
          if (missingRemote.length) {
            blocked.push({ kind: entry.kind, id: entry.id, path: entry.path, reason: 'case-not-pushed', cases: missingRemote })
            continue
          }
          for (const removeId of removals) {
            const dependents = [...localMap.values()].filter((ref) => normalizeIds(ref.dependsOn).includes(removeId))
            if (dependents.length) {
              blocked.push({ kind: entry.kind, id: entry.id, path: entry.path, reason: 'remove-would-break-dependency', cases: [removeId] })
              planCaseBlocked = true
            }
          }
          if (!planCaseBlocked) {
            if (additions.length) {
              planCaseOps.push({ action: 'plan-case-add', kind: 'test-plan', id: String(entry.id), path: entry.path, caseIds: additions, localHash: local.localHash || null })
              for (const caseId of additions) {
                const ref = localMap.get(caseId)
                const deps = normalizeIds(ref?.dependsOn)
                if (deps.length) {
                  planCaseOps.push({ action: 'plan-case-deps', kind: 'test-plan', id: String(entry.id), path: entry.path, caseId, dependsOn: deps, localHash: local.localHash || null })
                }
              }
            }
            for (const [caseId, ref] of localMap) {
              const baseRef = baseMap.get(caseId)
              if (!baseRef) continue
              const localDeps = normalizeIds(ref.dependsOn)
              const baseDeps = normalizeIds(baseRef.dependsOn)
              if (!sameIds(localDeps, baseDeps)) {
                planCaseOps.push({ action: 'plan-case-deps', kind: 'test-plan', id: String(entry.id), path: entry.path, caseId, dependsOn: localDeps, localHash: local.localHash || null })
              }
            }
            for (const removeId of removals) {
              const baseRef = baseMap.get(removeId)
              planCaseOps.push({ action: 'plan-case-remove', kind: 'test-plan', id: String(entry.id), path: entry.path, planCaseId: baseRef.planCaseId, caseId: removeId, localHash: local.localHash || null })
            }
          }
        }
      }
      if (entry.kind === 'defect') {
        const cleared = ['caseId', 'planId', 'requirementId'].filter((field) => base[field] !== null && base[field] !== undefined && (local[field] === null || local[field] === undefined))
        if (cleared.length) {
          blocked.push({ kind: entry.kind, id: entry.id, path: entry.path, reason: 'association-clear-unsupported', fields: cleared })
          continue
        }
        if (base.assigneeId !== local.assigneeId) {
          warnings.push({ kind: entry.kind, id: entry.id, path: entry.path, reason: 'assignee-readonly' })
        }
      }
      const patch = changed(base, local, fieldsOf(entry.kind))
      const statusChange = String(base.status ?? '') !== String(local.status ?? '') ? String(local.status ?? '') : null
      if (entry.kind === 'defect' && statusChange && ['rejected', 'reopened'].includes(statusChange) && !local.statusComment) {
        blocked.push({ kind: entry.kind, id: entry.id, path: entry.path, reason: 'status-comment-required', status: statusChange })
        continue
      }
      if (Object.keys(patch).length === 0 && !statusChange && linkOps.length === 0 && planCaseOps.length === 0 && !baselineOp) continue
      if (Object.keys(patch).length > 0 || statusChange) {
        operations.push({
          action: 'update',
          kind: entry.kind,
          id: String(entry.id),
          path: entry.path,
          catalogId: local.catalogId === null || local.catalogId === undefined ? null : String(local.catalogId),
          title: local.title || local.name,
          patch,
          statusChange,
          statusComment: entry.kind === 'defect' ? (local.statusComment || null) : undefined,
          baseVersion: base.baseVersion ?? base.version ?? null,
          baseRevision: base.baseRevision ?? base.remote?.updatedAt ?? base.updatedAt ?? '',
          baseHash: base.baseHash ?? contentHash(entry.kind, base),
          localHash: local.localHash || null,
        })
      }
      operations.push(...linkOps)
      operations.push(...planCaseOps)
      if (baselineOp) operations.push(baselineOp)
    }
  }

  const hash = sha256(stableStringify(operations.map((op) => ({ ...op, title: undefined }))))
  return {
    planId: planIdFor(projectId, operations),
    projectId: String(projectId),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    hash,
    operations,
    blocked,
    conflicts,
    warnings,
    suppressedUnlinks,
    summary: {
      create: operations.filter((op) => op.action === 'create').length,
      update: operations.filter((op) => op.action === 'update').length,
      link: operations.filter((op) => op.action === 'link').length,
      unlink: operations.filter((op) => op.action === 'unlink').length,
      linkBaseline: operations.filter((op) => op.action === 'link-baseline').length,
      planCaseAdd: operations.filter((op) => op.action === 'plan-case-add').length,
      planCaseDeps: operations.filter((op) => op.action === 'plan-case-deps').length,
      planCaseRemove: operations.filter((op) => op.action === 'plan-case-remove').length,
      suppressed: suppressedUnlinks.length,
      warning: warnings.length,
      blocked: blocked.length,
      conflict: conflicts.length,
    },
  }
}

function stateKey(remote) {
  return String(remote.id)
}

export async function applyPush({ root, adapter, projectId, plan, editableKinds = [], onEvent = () => {} }) {
  if (!plan || !Array.isArray(plan.operations)) throw new Error('无效推送计划')
  if (plan.expiresAt && Date.parse(plan.expiresAt) < Date.now()) throw new Error('推送计划已过期，请重新生成')
  const states = {}
  for (const kind of Object.keys(KIND_META)) states[kind] = await readState(root, kind)
  const localScan = await scanLocal(root)
  const catalogs = { requirement: [], testcase: [] }
  for (const kind of ['requirement', 'testcase']) {
    try { catalogs[kind] = await adapter.listCatalogs(projectId, kind) } catch { catalogs[kind] = [] }
  }
  const catalogMaps = { requirement: catalogPathMap(catalogs.requirement), testcase: catalogPathMap(catalogs.testcase) }
  const createdMap = new Map()
  const linkFailures = new Set()
  const linkChanges = []
  const dirtyPlans = new Set()
  const planFailures = new Set()
  const failedEntities = new Set()
  const applyConflicts = []
  const result = { applied: true, created: [], updated: [], blocked: [...(plan.blocked || [])], conflicts: [...(plan.conflicts || [])], errors: [], skipped: [] }

  function entityKey(op) {
    return `${op.kind}:${op.localId ?? op.id ?? op.caseId ?? op.planId ?? ''}`
  }

  function markEntityFailure(op) {
    failedEntities.add(entityKey(op))
  }

  function entityFailed(op) {
    return failedEntities.has(entityKey(op))
  }

  function recordApplyConflict(item) {
    applyConflicts.push(item)
    result.conflicts.push(item)
  }

  function planIdOf(op) {
    const raw = op.id ?? op.localId
    return createdMap.get(String(raw)) || String(raw ?? '')
  }

  function markPlanFailure(op) {
    if (op.kind === 'test-plan') planFailures.add(planIdOf(op))
  }

  function planFailed(op) {
    return op.kind === 'test-plan' && planFailures.has(planIdOf(op))
  }

  function displayFor(op, local, remote, fallbackStatus) {
    let display = remote
    if (op.kind === 'testcase') {
      display = { ...display, requirementIds: normalizeIds(local?.requirementIds), linksUnknown: false }
    } else if (op.kind === 'test-plan') {
      display = { ...display, caseRefs: Array.isArray(local?.caseRefs) ? local.caseRefs : [] }
    } else if (op.kind === 'defect') {
      display = { ...display, statusComment: '' }
    }
    if (fallbackStatus) display = { ...display, status: fallbackStatus }
    return display
  }

  async function refreshPlan(planId) {
    const remote = await adapter.getEntity(projectId, 'test-plan', planId)
    const entry = states['test-plan'].entities[String(planId)] || { id: String(planId) }
    const relative = entry.path || relativePathFor('test-plan', remote, { catalogPath: '' })
    await writeAtomic(safeJoin(root, relative), renderFile('test-plan', remote))
    entry.id = String(planId)
    entry.path = relative
    entry.planCases = remote.planCasesComplete === false ? null : remote.planCases
    entry.planCasesComplete = remote.planCasesComplete !== false
    entry.baseHash = contentHash('test-plan', remote)
    entry.baseRevision = remote.remote?.updatedAt || remote.updatedAt || ''
    entry.baseVersion = null
    entry.basePulledAt = new Date().toISOString()
    entry.lastPushAt = new Date().toISOString()
    states['test-plan'].entities[String(planId)] = entry
    await writeBaseline(root, 'test-plan', String(planId), remote)
  }
  let done = 0
  for (const op of plan.operations) {
    done += 1
    onEvent({ phase: 'push', kind: op.kind, id: op.id || op.localId, done, total: plan.operations.length })
    if (entityFailed(op)) {
      result.skipped.push({ kind: op.kind, id: op.id || op.localId, action: op.action, reason: 'entity-already-failed' })
      continue
    }
    try {
      if (op.action === 'create') {
        const local = localScan[op.kind]?.byId.get(String(op.localId)) ?? null
        if (!local) throw new Error('本地文件不存在')
        if (op.localHash && local.localHash !== op.localHash) {
          recordApplyConflict({ kind: op.kind, id: op.localId, path: op.path, reason: 'local-changed-before-push' })
          markEntityFailure(op)
          markPlanFailure(op)
          continue
        }
        let remote
        try {
          remote = await adapter.createEntity(projectId, op.kind, local)
        } catch (error) {
          if (error?.code !== 'create_partial' || !error.createdId) throw error
          const key = String(error.createdId)
          createdMap.set(String(op.localId), key)
          const base = error.created || {}
          const catalogPath = (op.kind === 'requirement' || op.kind === 'testcase')
            ? catalogPathOf(catalogMaps[op.kind], base.catalogId ?? local.catalogId)
            : '_uncategorized'
          const display = {
            ...local,
            ...displayFor(op, local, base, local.status),
            id: key,
            localId: null,
            projectId: String(projectId),
            file: undefined,
            localHash: undefined,
            catalogId: base.catalogId ?? local.catalogId,
          }
          const relative = relativePathFor(op.kind, display, { catalogPath })
          await writeAtomic(safeJoin(root, relative), renderFile(op.kind, display))
          if (op.path && op.path !== relative) await import('node:fs/promises').then((fs) => fs.unlink(safeJoin(root, op.path)).catch(() => {}))
          states[op.kind].entities[key] = {
            id: key,
            localId: null,
            path: relative,
            catalogId: base.catalogId === null || base.catalogId === undefined ? null : String(base.catalogId),
            baseHash: contentHash(op.kind, base),
            baseRevision: base.remote?.updatedAt || base.updatedAt || '',
            baseVersion: base.version === null || base.version === undefined ? null : String(base.version),
            basePulledAt: new Date().toISOString(),
            lastPushAt: new Date().toISOString(),
            remoteDeleted: false,
            localOnly: false,
            needsFollowup: true,
            ...(op.kind === 'testcase' ? { baseRequirementIds: null, linksArmed: false, linksUnknown: true } : {}),
            ...(op.kind === 'test-plan'
              ? { planCases: base.planCasesComplete === false ? null : (base.planCases || []), planCasesComplete: base.planCasesComplete !== false }
              : {}),
            ...(op.kind === 'defect' ? { assigneeId: base.assigneeId, assigneeName: base.assigneeName } : {}),
          }
          await writeBaseline(root, op.kind, key, base)
          result.created.push({ kind: op.kind, localId: op.localId, id: key, path: relative })
          result.errors.push({ kind: op.kind, id: key, action: 'create', message: error.message })
          if (op.kind === 'test-plan') markPlanFailure(op)
          continue
        }
        const key = stateKey(remote)
        createdMap.set(String(op.localId), key)
        let base = remote
        let statusError = null
        if ((op.kind === 'requirement' || op.kind === 'testcase')
          && op.localStatus && String(remote.status ?? '') !== String(op.localStatus)) {
          try {
            remote = await adapter.updateStatus(projectId, op.kind, key, op.localStatus)
            base = remote
          } catch (error) {
            statusError = error
          }
        }
        const display = displayFor(op, local, remote, statusError ? (local.status || remote.status) : null)
        const catalogPath = op.kind === 'requirement' || op.kind === 'testcase'
          ? catalogPathOf(catalogMaps[op.kind], display.catalogId)
          : '_uncategorized'
        const relative = relativePathFor(op.kind, display, { catalogPath })
        const file = safeJoin(root, relative)
        await writeAtomic(file, renderFile(op.kind, display))
        if (op.path && op.path !== relative) await import('node:fs/promises').then((fs) => fs.unlink(safeJoin(root, op.path)).catch(() => {}))
        states[op.kind].entities[key] = {
          id: key,
          localId: null,
          path: relative,
          catalogId: base.catalogId === null || base.catalogId === undefined ? null : String(base.catalogId),
          baseHash: contentHash(op.kind, base),
          baseRevision: base.remote?.updatedAt || base.updatedAt || '',
          baseVersion: base.version === null || base.version === undefined ? null : String(base.version),
          basePulledAt: new Date().toISOString(),
          lastPushAt: new Date().toISOString(),
          remoteDeleted: false,
          localOnly: false,
          ...(statusError ? { needsFollowup: true } : {}),
          ...(op.kind === 'testcase' ? { baseRequirementIds: null, linksArmed: false, linksUnknown: true } : {}),
          ...(op.kind === 'test-plan'
            ? { planCases: base.planCasesComplete === false ? null : (base.planCases || []), planCasesComplete: base.planCasesComplete !== false }
            : {}),
          ...(op.kind === 'defect' ? { assigneeId: base.assigneeId, assigneeName: base.assigneeName } : {}),
        }
        await writeBaseline(root, op.kind, key, base)
        result.created.push({ kind: op.kind, localId: op.localId, id: key, path: relative })
        if (statusError) {
          result.errors.push({ kind: op.kind, id: key, action: 'create-status', message: statusError.message })
          states[op.kind].entities[key].needsFollowup = true
        }
        continue
      }
      if (op.action === 'update') {
        if (planFailed(op)) {
          result.skipped.push({ kind: op.kind, id: op.id, action: op.action, reason: 'plan-already-failed' })
          continue
        }
        const local = localScan[op.kind]?.byId.get(String(op.id)) ?? null
        if (op.localHash && local && local.localHash !== op.localHash) {
          recordApplyConflict({ kind: op.kind, id: op.id, path: op.path, reason: 'local-changed-before-push' })
          markEntityFailure(op)
          markPlanFailure(op)
          continue
        }
        const current = await adapter.getEntity(projectId, op.kind, op.id)
        const base = await readBaseline(root, op.kind, op.id)
        if (base && !sameVersion(current, base)) {
          recordApplyConflict({ kind: op.kind, id: op.id, path: op.path, reason: 'remote-changed-before-push' })
          markEntityFailure(op)
          markPlanFailure(op)
          continue
        }
        let remote = current
        if (op.kind === 'defect') {
          if (op.patch && Object.keys(op.patch).length) remote = await adapter.updateEntity(projectId, op.kind, op.id, op.patch)
          if (op.statusChange) {
            remote = await adapter.updateStatus(projectId, op.kind, op.id, op.statusChange, op.statusComment ? { comment: op.statusComment } : {})
          }
        } else {
          if (op.statusChange) remote = await adapter.updateStatus(projectId, op.kind, op.id, op.statusChange)
          if (op.patch && Object.keys(op.patch).length) remote = await adapter.updateEntity(projectId, op.kind, op.id, op.patch)
        }
        const display = displayFor(op, local, remote, null)
        const catalogPath = catalogPathOf(catalogMaps[op.kind] ?? new Map(), display.catalogId)
        const sameCatalog = op.catalogId === null || op.catalogId === undefined
          ? display.catalogId === null || display.catalogId === undefined
          : String(op.catalogId) === String(display.catalogId)
        const relative = op.path && sameCatalog ? op.path : relativePathFor(op.kind, display, { catalogPath })
        await writeAtomic(safeJoin(root, relative), renderFile(op.kind, display))
        if (op.path && op.path !== relative) await import('node:fs/promises').then((fs) => fs.unlink(safeJoin(root, op.path)).catch(() => {}))
        const key = String(op.id)
        states[op.kind].entities[key] = {
          ...(states[op.kind].entities[key] || {}),
          id: key,
          path: relative,
          catalogId: remote.catalogId === null ? null : String(remote.catalogId),
          baseHash: contentHash(op.kind, remote),
          baseRevision: remote.remote?.updatedAt || remote.updatedAt || '',
          baseVersion: remote.version === null || remote.version === undefined ? null : String(remote.version),
          basePulledAt: new Date().toISOString(),
          lastPushAt: new Date().toISOString(),
          needsFollowup: false,
          ...(op.kind === 'test-plan'
            ? { planCases: remote.planCasesComplete === false ? null : remote.planCases, planCasesComplete: remote.planCasesComplete !== false }
            : {}),
          ...(op.kind === 'defect' ? { assigneeId: remote.assigneeId, assigneeName: remote.assigneeName } : {}),
        }
        await writeBaseline(root, op.kind, key, remote)
        result.updated.push({ kind: op.kind, id: key, path: relative })
        continue
      }
      if (op.action === 'link' || op.action === 'unlink') {
        const caseKey = createdMap.get(String(op.caseId)) || String(op.caseId)
        try {
          if (op.action === 'link') await adapter.linkCases(projectId, op.requirementId, [caseKey])
          else await adapter.unlinkCase(projectId, op.requirementId, caseKey)
          linkChanges.push({ action: op.action, requirementId: op.requirementId, caseId: caseKey })
        } catch (error) {
          linkFailures.add(caseKey)
          const entry = states.testcase.entities[caseKey] || { id: caseKey }
          entry.linksArmed = false
          entry.linksUnknown = true
          states.testcase.entities[caseKey] = entry
          recordApplyConflict({ kind: 'testcase', id: caseKey, path: op.path, reason: 'link-apply-failed' })
          markEntityFailure(op)
          throw error
        }
        continue
      }
      if (op.action === 'link-baseline') {
        const key = createdMap.get(String(op.id)) || String(op.id)
        if (linkFailures.has(key)) {
          recordApplyConflict({ kind: 'testcase', id: key, path: op.path, reason: 'link-apply-failed' })
          const entry = states.testcase.entities[key] || { id: key }
          entry.linksArmed = false
          entry.linksUnknown = true
          states.testcase.entities[key] = entry
          continue
        }
        const current = await adapter.getEntity(projectId, 'testcase', key)
        current.requirementIds = normalizeIds(op.requirementIds)
        current.linksUnknown = false
        const entry = states.testcase.entities[key] || { id: key }
        entry.id = key
        entry.path = entry.path || op.path || relativePathFor('testcase', current, { catalogPath: '' })
        entry.baseRequirementIds = normalizeIds(op.requirementIds)
        entry.linksArmed = op.armed === true
        entry.linksUnknown = false
        entry.linksUpdatedAt = new Date().toISOString()
        entry.baseHash = contentHash('testcase', current)
        entry.baseRevision = current.remote?.updatedAt || current.updatedAt || ''
        entry.baseVersion = current.version === null || current.version === undefined ? null : String(current.version)
        entry.basePulledAt = new Date().toISOString()
        states.testcase.entities[key] = entry
        await writeBaseline(root, 'testcase', key, current)
        continue
      }
      if (op.action === 'plan-case-add') {
        if (planFailed(op)) {
          result.skipped.push({ kind: op.kind, id: op.id, action: op.action, reason: 'plan-already-failed' })
          continue
        }
        const planId = createdMap.get(String(op.id)) || String(op.id)
        const localPlan = localScan['test-plan']?.byId.get(String(op.id))
        if (op.localHash && localPlan && localPlan.localHash !== op.localHash) {
          recordApplyConflict({ kind: 'test-plan', id: planId, path: op.path, reason: 'local-changed-before-push' }); markEntityFailure(op)
          markPlanFailure(op)
          continue
        }
        await adapter.addPlanCases(projectId, planId, op.caseIds)
        dirtyPlans.add(String(planId))
        continue
      }
      if (op.action === 'plan-case-deps') {
        if (planFailed(op)) {
          result.skipped.push({ kind: op.kind, id: op.id, action: op.action, reason: 'plan-already-failed' })
          continue
        }
        const planId = createdMap.get(String(op.id)) || String(op.id)
        const current = await adapter.getEntity(projectId, 'test-plan', planId)
        if (current.planCasesComplete === false) {
          recordApplyConflict({ kind: 'test-plan', id: planId, path: op.path, reason: 'plan-cases-incomplete' }); markEntityFailure(op)
          markPlanFailure(op)
          continue
        }
        const target = (current.planCases || []).find((item) => String(item.caseId) === String(op.caseId))
        if (!target) {
          recordApplyConflict({ kind: 'test-plan', id: planId, path: op.path, reason: 'plan-case-changed-before-push' }); markEntityFailure(op)
          markPlanFailure(op)
          continue
        }
        await adapter.updatePlanCaseDeps(projectId, planId, target.planCaseId, op.dependsOn)
        dirtyPlans.add(String(planId))
        continue
      }
      if (op.action === 'plan-case-remove') {
        if (planFailed(op)) {
          result.skipped.push({ kind: op.kind, id: op.id, action: op.action, reason: 'plan-already-failed' })
          continue
        }
        const planId = createdMap.get(String(op.id)) || String(op.id)
        const current = await adapter.getEntity(projectId, 'test-plan', planId)
        const target = (current.planCases || []).find((item) => String(item.planCaseId) === String(op.planCaseId) && String(item.caseId) === String(op.caseId))
        if (!target) {
          recordApplyConflict({ kind: 'test-plan', id: planId, path: op.path, reason: 'plan-case-changed-before-push' }); markEntityFailure(op)
          markPlanFailure(op)
          continue
        }
        await adapter.removePlanCase(projectId, planId, target.planCaseId)
        dirtyPlans.add(String(planId))
        continue
      }
    } catch (error) {
      result.errors.push({ kind: op.kind, id: op.id || op.localId, action: op.action, message: error.message })
      markEntityFailure(op)
      markPlanFailure(op)
    }
  }
  for (const planId of planFailures) {
    recordApplyConflict({ kind: 'test-plan', id: planId, reason: 'plan-case-partial' })
  }
  for (const planId of dirtyPlans) {
    if (planFailures.has(planId)) continue
    try { await refreshPlan(planId) } catch (error) { result.errors.push({ kind: 'test-plan', id: planId, action: 'refresh', message: error.message }) }
  }
  for (const kind of Object.keys(states)) await writeState(root, kind, states[kind])
  if (linkChanges.length) await patchLinkCache(root, { projectId, changes: linkChanges })
  result.applyConflicts = applyConflicts
  result.partial = result.errors.length > 0 || result.skipped.length > 0 || applyConflicts.length > 0 || planFailures.size > 0
  return result
}

export async function resolveConflict({ root, adapter, projectId, kind, id, resolution }) {
  if (!['local', 'remote'].includes(resolution)) throw new Error('resolution 只支持 local/remote')
  if (!KIND_META[kind]) throw new Error(`未知类型 ${kind}`)
  const remote = await adapter.getEntity(projectId, kind, id)
  const base = await readBaseline(root, kind, id)
  if (!base) throw new Error('缺少基线，无法解决冲突')
  const state = await readState(root, kind)
  const key = String(id)
  const entry = state.entities[key] || { id: key }
  let linkCache = null
  if (kind === 'testcase') {
    const cached = await readLinkCache(root, { projectId })
    linkCache = cacheUsable(cached, { projectId, maxAgeMs: 300_000 }) ? cached : null
    if (linkCache?.complete === true) {
      remote.requirementIds = normalizeIds(linkCache.byCase[key] ?? [])
      remote.linksUnknown = false
    } else {
      const localScan = await scanLocal(root)
      const local = localScan.testcase?.byId.get(key) ?? null
      remote.requirementIds = normalizeIds(local?.requirementIds ?? remote.requirementIds)
      remote.linksUnknown = !local
    }
  }
  if (kind === 'test-plan') {
    entry.planCases = remote.planCasesComplete === false ? null : (remote.planCases || [])
    entry.planCasesComplete = remote.planCasesComplete !== false
  }
  if (kind === 'defect') {
    entry.assigneeId = remote.assigneeId
    entry.assigneeName = remote.assigneeName
  }
  if (resolution === 'remote') {
    let relative = entry.path || relativePathFor(kind, remote, { catalogPath: '' })
    if (kind === 'requirement' || kind === 'testcase') {
      try {
        const catalogs = await adapter.listCatalogs(projectId, kind)
        const catalogPath = catalogPathOf(catalogPathMap(catalogs), remote.catalogId)
        relative = relativePathFor(kind, remote, { catalogPath })
      } catch {
        // 目录读取失败时保留旧路径，避免凭空移动文件
      }
    }
    await writeAtomic(safeJoin(root, relative), renderFile(kind, remote))
    if (entry.path && entry.path !== relative) await import('node:fs/promises').then((fs) => fs.unlink(safeJoin(root, entry.path)).catch(() => {}))
    entry.path = relative
    entry.catalogId = remote.catalogId === null || remote.catalogId === undefined ? null : String(remote.catalogId)
  }
  if (kind === 'testcase') {
    if (linkCache?.complete === true) {
      entry.baseRequirementIds = normalizeIds(linkCache.byCase[key] ?? [])
      entry.linksArmed = true
      entry.linksUnknown = false
      entry.linksUpdatedAt = linkCache.fetchedAt
    } else {
      entry.baseRequirementIds = null
      entry.linksArmed = false
      entry.linksUnknown = true
    }
  }
  entry.baseHash = contentHash(kind, remote)
  entry.baseRevision = remote.remote?.updatedAt || remote.updatedAt || ''
  entry.baseVersion = remote.version === null || remote.version === undefined ? null : String(remote.version)
  entry.basePulledAt = new Date().toISOString()
  entry.needsFollowup = false
  state.entities[key] = entry
  await writeState(root, kind, state)
  await writeBaseline(root, kind, key, remote)
  if (resolution === 'remote') await patchLegacyCache(root, { projectId, changes: { [key]: null } })
  return { ok: true, kind, id: key, resolution }
}
