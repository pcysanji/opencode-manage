/**
 * 自测：不启动 DSH，用假 ctx 驱动宿主半边的路由，验证
 * 「认账号 → 解析 key → 调 opencode 接口 → 出百分比」这条链路。
 *
 *   node scripts/selftest.mjs
 */
import { Readable } from 'node:stream'
import { apply } from '../index.js'

const routes = []
const ctx = {
  settings: { get: () => null },
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

apply(ctx)
if (!routes.length) throw new Error('没有注册任何路由')

const route = routes[0]

function makeReq(method, url, body) {
  const stream = Readable.from(body ? [Buffer.from(JSON.stringify(body), 'utf8')] : [])
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

const res = makeRes()
await route.handler(makeReq('POST', `${route.path}/usage`, {}), res)
const out = res.result()
console.log('status', out.status)
for (const account of out.payload?.accounts || []) {
  const usage = account.usage || {}
  const cell = (key) => (usage[key] ? `${usage[key].percent}% → ${usage[key].resetsAt}` : '—')
  console.log(
    [
      account.ok ? 'OK ' : 'ERR',
      account.source.padEnd(10),
      (account.label || '').padEnd(24),
      `…${account.keyTail}`,
      cell('rolling'),
      cell('weekly'),
      cell('monthly'),
      account.ok ? '' : `${account.error} ${account.message}`,
    ].join(' | '),
  )
}
