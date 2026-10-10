# MCP 资料核对交互：本地验证记录

日期：2026-10-07。范围：共享阅读草稿、工作台参考适配器、可选合成 MCP App。没有医院真实患者输入、实际模型核对、部署或临床投放。

| 检查 | 结果 | 解释 |
|---|---|---|
| 定向 Node 测试 | 21/21 PASS | 会话隔离、PHI、修订/重复/过期、工作台迟到响应、宿主能力/消息/上下文、实际 stdio 资源与工具通道 |
| 完整门禁 | 75/75 步骤完成，0 失败 | 62 项工程检查通过；13 项报告脚本完成。报告执行不是临床终点评价成功 |
| JSON 契约与技能校验 | PASS | `validate-json.mjs`、`validate-skills.mjs` |
| 浏览器模拟 | PASS | 已安装 Chrome + Playwright；1280×960、390×844；无横向溢出、无页面错误；选中范围、存疑、问题保存、上下文与消息操作通过 |
| 外部插件校验器 | NOT_RUN / FILE_MISSING | AGENTS 指定的 `C:/Users/13264/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py` 不存在；本地 skills/plugins 检索未找到替代文件；未自动安装 |
| 原生宿主验收 | NOT_RUN | 浏览器测试宿主是本地模拟，不能证明 Codex/ChatGPT 安装、入口展示或模型行为 |
| 医生收益与临床证据 | NOT_ESTABLISHED / BLOCKED | 未执行真实医生任务研究或独立临床评价 |

完整门禁记录：`out/quality-gates-0d89bf04-c6be-4b23-9810-b415a5d47b9b.json`；完成时间 `2026-10-07T07:45:53.401Z`。日志：`out/mcp-review-full-checks.log`。这些是本地生成产物，不作为已批准的受控临床证据。

浏览器记录：`out/review-app/browser-check.json`，截图 `desktop.png`、`mobile.png`。模拟只返回消息接收回执，没有模型响应。未修改默认产品 manifest 或用户宿主配置。

第一次完整执行有 7 项受沙箱本机回环连接限制影响（`EACCES 127.0.0.1` 及其派生探针错误）；允许本机测试连接后的最终完整执行通过。浏览器测试包装页的字符编码问题已修正为显式 UTF-8，最终检查通过。

上游研究使用公开 GitHub 资料及免费能力搜索，没有付费服务调用。协议来源、实现选择及真实部署前尚需完成的工作见 [交互设计说明](../mcp-extension-clinician-interaction.md)。
