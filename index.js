/**
 * opencode-manage — 宿主半边。
 *
 * 只做三件事：
 * 1. 认账号：DSH 模型配置里 baseURL 指向 opencode.ai 的 provider + .credentials.yaml 里 OPENCODE* 的 key + 用户手填的账号；
 * 2. 代浏览器调 https://opencode.ai/zen/go/v1/usage（该接口不发 CORS 头，浏览器直连不通）；
 * 3. 只把百分比、重置时间、key 末 4 位交给标签页 —— 完整 key 不出宿主进程。
 *
 * 不做常驻轮询：标签页打开或点「刷新」时才发请求。
 */

import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  ROUTER_REF,
  TICK_MS,
  decide,
  loadRouterState,
  nextState,
  saveRouterState,
} from './router.js'

const HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
const DATA_DIR = path.join(HOME, 'opencode-usage')
const ACCOUNTS_PATH = path.join(DATA_DIR, 'accounts.json')
const CREDS_PATH = path.join(HOME, '.credentials.yaml')

const ROUTE = '/opencode-usage/api'
const UPSTREAM = [
  'https://opencode.ai/zen/go/v1/usage',
  'https://opencode.ai/inference/go/v1/usage',
]
const WINDOWS = ['rolling', 'weekly', 'monthly']

/** 自动路由对外暴露的 provider 名（写在 profile 的 cordis.patch.yml 里，挂在 llm-pi-ai 下）。 */
const ROUTER_PROVIDER = 'opencode-go'

/** 启动后先等一会儿再检查，避免和启动期抢资源。 */
const ROUTER_BOOT_MS = 15000

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function sendJson(res, status, payload) {
  if (res.headersSent) return
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

function keyTail(key) {
  if (typeof key !== 'string' || key.length < 4) return ''
  return key.slice(-4)
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('BODY_TOO_LARGE'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(new Error('BAD_JSON'))
      }
    })
    req.on('error', reject)
  })
}

/* ------------------------------------------------------------------ *
 * 账号来源
 * ------------------------------------------------------------------ */

/** .credentials.yaml 是扁平结构：refs: 下一层 `  NAME: value`，值可能带引号。 */
function readCredentialRefs() {
  let text = ''
  try {
    text = readFileSync(CREDS_PATH, 'utf8')
  } catch {
    return {}
  }
  const out = {}
  let inRefs = false
  for (const raw of text.split(/\r?\n/)) {
    if (/^refs:\s*$/.test(raw)) {
      inRefs = true
      continue
    }
    if (!inRefs) continue
    if (/^\S/.test(raw)) break
    const m = /^\s{2}([A-Za-z0-9_.-]+):\s*(.+?)\s*$/.exec(raw)
    if (!m) continue
    let value = m[2]
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1)
    }
    out[m[1]] = value
  }
  return out
}

function loadStore() {
  try {
    const doc = JSON.parse(readFileSync(ACCOUNTS_PATH, 'utf8'))
    if (Array.isArray(doc?.manual)) {
      return { manual: doc.manual, aliases: doc.aliases && typeof doc.aliases === 'object' ? doc.aliases : {} }
    }
  } catch {
    /* 首次运行或文件损坏都按空处理 */
  }
  return { manual: [], aliases: {} }
}

function saveStore(store) {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(ACCOUNTS_PATH, JSON.stringify(store, null, 2), 'utf8')
  try {
    chmodSync(ACCOUNTS_PATH, 0o600)
  } catch {
    /* Windows 上 chmod 只是尽力而为 */
  }
}

function providerConfigs(ctx) {
  // 真机上 settings 的文档键随 profile 走（entry id 可能是 llm-pi-ai / include:llm-pi-ai / 包名），逐个试。
  const keys = ['llm-pi-ai', 'include:llm-pi-ai', '@deepseek-ai/dsh-llm-pi-ai']
  for (const key of keys) {
    try {
      const doc = ctx.settings?.get?.(key)
      const providers = doc?.providers
      if (providers && typeof providers === 'object' && Object.keys(providers).length) return providers
    } catch {
      /* 换下一个候选键 */
    }
  }
  return {}
}

/** 合并三路来源，按 key 去重（同一个 key 配在多个 provider 上只算一个账号），返回列表（不含完整 key）。 */
function detectAccounts(ctx) {
  const refs = readCredentialRefs()
  const store = loadStore()
  // OPENCODE_GO_AUTO 是插件自己写进去的「当前在用」出口，不是用户账号。
  // 它和手填账号指向同一把 key，一旦参与按 key 去重就会把真账号吞掉 ——
  // 用户钉住的 id 下一轮就变成「已不存在」，于是又被自动切走。
  const skipRef = (ref) => ref === ROUTER_REF
  const accounts = []
  const byRef = new Set()
  const byKey = new Map()

  const push = (account, key) => {
    const existing = key ? byKey.get(key) : null
    if (existing) {
      if (!existing.labels.includes(account.label)) existing.labels.push(account.label)
      return
    }
    const entry = { ...account, labels: [account.label] }
    if (key) byKey.set(key, entry)
    accounts.push(entry)
  }

  const providers = providerConfigs(ctx)
  const nameByRef = new Map()
  for (const config of Object.values(providers)) {
    const baseURL = typeof config?.baseURL === 'string' ? config.baseURL : ''
    if (!/opencode\.ai/i.test(baseURL)) continue
    const ref = typeof config?.apiKeyEnv === 'string' ? config.apiKeyEnv : ''
    const name = typeof config?.displayName === 'string' ? config.displayName.trim() : ''
    if (ref && name && !skipRef(ref) && !nameByRef.has(ref)) nameByRef.set(ref, name)
  }

  for (const [providerId, config] of Object.entries(providers)) {
    const baseURL = typeof config?.baseURL === 'string' ? config.baseURL : ''
    if (!/opencode\.ai/i.test(baseURL)) continue
    const ref = typeof config?.apiKeyEnv === 'string' ? config.apiKeyEnv : ''
    if (!ref || skipRef(ref) || byRef.has(ref)) continue
    byRef.add(ref)
    push({
      // id 跟着 ref 走：名字只影响展示，别名与台账不会因为来源切换而失联。
      id: `ref:${ref}`,
      source: 'config',
      label: typeof config.displayName === 'string' && config.displayName ? config.displayName : providerId,
      ref,
      keyTail: keyTail(refs[ref]),
      hasKey: Boolean(refs[ref]),
    }, refs[ref] || '')
  }

  for (const [ref, value] of Object.entries(refs)) {
    if (!/opencode/i.test(ref)) continue
    if (skipRef(ref)) continue
    if (!/^oc_/.test(value)) continue
    if (byRef.has(ref)) continue
    byRef.add(ref)
    push({
      id: `ref:${ref}`,
      source: 'credential',
      label: nameByRef.get(ref) || ref,
      ref,
      keyTail: keyTail(value),
      hasKey: true,
    }, value)
  }

  for (const item of store.manual) {
    push({
      id: item.id,
      source: 'manual',
      label: item.label,
      ref: null,
      keyTail: keyTail(item.key),
      hasKey: Boolean(item.key),
      createdAt: item.createdAt,
    }, item.key || '')
  }

  return {
    accounts: accounts.map(({ labels, ...rest }) => {
      const autoLabel = labels.join(' / ')
      const alias = typeof store.aliases?.[rest.id] === 'string' ? store.aliases[rest.id] : ''
      return { ...rest, autoLabel, label: alias || autoLabel }
    }),
    refs,
    store,
  }
}

function keyOf(account, refs, store) {
  if (account.source === 'manual') {
    const item = store.manual.find((entry) => entry.id === account.id)
    return item?.key || ''
  }
  return refs[account.ref] || ''
}

/* ------------------------------------------------------------------ *
 * 上游接口
 * ------------------------------------------------------------------ */

function parseUsage(payload) {
  const usage = payload?.usage && typeof payload.usage === 'object' ? payload.usage : payload
  const out = {}
  for (const name of WINDOWS) {
    const window = usage?.[name]
    if (!window || typeof window !== 'object') continue
    const percent = Number(window.percent)
    out[name] = {
      percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null,
      status: typeof window.status === 'string' ? window.status : '',
      resetsAt: typeof window.resetsAt === 'string' ? window.resetsAt : '',
    }
  }
  return Object.keys(out).length ? out : null
}

async function fetchUsage(key) {
  if (!key) return { ok: false, error: 'NO_KEY', message: '没有可用的 API Key' }
  let lastError = null
  for (const endpoint of UPSTREAM) {
    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${key}`,
          'x-opencode-session': 'opencode-manage',
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(12000),
      })
      if (response.status === 401 || response.status === 403) {
        return { ok: false, error: 'KEY_REJECTED', message: `Key 被拒（HTTP ${response.status}）` }
      }
      if (!response.ok) {
        lastError = { ok: false, error: 'UPSTREAM_STATUS', message: `HTTP ${response.status}` }
        continue
      }
      const parsed = parseUsage(await response.json())
      if (!parsed) {
        lastError = { ok: false, error: 'BAD_SHAPE', message: '返回里没有 rolling/weekly/monthly' }
        continue
      }
      return { ok: true, usage: parsed }
    } catch (error) {
      const message = error?.name === 'TimeoutError' ? '请求超时' : String(error?.message || error)
      lastError = { ok: false, error: 'NETWORK', message }
    }
  }
  return lastError || { ok: false, error: 'UNKNOWN', message: '拿不到用量' }
}

/* ------------------------------------------------------------------ *
 * 自动路由
 * ------------------------------------------------------------------ */

function rowsForRouter(accounts, refs, store, results) {
  return accounts.map((account, index) => {
    const result = results[index]
    const key = keyOf(account, refs, store)
    return {
      id: account.id,
      label: account.label,
      keyTail: account.keyTail || keyTail(key),
      source: account.source,
      usage: result.ok ? result.usage : null,
      error: result.ok ? null : result.error || 'USAGE_FAILED',
      message: result.message || '',
    }
  })
}

function summarize(rows) {
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    keyTail: row.keyTail,
    rolling: row.rolling,
    weekly: row.weekly,
    monthly: row.monthly,
    rollingResetsAt: row.rollingResetsAt,
    monthlyResetsAt: row.monthlyResetsAt,
    blocked: row.blocked,
    reason: row.reason,
  }))
}

/**
 * 跑一轮自动路由：拉全部账号用量 → 选一个 → 需要时把它的 key 写进 OPENCODE_GO_AUTO。
 * force=true 时忽略「开关关掉」这个条件。
 */
async function routerRun(ctx) {
  const home = HOME
  const state = loadRouterState(home)
  const { accounts, refs, store } = detectAccounts(ctx)
  const results = await Promise.all(
    accounts.map((account) => fetchUsage(keyOf(account, refs, store))),
  )
  const rows = rowsForRouter(accounts, refs, store, results)
  const decision = decide(rows, state.activeId, state.pinnedId)
  // 开关关掉时只刷新数字，不换号：把"当前应该用谁"钉回正在用的那个
  const disabled = state.enabled === false
  const active = disabled
    ? decision.all.find((row) => row.id === state.activeId) || null
    : decision.active
  const { next, switched } = nextState(state, { ...decision, active })
  if (decision.mode === 'pinned' && active) {
    next.pinnedId = active.id
    next.pinnedLabel = active.label
    next.pinnedSince = state.pinnedId === active.id ? state.pinnedSince : new Date().toISOString()
    next.mode = 'pinned'
  }
  // 顺序：能用的按优先级排前面，出局的排后面，页面上的 1 / 2 / 3 就是使用顺序
  next.lastCheck = {
    at: next.checkedAt,
    rows: summarize([...decision.queue, ...decision.all.filter((row) => row.blocked)]),
  }

  let didSwitch = false
  let error = ''
  if (switched && decision.active) {
    const account = accounts.find((entry) => entry.id === decision.active.id)
    const key = keyOf(account, refs, store)
    try {
      if (!ctx.credentials?.set) throw new Error('宿主没有 credentials 服务')
      await ctx.credentials.set(ROUTER_REF, key)
      didSwitch = true
    } catch (failure) {
      error = String(failure?.message || failure)
      next.lastSwitch = null
      next.switches = state.switches || []
      next.activeId = state.activeId
      next.activeLabel = state.activeLabel
      next.activeKeyTail = state.activeKeyTail
      next.activeSince = state.activeSince
      next.lastError = { at: new Date().toISOString(), message: error }
    }
  }

  saveRouterState(home, next)
  return { state: next, rows: decision.all, decision, switched: didSwitch, error }
}

function routerPayload(state) {
  return {
    enabled: state.enabled !== false,
    provider: ROUTER_PROVIDER,
    ref: ROUTER_REF,
    tickMs: TICK_MS,
    activeId: state.activeId || null,
    activeLabel: state.activeLabel || '',
    activeKeyTail: state.activeKeyTail || '',
    activeSince: state.activeSince || null,
    activeReason: state.activeReason || '',
    checkedAt: state.checkedAt || null,
    lastSwitch: state.lastSwitch || null,
    switches: state.switches || [],
    lastCheck: state.lastCheck || null,
    lastError: state.lastError || null,
    mode: state.mode === 'pinned' ? 'pinned' : 'auto',
    pinnedId: state.pinnedId || null,
    pinnedLabel: state.pinnedLabel || '',
    pinnedSince: state.pinnedSince || null,
    pinnedDropped: state.pinnedDropped || null,
  }
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */

async function handleRequest(ctx, req, res) {
  const url = new URL(req.url || '/', 'http://localhost')
  const sub = url.pathname.slice(ROUTE.length) || '/'
  const method = (req.method || 'GET').toUpperCase()

  try {
    if (sub === '/router' && method === 'GET') {
      return sendJson(res, 200, routerPayload(loadRouterState(HOME)))
    }

    if (sub === '/router/tick' && method === 'POST') {
      const result = await routerRun(ctx)
      return sendJson(res, 200, {
        ...routerPayload(result.state),
        switched: result.switched,
        error: result.error || null,
        rows: summarize(result.decision ? result.decision.all : []),
      })
    }

    if (sub === '/router/enabled' && method === 'POST') {
      const body = await readJsonBody(req)
      const state = loadRouterState(HOME)
      state.enabled = body.enabled !== false
      saveRouterState(HOME, state)
      return sendJson(res, 200, routerPayload(state))
    }

    if ((sub === '/router/pick' || sub === '/router/manual') && method === 'POST') {
      const body = await readJsonBody(req)
      const id = typeof body.id === 'string' ? body.id : ''
      const state = loadRouterState(HOME)
      // 空 id = 选「自动」
      state.pinnedId = id || null
      state.pinnedLabel = ''
      state.pinnedSince = null
      state.pinnedDropped = null
      state.mode = id ? 'pinned' : 'auto'
      if (id) {
        const { accounts } = detectAccounts(ctx)
        const target = accounts.find((entry) => entry.id === id)
        if (!target) return sendJson(res, 404, { error: 'NOT_FOUND', message: '没有这个账号' })
        state.pinnedLabel = target.label
        state.pinnedSince = new Date().toISOString()
      }
      saveRouterState(HOME, state)
      const result = await routerRun(ctx)
      return sendJson(res, 200, {
        ...routerPayload(result.state),
        switched: result.switched,
        error: result.error || null,
        rows: summarize(result.decision ? result.decision.all : []),
      })
    }

    if (sub === '/accounts' && method === 'GET') {
      const { accounts } = detectAccounts(ctx)
      return sendJson(res, 200, { accounts })
    }

    if ((sub === '/usage' || sub === '/refresh') && method !== 'DELETE') {
      const { accounts, refs, store } = detectAccounts(ctx)
      const rows = await Promise.all(
        accounts.map(async (account) => {
          const result = await fetchUsage(keyOf(account, refs, store))
          return { ...account, ...result, fetchedAt: new Date().toISOString() }
        }),
      )
      return sendJson(res, 200, { accounts: rows, fetchedAt: new Date().toISOString() })
    }

    if (sub === '/accounts' && method === 'POST') {
      const body = await readJsonBody(req)
      const key = typeof body.key === 'string' ? body.key.trim() : ''
      const label = typeof body.label === 'string' ? body.label.trim() : ''
      if (!key) return sendJson(res, 400, { error: 'MISSING_KEY', message: '请填 API Key' })
      const store = loadStore()
      if (store.manual.some((entry) => entry.key === key)) {
        return sendJson(res, 409, { error: 'DUPLICATE', message: '这个 Key 已经加过了' })
      }
      const item = {
        id: `man:${randomUUID()}`,
        label: label || `OpenCode Go ${keyTail(key)}`,
        key,
        createdAt: new Date().toISOString(),
      }
      store.manual.push(item)
      saveStore(store)
      return sendJson(res, 200, { account: { ...item, key: undefined, keyTail: keyTail(key), source: 'manual', hasKey: true } })
    }

    if (sub === '/accounts/remove' && method === 'POST') {
      const body = await readJsonBody(req)
      const id = typeof body.id === 'string' ? body.id : ''
      const store = loadStore()
      const before = store.manual.length
      store.manual = store.manual.filter((entry) => entry.id !== id)
      if (store.manual.length === before) {
        return sendJson(res, 404, { error: 'NOT_FOUND', message: '手填账号里没有这一条' })
      }
      saveStore(store)
      return sendJson(res, 200, { ok: true })
    }

    if (sub === '/accounts/update' && method === 'POST') {
      const body = await readJsonBody(req)
      const id = typeof body.id === 'string' ? body.id : ''
      const hasLabel = typeof body.label === 'string'
      const label = hasLabel ? body.label.trim() : ''
      const key = typeof body.key === 'string' ? body.key.trim() : ''
      if (!id) return sendJson(res, 400, { error: 'MISSING_ID', message: '缺少账号 id' })

      const store = loadStore()
      const { accounts } = detectAccounts(ctx)
      const account = accounts.find((entry) => entry.id === id)
      if (!account) return sendJson(res, 404, { error: 'NOT_FOUND', message: '没有这个账号' })

      if (account.source === 'manual') {
        const item = store.manual.find((entry) => entry.id === id)
        if (!item) return sendJson(res, 404, { error: 'NOT_FOUND', message: '手填账号里没有这一条' })
        if (key) {
          if (store.manual.some((entry) => entry.id !== id && entry.key === key)) {
            return sendJson(res, 409, { error: 'DUPLICATE', message: '这个 Key 已经加过了' })
          }
          item.key = key
        }
        if (hasLabel) item.label = label || `OpenCode Go ${keyTail(item.key)}`
        saveStore(store)
        return sendJson(res, 200, { ok: true })
      }

      // DSH 配置 / 凭据库来的账号：名字存本页别名，key 写回 DSH 凭据（模型那边同时生效）
      if (hasLabel) {
        if (label) store.aliases[id] = label
        else delete store.aliases[id]
      }

      if (key) {
        if (!/^oc_/.test(key)) {
          return sendJson(res, 400, { error: 'BAD_KEY', message: 'OpenCode Go 的 key 是 oc_ 开头的' })
        }
        const service = ctx.credentials
        if (!service?.set) return sendJson(res, 503, { error: 'NO_CREDENTIALS', message: '宿主没有 credentials 服务' })
        let writable = true
        try {
          const info = await service.describe(account.ref)
          if (info && info.writable === false) writable = false
        } catch {
          /* describe 失败就交给 set 自己报错 */
        }
        if (!writable) {
          return sendJson(res, 409, { error: 'READ_ONLY', message: '这个 key 来自环境变量，写不进去' })
        }
        await service.set(account.ref, key)
      }

      saveStore(store)
      return sendJson(res, 200, { ok: true })
    }

    return sendJson(res, 404, { error: 'NOT_FOUND', message: `未知路由 ${sub}` })
  } catch (error) {
    const message = String(error?.message || error)
    const status = message === 'BAD_JSON' ? 400 : message === 'BODY_TOO_LARGE' ? 413 : 500
    return sendJson(res, status, { error: 'HANDLER_FAILED', message })
  }
}

export const inject = ['webServer', 'settings', 'credentials', 'timer']

export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler: (req, res) => handleRequest(ctx, req, res),
      }),
    'opencode-manage api',
  )

  const guard = (error) => console.warn('[opencode-usage] 自动路由检查失败：', error)

  ctx.effect(
    () => ctx.timer.interval(() => { routerRun(ctx).catch(guard) }, TICK_MS),
    'opencode-manage router interval',
  )

  ctx.effect(
    () => ctx.timer.timeout(() => { routerRun(ctx).catch(guard) }, ROUTER_BOOT_MS),
    'opencode-manage router boot',
  )
}
