# AGENTS.md — dsh-personalised 仓库约束

给在本仓库工作的人和 AI Agent。动手前读完，冲突时以本文件为准。

## 仓库是什么

- npm 包 `dsh-personalised`：DeepSeek Harness（DSH）个性化插件，目标 DSH `>=0.2.2-rc.3 <0.3.0-0`，Node `>=24.9`。
- Fork 自上游 [Aik358/dsh-auto-memory](https://github.com/Aik358/dsh-auto-memory)。记忆引擎沿用上游，个性化层是本仓库新增。
- 设计契约：[docs/personalised/DESIGN.md](docs/personalised/DESIGN.md)。接口改动先改它。

## 代码布局

| 路径 | 归属 | 规则 |
|---|---|---|
| `lib/index.js` | 上游（host 单体，约 2 万行） | 只做最小接线；新逻辑放 `lib/personal/`。不要重排、格式化或大段移动代码，否则上游同步必冲突 |
| `lib/client.js` | 上游（client 单体） | 新 UI 只写在 `DSH-PERSONALISED BEGIN/END` 区块；`ITER5-*-GENERATED` 区由 `tools/build-iter5-skin.mjs` 生成，禁止手改 |
| `lib/personal/` | 本仓库 | 个性化层：档案格式、画像库、相关性、分层渲染、导入器、提示词。纯模块，零运行时依赖 |
| `tests/smoke/` | 共用 | 每个套件是独立 node 脚本；新增套件命名 `smoke-test-personal-*.mjs` |
| `docs/`、`README*`、`package.json`、`.github/` | 本仓库 | 上游同步时冲突一律保留本仓库版本 |

兼容性约束（改动前先想清楚）：

- 路由前缀 `/api/dsh-auto-memory`、配置文件 `dsh-auto-memory.json`、数据目录 `~/.dsh/memory/` 保持旧名，老用户换装本插件后数据直接可用。
- 新增 host 路由必须同时登记 `lib/index.js` 的 `API` 表和 `lib/client.js` 的 `API` 表，`smoke-test-api-paths` 会检查。
- 新增配置键加进 `DEFAULT_CONFIG`，校验写进 `lib/settings-safety.js`。改已有键的默认值要写一次性迁移。
- 分层注入的三条规则（全局指令稳定、个人记忆按相关性、项目记忆限本工作区）见 DESIGN §2，不得破坏。改注入文本要保证同一请求两次渲染逐字节一致。

## 工具链

- 包管理只用 vp：`vp install`、`vp add -D <pkg>`、`vp remove <pkg>`。不要用 npm/yarn 安装依赖，不要提交其他锁文件。
- 测试：`vp run test`（= `node tools/run-smoke.mjs`）。只跑相关子集：`node tools/run-smoke.mjs --filter=personal`。
- 不要对现有文件运行 `vp fmt`、`vp lint --fix`、`vp migrate` 或任何全仓格式化。
- `vp install` 会经 `prepare` 安装 commit-msg 钩子。

## 提交纪律

- 提交信息遵循 Angular 规范，且 subject 必须含汉字，由 commitlint 在 commit-msg 钩子里强制：
  `feat(导入): 支持用模型处理外部记忆档案`、`fix(注入): 子代理不再收到个人记忆`。
- type：`feat fix docs style refactor perf test build ci chore revert`。
- 一个提交只做一件事；提交前跑相关 smoke 子集，全绿再提交。
- 不要用 `--no-verify` 绕过钩子（CI 机器人合并上游除外）。

## 发版

- 改 `package.json` 的 `version` 并在 `CHANGELOG.md` 写同版本条目，推到 main 后 `publish.yml` 自动测试、发布（npm trusted publishing）、打 tag、建 Release。
- 本地不要 `npm publish`，除非 CI 不可用且维护者明确要求。
- `upstream-sync.yml` 每天合并上游；无法自动合并时会开 `upstream-sync` issue。处理方式见该 issue 内的说明。

## 安全

- 不读取、不输出、不提交任何凭据（`.credentials`、token、API key）。
- 个人记忆属于用户隐私：测试只用临时目录和虚构数据，不要把真实 `~/.dsh/memory` 内容写进仓库或日志。
