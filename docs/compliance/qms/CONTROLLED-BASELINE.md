# 受控文件工程基线

> Product baseline: 0.8.0-pilot; document revision: 1; approval: DRAFT_UNAPPROVED


当前产品版本取自 `plugins/medcius/plugin.json`；三种宿主清单必须一致。
`controlled-documents.json` 记录当前适用文件、文档修订、LF归一化内容哈希及组件版本。修改受控文件时同时提交内容差异、修订号与登记哈希；CI只检查，不自动重封存。

此登记是工程配置基线，`approval_status: DRAFT_UNAPPROVED`。尚无具名签署的QMS批准，不把哈希、Git提交或自动化结果称为医院/监管批准。

产品 `0.8.0-pilot` 与私有服务包 `0.0.1` 使用不同版本域：产品版本描述插件组合，服务包版本是各组件的内部协议/封装版本。当前组件版本在登记中逐项固定，不自动随产品升级；组件接口变更需单独修订并检查MCP契约。历史审核记录不回写新版本，也不作为当前基线。

生成的新工程记录应携带运行时间、版本、输入和输出标识。工程检查、合成执行、合成终点、临床证据、正式审批分别判定。
