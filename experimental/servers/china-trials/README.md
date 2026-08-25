# mcp-server-china-trials

本地中国药物临床试验登记**摘录库**。不是 chinadrugtrials.org.cn 全库镜像，本仓库不附带官方登记数据。

```bash
node plugins/medcius/servers/china-trials/scripts/ingest.mjs --sample
node plugins/medcius/servers/china-trials/scripts/ingest.mjs path/to/trials.json
```

工具：`search_trials` / `get_trial` / `validate_ctr_format` / `corpus_status`。`not_in_corpus` 与格式错误都不得编造方案。
