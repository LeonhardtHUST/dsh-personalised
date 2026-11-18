# dsh-auto-memory → dsh-personalised

[English](#english)

适用于本仓库的旧名称迁移更新。**npm 的 `1.0.0` 仍使用旧配置路径；使用下面的新路径前，先确认安装包已包含本次更新。** 本地试用可在 DSH 插件管理器中安装此仓库目录。直接修改仓库不会更新另一个目录里的已安装副本。

## 同一台电脑迁移

1. 在旧插件设置中记下存储目录、模型和自动化开关。停止后台任务，关闭使用同一 `DSH_HOME` 的其他 DSH 进程。
2. 备份以下内容到一个独立目录：
   - `$DSH_HOME/dsh-auto-memory.json`；如有 `$DSH_HOME/dsh-auto-memory-pre.json`，一起备份。
   - `$DSH_HOME/memory/`，以及设置里指定的其他 `memoryRoot`、`userMemoryDir`、`workbenchRoot`。
   - 有效 profile 目录内的 `package.json`、`cordis.patch.yml`。不要收集凭据文件。
3. 打开 DSH 的插件管理器，停用旧包 `@a9i5k4/dsh-auto-memory`，然后安装并启用 `dsh-personalised`。确认旧包不再启用；安装器若询问是否删除用户数据，请保留数据。不要同时运行两个插件。
4. 完全退出并重启 DSH，浏览器页面强制刷新。替换已安装包后需要重启，不能只依赖热更新。
5. 打开「设置 → 个性化」及「记忆」设置页，核对存储目录、模型、已有笔记、日志、白板和技能。新会话里运行 `memory_status`，确认使用的是预期工作区。

桌面版默认数据根是 `~/.dsh`，profile 通常是 `~/.dsh/profiles/desktop`；网页版通常是 `~/.dsh/profiles/web`。设置了 `DSH_HOME` 或使用自定义 profile 时，以实际路径为准。

## 自动迁移的范围

| 内容 | 更新后的行为 |
|---|---|
| 插件配置 | 新路径为 `$DSH_HOME/dsh-personalised.json`。仅在它不存在时读取旧配置，原子写入新文件 |
| 配置冲突 | 新文件已存在时完全以新文件为准，包括空对象。首次迁移旧配置时，普通旧配置优先于 `-pre` 配置 |
| 旧配置 | 保留，不删除、不跟随新配置持续更新。迁移失败会报告错误，不应手工用默认设置覆盖 |
| 笔记、日志、白板、技能、画像 | 原目录和 Workspace key 不变；配置中的自定义路径也不变，无须重新导入 |
| 浏览器偏好 | 同一浏览器、同一站点首次加载时，将旧前缀状态复制到 `dsh-personalised.*`；新值优先，旧值保留 |
| HTTP API | 主前缀改为 `/api/dsh-personalised`，旧 `/api/dsh-auto-memory` 保留兼容处理器；已有脚本可逐步更新 |
| 远程访问白名单 | 新环境变量 `DSH_PERSONALISED_ALLOWED_HOSTS` 优先；旧 `DSH_AUTO_MEMORY_ALLOWED_HOSTS` 仍兼容 |
| 后台任务 | 新任务使用新标签，旧任务标签仍可识别和清理 |

浏览器偏好不在服务器配置里。更换浏览器、主机名或端口时，面板位置和主题偏好可能需要重设；这不影响磁盘上的记忆。

首次迁移失败时，先查看诊断信息并处理文件权限、损坏配置或占用锁。保留旧文件和备份，不要删除配置来“恢复默认”。

## 核对清单

- [ ] 插件管理器只有 `dsh-personalised` 启用，没有重复记忆入口。
- [ ] 新配置文件存在，存储路径与原配置一致。
- [ ] 原用户笔记、至少一个项目的日志和白板可以打开。
- [ ] 选定模型及自动化开关正确；新会话未混入其他 Workspace 的项目记忆。
- [ ] 浮层使用不透明背景，浅色和深色模式下文字可读。

核对完成前不要删除备份。旧格式的 namespace、迁移包标记和来源署名可能保留旧名称，这是读取历史数据所需的兼容信息。

## 换电脑或改工作区路径

不要直接改 `memory/workspaces/` 下的目录名。Workspace key 与原始路径绑定，直接改名会留下失效引用。

- 搬完整项目记忆：使用记忆面板的迁移包功能，先导出，在目标机预览，再指定目标工作区导入。
- 只搬个人画像：在「设置 → 个性化 → 导出」导出档案，再在目标机「导入」页预览确认。
- 拷贝备份前先停止两端 DSH。共享目录需要各实例一致的访问与权限设置。

## 回退

1. 停用 `dsh-personalised`，停止后台任务并退出全部相关 DSH 进程。
2. 重新启用原版插件，恢复备份的旧配置和 profile 设置，再启动 DSH。
3. 旧浏览器键仍在同一站点，新插件不会把新值写回旧键。

配置复制不是完整数据快照。迁移后对共享记忆目录做的修改会同时影响旧插件；若要恢复迁移前的全部内容，必须恢复第 2 步保存的记忆目录备份。恢复前先另存当前目录，防止覆盖迁移后新增内容。

## English

This guide describes the source update that renames the runtime paths. npm `1.0.0` still uses the legacy paths. Install a build containing this update, or install this checkout through the DSH plugin manager. Editing a checkout does not update a separately installed copy.

1. Record storage paths, selected models and automation switches. Stop background jobs and other DSH processes sharing the same `DSH_HOME`.
2. Back up the old config files, the memory directory and all custom storage roots. Back up the active profile's `package.json` and `cordis.patch.yml`; do not collect credential files.
3. Disable `@a9i5k4/dsh-auto-memory`, then install and enable `dsh-personalised` through the plugin manager. Keep user data if prompted. Never run both plugins together.
4. Fully restart DSH and refresh the browser. Verify storage paths, models, notes, logs, whiteboards and skills. Use `memory_status` in a new session to check the workspace.

The new config is `$DSH_HOME/dsh-personalised.json`. It is created from the legacy files only when absent. Once present, it is authoritative, even if it contains `{}`. The normal legacy config takes precedence over the older `-pre` file during the initial migration. Old files remain untouched for rollback.

Memory directories, custom paths, persisted formats and Workspace keys remain unchanged. Browser preferences are copied to `dsh-personalised.*` before first use, without overwriting new values or deleting old keys. Preferences are origin-specific: another browser, hostname or port may need fresh UI settings.

Use `/api/dsh-personalised` for new integrations. The old API prefix remains an alias with the same handlers and access checks. `DSH_PERSONALISED_ALLOWED_HOSTS` takes precedence over the supported legacy variable.

For another machine or a changed workspace path, use the workspace migration pack and review its target path. Use Personalisation → Export/Import for the personal profile. Do not rename workspace directories by hand.

To roll back, disable the new plugin, stop DSH, restore the old config/profile and enable the old plugin. Both versions share the memory directories: restore the directory backup too if you need the exact pre-migration state. Save the current data separately before restoring it.
