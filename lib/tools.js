/**
 * tmsync preset 工具：tmsync_status / show / pull / validate。
 * 原始 ToolDefinition（JSON Schema），零依赖；参数在 execute 内校验。
 */
export const name = 'tmsync-tools'
export const inject = ['tools', 'tmsync', 'workingDirectory']

const ENTITY_KINDS = ['requirement', 'testcase', 'test-plan', 'defect', 'test-report']

function text(value) {
  return value === undefined || value === null ? '' : String(value)
}

function summarize(summary = {}) {
  return [
    `一致 ${summary.same || 0}`,
    `本地修改 ${summary['local-modified'] || 0}`,
    `本地新增 ${summary['local-added'] || 0}`,
    `平台更新 ${summary['remote-modified'] || 0}`,
    `平台新增 ${summary['remote-new'] || 0}`,
    `冲突 ${summary.conflict || 0}`,
    `本地删除 ${summary['local-deleted'] || 0}`,
    `平台删除 ${summary['remote-deleted'] || 0}`,
    `只读修改 ${summary['readonly-modified'] || 0}`,
    `平台未知 ${summary['remote-unknown'] || 0}`,
    `未跟踪 ${summary.untracked || 0}`,
    `无效 ${summary.invalid || 0}`,
  ].join(' · ')
}

export function renderStatusText(value, entries = []) {
  const lines = [
    `项目 ${value.projectName || '当前项目'}`,
    `工作区 ${value.root}`,
    `状态：${summarize(value.summary)}`,
    `平台检查：${value.remoteCheckedAt}`,
  ]
  if (entries.length === 0) lines.push('没有需要显示的变更。')
  else {
    lines.push('', '变更条目：')
    for (const entry of entries) lines.push(`- [${entry.status}] ${entry.kind} ${entry.code || entry.id || ''} ${entry.title || entry.path} (${entry.path || '未落盘'})${entry.legacy ? ` · legacy:${entry.legacyReason || '需 rebase'}` : ''}`)
  }
  return lines.join('\n')
}

function tool(definition) {
  return definition
}

async function workspaceOf(ctx, exec) {
  if (!exec.agent) throw new Error('tmsync 工具需要 Agent 会话')
  const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
  const found = await ctx.tmsync.workspaceForCwd(cwd)
  if (!found) throw new Error(`当前目录不是 tmsync 工作区：${cwd}。请从测试资产工作台发起会话，或先关联本地工作区。`)
  return found
}

function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 必须是非空字符串`)
  return value.trim()
}

export function apply(ctx) {
  ctx.tools.register(tool({
    name: 'tmsync_status',
    description: '读取当前 tmsync 工作区的本地/平台状态。本地总是重新扫描；平台默认使用 TTL 快照；includeRemote=true 强制刷新平台。返回汇总和变更条目（有界）。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ENTITY_KINDS },
        includeRemote: { type: 'boolean', description: '强制刷新远程状态' },
        limit: { type: 'number', description: '最多返回条目，默认 100' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const found = await workspaceOf(ctx, exec)
      const value = await ctx.tmsync.status(found.projectId, { refresh: args.includeRemote === true })
      const limit = Math.min(Math.max(Number(args.limit) || 100, 1), 300)
      const changed = value.entries
        .filter((entry) => !args.kind || entry.kind === args.kind)
        .filter((entry) => entry.status !== 'same')
      const entries = changed
        .slice(0, limit)
        .map((entry) => ({
          kind: entry.kind,
          id: entry.id,
          code: entry.code,
          title: entry.title,
          path: entry.path,
          status: entry.status,
          localId: entry.localId || null,
          error: entry.error || null,
          localState: entry.localState,
          remoteState: entry.remoteState,
          editable: entry.editable,
          legacy: entry.legacy === true,
          legacyReason: entry.legacyReason || '',
        }))
      return {
        projectId: value.projectId,
        root: value.root,
        summary: value.summary,
        entries,
        truncated: changed.length > entries.length,
        totalChanged: changed.length,
        remoteCheckedAt: value.remoteCheckedAt,
        text: renderStatusText(value, entries) + (changed.length > entries.length ? `\n已截断：共 ${changed.length} 条，只显示前 ${entries.length} 条。` : ''),
      }
    },
  }))

  ctx.tools.register(tool({
    name: 'tmsync_show',
    description: '读取单条 tmsync 资产的本地内容、基线或差异（local/remote/base/diff）。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ENTITY_KINDS },
        id: { type: 'string' },
        view: { type: 'string', enum: ['local', 'remote', 'base', 'diff'] },
      },
      required: ['kind', 'id'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const found = await workspaceOf(ctx, exec)
      const kind = requireString(args.kind, 'kind')
      const id = requireString(args.id, 'id')
      const view = args.view || 'local'
      const value = await ctx.tmsync.entity(found.projectId, kind, id, { view })
      const lines = [`${kind} ${id}（${view}）`]
      const jsonBlock = (value) => `\`\`\`json\n${JSON.stringify(value, null, 2).slice(0, 12000)}\n\`\`\``
      if (view === 'local' && value.local) lines.push('', '本地：', jsonBlock(value.local))
      if (view === 'base' && value.base) lines.push('', '基线：', jsonBlock(value.base))
      if (view === 'remote' && value.remote) lines.push('', '平台：', jsonBlock(value.remote))
      if (view === 'diff' && value.diff) {
        lines.push('', '差异：')
        const preview = (item) => {
          const text = item === undefined || item === null ? '—' : (typeof item === 'string' ? item : JSON.stringify(item))
          return text.length > 300 ? `${text.slice(0, 300)}…` : text
        }
        for (const item of value.diff) lines.push(`- ${item.field} [${item.state}] base=${preview(item.base)} local=${preview(item.local)} remote=${preview(item.remote)}`)
      }
      if (value.links) {
        lines.push('', `链接（${value.links.fresh ? 'fresh' : 'stale/unknown'}）：本地[${(value.links.local || []).join(',') || '—'}] 基线[${value.links.base === null ? '未知' : (value.links.base || []).join(',') || '—'}] 平台[${value.links.remote === null ? '未知' : (value.links.remote || []).join(',') || '—'}]`)
      }
      if (value.remote?.error) lines.push('', `平台读取失败：${value.remote.error}`)
      return { ...value, text: lines.join('\n') }
    },
  }))

  ctx.tools.register(tool({
    name: 'tmsync_pull',
    description: '把远程安全更新拉取到本地。默认 dry-run；apply=true 才写文件。不会覆盖本地修改。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ENTITY_KINDS },
        ids: { type: 'array', items: { type: 'string' } },
        apply: { type: 'boolean', description: 'true 才真正写文件' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const found = await workspaceOf(ctx, exec)
      const result = await ctx.tmsync.pull(found.projectId, {
        kind: args.kind,
        ids: Array.isArray(args.ids) ? args.ids : undefined,
        dryRun: args.apply !== true,
      })
      const plan = result.plan
      const lines = [
        result.applied ? '已拉取。' : '拉取计划（dry-run，未写文件）。',
        `写入 ${plan.write} · 冲突 ${plan.conflict} · 跳过 ${plan.skip} · 平台删除 ${plan.remoteDeleted}`,
      ]
      if (result.written?.length) lines.push('', ...result.written.slice(0, 100).map((item) => `- 写入 ${item.kind} ${item.id} → ${item.path}`))
      if ((result.written?.length || 0) > 100) lines.push(`- 已截断：共 ${result.written.length} 条写入，只显示前 100 条`)
      if (result.conflicts?.length) lines.push('', ...result.conflicts.slice(0, 100).map((item) => `- 冲突 ${item.kind} ${item.id}: ${item.reason}`))
      if (result.errors?.length) lines.push('', ...result.errors.slice(0, 100).map((item) => `- 失败 ${item.kind} ${item.id}: ${item.message}`))
      return { ...result, text: lines.join('\n') }
    },
  }))

  ctx.tools.register(tool({
    name: 'tmsync_plan_cases',
    description: '刷新测试计划的用例基线（全量分页 list_plan_cases），不改本地文件；用于旧工作区或 planCases 不完整。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['refresh'] },
        id: { type: 'string', description: '可选：只刷新一个计划 ID' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const found = await workspaceOf(ctx, exec)
      const result = await ctx.tmsync.planCasesRefresh(found.projectId, { id: args.id })
      const lines = [
        `计划用例基线已刷新：${result.updated.length} 个计划`,
        ...result.updated.map((item) => `- 计划 ${item.id}: ${item.planCases ?? '未知'} 条${item.complete ? '' : '（不完整）'}`),
        ...result.errors.map((item) => `- 失败 ${item.id}: ${item.message}`),
      ]
      return { ...result, text: lines.join('\n') }
    },
  }))

  ctx.tools.register(tool({
    name: 'tmsync_links',
    description: '需求-用例链接：status 查看本地/基线/远程；refresh 重建缓存；adopt 把远程链接采用到未修改的本地用例。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'refresh', 'adopt'] },
        ids: { type: 'array', items: { type: 'string' }, description: 'adopt 时可选的用例 ID' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const found = await workspaceOf(ctx, exec)
      if (args.action === 'status') {
        const value = await ctx.tmsync.linksStatus(found.projectId)
        const lines = [
          `链接缓存：${value.cache ? `${value.cache.complete ? '完整' : '不完整'} @ ${value.cache.fetchedAt}${value.cache.fresh ? '' : '（已过期）'}` : '未构建'}`,
        ]
        const shown = value.entries.slice(0, 200)
        for (const item of shown) {
          if (!item.local.length && !(item.base || []).length && !(item.remote || []).length) continue
          lines.push(`- ${item.code || item.id} ${item.title || ''}: 本地[${item.local.join(',')}] 基线[${item.base === null ? '未知' : item.base.join(',')}] 平台[${item.remote === null ? '未知' : item.remote.join(',')}]${item.armed ? '' : ' · 删除未启用'}`)
        }
        if (value.entries.length > shown.length) lines.push(`- 已截断：共 ${value.entries.length} 条，只显示前 200 条`)
        return { ...value, text: lines.join('\n') }
      }
      if (args.action === 'refresh') {
        const result = await ctx.tmsync.linksRefresh(found.projectId)
        return { ...result, text: `链接缓存已刷新：${result.complete ? '完整' : '不完整'}，需求 ${result.requirements}，用例 ${result.casesLinked}` }
      }
      const result = await ctx.tmsync.linksAdopt(found.projectId, { ids: Array.isArray(args.ids) ? args.ids : undefined })
      const lines = [
        `采用远程链接：${result.adopted.length} 条`,
        ...result.adopted.map((item) => `- ${item.id}: [${item.requirementIds.join(',')}]`),
        ...result.skipped.map((item) => `- 跳过 ${item.id}: ${item.reason}`),
      ]
      return { ...result, text: lines.join('\n') }
    },
  }))

  ctx.tools.register(tool({
    name: 'tmsync_push_plan',
    description: '生成推送计划（只读）。需求/用例/计划/缺陷可写；报告只读；链接/计划用例按基线差异生成。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ENTITY_KINDS },
        ids: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const found = await workspaceOf(ctx, exec)
      const plan = await ctx.tmsync.pushPlan(found.projectId, { kind: args.kind, ids: Array.isArray(args.ids) ? args.ids : undefined })
      const lines = [
        `推送计划 ${plan.planId}（${plan.expiresAt} 前有效）`,
        `创建 ${plan.summary.create} · 更新 ${plan.summary.update} · 链接 ${plan.summary.link || 0} · 解除 ${plan.summary.unlink || 0} · 抑制解除 ${plan.summary.suppressed || 0} · 阻断 ${plan.summary.blocked} · 冲突 ${plan.summary.conflict}`,
      ]
      for (const op of plan.operations.slice(0, 200)) lines.push(`- ${op.action} ${op.kind} ${op.id || op.localId} ${op.requirementId || ''} ${op.caseId || ''} ${op.title || ''} ${op.path || ''}${op.localStatus ? ` status=${op.localStatus}` : ''}`)
      if (plan.operations.length > 200) lines.push(`- …已截断：共 ${plan.operations.length} 个操作，只显示前 200 个`)
      for (const item of plan.suppressedUnlinks || []) lines.push(`- 不会解除 ${item.caseId} ↔ ${item.requirementId}（${item.reason}）`)
      for (const item of plan.blocked) lines.push(`- 阻断 ${item.kind} ${item.id || ''}: ${item.reason}`)
      for (const item of plan.conflicts) lines.push(`- 冲突 ${item.kind} ${item.id || ''}: ${item.reason}`)
      for (const item of plan.warnings || []) lines.push(`- 提示 ${item.kind} ${item.id || ''}: ${item.reason}`)
      lines.push('', '确认后调用 tmsync_push({ planId, confirm: true })。')
      return { ...plan, text: lines.join('\n') }
    },
  }))

  ctx.tools.register(tool({
    name: 'tmsync_push',
    description: '执行已确认的推送计划。必须提供 planId 与 confirm:true；不会自动推送，也不会删除/归档。',
    parameters: {
      type: 'object',
      properties: {
        planId: { type: 'string' },
        confirm: { type: 'boolean' },
      },
      required: ['planId', 'confirm'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const found = await workspaceOf(ctx, exec)
      if (args.confirm !== true) throw new Error('push 必须显式确认（confirm: true）')
      const result = await ctx.tmsync.push(found.projectId, { planId: requireString(args.planId, 'planId'), confirm: true })
      const lines = [
        `${result.partial ? '部分完成' : '推送完成'}：创建 ${result.created.length} · 更新 ${result.updated.length} · 冲突 ${result.conflicts.length} · 跳过 ${(result.skipped || []).length} · 错误 ${result.errors.length}`,
      ]
      for (const item of result.created) lines.push(`- 创建 ${item.kind} ${item.id} → ${item.path}`)
      for (const item of result.updated) lines.push(`- 更新 ${item.kind} ${item.id} → ${item.path}`)
      for (const item of result.conflicts) lines.push(`- 冲突 ${item.kind} ${item.id}: ${item.reason}`)
      for (const item of result.skipped || []) lines.push(`- 跳过 ${item.kind} ${item.id || ''}: ${item.reason}`)
      for (const item of result.errors) lines.push(`- 错误 ${item.kind} ${item.id || ''}: ${item.message}`)
      return { ...result, text: lines.join('\n') }
    },
  }))

  ctx.tools.register(tool({
    name: 'tmsync_rebase',
    description: '以平台/基线为准重写本地文件（丢弃本地修改）。单实体用于 local-modified/conflict/legacy；all 从 .tmsync/baseline 重建 state，用于 state 缺失或批量 legacy。必须 confirm:true。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ENTITY_KINDS },
        id: { type: 'string' },
        all: { type: 'boolean', description: '从 baseline 重建整个工作区 state' },
        allowLocalOnly: { type: 'boolean', description: 'all 模式允许有远程 id 但无 baseline 的本地实体' },
        confirm: { type: 'boolean' },
      },
      required: ['confirm'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const found = await workspaceOf(ctx, exec)
      if (args.confirm !== true) throw new Error('rebase 必须显式确认（confirm: true）')
      const result = await ctx.tmsync.rebase(found.projectId, {
        kind: args.all === true ? undefined : (args.kind ? requireString(args.kind, 'kind') : undefined),
        id: args.all === true ? undefined : (args.id ? requireString(args.id, 'id') : undefined),
        all: args.all === true,
        confirm: true,
        allowLocalOnly: args.allowLocalOnly === true,
      })
      const lines = args.all === true
        ? [`已从 baseline 重建：${result.counts.rewritten} 个实体`, ...(result.localOnly || []).map((item) => `- 本地无 baseline：${item.kind} ${item.id} (${item.path})`)]
        : [`已以平台为准重写 ${result.kind} ${result.id}`]
      return { ...result, text: lines.join('\n') }
    },
  }))

  ctx.tools.register(tool({
    name: 'tmsync_git_checkpoint',
    description: '在工作区创建 Git 检查点（add -A + commit）。仅当仓库根等于工作区根；不 init/push/tag，禁用 hooks/GPG。必须 confirm:true。',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '提交信息；默认 tmsync checkpoint: <project> <ISO>' },
        confirm: { type: 'boolean' },
      },
      required: ['confirm'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const found = await workspaceOf(ctx, exec)
      if (args.confirm !== true) throw new Error('Git 检查点必须显式确认（confirm: true）')
      const result = await ctx.tmsync.gitCheckpoint(found.projectId, { message: args.message, confirm: true })
      const lines = [
        result.created ? `已创建检查点 ${result.commit}（${result.files} 个文件，分支 ${result.branch || 'detached'}）` : '没有可提交的变更。',
        result.preview?.length ? `文件：${result.preview.slice(0, 20).map((item) => item.path).join(', ')}` : '',
      ].filter(Boolean)
      return { ...result, text: lines.join('\n') }
    },
  }))

  ctx.tools.register(tool({
    name: 'tmsync_validate',
    description: '校验当前 tmsync 工作区的 Markdown 结构、front matter、ID、枚举、计划编排与只读规则。',
    parameters: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ENTITY_KINDS } },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const found = await workspaceOf(ctx, exec)
      const value = await ctx.tmsync.validate(found.projectId, { kind: args.kind })
      const lines = [value.ok ? '校验通过。' : `校验失败：${value.errors.length} 个错误。`]
      for (const item of value.errors.slice(0, 100)) lines.push(`- ERROR ${item.file || item.kind}: ${item.field || ''} ${item.message}`)
      for (const item of value.warnings.slice(0, 50)) lines.push(`- WARN ${item.file || item.kind}: ${item.field || ''} ${item.message}`)
      return { ...value, text: lines.join('\n') }
    },
  }))

  ctx.tools.register(tool({
    name: 'tmsync_conflicts',
    description: '列出/查看/解决 tmsync 冲突。resolution 只支持 local 或 remote；冲突必须由用户决定。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'show', 'resolve'] },
        kind: { type: 'string', enum: ENTITY_KINDS },
        id: { type: 'string' },
        resolution: { type: 'string', enum: ['local', 'remote'] },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const found = await workspaceOf(ctx, exec)
      if (args.action === 'list') {
        const value = await ctx.tmsync.status(found.projectId, { refresh: true })
        const conflicts = value.entries.filter((entry) => entry.status === 'conflict').map((entry) => ({ kind: entry.kind, id: entry.id, path: entry.path, title: entry.title }))
        return { conflicts, text: conflicts.length ? conflicts.map((item) => `- ${item.kind} ${item.id} ${item.title} (${item.path})`).join('\n') : '没有冲突。' }
      }
      if (args.action === 'show') {
        const kind = requireString(args.kind, 'kind')
        const id = requireString(args.id, 'id')
        const value = await ctx.tmsync.entity(found.projectId, kind, id, { view: 'diff' })
        const preview = (item) => {
          const text = item === undefined || item === null ? '—' : (typeof item === 'string' ? item : JSON.stringify(item))
          return text.length > 300 ? `${text.slice(0, 300)}…` : text
        }
        const lines = [`冲突 ${kind} ${id}`]
        for (const item of value.diff || []) lines.push(`- ${item.field} [${item.state}] base=${preview(item.base)} local=${preview(item.local)} remote=${preview(item.remote)}`)
        if (value.links) lines.push(`- 链接：本地[${(value.links.local || []).join(',') || '—'}] 基线[${value.links.base === null ? '未知' : (value.links.base || []).join(',') || '—'}] 平台[${value.links.remote === null ? '未知' : (value.links.remote || []).join(',') || '—'}]`)
        return { ...value, text: lines.join('\n') }
      }
      const kind = requireString(args.kind, 'kind')
      const id = requireString(args.id, 'id')
      const resolution = requireString(args.resolution, 'resolution')
      const result = await ctx.tmsync.resolve(found.projectId, { kind, id, resolution })
      return { ...result, text: `已按 ${resolution} 解决 ${kind} ${id}` }
    },
  }))
}
