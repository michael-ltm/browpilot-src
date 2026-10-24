# 2026-09-24：页签占用排查与 stdio 生命周期修复

## 现场结论

Dev 2 的“新世界”页签报告 `leased by another session`。排查确认两个独立事实，不能将它们合并成同一根因：

1. **确有 stdio 生命周期缺陷。** SDK 的 StdioServerTransport 监听 data/error，但不以 stdin EOF 触发自身 close；原入口只在 SDK onclose 时 dispose。调用方退出后，broker WebSocket 和重连资源仍能让 MCP 进程存活，已经持有的 lease 也不会释放。
2. **本次目标页仍属于一个连接未断开的会话。** 清理孤立进程后，broker 的只读诊断仍将目标 lease 映射到本地端口 42032 → MCP PID 3299518 → Codex PID 3299303。该 Codex 位于 `/dev/pts/9`，cwd `/home/ming`；MCP stdin 未收到挂断。检查时 broker pending 为 0，但不能据此认定该调用方任务已结束。

另一个误导现象是 `browser_list_instances` 报未选择 profile。运行中的 broker PID 3015 自 9 月 11 日启动，早于磁盘上 9 月 12 日的构建。重选 Dev 2 成功、指定 profile 的 tabs 查询也成功；不能将该旧服务响应当成 profile 选择未生效的证据。没有为此重启共享 broker，以免清除其他活动会话的状态。

## 修改

- 新增 `packages/mcp-server/src/stdio.ts`，统一在 stdin end/close/error、stdout error/close 和 SDK onclose 时关闭本 MCP server，并释放 broker/developer 资源。
- 关闭 Promise 先登记，确保多个关闭事件和 onclose 递归只执行一次清理；`finally` 保证 SDK close 抛错后仍执行 dispose。
- 连接前已结束或销毁的流在 connect 后再次检查；异步 dispose 完成前 close 不返回。
- `packages/mcp-server/src/index.ts` 的 stdio 入口使用该方法。HTTP MCP 生命周期未改动。
- 不取消 lease 隔离，不增加强制抢占或全局锁清理。

## 验证

- 从原入口提取相同 stdio 行为后，EOF、输入销毁、输出 EPIPE 三项测试失败：dispose 次数为 0，锁未释放；EPIPE 同时暴露未处理流错误。
- 修复后 5 项 stdio 测试通过，覆盖 EOF 释放原会话锁且保留另一活动会话锁、输入销毁、EPIPE、并发关闭、异步清理。
- `npm run typecheck && npm test && npm run build` 通过；52 个测试文件、342 项测试。
- 独立只读审查通过，并使用临时 Vitest 配置复跑 5 项测试通过。
- 最终构建的真实 MCP 子进程初始化、查询实际 broker profiles 成功；关闭 stdin 后 16ms 自然退出，exit code 0，无 signal。没有调用页面控制工具。

## 已执行的现场清理与边界

- 精确筛选入口路径完全匹配、无额外参数、ppid=1、stdin 为 pipe 且 poll 确认 POLLHUP、再次核对进程启动身份一致的孤立 MCP；共向 56 个进程发送 SIGTERM。
- 保留其他活动 MCP、broker、浏览器和页面。清理后目标页仍被上述活动连接持有，因此不能声称本次目标页已恢复。
- 为只读映射 lease 所有者临时开启 broker 的本机 Node inspector，读取 lease 与 agent socket 端口；没有修改 lease、暂停浏览器或读取账号凭据。完成后关闭 inspector。
- 新构建适用于后续启动的 MCP。已运行的旧 MCP 不会自动热更新；没有终止仍有调用方的会话。
- 已请求用户确认 `/dev/pts/9` 的会话是否已不再使用该页，再决定是否释放这一个目标页的锁。

未提交 Git、未发布版本；仓库已有未提交修改均保留。


## 用户确认后的单页恢复

用户确认旧会话不再使用新世界页后，重新核对目标锁仍属于端口42032，且目标页无请求在途，仅删除 Dev 2 的 tab1917673672 lease并同步计数，其他22把锁保留。随后同一Browpilot工具成功取得新世界snapshot及原生Egret内存信息，登录保持。没有终止仍连接的旧Codex会话或重启共享broker。临时inspector已关闭。
