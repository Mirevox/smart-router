# Acceptance — Smart Router v0.1

Date: 2026-11-20  
Against: `docs/requirements.md` (vetted lock) + shipped code at repo root  
Verifier: orchestrator + automated `npm test` / `npm run typecheck` / live curl

## Verdict

**Accept v0.1 stub** for the locked scope. Fail-closed residency, streaming, live SDKs, and LiteLLM wrap remain deferred (documented).

## Evidence matrix

| ID / Capability | Result | Evidence |
| --- | --- | --- |
| Gateway boots + `/health` | PASS | `curl http://127.0.0.1:18765/health` → `status: ok` |
| Bearer auth 401 | PASS | `test/gateway.test.ts` |
| `GET /v1/models` from registry | PASS | gateway + registry tests |
| `POST /v1/chat/completions` + `mirevox` metadata | PASS | gateway test; stub echo |
| `stream: true` → 501 | PASS | implemented in gateway |
| Key vault CRUD without secret leak | PASS | `test/vault.test.ts` |
| Activity/model routing | PASS | `test/policy.test.ts` |
| Fan-out parallel + order | PASS | `test/fanout.test.ts` |
| Registry poll Foundry/Bedrock/Vertex/local/MCP | PASS | `test/registry.test.ts` |
| Typecheck + build | PASS | `tsc --noEmit`, `npm run build` |
| Docker Compose packaging | PASS (files present) | `Dockerfile`, `docker-compose.yml` — image build not run here (no docker daemon) |
| Fail-closed onprem deny | DEFER v0.2 | policy resolves placement but does not 403 cloud backends |
| Live provider calls | DEFER | stub adapters only |
| SSE streaming | DEFER / cut v0.1 | 501 |

## Commands

```bash
npm test          # 14 passing
npm run typecheck
npm run build
npm run dev       # :18765
```

## Gaps carried forward

1. Grant Cursor GitHub App access to `Mirevox/smart-router` so authenticated push works.
2. v0.2: fail-closed residency, structured egress log, optional LiteLLM backend delegation.
3. Live adapters after credentials exist.
