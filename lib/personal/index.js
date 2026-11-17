/**
 * lib/personal/index.js —— 个性化核心纯模块的**唯一汇总出口**。
 *
 * 宿主接线只看这一份导出面（详见 docs/personalised/DESIGN.md §2、§5）：
 *
 *   import {
 *     createProfileStore, createImporter, makeLlmCall,
 *     renderStableSection, renderPersonalContext, decideLayers, stableSectionOrder,
 *     STABLE_SECTION_NAME, PERSONAL_CONTEXT_NAME,
 *     parseArchive, renderArchive, renderJson, selectRelevantChunks,
 *   } from './personal/index.js'
 *
 * 典型接线：
 *
 *   const store = createProfileStore({ dir: path.join(userMemoryDir, 'personal') })
 *   const importer = createImporter({ store, llmCall: makeLlmCall(ctx.llm) })
 *
 *   ctx.systemPrompt.section({
 *     name: STABLE_SECTION_NAME,
 *     order: stableSectionOrder(config.customInstructionsPosition),
 *     interpolate: false,
 *     text: () => renderStableSection({ enabled: config.customInstructionsEnabled, customText: config.customInstructions, entries }),
 *   })
 *   ctx.systemPrompt.context({
 *     name: PERSONAL_CONTEXT_NAME,
 *     order: 10000,
 *     text: (context) => {
 *       const decision = decideLayers({ isSubagent, isOwnBackground, policy: config.personalSubagentPolicy, ... })
 *       return decision.personal && decision.workspace
 *         ? renderPersonalContext({ query, entries, wsKey, topK: config.personalTopK, budgetChars: config.personalBudgetChars }).text
 *         : ''
 *     },
 *   })
 *
 * 纪律：所有模块只依赖 node 内置与仓库内 lib/*.js；不 import `@deepseek-ai/*`。
 * 除 `profile-store` / `importer` / `llm-call` 外全部是纯函数（可同步调用、结果确定）。
 */

export * from './prompts.js'
export * from './archive-format.js'
export * from './profile-store.js'
export * from './relevance.js'
export * from './layers.js'
export * from './importer.js'
export * from './llm-call.js'
