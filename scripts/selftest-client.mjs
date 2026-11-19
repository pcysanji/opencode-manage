/**
 * 客户端半边自测：不打开浏览器，检查
 * 1. 模块能被 __ModuleLoader__ 装载、返回 { inject, apply }；
 * 2. 注册到 conversation.view 的参数正确（id / order / label）；
 * 3. 首屏能渲染出 HTML（无 JSX 语法错、无 React 用法错）。
 *
 *   node scripts/selftest-client.mjs
 */
import { createRequire } from 'node:module'
import path from 'node:path'

const PROFILE = 'D:/Users/Changye_Pan/Documents/.dsh/profiles/desktop/package.json'
const req = createRequire(PROFILE)

const React = req('react')
const { renderToStaticMarkup } = req('react-dom/server')

const appended = []
globalThis.window = { __ModuleLoader__: { load: (mod) => (globalThis.__captured = mod) } }
globalThis.document = {
  getElementById: (id) => (id === 'dsh-opencode-usage-style' ? (appended.length ? {} : null) : null),
  createElement: () => ({ id: '', textContent: '' }),
  head: { appendChild: (node) => appended.push(node) },
}

await import('../client.js')
const captured = globalThis.__captured
if (!captured) throw new Error('__ModuleLoader__.load 没被调用')
console.log('模块 id:', captured.id)

const mod = captured.factory((name) => {
  if (name === 'react') return React
  if (name === 'react-dom') return req('react-dom')
  return req(name)
})

if (!Array.isArray(mod.inject) || !mod.inject.includes('slots')) throw new Error('inject 里没有 slots')
if (typeof mod.apply !== 'function') throw new Error('没有 apply')

let registered = null
const ctx = {
  slots: {
    inject: (_slot, factory) => factory(),
    register: (options, component) => {
      registered = { options, component }
      return () => {}
    },
  },
}
mod.apply(ctx)

console.log('注册槽位:', registered.options.name, '| id:', registered.options.id, '| order:', registered.options.order, '| 标签:', registered.options.label())
console.log('样式注入:', appended.length ? `${appended[0].textContent.length} 字符` : '没注入')

const html = renderToStaticMarkup(React.createElement(registered.component))
console.log('首屏 HTML 长度:', html.length)
console.log('首屏是否显示标题:', html.includes('OpenCode Go 余额'))
console.log('首屏是否显示加载态:', html.includes('正在拉取'))

const tokens = [...new Set((appended[0]?.textContent || '').match(/--dsw-[a-z0-9-]+/g) || [])]
const hardcoded = [...new Set((appended[0]?.textContent || '').match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) || [])]
console.log('用到的主题令牌数:', tokens.length, '| 硬编码颜色:', hardcoded.length ? hardcoded.join(', ') : '无')
