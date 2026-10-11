# v0.5.0 — 长文本优化提速 + opencode 会话头兜底

本版针对两个实际使用反馈:①长草稿点击优化后等待过久(瓶颈在模型生成输出 token 的数量——默认完整模式每轮要生成「诊断分析 + 优化稿」两段);②opencode(`opencode-go`)模型偶发「缺少请求头」。兼容面与 v0.4.0 一致(同一份构建覆盖 dsh 0.1.0-rc.7 ~ 0.2.0 全线)。

## 主要变更

- **默认优化模式改为快速(仅优化稿)**:快速模式只生成优化结果、不再先生成一段诊断分析,输出 token 与等待时间约减半;想看五维诊断在设置卡切回「完整」。已显式保存过 `mode` 的旧设置不受影响。
- **完整模式输出顺序改为「先优化稿、后分析」**:最关心的交付物先流式到达,等待期即可复制取走,分析随后补上。解析层重写为**与标记顺序无关**的段落规则(段落 = 标记到下一个标记/首个 END),新旧两种输出顺序都能正确解析;END 之后的内容视为尾部杂音,不归属任何段落。
- **长度纪律收紧**:简单任务的优化稿目标从 800 字符内收紧到 **500 字符内**,并明确「优化稿就是提示词本身——不复述原稿、不加多余解释或前言」;保真自检仍优先于长度。
- **opencode 会话头兜底**:v0.4.0 的会话标注依赖客户端携带会话 id,个别宿主形态不向槽位组件投递 `sessionId` 时请求体缺失、opencode 依旧报「缺少请求头」。0.5.0 起 Host 侧兜底——客户端未携带(或为空白)时标注合成 id `prompt-optimizer-one-shot`,任何调用路径都满足 `x-opencode-session` 要求;客户端正常携带时仍用真实会话 id(会话级计量归属不变)。
- **修复流式预览的一处冻结丢失**:旧版缓冲压缩在 OPTIMIZED 确认后,后续帧会把已定格的分析段清空;现在冻结字段只在首次产出时采纳,且新增优化稿段冻结(新顺序下 ANALYSIS 确认即优化稿定格,缓冲收缩为分析段尾部窗口)。

## 验证

- `npm test` **74 例全绿**(smoke 30 + prompt 20 + controller 24;新增新输出顺序的完整/流式解析、两段式缓冲压缩、新顺序流式预览兜底、会话标注兜底、默认快速模式提示词等用例);`npm run typecheck` 零错误。
- 兼容性未变:v0.4.0 的实测矩阵继续有效(0.2.0-rc.2 Web + 官方桌面端、0.1.5-rc.2/0.1.5-rc.1、0.1.2 线、0.1.1-rc.2 及以下)。

## 升级注意

- **旧 profile 里装的插件(0.3.x 及更早)不含 opencode 修复**:`dsh plugin --profile <profile> list` 确认版本,升级到 0.5.0+ 后重启宿主/刷新页面。
- opencode 会话头注入依赖宿主 0.2.x 线的 pi-ai 适配器(按 `GenerateOptions.sessionId` 注入);0.1.x 宿主的 llm 服务不透传该字段,opencode-go 在其上仍不可用,属宿主限制。

## 安装

```sh
dsh plugin --profile web add @y1x1n/dsh-prompt-optimizer
```

或从 Release 下载 `y1x1n-dsh-prompt-optimizer-0.5.0.tgz` 后本地安装:

```sh
dsh plugin --profile web add ./y1x1n-dsh-prompt-optimizer-0.5.0.tgz
```

**官方桌面端**:完全退出应用,用应用自带 CLI 安装并重启(Windows 示例):

```sh
"E:\Deepseek-Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add @y1x1n/dsh-prompt-optimizer
```
