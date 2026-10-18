/**
 * 槽位注册守卫回归测试。
 *
 * 背景:0.2.1-rc.2 起 `settings.plugin.item` 已从上游彻底移除(运行时 bundle 与
 * npm 包双向确认),而 `SlotCore.register` 对**未声明**槽位是同步抛错:
 *   slot "settings.plugin.item" is not declared (a parent entry's children table must declare it)
 *
 * 旧实现把 `settings.plugins.tab` 与 `settings.plugin.item` 两个注册放进同一个
 * `slots.inject` 回调:回调只在**其中一个**槽位被声明时触发,于是 0.2.1 上
 * 「先注册 tab 成功、再注册 item 抛错」,而 `slots.inject` 的异常会被
 * `queueMicrotask(() => { throw failure })` 抛成页面级未捕获异常。
 *
 * 本测试用真实的 `@deepseek-ai/dsh-client-ui-slots` 的 `SlotCore` 固化这条边界:
 *  - 未声明槽位注册必须抛错(证明这不是假想问题);
 *  - 各自守卫后两边都安全。
 *
 * 运行:`npm test`(无需 build,直接对 node_modules 里的上游实现断言)。
 */
import assert from 'node:assert/strict'

/**
 * 上游槽位核心。它是本测试的被测对象(而不是本插件的代码),因此:
 *  - 首选已安装的 `@deepseek-ai/dsh-client-ui-slots`(devDependency,与 CI 一致);
 *  - 若该包缺席(例如只装了 `dependencies` 的精简环境),**跳过**而不是让整个
 *    `npm test` 失败——这条测试校验的是「上游 register 的行为 + 我们的守卫形状」,
 *    在没有上游实现时无从断言。
 */
let SlotCore
try {
  ;({ SlotCore } = await import('@deepseek-ai/dsh-client-ui-slots'))
} catch (error) {
  console.log(`slot-guard: SKIP (@deepseek-ai/dsh-client-ui-slots 不可用: ${error.message})`)
  process.exit(0)
}

/** 造一个只声明了 `settings.plugins.tab` 的父条目(模拟 0.2.1 宿主)。 */
function host021() {
  const core = new SlotCore()
  core.register(
    { name: 'root', children: { 'settings.plugins.tab': { kind: 'list', scope: 'root' } } },
    () => null,
  )
  return core
}

// s1. 未声明槽位上的注册确实抛错(上游行为基线,防止本测试前提失效)
{
  const core = host021()
  assert.throws(
    () => core.register({ name: 'settings.plugin.item', key: 'prompt-optimizer' }, () => null),
    /is not declared/,
    '未声明槽位必须抛错——若上游改成静默忽略,本测试需重新评估',
  )
  console.log('✓ s1 未声明槽位注册抛错(前提成立)')
}

// s2. 旧实现(共用回调)在 0.2.1 上会抛错
{
  const core = host021()
  let threw = null
  try {
    core.register({ name: 'settings.plugins.tab', id: 'prompt-optimizer', order: 30, label: () => 'x' }, () => null)
    core.register({ name: 'settings.plugin.item', key: 'prompt-optimizer' }, () => null)
  } catch (error) {
    threw = error
  }
  assert.ok(threw, '共用回调的旧写法必须在 0.2.1 上抛错')
  assert.match(threw.message, /settings\.plugin\.item.*is not declared/)
  console.log('✓ s2 旧共用回调写法在 0.2.1 上抛错')
}

// s3. 修复后(各自守卫)两个槽位都安全,且已声明的那个正常入账
{
  const core = host021()
  const result = {}
  if (core.specDynamic('settings.plugins.tab') !== undefined) {
    core.register({ name: 'settings.plugins.tab', id: 'prompt-optimizer', order: 30, label: () => 'x' }, () => null)
    result.tab = 'registered'
  } else result.tab = 'skipped'
  if (core.specDynamic('settings.plugin.item') !== undefined) {
    core.register({ name: 'settings.plugin.item', key: 'prompt-optimizer' }, () => null)
    result.item = 'registered'
  } else result.item = 'skipped'
  assert.deepEqual(result, { tab: 'registered', item: 'skipped' })
  assert.equal(core.entries('settings.plugins.tab').length, 1, 'tab 注册应入账')
  console.log('✓ s3 各自守卫后两槽位都安全')
}

// s4. 反向:0.1.x 宿主只声明 settings.plugin.item 时,tab 分支必须安全跳过
{
  const core = new SlotCore()
  core.register(
    { name: 'root', children: { 'settings.plugin.item': { kind: 'keyed', scope: 'root' } } },
    () => null,
  )
  const result = {}
  if (core.specDynamic('settings.plugins.tab') !== undefined) result.tab = 'registered'
  else result.tab = 'skipped'
  if (core.specDynamic('settings.plugin.item') !== undefined) {
    core.register({ name: 'settings.plugin.item', key: 'prompt-optimizer' }, () => null)
    result.item = 'registered'
  } else result.item = 'skipped'
  assert.deepEqual(result, { tab: 'skipped', item: 'registered' })
  console.log('✓ s4 0.1.x 宿主上 tab 分支安全跳过')
}

console.log('slot-guard: all passed')
