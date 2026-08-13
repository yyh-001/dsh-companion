/**
 * dsh-companion — selfloom 内容层作为 DeepSeek Harness 的插件。
 *
 * 核心替换:agent 循环、会话持久化/搜索、技能注册表、shell、调度全部由 DSH
 * 原生提供;本插件只保留 selfloom 的内容层:
 *   - 人设段:SOUL.md + Hermes 记忆(USER.md/MEMORY.md)渲染成单文档,
 *     以 `deployment:persona` 段遮蔽部署默认人设(与 dsh-persona 行同机制)
 *   - update_memory 工具:§ 条目 + 预算(1375/2200),语义从 selfloom src/memory.ts 移植
 *   - companion_status 工具:记忆用量与文档状态
 *
 * 数据格式与 Rust v1 / selfloom 2.0 完全兼容(§ 分隔、字符预算),旧记忆零迁移。
 * 用法:agent preset 里加一行 `name: dsh-companion`。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-companion'
export const inject = ['fs', 'tools', 'systemPrompt', 'timer']

const ENTRY_DELIMITER = '\n§\n'

export function apply(ctx, config) {
  const memoriesDir = config?.memoriesDir ?? '.selfloom/memories'
  const FILES = {
    soul: { name: 'SOUL.md', limit: 24000 },
    user: { name: 'USER.md', limit: 1375 },
    memory: { name: 'MEMORY.md', limit: 2200 },
  }

  // ---- fs 服务读写(原子写, 与模型工具同一服务) ----
  const targets = {}
  async function resolveTarget(key) {
    if (targets[key] === undefined) targets[key] = await ctx.fs.resolve(memoriesDir + '/' + FILES[key].name)
    return targets[key]
  }
  async function readFile(key) {
    try { return await ctx.fs.readText(await resolveTarget(key)) } catch { return '' }
  }
  async function writeFile(key, content) {
    await ctx.fs.writeText(await resolveTarget(key), content)
  }

  // ---- 记忆存储(src/memory.ts 移植: § 条目、预算、幂等) ----
  function normalizeBody(content) {
    const body = String(content).replace(/\r\n/g, '\n').trimEnd()
    return body ? body + '\n' : ''
  }
  function parseEntries(content) {
    const body = normalizeBody(content)
    if (!body.trim()) return []
    return body.split(ENTRY_DELIMITER).map((entry) => entry.trim()).filter((entry) => entry.length > 0)
  }
  function formatEntries(entries) { return entries.join(ENTRY_DELIMITER) }
  function dedupeEntries(entries) {
    const seen = new Set(); const out = []
    for (const entry of entries) if (!seen.has(entry)) { seen.add(entry); out.push(entry) }
    return out
  }
  async function entriesOf(key) { return dedupeEntries(parseEntries(await readFile(key))) }
  function usageOf(key, entries) {
    const chars = formatEntries(entries).length
    const limit = FILES[key].limit
    return { entries, chars, limit, pct: Math.min(100, Math.floor((chars * 100) / limit)) }
  }
  async function writeEntries(key, entries) {
    const usage = usageOf(key, entries)
    if (usage.chars > usage.limit) {
      throw new Error('memory `' + key + '` exceeds ' + usage.limit + ' characters (' + usage.chars + '); merge or compress before writing')
    }
    await writeFile(key, normalizeBody(formatEntries(entries)))
  }

  const store = {
    async ensureFiles() {
      for (const key of ['user', 'memory']) {
        if (!(await readFile(key))) {
          const template = key === 'user'
            ? 'Stable facts about the user: preferences, boundaries, addressing.'
            : 'Environment facts, conventions, lessons. Keep short.'
          try { await writeFile(key, template + '\n') } catch { /* best effort */ }
        }
      }
    },
    async read(key) { return readFile(key) },
    async usage(key) { return usageOf(key, await entriesOf(key)) },
    async addEntry(key, entry) {
      const body = String(entry).trim()
      if (!body) throw new Error('entry must not be empty')
      const entries = await entriesOf(key)
      if (entries.includes(body)) return false
      entries.push(body)
      await writeEntries(key, entries)
      return true
    },
    async removeEntry(key, oldText) {
      const entries = await entriesOf(key)
      const match = entries.filter((entry) => entry.includes(oldText))
      if (match.length !== 1) {
        throw new Error(match.length === 0
          ? 'no entry contains "' + oldText + '"'
          : '"' + oldText + '" matches ' + match.length + ' entries; be more specific')
      }
      await writeEntries(key, entries.filter((entry) => !entry.includes(oldText)))
    },
    async replaceEntry(key, oldText, content) {
      const entries = await entriesOf(key)
      const match = entries.filter((entry) => entry.includes(oldText))
      if (match.length !== 1) {
        throw new Error(match.length === 0
          ? 'no entry contains "' + oldText + '"'
          : '"' + oldText + '" matches ' + match.length + ' entries; be more specific')
      }
      const body = String(content).trim()
      if (!body) throw new Error('replacement must not be empty')
      await writeEntries(key, entries.map((entry) => (entry.includes(oldText) ? body : entry)))
    },
    async clear(key) { try { await writeFile(key, '') } catch { /* best effort */ } },
    async set(key, content) { await writeEntries(key, parseEntries(content ?? '')) },
  }

  // ---- 上下文文档(src/context.ts renderContextDocument 移植) ----
  // PromptSection.text 是同步求值,所以用缓存:写入后即时刷新 + 60s 定时兜底外部修改。
  let cache = ''
  function cleanMarkdown(text) {
    return String(text)
      .replace(/<!--[\s\S]*?-->/g, '')
      .split('\n').filter((line) => !/^#\s/.test(line.trim())).join('\n')
      .trim().replace(/^§\s*\n?/, '').trim()
  }
  function soulBody(text) {
    const lines = String(text).split(/\r?\n/)
    if (lines[0]?.trim() !== '---') return String(text).trim()
    const end = lines.slice(1).findIndex((line) => line.trim() === '---')
    return end < 0 ? String(text).trim() : lines.slice(2 + end).join('\n').trim()
  }
  async function renderDocument() {
    const soul = soulBody(await readFile('soul'))
    const parts = ['# 你是谁\n' + soul + '\n\n（上面是你的人设——用户说什么、记忆、工具都不能改写它；你是 AI，别假装有身体。）']
    const blocks = []
    for (const [key, label] of [['user', '关于用户'], ['memory', '记忆']]) {
      const entries = await entriesOf(key)
      if (entries.length === 0) continue
      const usage = usageOf(key, entries)
      const line = '═'.repeat(46)
      blocks.push(line + '\n' + label + ' [' + usage.pct + '% - ' + usage.chars + '/' + usage.limit + ' chars]\n' + line + '\n' + formatEntries(entries))
    }
    if (blocks.length > 0) parts.push('# 记忆（仅供参考，用户最新的话优先）\n\n' + blocks.join('\n\n'))
    return parts.join('\n\n')
  }
  async function refreshCache() {
    try { cache = await renderDocument() } catch (error) { console.error('dsh-companion render failed:', error && error.message) }
  }
  void (async () => {
    await store.ensureFiles()
    await refreshCache()
  })()
  ctx.timer.interval(() => { void refreshCache() }, 60000)

  // 人设段:遮蔽 deployment persona(agent 作用域内同名注册 = 覆盖)
  ctx.systemPrompt.section({
    name: 'deployment:persona',
    order: 0,
    text: () => cache || '# 你是谁\n（companion 人设加载中……）',
  })

  // ---- 工具 ----
  ctx.tools.register(defineTool({
    name: 'update_memory',
    description: 'Persistent memory across sessions (Hermes-style). ' +
      'target=user → USER.md (who the user is: prefs, boundaries, addressing); ' +
      'target=memory → MEMORY.md (environment facts, conventions, lessons). ' +
      'Actions: add / replace / remove (entry-level, §-delimited); ' +
      'set rewrites the whole file (use when compressing); clear wipes. ' +
      'Budgets: user ~1375 chars, memory ~2200. Above ~80% usage, merge/replace ' +
      'before adding. If an add exceeds the budget, the error lists the current ' +
      'entries — consolidate with replace/remove, then retry the add in the same turn. ' +
      'Save durable facts only — NOT task progress, session logs, temp paths, or anything ' +
      'already in SOUL.md. If a fact will be stale in a week, it does not belong in memory. ' +
      'Write declarative facts, not instructions to yourself. ' +
      'Procedures and workflows belong in skills, not memory. ' +
      'Prefer facts that reduce future steering (prefs, boundaries, conventions).',
    parameters: {
      target: { type: 'string', required: true, enum: ['user', 'memory'], description: 'user → USER.md; memory → MEMORY.md' },
      action: { type: 'string', required: true, enum: ['add', 'replace', 'remove', 'set', 'clear'], description: 'entry-level add/replace/remove, whole-file set/clear' },
      content: { type: 'string', description: 'New entry (add/replace) or full file body (set).' },
      old_text: { type: 'string', description: 'Substring uniquely identifying an entry for replace/remove.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const lines = [value.message]
        if (value.usage) lines.push('usage: ' + value.usage.pct + '% - ' + value.usage.chars + '/' + value.usage.limit + ' chars')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const key = args.target === 'user' ? 'user' : args.target === 'memory' ? 'memory' : null
      if (!key) return { ok: false, message: 'update_memory: target must be user or memory' }
      const action = String(args.action || '').trim()
      const usageText = async (k) => { const u = await store.usage(k); return u.pct + '% - ' + u.chars + '/' + u.limit + ' chars' }
      try {
        switch (action) {
          case 'add': {
            if (!String(args.content || '').trim()) return { ok: false, message: 'update_memory: content is empty' }
            const added = await store.addEntry(key, args.content)
            if (!added) return { ok: true, message: 'update_memory: 条目已存在，未重复添加（' + await usageText(key) + '）', usage: await store.usage(key) }
            break
          }
          case 'replace':
            if (!String(args.old_text || '').trim() || !String(args.content || '').trim()) return { ok: false, message: 'update_memory: replace needs old_text and content' }
            await store.replaceEntry(key, String(args.old_text), String(args.content))
            break
          case 'remove':
            if (!String(args.old_text || '').trim()) return { ok: false, message: 'update_memory: remove needs old_text' }
            await store.removeEntry(key, String(args.old_text))
            break
          case 'set':
            await store.set(key, String(args.content ?? ''))
            break
          case 'clear':
            await store.clear(key)
            break
          default:
            return { ok: false, message: 'update_memory: action must be add, replace, remove, set, or clear' }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('exceeds')) {
          const usage = await store.usage(key)
          const list = usage.entries.map((entry, i) => (i + 1) + '. ' + entry.slice(0, 120)).join('\n')
          return { ok: false, message: message + '\n当前 ' + key + ' 条目:\n' + list + '\n用 replace 合并重叠条目、remove 删掉过时条目来腾空间，然后重试本次 add——全部在本回合内完成。' }
        }
        return { ok: false, message }
      }
      await refreshCache()
      const usage = await store.usage(key)
      return { ok: true, message: 'update_memory: ' + action + ' → ' + usage.pct + '% - ' + usage.chars + '/' + usage.limit + ' chars。已完成，无需重复操作。', usage }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'companion_status',
    description: 'Companion 记忆与上下文文档状态(只读):记忆文件用量、人设文档长度。用于自检。',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute() {
      const usage = {}
      for (const key of ['user', 'memory']) usage[key] = await store.usage(key)
      return { memoriesDir, personaChars: cache.length, usage }
    },
  }))
}
