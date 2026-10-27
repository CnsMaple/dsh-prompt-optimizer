// 真实宿主形状下的加载验证:用本机 DSH 的 command 契约声明 + 假 ctx,
// 确认 lib/client.js 的 apply() 会注册 /optimize 与 /optimize-undo。
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const DSH = 'C:/Users/03520/AppData/Roaming/dsh-tauri/dependencies/dsh/node_modules/@deepseek-ai'
const registered = []

// 最小 DSH 客户端运行时桩:slots / connection / remote / locale / commandUi / conversation
const makeCtx = () => {
  const disposers = []
  const ctx = {
    inject(deps, fn) {
      // 只执行关心的服务:commandUi / conversation;其余(可选服务)一律不回调,
      // 从而模拟服务缺席的安全降级路径。
      const scopeCtx = {
        ...ctx,
        effect: (fn2) => { const d = fn2(); disposers.push(typeof d === 'function' ? d : () => {}) },
      }
      if (deps.includes('commandUi')) return fn(scopeCtx)
      return undefined
    },
    slots: {
      inject: () => {},
      register: () => () => {},
    },
    commandUi: {
      register(contribution) {
        registered.push(contribution)
        return () => {}
      },
      decorate: () => () => {},
      dismiss: () => {},
      popupFor: () => ({}),
    },
    conversation: { input: { for: () => ({ state: { getSnapshot: () => ({ draft: '' }) }, setDraft() {}, notify() {} }) } },
    effect: (fn) => { const d = fn(); disposers.push(typeof d === 'function' ? d : () => {}) },
  }
  return ctx
}

// lib/client.js 是 lazy-CJS factory 形态:注入 __ModuleLoader__ 再执行
let factory = null
globalThis.window = globalThis
globalThis.__ModuleLoader__ = { load: ({ id, factory: f }) => { factory = f } }
const code = readFileSync('lib/client.js', 'utf8')
// eslint-disable-next-line no-new-func
new Function('window', code)(globalThis)
if (!factory) throw new Error('client bundle 未调用 __ModuleLoader__.load')

// 外部模块:react 用真 react,其余 @deepseek-ai/* 用空桩(本测试只关心命令注册)
const require = createRequire(import.meta.url)
const realRequire = (id) => {
  if (id === 'react' || id === 'react-dom' || id.startsWith('react/')) return require(id)
  return new Proxy({}, { get: () => () => undefined })
}
const mod = factory(realRequire)
if (typeof mod.apply !== 'function') throw new Error('client bundle 没有导出 apply()')
mod.apply(makeCtx())

const names = registered.map((c) => c.name).sort()
console.log('注册到的命令:', names.join(', '))
if (!names.includes('optimize') || !names.includes('optimize-undo')) {
  throw new Error('缺少期望的命令: ' + names.join(','))
}
for (const c of registered) {
  if (c.ui.kind !== 'action') throw new Error(c.name + ' 不是 action 类型')
  if (typeof c.ui.run !== 'function') throw new Error(c.name + ' 缺少 run()')
  if (typeof c.available !== 'function') throw new Error(c.name + ' 缺少 available()')
}
console.log('client bundle: 命令注册验证通过')
