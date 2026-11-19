/* 自动路由：在几个 OpenCode Go 账号之间挑一个，把它的 key 写进 OPENCODE_GO_AUTO 这个凭据 ref。
 *
 * 口径（用户 2026-11-19 定稿）：
 *   - 只看周额度与月额度，5 小时窗口不参与判断；
 *   - 排序不看开通时间，看「月额度重置日」——谁先重置就用谁（先重置 = 更快回血）；
 *   - 周额度到 99.9% 就换下一个；月额度到 100% 就停用到下个重置日；
 *   - 换 key 由宿主在这里做，模型路由那边下一次请求就解析到新 key，不需要重启。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 自动路由专用的凭据 ref，provider 配置里的 apiKeyEnv 指向它。 */
export const ROUTER_REF = 'OPENCODE_GO_AUTO'

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

/** 给一行加上判定：周/月百分比、重置时间、是否出局与原因。 */
export function evaluateRow(row) {
  const weekly = percent(row.usage?.weekly?.percent)
  const monthly = percent(row.usage?.monthly?.percent)
  const monthlyResetsAt = row.usage?.monthly?.resetsAt || null
  const weeklyResetsAt = row.usage?.weekly?.resetsAt || null

  let blocked = null
  let reason = ''
  if (row.error) {
    blocked = 'error'
    reason = '拉不到用量'
  } else if (monthly != null && monthly >= MONTHLY_LIMIT) {
    blocked = 'monthly'
    reason = '本月已用满'
  } else if (weekly != null && weekly >= WEEKLY_LIMIT) {
    blocked = 'weekly'
    reason = '本周用到 99.9%'
  }

  return { ...row, weekly, monthly, monthlyResetsAt, weeklyResetsAt, blocked, reason }
}

/** 能用的账号按「月重置日最早 → 周用量最低」排序。 */
export function rankRows(rows) {
  return rows
    .map(evaluateRow)
    .filter((row) => !row.blocked)
    .sort((a, b) => {
      const ta = timeOf(a.monthlyResetsAt) ?? Number.MAX_SAFE_INTEGER
      const tb = timeOf(b.monthlyResetsAt) ?? Number.MAX_SAFE_INTEGER
      if (ta !== tb) return ta - tb
      return (a.weekly ?? 0) - (b.weekly ?? 0)
    })
}

/**
 * 选当前该用哪个账号。
 * 当前账号还在额度内、且月重置日与第一名相同（同一天重置）时留用，避免来回跳。
 */
export function decide(rows, currentId) {
  const all = rows.map(evaluateRow)
  const queue = rankRows(all)
  if (!queue.length) {
    return { all, queue, active: null, reason: '所有账号本月都用满了' }
  }

  const first = queue[0]
  const current = currentId ? queue.find((row) => row.id === currentId) : null
  const sameReset = current && timeOf(current.monthlyResetsAt) === timeOf(first.monthlyResetsAt)
  const active = current && sameReset && (current.weekly ?? 0) <= (first.weekly ?? 0) ? current : first

  return {
    all,
    queue,
    active,
    reason: active === current && current !== first ? '同一天重置，继续用现在的' : '用月重置日最近的那个',
  }
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
  }
}

export function loadRouterState(home) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(home), 'utf8'))
    return {
      ...defaultState(),
      ...parsed,
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
  if (!active) return { next, switched: false }

  next.activeId = active.id
  next.activeLabel = active.label
  next.activeKeyTail = active.keyTail || ''
  next.activeReason = decision.reason

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
