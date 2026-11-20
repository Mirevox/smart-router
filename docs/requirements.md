# Mirevox Smart Router — Requirements & FR/NFR Specification (v0.1 Locked)

- **Package / Repo:** `@mirevox/smart-router` v`0.1.0` (`https://github.com/Mirevox/smart-router`)
- **License:** Apache-2.0
- **Status:** Vetted & Locked (v0.1 Runnable Stub)
- **Implementation Stack:** TypeScript (`strict`), Hono (`@hono/node-server`), Node.js `>= 20`, YAML (`yaml`), Docker Compose (`node:22-alpine`)

> **Honest v0.1 Baseline:** Smart Router v0.1 is a **Mirevox-owned stub gateway**. HTTP routing, Bearer authentication, file/env key storage, activity/pattern routing resolution, bounded parallel fan-out orchestration, and periodic registry polling are implemented for real; upstream inference (`src/backends/stub.ts`) and discovery catalogs (`src/registry/providers.ts`) are deterministic stubs explicitly tagged `stub: true`. The adversarial recommendation in `docs/devils-advocate.md` to wrap LiteLLM (or Bifrost) instead of owning a gateway is recorded as a **deferred v0.2+ alternative** (backend delegation behind `src/backends/`); v0.1 requirements are locked to the shipped Hono stub APIs.

---

## 1. Stub vs. Live Implementation Truth Table

| Subsystem | v0.1 Status | Code Surface | What Is Live (Real) | What Is Stubbed or Deferred |
| --- | --- | --- | --- | --- |
| **HTTP Gateway & Auth** | **Live** | `src/gateway/openai.ts` | Hono HTTP server on `:18765`, Bearer auth middleware (`SMART_ROUTER_API_KEY`, open-dev mode when empty), unauthenticated `/` and `/health`, OpenAI-style error JSON `{ error: { message, type } }`. | Single shared key for `/v1/*` and `/admin/*` (separate client/admin tokens deferred). `stream: true` returns `501`. |
| **Chat Completions** | **Stub** | `POST /v1/chat/completions`, `src/backends/stub.ts` | Validates `model` and `messages[]`, resolves policy, returns OpenAI `chat.completion` JSON with inline `mirevox` routing block. | `stubComplete()` echoes last user message with `[mirevox-stub/<backend>]`, approximates tokens (`ceil(chars/4)`), adds 5–24 ms jitter. Zero live provider calls. |
| **Model Listing** | **Live wrapper / Stub data** | `GET /v1/models`, `src/registry/providers.ts` | Aggregates enabled providers from `DiscoveryRegistry` into OpenAI `{ object: "list", data }` format. | Populated from static `STUB_CATALOG` per `ProviderKind` (`foundry`, `bedrock`, `vertex`, `local`, `mcp`, `mock`), tagged `stub: true`. |
| **Central Key Vault** | **Live (local file + env)** | `src/vault/key-vault.ts`, `/admin/keys` | Plaintext JSON persistence (`./data/vault.json`, mode `0o600`), clean boot if absent, `SMART_ROUTER_KEY_<BACKEND>` env override, CRUD API, secret redaction on list (`has_secret: boolean`). | Not encrypted KMS/HSM; stores one secret string per entry (AWS SigV4, Google ADC, Azure Entra deferred). |
| **Routing Policy** | **Live (preference resolver)** | `src/router/policy.ts`, `GET /admin/routes` | Declarative YAML `activities` (`chat`, `code`, `embed`, `tool`), `default_placement`, prefix-glob `model_routes`, `fallback_backend`, per-request overrides, `onprem` fallback nudge to `local-ollama` for `code`. | **Not yet a fail-closed `403` deny gate** for explicit cloud models requested under an `onprem` activity; no live retry/fallback loop yet. Promoted to v0.2 gate `H-01`. |
| **Task-Split Fan-Out** | **Live orchestrator / Stub tasks** | `POST /v1/fanout`, `src/fanout/splitter.ts` | Explicit non-OpenAI endpoint; bounded worker pool (`fanout.max_parallel`, default `8`); independent per-task policy; per-task timeout race (`timeout_ms`, default `60000`); per-task error isolation; strict input-order preservation. | Executes `stubComplete()`. No `max_tasks` payload cap yet; timeout handle cleanup on fast completion tracked as v0.2 fix `H-02`. |
| **Discovery & Polling Registry** | **Live loop / Stub catalogs** | `src/registry/providers.ts`, `/admin/registry*` | 7 configured providers across 6 kinds, immediate startup poll + `setInterval` (`30000 ms`, `.unref()`'d), on-demand `POST /admin/registry/poll`, status inspection via `GET /admin/registry`. | Static `STUB_CATALOG` only; zero outbound HTTP probes; no runtime entry CRUD or staleness eviction in v0.1. |
| **Health & Packaging** | **Live** | `GET /`, `GET /health`, `Dockerfile`, `docker-compose.yml` | Unauthenticated `/health` returning provider status summary; graceful `SIGINT`/`SIGTERM` shutdown; multi-stage `node:22-alpine` Compose setup with persistent `router-data` volume. | Single `/health` route (no `/healthz` + `/readyz` split). Structured JSON egress audit log deferred to v0.2 (`H-04`). |

---

## 2. Council Cuts & Devil's Advocate Disposition

Draft ambitions that created false claims or unsafe surface were cut during vetting, incorporating the valid critiques from `docs/devils-advocate.md`:

| Topic | Disposition | Rationale & v0.1 Boundary |
| --- | --- | --- |
| **LiteLLM / Bifrost wrapper vs. owned Hono gateway** | **Owned Hono kept for v0.1; LiteLLM wrap deferred to v0.2+** | Hono stub (~450 LOC, 40 passing tests) locks Mirevox's exact extension contracts (`POST /v1/fanout`, `/admin/*`, activity placement). Delegating live cloud providers to LiteLLM/Bifrost behind `src/backends/` remains the preferred v0.2+ option instead of rewriting 50+ SDKs. |
| **Implicit task splitting inside `/v1/chat/completions`** | **Cut (DA agreed)** | Preserves single-route OpenAI client compatibility. Explicit fan-out lives solely on `POST /v1/fanout`. |
| **Workflow-by-reference URL fetch & MCP stdio execution** | **Cut (DA agreed)** | Eliminates SSRF and RCE risks. MCP appears only as a static stub catalog entry in v0.1. |
| **Auto-onboarding arbitrary polled endpoints** | **Cut (DA agreed)** | Providers are declared statically in `config/default.yaml`; no silent unreviewed route injection. |
| **Vault encryption passphrase in env / KMS / UI** | **Cut (DA agreed)** | Avoids security theater. `KeyVault` is honestly documented as a `0o600` local JSON file + env override. |
| **SSE streaming (`stream: true`)** | **Cut from v0.1** | Explicitly returns HTTP `501` (`"streaming not implemented in v0.1 stub"`). |
| **n8n, Instagram, Sherali homelab, Web UI, bundled evals/lineage** | **Permanently out of scope** | Separate repositories / non-goals. |

---

## 3. Functional Requirements (v0.1 Locked)

| ID | Category | Mode | Requirement | Measurable Exit Criterion | Verification |
| --- | --- | --- | --- | --- | --- |
| **`FR-01`** | Chat Completions | Stub exec / Live contract | `POST /v1/chat/completions` accepts `{ model, messages, temperature?, stream?, max_tokens?, activity?, placement?, backend? }`, evaluates `RoutingPolicy`, and returns an OpenAI `chat.completion` with a `mirevox` metadata block. | HTTP `200`; `id` matches `/^chatcmpl_[0-9a-f]{24}$/`, `object === "chat.completion"`, `model === req.model`, `choices[0].message.role === "assistant"`, content includes `[mirevox-stub/<backend>]` and user prompt echo (<= 500 chars), `finish_reason === "stop"`, `usage.total_tokens === prompt_tokens + completion_tokens`, `mirevox.{backend, placement, activity, stub: true}`. | `test/gateway.test.ts` + `curl` |
| **`FR-02`** | Validation & Streaming Guard | Live | `POST /v1/chat/completions` rejects missing required fields and refuses unsupported streaming explicitly. | Missing `model` or non-array `messages` -> `400` (`"model and messages are required"`). `stream: true` -> `501` (`"streaming not implemented in v0.1 stub"`). | Gateway integration test |
| **`FR-03`** | Model Catalog | Stub data / Live route | `GET /v1/models` exposes models from all enabled providers in `DiscoveryRegistry` in OpenAI list format. | HTTP `200`; `object === "list"`; 14 models under `config/default.yaml` (2 x 7 enabled providers); each carries `id`, `object: "model"`, `created`, `owned_by`, `backend`, `placement` (`onprem` for `local`/`mcp`, else `cloud`), `stub: true`. | `test/gateway.test.ts` |
| **`FR-04`** | Auth & Error Envelope | Live | All routes except `GET /` and `GET /health` enforce `Authorization: Bearer <gateway.api_key>` when configured; empty key enables open local-dev mode. All errors return `{ error: { message, type } }`. | Missing/wrong bearer -> `401` (`type: "invalid_request_error"`). Unhandled exception -> `500` (`type: "server_error"`). `/` and `/health` return `200` unauthenticated. | `test/gateway.test.ts` + `/health` probe |
| **`FR-05`** | Routing Policy | Live | `RoutingPolicy.decide()` resolves placement (`override` > `activities[activity]` > `default_placement`; omitted `activity` defaults to `"chat"`) and backend (`override` > prefix-glob `model_routes` > `fallback_backend`), nudging fallback `code` traffic under `onprem` placement to an enabled `local` provider. | 5/5 tests in `test/policy.test.ts` pass (`gpt-4o-mini`/chat -> `mock-openai`/`cloud`; `local/llama3.2`/code -> `local-ollama`/`onprem`; `foundry/gpt-4o` -> `azure-foundry`; placement & backend overrides honored). `GET /admin/routes` returns `200` with `{ routing, sample }` (3 entries). | `test/policy.test.ts` + `GET /admin/routes` |
| **`FR-06`** | Parallel Fan-Out | Live orch / Stub tasks | `POST /v1/fanout` accepts `{ tasks: FanoutTask[], timeout_ms? }`, validates non-empty `tasks`, runs a worker pool bounded by `min(max(1, fanout.max_parallel), tasks.length)`, resolves policy independently per task, isolates per-task errors/timeouts, and preserves input order. | Empty/missing `tasks` -> `400`. Valid 3-task batch -> `200`, `object === "mirevox.fanout_result"`, `parallel === min(max_parallel, tasks.length)`, `results.length === tasks.length`, `results[i].id === tasks[i].id`. Timed-out task returns `ok: false, error: "task timeout"` without failing sibling tasks. | `test/fanout.test.ts` |
| **`FR-07`** | Key Vault Storage | Live | `KeyVault` persists `{ version: 1, entries }` JSON at `config.vault.path` with mode `0o600`, boots cleanly if file absent, and resolves `SMART_ROUTER_KEY_<BACKEND_NORMALIZED_UPPER>` env override ahead of file entries. | `put()` writes mode `0o600`; `getSecret()` returns env > file > `undefined`; `delete()` removes entry and returns boolean; missing file on init throws zero errors. | `test/vault.test.ts` |
| **`FR-08`** | Key Vault Admin API | Live | `GET /admin/keys`, `PUT /admin/keys/:id`, and `DELETE /admin/keys/:id` manage keys while never returning raw secret values. | `PUT` missing `backend` or `secret` -> `400`; valid `PUT` -> `200` `{ id, backend, updated_at, has_secret: true }` without `secret`; `GET /admin/keys` returns `0` objects containing a `secret` key; `DELETE` returns `{ deleted: boolean }`. | `test/vault.test.ts` + `test/gateway.test.ts` |
| **`FR-09`** | Discovery Registry | Live loop / Stub catalogs | `DiscoveryRegistry` tracks configured providers (`foundry`, `bedrock`, `vertex`, `local`, `mcp`, `mock`), runs immediate `pollAll()` on `start()`, refreshes every `poll_interval_ms` (`30000 ms`, `.unref()`'d), and exposes `GET /admin/registry` and `POST /admin/registry/poll`. | All 7 providers report `healthy: true`, ISO-8601 `last_poll_at`, non-empty `models[]`, and `stub: true` (when `SMART_ROUTER_STUB_MODE` is true or vault key missing). Disabled providers report `healthy: false, models: []`. | `test/gateway.test.ts` + `/admin/registry*` |
| **`FR-10`** | Config & Lifecycle | Live | `loadConfig()` parses YAML from `SMART_ROUTER_CONFIG` (default `./config/default.yaml`), throws if missing, and overlays `SMART_ROUTER_HOST`, `SMART_ROUTER_PORT`, `SMART_ROUTER_API_KEY`, `SMART_ROUTER_VAULT_PATH`, and `SMART_ROUTER_STUB_MODE`. `SIGINT`/`SIGTERM` stops polling and closes server. | Missing config file throws `Config not found` and exits non-zero; env overrides take precedence; `GET /` and `GET /health` report runtime banner and 7 provider statuses. | Startup + Docker healthcheck |

---

## 4. Non-Functional Requirements (v0.1 Locked)

| ID | Category | Requirement | Measurable Exit Criterion | Verification |
| --- | --- | --- | --- | --- |
| **`NFR-01`** | Offline & Zero-Credential Operability | Build, typecheck, tests, and Docker Compose runtime require zero cloud keys and zero outbound network access. | `npm run typecheck`, `npm test`, `npm run build`, and `docker compose up --build -d` + endpoint checks succeed with zero `SMART_ROUTER_KEY_*` vars set. | Local & Compose smoke run |
| **`NFR-02`** | Stub Latency & Parallelism | Low gateway overhead; fan-out executes independent tasks concurrently up to `max_parallel`. | `GET /health` `< 50 ms`; single stub completion `< 100 ms` (simulated 5–24 ms jitter); 3-task fan-out `< 100 ms` with `parallel === 3`. | Test run durations |
| **`NFR-03`** | Secret Non-Exposure | Vault secrets never appear in API responses and are persisted with owner-only file permissions. | `0` raw secret occurrences across `/admin/keys`, `/v1/models`, `/health`, `/admin/registry`, `/admin/routes`; `vault.json` mode `0o600`. | `test/vault.test.ts` + `test/gateway.test.ts` |
| **`NFR-04`** | Stub Honesty | Every stubbed response and catalog row explicitly declares stub status. | `100%` of stub completions set `mirevox.stub === true` and `[mirevox-stub/<backend>]` prefix; `100%` of stubbed catalog models set `stub: true`. | `test/gateway.test.ts` |
| **`NFR-05`** | Type Safety | Strict TypeScript (`strict: true`, `noUncheckedIndexedAccess: true`) compiles cleanly. | `npm run typecheck` and `npm run build` exit `0` with `0` diagnostics. | `tsc --noEmit` & `tsc` |
| **`NFR-06`** | Container Readiness | Multi-stage `node:22-alpine` image prunes devDependencies and boots quickly. | `docker compose up --build -d` reaches `healthy` (`/health` = `200`) in `<= 30 s`. | `docker compose up` + healthcheck |
| **`NFR-07`** | Modularity | Acyclic, single-responsibility modules under `src/` so live adapters or downstream LiteLLM can replace `src/backends/stub.ts` without breaking `/v1/*` or `/admin/*`. | `stubComplete` referenced only from `src/gateway/openai.ts` and `src/fanout/splitter.ts`. | Code inspection + typecheck |
| **`NFR-08`** | Licensing & Scope Hygiene | Apache-2.0 licensed with zero out-of-scope dependencies. | `LICENSE` (Apache-2.0) at root; `package.json` `"license": "Apache-2.0"`; `0` n8n/Instagram/Sherali references. | Repo inspection |

---

## 5. Deferred v0.2 Hardening Gates (Not Claimed in v0.1)

| Gate | Capability | Target Measurable Exit |
| --- | --- | --- |
| **`H-01`** | Fail-closed `onprem` residency enforcement | Requesting a `cloud` backend/model under an `onprem` activity returns HTTP `403` (naming activity + placement) with `0` outbound cloud calls (proven by hit-counter test). |
| **`H-02`** | Fan-out timer cleanup & batch bounds | Clear `setTimeout` handle in `finally` inside `fanoutTasks()` (eliminating the 60s lingering event-loop timer on process exit); enforce `max_tasks` (`400` above limit) and reject duplicate `task.id`. |
| **`H-03`** | Separate client vs. admin bearer profiles | Distinct tokens/profiles (e.g., VS Code, home chatbot, admin) so client keys cannot access `/admin/*`. |
| **`H-04`** | Structured JSON egress log & canary scrubber | Emit 1 JSON record per request/subtask (`request_id`, `activity`, `backend`, `placement`, `model`, `status`, `latency_ms`, `usage`) with `0` prompt/response bodies and `0` canary secrets for Mirevox `evals` and `data-lineage`. |
| **`H-05`** | Zod runtime schema validation | Wire installed `zod` dependency to validate `config/default.yaml` on boot and all `/v1/*` + `/admin/*` request payloads. |
| **`H-06`** | Live backend adapter (Ollama / LiteLLM / native SDKs) | Introduce `CompletionBackend` interface behind `src/backends/` supporting local Ollama HTTP and optional downstream LiteLLM/Bifrost delegation or native cloud SDKs with structured credentials (SigV4/ADC/Entra). |

---

## 6. Master v0.1 Release Verification Checklist

| Gate | Command / Check | Pass Condition |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | Exit `0`, 0 errors |
| Test suite | `npm test` | Exit `0`, 6 suites / 40 tests pass, 0 failed/skipped |
| Build | `npm run build` | Exit `0`, `dist/index.js` built |
| Docker Compose | `docker compose up --build -d` | `smart-router` container reaches `healthy` within `<= 30 s` |
| Auth gate | `GET /v1/models` without bearer | HTTP `401` |
| Health probe | `GET /health` without bearer | HTTP `200`, `status: "ok"`, 7 providers |
| Models catalog | `GET /v1/models` with bearer | HTTP `200`, `object: "list"`, 14 stub models |
| Chat stub | `POST /v1/chat/completions` (`foundry/gpt-4o`, `activity: "chat"`) | HTTP `200`, `mirevox.backend === "azure-foundry"`, `mirevox.stub === true` |
| Streaming guard | `POST /v1/chat/completions` (`stream: true`) | HTTP `501` |
| Fan-out | `POST /v1/fanout` with 3 tasks | HTTP `200`, `object: "mirevox.fanout_result"`, 3 ordered results |
| Vault redaction | `PUT /admin/keys/k1` + `GET /admin/keys` | HTTP `200`, `has_secret: true`, raw secret absent |
| Manual poll | `POST /admin/registry/poll` | HTTP `200`, 7 providers with updated `last_poll_at` |
