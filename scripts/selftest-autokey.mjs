// 直接对 client.js 里的真实源码做断言：新键名 + 旧键迁移 + 显式 0 不被旧值复活。
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8')

const start = source.indexOf('    const AUTO_KEY')
const end = source.indexOf('    function autoNotice')
assert.ok(start > 0 && end > start, '没找到自动刷新键那段源码')

// 把真实源码原样取出来，配一个假 window 跑起来
const factory = new Function('window', `${source.slice(start, end)}\nreturn { readAutoMinutes, readAutoMinutesFrom, AUTO_KEY, LEGACY_AUTO_KEY }`)

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    dump: () => Object.fromEntries(map),
  }
}

const results = []
function check(name, fn) {
  try {
    fn()
    results.push(`PASS | ${name}`)
  } catch (error) {
    results.push(`FAIL | ${name} | ${error.message}`)
  }
}

check('键名都是新名字', () => {
  const api = factory({ localStorage: makeStorage() })
  assert.equal(api.AUTO_KEY, 'opencode-manage:auto-minutes')
  assert.equal(api.LEGACY_AUTO_KEY, 'dsh-opencode-usage:auto-minutes')
})

check('空存储返回 0', () => {
  const api = factory({ localStorage: makeStorage() })
  assert.equal(api.readAutoMinutes(), 0)
})

check('只有旧键时读到旧值', () => {
  const storage = makeStorage({ 'dsh-opencode-usage:auto-minutes': '30' })
  const api = factory({ localStorage: storage })
  assert.equal(api.readAutoMinutes(), 30)
})

check('旧值搬到新键、旧键删掉', () => {
  const storage = makeStorage({ 'dsh-opencode-usage:auto-minutes': '30' })
  const api = factory({ localStorage: storage })
  api.readAutoMinutes()
  assert.deepEqual(storage.dump(), { 'opencode-manage:auto-minutes': '30' })
})

check('新键已存在时不看旧键', () => {
  const storage = makeStorage({ 'opencode-manage:auto-minutes': '45', 'dsh-opencode-usage:auto-minutes': '30' })
  const api = factory({ localStorage: storage })
  assert.equal(api.readAutoMinutes(), 45)
})

check('显式设成 0 不会被旧键复活', () => {
  const storage = makeStorage({ 'opencode-manage:auto-minutes': '0', 'dsh-opencode-usage:auto-minutes': '30' })
  const api = factory({ localStorage: storage })
  assert.equal(api.readAutoMinutes(), 0)
  assert.equal(storage.dump()['dsh-opencode-usage:auto-minutes'], '30')
})

check('超大值夹到 1440', () => {
  const api = factory({ localStorage: makeStorage({ 'dsh-opencode-usage:auto-minutes': '9999' }) })
  assert.equal(api.readAutoMinutes(), 1440)
})

check('脏值当 0', () => {
  const api = factory({ localStorage: makeStorage({ 'opencode-manage:auto-minutes': 'abc' }) })
  assert.equal(api.readAutoMinutes(), 0)
})

check('存储抛错时退化成 0', () => {
  const api = factory({ localStorage: { getItem() { throw new Error('boom') } } })
  assert.equal(api.readAutoMinutes(), 0)
})

check('没有 localStorage 时退化成 0', () => {
  const api = factory({})
  assert.equal(api.readAutoMinutes(), 0)
})

const failed = results.filter((line) => line.startsWith('FAIL'))
results.forEach((line) => console.log(line))
console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
process.exit(failed.length ? 1 : 0)
