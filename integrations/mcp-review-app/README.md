# 可选 MCP 资料核对面板

这是合成资料交互评估入口，不连接医院患者、FHIR 凭据或 EHR 写入。默认产品 manifest 没有启用它，也未修改用户的宿主配置。

1. 使用 Node.js 22 或更高版本，将 `mcp.example.json` 的占位路径换成实际检出的 `plugins/medcius/servers/review-app/src/index.mjs` 绝对路径。
2. 在支持 MCP Apps 的开发宿主中注册该 stdio 服务。宿主支持 OpenAI 扩展时，可以从全局或会话入口手动打开“Medcius 资料核对”。入口可用性与固定到侧栏由宿主决定。
3. 从内置的血钾更正记录开始：展开依据 → 列入重点 → 标记存疑维度 → 保存问题 → 预览请求。
4. “放入对话上下文”仅附加所选资料；“提交所选问题”会立即向当前对话发送消息。必须由用户明确点击。宿主不提供对应能力时，按钮不可用。

`NODE_ENV=production`、`MEDCIUS_PROFILE=production` 或临床落地模式下所有工具拒绝执行。本面板的默认身份明确是合成交互身份，不是医院目录身份。App-only 可见性不构成人员身份认证，不能用它证明某位医生作出过临床决定。

草稿只保存在服务进程内，固定 30 分钟过期；最多 100 个会话、每会话 500 次操作，最多同时选择 12 个条目。未部署持久保存、真实患者切换或临床签核。消息回执仅代表发送，不代表模型已完成或医生已接受。提交结果不明时不要盲目重发，先检查当前对话。

## 本地验证

```powershell
node --test tests/test-clinician-review-session.mjs tests/test-review-app.mjs tests/test-doctor-ui.mjs
```

可选浏览器模拟需要已经安装的 Playwright（不自动下载）。设置 `MEDCIUS_PLAYWRIGHT_PACKAGE` 为安装目录，再执行 `node scripts/verify-review-app-browser.mjs`。截图和记录写入 `out/review-app/`。模拟宿主不调用模型，不构成 Codex/ChatGPT 原生宿主验收。

也可用 `MEDCIUS_BROWSER_EXECUTABLE` 指定已经安装的 Chrome 可执行文件，无须下载浏览器。

原生宿主验收仍需逐项检查：空参数入口、首次结果只渲染一次、窄屏与键盘、上下文附加/移除/重挂载、能力缺失、消息超时、断线恢复，以及宿主升级后的协议兼容性。临床使用另需院方批准部署边界、身份权限、独立有效性评价、真实工作流验证与持久审计，不能从本地模拟推导。

设计取舍与上游版本见 [MCP 扩展交互设计](../../docs/mcp-extension-clinician-interaction.md)。
