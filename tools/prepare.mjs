#!/usr/bin/env node
// Install-time hook: Vite+ is a repository tool, not a runtime dependency of the published bundle.
// npm trusted-publishing runners do not have the optional local `vp` binary, so a missing binary is
// intentionally a no-op; when vp is available it still installs the repository hook dispatcher.
import { spawnSync } from 'node:child_process'

const command = process.platform === 'win32' ? 'vp.cmd' : 'vp'
const result = spawnSync(command, ['config', '--no-agent'], { stdio: 'inherit' })
if (result.error && (result.error.code === 'ENOENT' || result.error.code === 'EACCES')) process.exit(0)
if (result.status !== null && result.status !== 0) process.exit(result.status)
