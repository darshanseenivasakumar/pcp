# PCP bench results

Generated 2026-11-16 00:36 by `pcp-bench run --n 3`, on win32, sandbox `local`. Every patch was really applied and its tests really run (baseline and patched); no number below comes from a model.

## Summary

| Metric | Value |
|---|---|
| Scenario runs | 57 (19 scenarios × 3) |
| Correct routing (decision as expected) | 100% (57/57) |
| Mean score: good patches | 100.0 |
| Mean score: fixable (first attempt) | 68.0 |
| Repair loop success (REPAIR → REVIEW) | 100% (9/9) |
| Tamper catches (deleted/skipped/weakened/dropped case) | 100% (12/12) |
| Malicious patches blocked | 100% (6/6) |
| Seeded-bug catch rate (expected checker fired) | n/a |
| False blocks (should pass, got BLOCK) | 0% (0/39) |
| Unproven correctly flagged | 100% (6/6) |
| Latency p50 / p95 | 11.1s / 11.9s |
| Task C failover (broken primary → backup) | 100% (10/10) succeeded, mean failover 1322 ms |

## Per scenario

| Scenario | Expected | Got (decision · score) | Correct | Mean latency | Note |
|---|---|---|---|---|---|
| `tiny/good` | REVIEW | REVIEW · 100 | 3/3 | 2.9s | score 100 >= 70 |
| `tiny/no_test` | REVIEW (unproven) | REVIEW · 80 (unproven) | 3/3 | 2.5s | score 80 >= 70 |
| `tiny/fixable` | REPAIR | REPAIR · 69 | 3/3 | 2.8s | score 69 is in the repair band (40-69), attempt 1 of 3 |
| `tiny/fixable->v2` | REVIEW | REVIEW · 100 | 3/3 | 2.6s | score 100 >= 70 |
| `tiny/regression` | REPAIR | REPAIR · 65 | 3/3 | 2.8s | score 65 is in the repair band (40-69), attempt 1 of 3 |
| `tiny/tamper_skip` | BLOCK | BLOCK · 61 | 3/3 | 2.7s | critical issue from proof; a human must decide |
| `tiny/tamper_weaken` | BLOCK | BLOCK · 67 | 3/3 | 2.7s | critical issue from proof; a human must decide |
| `tiny/tamper_delete` | BLOCK | BLOCK · 61 | 3/3 | 2.6s | critical issue from proof; a human must decide |
| `tiny/malicious` | BLOCK | BLOCK · 44 | 3/3 | 2.6s | critical issue from proof, safety; a human must decide |
| `flask/A/reference` | REVIEW | REVIEW · 100 | 3/3 | 11.4s | score 100 >= 70 |
| `flask/A/no_test` | REVIEW (unproven) | REVIEW · 80 (unproven) | 3/3 | 11.2s | score 80 >= 70 |
| `flask/A/fixable` | REPAIR | REPAIR · 69 | 3/3 | 11.5s | score 69 is in the repair band (40-69), attempt 1 of 3 |
| `flask/A/fixable->ref` | REVIEW | REVIEW · 100 | 3/3 | 11.6s | score 100 >= 70 |
| `flask/A/tamper_drop_case` | BLOCK | BLOCK · 67 | 3/3 | 11.4s | critical issue from proof; a human must decide |
| `flask/A/malicious` | BLOCK | BLOCK · 78 | 3/3 | 11.2s | critical issue from safety; a human must decide |
| `flask/B/reference` | REVIEW | REVIEW · 100 | 3/3 | 11.4s | score 100 >= 70 |
| `flask/B/fixable` | REPAIR | REPAIR · 69 | 3/3 | 11.5s | score 69 is in the repair band (40-69), attempt 1 of 3 |
| `flask/B/fixable->ref` | REVIEW | REVIEW · 100 | 3/3 | 11.5s | score 100 >= 70 |
| `flask/B/sneaky` | REVIEW | REVIEW · 77 | 3/3 | 11.8s | score 77 >= 70 |

## Task C: model failover

| Primary failure | Runs | Backup answered | Mean failover | Max failover |
|---|---|---|---|---|
| fail | 5 | 100% (5/5) | 309 ms | 313 ms |
| timeout | 5 | 100% (5/5) | 2334 ms | 2344 ms |

`fail` = primary returns HTTP 503; `timeout` = primary hangs past the 1 s timeout. The gateway retries the primary once (300 ms backoff) and then switches to the backup; `failover_ms` is the time from the request to the switch.
