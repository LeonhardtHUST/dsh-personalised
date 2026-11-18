# dsh-personalised

[English](README.md) · 中文

DeepSeek Harness（DSH）的个性化插件。你写一次指令、导入一次记忆，之后每个会话都按你的习惯工作。

插件把「AI 应该怎么对待你」拆成几个维度，各管各的：

| 维度 | 说明 |
|---|---|
| 指令 | 自定义 system instructions，全局生效，内容不变时逐字节稳定，利于前缀缓存 |
| 画像 | 身份、技能、环境、目标、偏好、纠错，存成结构化条目，按与当前提问的相关性注入 |
| 项目 | 只对某个工作区有效的记忆，不会带进别的项目 |
| 迁移 | 从 ChatGPT、Claude、Gemini 等平台导入记忆，也能导出给它们 |
| 边界 | 子代理能看到什么，由策略控制；敏感信息沿用原有过滤 |
| 节奏 | 自动沉淀、问候、无人值守（来自 dsh-auto-memory 引擎） |
| 外观 | 皮肤、字号、主题（同上） |

## 快速开始

1. 安装。打开 DSH 的 Plugins 页，点 Add plugin。填本仓库的本地目录，或包名 `dsh-personalised`。也可以在 profile 目录（桌面版是 `~/.dsh/profiles/desktop`，网页版是 `~/.dsh/profiles/web`）运行 `pnpm add dsh-personalised`，再把包名加进 `package.json` 的 `dsh.profile.bundles`。装完重启 DSH。
2. 打开 设置 → 个性化。页面有五个标签页：指令、记忆、导入、导出、分层。
3. 在「指令」页写自定义指令，比如回复语言、代码风格、禁忌。保存后新会话立即生效。
4. 在「导入」页点「复制导出提示词」，粘贴到你以前常用的 AI 平台，把它返回的档案贴回来。选模型处理（或本地解析），预览后勾选要保留的条目，提交。
5. 导错了可以点「撤销本次导入」。每次提交前插件会备份整库，最多保留最近 20 份。

不想用模型也行：导入页的「本地解析」只按档案格式切条目，不联网、不花 token。

## 分层上下文

插件把注入内容分成三层，规则固定：

- 全局指令保持稳定。自定义指令和画像里的全局指令条目放进 system prompt，只在你编辑或导入时变化，同一内容逐字节一致。
- 个人记忆按相关性注入。画像里的事实条目与你最新的消息算相关度，只注入前 K 条（默认 8 条、1600 字符预算），放在 user 消息一侧。置顶条目不受相关度阈值限制，但仍受预算约束。
- 项目记忆限本工作区。只有对应工作区的会话才会看到。

待确认的条目不会注入。子代理默认只收到全局指令，看不到个人记忆和项目记忆，可在「分层」页改成不给或全给。

## 从 dsh-auto-memory 迁移

先备份配置和记忆目录，再停用旧插件、安装新插件并完全重启。不要同时启用两个插件。具体步骤、检查清单、换机操作和回退见 [迁移指南](docs/MIGRATION.md)。

本次源代码更新将主配置改为 `$DSH_HOME/dsh-personalised.json`，主 API 改为 `/api/dsh-personalised`。新配置不存在时才复制旧配置，旧文件和旧 API 兼容入口保留。记忆目录、Workspace key 与自定义存储路径不变。npm `1.0.0` 尚不包含这次路径迁移，试用本次更新请安装此仓库目录或包含更新的新版本。

## 兼容性

| 项 | 要求 |
|---|---|
| DSH | `>=0.2.2-rc.3 <0.3.0` |
| Node | `>=24.9` |

## 文档

- [用户手册](docs/USER-GUIDE.zh-CN.md)：五个标签页、导入导出流程、各配置项、原有记忆功能
- [文档索引](docs/README.md)
- [设计契约](docs/personalised/DESIGN.md)：分层架构、数据模型、接口
- [更新日志](CHANGELOG.md)

## 开发

```powershell
vp install                                    # 安装依赖，并装上 commit-msg 钩子
vp run test                                   # 全量 smoke 测试
node tools/run-smoke.mjs --filter=personal    # 只跑个性化相关套件
```

包管理只用 vp。提交信息遵循 Angular 规范，subject 要含汉字，例如 `feat(导入): 支持用模型处理外部记忆档案`。目录约束、上游同步和发版流程见 [AGENTS.md](AGENTS.md)。

## 致谢与许可

记忆引擎来自 [Aik358/dsh-auto-memory](https://github.com/Aik358/dsh-auto-memory)，本仓库是它的 fork，个性化层在其上新增。感谢上游作者与贡献者。

许可证：BSD-3-Clause，见 [LICENSE](LICENSE)。
