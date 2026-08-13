# dsh-companion

把 DeepSeek Harness 变成你的陪伴 Agent：人格（SOUL）+ 长期记忆（Hermes 风格）+ 技能目录，agent 核心（回合循环、会话、搜索、工具注册）全部由 DSH 提供。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

`dsh-companion` 是 [selfloom](https://github.com/yyh-001/selfloom)（单用户陪伴 agent 内核）的内容层移植：不再自带 agent 循环和会话存储，只保留"陪伴"真正需要的东西——**人设**、**记忆**、**工具**，以 Cordis 插件的形式挂进 DeepSeek Harness。

## 陪伴模式是什么

DeepSeek Harness 的每个 agent 由 **agent preset** 定义（工具、人设、技能）。`dsh-companion` 配套一个 `companion` preset（"陪伴模式"）：用 DSH 的会话启动一个陪伴型 agent，跟它聊天、让它记住你、随时间积累记忆——核心机制（长对话压缩、会话持久化、工具并行调度）由 DSH 原生提供，本插件只贡献内容层：

| 贡献 | 说明 |
|---|---|
| **人设段** `deployment:persona` | 把 `SOUL.md`（人格）+ `USER.md` / `MEMORY.md`（长期记忆）渲染成单文档，以同名段遮蔽部署默认人设；每次组装实时渲染，记忆写入后立即刷新，另有 60s 定时兜底外部修改 |
| **`update_memory` 工具** | 长期记忆的增删改查：`add` / `replace` / `remove`（§ 条目级）、`set` / `clear`（整文件）；带字符预算（USER 1375 / MEMORY 2200）与超预算合并引导 |
| **`companion_status` 工具** | 记忆用量与人设文档状态，自检用 |
| **QQ 通道**（可选） | `qq.enabled` 时连接 QQ 官方网关：QQ 消息经 `agent.send` 进入陪伴会话，agent 回复经表达层分块回发 QQ（带引用回复）；`qq_status` 工具查在线状态 |

人设段渲染出来的模型上下文长这样（节选）：

```markdown
# 你是谁
你叫 suki。跟对方聊天的损友，不是助手，不是客服，不是动漫角色。
…

# 记忆（仅供参考，用户最新的话优先）
══════════════════════════════════════════════════
关于用户 [12% - 165/1375 chars]
══════════════════════════════════════════════════
- 喜欢喝茶，不太喝咖啡
- 周末一般在家写代码
```

## 特性

- **单文档上下文**：人格 + 记忆 + 用量一屏读完，system prompt 前缀稳定（利于缓存）
- **数据零迁移**：`SOUL.md` / `USER.md` / `MEMORY.md` 格式与 selfloom（Rust v1 / TS 2.0）完全兼容，现有数据直接使用
- **记忆预算引导**：接近上限时工具返回当前条目清单，提示合并/清理后同回合重试
- **技能目录接入**：预设里配置 `customSkillDirs` 指向你的 `SKILL.md` 技能树，模型按需加载
- **零运行时依赖**：只用 DSH host 服务（`fs` / `tools` / `systemPrompt` / `timer`），peer 依赖 `@deepseek-ai/dsh-tools` / `@deepseek-ai/dsh-llm`；QQ 通道的第三方依赖只有官方 SDK `@tencent-connect/qqbot-nodejs`

## 快速开始

### 1. 安装插件

在 DSH profile 目录（如 `~/.dsh/profiles/web/`）安装：

```bash
pnpm add file:/path/to/dsh-companion
# 或从 GitHub:
pnpm add github:yyh-001/dsh-companion
```

### 2. 创建陪伴模式预设

在 `~/.dsh/.agent-presets/companion/` 下建 `agent.cordis.yml`。最简单的方式是从 DSH 的 `standard` 预设拷贝一份，然后：

1. **删掉** `persona` 行（`@deepseek-ai/dsh-persona`）——人设由本插件接管，同一作用域不能注册两个同名段；
2. **加入**本插件行：

```yaml
- id: selfloom-companion
  name: dsh-companion
  config:
    memoriesDir: .selfloom/memories   # 相对路径按会话工作目录解析，也可写绝对路径
    # 可选:QQ 通道——appId/secret 来自 QQ 开放平台(q.qq.com)机器人凭据
    qq:
      enabled: true
      appId: '1905247119'
      clientSecret: 'xxxxxxxxxxxxxxxx'
```

再补一个 `preset.yml`（显示名）：

```yaml
name: 陪伴模式
description: 陪伴 Agent——人设 + Hermes 长期记忆 + 技能目录，核心由 DeepSeek Harness 提供。
```

### 3. 启动会话

在 DSH Web 界面新建会话，选择「陪伴模式」。然后：

- 问它「你是谁」——看到的是 `SOUL.md` 里的人格；
- 说「记住我喜欢喝 XX」——模型会调 `update_memory` 写进 `USER.md`；
- 过一阵子再聊——记忆还在，跨会话、跨重启。

### 数据目录

`memoriesDir` 指向包含这三个文件的目录：

| 文件 | 内容 | 预算 |
|---|---|---|
| `SOUL.md` | 人格（YAML frontmatter：`revision` / `name` + Markdown 正文） | 24 000 chars |
| `USER.md` | 关于用户的事实（偏好、边界、称呼） | 1 375 chars |
| `MEMORY.md` | 环境事实、约定、经验教训 | 2 200 chars |

记忆文件用 `§` 分隔条目，整文件原子写（临时文件 + 替换）。

## 工作原理

- **人设注入**：`PromptSection.text` 是同步求值，所以插件维护一份渲染缓存——`update_memory` 写入后即时刷新，`timer` 每 60s 兜底刷新一次，外部改文件最多延迟一分钟生效；
- **记忆存储**：通过 DSH 的 `fs` 服务读写（与模型工具同一服务），原子写、预算强制、条目幂等（重复 add 不重写）；
- **人设遮蔽**：以 `deployment:persona` 为段名注册，与 `dsh-persona` 行同一机制——per-agent 作用域内同名即覆盖部署默认人设。

## 开发

```
plugin/dsh-companion/
├── index.js        # 插件本体:人设段 + 记忆工具 + QQ 挂载
├── qq.js           # QQ 通道模块:官方 SDK 网关 ↔ agent 会话桥接 + 分块投递
├── package.json    # name / inject / deps
├── README.md
└── LICENSE         # MIT
```

挂载验证（组合真实挂载，非静态检查）：

```bash
# 通过 roster 服务（临时探针插件调 agentPresets.standingKeyFor('companion')）
# 或直接在 DSH Web 新建「陪伴模式」会话，确认 update_memory 出现在工具列表
```

## 已知限制

- 记忆文件跨会话共享，当前每个会话的 store 实例各自读写同一批文件——单用户场景无问题；若出现真正的跨会话消费者（如其他插件读记忆），再提升为 host 侧服务；
- QQ 通道是单目标 MVP：所有入站记住最近聊天目标，回复发回该目标；多聊天并发分发是后续增强。扫码登录尚未移植（凭据直接配置即可用）；
- 表情包发送（meme 库 + 发图）尚未移植。提醒场景可用 DSH 原生 `@deepseek-ai/dsh-schedule` 覆盖。

## License

[MIT](LICENSE)
