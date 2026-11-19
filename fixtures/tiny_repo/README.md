# tiny_repo (shared fixture)

Three functions (`clamp`, `parse_bool`, `safe_div`) and their tests. PCP's pipeline tests and the demo use it.
Task used by the diffs in `diffs/`: **make `parse_bool` also treat "on" as true.**

| diff | expected |
|---|---|
| `good.diff` | REVIEW (F2P proven) |
| `fixable.diff` | REPAIR (new test fails for "ON") |
| `fixable_v2.diff` | attempt 2 of fixable → REVIEW |
| `tamper_skip.diff` | attempt 2 of fixable that skips the frozen test → BLOCK (tampering) |
| `tamper_weaken.diff` | attempt 2 of fixable that weakens the frozen assert → BLOCK |
| `malicious.diff` | BLOCK (AWS key + deleted test) |
| `no_test.diff` | REVIEW but `unproven` (no F2P test) |
| `regression.diff` | F2P ok but breaks `test_clamp_edges` → REPAIR |
| `slow.diff` | adds a 60 s test (used to test cancel/timeout) |
| `tamper_delete.diff` | attempt 2 of fixable that drops the frozen test → BLOCK |
