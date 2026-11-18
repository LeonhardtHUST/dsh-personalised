# 文档索引

## 用户文档

| 文档 | 内容 |
|---|---|
| [用户手册（中文）](USER-GUIDE.zh-CN.md) | 个性化页五个标签页、导入导出、分层与子代理策略、原有记忆功能 |
| [User guide (English)](USER-GUIDE.en.md) | 同上 |
| [迁移指南 / Migration](MIGRATION.md) | 从 dsh-auto-memory 升级、数据核对、换机和回退 |
| [README](../README.zh-CN.md) / [English](../README.md) | 定位、快速开始、迁移、开发 |
| [CHANGELOG](../CHANGELOG.md) | 版本记录 |

## 设计文档

[personalised/](personalised/) 是本仓库的设计资料。

- [DESIGN.md](personalised/DESIGN.md)：分层架构、数据模型、档案格式、路由、配置键、界面。改接口先改它。
- [rc3-audit.md](personalised/rc3-audit.md)：DSH rc3 适配审计。
- [research-dsh-rc3-api.md](personalised/research-dsh-rc3-api.md)：rc3 API 调研。
- [research-repo-map.md](personalised/research-repo-map.md)：仓库结构图。

## 上游历史资料

下面这些来自上游 dsh-auto-memory，保留是因为测试或源码注释仍在引用，内容停留在上游当时的状态。

| 文档 | 说明 |
|---|---|
| [HANDBOOK.md](HANDBOOK.md)、[SOURCE-REFERENCE.md](SOURCE-REFERENCE.md)、[WHITEPAPER.md](WHITEPAPER.md) | 上游接手手册、默认值速查、存储约束。`smoke-test-issue111-docs-real-names` 会校验 HANDBOOK |
| [SKIN-GUIDE.md](SKIN-GUIDE.md)、[TEAMWORK-GUIDE.md](TEAMWORK-GUIDE.md) | 皮肤规则、团队功能 |
| [internal/](internal/) | 仅保留 `SEMANTIC-ARCHITECTURE-SPEC.md` 与 `THREE-LAYER-CONTRACT.md`，由 `smoke-test-doc-code-consistency` 对照 |
| [skin-figures/](skin-figures/)、[ui-redesign-2026-09-25/](ui-redesign-2026-09-25/) | 皮肤指南引用的图和验收记录 |
| [teamwork-impl/](teamwork-impl/)、[teamwork-research/](teamwork-research/) | 仅保留皮肤层章程、接口契约和布局 schema，供 `skins/` 与 `lib/layout-config.js` 引用 |

其余上游文档（路线图、M7 研究、落地页、截图等）已从本仓库移除，可在上游仓库查看：https://github.com/Aik358/dsh-auto-memory
