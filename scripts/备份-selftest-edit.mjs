/**
 * 自测 2：改名 / 换 key（/accounts/update）。用临时 DSH_HOME，不碰真实配置。
 *
 *   node scripts/selftest-edit.mjs
 */
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

const home = mkdtempSync(path.join(tmpdir(), 'dsh-ocu-test-'))
process.env.DSH_HOME = home
mkdirSync(home, { recursive: true })
writeFileSync(
  path.join(home, '.credentials.yaml'),
  ['version: 1', 'refs:', '  OPENCODE_TEST_KEY: oc_sk_original_0001', ''].join('\n'),
  'utf8',
)
mkdirSync(path.join(home, 'opencode-usage'), { recursive: true })
writeFileSync(path.join(home, 'opencode-usage', 'accounts.json'), JSON.stringify({ manual: [], aliases: {} }), 'utf8')

const { apply } = await import('../index.js')

const routes = []
const credentialWrites = []
const ctx = {
  settings: {
    get: () => ({
      providers: {
        'opencode-go-free': {
          displayName: 'OpenCode Go (Free)',
          baseURL: 'https://opencode.ai/inference/go/openai/v1',
          apiKeyEnv: 'OPENCODE_TEST_KEY',
        },
      },
    }),
  },
  credentials: {
    describe: async () => ({ configured: true, writable: true }),
    set: async (ref, value) => credentialWrites.push([ref, value]),
  },
  effect: (factory) => factory(),
  webServer: {
    register: (route) => {
      routes.push(route)
      return () => {}
    },
  },
}

apply(ctx)
const route = routes[0]

function call(method, sub, body) {
  const stream = Readable.from(body ? [Buffer.from(JSON.stringify(body), 'utf8')] : [])
  stream.method = method
  stream.url = `${route.path}${sub}`
  const out = { status: 0, payload: null }
  const res = {
    headersSent: false,
    writeHead(status) {
      out.status = status
      this.headersSent = true
    },
    end(chunk) {
      out.payload = chunk ? JSON.parse(String(chunk)) : null
    },
  }
  return route.handler(stream, res).then(() => out)
}

const checks = []
const check = (name, ok, detail) => checks.push({ name, ok, detail })

// 1. 手填新增
const added = await call('POST', '/accounts', { label: '临时账号', key: 'oc_sk_manual_0002' })
check('手填新增 200', added.status === 200, added.status)
const manualId = added.payload?.account?.id

// 2. 手填改名 + 换 key
const manualEdit = await call('POST', '/accounts/update', {
  id: manualId,
  label: '临时账号改名',
  key: 'oc_sk_manual_0003',
})
check('手填改名换 key 200', manualEdit.status === 200, manualEdit.status)

// 3. DSH 配置来的账号：改名（只存别名）
const configEdit = await call('POST', '/accounts/update', { id: 'cfg:opencode-go-free', label: 'Free 主号' })
check('配置账号改名 200', configEdit.status === 200, configEdit.status)

// 4. 配置账号换 key → 写回 DSH 凭据
const keyEdit = await call('POST', '/accounts/update', { id: 'cfg:opencode-go-free', key: 'oc_sk_replaced_0004' })
check('配置账号换 key 200', keyEdit.status === 200, keyEdit.status)
check(
  '凭据写回 ref 正确',
  credentialWrites.length === 1 && credentialWrites[0][0] === 'OPENCODE_TEST_KEY' && credentialWrites[0][1] === 'oc_sk_replaced_0004',
  credentialWrites,
)

// 5. 非法 key 被拒
const badKey = await call('POST', '/accounts/update', { id: 'cfg:opencode-go-free', key: 'nope' })
check('非法 key 400', badKey.status === 400, badKey.payload?.error)

// 6. 列表读回：别名生效、手填新 label 生效
const listed = await call('GET', '/accounts', null)
const byId = Object.fromEntries((listed.payload?.accounts || []).map((a) => [a.id, a]))
check('配置账号显示别名', byId['cfg:opencode-go-free']?.label === 'Free 主号', byId['cfg:opencode-go-free']?.label)
check('配置账号保留原名', byId['cfg:opencode-go-free']?.autoLabel === 'OpenCode Go (Free)', byId['cfg:opencode-go-free']?.autoLabel)
check('手填账号新名字', byId[manualId]?.label === '临时账号改名', byId[manualId]?.label)
check('手填账号新 key 末四位', byId[manualId]?.keyTail === '0003', byId[manualId]?.keyTail)

// 7. 磁盘上确实写了 aliases
const store = JSON.parse(readFileSync(path.join(home, 'opencode-usage', 'accounts.json'), 'utf8'))
check('aliases 落盘', store.aliases?.['cfg:opencode-go-free'] === 'Free 主号', store.aliases)

// 8. 清空别名 = 回到原名
await call('POST', '/accounts/update', { id: 'cfg:opencode-go-free', label: '' })
const listed2 = await call('GET', '/accounts', null)
const again = (listed2.payload?.accounts || []).find((a) => a.id === 'cfg:opencode-go-free')
check('清空别名回原名', again?.label === 'OpenCode Go (Free)', again?.label)

let failed = 0
for (const item of checks) {
  console.log(`${item.ok ? 'OK ' : 'FAIL'} | ${item.name} | ${JSON.stringify(item.detail) ?? ''}`)
  if (!item.ok) failed += 1
}
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
