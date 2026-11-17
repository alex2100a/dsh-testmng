/**
 * tmsync 宿主半：在 DSH Web Server 上注册工作台/API 路由，提供 ctx.tmsync 服务，
 * 并向 Agent 播报本地工作区入口。零生产依赖。
 */
import { readConfig, resolveDataDir } from '../server/config.js'
import { createTmsyncService } from '../server/service.js'
import { createApi } from '../server/routes.js'
import { classifyDshVersion, detectDshVersion } from '../server/compat.js'
import { VERSION } from '../server/version.js'

export const name = 'tmsync'
export const inject = ['webServer', 'systemPrompt']

const BASE = '/api/tmsync'
const ANNOUNCEMENT = `【tmsync 测试资产工作台（DSH 插件）】
本机安装了 tmsync：把测试管理平台的需求/用例/计划/缺陷/报告同步成本地工作区文件。
入口：GUI 侧边栏「测试资产」（主面板 iframe）；配置：平台地址/MCP/PAT。
对话在 DSH 原生会话中进行；使用「测试资产工作区」模式（preset id: tmsync）。
本地是工作副本，平台是上游：先 tmsync_status / tmsync_pull，再编辑文件；
tmsync_validate 校验；需求-用例链接用 tmsync_links（status/refresh/adopt）；
推送必须先生成计划并确认；链接删除需要 linksArmed，未启用时计划会列出 suppressedUnlinks。
不要编辑 .tmsync/；不要重命名/移动文件；报告只读；删除/归档/目录改名暂不支持。
配置存于 ~/.dsh/tmsync/config.json；PAT 不会进入工作区或日志。`

export function isLoopbackRequest(req) {
  const address = req.socket?.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = req.headers?.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostUrl.hostname)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

function deny(res) {
  res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ ok: false, error: { code: 'forbidden', message: 'loopback only' } }))
}

export function apply(ctx, config = {}) {
  const log = (message) => {
    const text = String(message).startsWith('[tmsync]') ? String(message) : `[tmsync] ${message}`
    try { ctx.logger?.info(text) } catch { /* ignore */ }
    console.log(text)
  }

  ctx.effect(async () => {
    const dataDir = resolveDataDir(process.env, config.dataDir)
    const dshVersion = detectDshVersion()
    const compatibility = classifyDshVersion(dshVersion)
    const startupConfig = await readConfig(dataDir, { log }).catch(() => null)
    if (compatibility.status === 'supported') log(`DSH ${compatibility.version}（已测试）`)
    else if (compatibility.status === 'untested') log(`DSH ${compatibility.version} 未在测试矩阵（${compatibility.range}；已测 ${compatibility.tested.join('/')}）`)
    else if (compatibility.status === 'incompatible') log(`警告：DSH ${compatibility.version} 超出支持范围 ${compatibility.range}`)
    else log('无法检测 DSH 版本；继续运行')
    const service = createTmsyncService({
      dataDir,
      log,
      dshVersion,
      cacheLimits: startupConfig?.workbench?.cache,
    })
    const disposeService = ctx.provide('tmsync', service)
    const api = createApi({ service, log })
    const routeDisposers = []
    const guarded = (req, res) => {
      if (!isLoopbackRequest(req)) return deny(res)
      return api.handle(req, res)
    }
    try {
      routeDisposers.push(ctx.webServer.register({ kind: 'exact', path: `${BASE}/info`, handler: guarded }))
      routeDisposers.push(ctx.webServer.register({ kind: 'prefix', path: `${BASE}/workbench`, handler: guarded }))
      routeDisposers.push(ctx.webServer.register({ kind: 'prefix', path: `${BASE}/api`, handler: guarded }))
    } catch (error) {
      log(`路由注册失败：${error?.message || error}`)
    }
    const announcement = compatibility.status === 'incompatible'
      ? `${ANNOUNCEMENT}\n注意：当前 DSH 版本 ${compatibility.version} 超出 tmsync 测试范围；如遇界面/同步异常，请先切换 DSH 版本。`
      : ANNOUNCEMENT
    const fileConfig = await service.getConfig().catch(() => null)
    const fileAnnounce = fileConfig !== null
      && fileConfig.configError === undefined
      && fileConfig.workbench?.announceToAgent !== false
    const announce = config.announceToAgent !== false && fileAnnounce
    if (!announce && config.announceToAgent !== false) log('播报已关闭（tmsync config.json 或配置损坏）')
    const disposeSection = announce
      ? ctx.systemPrompt.section({ name: 'plugin:tmsync', order: 216, text: announcement })
      : undefined
    log(`插件就绪：v${VERSION} · ${dataDir}`)
    return async () => {
      disposeSection?.()
      for (const dispose of routeDisposers.splice(0)) dispose()
      disposeService?.()
    }
  }, 'tmsync: workbench + routes')
}
