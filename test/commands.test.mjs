import assert from 'node:assert/strict'
import { stripLeadingCommand, COMMAND_OPTIMIZE, COMMAND_UNDO, registerPromptCommands } from '../lib/commands.js'

// ——— stripLeadingCommand:只剥行首的本插件命令,其余原样 ———
assert.equal(stripLeadingCommand('/optimize 帮我写个脚本'), '帮我写个脚本', 'E1 剥 /optimize + 空格')
assert.equal(stripLeadingCommand('/optimize\n帮我写个脚本'), '帮我写个脚本', 'E2 剥 /optimize + 换行')
assert.equal(stripLeadingCommand('  /optimize-undo  '), '', 'E3 命令后无正文 → 空')
assert.equal(stripLeadingCommand('帮我写个脚本'), '帮我写个脚本', 'E4 无命令原样')
assert.equal(stripLeadingCommand('/goal 帮我写个脚本'), '/goal 帮我写个脚本', 'E5 别的命令不剥(交给 splitCommandPrefix)')
assert.equal(stripLeadingCommand('/optimum 不是命令'), '/optimum 不是命令', 'E6 前缀相近的词不剥')
assert.equal(stripLeadingCommand('/path/to/file 处理'), '/path/to/file 处理', 'E7 路径不剥')
assert.equal(stripLeadingCommand(''), '', 'E8 空串')

// ——— registerPromptCommands:注册两个命令,行为正确 ———
function makeHarness(initDraft, applied) {
  const draft = { value: initDraft }
  const notices = []
  const sets = []
  const registered = new Map()
  const commandUi = {
    register(c) {
      assert.ok(!registered.has(c.name), `重复注册: ${c.name}`)
      registered.set(c.name, c)
      return () => registered.delete(c.name)
    },
  }
  const input = {
    state: { getSnapshot: () => ({ draft: draft.value }) },
    setDraft(text) { sets.push(text); draft.value = text },
    notify(level, text) { notices.push({ level, text }) },
  }
  const ctx = { conversation: { input: { for: () => input } } }
  const state = { status: 'idle', applied, notice: null }
  const controller = {
    getSnapshot: () => state,
    notify(level, text) { state.notice = { level, text } },
    async optimize(body, sessionId) {
      calls.push({ body, sessionId })
      return { optimized: '优化后的提示词', wellFormed: true }
    },
    markApplied(a) { state.applied = a },
    clearApplied() { state.applied = null },
  }
  const calls = []
  const dispose = registerPromptCommands(ctx, controller, () => commandUi)
  return { registered, draft, notices, sets, calls, state, dispose, input }
}

// R1:两个命令都注册,名字符合预期
{
  const h = makeHarness('帮我写个脚本', null)
  assert.deepEqual([...h.registered.keys()].sort(), [COMMAND_OPTIMIZE, COMMAND_UNDO].sort(), 'R1 命令名')
  assert.equal(h.registered.get(COMMAND_OPTIMIZE).ui.kind, 'action', 'R1b action 类型')
}

// R2:/optimize 跑完直接写回输入框,并记录撤回依据
{
  const h = makeHarness('/optimize 帮我写个脚本', null)
  await h.registered.get(COMMAND_OPTIMIZE).ui.run({ sessionId: 's1' })
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(h.calls.length, 1, 'R2 调了一次优化')
  assert.equal(h.calls[0].body, '帮我写个脚本', 'R2b 正文里已剥掉命令 token')
  assert.deepEqual(h.sets, ['优化后的提示词'], 'R2c 结果写回输入框')
  assert.equal(h.state.applied?.backup, '/optimize 帮我写个脚本', 'R2d 撤回备份 = 执行前草稿')
}

// R3:空草稿不调模型,只提示
{
  const h = makeHarness('   ', null)
  await h.registered.get(COMMAND_OPTIMIZE).ui.run({ sessionId: 's1' })
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(h.calls.length, 0, 'R3 空草稿不发请求')
  assert.equal(h.sets.length, 0, 'R3b 不写草稿')
  assert.equal(h.notices[0].level, 'info', 'R3c 给出提示')
}

// R4:斜杠命令前缀(/goal)保留并拼回
{
  const h = makeHarness('/goal 帮我写个脚本', null)
  const controller = h.state
  await h.registered.get(COMMAND_OPTIMIZE).ui.run({ sessionId: 's1' })
  await new Promise((r) => setTimeout(r, 0))
  // controller 的 splitCommandPrefix 会把 /goal 拆走;这里模拟 controller 返回带 prefix 的结果
  // (真实路径由 R5 覆盖)
  assert.equal(h.calls[0].body, '/goal 帮我写个脚本', 'R4 /goal 不被 stripLeadingCommand 剥')
}

// R5:controller 返回 prefix 时,写回草稿拼回前缀
{
  const h = makeHarness('/goal 帮我写个脚本', null)
  const original = h.calls
  const ctx = { conversation: { input: { for: () => ({ state: { getSnapshot: () => ({ draft: '/goal 帮我写个脚本' }) }, setDraft: (t) => h.sets.push(t), notify: () => {} }) } } }
  const controller = {
    notify() {},
    getSnapshot: () => ({ status: 'idle', applied: null }),
    async optimize() { return { optimized: '优化稿', prefix: '/goal', wellFormed: true } },
    markApplied() {}, clearApplied() {},
  }
  const reg = new Map()
  registerPromptCommands(ctx, controller, () => ({ register: (c) => { reg.set(c.name, c); return () => {} } }))
  await reg.get(COMMAND_OPTIMIZE).ui.run({ sessionId: 's1' })
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(h.sets, ['/goal 优化稿'], 'R5 前缀拼回')
}

// R6:/optimize-undo 恢复原文并清掉撤回记录
{
  const h = makeHarness('优化后的提示词', { backup: '原始草稿', text: '优化后的提示词' })
  h.registered.get(COMMAND_UNDO).ui.run({ sessionId: 's1' })
  assert.deepEqual(h.sets, ['原始草稿'], 'R6 恢复原文')
  assert.equal(h.state.applied, null, 'R6b 清掉撤回记录')
}

// R7:没有可撤回记录时只提示,不动草稿
{
  const h = makeHarness('当前草稿', null)
  h.registered.get(COMMAND_UNDO).ui.run({ sessionId: 's1' })
  assert.equal(h.sets.length, 0, 'R7 不写草稿')
  assert.equal(h.notices[0].level, 'info', 'R7b 给出提示')
}

// R8:优化中再执行 → 提示忙,不重复请求
{
  const h = makeHarness('草稿', null)
  h.state.status = 'loading'
  await h.registered.get(COMMAND_OPTIMIZE).ui.run({ sessionId: 's1' })
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(h.calls.length, 0, 'R8 忙时不发请求')
}

// R9:dispose 后命令被移除
{
  const h = makeHarness('草稿', null)
  h.dispose()
  assert.equal(h.registered.size, 0, 'R9 dispose 移除命令')
}

// R10:宿主没有 commandUi 时安静降级(不抛错)
{
  let threw = false
  try {
    const dispose = registerPromptCommands({ conversation: { input: { for: () => ({}) } } }, {}, () => undefined)
    dispose()
  } catch { threw = true }
  assert.equal(threw, false, 'R10 缺服务不抛错')
}

// R11:拿不到会话输入机器时,不能静默无反应 —— 必须经 controller.notify 给出原因
{
  const notices = []
  const reg = new Map()
  const controller = {
    notify: (level, text) => notices.push({ level, text }),
    getSnapshot: () => ({ status: 'idle', applied: null }),
    async optimize() { throw new Error('不该走到这里') },
    markApplied() {},
    clearApplied() {},
  }
  // InputHub.for 在非会话作用域 ctx 上会抛 "requires a retained Session scope"
  const ctx = { conversation: { input: { for: () => { throw new Error('conversation.input.for requires a retained Session scope') } } } }
  registerPromptCommands(ctx, controller, () => ({ register: (c) => { reg.set(c.name, c); return () => {} } }))
  await reg.get(COMMAND_OPTIMIZE).ui.run({ sessionId: 's1' })
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(notices.length, 1, 'R11 失败时有可见提示')
  assert.equal(notices[0].level, 'error', 'R11b 提示级别 error')
  assert.match(notices[0].text, /无法访问输入框|Cannot reach the composer/, 'R11c 提示说明原因')
}

// R12:完全没有 conversation 服务时同样给出提示
{
  const notices = []
  const reg = new Map()
  const controller = {
    notify: (level, text) => notices.push({ level, text }),
    getSnapshot: () => ({ status: 'idle', applied: null }),
    async optimize() {},
    markApplied() {},
    clearApplied() {},
  }
  registerPromptCommands({}, controller, () => ({ register: (c) => { reg.set(c.name, c); return () => {} } }))
  await reg.get(COMMAND_UNDO).ui.run({ sessionId: 's1' })
  assert.equal(notices.length, 1, 'R12 缺服务也有提示')
}

console.log('commands: all passed')
