/* 自动路由：在几个 OpenCode Go 账号之间挑一个，把它的 key 写进 OPENCODE_GO_AUTO 这个凭据 ref。
 *
 * 口径（用户 2026-11-19 / 2026-11-23 定稿）：
 *   - 三个窗口都参与判断：5 小时、本周、本月；
 *   - 排序不看开通时间，看「月额度重置日」——谁先重置就用谁（先重置 = 更快回血）；
 *   - 5 小时或周额度到 99.9% 就换下一个；月额度到 100% 就停用到下个重置日；
 *   - 队列里第一个 chip 是「自动」（= 按上面规则自动挑），后面每个账号可直接点选；
 *   - 点选某个账号 = 钉住它，直到它月额度用满才回落自动；5 小时/周满只是让位，不算出局；
 *   - 换 key 由宿主在这里做，模型路由那边下一次请求就解析到新 key，不需要重启。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 自动路由专用的凭据 ref，provider 配置里的 apiKeyEnv 指向它。 */
export const ROUTER_REF = 'OPENCODE_GO_AUTO'

/** 5 小时窗口到多少就换号。 */
export const ROLLING_LIMIT = 99.9

/** 周额度到多少就换号。 */
export const WEEKLY_LIMIT = 99.9

/** 月额度到多少就停用到下个重置日。 */
export const MONTHLY_LIMIT = 100

/** 后台检查间隔：5 分钟。 */
export const TICK_MS = 5 * 60 * 1000

export function percent(value) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

export function timeOf(value) {
  const t = Date.parse(String(value || ''))
  return Number.isFinite(t) ? t : null
}

/** 给一行加上判定：5 小时/周/月百分比、重置时间、是否出局与原因。 */
export function evaluateRow(row) {
  const rolling = percent(row.usage?.rolling?.percent)
  const weekly = percent(row.usage?.weekly?.percent)
  const monthly = percent(row.usage?.monthly?.percent)
  const rollingResetsAt = row.usage?.rolling?.resetsAt || null
  const weeklyResetsAt = row.usage?.weekly?.resetsAt || null
  const monthlyResetsAt = row.usage?.monthly?.resetsAt || null

  let blocked = null
  let reason = ''
  if (row.error) {
    blocked = 'error'
    reason = '拉不到用量'
  } else if (monthly != null && monthly >= MONTHLY_LIMIT) {
    blocked = 'monthly'
    reason = '本月已用满'
  } else if (rolling != null && rolling >= ROLLING_LIMIT) {
    blocked = 'rolling'
    reason = '5 小时窗口用满'
  } else if (weekly != null && weekly >= WEEKLY_LIMIT) {
    blocked = 'weekly'
    reason = '本周用到 99.9%'
  }

  return {
    ...row,
    rolling,
    weekly,
    monthly,
    rollingResetsAt,
    weeklyResetsAt,
    monthlyResetsAt,
    blocked,
    reason,
  }
}

/** 全部账号按「月重置日最早 → 周用量 → 5 小时用量」排序（含月满的，只是它在队列里排最后）。 */
export function sortRows(rows) {
  return rows.map(evaluateRow).sort((a, b) => {
    const ta = timeOf(a.monthlyResetsAt) ?? Number.MAX_SAFE_INTEGER
    const tb = timeOf(b.monthlyResetsAt) ?? Number.MAX_SAFE_INTEGER
    if (ta !== tb) return ta - tb
    const wa = a.weekly ?? 0
    const wb = b.weekly ?? 0
    if (wa !== wb) return wa - wb
    return (a.rolling ?? 0) - (b.rolling ?? 0)
  })
}

/** 队列 = 队列顺序里还不到「月满」的号；月满的只作为停用项留在 all 里。 */
export function rankRows(rows) {
  return sortRows(rows).filter((row) => row.blocked !== 'monthly')
}

/**
 * 选当前该用哪个账号。
 *  - pinnedId（用户点选的账号）还在队列里就一直用它，哪怕它 5 小时/周已经满了——用户明说了算；
 *  - pinnedId 月满或账号没了：本轮回落自动，并记下 pinnedDropped 让调用方清标记；
 *  - 自动：取队列里第一个「5 小时、周、月都没满」的号；都满了就先取月重置最近的那个（等 5 小时回血后自然切回来）。
 */
export function decide(rows, currentId, pinnedId) {
  const all = sortRows(rows)
  const queue = all.filter((row) => row.blocked !== 'monthly')
  const usable = queue.filter((row) => !row.blocked)

  let pinnedDropped = null
  if (pinnedId) {
    const target = queue.find((row) => row.id === pinnedId)
    if (target) {
      return { all, queue, active: target, mode: 'pinned', reason: `指定用 ${target.label}`, pinnedDropped: null }
    }
    const gone = all.find((row) => row.id === pinnedId)
    pinnedDropped = { id: pinnedId, label: gone ? gone.label : '', reason: gone ? gone.reason : '账号已不存在' }
  }

  const active = usable[0] || queue[0] || null
  let reason = '自动：用月重置日最近的那个'
  if (active && active.blocked) reason = '自动：都到上限了，先占着月重置最近的'
  else if (active && currentId && active.id !== currentId) {
    const previous = queue.find((row) => row.id === currentId)
    if (previous && previous.blocked) reason = `自动：${previous.label} ${previous.reason}，换 ${active.label}`
  }

  return { all, queue, active, mode: 'auto', reason, pinnedDropped }
}

export function statePath(home) {
  return path.join(home, 'opencode-usage', 'router.json')
}

export function defaultState() {
  return {
    enabled: true,
    activeId: null,
    activeLabel: '',
    activeKeyTail: '',
    activeSince: null,
    lastSwitch: null,
    switches: [],
    checkedAt: null,
    mode: 'auto',
    pinnedId: null,
    pinnedLabel: '',
    pinnedSince: null,
  }
}

export function loadRouterState(home) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(home), 'utf8'))
    const base = defaultState()
    const pinnedId = parsed.pinnedId ?? parsed.manualId ?? null
    return {
      ...base,
      ...parsed,
      pinnedId,
      pinnedLabel: parsed.pinnedLabel ?? (pinnedId ? parsed.manualLabel || '' : ''),
      pinnedSince: parsed.pinnedSince ?? (pinnedId ? parsed.manualSince || null : null),
      mode: pinnedId ? 'pinned' : 'auto',
      switches: Array.isArray(parsed.switches) ? parsed.switches.slice(0, 20) : [],
    }
  } catch {
    return defaultState()
  }
}

export function saveRouterState(home, state) {
  const file = statePath(home)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 })
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* 非 POSIX 或权限不足时静默 */
  }
}

/** 把这一轮的判定写进状态；是否需要真的换 key 由 switched 表示。 */
export function nextState(state, decision, now = new Date().toISOString()) {
  const active = decision.active
  const next = { ...state, checkedAt: now }

  // 钉住的号失效了（月满/账号没了）：这一轮已回落自动，把标记清掉免得下一轮又试它
  if (decision.pinnedDropped) {
    next.pinnedId = null
    next.pinnedLabel = ''
    next.pinnedSince = null
    next.mode = 'auto'
    next.pinnedDropped = { at: now, ...decision.pinnedDropped }
  }

  if (!active) return { next, switched: false }

  next.activeId = active.id
  next.activeLabel = active.label
  next.activeKeyTail = active.keyTail || ''
  next.activeReason = decision.reason
  next.mode = decision.mode || (next.pinnedId ? 'pinned' : 'auto')

  if (state.activeId === active.id) return { next, switched: false }

  next.activeSince = now
  next.lastSwitch = {
    at: now,
    reason: decision.reason,
    from: state.activeId
      ? { id: state.activeId, label: state.activeLabel, keyTail: state.activeKeyTail }
      : null,
    to: { id: active.id, label: active.label, keyTail: active.keyTail || '' },
  }
  next.switches = [next.lastSwitch, ...(state.switches || [])].slice(0, 20)
  return { next, switched: true }
}
