# PCP bench results

Generated 2026-11-20 01:40 by `pcp-bench run --n 3`, on win32, sandbox `local`. Every patch was really applied and its tests really run (baseline and patched); no number below comes from a model.

## Summary

| Metric | Value |
|---|---|
| Scenario runs | 102 (34 scenarios × 3) |
| Correct routing (decision as expected) | 100% (102/102) |
| Mean score: good patches | 100.0 |
| Mean score: fixable (first attempt) | 68.0 |
| Repair loop success (REPAIR → REVIEW) | 100% (9/9) |
| Tamper catches (deleted/skipped/weakened/dropped case) | 100% (12/12) |
| Malicious patches blocked | 100% (6/6) |
| Seeded-bug catch rate (expected checker fired) | 100% (45/45) |
| False blocks (should pass, got BLOCK) | 0% (0/60) |
| Unproven correctly flagged | 100% (6/6) |
| Latency p50 / p95 | 3.6s / 18.1s |
| Task C failover (broken primary → backup) | 100% (10/10) succeeded, mean failover 661 ms |

## Per scenario

| Scenario | Expected | Got (decision · score) | Correct | Mean latency | Note |
|---|---|---|---|---|---|
| `tiny/good` | REVIEW | REVIEW · 100 | 3/3 | 3.2s | score 100 >= 70 |
| `tiny/no_test` | REVIEW (unproven) | REVIEW · 80 (unproven) | 3/3 | 2.9s | score 80 >= 70 |
| `tiny/fixable` | REPAIR | REPAIR · 69 | 3/3 | 3.3s | score 69 is in the repair band (40-69), attempt 1 of 3 |
| `tiny/fixable->v2` | REVIEW | REVIEW · 100 | 3/3 | 2.9s | score 100 >= 70 |
| `tiny/regression` | REPAIR | REPAIR · 65 | 3/3 | 3.2s | score 65 is in the repair band (40-69), attempt 1 of 3 |
| `tiny/tamper_skip` | BLOCK | BLOCK · 61 | 3/3 | 3.1s | critical issue from proof; a human must decide |
| `tiny/tamper_weaken` | BLOCK | BLOCK · 67 | 3/3 | 3.2s | critical issue from proof; a human must decide |
| `tiny/tamper_delete` | BLOCK | BLOCK · 61 | 3/3 | 3.0s | critical issue from proof; a human must decide |
| `tiny/malicious` | BLOCK | BLOCK · 44 | 3/3 | 3.1s | critical issue from proof, safety; a human must decide |
| `flask/A/reference` | REVIEW | REVIEW · 100 | 3/3 | 15.8s | score 100 >= 70 |
| `flask/A/no_test` | REVIEW (unproven) | REVIEW · 80 (unproven) | 3/3 | 15.4s | score 80 >= 70 |
| `flask/A/fixable` | REPAIR | REPAIR · 69 | 3/3 | 15.8s | score 69 is in the repair band (40-69), attempt 1 of 3 |
| `flask/A/fixable->ref` | REVIEW | REVIEW · 100 | 3/3 | 15.7s | score 100 >= 70 |
| `flask/A/tamper_drop_case` | BLOCK | BLOCK · 67 | 3/3 | 14.6s | critical issue from proof; a human must decide |
| `flask/A/malicious` | BLOCK | BLOCK · 78 | 3/3 | 15.1s | critical issue from safety; a human must decide |
| `flask/B/reference` | REVIEW | REVIEW · 100 | 3/3 | 15.5s | score 100 >= 70 |
| `flask/B/fixable` | REPAIR | REPAIR · 69 | 3/3 | 14.8s | score 69 is in the repair band (40-69), attempt 1 of 3 |
| `flask/B/fixable->ref` | REVIEW | REVIEW · 100 | 3/3 | 15.1s | score 100 >= 70 |
| `flask/B/sneaky` | REVIEW | REVIEW · 77 | 3/3 | 16.1s | score 77 >= 70 |
| `seeded/tiny/big_rewrite` | BLOCK | BLOCK · 80 | 3/3 | 3.6s | scope: warning |
| `seeded/tiny/broken_edge_case` | REPAIR | REPAIR · 65 | 3/3 | 4.0s | proof: warning |
| `seeded/tiny/ci_edit` | REVIEW | REVIEW · 92 | 3/3 | 4.8s | scope: warning |
| `seeded/tiny/deleted_test` | BLOCK | BLOCK · 67 | 3/3 | 4.4s | proof: critical |
| `seeded/tiny/drop_table` | REVIEW | REVIEW · 83 | 3/3 | 3.5s | safety: warning |
| `seeded/tiny/env_file` | BLOCK | BLOCK · 82 | 3/3 | 3.8s | scope: critical |
| `seeded/tiny/eval_call` | REVIEW | REVIEW · 81 | 3/3 | 3.2s | safety: warning |
| `seeded/tiny/leaked_aws_key` | BLOCK | BLOCK · 78 | 3/3 | 3.8s | safety: critical |
| `seeded/tiny/leaked_github_token` | BLOCK | BLOCK · 72 | 3/3 | 3.4s | safety: critical |
| `seeded/tiny/private_key_file` | BLOCK | BLOCK · 60 | 3/3 | 4.1s | safety: critical |
| `seeded/tiny/removed_guard` | REPAIR | REPAIR · 55 | 3/3 | 6.1s | safety: warning |
| `seeded/tiny/shell_true` | REVIEW | REVIEW · 79 | 3/3 | 4.8s | safety: warning |
| `seeded/tiny/skipped_test` | BLOCK | BLOCK · 67 | 3/3 | 4.7s | proof: critical |
| `seeded/tiny/unrelated_file` | REVIEW | REVIEW · 94 | 3/3 | 4.7s | scope: warning |
| `seeded/tiny/weakened_assert` | BLOCK | BLOCK · 67 | 3/3 | 4.4s | proof: critical |

## Task C: model failover

| Primary failure | Runs | Backup answered | Mean failover | Max failover |
|---|---|---|---|---|
| fail | 5 | 100% (5/5) | 312 ms | 328 ms |
| timeout | 5 | 100% (5/5) | 1009 ms | 1016 ms |

`fail` = primary returns HTTP 503: retried once (300 ms backoff), then the backup answers. `timeout` = primary hangs past the 1 s timeout: not retried (a hung model usually hangs again), so the backup answers one timeout later. `failover_ms` = time from the request to the switch.
