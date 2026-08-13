# dsh-companion

selfloom 陪伴内容层作为 DeepSeek Harness 插件的实现。核心替换:agent 循环、会话、搜索、技能注册表、shell、调度全部由 DSH 提供,本包只保留 selfloom 的内容层。

## 挂载

agent preset 里加一行(`memoriesDir` 指向你的陪伴记忆目录,相对路径按会话工作目录解析):

```yaml
- id: selfloom-companion
  name: dsh-companion
  config:
    memoriesDir: .selfloom/memories
```

## 贡献

| 贡献 | 说明 |
|---|---|
| `deployment:persona` 段(order 0) | SOUL.md + Hermes 记忆(USER.md/MEMORY.md)渲染成单文档,遮蔽部署默认人设;缓存 + 写入后即时刷新 + 60s 定时兜底(PromptSection.text 同步求值) |
| `update_memory` 工具 | § 条目 + 预算(1375/2200),语义移植自 selfloom `src/memory.ts` / `src/tools/update_memory.ts`,数据格式与 Rust v1 兼容 |
| `companion_status` 工具 | 记忆用量与人设文档状态(自检用) |

## 依赖

- `fs` / `tools` / `systemPrompt` / `timer`(DSH host 服务,inject)
- `@deepseek-ai/dsh-tools`(defineTool,peer)

## 已知限制

- 记忆文件跨会话共享,但当前每个会话的 store 实例各自读写同一批文件;若出现真正的跨会话消费者(如 QQ 通道插件读记忆),再提为 host 侧服务。
- 表情包发送、QQ 通道、cron.jsonl 全局调度尚未移植(DSH 侧用 `dsh-schedule` 覆盖提醒场景)。
