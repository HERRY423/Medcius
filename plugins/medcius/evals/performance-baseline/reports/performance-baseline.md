# 性能基线报告（Performance Baseline）

> **用途**：记录关键路径在当前机器上的延迟基线并作为 CI 回归门禁。预算值为稳定性上限（约典型值的 ~10 倍），不是 SLO；超出基线报告的显著回退即使在预算内也应人工评审。

- 环境：Node v24.13.0 / win32 x64 / 14 vCPU
- 预算系数：MEDCIUS_PERF_BUDGET_FACTOR=1（仅吸收慢 CI 机，强制 >=1）

| 基准 | 迭代 | 平均 (ms/op) | p50 | p95 | ops/s | 预算 (ms) | 结果 |
|---|---|---|---|---|---|---|---|
| bridge_snapshot | 200 | 0.056 | 0.056 | 0.056 | 17922 | 20.00 | ✅ |
| preround_workflow | 100 | 0.186 | 0.186 | 0.186 | 5382 | 80.00 | ✅ |
| phiguard_pseudonymize | 500 | 0.019 | 0.014 | 0.032 | 53481 | 3.00 | ✅ |
| audit_crypto_chain | 2000 | 0.004 | 0.003 | 0.003 | 268298 | 0.50 | ✅ |
| public_ref_reviewer | 500 | 0.010 | 0.007 | 0.018 | 105124 | 2.00 | ✅ |

- 门禁结果：✅ ALL WITHIN BUDGET
