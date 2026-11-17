/**
 * tmsync 客户端半：官方 Slots 入口 + 主面板 iframe。
 *
 * 手写 ModuleLoader 小壳（无构建）：只 require('react')，不打包 React。
 * 顶层只硬依赖 slots；locale/uiWorkspace/workspaces/layout 全部可选，
 * 缺失时面板仍可渲染（locale 用 key fallback）。
 */
window.__ModuleLoader__.load({
  id: 'tmsync',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var NS = 'tmsync'
    var WORKBENCH_URL = '/api/tmsync/workbench/'

    var DICT = {
      zh: { panel: '测试资产' },
      en: { panel: 'Test assets' },
    }

    function TmsyncIcon(props) {
      var size = props && Number.isFinite(props.size) ? props.size : 16
      return React.createElement('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        React.createElement('path', { d: 'M4 5.5h6l2 2h8v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z' }),
        React.createElement('path', { d: 'M8 13.5h8' }),
        React.createElement('path', { d: 'M8 16.5h5' })
      )
    }

    function apply(ctx) {
      try {
        ctx.effect(function () { return applyInner(ctx) }, 'tmsync: client entry')
      } catch (error) {
        console.error('[tmsync] 客户端初始化失败：', error)
      }
    }

    function applyInner(ctx) {
      var locale = ctx.get && ctx.get('locale')
      var localeOptions = locale === undefined || locale === null ? {} : { locale: NS }
      var t = locale === undefined || locale === null
        ? function (key) { return key }
        : locale.bind(NS)

      ctx.inject(['locale'], function (scope) {
        scope.effect(function () { return scope.locale.register(NS, DICT) }, 'tmsync: locale')
        t = scope.locale.bind(NS)
      })

      var uiWorkspace
      var workspaces
      var layout
      ctx.inject(['uiWorkspace'], function (scope) { uiWorkspace = scope.uiWorkspace })
      ctx.inject(['workspaces'], function (scope) { workspaces = scope.workspaces })
      ctx.inject(['layout'], function (scope) { layout = scope.layout })

      function serviceOf(name, current) {
        if (current) return current
        try { return ctx.get ? ctx.get(name) : undefined } catch { return undefined }
      }

      function reply(source, payload) {
        try { source && source.postMessage(payload, window.location.origin) } catch { /* ignore */ }
      }

      async function startSession(data, source) {
        var requestId = data && data.requestId
        try {
          var cwd = String(data && data.cwd || '')
          if (!cwd || cwd[0] !== '/' && !/^[A-Za-z]:[\\/]/.test(cwd)) throw new Error('工作区路径不是绝对路径')
          var workspaceService = serviceOf('workspaces', workspaces)
          var ui = serviceOf('uiWorkspace', uiWorkspace)
          if (!workspaceService || !ui) throw new Error('当前 DSH 版本不支持工作区 API；请升级 DSH 或手动打开会话。')
          var workspace = await workspaceService.create({ path: cwd })
          var sessionId = await ui.connectWorkspace(workspace.workspaceId, { agentPreset: 'tmsync' })
          ui.openSession(sessionId)
          reply(source, { type: 'tmsync:session-started', requestId: requestId, workspaceId: workspace.workspaceId, sessionId: sessionId })
        } catch (error) {
          reply(source, { type: 'tmsync:error', requestId: requestId, message: String(error && error.message || error) })
        }
      }

      async function pickDirectory(data, source) {
        var requestId = data && data.requestId
        try {
          var ui = serviceOf('uiWorkspace', uiWorkspace)
          if (!ui || typeof ui.pickDirectory !== 'function') throw new Error('当前 DSH 版本不支持目录选择；请手动输入路径或升级 DSH。')
          var picked = await ui.pickDirectory()
          reply(source, { type: 'tmsync:directory-picked', requestId: requestId, path: picked || null, canceled: !picked })
        } catch (error) {
          reply(source, { type: 'tmsync:error', requestId: requestId, message: String(error && error.message || error) })
        }
      }

      function TmsyncConfigCard(props) {
        var view = props && props.view
        var dataState = React.useState(null)
        var data = dataState[0]
        var setData = dataState[1]
        var busyState = React.useState(false)
        var busy = busyState[0]
        var setBusy = busyState[1]
        var errorState = React.useState('')
        var error = errorState[0]
        var setError = errorState[1]
        var refreshedState = React.useState('')
        var refreshed = refreshedState[0]
        var setRefreshed = refreshedState[1]

        function load() {
          fetch('/api/tmsync/api/overview', { cache: 'no-store' })
            .then(function (res) { return res.json() })
            .then(function (value) {
              if (value && value.ok === false) throw new Error((value.error && value.error.message) || '读取失败')
              setData(value)
              setError('')
              setRefreshed(new Date().toLocaleTimeString())
            })
            .catch(function (cause) { setError(String(cause && cause.message || cause)) })
        }

        React.useEffect(function () {
          load()
          function onFocus() { load() }
          window.addEventListener('focus', onFocus)
          return function () { window.removeEventListener('focus', onFocus) }
        }, [])

        function write(patch) {
          if (busy) return
          setBusy(true)
          fetch('/api/tmsync/api/config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
          })
            .then(function (res) { return res.json() })
            .then(function (value) {
              if (!value || value.ok === false) throw new Error((value && value.error && value.error.message) || '保存失败')
              load()
            })
            .catch(function (cause) { setError(String(cause && cause.message || cause)) })
            .finally(function () { setBusy(false) })
        }

        function openPanel() {
          var target = serviceOf('layout', layout)
          try {
            if (!target || typeof target.selectPanel !== 'function') throw new Error('当前 DSH 版本不支持打开面板')
            target.selectPanel('tmsync')
          } catch (cause) {
            setError(String(cause && cause.message || cause))
          }
        }

        if (view === 'summary') {
          return React.createElement('span', null, 'tmsync' + (data && data.info && data.info.version ? ' v' + data.info.version : ''))
        }

        var info = data && data.info || {}
        var config = data && data.config || {}
        var compat = info.compatibility || {}
        var workbench = config.workbench || {}
        var platform = config.platform || info.platform || {}
        var status = compat.status || 'unknown'
        var color = status === 'incompatible' ? 'var(--dsw-alias-label-danger, #a12626)'
          : status === 'untested' ? 'var(--dsw-alias-label-warning, #8a5a00)'
            : status === 'supported' ? 'var(--dsw-alias-label-success, #2f7d4f)'
              : 'var(--dsw-alias-label-secondary, #5b6478)'
        var label = status === 'incompatible' ? '不兼容' : status === 'untested' ? '未测试' : status === 'supported' ? '已测试' : '版本未知'
        var configError = data && data.configError

        return React.createElement('div', { style: { display: 'grid', gap: '10px', fontSize: '13px' } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
            React.createElement('strong', null, 'tmsync' + (info.version ? ' v' + info.version : '')),
            React.createElement('span', { style: { color: color, fontWeight: 600 } }, label),
            refreshed ? React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary, #5b6478)', fontSize: '11px' } }, '刷新 ' + refreshed) : null
          ),
          configError ? React.createElement('div', { style: { color: 'var(--dsw-alias-label-danger, #a12626)' } },
            String(configError.message || '配置错误') + (configError.hint ? '：' + configError.hint : '')) : null,
          React.createElement('div', { style: { color: 'var(--dsw-alias-label-secondary, #5b6478)' } }, compat.message || ''),
          React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '92px minmax(0,1fr)', gap: '4px 10px' } },
            React.createElement('span', null, 'DSH 版本'), React.createElement('span', null, compat.version || '未知'),
            React.createElement('span', null, '支持范围'), React.createElement('span', null, compat.range || '—'),
            React.createElement('span', null, '数据目录'), React.createElement('span', { style: { wordBreak: 'break-all' } }, info.dataDir || config.dataDir || '—'),
            React.createElement('span', null, '平台'), React.createElement('span', { style: { wordBreak: 'break-all' } }, (platform.mcpUrl || '未配置') + (platform.hasToken ? ' · PAT 已配置' : ' · PAT 未配置')),
            React.createElement('span', null, '项目/工作区'), React.createElement('span', null, String((data && data.counts && data.counts.projects) || 0) + ' / ' + String((data && data.counts && data.counts.workspaces) || 0)),
            React.createElement('span', null, '实时更新'), React.createElement('span', null, workbench.realtime === false ? '已关闭（只关 watcher）' : '开启'),
            React.createElement('span', null, 'Agent 播报'), React.createElement('span', null, workbench.announceToAgent === false ? '已关闭（重启后生效）' : '开启（重启后生效）')
          ),
          React.createElement('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
            React.createElement('button', { type: 'button', disabled: busy, onClick: function () { write({ workbench: { realtime: workbench.realtime === false } }) } }, workbench.realtime === false ? '开启实时更新' : '关闭实时更新'),
            React.createElement('button', { type: 'button', disabled: busy, onClick: function () { write({ workbench: { announceToAgent: workbench.announceToAgent === false } }) } }, workbench.announceToAgent === false ? '开启 Agent 播报' : '关闭 Agent 播报'),
            React.createElement('button', { type: 'button', onClick: openPanel }, '打开测试资产'),
            React.createElement('button', { type: 'button', onClick: load }, '刷新')
          ),
          error ? React.createElement('div', { style: { color: 'var(--dsw-alias-label-danger, #a12626)' } }, error) : null,
          React.createElement('div', { style: { color: 'var(--dsw-alias-label-secondary, #5b6478)', fontSize: '12px' } },
            '平台地址/PAT/工作区绑定请在工作台「测试资产」→「配置」中修改；PAT 不会写入 DSH profile。')
        )
      }

      function TmsyncPanel() {
        var frameRef = React.useRef(null)
        var compatState = React.useState(null)
        var compat = compatState[0]
        var setCompat = compatState[1]
        var closedState = React.useState(false)
        var closed = closedState[0]
        var setClosed = closedState[1]

        React.useEffect(function () {
          var alive = true
          var retry = null
          function load() {
            fetch('/api/tmsync/info', { cache: 'no-store' })
              .then(function (res) { return res.json() })
              .then(function (data) { if (alive) setCompat(data && data.compatibility || null) })
              .catch(function () { /* ignore */ })
          }
          load()
          retry = setTimeout(load, 1500)
          return function () { alive = false; if (retry) clearTimeout(retry) }
        }, [])

        React.useEffect(function () {
          function onMessage(event) {
            if (event.origin !== window.location.origin) return
            var frame = frameRef.current
            if (!frame || event.source !== frame.contentWindow) return
            var data = event.data
            if (!data || typeof data.type !== 'string') return
            if (data.type === 'tmsync:start-session') void startSession(data, event.source)
            else if (data.type === 'tmsync:pick-directory') void pickDirectory(data, event.source)
          }
          window.addEventListener('message', onMessage)
          return function () { window.removeEventListener('message', onMessage) }
        }, [])

        var banner = null
        if (compat && !closed && (compat.status === 'incompatible' || compat.status === 'untested')) {
          var danger = compat.status === 'incompatible'
          banner = React.createElement('div', {
            role: 'status',
            style: {
              display: 'flex',
              alignItems: 'flex-start',
              gap: '8px',
              padding: '6px 10px',
              fontSize: '12px',
              lineHeight: '1.45',
              color: danger ? 'var(--dsw-alias-label-danger, #a12626)' : 'var(--dsw-alias-label-warning, #8a5a00)',
              background: danger ? 'var(--dsw-alias-bg-danger-l1, #fdf0f0)' : 'var(--dsw-alias-bg-warning-l1, #fff8ec)',
              borderBottom: '1px solid var(--dsw-alias-border-l2, #e4e9f2)',
              flex: 'none',
            },
          },
            React.createElement('span', { style: { flex: '1', minWidth: 0 } }, compat.message),
            React.createElement('button', {
              type: 'button',
              'aria-label': '关闭兼容提示',
              onClick: function () { setClosed(true) },
              style: { border: 0, background: 'transparent', cursor: 'pointer', color: 'inherit', fontSize: '14px', lineHeight: '1' },
            }, '×')
          )
        }

        return React.createElement('div', {
          style: { height: '100%', minHeight: 0, width: '100%', display: 'flex', flexDirection: 'column', background: 'var(--dsw-alias-bg-base, #fff)' },
        }, banner, React.createElement('iframe', {
          ref: frameRef,
          src: WORKBENCH_URL,
          title: 'tmsync 测试资产工作台',
          style: { border: 0, width: '100%', flex: '1', minHeight: 0, display: 'block' },
        }))
      }

      var disposeMain = ctx.slots.inject('main', function () {
        return ctx.slots.register(Object.assign({ name: 'main', key: 'tmsync' }, localeOptions), TmsyncPanel)
      })
      var disposeIcon = ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register(Object.assign({
          name: 'sidebar.panellist',
          id: 'tmsync',
          order: 20,
          label: function () { return t('panel') },
        }, localeOptions), TmsyncIcon)
      })
      var disposeCard = ctx.slots.inject('plugins.bundle.config', function () {
        return ctx.slots.register(Object.assign({
          name: 'plugins.bundle.config',
          key: 'tmsync',
        }, localeOptions), TmsyncConfigCard)
      })
      return function () {
        disposeCard && disposeCard()
        disposeIcon && disposeIcon()
        disposeMain && disposeMain()
      }
    }

    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
