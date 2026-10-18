# v0.6.0 适配代码审查(DSH 0.2.0-rc.2 → 0.2.1-rc.2)

审查对象:`@y1x1n/dsh-prompt-optimizer` 从 v0.5.0 到 v0.6.0 的适配改动。
审查基准:桌面端 `E:\DSH\resources\app.asar` 内随包发布的 **0.2.1-rc.2** 运行时 + npm 上 `@deepseek-ai/*@0.2.0-rc.2` / `@0.2.1-rc.2` 的 tarball。

## 结论:**通过(Approve)**

无阻塞问题。全部改动均以**上游真实产物**为依据,并有针对性回归测试。下面逐条记录验证过程与残余风险。

---

## 一、阻塞项:无

## 二、改动逐项审查

### 2.1 设置槽位注册拆分(`src/client/index.tsx`)

**改了什么**:`settings.plugins.tab`(0.2.x)与 `settings.plugin.item`(0.1.x)原先共用一个 `slots.inject` 回调、一个 `settingsDisposers` 数组;现拆成两个各自独立的 `slots.inject`。

**为什么必须改**(已核对上游源码,非推测):

| 事实 | 证据 |
|---|---|
| 0.2.1 全库不存在 `settings.plugin.item` | 对 `app.asar` 内全部 `.js` 检索 `plugin\.item` → 0 命中 |
| 未声明槽位注册同步抛错 | `dsh-client-ui-slots@0.2.1-rc.2` `lib/index.js:165`:`if (!rec?.spec) throw new Error(\`slot "..." is not declared ...\`)` |
| `slots.inject` 回调异常会升级为页面级未捕获错误 | `dsh-client-ui-renderer` `lib/client.js` `inject()`:`catch (error) { stop(); queueMicrotask(() => { throw failure }) }` |
| `slots.inject` 只在**该**槽位被声明时触发 | 同上,`reconcile()` 里 `const spec = this._core.specDynamic(key); if (spec === void 0) return` |

因此旧写法在 0.2.1 上的实际行为是:**回调被 tab 的声明触发 → 先注册 tab 成功 → 再注册 item → 抛错 → 微任务里再抛一次 → 页面级 uncaught**。设置页挂载路径被打断。

**双注册风险核对**:新版两个回调各自 `createSettingsCard(slotCtx, settings.face)`。检查 `createSettingsCard` 的副作用仅 `ensureStyles()`,而 `ensureStyles()` 以 `document.getElementById(STYLES_ID)` 幂等短路(`src/client/SettingsCard.tsx`)。即便某个宿主同时声明两个槽位,也只是两次幂等调用,不会重复插样式、不会重复订阅(订阅在组件内部 `useSyncExternalStore` 中)。**无泄漏、无双注册。**

**固化测试**:`test/slot-guard.test.mjs` 直接 import 上游真实 `SlotCore`:
- s1:未声明槽位注册必须抛错(前提护栏,防上游将来改静默);
- s2:旧共用回调写法在 0.2.1 形态上确实抛错;
- s3:拆分后 0.2.1 形态下 tab 入账、item 安全跳过;
- s4:反向(仅声明 item 的 0.1.x 形态)下 tab 分支安全跳过。

### 2.2 会话上下文改走事件窗口(`src/client/host-faces.ts` + `controller.ts` + `index.tsx`)

**改了什么**:新增 `sessionEventEntries()` 读 `ctx.sessions.binding(id).eventSource.getSnapshot().entries`;`controller` 的上下文分支改为「事件窗口 → legacy 查询面 → 无上下文」三级。

**为什么必须改**:`connection.api.sessions.history` 在 0.1.0-rc.7 → 0.2.1 全线**从未实现**,旧代码的 `legacyQueryFace(...)?.sessions?.history` 恒为 undefined,「携带上下文」一直是静默空转。

**为什么不用 `session/page`**(关键判断,已实证):
```
paginate(events, beforeSeq, maxMessages, throughSeq, turnWindow) {
  const end = SessionLogOffset(Math.min(throughSeq + 1, beforeSeq ?? throughSeq + 1));
  ...
  return { events: events.slice(cut, end), hasMore: cut > 0 };
}
```
`throughSeq = -1` → `end = min(0, 0) = 0` → `slice(0,0)` → **空页**。而正确的 `throughSeq` 只能从 follow 开场帧取得,冷调用拿不到。故该 RPC 不可用,判断正确。

**事件窗口确实含历史**:`Session.doOpen` 打开时 `this.eventSource.replace(visible, hasMore)`,其中 `visible` 来自尾部页(`HISTORY_PAGE_OPTIONS = { maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } }`);`loadOlder()` 再 `prepend`。窗口初始态为 `leaf([])` / `entries: []`,空数组判空正确,不会把"未打开"误判成"有上下文"。

**过期代际**:`retireScope()` 里 `if (this.scopes.get(id) === record) this.scopes.delete(id)` 先删表,`binding(id)` 立刻返回 `undefined`。**无读到旧代际的风险。**

**消息过滤正确性**(实测):
- `{type:'transient', event:{type:'assistant/live-chunk'}}` → `extractContextTurns` 只认 `user/message` / `assistant/message`,天然跳过 ✓
- `source.kind === 'runtime-context'`(agent 注入)→ 被 `!== 'user'` 过滤 ✓
- Web 端真实用户输入确为 `source.kind === 'user'`(`api-session-controller` 的 `prompt()` 把 `source` 原样交给 `createUserMessage`,`dsh-commands` 传 `{ kind: 'user' }`)✓

**体量上限**(实测 500 条满载窗口):`sampleContextTurns` 取最近 4 条 user + 4 条 assistant → `capConversationContext` 收敛 → 输出 **3 轮 / 1215 字符**,预算受控,无 token 爆炸。

**注入方式**:`ctx.inject(['sessions'], ...)` 独立可选 inject,与既有 `modelDirectories` / `configForms` 同一模式;不并入主 `inject: ['slots','connection','remote']`,因此 0.1.x 无此服务时**不会**阻塞客户端就绪。已确认 `ctx.sessions` 在 0.2.0 与 0.2.1 都由 `dsh-api-session-controller` 通过 `rootCtx.reflect.provide("sessions", this)` 提供。

### 2.3 设置卡文案(`i18n.ts` + `SettingsCard.tsx`)

`ConfigFormSnapshot` 在 0.2.1 删除了 `mode: 'host' | 'memory'` 及构造函数的 `persistence` 参数 —— 内存模式不存在。原 `settings.memoryOnly`(「内存模式:设置不会持久化」)语义已失效,改为 `settings.readOnly`(「宿主拒绝写入,改动不会保存」),绑定的仍是 `!writable` 条件,逻辑不变。

**全库核对**:`src/` 与 `test/` 中已无 `memoryOnly` / 「内存模式」残留(仅剩一条解释为何删除的注释)。

### 2.4 `package.json` 清单

```json
"engines": { "node": ">=18", "dsh": ">=0.1.0-rc.7 <0.3.0-0" },
"dsh": { "manifestVersion": 1, ... }
```

- `engines.dsh` 由 `dsh-app-boot` 的 `unmetRequirements()` 在启动期校验,用的是 `semver.satisfies(..., { includePrerelease: true })`;若声明了 `engines.dsh`,则**只看它**,不再看 `peerDependencies`。
- 区间实测(`includePrerelease: true`):

| 版本 | `>=0.1.0-rc.7 <0.3.0-0` |
|---|---|
| 0.1.0-rc.6 | false |
| 0.1.0-rc.7 | **true** |
| 0.1.2 / 0.1.5-rc.1 | true |
| 0.2.0-rc.1 / 0.2.0-rc.2 / 0.2.0 | true |
| **0.2.1-rc.2** / 0.2.1 / 0.2.2 | **true** |
| 0.3.0-rc.1 | **false** |
| 0.3.0 | false |

  尾界必须写 `<0.3.0-0`:写成 `<0.3.0` 会连 `0.3.0-rc.1` 一起放行。当前写法正确。
- `manifestVersion: 1` 与 `dsh-package-manifest@0.2.1` 的 `DshManifest.manifestVersion?: 1` 一致。
- **不构成向下阻塞**:0.1.x 宿主不读 `engines.dsh`(该字段是 0.2.1 才引入并强制的),因此老宿主行为不变。

### 2.5 类型基线与 `sync-types.mjs`

`devDependencies` 与 `sync-types` 的 19 个钉版本包统一升到 `0.2.1-rc.2`。本地原先残留的 13 个 `0.2.0-rc.2` 类型包也已实质替换,`tsc --noEmit` 在**全量 0.2.1 类型**下零错误 —— 这是"类型层面无破坏"的实证。

新增 `@deepseek-ai/dsh-client-ui-slots: 0.2.1-rc.2` 到 devDeps:它是 `test/slot-guard.test.mjs` 的被测对象。同时该测试做了**优雅降级**——包不可用时打印 `SKIP` 并以 0 退出,不会让精简环境的 `npm test` 假失败。

### 2.6 注释修正(`src/index.ts`)

`settings.configure({auto:false})` 原注释称"关闭宿主原生表单页"。核查 0.2.1:`autoGenerate` 只剩 schema 字段定义与 zod 描述,**没有任何客户端 UI 读取它**(对全部 `client.js` 检索 `autoGenerate`,仅 `dsh-api-remotes/lib/client.js` 的 schema 描述命中)。注释已改为如实描述"当前仅为显式意图声明"。

---

## 三、验证记录

| 项 | 命令 / 方法 | 结果 |
|---|---|---|
| 类型检查(0.2.1 全量类型) | `npm run typecheck` | 零错误 |
| 构建 | `npm run build` | 4 个产物生成 |
| Host 半测试 | `node test/smoke.mjs` | all passed |
| 提示词/解析测试 | `node test/prompt.test.mjs` | all passed |
| 客户端状态机测试(含新增 c25/c26) | `node test/controller.test.mjs` | all passed |
| 槽位守卫测试(新增) | `node test/slot-guard.test.mjs` | all passed |
| transient / runtime-context 过滤 | 直接调用 `extractContextTurns` | 仅输出真实 user/assistant |
| 500 条满载窗口体量 | 同上 | 3 轮 / 1215 字符 |
| 槽位抛错行为 | 真实 `SlotCore` | 旧写法抛错、新写法安全 |

---

## 四、非阻塞观察(不影响本次发布)

1. **上下文质量优于数量**:事件窗口最多可含 500 条,但采样后固定为 ≤8 轮。这是刻意的(优化是格式化元任务,过多上下文反而稀释),非缺陷。
2. **窗口只含"已装载"页**:若用户在极长会话里从未向上翻页,窗口仅有尾部页。对"最近 4 条用户输入"的目标已足够;若将来需要更早历史,可在点击时调用 `loadOlder()`(本次未做,避免改动用户可见的滚动位置)。
3. **`session/page` 的 `throughSeq` 语义**已写入 `host-faces.ts` 注释,避免后人"顺手改回 RPC"。
4. **`engines.dsh` 上界**:0.3.x 被拒。这是显式选择(0.3 未验证),而非疏漏;Release notes 已说明可用 `compatibility.json` 豁免。

---

## 五、已验证 vs 假设

**已对真实上游产物验证**:槽位声明与抛错行为、`slots.inject` 异常传播、`settings.plugins.tab` 存在性、`settings.plugin.item` 不存在、`ctx.sessions` 提供方与 `binding()` 形态、`eventSource` 初始态与填充时机、`retireScope` 的绑定失效、`paginate()` 空页行为、`source.kind` 取值、`ConfigFormSnapshot` 字段、`engines.dsh` 校验与 semver 区间、`autoGenerate` 无 UI 消费方、client baseline 静态模块表。

**未做**:在 0.2.1-rc.2 真实 GUI 里点通全流程(本机 `dsh web` 实例需要 launch token 才能进页面,无法自动化取得)。因此 UI 层结论来自代码路径推演 + 上游产物核对,而非像素级实测。这一点已在 Release notes 与 README 中如实标注为"对上游产物逐项核对",未夸大为"GUI 实测"。
