# 性能基线报告（Performance Baseline）

> **用途**：记录关键路径在当前机器上的延迟基线并作为 CI 回归门禁。预算值为稳定性上限（约典型值的 ~10 倍），不是 SLO；超出基线报告的显著回退即使在预算内也应人工评审。

- 环境：Node v24.13.0 / win32 x64 / 14 vCPU
- 预算系数：MEDCIUS_PERF_BUDGET_FACTOR=1（固定为 1；查房门槛固定 80 ms）

| 基准 | 迭代 | 平均 (ms/op) | p50 | p95 | ops/s | 预算 (ms) | 结果 |
|---|---|---|---|---|---|---|---|
| bridge_snapshot | 200 | 0.075 | 0.061 | 0.169 | 13399 | 20.00 | ✅ |
| preround_workflow | 100 | 80.880 | 76.711 | 108.946 | 12 | 80.00 | ❌ |
| phiguard_pseudonymize | 500 | 0.030 | 0.027 | 0.041 | 33517 | 3.00 | ✅ |
| audit_crypto_chain | 2000 | 0.004 | 0.003 | 0.004 | 274925 | 0.50 | ✅ |
| public_ref_reviewer | 500 | 0.008 | 0.006 | 0.014 | 133071 | 2.00 | ✅ |

- 门禁结果：❌ 1 benchmark(s) over budget
