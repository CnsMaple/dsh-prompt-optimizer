// 斜杠命令(/optimize、/optimize-undo)——从"客户端命令"这一层进,不碰 Host。
//
// 为什么放在客户端:DSH 把命令分两半——Host 侧命令(host command registry)只能
// 把结果回显到命令面板,**够不到浏览器里的输入框草稿**;而草稿归客户端
// (conversation input machine)所有。本插件的「替换输入框 / 撤回」本来就发生在
// 客户端(ResultDock 用 inputActions.setDraft),所以命令也必须注册在客户端,
// 才能做到"执行后直接把结果写回输入框"。
//
// 用的是 DSH 官方公开面:
//   ctx.commandUi.register({ name, label, available, ui: { kind: 'action', run } })
//   run(session) 收到本次调用的 ClientSessionContext(含 sessionId);
//   再经 ctx.conversation.input.for(ctx) 取回该会话的输入机器(InputHub),
//   读 state.draft、写 setDraft、并用 notify() 在输入框上方给提示。
//
// 命令是**无参数**的 action:消耗掉触发 token、不向模型提交任何内容
// (见 CommandUiSpec/ActionSpec 的说明)。因此草稿只可能是
// 「先写好的正文 + 一个 /optimize chip」,正文保持纯文本。
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { OptimizerController } from './controller.js'
import { translate } from './i18n.js'

/** 本插件注册的两个客户端命令名(不带前导斜杠)。 */
export const COMMAND_OPTIMIZE = 'optimize'
export const COMMAND_UNDO = 'optimize-undo'

/**
 * 草稿里去掉行首的命令 token,得到真正要优化的正文。
 *
 * action 命令被点选/回车时,DSH 会消费掉触发 token;但草稿里那份 token
 * 在部分宿主代际下仍可能以文本形式残留在开头(如 "/optimize\n正文")。
 * 这里做一次保守剥离:只剥**行首**那一个命令名,其余一律保持原样,
 * 避免误伤正文里正常出现的斜杠(路径、日期、代码片段)。
 *
 * @param draft - 当前草稿全文
 * @returns 去掉行首命令 token 与首尾空白后的正文
 */
export function stripLeadingCommand(draft: string): string {
  const trimmed = draft.replace(/^\s+/, '')
  const match = /^\/([A-Za-z][\w-]*)(?:\s+|$)/.exec(trimmed)
  if (!match) return trimmed.trim()
  // 只剥本插件的两个命令;别的命令(如 /goal)是用户的意图,原样保留交给
  // controller 的 splitCommandPrefix 处理(它会拆前缀并拼回)。
  if (match[1] !== COMMAND_OPTIMIZE && match[1] !== COMMAND_UNDO) return trimmed.trim()
  return trimmed.slice(match[0].length).trim()
}

/** 输入机器的最小依赖面(与 InputHub 的公开形状一致,不引入宿主实现类型)。 */
interface SessionInputLike {
  readonly state: { getSnapshot(): { draft?: unknown } }
  setDraft(text: string): void
  notify(level: 'info' | 'error', text: string): void
}

/** conversation 服务的最小依赖面。 */
interface ConversationLike {
  input: { for(actx: ClientContext): SessionInputLike }
}

/** commandUi 服务的最小依赖面(只用到 register)。 */
interface CommandUiLike {
  register(contribution: {
    name: string
    label?(): string
    description?(): string
    available(session: unknown): boolean
    ui: { kind: 'action'; run(session: { sessionId: string }): void }
  }): () => void
}

/**
 * 注册两个客户端斜杠命令。
 *
 * 两个命令都**复用** ✨ 按钮所走的 controller 路径(同一个 SSE 优化请求、
 * 同一个结果面板、同一份"已替换/撤回"状态),不是另起一套逻辑:
 *  - `/optimize`      —— 优化当前草稿并直接替换输入框(等同于按下按钮 + 点「替换」);
 *  - `/optimize-undo` —— 撤回上一次替换(等同于面板上的「撤回」)。
 *
 * @param ctx - 客户端根 ctx(用于取会话输入机器)
 * @param controller - 与按钮/面板共享的状态容器
 * @param getCommandUi - 惰性读取 `ctx.commandUi`(可选服务,旧宿主可能缺席)
 * @returns 清理函数(移除已注册命令);缺席命令服务时返回 no-op
 */
export function registerPromptCommands(
  ctx: ClientContext,
  controller: OptimizerController,
  getCommandUi: () => CommandUiLike | undefined,
): () => void {
  const commandUi = getCommandUi()
  if (!commandUi) {
    // 旧版宿主没有客户端命令服务:按钮与面板照常工作,只是没有斜杠命令。
    console.warn('[dsh-prompt-optimizer] 当前 dsh 版本没有客户端命令服务(commandUi),斜杠命令未注册')
    return () => {}
  }

  /**
   * 取本会话的输入机器。
   *
   * 注意 `InputHub.for(actx)` 要的是**会话作用域的 ctx**(它会用
   * `sessions.sessionOf(actx)` 反查会话,再校验 binding 是否仍被保留);命令的
   * run(session) 只给到 `{ sessionId }` 而不是 scope ctx,因此这里只能
   * 「尽力而为」:先用插件自己的 ctx 试一次。失败时返回原因字符串,交给调用方
   * 用 notify 告诉用户,而不是静默无反应(静默无反应正是要避免的体验)。
   */
  const resolveInput = (): { input?: SessionInputLike; reason?: string } => {
    const conversation = (ctx as unknown as { conversation?: ConversationLike }).conversation
    if (!conversation?.input?.for) {
      return { reason: translate('cmd.noInputService') }
    }
    try {
      return { input: conversation.input.for(ctx) }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      console.warn('[dsh-prompt-optimizer] 取会话输入机器失败:', message)
      return { reason: translate('cmd.noScope').replace('{error}', message) }
    }
  }

  const readDraft = (input: SessionInputLike): string => {
    try {
      const draft = input.state.getSnapshot().draft
      return typeof draft === 'string' ? draft : ''
    } catch {
      return ''
    }
  }

  /**
   * 兜底提示通道:拿不到输入机器时,输入框调不通,只能走面板。
   * controller.notify() 会把文案推给 ResultDock 渲染成一条提示条(见 controller/ResultDock)。
   */
  const notifyThroughController = (ctrl: OptimizerController, text: string): void => {
    if (!text) return
    ctrl.notify('error', text)
  }

  const disposers: (() => void)[] = []

  // ── /optimize ──────────────────────────────────────────────────────────────
  disposers.push(
    commandUi.register({
      name: COMMAND_OPTIMIZE,
      label: () => translate('cmd.optimize'),
      description: () => translate('cmd.optimizeDesc'),
      available: () => true,
      ui: {
        kind: 'action',
        run: (session) => {
          const resolved = resolveInput()
          const input = resolved.input
          if (!input) {
            // 拿不到输入机器必须让用户看见原因(不能静默无反应)。
            console.warn('[dsh-prompt-optimizer] /optimize 无法访问输入框:', resolved.reason)
            try {
              notifyThroughController(controller, resolved.reason ?? '')
            } catch {
              /* 兜底提示也失败时不打崩命令 */
            }
            return
          }
          console.info('[dsh-prompt-optimizer] /optimize 触发,session=%s', session?.sessionId)
          const state = controller.getSnapshot()
          if (state.status === 'loading') {
            input.notify('info', translate('cmd.busy'))
            return
          }
          const body = stripLeadingCommand(readDraft(input))
          if (!body) {
            // 空草稿不发请求:把命令词本身拿去优化只会得到垃圾输出。
            input.notify('info', translate('cmd.empty'))
            return
          }
          const sessionId = session?.sessionId
          if (!sessionId) {
            input.notify('error', translate('cmd.noSession'))
            return
          }
          // 记录触发前的草稿,作为「替换后撤回」的原始备份。
          const backup = readDraft(input)
          void controller
            .optimize(body, sessionId)
            .then((outcome) => {
              // outcome 为 undefined:空文本/并发中/命令只有前缀(controller 内部已提示)。
              if (!outcome?.optimized) return
              const prefix = outcome.prefix ? `${outcome.prefix} ` : ''
              const nextDraft = `${prefix}${outcome.optimized}`
              // 与面板「替换输入框」同一条记录路径:撤回依据 + 写回草稿。
              controller.markApplied({ backup, text: nextDraft })
              input.setDraft(nextDraft)
              input.notify('info', translate('cmd.applied'))
            })
            .catch((cause) => {
              const message = cause instanceof Error ? cause.message : String(cause)
              input.notify('error', translate('cmd.failed').replace('{error}', message))
            })
        },
      },
    }),
  )

  // ── /optimize-undo ─────────────────────────────────────────────────────────
  disposers.push(
    commandUi.register({
      name: COMMAND_UNDO,
      label: () => translate('cmd.undo'),
      description: () => translate('cmd.undoDesc'),
      available: () => true,
      ui: {
        kind: 'action',
        run: () => {
          const resolved = resolveInput()
          const input = resolved.input
          if (!input) {
            console.warn('[dsh-prompt-optimizer] /optimize-undo 无法访问输入框:', resolved.reason)
            try {
              notifyThroughController(controller, resolved.reason ?? '')
            } catch {
              /* 同上 */
            }
            return
          }
          const applied = controller.getSnapshot().applied
          if (!applied) {
            input.notify('info', translate('cmd.nothingToUndo'))
            return
          }
          // 与面板「撤回」一致:写回替换前的原文并清掉撤回记录。
          input.setDraft(applied.backup)
          controller.clearApplied()
          input.notify('info', translate('cmd.undone'))
        },
      },
    }),
  )

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* 卸载期宿主可能已先行销毁槽位/服务,忽略 */
      }
    }
  }
}
