/**
 * QQ 通道模块(dsh-companion 的一部分)。
 *
 * 桥接:QQ 官方 SDK 网关 ↔ DSH agent 会话。
 * 入站:QQ 消息 → createUserMessage → agent.send 进入当前陪伴会话(唤醒驱动);
 * 出站:监听 session/event 的 assistant/message → 表达层分块 → 回发 QQ。
 *
 * 单目标 MVP:selfloom 同款 lastChatTarget——所有入站记住目标,回复发回最近
 * 聊天的那个 QQ 会话(带 msg_id 引用回复)。多聊天并发是后续增强。
 *
 * 语义移植自 selfloom src/channels/qq.ts + src/expression.ts,分块规则不改模型文本。
 */
import { QQBot } from '@tencent-connect/qqbot-nodejs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** FNV-1a 64-bit as hex(selfloom 同款,事件 id 跨运行稳定)。 */
function shortId(value) {
  let hash = 0xcbf29ce484222325n
  for (let i = 0; i < value.length; i++) {
    hash ^= BigInt(value.charCodeAt(i))
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return 'qq:' + hash.toString(16).padStart(16, '0')
}

function toReplyTarget(target) {
  if (target.startsWith('user:')) return { scope: 'c2c', targetId: target.slice(5) }
  if (target.startsWith('group:')) return { scope: 'group', targetId: target.slice(6) }
  throw new Error('无法识别的目标 ' + target)
}

/** 句子切分(移植自 expression.ts):按行 + 按 。！？!?、连续省略号边界切。 */
function splitAtBoundaries(line) {
  const parts = []
  let start = 0
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (!'。！？!?'.includes(ch) && ch !== '…') continue
    if (ch === '…') {
      let j = i
      while (j + 1 < line.length && line[j + 1] === '…') j += 1
      i = j
    }
    const part = line.slice(start, i + 1).trim()
    if (part) parts.push(part)
    start = i + 1
  }
  if (start < line.length) {
    const tail = line.slice(start).trim()
    if (tail) parts.push(tail)
  }
  return parts
}

function splitSentences(text) {
  const byLine = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
  const segments = []
  for (const line of byLine) segments.push(...splitAtBoundaries(line))
  if (segments.length === 0) return [text]
  const merged = []
  for (const segment of segments) {
    if (merged.length > 0 && segment.length <= 2) merged[merged.length - 1] += segment
    else merged.push(segment)
  }
  return merged
}

/** 投递分块(移植自 channels/qq.ts):短闲聊按句拆气泡,长文保持完整,超长按段切。 */
export function channelTextChunks(text) {
  const trimmed = String(text).trim()
  if (!trimmed) return []
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
  const chars = [...trimmed].length
  const looksStructured =
    trimmed.includes('```') ||
    lines.some((line) => line.startsWith('#') || line.startsWith('|') || line.startsWith('- ') || line.startsWith('* ') || /^\d+\./.test(line))
  const casual = !looksStructured && chars <= 240 && lines.length <= 4
  let chunks
  if (casual) chunks = lines.flatMap((line) => splitSentences(line)).slice(0, 8)
  else if (chars <= 1600) chunks = [trimmed]
  else chunks = trimmed.split('\n\n').map((part) => part.trim()).filter((part) => part.length > 0)
  return chunks.slice(0, 8)
}

function textFromBlocks(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks.map((block) => (block && block.type === 'text' ? block.text : '')).join('').trim()
}

/**
 * 启动 QQ 通道。agent 缺失(如挂载验证场景)时跳过网关连接,只注册状态工具。
 * 返回 { isOnline }。生命周期挂在 ctx 上,插件卸载时自动断开。
 */
export function startQq(ctx, qqConfig) {
  const agents = ctx.get('agents')
  const agent = ctx.agent ?? (agents === undefined ? undefined : agents.currentInitiator())
  const appId = String(qqConfig.appId || '')
  const clientSecret = String(qqConfig.clientSecret || '')

  let bot = null
  let ready = false
  let stopped = false
  let lastChatTarget = ''
  const msgByEvent = new Map()

  // ---- 出站:assistant/message → 回发 QQ ----
  const offEvent = ctx.on('session/event', (session, event) => {
    if (stopped || event.type !== 'assistant/message') return
    const text = textFromBlocks(event.message && event.message.content)
    if (!text || !lastChatTarget) return
    void sendChunked(lastChatTarget, text)
  })

  // ---- 入站:QQ 消息 → agent.send ----
  async function handleMessage(msg) {
    if (msg.kind !== 'c2c' && msg.kind !== 'group') return
    const text = String(msg.content || '').trim()
    if (!text) return
    const eventId = shortId(msg.messageId)
    if (msgByEvent.size > 1000) msgByEvent.clear()
    msgByEvent.set(eventId, msg.messageId)
    const isGroup = msg.kind === 'group'
    const chatId = isGroup ? 'group:' + msg.replyTarget.targetId : 'user:' + msg.replyTarget.targetId
    lastChatTarget = chatId
    if (!agent) {
      console.warn('[dsh-companion] qq: no agent in scope, message dropped:', chatId)
      return
    }
    try {
      agent.send(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }), 'next-turn', true)
    } catch (error) {
      console.error('[dsh-companion] qq: agent.send failed:', error && error.message)
    }
  }

  async function sendText(target, text, replyEventId) {
    if (!bot || !ready) return
    const replyTarget = toReplyTarget(target)
    if (replyEventId) {
      const original = msgByEvent.get(replyEventId)
      if (original) replyTarget.msgId = original
    }
    await bot.sendText(replyTarget, text)
  }

  async function sendChunked(target, text, replyEventId) {
    const chunks = channelTextChunks(text)
    const list = chunks.length > 0 ? chunks : [text]
    for (const chunk of list) {
      try {
        await sendText(target, chunk, replyEventId)
      } catch (error) {
        console.error('[dsh-companion] qq: send failed:', error && error.message)
      }
    }
  }

  function isOnline() {
    return ready && !stopped && !!bot
  }

  // ---- 网关连接(agent 缺失时不连,避免验证挂载空转) ----
  if (agent && appId && clientSecret) {
    bot = new QQBot({ appId, appSecret: clientSecret })
    bot.on('ready', () => {
      ready = true
      console.log('[dsh-companion] QQ READY')
    })
    bot.on('error', (error) => {
      ready = false
      console.error('[dsh-companion] QQ error:', error && error.message)
    })
    bot.on('message', (_ctx, msg) => {
      void handleMessage(msg)
    })
    bot.start().then(() => {
      if (!stopped) console.log('[dsh-companion] QQ gateway started')
    }).catch((error) => {
      console.error('[dsh-companion] QQ gateway start failed:', error && error.message)
    })
  } else {
    console.log('[dsh-companion] qq: skipped gateway (agent=' + !!agent + ', appId=' + !!appId + ')')
  }

  // ---- 状态工具 ----
  ctx.tools.register(defineTool({
    name: 'qq_status',
    description: 'QQ 通道状态(只读):网关是否在线、最近聊天目标。自检用。',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: () => ({ online: isOnline(), ready, stopped, lastChatTarget: lastChatTarget || null, appId }),
  }))

  // ---- 生命周期:插件卸载时断开 ----
  ctx.on('dispose', () => {
    stopped = true
    ready = false
    try { offEvent() } catch { /* ignore */ }
    try { if (bot) bot.stop() } catch { /* ignore */ }
    bot = null
  })

  return { isOnline }
}
