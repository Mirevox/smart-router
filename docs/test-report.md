# Test report — Smart Router v0.1

**Command:** `npm test`  
**Result:** **40/40 pass** (6 suites) in ~0.5s  
**Typecheck / build:** green

## Suites

| Suite | Notes |
| --- | --- |
| policy | model/activity routing |
| vault | CRUD, env override, `0o600` mode |
| fanout | order, parallelism, timeouts + `clearTimeout` |
| gateway | Bearer auth, JSON 404/400, stub honesty, fan-out validation, admin |
| registry | poll stubs + lifecycle; `stub: true` even with key + `STUB_MODE=0` |
| gateway auth/health edges | open mode, pre-poll health |

## Acceptance deltas covered

D-01 Bearer scheme · D-02 JSON 404/400 · D-03 stub always true · D-04 tasks array + clearTimeout · D-05 vault mode

## Validation-wave honesty (2026-11-20)

| Check | Result |
| --- | --- |
| Stub flag leak (`NFR-04`) | Fixed — registry/policy always `stub: true` in v0.1 |
| Docker Compose (`NFR-06`) | **UNVERIFIED** on agent VM (no daemon); Dockerfile/Compose static OK |
| `config.ts` unit suite | Not present (manual smoke only) |
