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
 *  7. 5 小时满只是让位，恢复后回到月重置最早的号；点账号 = 钉住，月满才回落自动
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
  'oc_sk_cccc_0003': { rolling: 2, weekly: 12, monthly: 22, monthlyReset: '2026-11-27T00:00:00.000Z' },
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
check('队列按规则排序，满额的只在选择时跳过', () => {
  const blocked = status.lastCheck.rows.find((row) => row.blocked)
  assert.ok(blocked, '应该有一个满额被标记的号')
  assert.notEqual(status.activeId, blocked.id, '被跳过的号不能被选为当前')
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

// 9. 5 小时满只是让位：恢复后自动回到月重置最早的号
usage['oc_sk_aaaa_0001'] = { rolling: 1, weekly: 10, monthly: 40, monthlyReset: '2026-12-01T00:00:00.000Z' }
usage['oc_sk_bbbb_0002'] = { rolling: 1, weekly: 10, monthly: 20, monthlyReset: '2026-11-25T00:00:00.000Z' }
status = await call('POST', '/router/tick', {})
check('按规则选月重置最早的号（B）', () => {
  assert.equal(status.activeId, 'ref:OPENCODE_GO_API_KEY')
  assert.equal(status.mode, 'auto')
})

usage['oc_sk_bbbb_0002'].rolling = 99.9
status = await call('POST', '/router/tick', {})
check('5 小时满 → 暂时让位给下一个', () => {
  assert.equal(status.activeId, 'ref:OPENCODE_API_KEY')
  const row = status.lastCheck.rows.find((entry) => entry.id === 'ref:OPENCODE_GO_API_KEY')
  assert.equal(row.blocked, 'rolling')
  assert.equal(row.reason, '5 小时窗口用满')
})
check('让位的号仍排在队列里（不是停用）', () => {
  const ids = status.lastCheck.rows.map((row) => row.id)
  assert.ok(ids.includes('ref:OPENCODE_GO_API_KEY'))
})

usage['oc_sk_bbbb_0002'].rolling = 1
status = await call('POST', '/router/tick', {})
check('5 小时恢复后自动切回月重置最早的号', () => {
  assert.equal(status.activeId, 'ref:OPENCODE_GO_API_KEY')
  assert.equal(writes.at(-1)[1], 'oc_sk_bbbb_0002')
})

// 10. 点某个账号 = 钉住它，自动不抢
const picked = await call('POST', '/router/pick', { id: 'ref:OPENCODE_API_KEY' })
check('点账号切到它并进入 pinned', () => {
  assert.equal(picked.activeId, 'ref:OPENCODE_API_KEY')
  assert.equal(picked.mode, 'pinned')
  assert.equal(picked.pinnedId, 'ref:OPENCODE_API_KEY')
  assert.equal(writes.at(-1)[1], 'oc_sk_aaaa_0001')
})
const keep = await call('POST', '/router/tick', {})
check('钉住期间自动不抢（即使另一个月重置更早）', () => {
  assert.equal(keep.activeId, 'ref:OPENCODE_API_KEY')
  assert.equal(keep.mode, 'pinned')
})

usage['oc_sk_aaaa_0001'].rolling = 99.9
const pinnedBusy = await call('POST', '/router/tick', {})
check('钉住的号 5 小时满了也不自己换（用户明选）', () => {
  assert.equal(pinnedBusy.activeId, 'ref:OPENCODE_API_KEY')
  assert.equal(pinnedBusy.mode, 'pinned')
})
usage['oc_sk_aaaa_0001'].rolling = 1

// 11. 钉住的号月满 → 仍然钉住（用户说了：选了手动就别自动切，除非选自动）
usage['oc_sk_aaaa_0001'].monthly = 100
const full = await call('POST', '/router/tick', {})
check('钉住的号月满也不自动换', () => {
  assert.equal(full.mode, 'pinned')
  assert.equal(full.pinnedId, 'ref:OPENCODE_API_KEY')
  assert.equal(full.activeId, 'ref:OPENCODE_API_KEY')
  assert.equal(full.pinnedDropped, null)
  assert.ok(/额度已满/.test(full.activeReason || ''), '应说明额度已满')
})

// 12. 点「自动」= 交回自动
usage['oc_sk_aaaa_0001'].monthly = 40
const pick2 = await call('POST', '/router/pick', { id: 'ref:OPENCODE_API_KEY' })
check('再点一次账号', () => assert.equal(pick2.mode, 'pinned'))
const backAuto = await call('POST', '/router/pick', { id: '' })
check('点自动回到自动模式', () => {
  assert.equal(backAuto.mode, 'auto')
  assert.equal(backAuto.pinnedId, null)
})

// 13. 指定不存在的账号 → 404
const res404 = await call('POST', '/router/pick', { id: 'ref:NOPE' }).catch((error) => error.message)
check('指定不存在的账号报错', () => {
  assert.ok(String(res404).includes('404'), String(res404))
})

// 14. 自动出口（OPENCODE_GO_AUTO）与手填账号同 key 时，手填账号不能被吞掉
const credFile = path.join(home, '.credentials.yaml')
fs.writeFileSync(
  credFile,
  [
    'version: 1',
    'refs:',
    "  OPENCODE_API_KEY: 'oc_sk_aaaa_0001'",
    "  OPENCODE_GO_API_KEY: 'oc_sk_bbbb_0002'",
    "  OPENCODE_GO_AUTO: 'oc_sk_cccc_0003'",
    'records:',
    '',
  ].join('\n'),
  'utf8',
)

const manualId = 'man:test-shared-key'
const storeFile = path.join(home, 'opencode-usage', 'accounts.json')
fs.mkdirSync(path.dirname(storeFile), { recursive: true })
const store = fs.existsSync(storeFile)
  ? JSON.parse(fs.readFileSync(storeFile, 'utf8'))
  : { manual: [], aliases: {} }
store.manual = [
  ...(store.manual || []),
  { id: manualId, label: '手工同号', key: 'oc_sk_cccc_0003', createdAt: new Date().toISOString() },
]
fs.writeFileSync(storeFile, JSON.stringify(store, null, 2), 'utf8')

const shared = await call('POST', '/usage', {})
check('自动出口与手填同 key 时，手填账号仍在列表里', () => {
  const ids = shared.accounts.map((entry) => entry.id)
  assert.ok(ids.includes(manualId), `缺少 ${manualId}：${ids.join(',')}`)
  assert.equal(ids.includes('ref:OPENCODE_GO_AUTO'), false, '自动出口不该出现在账号列表里')
})
check('自动出口同 key 不会把手填账号改名', () => {
  const target = shared.accounts.find((entry) => entry.id === manualId)
  assert.equal(target.label, '手工同号')
})

const pinShared = await call('POST', '/router/pick', { id: manualId })
check('钉住手填账号后进入 pinned', () => {
  assert.equal(pinShared.mode, 'pinned')
  assert.equal(pinShared.pinnedId, manualId)
})
const keepShared = await call('POST', '/router/tick', {})
check('下一轮 tick 仍是 pinned，不再报"账号已不存在"', () => {
  assert.equal(keepShared.mode, 'pinned')
  assert.equal(keepShared.pinnedId, manualId)
  assert.equal(keepShared.pinnedDropped, null)
})

globalThis.fetch = realFetch

const failed = results.filter(([ok]) => !ok)
for (const [ok, name] of results) console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}`)
console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
if (failed.length) process.exitCode = 1
