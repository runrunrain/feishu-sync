# macOS arm64 最终源码重包报告

## 当前交付与状态（取代下方旧候选数据）

当前 `.app` / `.dmg` / `.zip` 均基于 `c2aca8d2bc4f745dcaf3bd6aecb0a8b0ef1be459` 加本轮未提交的 Electron clipboard bridge、统一 helper 和 standalone 日志修复等实际源码构建。**不是正式发布包**：ad-hoc 签名、未公证；真实 GUI 待洛神对新包复验。§13.10 standalone 补验已使用显式配置的空闲回环端口通过；默认 3001 被其他进程占用，未进行默认端口实测。

- App（后续 GUI 实测入口）：`/Users/run.mao/workpace/feishu-sync/dist-desktop/darwin-arm64/mac-arm64/Feishu Sync.app`
- 启动：`open '/Users/run.mao/workpace/feishu-sync/dist-desktop/darwin-arm64/mac-arm64/Feishu Sync.app'`
- 独立 staging：`/Users/run.mao/feishu-sync-candidate.1cQjnvcc/`；复用已有 Electron ABI 125 的独立 server 依赖，未安装或重建依赖。
- 旧 app、DMG、ZIP、源清单、app 清单、旧报告、旧 staged dist 已归档到 `/Users/run.mao/feishu-sync-candidate.1cQjnvcc/archive-0152862a.YeBzKi/`，未删除；下方旧候选章节仅为历史证据，不是当前产物哈希。

| 当前产物路径（项目根相对路径） | 字节 | SHA-256 |
|---|---:|---|
| `dist-desktop/darwin-arm64/FeishuSync-0.3.50-arm64.dmg` | 86,980,239 | `6d1d4cc639280d01df602ebc87d9462cb3226f3e771ee65d23b012f1a2cd348c` |
| `dist-desktop/darwin-arm64/FeishuSync-0.3.50-arm64.zip` | 100,297,633 | `6d9d16b8f39cc5b52a52816f651fbfc0666720e2b6dbc402c9f1a6d3a5e99b9a` |
| `dist-desktop/darwin-arm64/mac-arm64/Feishu Sync.app` | 普通文件合计 241,642,722 | 目录没有单一文件 hash；9,579 条规范化内容清单 SHA-256 `c1735035bf972c3211eb26920bb92f15f1886a9abb3bbd5b84efd2abfd33e7bb` |

当前 app 清单：`/Users/run.mao/feishu-sync-candidate.1cQjnvcc/repack-app-manifest.json`。其按相对路径排序记录目录 mode、文件 mode/大小/SHA-256 与符号链接目标，紧凑 JSON 加换行。该清单不覆盖扩展属性；签名另经 `codesign` 验证。

## 最终源码及构建闭环

构建前、构建后、打包后的生产源码清单各 481 条、字节相等，清单 SHA-256 均为 `885c1582db06618660e9d1e092d34b8931579366c470b3e4efe861e548b91f3b`，对应 staging 的 `repack-source-before.json`、`repack-source-after-build.json`、`repack-source-after-package.json` 和最后复核的 `repack-source-final.json`。生成器 `agent-outputs/workflow/20261029-kb-retrieval-mcp/package-source-manifest.py` 使用 `git ls-files -co --exclude-standard` 覆盖 `src`、`electron`、`server/src`、`server/scripts`、根 `scripts`、各 package/lock、Vite/TS/PostCSS/Tailwind 配置、`index.html` 和 builder config，并显式纳入 ignored `build/` 所有资源；含未跟踪生产源，不含 `server/tests`。D 提交后在项目根执行 `python3 agent-outputs/workflow/20261029-kb-retrieval-mcp/package-source-manifest.py /tmp/<新清单>.json`，再逐项比对此 staging 最终清单；提交时若路径集合或内容变更必须重新判断对应关系。

项目根执行 `npm run build:all && npm run electron:build`，两者 exit 0；构建前后源清单相同。将新 `dist`、`dist-electron`、`server/dist` 复制到隔离 app。调用根 `electron-builder.config.cjs`，`DESKTOP_APP_DIR` 为 staging、目标为 darwin arm64、`DESKTOP_MAC_SIGNING=adhoc`、`--publish never`，通过 `--config.electronDist` 指向现有 Electron 31.7.7 缓存 ZIP，exit 0；builder 日志确认 `npmRebuild: false`。本轮无 npm install/rebuild/@electron/rebuild。Vite 有大 chunk 提示。

最终包内 `server/dist` 179 个文件的 SHA-256 与新构建输出一致；asar 内前端和 Electron 两入口与当前构建输出字节相同：前端 `index-C8qc1mmu.js` SHA-256 `14b0e7b78934d7f37f154f820178f028ea1ab7868506675c549123daa298ac6a`，`main.cjs` `ce0cd0a070f6460de8dd41ffc523434d927ec76faef4d004e73c7a75201cea76`，`preload.cjs` `d6b2d3162dccaea6e513db11dc5ee25cd5a7988e52557b8485791ac3506efef4`。源码、构建输出、包的关联基于该轮快照和逐字节比对，不等同独立可复现构建。

## 当前包验证

- `codesign --verify --deep --strict '<app>'` exit 0。包内 `ELECTRON_RUN_AS_NODE=1` 在 `app.asar.unpacked/server` 加载 better-sqlite3、打开 `:memory:`，Electron 31.7.7 / ABI 125，`select 42` 返回 42。
- 打包前后主树 root 与 server 的 Node 24 / ABI 137 均打开 `:memory:` 并返回 42；两份 native 文件 SHA-256 前后均为 `c6fac315df023cf5efec45a3511e6515c6b0f7461a4a284b1b7a79c7ef8febe7`。staging 原生文件为独立实际文件，SHA-256 `aa035da51da3d34a2bcc93ab402a66dc0152ba311a6cd262ea891d7bff5697af`。
- 两个独立 MCP CJS 存在且字符串扫描未发现 `better-sqlite3`、`better_sqlite3`、`.node` 或 `node-gyp`。`kb-mcp.cjs` SHA-256 `84c1b83e3fe6ce37f6e45433ab48c65d2f13ca879925e5db128108b77a748781`；gateway SHA-256 `025b7050d4cffed509819683313b07e7101ad426a2efbeba1b0f4ad0e0fa1bdc`。使用打包 Electron、打包 SDK 和合成 release 执行 `package-mcp-smoke.cjs`，stdio 与回环 HTTP 均列出七工具，`search_knowledge` 命中并以 `get_knowledge` 校验正文；gateway exit 0 被回收。
- 新 DMG 用 `hdiutil attach -readonly -nobrowse -mountpoint` 挂载到独立 `/var/folders/q0/6kr7qkp52b922c7_w47mght80000gn/T/feishu-final-dmg.TfrLE3IW/mount`，签名、asar、两个 CJS 和 native 文件验证通过；整份 app 9,579 条清单与当前 app 完全一致；`hdiutil detach` exit 0，系统 mount 列表再次确认无该挂载。hdiutil 提示其 attach/detach 语法 deprecated，不影响本次结果。
- 新 ZIP 用 `ditto -x -k` 解包到独立 `/var/folders/q0/6kr7qkp52b922c7_w47mght80000gn/T/feishu-final-zip.p8xHwX5j/`；签名、关键文件及完整清单均与当前 app 一致。临时副本保留，未复制到 Applications。
- app 清单复核脚本：`agent-outputs/workflow/20261029-kb-retrieval-mcp/package-verify-app.py '<app>' '/Users/run.mao/feishu-sync-candidate.1cQjnvcc/repack-app-manifest.json'`。当前 app 在介质验证后再次对清单及签名复核通过。

上游反馈（非本轮重跑的完整回归）：`bg-a85e675f` 的 `npm run check && build:all && electron:build` exit 0；原 CIDR FAIL 经上游精确 API/磁盘链路确认为浏览器填空未触发 React 的误报，manager 业务改动已撤回。此前安全审核 PASS 不能自动替代本轮新增补丁的最终安全结论。

## §13.10 A8：真实 standalone 补验

第一次在项目根执行 `node agent-outputs/workflow/20261029-kb-retrieval-mcp/package-standalone-smoke.cjs`，仅对 `127.0.0.1:3001` 做绑定空闲探测，得到 `EADDRINUSE`，exit 1。只读 `lsof` 显示 Node PID 35683 监听该地址；上游随后核实其为主仓 watcher，非本任务进程。未连接、终止或修改该进程，**默认 3001 行为未实测**。

按授权为 helper 增加 `STANDALONE_SMOKE_PORT`；在项目根执行 `STANDALONE_SMOKE_PORT=0 node agent-outputs/workflow/20261029-kb-retrieval-mcp/package-standalone-smoke.cjs`，exit 0。helper 临时探测空闲端口，本次主服务使用 `127.0.0.1:49614`，并将此值经既有 `FEISHU_SYNC_PORT` 传给系统 Node 实际执行的 `server/dist/index.js`。它在发请求前用 `lsof` 确认监听属于刚创建的子进程，未触碰 3001 watcher。实测步骤与结果：

1. 独立临时 `FEISHU_SYNC_HOME` 和合成 release，主 API health 200，初始 gateway 状态 disabled；正式管理 API 启用回环网关后状态 running。
2. MCP SDK 经回环 HTTP 列出七工具，`search_knowledge` 命中合成文档；网关运行期间主 API health 仍为 200。
3. 关闭 SDK 会话，再以管理 API 停用并作废令牌；状态 disabled、reveal 返回 null、网关连接失败。发送 SIGTERM 后 standalone 父进程 exit 0 被回收；`lsof` 复核主服务端口 49614 无监听。
4. 随机 desktop 凭据仅在内存及子进程环境中，不放 argv；stdout/stderr 写独立 0600 日志。日志不直接输出，针对本次 desktop 和 gateway 测试凭据的字面泄漏检查均为 false。临时 fixture/log 路径：`/var/folders/q0/6kr7qkp52b922c7_w47mght80000gn/T/feishu-standalone-smoke-ovk7Fk/`。

helper 显式设置 `NODE_ENV=test`，用于跳过 `server/src/index.ts` 内 `runtimeInstaller.ensureMissing()` 的自动 npm 安装；检索显示此字段在 `server/src` 的唯一用途，但不对依赖内部的环境分支作等价保证。因此此证据覆盖真实 standalone 入口及管理/网关链，不声称默认环境或默认端口完全等价。未访问生产数据、远端模型或全局客户端配置。此验证独立于洛神 GUI 结论。

本轮补验前后主树 root/server 均为 Node ABI 137、`:memory:` 返回 42、native SHA-256 均为 `c6fac315df023cf5efec45a3511e6515c6b0f7461a4a284b1b7a79c7ef8febe7`。481 项源码重新计算仍为 `885c1582db06618660e9d1e092d34b8931579366c470b3e4efe861e548b91f3b`，零差异；当前 app `codesign --verify --deep --strict` 通过，DMG/ZIP hash 仍与当前产物表一致。未重新打包或重签 app，未重新读取整份 app manifest。

本轮未触碰共享 native、未提交、未上传、未公证；新包仅供本机 ad-hoc 交接。保留产物、归档、staging 和独立临时解包；DMG 已正常 detach。

---

# 历史记录：旧候选（仅供溯源，路径可能指向新包，哈希与结论不可套用）

# macOS arm64 本机 ad-hoc 成品及复核报告

## 结论与交接

本机 ad-hoc 成品已构建，最终提交的已记录源码与包构建时快照一致；`.app`、DMG 和 ZIP 的签名、完整性及关键文件已复核。此包未经 Developer ID 签名或公证，**不是正式发布包**；ad-hoc 签名不能保证 Gatekeeper 默认放行。未向系统 Applications 安装，GUI 交互由洛神另行验证，本报告不代签其结论。默认模型配置未修改，也未进行真实模型请求。未提交、上传、公证或使用 Developer ID。

- 主 app：`/Users/run.mao/workpace/feishu-sync/dist-desktop/darwin-arm64/mac-arm64/Feishu Sync.app`
- 打开方式（供后续洛神真实 Electron 交互，不在本轮执行）：`open '/Users/run.mao/workpace/feishu-sync/dist-desktop/darwin-arm64/mac-arm64/Feishu Sync.app'`
- 可复用独立 staging：`/Users/run.mao/feishu-sync-candidate.1cQjnvcc/`；`app/` 为当前打包输入，`prior-package/` 保存第一次候选。另保留最初的 `/private/tmp/feishu-sync-candidate.qyz4Aq4S/`。
- 任务参考输入：`CLAUDE.md`、`scripts/build-desktop-target.cjs`、`electron-builder.config.cjs`、`package.json`、`server/package.json`；Leader 指示整合 `src/components/KbLanMcpSettingsCard.tsx` 及其 test。

## 源与产物指纹

本轮复核主树 HEAD：`c2aca8d2bc4f745dcaf3bd6aecb0a8b0ef1be459`，含祖先 `060c02f504682c4e44e9da946ed9d27a618957a2` 和 `8fba39569ac00c5360c7f934c7735972be7827aa`。当初构建时 HEAD 为 `060c02f...`，生产修改尚在工作树；本轮 475 个已记录文件全部存在于最终提交，`git diff HEAD --` 对已跟踪文件为空，原始路径集合本轮无增减。另有未跟踪的 `server/tests/kb-discuss-integration.test.ts`，未纳入生产构建。原始清单从 `git ls-files -co --exclude-standard` 提取 `src`、`electron`、`server/src`、`server/scripts`、server/root package+lock、builder config、`scripts`、`build`、`index.html`、Vite/TS 配置中存在的 475 个文件，按路径排序，记录各文件 SHA-256 的 UTF-8 JSON：

- 构建前快照（首次检查时，尚未整合最新前端两文件）：`/private/tmp/feishu-sync-candidate.qyz4Aq4S/source-before.json`，文件 SHA-256 `c14ade8e499c885b5fcecedbecb18b40c6f2175bf8fd75b7bc4efeb63f8387d7`。
- 第二次构建前快照：`/Users/run.mao/feishu-sync-candidate.1cQjnvcc/source-after.json`；打包验证时快照：同目录 `source-final.json`。两者字节 SHA-256 均为 `2d786fa817e82ca63e5bf546f4c656d2aceeebe5ae4e3611a487334a12f0e06e`。本轮对相同 475 个路径重新计算，逐项零差异，按相同规则生成的清单 hash 仍为上述值；ignored 资源及额外配置另有下文复核。
- 最新 `src/components/KbLanMcpSettingsCard.tsx`：`6d5a31502cd31721aa6a3a02410df5023b2a4616994731f1f22b790bc49d1590`；其 test：`55d80032b2d7097731df339bd0c2c842904dc0ffee82303bb9a858e42f08430f`。第二次构建后包内前端 JS 与主树新 dist 逐字节相等，SHA-256 `9528871bec2cce10944d2a8627907efd33d07950af1dca48b355aede0bae0c53`。
- `electron-builder.config.cjs`：`6557500d1b02306671c530117c9ae10f965200510aae93efdd68291517affb19`；`server/scripts/build-agent-assets.mjs`：`97b96fbc5490e3627f947e923f09fced4897de9147586001259ce8beb46daef5`；`server/src/mcp/kb-mcp-tools.ts`：`7d9f59aee26524f1af31bc5b63fd5a5152512520ae364d35ff474ef17cc36ce2`；`server/src/mcp/kb-mcp-gateway.ts`：`f8e029ed9a3a95f7c4059b378f1e1b373531b35fcce303b3eae0c57e12a84733`。
- 主树被 ignore 的打包资源，单独记录打包后 hash：`build/icon.icns` `213dad5549212253d8c487b00c2531e49ba376d9022e82738d9eea1efcfd0025`；`build/entitlements.mac.plist` `1a3df1fb7390f5f051e3ca51a02470b7b9a38dc2365609412f07c62fce819c96`；`build/tray-iconTemplate.png` `f0150014d1300ee613cc8cc471ead31c703d23890501c02376c76e2d86b761f3`；`build/tray-iconTemplate@2x.png` `444cabe917ea6b47f2695b6fc91168aff60e2716a1c8de8358f58410bbc9d2fe`。它们未包含在上述 Git 路径清单中，未留构建前比较快照。
- 额外构建输入的打包后 hash（未纳入上述快照，故未证明构建前后不变）：`server/tsconfig.json` `dec55214200921241eb6ab5fffde5a8b4e19dcee42aec80d21b223445f15905b`；`postcss.config.js` `e470ad1ba0c8e72ff28c80a2cbcad88e007e3f4559dca91af5fa2d70178a3638`；`tailwind.config.js` `43a112919c6cb1fb75b8338f39a570ab8b11e34a3b3fcedabf77ecfde929b9e0`；`build/tray-icon.ico` `33030a303d5ee623e3139defe521f3c19fb2a2b869c23366ab1c49887899e2c7`。最终复核须将这些输入一起冻结并重新比对。

| 产物 | 字节 | SHA-256 |
|---|---:|---|
| `dist-desktop/darwin-arm64/FeishuSync-0.3.50-arm64.dmg` | 86,979,388 | `8288a2f32531cbf4ddda38bf83eca5cc97bd4408cbb1f5c40af98eee56bfda8d` |
| `dist-desktop/darwin-arm64/FeishuSync-0.3.50-arm64.zip` | 100,297,352 | `0152862a182b20254954d9be4e87e4ff18b618950e71ade07f08b8bddb1fb8c8` |
| `dist-desktop/darwin-arm64/mac-arm64/Feishu Sync.app` | 普通文件大小合计 241,641,665 | app 是目录，无单一文件字节 hash；完整目录规范化清单 `app-manifest.json` 的 SHA-256：`0122590c4955c970e5e143ab535a53203c1a1c7f9690dce039264a2aa0b11653` |

app 清单位于 staging 根；以相对路径排序记录 9,579 个条目，包含目录的 mode、普通文件的 mode/大小/SHA-256、符号链接目标，JSON 紧凑编码加末尾换行后 hash。它是**清单 hash 而非 app 文件 hash**，不包含扩展属性；签名另外实际校验。

## 构建与异常记录

1. 构建前在主树根目录及 `server/node_modules` 各用系统 Node 24.21.0 打开 `:memory:`，`select 42` 成功，ABI 137；两份 native 二进制 SHA-256 均 `c6fac315df023cf5efec45a3511e6515c6b0f7461a4a284b1b7a79c7ef8febe7`。
2. 主树运行 `npm run build:all && npm run electron:build`（exit 0）。前端新组件在第一份源快照后发生变化，故保留第一次候选与 staging 旧 dist，再对新的源快照重新执行两个构建（exit 0），重新复制新 `dist`、`dist-electron` 和 `server/dist` 并重打。最新 Vite 产物为 `index-CXw_rB5K.js`。Vite 报大于 500 kB chunk 的既有 warning。
3. 初始全新 staging 的 `server/` 从复制的 package+lock 执行 `npm ci --omit=dev --no-audit --no-fund`（exit 0，331 packages），npm cache/devdir 指向独立临时目录。未在主树运行 npm install、npm rebuild 或 electron-rebuild。依赖目录和 better-sqlite3 均为实目录，最终 staging 内模块 realpath 在 staging 内。最终 staging 的 `server/` 下执行主树现成 `/Users/run.mao/workpace/feishu-sync/node_modules/.bin/electron-rebuild -f -w better-sqlite3 -v 31.7.7 -a arm64 -m /Users/run.mao/feishu-sync-candidate.1cQjnvcc/app/server`，exit 0。builder 配置 `npmRebuild: false`，日志确认跳过依赖重建。
4. 按任务规定设置五个 `DESKTOP_*` 变量，采用原 `electron-builder.config.cjs`、`--mac --arm64 --publish never`、ad-hoc 签名。首次 staging 放在 `/tmp` 被 electron-builder 26.15.3 的 unsafe path 防护拒绝：macOS `os.tmpdir()` 实际是 `/var/folders/...`，而 `/private/tmp` 被 denylist 覆盖；原错误保留在运行日志。复制到用户目录下独立 staging 后构建成功，未绕过防护。随后第二轮打包下载 Electron 时 `ECONNRESET`；核实现有本机缓存后，以 `--config.electronDist=/Users/run.mao/Library/Caches/electron/c94f2fc32e1fb05767f75322ea533eeb9828155f017ec184140930a3ec825e81/electron-v31.7.7-darwin-arm64.zip` 指定同版本现有缓存，最终打包 exit 0。缓存 ZIP SHA-256 `e81b75a185376effcc7dd15aef8877ab48474633e5ac7417810a3b28e694bbfa`。此 CLI 参数只改变本次 Electron 来源，未改 config 文件。

## 构建当轮验证（历史证据）

均在仓库根目录执行，除 SQLite 命令按说明进入打包 server；退出码均为 0。

| 验收 | 实际观察 |
|---|---|
| ad-hoc 包签名 | `codesign --verify --deep --strict '<app>'` 通过；并不代表 Gatekeeper 认证或公证。 |
| 包内 SQLite | 在 `<app>/Contents/Resources/app.asar.unpacked/server` 执行 `ELECTRON_RUN_AS_NODE=1 '<app>/Contents/MacOS/Feishu Sync' -e "const B=require('better-sqlite3'); const d=new B(':memory:'); console.log(process.versions.electron,process.versions.modules,d.prepare('select 42 as n').get()); d.close()"`，输出 Electron 31.7.7、ABI 125、`{ n: 42 }`。 |
| 主树 ABI 不变 | 打包后根及 server 两份 Node ABI 137 `:memory:` 都返回 42，native 二进制 hash 与打包前均为 `c6fac315df023cf5efec45a3511e6515c6b0f7461a4a284b1b7a79c7ef8febe7`。 |
| 独立 MCP 文件 | 打包 server 的 `dist/mcp/kb-mcp.cjs` 594,626 bytes，SHA-256 `84c1b83e3fe6ce37f6e45433ab48c65d2f13ca879925e5db128108b77a748781`；`kb-mcp-gateway.cjs` 664,004 bytes，SHA-256 `025b7050d4cffed509819683313b07e7101ad426a2efbeba1b0f4ad0e0fa1bdc`。两者 `rg -i 'better-sqlite3|better_sqlite3|\\.node\\b|node-gyp'` 无匹配；这是静态字符串扫描，不是对任意动态加载的形式证明。 |
| 真实协议及查询 | 用打包 Electron 运行 `package-mcp-smoke.cjs`，加载打包 SDK，启动打包 stdio CJS 和独立 gateway CJS；在 staging 合成 release `fixture-r1` 上均列出 7 个工具，`search_knowledge` 命中 synthetic 文档，`get_knowledge` 验证正文。HTTP 经 `127.0.0.1` 带临时随机凭据成功；不输出凭据；gateway SIGTERM 后 exit 0 被回收，stdio transport 关闭。脚本首次失败源于 fixture 哈希漏写 `sha256:` 前缀，按 `computeSourceHash` 契约修正 fixture 后通过，不涉及产品代码修复。 |
| 打包内容 | 使用 `@electron/asar.extractFile` 逐字节比对新前端 dist 和 Electron 两入口相等；包内 `server/dist` 179 个普通文件与当前构建产物逐字节 SHA-256 比对，零差异。 |

可复现合成 smoke：

```bash
app='/Users/run.mao/workpace/feishu-sync/dist-desktop/darwin-arm64/mac-arm64/Feishu Sync.app'
ELECTRON_RUN_AS_NODE=1 "$app/Contents/MacOS/Feishu Sync" \
  /Users/run.mao/workpace/feishu-sync/agent-outputs/workflow/20261029-kb-retrieval-mcp/package-mcp-smoke.cjs \
  "$app/Contents/Resources/app.asar.unpacked/server" \
  /Users/run.mao/feishu-sync-candidate.1cQjnvcc/synthetic-kb
```

脚本仅写上述合成 KB，不访问生产数据；端口由 OS 临时分配。fixture 和可复用 staging 保留。上述是构建当轮实测，不是本轮重新执行的完整单元测试或 GUI 验证。

## 最终源码与安装介质复核

本轮使用只读检验，未重建、覆盖、重签正在被洛神使用的 app、DMG 或 ZIP。除特别注明的上游信息外，下列命令均在项目根目录执行且退出码为 0。

1. **最终源码**：重新按 `source-final.json` 的 475 个路径逐一读取并算 SHA-256，全部与快照一致；重新以同范围 `git ls-files -co --exclude-standard` 比较，新增/删除路径均为 0。最终提交包含全部 475 条，已跟踪文件相对 HEAD 无差异。清单和 hash 规则同上。`server/tsconfig.json`、`postcss.config.js`、`tailwind.config.js` 和 `build/` 内图标/签名资源分别重新计算，均与上文记录的 8 条 hash 一致；这些额外输入是构建后首次记录，不能单凭此证明它们在构建之前未变化。
2. **资源与实际 bundle**：`Contents/Resources/icon.icns` 和 `Contents/Resources/build/` 内三个托盘资源与当前对应源文件逐项 SHA-256 相同。`codesign -d --entitlements :- '<app>'` 输出与 `build/entitlements.mac.plist` 使用 `plistlib` 解码后字典完全相同，三个键均为 true。TS/PostCSS/Tailwind 配置不以原样文件打包；其当前 hash 与记录一致，不能直接将配置字节与 app 对比。
3. **当前 bundle/runtime**：`python3 /Users/run.mao/feishu-sync-candidate.1cQjnvcc/verify-app-manifest.py '<app>'` 对全部 9,579 条记录重新计算，和构建时规范化清单无差异，普通文件合计 241,641,665 字节，清单 SHA-256 `0122590c4955c970e5e143ab535a53203c1a1c7f9690dce039264a2aa0b11653`；`codesign --verify --deep --strict` 通过。包内 Electron 31.7.7 / ABI 125 打开 `:memory:` 并返回 42。包内 server/dist 179 个文件与当前构建输出逐项一致，asar 内当前前端及 Electron 入口与当前 dist 逐字节一致。以上为源码快照、构建输出和包的链路证据，不是可复现构建证明。
4. **DMG**：`hdiutil attach -readonly -nobrowse -mountpoint '<owned-temp>/mount' '<dmg>'` 只读且不浏览挂载到 `/var/folders/q0/6kr7qkp52b922c7_w47mght80000gn/T/feishu-dmg-check.xjeiYLH3/mount`，`codesign --verify --deep --strict` 通过；asar、两份 MCP CJS、better-sqlite3 native 文件均存在；整份 app 清单与原 app 完全相同。`hdiutil detach '<mount>'` 成功，独立 `mount` 命令 exit 0 且无该 mount 记录。系统提示 hdiutil attach/detach 已 deprecated，但均成功。
5. **ZIP**：`ditto -x -k '<zip>' '<owned-temp>'` 解到 `/var/folders/q0/6kr7qkp52b922c7_w47mght80000gn/T/feishu-zip-check.Mvzup2Z0/`，签名通过、上述关键文件均存在，整份 app 清单与原 app 完全相同。临时解包副本保留在该独立目录；没有复制到系统 Applications 或修改全局配置。
6. **主树 ABI**：本轮前后 root 与 server 的 Node 24 / ABI 137 打开 `:memory:` 均返回 42，两份 native hash 均保持 `c6fac315df023cf5efec45a3511e6515c6b0f7461a4a284b1b7a79c7ef8febe7`。仅只读访问共享 node_modules 做检查，未安装、重建或修改其中内容。DMG、ZIP 的大小与 SHA-256 再算一次，仍与本报告产物表一致。

上游反馈（非本轮重跑或独立审核）：安全审核 `02908e87` PASS；`bg-dbfe5e82` 的完整 `npm run check` exit 0，前端 424 / server 1979 通过、8 skip，lint 0 error / 3 既有 warning。GUI 任务 `b7a9eab9` 正在验证实际 app，其结果待洛神单独出具；本轮未执行真实 GUI、真实客户端或真实模型连接，且未实际安装、未验证 Gatekeeper 默认放行。

## 回滚与保留

没有改产品源码、lock 或模型配置；构建当轮按任务授权刷新过 ignored `dist`、`dist-electron`、`server/dist`，本轮未重新构建。若需回收，仅在获授权后删除本任务创建的 staging/临时目录、`dist-desktop/darwin-arm64/` 产物及报告目录中的本任务 helper/report；不对主树执行 Git reset/clean/restore，不触碰共享 node_modules。最终源码或打包资源如有后续变化，须重审影响并由 Leader 决定重包，不能覆盖正在运行的 app。
