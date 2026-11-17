# Changelog

dsh-personalised 的版本记录。1.0.0 之前的版本历史见上游 https://github.com/Aik358/dsh-auto-memory/blob/main/CHANGELOG.md

## [1.0.0] - 2026-11-17

仓库从 dsh-auto-memory 的 fork 改为独立发布的个性化插件，记忆引擎沿用上游。

### 新增

- 自定义 system instructions：设置 → 个性化 → 指令。支持开关、前缀/后缀位置、是否下发给子代理，上限 20000 字符。内容不变时逐字节稳定，不破坏前缀缓存。
- 分层上下文：全局指令层、个人记忆层（按与最新消息的相关性取前 K 条）、项目记忆层（限本工作区）。旧 `MEMORY.md` 新增 `relevant` 注入模式（默认），`full` 保持旧行为。
- 画像库：九类结构化条目，存于 `~/.dsh/memory/personal/profile.json`，支持置顶、全局/工作区作用域、待确认条目。新增 `memory_profile` 工具。
- 子代理策略 `personalSubagentPolicy`：`instructions`（默认）、`none`、`all`。
- 记忆导入：复制导出提示词，粘贴外部平台返回的档案，用模型或本地解析，预览后勾选提交。每次提交前自动备份，保留最近 20 份，可一键撤销。
- 记忆导出：Markdown 或 JSON，可按全局或工作区范围导出。
- 设置页「个性化」，含指令、记忆、导入、导出、分层五个标签页和上下文预览。
- 可在页面内编辑 DSH 原生 `$DSH_HOME/AGENTS.md`，保存时带摘要校验，防止覆盖他人修改。
- 新增配置键：`customInstructionsEnabled`、`customInstructions`、`customInstructionsPosition`、`customInstructionsSubagents`、`personalInjectMode`、`personalTopK`、`personalBudgetChars`、`personalSubagentPolicy`、`userMemoryInjectMode`、`personalImportProvider`、`personalImportModel`、`personalImportTimeoutMs`。

### 变更

- 包更名为 `dsh-personalised`，仓库重新定位为 DeepSeek Harness 个性化插件。
- 适配 DSH `>=0.2.2-rc.3 <0.3.0`（rc3），客户端模块 id 改为 `dsh-personalised`，插件详情页对新旧包名都认领。
- 路由前缀 `/api/dsh-auto-memory`、配置文件 `dsh-auto-memory.json`、数据目录 `~/.dsh/memory/` 保持旧名，从 dsh-auto-memory 换装后数据直接可用。
- 文档精简：重写 README 与用户手册，删除上游的宣传页、调研稿、交接记录和内部运维文档。

### 工程

- 包管理与脚本统一用 vp，Node 要求 `>=24.9`。
- 提交信息由 commitlint 强制 Angular 规范，subject 必须含汉字。
- CI：push 到 main 时自动测试、发布到 npm（trusted publishing）、打 tag 并建 Release；每日同步上游，无法自动合并时开 issue。
