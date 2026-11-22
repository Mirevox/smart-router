# Verification & Smoke Screen Report — `smart-router`

| Field | Value |
| --- | --- |
| **Module** | `Mirevox/smart-router` (`@mirevox/smart-router`) |
| **Package Version** | `0.1.0` |
| **Verification Status** | **VERIFIED** |
| **Verified At (UTC)** | `2026-11-22T21:11:27Z` |
| **Environment** | Node `v22.14.0`, TypeScript compiler, Docker `linux/amd64` (`sherali` Docker Engine `29.8.1`) |

## Automated Typecheck & Test Suite

- `tsc -p tsconfig.json --noEmit` and `tsc -p tsconfig.json`: **PASS** (exit `0`)
- `node --import tsx --test test/*.test.ts`: **PASS (47/47 tests across 8 suites, 0 failed)**

```text
# tests 47
# suites 8
# pass 47
# fail 0
```

## Guardrails & Live E2E Smoke Tests

1. **Loop Detector (`>3` identical tool calls):**
   `Statuses=[200, 200, 200, 429], 4th_code=LOOP_CIRCUIT_BREAKER, logged_events=1`
2. **Per-Task Budget Cap Hard Stop:**
   `HTTP 402, code=BUDGET_CAP_EXCEEDED`
3. **Context Exhaustion Alert (`>=80%` window):**
   `HTTP 200, usage_ratio=0.85, header=compaction_triggered`
4. **Trace ID Propagation (`smart-router` -> `data-lineage` `/v1/trace` & `evals` `/api/capture/webhook`):**
   `HTTP 200, router.mirevox.trace_id=trace-audit-e2e-2026, lineage_edges=5, evals_turns_matching=1`

## Container & Hygiene Verification

- Standalone Linux/x64 Docker image built cleanly: `mirevox/smart-router:x64-verify bda7ab16eb75 271MB`
- Workspace hygiene & security scan: `repos=9, all_docs_license_compose=True, hardcoded_paths=0, secret_hits=0, src_todo_hits=0`

## Reproduce Locally

```bash
npm run typecheck && npm run build && npm test
```
