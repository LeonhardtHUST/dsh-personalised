# dsh-personalised

English · [中文](README.zh-CN.md)

A personalisation plugin for DeepSeek Harness (DSH). Write your instructions once, import your memories once, and every session follows your habits.

The plugin splits "how the AI should treat you" into separate dimensions:

| Dimension | What it covers |
|---|---|
| Instructions | Custom system instructions, global, byte-stable while unchanged so prefix caching keeps working |
| Profile | Identity, skills, environment, goals, preferences and corrections, stored as structured entries and injected by relevance to the current question |
| Projects | Memory that applies to one workspace only and never leaks into others |
| Migration | Import memories from ChatGPT, Claude, Gemini and similar platforms, and export them back out |
| Boundaries | What subagents can see, set by policy; sensitive-data filtering is inherited |
| Rhythm | Auto-consolidation, greetings, unattended mode (from the dsh-auto-memory engine) |
| Appearance | Skins, font size, theme (same source) |

## Quick start

1. Install. Open the Plugins page in DSH and click Add plugin. Enter a local directory of this repo, or the package name `dsh-personalised`. You can also run `pnpm add dsh-personalised` in the profile directory (`~/.dsh/profiles/desktop` for the desktop app, `~/.dsh/profiles/web` for the web build) and add the package name to `dsh.profile.bundles` in its `package.json`. Restart DSH afterwards.
2. Open Settings → Personalisation. It has five tabs: Instructions, Memory, Import, Export, Layers.
3. On the Instructions tab, write your custom instructions: reply language, code style, things to avoid. They apply to new sessions as soon as you save.
4. On the Import tab, click "Copy export prompt", paste it into the AI platform you used before, then paste the archive it returns. Pick a model to process it (or local parsing), review the preview, tick the entries to keep, and commit.
5. If an import went wrong, click "Undo this import". The plugin backs up the whole profile before every commit and keeps the latest 20 backups.

Local parsing needs no model: it splits entries by the archive format only, with no network call and no tokens spent.

## Layered context

Injected content is split into three layers with fixed rules:

- Global instructions stay stable. Custom instructions and global instruction entries from the profile go into the system prompt. They change only when you edit or import, and identical content renders byte for byte the same.
- Personal memory is injected by relevance. Fact entries are scored against your latest message and only the top K are injected (default 8 entries, 1600-character budget), on the user-message side. Pinned entries skip the relevance threshold but still count against the budget.
- Project memory stays in its workspace. Only sessions in that workspace see it.

Pending entries are never injected. Subagents receive only the global instructions by default, with no personal or project memory. The Layers tab can change that to none or all.

## Migrating from dsh-auto-memory

1. Uninstall the old dsh-auto-memory (package `@a9i5k4/dsh-auto-memory`) on the Plugins page. Do not enable both.
2. Install dsh-personalised as above and restart.

Nothing needs to move. The route prefix `/api/dsh-auto-memory`, the config file `~/.dsh/dsh-auto-memory.json` and the data directory `~/.dsh/memory/` keep their old names, so existing memory, logs, whiteboards and settings work as before. The profile store is new and lives at `~/.dsh/memory/personal/profile.json`.

## Compatibility

| Item | Requirement |
|---|---|
| DSH | `>=0.2.2-rc.3 <0.3.0` |
| Node | `>=24.9` |

## Documentation

- [User guide](docs/USER-GUIDE.en.md): the five tabs, import and export flow, every setting, the original memory features
- [Docs index](docs/README.md)
- [Design contract](docs/personalised/DESIGN.md): layer architecture, data model, API
- [Changelog](CHANGELOG.md)

## Development

```powershell
vp install                                    # install dependencies and the commit-msg hook
vp run test                                   # full smoke suite
node tools/run-smoke.mjs --filter=personal    # personalisation suites only
```

Use vp for package management. Commit messages follow the Angular convention and the subject must contain Chinese characters, for example `feat(导入): 支持用模型处理外部记忆档案`. Directory rules, upstream sync and the release flow are in [AGENTS.md](AGENTS.md).

## Credits and license

The memory engine comes from [Aik358/dsh-auto-memory](https://github.com/Aik358/dsh-auto-memory). This repository is a fork that adds the personalisation layer on top. Thanks to the upstream author and contributors.

License: BSD-3-Clause, see [LICENSE](LICENSE).
