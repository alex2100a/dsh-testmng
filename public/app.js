/* tmsync 工作台（原生 JS，无构建） */
(() => {
  const API = '/api/tmsync/api'
  const KINDS = ['requirement', 'testcase', 'test-plan', 'defect', 'test-report']
  const KIND_LABEL = { requirement: '测试需求', testcase: '测试用例', 'test-plan': '测试计划', defect: '测试缺陷', 'test-report': '测试报告' }
  const STATUS = {
    same: ['✓', '一致'],
    'local-modified': ['M', '本地修改'],
    'local-added': ['A', '本地新增'],
    'local-deleted': ['D', '本地删除（阻断）'],
    'remote-modified': ['↓', '平台更新'],
    'remote-new': ['+', '平台新增（未拉取）'],
    'remote-deleted': ['⚠', '平台已删除'],
    conflict: ['!', '冲突'],
    untracked: ['?', '未跟踪'],
    invalid: ['?', '无效'],
    'readonly-modified': ['M', '只读类型被修改'],
    'remote-unknown': ['◌', '平台状态未知'],
  }

  const state = {
    info: null,
    config: null,
    workspaces: [],
    projects: [],
    projectId: null,
    workspaceRoot: '',
    kind: 'requirement',
    tree: [],
    summary: {},
    remoteCheckedAt: '',
    selection: null,
    detail: null,
    view: 'content',
    onlyDiff: false,
    query: '',
    busy: false,
    logs: [],
    logsAt: 0,
    pending: new Map(),
    git: null,
    menuOpen: false,
    syncOpen: false,
    collapsedKeys: new Set(),
    treeRequestId: 0,
    detailRequestId: 0,
    revision: null,
    events: {
      source: null,
      state: 'off',
      instanceId: '',
      lastEventId: '',
      retry: 0,
      pending: new Set(),
      timer: null,
      refreshing: false,
      pendingRefresh: false,
    },
  }

  const $ = (id) => document.getElementById(id)
  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag)
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'class') node.className = value
      else if (key === 'text') node.textContent = value
      else if (key === 'html') node.innerHTML = value
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value)
      else if (value !== undefined && value !== null) node.setAttribute(key, value)
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined) continue
      node.append(child instanceof Node ? child : document.createTextNode(String(child)))
    }
    return node
  }
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const badge = (status) => {
    const [icon, label] = STATUS[status] || ['?', status || '未知']
    return el('span', { class: `badge ${status || 'untracked'}`, title: label, text: icon })
  }

  const entityKey = (entry) => `${entry.kind}:${entry.id || entry.localId || entry.path || ''}`
  const nodeEntityKey = (node) => node?.entry ? entityKey(node.entry) : ''
  const findEntity = (nodes, key) => {
    for (const node of nodes || []) {
      if (node.type === 'entity' && entityKey(node.entry || {}) === key) return node.entry
      if (node.type === 'folder') {
        const found = findEntity(node.children || [], key)
        if (found) return found
      }
    }
    return null
  }
  const applyCollapsed = (nodes) => {
    for (const node of nodes || []) {
      if (node.type !== 'folder') continue
      node.expanded = !state.collapsedKeys.has(node.key)
      applyCollapsed(node.children || [])
    }
  }
  const sessionGet = (key) => {
    try { return window.sessionStorage.getItem(key) || '' } catch { return '' }
  }
  const sessionSet = (key, value) => {
    try {
      if (value) window.sessionStorage.setItem(key, value)
      else window.sessionStorage.removeItem(key)
    } catch { /* ignore */ }
  }

  const PENDING_MAX = 32

  function sweepPending() {
    const now = Date.now()
    for (const [key, entry] of state.pending) {
      if (now - entry.at > (entry.ttlMs || 30_000)) state.pending.delete(key)
    }
  }

  function setPending(requestId, callback, { ttlMs = 30_000 } = {}) {
    sweepPending()
    while (state.pending.size >= PENDING_MAX) {
      const oldest = state.pending.keys().next().value
      if (oldest === undefined) break
      state.pending.delete(oldest)
    }
    state.pending.set(requestId, { at: Date.now(), ttlMs, callback })
  }

  function takePending(requestId) {
    const entry = state.pending.get(requestId)
    if (!entry) return null
    state.pending.delete(requestId)
    return entry.callback
  }

  function toast(message, kind = '') {
    const node = $('toast')
    node.textContent = message
    node.className = `toast ${kind}`
    clearTimeout(toast.timer)
    toast.timer = setTimeout(() => node.classList.add('hidden'), 5200)
  }

  async function api(path, options = {}) {
    const res = await fetch(API + path, {
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) {
      const error = data.error || {}
      throw new Error(`${error.message || res.statusText || '请求失败'}${error.hint ? '：' + error.hint : ''}`)
    }
    return data
  }

  function projectOption(projectId) {
    return state.workspaces.find((item) => item.projectId === projectId)
      || state.projects.find((item) => item.id === projectId)
      || null
  }

  function workspaceOf(projectId) {
    return state.workspaces.find((item) => item.projectId === projectId) || null
  }

  function syncRows(summary = {}) {
    return [
      ['本地修改', summary['local-modified'] || 0],
      ['本地新增', summary['local-added'] || 0],
      ['平台更新', summary['remote-modified'] || 0],
      ['未拉取', summary['remote-new'] || 0],
      ['冲突', summary.conflict || 0],
      ['本地删除', summary['local-deleted'] || 0],
      ['平台删除', summary['remote-deleted'] || 0],
      ['平台未知', summary['remote-unknown'] || 0],
      ['无效', summary.invalid || 0],
    ]
  }

  function syncTotals(summary = {}) {
    const pending = (summary['local-modified'] || 0) + (summary['local-added'] || 0)
      + (summary['remote-modified'] || 0) + (summary['remote-new'] || 0)
      + (summary['local-deleted'] || 0) + (summary['remote-deleted'] || 0)
    return {
      conflict: summary.conflict || 0,
      invalid: summary.invalid || 0,
      unknown: summary['remote-unknown'] || 0,
      pending,
    }
  }

  function syncChipInfo() {
    if (!state.projectId) return { key: 'muted', icon: '·', label: '未选择项目' }
    if (!state.workspaceRoot) return { key: 'muted', icon: '·', label: '未关联工作区' }
    const totals = syncTotals(state.summary)
    if (totals.conflict) return { key: 'danger', icon: '⚠', label: `冲突 ${totals.conflict}` }
    if (totals.invalid) return { key: 'danger', icon: '!', label: `异常 ${totals.invalid}` }
    if (totals.unknown) return { key: 'warn', icon: '?', label: `待确认 ${totals.unknown}` }
    if (totals.pending) return { key: 'warn', icon: '•', label: `待处理 ${totals.pending}` }
    return { key: 'ok', icon: '✓', label: '已同步' }
  }

  function setDisabled(id, disabled, reason = '') {
    const button = $(id)
    if (!button) return
    button.disabled = disabled
    if (disabled) button.title = reason
    else button.removeAttribute('title')
  }

  function renderSyncChip() {
    const info = syncChipInfo()
    const chip = $('sync-chip')
    chip.className = `sync-chip ${info.key}`
    chip.title = `${info.label} · 点击查看平台同步明细`
    $('sync-chip-icon').textContent = info.icon
    $('sync-chip-label').textContent = info.label
  }

  function renderSyncPopover() {
    const body = $('sync-popover-body')
    body.innerHTML = ''
    if (!state.workspaceRoot) {
      body.append(el('div', { class: 'muted', text: state.projectId ? '当前项目未关联本地工作区。' : '请先选择项目。' }))
      return
    }
    for (const [label, count] of syncRows(state.summary)) {
      body.append(el('div', { class: 'popover-row' },
        el('span', { class: 'muted', text: label }),
        el('strong', { text: String(count) })
      ))
    }
    $('sync-popover-time').textContent = state.remoteCheckedAt
      ? `平台检查 ${new Date(state.remoteCheckedAt).toLocaleTimeString()}`
      : ''
  }

  function renderGitPanel() {
    const panel = $('git-panel')
    if (!panel) return
    panel.innerHTML = ''
    if (!state.workspaceRoot) {
      panel.append(el('div', { class: 'muted', text: '关联本地工作区后可用。' }))
      return
    }
    const git = state.git
    if (!git) {
      panel.append(el('div', { class: 'muted', text: '正在检测本地 Git…' }))
      return
    }
    if (!git.isRepo) {
      panel.append(el('div', { class: 'muted', text: '未检测到 Git 仓库（本地版本功能不可用）。' }))
      return
    }
    const dirty = git.dirty || { staged: 0, unstaged: 0, untracked: 0 }
    const changes = dirty.staged + dirty.unstaged + dirty.untracked
    panel.append(el('div', { class: 'git-line' },
      el('span', { class: 'muted', text: '分支' }),
      el('strong', { text: git.branch || 'detached' }),
      el('span', { class: `pill ${changes ? 'warn' : 'ok'}`, text: changes ? `${changes} 个变更` : '干净' })
    ))
    if (!git.repoRootMatches) {
      panel.append(el('div', { class: 'pill bad', text: '仓库根与工作区根不一致，检查点已禁用' }))
    }
    const checkpoint = git.checkpoints?.[0]
    if (checkpoint) {
      panel.append(el('div', { class: 'muted', text: `最近检查点 ${checkpoint.commit || '—'} · ${checkpoint.at ? new Date(checkpoint.at).toLocaleString() : ''}` }))
    }
    panel.append(el('div', { class: 'form-actions' },
      el('button', {
        class: 'btn small',
        disabled: !git.repoRootMatches ? 'disabled' : undefined,
        onclick: () => { if (git.repoRootMatches) openGitModal(); else toast('仓库根与工作区根不一致，无法创建检查点', 'error') },
      }, '创建本地检查点')
    ))
    panel.append(el('div', { class: 'git-note muted', text: '仅本地 commit，不 push，也不会同步到测试管理平台。' }))
  }

  function renderTop() {
    const select = $('project-select')
    const ids = new Set()
    for (const item of state.workspaces) ids.add(item.projectId)
    for (const item of state.projects) ids.add(item.id)
    select.innerHTML = ''
    if (ids.size === 0) {
      select.append(el('option', { value: '', text: '未关联项目' }))
    }
    for (const id of ids) {
      const item = projectOption(id)
      const label = item ? `${item.name || item.code || id}${item.code ? `（${item.code}）` : ''}` : id
      const option = el('option', { value: id, text: label })
      option.title = item ? `${item.name || item.code || id}${item.code ? `（${item.code}）` : ''} · 平台 ID ${id}` : id
      select.append(option)
    }
    select.value = state.projectId || ''
    const current = projectOption(state.projectId)
    select.title = current
      ? `${current.name || current.code || state.projectId}${current.code ? `（${current.code}）` : ''} · 平台 ID ${state.projectId}`
      : (state.projectId || '')
    renderSyncChip()
    renderSyncPopover()
    renderGitPanel()
    $('remote-time').textContent = state.remoteCheckedAt ? `平台检查 ${new Date(state.remoteCheckedAt).toLocaleTimeString()}` : ''
    for (const button of document.querySelectorAll('#tabs .tab')) {
      button.classList.toggle('active', button.dataset.kind === state.kind)
    }
    const canSync = Boolean(state.projectId && state.workspaceRoot && !state.busy)
    const syncReason = !state.projectId ? '请先选择项目' : !state.workspaceRoot ? '请先关联本地工作区' : '正在处理'
    setDisabled('popover-pull', !canSync, syncReason)
    setDisabled('popover-push', !canSync, syncReason)
    setDisabled('menu-pull', !canSync, syncReason)
    setDisabled('menu-push', !canSync, syncReason)
    const git = state.git
    const gitReason = !state.workspaceRoot ? '请先关联本地工作区'
      : !git ? '正在检测本地 Git'
      : !git.isRepo ? '未检测到 Git 仓库'
      : !git.repoRootMatches ? '仓库根与工作区根不一致'
      : ''
    setDisabled('menu-git', Boolean(gitReason), gitReason)
    $('start-btn').disabled = !state.projectId || !state.workspaceRoot || window.parent === window
    $('refresh-btn').disabled = !state.projectId || !state.workspaceRoot || state.busy
  }

  function renderSyncPanel() {
    const panel = $('sync-panel')
    panel.innerHTML = ''
    for (const [label, count] of syncRows(state.summary)) {
      panel.append(el('div', { class: 'sync-row' }, el('span', { class: 'muted', text: label }), el('strong', { text: String(count) })))
    }
    if (!state.workspaceRoot) {
      panel.append(el('div', { class: 'muted', text: '当前项目未关联本地工作区。' }))
      panel.append(el('button', { class: 'btn small', onclick: () => openConfig() }, '去关联'))
    }
    if (state.syncOpen) renderSyncPopover()
  }

  function renderLogs() {
    const panel = $('log-panel')
    panel.innerHTML = ''
    if (!state.logs.length) {
      panel.append(el('div', { class: 'muted', text: '暂无操作记录。' }))
      return
    }
    for (const item of state.logs.slice().reverse()) {
      panel.append(el('div', { class: 'log-item' },
        el('b', { text: `${item.action || item.op || '操作'} ${item.kind || ''} ${item.id || ''}` }),
        el('div', { text: `${item.result || ''} ${item.ts ? new Date(item.ts).toLocaleString() : ''}` })
      ))
    }
  }

  function matches(node) {
    if (!state.query) return true
    const q = state.query.toLowerCase()
    if (node.type === 'entity') {
      const entry = node.entry || {}
      return [entry.code, entry.title, entry.path, entry.id].some((value) => String(value || '').toLowerCase().includes(q))
    }
    return (node.children || []).some(matches)
  }

  function visibleNode(node) {
    if (!matches(node)) return false
    if (state.onlyDiff && node.type === 'entity' && node.entry?.status === 'same') return false
    return true
  }

  function renderTree(nodes, parent, depth = 0) {
    for (const node of nodes) {
      if (!visibleNode(node)) continue
      if (node.type === 'folder') {
        const children = node.children || []
        const expanded = !state.collapsedKeys.has(node.key)
        const row = el('div', { class: 'tree-row', role: 'treeitem', 'aria-expanded': String(expanded) },
          el('span', { class: 'tree-caret', text: children.length ? (expanded ? '▾' : '▸') : '' }),
          el('span', { class: 'tree-icon', text: '📁' }),
          el('span', { class: 'tree-label', text: node.name }),
          el('span', { class: 'tree-counts', text: countsText(node.counts) })
        )
        row.addEventListener('click', () => {
          if (state.collapsedKeys.has(node.key)) state.collapsedKeys.delete(node.key)
          else state.collapsedKeys.add(node.key)
          renderTreeView()
        })
        parent.append(el('div', { class: 'tree-node' }, row))
        if (expanded && children.length) {
          const childBox = el('div', { class: 'tree-children' })
          renderTree(children, childBox, depth + 1)
          parent.lastChild.append(childBox)
        }
      } else if (node.type === 'entity') {
        const entry = node.entry || {}
        const selected = state.selection && state.selection.key === entityKey(entry)
        const row = el('div', { class: 'tree-row' + (selected ? ' selected' : ''), role: 'treeitem', tabindex: '0' },
          el('span', { class: 'tree-caret' }),
          el('span', { class: 'tree-icon', text: entry.readOnly ? '🔒' : '📄' }),
          el('span', { class: 'tree-label', text: node.name }),
          badge(entry.status)
        )
        const open = () => selectEntry(entry)
        row.addEventListener('click', open)
        row.addEventListener('keydown', (event) => { if (event.key === 'Enter') open() })
        parent.append(el('div', { class: 'tree-node' }, row))
      }
    }
  }

  function countsText(counts = {}) {
    const parts = []
    for (const [key, value] of Object.entries(counts)) {
      if (!value) continue
      const icon = STATUS[key]?.[0] || key
      parts.push(`${icon}${value}`)
    }
    return parts.join(' ')
  }

  function renderTreeView() {
    const tree = $('tree')
    tree.innerHTML = ''
    if (!state.projectId) {
      tree.append(el('div', { class: 'muted', style: 'padding:10px', text: '请先选择项目。' }))
      return
    }
    if (!state.workspaceRoot) {
      tree.append(el('div', { class: 'muted', style: 'padding:10px', text: '当前项目未关联本地工作区。' }))
      tree.append(el('button', { class: 'btn small', onclick: () => openConfig() }, '关联工作区'))
      return
    }
    if (!state.tree.length) {
      tree.append(el('div', { class: 'muted', style: 'padding:10px', text: '暂无条目；可先拉取或刷新状态。' }))
      return
    }
    renderTree(state.tree, tree)
  }

  function renderTreeChrome() {
    renderSyncChip()
    renderSyncPopover()
    renderSyncPanel()
    $('remote-time').textContent = state.remoteCheckedAt ? `平台检查 ${new Date(state.remoteCheckedAt).toLocaleTimeString()}` : ''
  }

  async function loadTree(kind = state.kind, { keepView = false, silent = false, force = false } = {}) {
    if (!state.projectId) { state.tree = []; renderTreeView(); return }
    const requestId = ++state.treeRequestId
    const tree = $('tree')
    const scrollTop = keepView ? tree.scrollTop : 0
    const selectedKey = keepView && state.selection ? state.selection.key : null
    try {
      const data = await api(`/tree?projectId=${encodeURIComponent(state.projectId)}&kind=${encodeURIComponent(kind)}`)
      if (requestId !== state.treeRequestId) return
      const unchanged = data.revision !== undefined
        && data.revision === state.revision
        && data.remoteCheckedAt === state.remoteCheckedAt
      if (silent && !force && unchanged) {
        state.realtime = data.realtime
        renderRealtime()
        return
      }
      state.tree = data.nodes || []
      state.summary = data.summary || {}
      state.remoteCheckedAt = data.remoteCheckedAt || ''
      state.revision = data.revision
      state.realtime = data.realtime
      if (!keepView) {
        state.collapsedKeys.clear()
        state.selection = null
        state.detail = null
        $('detail-body').classList.add('hidden')
        $('empty').classList.remove('hidden')
      } else {
        applyCollapsed(state.tree)
        if (selectedKey) {
          const found = findEntity(state.tree, selectedKey)
          if (found) state.selection = { ...found, key: selectedKey }
          else {
            state.selection = null
            state.detail = null
            $('detail-body').classList.add('hidden')
            $('empty').classList.remove('hidden')
          }
        }
      }
      if (silent) renderTreeChrome()
      else renderTop()
      renderSyncPanel()
      renderTreeView()
      if (keepView) tree.scrollTop = scrollTop
      renderRealtime()
    } catch (error) {
      if (requestId !== state.treeRequestId) return
      if (silent) {
        state.events.pendingRefresh = true
        renderRealtime()
        return
      }
      state.tree = []
      renderTreeView()
      toast(error.message, 'error')
    }
  }

  async function selectEntry(entry) {
    state.selection = { ...entry, key: entityKey(entry) }
    state.view = 'content'
    renderTreeView()
    await loadDetail()
  }

  async function loadDetail(view = state.view, { silent = false } = {}) {
    if (!state.selection) return
    const entry = state.selection
    const id = entry.id || entry.localId
    const requestId = ++state.detailRequestId
    const detail = $('detail')
    const scrollTop = detail ? detail.scrollTop : 0
    try {
      const data = await api(`/entity?projectId=${encodeURIComponent(state.projectId)}&kind=${encodeURIComponent(entry.kind)}&id=${encodeURIComponent(id || '')}&view=${encodeURIComponent(view === 'content' ? 'local' : view)}`)
      if (requestId !== state.detailRequestId) return
      state.detail = data
      state.view = view
      renderDetail()
      if (silent && detail) detail.scrollTop = scrollTop
    } catch (error) {
      if (silent) return
      toast(error.message, 'error')
    }
  }

  function statusPill(status) {
    const label = STATUS[status]?.[1] || status
    const cls = status === 'same' ? 'ok' : ['conflict', 'local-deleted', 'remote-deleted', 'invalid'].includes(status) ? 'bad' : 'warn'
    return el('span', { class: `pill ${cls}`, text: `${STATUS[status]?.[0] || ''} ${label}` })
  }

  function renderDetail() {
    const root = $('detail-body')
    const empty = $('empty')
    if (!state.selection || !state.detail) {
      root.classList.add('hidden')
      empty.classList.remove('hidden')
      return
    }
    empty.classList.add('hidden')
    root.classList.remove('hidden')
    root.innerHTML = ''
    const entry = state.selection
    const local = state.detail.local
    const base = state.detail.base
    const remote = state.detail.remote
    const title = local?.title || local?.name || entry.title || entry.id || entry.path
    const head = el('div', { class: 'detail-head' },
      el('div', {},
        el('h2', { class: 'detail-title', text: title }),
        el('div', { class: 'detail-meta', text: `${entry.code || ''} ${entry.kind} · ${entry.path || '未落盘'}` }),
        el('div', { class: 'detail-meta', text: `id ${entry.id || entry.localId || '—'} · catalog ${entry.catalogId || '—'}` })
      ),
      el('div', { class: 'detail-actions' },
        statusPill(entry.status),
        el('button', { class: 'btn small', onclick: () => loadDetail('content') }, '内容'),
        el('button', { class: 'btn small', onclick: () => loadDetail('diff') }, '差异'),
        el('button', { class: 'btn small', onclick: () => loadDetail('info') }, '信息'),
        el('button', { class: 'btn small', onclick: copyPath }, '复制路径'),
        entry.status === 'conflict' ? el('button', { class: 'btn small', onclick: () => resolveConflict(entry.kind, entry.id, 'local') }, '保留本地') : null,
        entry.status === 'conflict' ? el('button', { class: 'btn small', onclick: () => resolveConflict(entry.kind, entry.id, 'remote') }, '采用平台') : null,
        (entry.status === 'local-modified' || entry.legacy) ? el('button', { class: 'btn small', onclick: () => rebaseEntry(entry.kind, entry.id) }, '以平台为准') : null
      )
    )
    root.append(head)
    const tabs = el('div', { class: 'view-tabs' })
    for (const [key, label] of [['content', '内容'], ['diff', '差异'], ['info', '信息']]) {
      tabs.append(el('button', { class: state.view === key ? 'active' : '', onclick: () => loadDetail(key), text: label }))
    }
    root.append(tabs)

    if (state.view === 'diff') {
      root.append(renderDiff(state.detail.diff || []))
    } else if (state.view === 'info') {
      root.append(el('div', { class: 'card' },
        el('table', { class: 'field-table' },
          el('tbody', {},
            row('类型', KIND_LABEL[entry.kind] || entry.kind),
            row('项目 ID', state.projectId || '—'),
            row('状态', STATUS[entry.status]?.[1] || entry.status),
            row('本地状态', entry.localState),
            row('平台状态', entry.remoteState),
            row('可编辑', entry.editable ? '是' : '否'),
            row('平台更新时间', entry.remoteUpdatedAt || '—'),
            row('本地 hash', entry.localHash || '—'),
            row('基线 hash', entry.baseHash || '—')
          )
        )
      ))
      root.append(el('div', { class: 'card' },
        el('div', { class: 'muted', text: '基线（canonical）' }),
        el('pre', { class: 'code', text: JSON.stringify(base, null, 2) })
      ))
      if (remote) root.append(el('div', { class: 'card' }, el('div', { class: 'muted', text: '平台（canonical）' }), el('pre', { class: 'code', text: JSON.stringify(remote, null, 2).slice(0, 30000) })))
    } else {
      root.append(renderContent(local || base || {}, entry.kind, state.detail.links))
    }
  }

  function row(label, value) {
    return el('tr', {}, el('th', { text: label }), el('td', { text: String(value ?? '—') }))
  }

  function renderContent(entity, kind, links) {
    const card = el('div', { class: 'card' })
    const add = (heading, value) => {
      if (value === undefined || value === null || value === '') return
      card.append(el('h3', { text: heading }))
      card.append(el('div', { class: 'md', text: String(value) }))
    }
    const attrs = []
    if (entity.priority) attrs.push(`优先级 ${entity.priority}`)
    if (entity.status) attrs.push(`状态 ${entity.status}`)
    if (entity.type) attrs.push(`类型 ${entity.type}`)
    if (entity.severity) attrs.push(`严重级 ${entity.severity}`)
    if (attrs.length) card.append(el('div', { class: 'muted', text: attrs.join(' · ') }))
    if (kind === 'testcase') {
      add('前置条件', entity.precondition)
      if (Array.isArray(entity.steps) && entity.steps.length) {
        card.append(el('h3', { text: '步骤' }))
        const table = el('table', { class: 'field-table' }, el('thead', {}, el('tr', {}, el('th', { text: '#' }), el('th', { text: '操作' }), el('th', { text: '预期' }))))
        const body = el('tbody')
        for (const step of entity.steps) body.append(el('tr', {}, el('td', { text: String(step.no ?? '') }), el('td', { text: step.action || '' }), el('td', { text: step.expected || '' })))
        table.append(body)
        card.append(table)
      }
      if (entity.requirementIds?.length) add('关联需求', entity.requirementIds.join(', '))
      if (links) {
        card.append(el('h3', { text: '链接状态' }))
        card.append(el('div', { class: 'muted', text: `本地 [${(links.local || []).join(',') || '—'}] · 基线 [${links.base === null ? '未知' : (links.base || []).join(',') || '—'}] · 平台 [${links.remote === null ? '未知' : (links.remote || []).join(',') || '—'}]${links.armed ? '' : ' · 删除未启用'}` }))
        card.append(el('div', { class: 'form-actions' },
          el('button', { class: 'btn small', onclick: refreshLinks }, '刷新链接'),
          el('button', { class: 'btn small', onclick: adoptLinks }, '采用平台链接')
        ))
      }
    } else if (kind === 'requirement') {
      add('描述', entity.description)
      add('验收标准', entity.acceptanceCriteria)
    } else if (kind === 'test-plan') {
      add('描述', entity.description)
      if (entity.caseRefs?.length) add('用例编排', entity.caseRefs.map((item) => `${item.order || ''} ${item.caseId} ${item.dependsOn?.length ? '依赖 ' + item.dependsOn.join(',') : ''}`).join('\n'))
      if (entity.qualityGate?.rules?.length) add('质量门禁', entity.qualityGate.rules.map((rule) => `${rule.metric} ${rule.operator} ${rule.value}`).join('\n'))
    } else if (kind === 'defect') {
      add('描述', entity.description)
      add('指派人（只读）', entity.assigneeName || entity.assigneeId || '—')
      if (entity.statusComment) add('状态说明', entity.statusComment)
      const associations = []
      if (entity.caseId) associations.push(`用例 ${entity.caseId}`)
      if (entity.planId) associations.push(`计划 ${entity.planId}`)
      if (entity.requirementId) associations.push(`需求 ${entity.requirementId}`)
      if (associations.length) add('关联', associations.join(' · '))
      if (entity.assigneeId && state.detail?.base && String(entity.assigneeId) !== String(state.detail.base.assigneeId ?? '')) {
        card.append(el('div', { class: 'pill warn', text: '指派人只读：本地修改不会推送' }))
      }
    } else if (kind === 'test-report') {
      add('摘要', '平台报告只读；完整报告请在平台查看。')
      if (entity.reportContent) add('结构化内容', JSON.stringify(entity.reportContent, null, 2))
    }
    if (entity.readOnly) card.append(el('div', { class: 'pill warn', text: '只读：本地修改不会推送' }))
    if (!Object.keys(entity).length) card.append(el('div', { class: 'muted', text: '无本地内容；可先拉取平台数据。' }))
    return card
  }

  function renderDiff(diff) {
    if (!diff.length) return el('div', { class: 'card muted', text: '没有字段差异。' })
    const table = el('table', { class: 'diff-table' },
      el('thead', {}, el('tr', {}, el('th', { text: '字段' }), el('th', { text: '基线' }), el('th', { text: '本地' }), el('th', { text: '平台' }), el('th', { text: '状态' })))
    )
    const body = el('tbody')
    for (const item of diff) {
      body.append(el('tr', {},
        el('td', { text: item.field }),
        el('td', { text: preview(item.base) }),
        el('td', { text: preview(item.local) }),
        el('td', { text: preview(item.remote) }),
        el('td', { text: item.state })
      ))
    }
    table.append(body)
    return el('div', { class: 'card' }, table)
  }

  function preview(value) {
    if (value === undefined || value === null) return '—'
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return text.length > 300 ? `${text.slice(0, 300)}…` : text
  }

  async function refreshLinks() {
    if (!state.projectId) return
    try {
      const data = await api('/links/refresh', { method: 'POST', body: { projectId: state.projectId } })
      toast(`链接缓存已刷新：需求 ${data.result.requirements}，用例 ${data.result.casesLinked}`, data.result.complete ? 'ok' : 'error')
      await loadDetail(state.view)
    } catch (error) { toast(error.message, 'error') }
  }

  async function adoptLinks() {
    if (!state.projectId) return
    if (!confirm('把平台链接采用到未修改的本地用例？有本地修改的用例会被跳过。')) return
    try {
      const data = await api('/links/adopt', { method: 'POST', body: { projectId: state.projectId } })
      const result = data.result || {}
      toast(`已采用 ${result.adopted?.length || 0} 条，跳过 ${result.skipped?.length || 0} 条`, 'ok')
      await loadTree()
      await loadDetail('content')
    } catch (error) { toast(error.message, 'error') }
  }

  async function copyPath() {    const path = state.selection?.path
    if (!path) return toast('没有本地路径', 'error')
    try { await navigator.clipboard.writeText(path); toast('已复制路径', 'ok') } catch { toast(path) }
  }

  async function refreshStatus() {
    if (!state.projectId || !state.workspaceRoot) return toast('请先关联本地工作区', 'error')
    state.busy = true; renderTop()
    try {
      const data = await api('/status/refresh', { method: 'POST', body: { projectId: state.projectId } })
      state.summary = data.summary || {}
      state.remoteCheckedAt = data.remoteCheckedAt || ''
      toast('状态已刷新', 'ok')
      await loadTree()
      await loadLogs()
    } catch (error) { toast(error.message, 'error') }
    finally { state.busy = false; renderTop() }
  }

  async function pull() {
    if (!state.projectId || !state.workspaceRoot) return toast('请先关联本地工作区', 'error')
    if (!confirm('从平台拉取安全更新？本地已修改的条目不会被覆盖。')) return
    state.busy = true; renderTop()
    try {
      const data = await api('/pull', { method: 'POST', body: { projectId: state.projectId, dryRun: false } })
      const result = data.result || {}
      toast(`拉取完成：写入 ${result.written?.length || 0}，冲突 ${result.conflicts?.length || 0}，错误 ${result.errors?.length || 0}`, result.errors?.length ? 'error' : 'ok')
      await loadTree()
      await loadLogs()
    } catch (error) { toast(error.message, 'error') }
    finally { state.busy = false; renderTop() }
  }

  function startSession() {
    if (window.parent === window) return toast('请在 DSH 内打开工作台后发起会话', 'error')
    if (!state.workspaceRoot) return toast('请先关联本地工作区', 'error')
    const requestId = `req-${Date.now()}`
    window.parent.postMessage({ type: 'tmsync:start-session', requestId, cwd: state.workspaceRoot, projectId: state.projectId }, window.location.origin)
    setPending(requestId, (data) => {
      if (data.type === 'tmsync:session-started') toast('已打开 tmsync 会话', 'ok')
      else toast(data.message || '发起会话失败', 'error')
    })
  }

  async function pushPlan() {
    if (!state.projectId || !state.workspaceRoot) return toast('请先关联本地工作区', 'error')
    state.busy = true; renderTop()
    try {
      const data = await api('/push/plan', { method: 'POST', body: { projectId: state.projectId } })
      openPushModal(data.plan)
    } catch (error) { toast(error.message, 'error') }
    finally { state.busy = false; renderTop() }
  }

  function openPushModal(plan) {
    const modal = $('modal')
    modal.classList.remove('hidden')
    $('modal-title').textContent = '推送计划'
    const content = $('modal-content')
    content.innerHTML = ''
    content.append(el('div', { class: 'card' },
      el('div', { text: `创建 ${plan.summary.create} · 更新 ${plan.summary.update} · 链接 ${plan.summary.link || 0} · 解除 ${plan.summary.unlink || 0} · 抑制解除 ${plan.summary.suppressed || 0} · 阻断 ${plan.summary.blocked} · 冲突 ${plan.summary.conflict}` }),
      el('div', { class: 'muted', text: `${plan.expiresAt} 前有效` })
    ))
    if (plan.operations.length) {
      const card = el('div', { class: 'card' }, el('strong', { text: '将执行' }))
      for (const op of plan.operations) {
        card.append(el('div', { class: 'log-item' },
          el('b', { text: `${op.action} ${op.kind} ${op.id || op.localId}` }),
          el('div', { text: `${op.title || ''} ${op.path || ''}` }),
          op.patch && Object.keys(op.patch).length ? el('div', { class: 'muted', text: `字段：${Object.keys(op.patch).join(', ')}` }) : null,
          op.statusChange ? el('div', { class: 'muted', text: `状态 → ${op.statusChange}${op.statusComment ? '：' + op.statusComment : ''}` }) : null
        ))
      }
      content.append(card)
    }
    if (plan.blocked.length) {
      const card = el('div', { class: 'card' }, el('strong', { text: '阻断' }))
      for (const item of plan.blocked) card.append(el('div', { class: 'log-item', text: `${item.kind} ${item.id || ''}: ${item.reason}` }))
      content.append(card)
    }
    if (plan.conflicts.length) {
      const card = el('div', { class: 'card' }, el('strong', { text: '冲突' }))
      for (const item of plan.conflicts) card.append(el('div', { class: 'log-item', text: `${item.kind} ${item.id || ''}: ${item.reason}` }))
      content.append(card)
    }
    if (plan.suppressedUnlinks?.length) {
      const card = el('div', { class: 'card' }, el('strong', { text: '本次不会解除的关联' }))
      for (const item of plan.suppressedUnlinks) card.append(el('div', { class: 'log-item', text: `${item.caseId} ↔ ${item.requirementId}：${item.reason}` }))
      content.append(card)
    }
    if (plan.warnings?.length) {
      const card = el('div', { class: 'card' }, el('strong', { text: '提示' }))
      for (const item of plan.warnings) card.append(el('div', { class: 'log-item', text: `${item.kind} ${item.id || ''}：${item.reason}` }))
      content.append(card)
    }
    const actions = el('div', { class: 'form-actions' })
    if (plan.operations.length) {
      actions.append(el('button', { class: 'btn primary', onclick: async () => {
        if (!confirm(`确认推送 ${plan.operations.length} 条变更？`)) return
        try {
          const data = await api('/push', { method: 'POST', body: { projectId: state.projectId, planId: plan.planId, confirm: true } })
          const result = data.result || {}
          const label = result.partial ? '部分完成' : '推送完成'
          toast(`${label}：创建 ${result.created?.length || 0}，更新 ${result.updated?.length || 0}，冲突 ${result.conflicts?.length || 0}，跳过 ${result.skipped?.length || 0}，错误 ${result.errors?.length || 0}`, result.errors?.length || result.partial ? 'error' : 'ok')
          $('modal').classList.add('hidden')
          await loadTree()
          await loadLogs()
        } catch (error) { toast(error.message, 'error') }
      } }, '确认推送'))
    }
    content.append(actions)
  }

  async function resolveConflict(kind, id, resolution) {
    try {
      await api('/conflict/resolve', { method: 'POST', body: { projectId: state.projectId, kind, id, resolution } })
      toast(`已按 ${resolution === 'local' ? '本地' : '平台'} 解决冲突`, 'ok')
      await loadTree()
      await loadDetail('content')
    } catch (error) { toast(error.message, 'error') }
  }

  async function rebaseEntry(kind, id) {
    if (!confirm('以平台为准重写该文件？本地修改会被丢弃。')) return
    try {
      await api('/rebase', { method: 'POST', body: { projectId: state.projectId, kind, id, confirm: true } })
      toast('已以平台为准重写本地文件', 'ok')
      await loadTree()
      await loadDetail('content')
    } catch (error) { toast(error.message, 'error') }
  }

  function pickDirectory() {
    return new Promise((resolve) => {
      if (window.parent === window) {
        const path = prompt('输入本地工作区绝对路径：')
        resolve(path || null)
        return
      }
      const requestId = `dir-${Date.now()}`
      setPending(requestId, (data) => resolve(data.path || null), { ttlMs: 300_000 })
      window.parent.postMessage({ type: 'tmsync:pick-directory', requestId }, window.location.origin)
    })
  }

  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) return
    const data = event.data || {}
    if (!data.requestId) return
    const callback = takePending(data.requestId)
    if (!callback) return
    callback(data)
  })

  async function loadLogs({ silent = false, force = false } = {}) {
    const now = Date.now()
    if (!force && now - state.logsAt < 2000) return
    state.logsAt = now
    try {
      const data = await api('/logs?limit=50')
      state.logs = (data.logs || []).slice(-50)
      renderLogs()
    } catch {
      if (!silent) return
    }
  }

  async function loadGit({ silent = false } = {}) {
    if (!state.projectId || !state.workspaceRoot) {
      state.git = null
      if (silent) renderGitPanel()
      else renderTop()
      return
    }
    try {
      const data = await api(`/git?projectId=${encodeURIComponent(state.projectId)}`)
      state.git = data
    } catch {
      state.git = null
    }
    if (silent) renderGitPanel()
    else renderTop()
  }

  function openGitModal() {
    const git = state.git
    if (!git?.repoRootMatches) return toast('当前工作区不是可提交的 Git 仓库', 'error')
    const modal = $('modal')
    modal.classList.remove('hidden')
    $('modal-title').textContent = '本地 Git 检查点'
    const content = $('modal-content')
    content.innerHTML = ''
    const dirty = git.dirty || { staged: 0, unstaged: 0, untracked: 0 }
    const files = git.stagedFiles || []
    const conflicts = (state.summary || {}).conflict || 0
    content.append(el('div', { class: 'card' },
      el('div', { text: `分支 ${git.branch || 'detached'} · HEAD ${git.head || '—'}` }),
      el('div', { class: 'muted', text: `已暂存 ${dirty.staged} · 未暂存 ${dirty.unstaged} · 未跟踪 ${dirty.untracked}` }),
      conflicts ? el('div', { class: 'pill warn', text: `仍有 ${conflicts} 条同步冲突未解决` }) : null,
      el('div', { class: 'muted', text: '仅创建本地 Git commit，不会 push，也不会同步到测试管理平台；提交范围受 .gitignore 约束。' })
    ))
    if (files.length) {
      const card = el('div', { class: 'card' }, el('strong', { text: `变更文件（${files.length}）` }))
      for (const item of files.slice(0, 100)) card.append(el('div', { class: 'log-item', text: `${item.status} ${item.path}` }))
      content.append(card)
    }
    const input = el('input', { type: 'text', placeholder: '提交信息（可留空）' })
    input.value = `tmsync checkpoint: ${state.projectId}`
    content.append(el('div', { class: 'card' }, el('label', { text: '提交信息' }), input))
    content.append(el('div', { class: 'form-actions' },
      el('button', { class: 'btn primary', onclick: async () => {
        if (!confirm('确认创建本地 Git 检查点？只会在本地 commit，不会 push。')) return
        try {
          const data = await api('/git/checkpoint', { method: 'POST', body: { projectId: state.projectId, message: input.value, confirm: true } })
          const result = data.result || {}
          toast(result.created ? `已创建检查点 ${result.commit}` : '没有可提交的变更', result.created ? 'ok' : '')
          $('modal').classList.add('hidden')
          await loadGit()
          await loadLogs()
        } catch (error) { toast(error.message, 'error') }
      } }, '创建检查点')
    ))
  }

  async function loadStatus({ silent = false, preserveProject = false, refreshProjects = true } = {}) {
    sweepPending()
    const previous = preserveProject ? state.projectId : null
    const data = await api('/status')
    state.info = data.info
    state.config = data.config
    state.workspaces = data.workspaces || []
    if (refreshProjects) {
      try { const projects = await api('/projects'); state.projects = projects.projects || [] } catch { state.projects = [] }
    }
    const ids = new Set()
    for (const item of state.workspaces) ids.add(item.projectId)
    for (const item of state.projects) ids.add(item.id)
    const firstWorkspace = state.workspaces.find((item) => item.exists && item.workspace)
    const fallback = firstWorkspace?.projectId || state.workspaces[0]?.projectId || state.projects[0]?.id || null
    state.projectId = previous && ids.has(previous) ? previous : fallback
    state.workspaceRoot = workspaceOf(state.projectId)?.localRoot || ''
    if (silent) renderTreeChrome()
    else {
      renderTop()
      renderSyncPanel()
      if (state.projectId && state.workspaceRoot) await loadTree(state.kind)
      else renderTreeView()
      await loadLogs()
      await loadGit()
    }
    renderCompatBanner()
    ensureEvents()
    if (silent) return
    if (state.config?.configError || state.info?.configError) {
      toast('配置文件损坏或结构无效；请先备份/修复配置，不要直接保存', 'error')
      openConfig()
      return
    }
    if (!state.config?.platform?.hasToken) openConfig()
  }

  const EVENTS_API = API + '/events'

  function renderCompatBanner() {
    const node = $('compat-banner')
    if (!node) return
    const compat = state.info?.compatibility
    if (!compat || compat.status === 'supported' || compat.status === 'unknown') {
      node.className = 'compat-banner hidden'
      node.textContent = ''
      return
    }
    const key = `tmsync.compat.${compat.status}.${compat.version || ''}`
    if (sessionGet(key) === '1') {
      node.className = 'compat-banner hidden'
      node.textContent = ''
      return
    }
    node.className = `compat-banner ${compat.status === 'incompatible' ? 'danger' : 'warn'}`
    node.textContent = ''
    node.append(
      el('span', { class: 'grow', text: compat.message || '当前 DSH 版本未在 tmsync 测试矩阵内。' }),
      el('button', {
        class: 'btn small',
        text: '关闭',
        onclick: () => { sessionSet(key, '1'); renderCompatBanner() },
      })
    )
  }

  function renderRealtime() {
    const dot = $('realtime-dot')
    if (!dot) return
    const events = state.events
    let cls = 'off'
    let title = '实时更新未连接'
    if (events.state === 'open') {
      if (state.info?.realtime === false) {
        cls = 'off'
        title = '实时更新已关闭（控制通道已连接）'
      } else {
        cls = 'ok'
        title = '实时更新已连接'
      }
    } else if (events.state === 'connecting') {
      cls = 'warn'
      title = '正在连接实时更新'
    } else if (events.state === 'fallback') {
      cls = 'off'
      title = '实时更新不可用，使用 60s 轮询'
    }
    dot.className = `realtime-dot ${cls}`
    dot.title = title
  }

  function ensureEvents() {
    if (typeof window.EventSource !== 'function') {
      state.events.state = 'fallback'
      renderRealtime()
      return
    }
    if (state.events.source) return
    connectEvents()
  }

  function connectEvents() {
    disconnectEvents()
    if (!state.info) return
    const last = state.events.lastEventId || sessionGet('tmsync.sse.lastId')
    const url = EVENTS_API + (last ? `?lastEventId=${encodeURIComponent(last)}` : '')
    state.events.state = 'connecting'
    renderRealtime()
    let source
    try {
      source = new EventSource(url)
    } catch {
      state.events.state = 'fallback'
      renderRealtime()
      return
    }
    state.events.source = source
    source.onopen = () => {
      state.events.state = 'open'
      state.events.retry = 0
      renderRealtime()
    }
    source.addEventListener('hello', (event) => {
      try {
        const data = JSON.parse(event.data || '{}')
        const previous = state.events.instanceId
        state.events.instanceId = data.instanceId || ''
        if (previous && previous !== state.events.instanceId) {
          state.events.lastEventId = ''
          sessionSet('tmsync.sse.lastId', '')
          queueEvent({ kind: 'resync', projectId: null })
        }
      } catch { /* ignore */ }
    })
    source.addEventListener('tmsync', (event) => {
      try {
        const data = JSON.parse(event.data || '{}')
        if (event.lastEventId) {
          state.events.lastEventId = event.lastEventId
          sessionSet('tmsync.sse.lastId', event.lastEventId)
        }
        queueEvent(data)
      } catch { /* ignore */ }
    })
    source.addEventListener('resync', (event) => {
      try {
        const data = JSON.parse(event.data || '{}')
        queueEvent({ kind: 'resync', projectId: data.projectId })
      } catch {
        queueEvent({ kind: 'resync' })
      }
    })
    source.onerror = () => {
      if (state.events.state !== 'fallback') {
        state.events.state = 'fallback'
        renderRealtime()
      }
      state.events.retry += 1
      if (state.events.retry >= 3) {
        disconnectEvents()
        state.events.timer = setTimeout(() => {
          state.events.timer = null
          connectEvents()
        }, 60_000)
      }
    }
  }

  function disconnectEvents() {
    const events = state.events
    if (events.source) {
      try { events.source.close() } catch { /* ignore */ }
      events.source = null
    }
    if (events.timer) {
      clearTimeout(events.timer)
      events.timer = null
    }
  }

  function queueEvent(event) {
    if (!event || (event.v !== undefined && event.v !== 1)) return
    if (event.projectId && state.projectId && String(event.projectId) !== String(state.projectId)) return
    const kind = event.kind
    const pending = state.events.pending
    if (kind === 'watch-error') {
      state.events.state = 'fallback'
      renderRealtime()
    }
    if (kind === 'resync' || kind === 'config') pending.add(kind)
    else if (kind === 'local' || kind === 'status') pending.add('tree')
    else if (kind === 'git') pending.add('git')
    else if (kind === 'logs') pending.add('logs')
    if (pending.size > 8) {
      pending.clear()
      pending.add('resync')
    }
    if (state.events.timer === null) {
      state.events.timer = setTimeout(() => { void flushRefresh() }, 300)
    }
  }

  async function flushRefresh() {
    const events = state.events
    events.timer = null
    if (events.refreshing) {
      events.pendingRefresh = true
      return
    }
    if (events.pending.size === 0) return
    if (document.visibilityState !== 'visible' || state.busy || !$('modal').classList.contains('hidden')) {
      events.pendingRefresh = true
      return
    }
    events.refreshing = true
    const kinds = new Set(events.pending)
    events.pending.clear()
    try {
      if (kinds.has('resync') || kinds.has('config')) {
        await loadStatus({ silent: true, preserveProject: true, refreshProjects: false })
        if (state.projectId && state.workspaceRoot) {
          await loadTree(state.kind, { keepView: true, silent: true, force: true })
          if (state.selection) await loadDetail(state.view, { silent: true })
        }
      } else if (kinds.has('tree')) {
        await loadTree(state.kind, { keepView: true, silent: true })
        if (state.selection) await loadDetail(state.view, { silent: true })
      }
      if (kinds.has('git')) await loadGit({ silent: true })
      if (kinds.has('logs')) await loadLogs({ silent: true })
    } catch (error) {
      console.warn('[tmsync] 实时刷新失败', error)
    } finally {
      events.refreshing = false
      if (events.pendingRefresh) {
        events.pendingRefresh = false
        if (events.pending.size > 0) setTimeout(() => { void flushRefresh() }, 0)
      }
    }
  }

  async function openConfig() {
    const modal = $('modal')
    modal.classList.remove('hidden')
    $('modal-title').textContent = 'tmsync 配置'
    const content = $('modal-content')
    content.innerHTML = ''
    const cfg = state.config || { platform: {}, sync: {} }
    if (cfg.configError) {
      content.append(el('div', { class: 'card' },
        el('strong', { text: '配置错误' }),
        el('div', { class: 'muted', text: `${cfg.configError.message || '配置文件损坏'}${cfg.configError.hint ? '：' + cfg.configError.hint : ''}` })
      ))
    }
    const form = el('div', { class: 'form-grid' })
    const input = (label, value, type = 'text', placeholder = '') => {
      const node = el('input', { type, value: value || '', placeholder })
      form.append(el('label', { text: label }), node)
      return node
    }
    const platformUrl = input('平台 Web 地址', cfg.platform?.platformUrl || '', 'text', 'http://localhost:5173/')
    const mcpUrl = input('MCP 地址', cfg.platform?.mcpUrl || '', 'text', 'http://localhost:8000/mcp')
    const token = input('PAT（留空不修改）', '', 'password', cfg.platform?.hasToken ? '已配置，留空保持不变' : 'mcp_...')
    content.append(el('div', { class: 'card' }, form,
      el('div', { class: 'form-actions' },
        el('button', { class: 'btn', onclick: () => testConnection() }, '测试连接'),
        el('button', { class: 'btn primary', onclick: () => saveConfig({ platformUrl: platformUrl.value, mcpUrl: mcpUrl.value, token: token.value }) }, '保存')
      )
    ))

    const projectCard = el('div', { class: 'card' }, el('strong', { text: '项目与本地工作区' }))
    for (const project of state.projects) {
      const mapping = workspaceOf(project.id)
      projectCard.append(el('div', { class: 'project-row' },
        el('div', { class: 'grow' },
          el('div', { text: `${project.name || project.code || project.id} ${project.code ? `(${project.code})` : ''}` }),
          el('div', { class: 'path', text: `平台 ID：${project.id}${mapping?.localRoot ? ' · ' + mapping.localRoot : ' · 未关联'}${mapping?.git?.isRepo ? ' · Git' : ''}` })
        ),
        mapping
          ? el('button', { class: 'btn small', onclick: () => unlinkProject(project.id) }, '解除')
          : el('button', { class: 'btn small primary', onclick: () => linkProject(project.id) }, '关联目录')
      ))
    }
    if (!state.projects.length) projectCard.append(el('div', { class: 'muted', text: '未读取到平台项目；请先保存配置并测试连接。' }))
    content.append(projectCard)
    const syncCard = el('div', { class: 'card' },
      el('strong', { text: '同步选项' }),
      el('div', { class: 'muted', text: `可编辑：${(cfg.sync?.editableKinds || []).join(', ') || '—'}；报告只读；指派人只读` }),
      el('div', { class: 'muted', text: `分页 ${cfg.workbench?.pageSize || 50} · 状态 TTL ${Math.round((cfg.workbench?.statusTtlMs || 300000) / 1000)}s` })
    )
    content.append(syncCard)
    const compat = state.info?.compatibility
    if (compat) {
      content.append(el('div', { class: 'card' },
        el('strong', { text: 'DSH 兼容性' }),
        el('div', { class: 'muted', text: `${compat.status} · ${compat.version || '未知'} · 支持 ${compat.range || '—'}` }),
        el('div', { class: 'muted', text: compat.message || '' })
      ))
    }
  }

  async function saveConfig({ platformUrl, mcpUrl, token }) {
    try {
      const platform = { platformUrl, mcpUrl }
      if (token) platform.token = token
      await api('/config', { method: 'PUT', body: { platform } })
      toast('配置已保存', 'ok')
      $('modal').classList.add('hidden')
      await loadStatus()
    } catch (error) { toast(error.message, 'error') }
  }

  async function testConnection() {
    try {
      const data = await api('/test-connection', { method: 'POST' })
      const result = data.result || {}
      toast(result.ok ? `连接成功：${result.toolCount} 个工具` : `连接失败：${result.error?.message || '未知错误'}`, result.ok ? 'ok' : 'error')
    } catch (error) { toast(error.message, 'error') }
  }

  async function linkProject(projectId) {
    const root = await pickDirectory()
    if (!root) return
    try {
      await api('/workspaces/link', { method: 'POST', body: { projectId, root } })
      toast('已关联本地工作区', 'ok')
      $('modal').classList.add('hidden')
      await loadStatus()
    } catch (error) { toast(error.message, 'error') }
  }

  async function unlinkProject(projectId) {
    if (!confirm('解除该项目的本地工作区绑定？不会删除工作区文件。')) return
    try {
      await api('/workspaces/unlink', { method: 'POST', body: { projectId } })
      toast('已解除绑定', 'ok')
      $('modal').classList.add('hidden')
      await loadStatus()
    } catch (error) { toast(error.message, 'error') }
  }

  function setMenuOpen(open) {
    state.menuOpen = Boolean(open)
    const menu = $('more-menu')
    const button = $('more-btn')
    menu.classList.toggle('hidden', !state.menuOpen)
    button.setAttribute('aria-expanded', String(state.menuOpen))
    if (state.menuOpen) {
      const first = menu.querySelector('.menu-item:not(:disabled)')
      if (first) first.focus()
    }
  }

  function setSyncOpen(open) {
    state.syncOpen = Boolean(open)
    const popover = $('sync-popover')
    const chip = $('sync-chip')
    popover.classList.toggle('hidden', !state.syncOpen)
    chip.setAttribute('aria-expanded', String(state.syncOpen))
    if (state.syncOpen) {
      renderSyncPopover()
      $('popover-close').focus()
    }
  }

  function closeOverlays() {
    if (state.menuOpen) setMenuOpen(false)
    if (state.syncOpen) setSyncOpen(false)
  }

  function bind() {
    $('project-select').addEventListener('change', async (event) => {
      state.projectId = event.target.value || null
      state.workspaceRoot = workspaceOf(state.projectId)?.localRoot || ''
      state.selection = null; state.detail = null
      $('detail-body').classList.add('hidden'); $('empty').classList.remove('hidden')
      renderTop(); renderSyncPanel()
      await loadGit()
      if (state.projectId && state.workspaceRoot) await loadTree(state.kind)
      else renderTreeView()
    })
    for (const button of document.querySelectorAll('#tabs .tab')) {
      button.addEventListener('click', async () => {
        const kind = button.dataset.kind
        if (kind === 'config') { await openConfig(); return }
        state.kind = kind
        state.selection = null; state.detail = null
        $('detail-body').classList.add('hidden'); $('empty').classList.remove('hidden')
        renderTop()
        await loadTree(kind)
      })
    }
    $('refresh-btn').addEventListener('click', refreshStatus)
    $('start-btn').addEventListener('click', startSession)
    $('sync-chip').addEventListener('click', (event) => {
      event.stopPropagation()
      setMenuOpen(false)
      setSyncOpen(!state.syncOpen)
    })
    $('more-btn').addEventListener('click', (event) => {
      event.stopPropagation()
      setSyncOpen(false)
      setMenuOpen(!state.menuOpen)
    })
    $('menu-pull').addEventListener('click', () => { closeOverlays(); pull() })
    $('menu-push').addEventListener('click', () => { closeOverlays(); pushPlan() })
    $('menu-git').addEventListener('click', () => {
      closeOverlays()
      if ($('menu-git').disabled) return toast($('menu-git').title || '本地检查点不可用', 'error')
      openGitModal()
    })
    $('menu-config').addEventListener('click', () => { closeOverlays(); openConfig() })
    $('popover-pull').addEventListener('click', () => { setSyncOpen(false); pull() })
    $('popover-push').addEventListener('click', () => { setSyncOpen(false); pushPlan() })
    $('popover-close').addEventListener('click', () => { setSyncOpen(false); $('sync-chip').focus() })
    document.addEventListener('click', (event) => {
      if (!event.target.closest('.menu-wrap')) setMenuOpen(false)
      if (!event.target.closest('#sync-chip') && !event.target.closest('#sync-popover')) setSyncOpen(false)
    })
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return
      const hadMenu = state.menuOpen
      const hadSync = state.syncOpen
      closeOverlays()
      if (hadMenu) $('more-btn').focus()
      else if (hadSync) $('sync-chip').focus()
    })
    $('search').addEventListener('input', (event) => { state.query = event.target.value.trim(); renderTreeView() })
    $('only-diff').addEventListener('click', () => {
      state.onlyDiff = !state.onlyDiff
      $('only-diff').setAttribute('aria-pressed', String(state.onlyDiff))
      renderTreeView()
    })
    $('modal-close').addEventListener('click', () => $('modal').classList.add('hidden'))
    $('modal').addEventListener('click', (event) => { if (event.target === $('modal')) $('modal').classList.add('hidden') })
  }

  bind()
  loadStatus().catch((error) => toast(error.message, 'error'))

  function refreshIfVisible() {
    if (document.visibilityState !== 'visible') return
    if (state.busy) return
    if (!$('modal').classList.contains('hidden')) return
    if (!state.projectId || !state.workspaceRoot) return
    if (state.events.pending.size > 0 || state.events.pendingRefresh) {
      void flushRefresh()
      return
    }
    loadTree(state.kind, { keepView: true, silent: true, force: true }).catch(() => {})
  }
  setInterval(refreshIfVisible, 60_000)
  window.addEventListener('focus', refreshIfVisible)
  window.addEventListener('pageshow', () => { ensureEvents(); refreshIfVisible() })
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshIfVisible()
  })
  window.addEventListener('beforeunload', disconnectEvents)
  window.addEventListener('pagehide', disconnectEvents)
})()
