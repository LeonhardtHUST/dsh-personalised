#!/usr/bin/env node
// 合并上游 Aik358/dsh-auto-memory 的新提交。
//
// 用法：node tools/upstream-sync.mjs [--dry-run]
//   环境变量 UPSTREAM_URL / UPSTREAM_BRANCH 可覆盖默认上游。
//
// 行为：
//   1. fetch 上游，没有新提交就退出（status=up-to-date）。
//   2. git merge --no-commit 上游分支。
//   3. 本仓库自有的文件（品牌、文档、发布配置，见 OURS）发生冲突时一律保留本仓库版本；
//      本仓库删除、上游修改的文件保持删除。
//   4. 仍有冲突 → git merge --abort，status=conflict，列出冲突文件。
//   5. 无冲突 → 提交合并（--dry-run 时 abort），status=merged。
//   6. 上游改了 package.json 的依赖/导出/manifest 字段时 attention=true，需要人工把改动搬过来。
//
// 结果写到 stdout（JSON）和 $GITHUB_OUTPUT（status / behind / upstream_sha / attention / conflicts_file）。

import { execFileSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'

const UPSTREAM_URL = process.env.UPSTREAM_URL || 'https://github.com/Aik358/dsh-auto-memory.git'
const UPSTREAM_BRANCH = process.env.UPSTREAM_BRANCH || 'main'
const DRY = process.argv.includes('--dry-run')
const REF = `upstream/${UPSTREAM_BRANCH}`

// 本仓库自有路径：冲突时保留本仓库版本。
const OURS = [
  /^README(\.[\w-]+)?\.md$/,
  /^CHANGELOG\.md$/,
  /^AGENTS\.md$/,
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^notices\.json$/,
  /^cordis\.patch\.yml$/,
  /^locale\//,
  /^docs\//,
  /^\.github\//,
  /^social-preview\.html$/,
]
// 上游改了这些 package.json 字段时需要人工跟进。
const WATCHED_PKG_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies', 'exports', 'files', 'dsh', 'main', 'type']

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const tryGit = (...args) => {
  try { return { ok: true, out: git(...args) } } catch (e) { return { ok: false, out: `${e.stdout || ''}\n${e.stderr || ''}\n${e.message}` } }
}
const isOurs = (p) => OURS.some((re) => re.test(p))

function output(result) {
  console.log(JSON.stringify(result, null, 2))
  const file = process.env.GITHUB_OUTPUT
  if (!file) return
  const lines = [
    `status=${result.status}`,
    `behind=${result.behind ?? 0}`,
    `upstream_sha=${result.upstreamSha ?? ''}`,
    `attention=${result.attention ? 'true' : 'false'}`,
  ]
  if (result.conflicts?.length || result.attentionNotes?.length) {
    const path = 'upstream-sync-report.md'
    writeFileSync(path, report(result))
    lines.push(`report_file=${path}`)
  }
  appendFileSync(file, lines.join('\n') + '\n')
}

function report(r) {
  const out = [`上游：${UPSTREAM_URL} \`${UPSTREAM_BRANCH}\` @ \`${r.upstreamSha}\`（领先本仓库 ${r.behind} 个提交）`, '']
  if (r.conflicts?.length) {
    out.push('### 无法自动合并的文件', '', ...r.conflicts.map((p) => `- \`${p}\``), '')
  }
  if (r.attentionNotes?.length) {
    out.push('### 需要人工跟进', '', ...r.attentionNotes.map((n) => `- ${n}`), '')
  }
  if (r.commits?.length) {
    out.push('### 上游新提交', '', ...r.commits.slice(0, 50).map((c) => `- ${c}`), '')
  }
  out.push('本地处理：', '', '```bash', 'git fetch upstream', `git merge ${REF}`, '# 解决冲突后', 'git commit', '```')
  return out.join('\n')
}

function pkgFieldChanges(base, head) {
  const read = (rev) => { const r = tryGit('show', `${rev}:package.json`); return r.ok ? JSON.parse(r.out) : {} }
  const a = read(base)
  const b = read(head)
  return WATCHED_PKG_FIELDS.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
}

function main() {
  if (!tryGit('remote', 'get-url', 'upstream').ok) git('remote', 'add', 'upstream', UPSTREAM_URL)
  git('fetch', '--no-tags', 'upstream', UPSTREAM_BRANCH)
  const upstreamSha = git('rev-parse', '--short', REF)
  const behind = Number(git('rev-list', '--count', `HEAD..${REF}`))
  if (behind === 0) return output({ status: 'up-to-date', behind, upstreamSha })

  const commits = git('log', '--format=%h %s', `HEAD..${REF}`).split('\n').filter(Boolean)
  const base = git('merge-base', 'HEAD', REF)
  const changedFields = pkgFieldChanges(base, REF)
  const attentionNotes = changedFields.length
    ? [`上游 package.json 改动了 ${changedFields.map((f) => `\`${f}\``).join('、')}；本仓库保留自己的 package.json，请手动核对是否需要同步。`]
    : []

  const merge = tryGit('merge', '--no-ff', '--no-commit', REF)
  if (!merge.ok && !/CONFLICT|Automatic merge failed/.test(merge.out)) throw new Error(merge.out)

  const unmerged = git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean)
  const remaining = []
  for (const p of unmerged) {
    if (!isOurs(p)) { remaining.push(p); continue }
    if (tryGit('cat-file', '-e', `HEAD:${p}`).ok) {
      git('checkout', '--ours', '--', p)
      git('add', '--', p)
    } else {
      git('rm', '-q', '-f', '--', p)
    }
  }
  // package.json 与 .github/ 即使没冲突也以本仓库为准：版本号与发布信息归本仓库所有；
  // 而 GITHUB_TOKEN 无权推送 workflow 文件改动，带进来会让推送失败。
  const forced = git('diff', '--cached', '--name-only', 'HEAD').split('\n')
    .filter((p) => p === 'package.json' || p.startsWith('.github/'))
  for (const p of forced) {
    if (tryGit('cat-file', '-e', `HEAD:${p}`).ok) git('checkout', 'HEAD', '--', p)
    else git('rm', '-q', '-f', '--', p)
  }

  if (remaining.length) {
    tryGit('merge', '--abort')
    return output({ status: 'conflict', behind, upstreamSha, conflicts: remaining, commits, attention: true, attentionNotes })
  }
  if (DRY) {
    tryGit('merge', '--abort')
    return output({ status: 'mergeable', behind, upstreamSha, commits, attention: attentionNotes.length > 0, attentionNotes })
  }
  git('commit', '--no-verify', '-m', `chore(同步): 合并上游 dsh-auto-memory@${upstreamSha}`)
  return output({ status: 'merged', behind, upstreamSha, commits, attention: attentionNotes.length > 0, attentionNotes })
}

main()
