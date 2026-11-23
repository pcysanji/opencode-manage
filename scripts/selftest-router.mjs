/**
 * 自测：自动切号（不启动 DSH）
 *
 * 覆盖：
 *  1. 第一次检查会按"月重置日最早"选号，并把 key 写进 OPENCODE_GO_AUTO
 *  2. 同一个号还在队首时不动（不来回跳）
 *  3. 周额度到 99.9% 换下一个
 *  4. 月额度到 100% 停用；全停用时保持原号不动
 *  5. 关掉开关后不再换号
 *  6. 页面能拿到的 payload 里没有完整 key
 *
 *   node scripts/selftest-router.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ocu-router-'))
process.env.DSH_HOME = home

fs.writeFileSync(
  path.join(home, '.credentials.yaml'),
  [
    'version: 1',
    'refs:',
    "  OPENCODE_API_KEY: 'oc_sk_aaaa_0001'",
    "  OPENCODE_GO_API_KEY: 'oc_sk_bbbb_0002'",
    'records:',
    '',
  ].join('\n'),
  'utf8',
)

// ---- 上游用量：按 Bearer key 给不同数字 ----
const usage = {
  'oc_sk_aaaa_0001': { rolling: 1, weekly: 10, monthly: 40, monthlyReset: '2026-12-01T00:00:00.000Z' },
  'oc_sk_bbbb_0002': { rolling: 1, weekly: 10, monthly: 20, monthlyReset: '2026-11-25T00:00:00.000Z' },
}

const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const key = String(init?.headers?.authorization || '').replace(/^Bearer\s+/i, '')
  const row = usage[key]
  if (!row) return { ok: false, status: 401, json: async () => ({}) }
  return {
    ok: true,
    status: 200,
    json: async () => ({
      usage: {
        rolling: { status: 'ok', percent: row.rolling ?? 1, resetsAt: row.monthlyReset },
        weekly: { status: 'ok', percent: row.weekly, resetsAt: '2026-11-24T00:00:00.000Z' },
        monthly: { status: 'ok', percent: row.monthly, resetsAt: row.monthlyReset },
      },
    }),
  }
}

// ---- 假 ctx ----
const writes = []
const routes = []
const ctx = {
  settings: { get: () => null },
  credentials: {
    set: async (ref, value) => {
      writes.push([ref, value])
    },
  },
  timer: { interval: () => () => {}, timeout: () => () => {} },
  effect: (factory) => {
    factory()
  },
  webServer: {
    register: (route) => {
      routes.push(route)
      return () => {}
    },
  },
}

const { apply } = await import('../index.js')
apply(ctx)

const route = routes.find((entry) => entry.path === '/opencode-usage/api')
assert.ok(route, '没有注册 /opencode-usage/api 前缀路由')

function makeReq(method, url, body) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')])
  stream.method = method
  stream.url = url
  return stream
}

function makeRes() {
  const out = { status: 0, payload: null }
  return {
    headersSent: false,
    writeHead(status) {
      out.status = status
      this.headersSent = true
    },
    end(chunk) {
      out.payload = chunk ? JSON.parse(String(chunk)) : null
      return out
    },
    result: () => out,
  }
}

async function call(method, suffix, body) {
  const res = makeRes()
  await route.handler(makeReq(method, `${route.path}${suffix}`, body), res)
  const out = res.result()
  if (out.status !== 200) throw new Error(`${method} ${suffix} → ${out.status} ${JSON.stringify(out.payload)}`)
  return out.payload
}

const results = []
function check(name, fn) {
  try {
    fn()
    results.push([true, name])
  } catch (error) {
    results.push([false, `${name} → ${error.message}`])
  }
}

// 1. 第一次检查：月重置日最早的 OPENCODE_GO_API_KEY 应该被选中
let status = await call('POST', '/router/tick', {})
check('第一次选号=月重置日最早的账号', () => {
  assert.equal(status.activeId, 'ref:OPENCODE_GO_API_KEY')
  assert.equal(status.activeKeyTail, '0002')
  assert.equal(status.lastSwitch.to.keyTail, '0002')
})
check('换号写进 OPENCODE_GO_AUTO', () => {
  assert.deepEqual(writes.at(-1), ['OPENCODE_GO_AUTO', 'oc_sk_bbbb_0002'])
})

// 2. 再跑一次：队首没变，不应该再换
const beforeSwitches = status.switches.length
status = await call('POST', '/router/tick', {})
check('队首没变就不换号', () => {
  assert.equal(status.activeId, 'ref:OPENCODE_GO_API_KEY')
  assert.equal(status.switches.length, beforeSwitches)
})

// 3. 周额度到 99.9% → 换下一个
usage['oc_sk_bbbb_0002'].weekly = 99.9
status = await call('POST', '/router/tick', {})
check('周额度 99.9% 换到下一个', () => {
  assert.equal(status.activeId, 'ref:OPENCODE_API_KEY')
  assert.equal(status.activeKeyTail, '0001')
  assert.equal(writes.at(-1)[1], 'oc_sk_aaaa_0001')
})
check('队列里能用的排在出局的后面', () => {
  const index = status.lastCheck.rows.findIndex((row) => row.blocked)
  assert.ok(index > 0, '出局的号应该排在后面')
})

// 4. 两个号都月额度满 100% → 全部停用，保持原号不动
usage['oc_sk_bbbb_0002'].monthly = 100
usage['oc_sk_aaaa_0001'].monthly = 100
const blockedBefore = status.activeId
status = await call('POST', '/router/tick', {})
check('全停用时保持原号不动', () => {
  assert.equal(status.activeId, blockedBefore)
  assert.equal(status.lastCheck.rows.every((row) => row.blocked), true)
})
check('月额度 100% 的号被判为停用', () => {
  const row = status.lastCheck.rows.find((entry) => entry.id === 'ref:OPENCODE_GO_API_KEY')
  assert.equal(row.blocked, 'monthly')
})

// 5. 关掉开关：即使有更好的号也不换
usage['oc_sk_bbbb_0002'].monthly = 20
usage['oc_sk_bbbb_0002'].weekly = 10
usage['oc_sk_aaaa_0001'].monthly = 40
await call('POST', '/router/enabled', { enabled: false })
const quiet = await call('POST', '/router/tick', {})
check('关掉开关后不换号', () => {
  assert.equal(quiet.enabled, false)
  assert.equal(quiet.switched, false)
  assert.equal(quiet.activeId, blockedBefore)
})
await call('POST', '/router/enabled', { enabled: true })

// 6. 页面能拿到的数据里不能有完整 key
const router = await call('GET', '/router')
const accounts = await call('POST', '/usage', {})
check('GET /router 结构完整', () => {
  assert.equal(router.provider, 'opencode-go')
  assert.equal(router.ref, 'OPENCODE_GO_AUTO')
  assert.equal(router.tickMs, 300000)
  assert.ok(Array.isArray(router.switches))
})
check('payload 里没有完整 key', () => {
  const text = JSON.stringify({ router, accounts })
  assert.equal(text.includes('oc_sk_'), false, '泄露了完整 key')
})

// 7. 状态文件落盘
const stateFile = path.join(home, 'opencode-usage', 'router.json')
check('状态写进 router.json', () => {
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assert.ok(saved.checkedAt)
  assert.ok(['ref:OPENCODE_API_KEY', 'ref:OPENCODE_GO_API_KEY'].includes(saved.activeId))
})

// 8. 5 小时窗口到 99.9% 也要换号
usage['oc_sk_bbbb_0002'].rolling = 99.9
usage['oc_sk_aaaa_0001'].rolling = 1
status = await call('POST', '/router/tick', {})
check('5 小时窗口 99.9% 换到下一个', () => {
  assert.equal(status.activeId, 'ref:OPENCODE_API_KEY')
  const blocked = status.lastCheck.rows.find((row) => row.id === 'ref:OPENCODE_GO_API_KEY')
  assert.equal(blocked.blocked, 'rolling')
})
check('chip 带 5 小时用量', () => {
  const row = status.lastCheck.rows.find((entry) => entry.id === 'ref:OPENCODE_API_KEY')
  assert.equal(typeof row.rolling, 'number')
})

// 9. 手动指定：切到指定号，并且自动逻辑不抢
usage['oc_sk_bbbb_0002'].rolling = 1
usage['oc_sk_bbbb_0002'].weekly = 10
usage['oc_sk_bbbb_0002'].monthly = 20
usage['oc_sk_aaaa_0001'].monthly = 40
const picked = await call('POST', '/router/manual', { id: 'ref:OPENCODE_GO_API_KEY' })
check('手动切到指定账号', () => {
  assert.equal(picked.activeId, 'ref:OPENCODE_GO_API_KEY')
  assert.equal(picked.manualId, 'ref:OPENCODE_GO_API_KEY')
  assert.equal(writes.at(-1)[1], 'oc_sk_bbbb_0002')
})
const keep = await call('POST', '/router/tick', {})
check('手动期间自动不抢（即使另一个月重置更早）', () => {
  assert.equal(keep.activeId, 'ref:OPENCODE_GO_API_KEY')
  assert.equal(keep.manualId, 'ref:OPENCODE_GO_API_KEY')
})

// 10. 手动指定的号自己爆额度 → 退回自动并留痕
usage['oc_sk_bbbb_0002'].monthly = 100
const dropped = await call('POST', '/router/tick', {})
check('手动号爆额度后回到自动', () => {
  assert.equal(dropped.manualId, null)
  assert.equal(dropped.activeId, 'ref:OPENCODE_API_KEY')
  assert.ok(dropped.manualDropped && dropped.manualDropped.reason, '应留下失效原因')
})

// 11. 空 id = 交回自动
usage['oc_sk_bbbb_0002'].monthly = 20
const pick2 = await call('POST', '/router/manual', { id: 'ref:OPENCODE_GO_API_KEY' })
check('再手动指定一次', () => assert.equal(pick2.manualId, 'ref:OPENCODE_GO_API_KEY'))
const backAuto = await call('POST', '/router/manual', { id: '' })
check('传空 id 回到自动', () => {
  assert.equal(backAuto.manualId, null)
})

// 12. 指定不存在的账号 → 404
const res404 = await call('POST', '/router/manual', { id: 'ref:NOPE' }).catch((error) => error.message)
check('指定不存在的账号报错', () => {
  assert.ok(String(res404).includes('404'), String(res404))
})

globalThis.fetch = realFetch

const failed = results.filter(([ok]) => !ok)
for (const [ok, name] of results) console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}`)
console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
if (failed.length) process.exitCode = 1
