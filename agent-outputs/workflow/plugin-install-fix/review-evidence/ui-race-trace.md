# UI 错误竞态：静态调用链证据（未做浏览器复现）

定位：`src/components/settings/BuildOrchestrationSettings.tsx:328-350, 811, 828-844`。

1. 挂载 / 手工刷新调用 `loadRuntime()`，GET A 挂起，`runtimeSeqRef` 为 n。
2. 安装入口不因 `runtimeLoading` 禁用（仅安装 busy/unwired 等），用户提交安装；如坏本地路径，POST 很快 400。
3. `install()` catch（842）把本次错误放入 `installError`；失败不调用 `onInstalled()`，所以不增加 GET 序号。
4. 先前 GET A 后到，其序号仍等于 n，`then` 合法执行 `setRuntimeStatus(dto)`。
5. 新增 effect（811）因 status 对象变更无条件清空 `installError`，本次刚出现的安装错误被旧请求结果抹掉。

这不推翻 GET-vs-GET latest-request-wins 的已修复结论；它是 GET-vs-安装错误的另一条因果链。已有最新响应单测只涵盖安装成功后第二个 GET；未覆盖此失败时序。

最小方向：清错保留在用户刷新动作和新安装动作/安装成功上，不因任意 status 引用变化清错；或跨 GET/安装请求共享操作代次，防止安装前发出的 GET 清除安装后的错误。
