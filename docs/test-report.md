# Test report — Smart Router v0.1

**Command:** `npm test`  
**Result:** **40/40 pass** (6 suites) in ~0.5s (was ~60s before fan-out timer clear)  
**Typecheck / build:** green

## Suites

| Suite | Notes |
| --- | --- |
| policy | model/activity routing |
| vault | CRUD, env override, `0o600` mode |
| fanout | order, parallelism, timeouts |
| gateway | Bearer auth, JSON 404/400, stub honesty, fan-out validation, admin |
| registry | poll stubs + lifecycle |
| gateway auth/health edges | open mode, pre-poll health |

## Acceptance deltas covered

D-01 Bearer scheme · D-02 JSON 404/400 · D-03 stub always true · D-04 tasks array + clearTimeout · D-05 vault mode
