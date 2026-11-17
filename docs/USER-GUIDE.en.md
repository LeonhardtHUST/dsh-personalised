# dsh-personalised user guide

This guide covers day-to-day use. Design details are in [DESIGN.md](personalised/DESIGN.md) (Chinese). Installation and migration are in the [README](../README.md).

## 1. Where to find it

Settings → Personalisation. It has five tabs: Instructions, Memory, Import, Export, Layers. The original memory panel is still behind the Memory button at the bottom of the left sidebar.

Edit settings on the page, then commit them with the save bar. Only changes to injection surfaces or the tool list need a DSH restart. The rest apply from the next turn.

## 2. The five tabs

### 2.1 Instructions

- Switch: turning it off removes the custom instructions block entirely.
- Editor: write your system instructions, up to 20,000 characters. The footer shows the character count and an estimated token count.
- Position: prefix puts them after the persona and before the policy section. Suffix puts them after the tools and policy section. Pick prefix if you want them to weigh more.
- Subagents: tick it to let subagents receive the instructions too.
- Native DSH AGENTS.md: a collapsed editor for `$DSH_HOME/AGENTS.md`. This is DSH's own mechanism, injected as a system-reminder on the first turn of a session. If the file changed elsewhere, saving reports a conflict. Refresh and edit again.

While the instructions stay the same, every request renders byte-identical text, so the prefix cache is not invalidated. Do not put dates or counters in them.

### 2.2 Memory

The profile store. Entries are grouped into nine categories: instructions, identity, skills, environment, projects, goals, preferences, corrections, pending.

- Scope filter: global, current workspace, all.
- The search box filters by text.
- Each entry can be edited, deleted, pinned, or added by hand.
- Pinned entries ignore the relevance threshold and are injected every time, but still use budget.
- Pending entries are never injected. Move them to another category to activate them.

Each entry has a priority (high, medium, low), evidence (explicit, inferred, unconfirmed), a time and a status. In the instructions and corrections categories, global entries above low priority go into the global instruction layer. Low-priority and workspace-scoped instructions are injected by relevance instead.

### 2.3 Import

Four steps:

1. Click "Copy export prompt" and paste it into the AI platform you used before.
2. Paste the archive it returns, or upload the file. An outer code fence is stripped automatically.
3. Choose how to process it and the target workspace. "Model" tidies, dedupes and judges conflicts with an LLM. "Local parse" only splits by format and makes no network call. If the model returns invalid JSON, the importer falls back to local parsing and says so.
4. Preview. Each row has a badge: add, merge (with an existing entry), conflict (with an existing entry), skip. Tick rows, edit text if needed, then commit.

After committing, the page shows "Undo this import", which restores the state before the commit. Backups live in `~/.dsh/memory/personal/backups/`, latest 20 kept.

Notes:

- A preview lives in memory for 30 minutes. After that, commit fails and you preview again.
- With no bound workspace, project-scoped entries are downgraded to global with a warning.
- Model mode needs a model. If none is selected, the importer tries the import model from settings, then the subagent model. If neither exists it asks you to pick one.
- The "completeness statement" and "items to verify" sections of an archive do not become entries. They show up in the report only.

Archive format:

```
### 1. 指令与行为规则
[高][明示][长期有效] content
[中][归纳][事件:2026-10-15][进行中] content
```

Section headings map to the nine categories by number or keyword. A bare list line is imported into its section with priority medium and evidence inferred.

### 2.4 Export

Choose a format (Markdown or JSON) and a scope (all, global, one workspace), preview, then copy or download. Markdown is grouped by the nine categories, starts with a line naming the source and time, and ends with a completeness statement. Project entries get `〔项目:path〕` in front. The exported Markdown can be imported back into this plugin or handed to another platform.

### 2.5 Layers

Controls how personal memory enters the context.

| Key | Default | Meaning |
|---|---|---|
| `personalInjectMode` | `relevant` | How personal and project memory is injected. `off` disables it |
| `personalTopK` | 8 | Maximum entries per turn, 1 to 30 |
| `personalBudgetChars` | 1600 | Character budget for the personal and project block, 200 to 8000 |
| `personalSubagentPolicy` | `instructions` | Subagent policy, see below |
| `userMemoryInjectMode` | `relevant` | How legacy `MEMORY.md` is injected. `relevant` trims by paragraph relevance, `full` injects the whole file (old behavior) |

The context preview at the bottom takes a sentence and shows what the three layers would inject right now, with character counts. Use it when tuning.

Three import keys also live here: `personalImportProvider`, `personalImportModel` (model used for import, empty follows the subagent model) and `personalImportTimeoutMs` (default 180000, range 30000 to 600000).

## 3. Layers and subagents

Injection has three layers:

| Layer | Content | Changes when |
|---|---|---|
| Global instructions | Custom instructions plus global instruction entries | Only when you edit or import |
| Personal memory | Fact entries, top K by relevance to the latest message | Recomputed each user turn; same result gives the same text |
| Project memory | Entries scoped to the current workspace | Same, and shown only in that workspace |

Subagent policy `personalSubagentPolicy`:

- `instructions` (default): global instructions only, and only when `customInstructionsSubagents` is on. No personal or project memory.
- `none`: nothing.
- `all`: all three layers. Project memory is judged by the subagent's own working directory.

Background subagents started by this plugin (auto-consolidation, summaries) never receive personal or project memory. A subagent calling `memory_profile` can search but cannot add, update or remove.

Instruction keys:

| Key | Default | Meaning |
|---|---|---|
| `customInstructionsEnabled` | on | Master switch for the global layer |
| `customInstructions` | empty | The instruction text, up to 20,000 characters |
| `customInstructionsPosition` | `prefix` | `prefix` or `suffix` |
| `customInstructionsSubagents` | on | Whether subagents receive global instructions |

## 4. Profile tool for the AI

`memory_profile` searches, adds, updates and removes profile entries. Entries added by the AI are marked source agent, evidence explicit. With workspace scope, the entry binds to the current session's workspace.

## 5. Original memory features

These come from the dsh-auto-memory engine and behave as before. Keys match the old version. Only the essentials are listed.

### 5.1 Auto-consolidation

After each turn, a subagent decides whether it has lasting value and, if so, writes it to today's log by topic. You never need to say "remember this".

- `autoConsolidate`: master switch, on by default.
- `autoConsolidateMinChars`: turns shorter than this count as small talk, default 240.
- `autoConsolidateCooldownMinutes`: minimum gap between runs, default 30, doubled at night. Setting 0 falls back to 30, it does not disable.
- `autoConsolidateDailyMax`: daily quota, default 8. The count is persisted and survives restarts.

### 5.2 Memory window and injection budget

The `<memory_system>` block injected each turn. `injectEnabled` switches it, `injectBudgetChars` (default 1600) caps it. Lower it if the AI is distracted by memory, raise it if it forgets things. Memory from other AI tools has its own budget, `externalInjectionChars` (default 1400). Credentials and secrets never enter prompts.

### 5.3 Retrieval

`memory_recall` fuses several arms. Lexical (keywords, BM25) is always available and is what finds error codes and variable names. Semantic (vector similarity) finds memories on the same topic with different wording. The time arm parses phrases like "yesterday" or "last week" and boosts entries from that period. Evidence weighting ranks memories you corrected lower. The arms merge with RRF, and the default result is a list of summaries of about 93 characters. Use `expand` or `memory_read` for the full text.

`semanticEngineMode` picks the engine: `auto` (semantic if ready, else lexical), `lexical`, `js` (built-in e5-small, about 130 MB), `python` (BGE-M3, about 563 MB). The detect button on the settings page checks the environment. Without a downloaded model it still works, just lexical only.

### 5.4 Memory hub

Distills memory into three layers: episodes, facts, skills. Promoting a skill passes four gates: at least 3 independent sessions, at least 2 successes, no more than 30% corrections, and manual approval for high-risk skills. The approval queue is on the Memory hub page of the memory panel. Master switch: `memoryHubEnabled`.

### 5.5 Handoff whiteboard and auto-continue

Long tasks record progress in `PLAN.md` and four-section handoff ledgers. The water-level card shows context usage and suggests a handoff once past the threshold. To continue, use "One-click continue" or turn on auto-continue on the whiteboard page. Search the whiteboard first with `memory_recall` and `scope=handoff`.

### 5.6 External memory

Connects memory files from WorkBuddy, CodeBuddy, Claude Code, Codex and similar tools. Scan, import or remove per source. Only path pointers are stored, content is not copied.

### 5.7 Calendar, greetings and unattended mode

The AI extracts deadlines from conversation and keeps reminding you of open items. After you are away longer than `awayMinutes` (default 60) you get a greeting on return. With `unattendedMode` on, only plain factual memory is injected, which suits long batch jobs.

### 5.8 Memory tools

The AI calls these itself: `memory_recall`, `memory_read`, `memory_note`, `memory_log`, `memory_user`, `memory_reflect`, `memory_consolidate`, `memory_maintain`, `memory_status`, `memory_external`, `calendar_add/list/done/remove`, plus the new `memory_profile`. Write tools pass an input gate that rejects garbled text, repeated lines and base64 residue, and says why.

## 6. Data locations

| What | Path |
|---|---|
| Plugin config | `~/.dsh/dsh-auto-memory.json` |
| Profile store | `~/.dsh/memory/personal/profile.json` |
| Import backups | `~/.dsh/memory/personal/backups/` |
| User-level memory | `~/.dsh/memory/MEMORY.md` |
| Workspace memory | `~/.dsh/memory/workspaces/<workspace>/` |
| Memory hub | `~/.dsh/memory/hub/` |
| Evidence events | `~/.dsh/memory/evidence/events/` |
| Diagnostic log | `~/.dsh/dsh-auto-memory-diagnose.log` (next to `memory/`, not inside) |

If `DSH_HOME` is set, the actual host data root applies. Everything stays on your machine. Paths keep the old names so existing dsh-auto-memory users keep their data.

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| Instructions have no effect | Check the Instructions switch is on and saved. In a subagent, check the Subagents box and `personalSubagentPolicy` |
| Personal memory not injected | Use the context preview. Check whether the entry is pending, whether `personalInjectMode` is `off`, and raise `personalTopK` or the budget |
| Import asks for a model | Pick a model on the Import tab, or set an import model or subagent model in settings |
| Commit says the preview expired | Previews last 30 minutes. Preview again |
| Imported the wrong thing | Click "Undo this import". If you left the page, restore from the backup directory by hand |
| A setting did not apply | Did you click save? Items marked restart-required need a restart. After a browser-side update press Ctrl+Shift+R |
| Semantic search returns nothing | Run detection on the settings page and download missing assets. Auto mode falls back to lexical |
| Reporting a problem | Attach the diagnostic log and open an [issue](https://github.com/LeonhardtHUST/dsh-personalised/issues) |
