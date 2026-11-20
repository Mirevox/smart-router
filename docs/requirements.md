
# Mirevox Smart Router — Vetted Requirements (v0.1 Locked Scope)

- **Brand / Repo:** Mirevox (`https://github.com/Mirevox/smart-router`)
- **License:** Apache-2.0
- **Stage:** Vetted & Locked (v0.1 Runnable Stub)
- **Implementation Stack:** TypeScript (`strict`), Hono (`@hono/node-server`), Node.js `>= 20`, YAML config (`yaml`), Docker Compose (`node:22-alpine`)
- **Honest Baseline:** v0.1 is a **Mirevox-owned stub gateway**. Control-plane HTTP routes, bearer auth, file/env key storage, routing policy resolution, parallel task fan-out, and periodic registry polling are implemented for real; upstream provider execution and provider discovery catalogs are deterministic stubs (`stub: true`). The Devil's Advocate recommendation to wrap LiteLLM (or Bifrost) instead of owning a gateway is documented as a **deferred alternative** for v0.2+ backend delegation—v0.1 locks requirements to the shipped Hono stub APIs.

---

## 1. Stub vs. Live Implementation Truth Table

No v0.1 document or release note may claim live cloud integration, enterprise KMS security, or full OpenAI parity. Every capability is classified below against the actual codebase at `/home/ubuntu/mirevox/smart-router`.

| Subsystem | v0.1 Status | Code Surface | What Is Live (Real) | What Is Stubbed or Deferred |
| --- | --- | --- | --- | --- |
| **HTTP Gateway & Auth** | **Live** | `src/gateway/openai.ts` | Hono HTTP server on `:18765`, Bearer auth middleware (`SMART_ROUTER_API_KEY`, open-dev mode when empty), unauthenticated `/` and `/health`, OpenAI-style error JSON `{ error: { message, type } }`. | Single shared gateway key for `/v1/*` and `/admin/*` (separate client vs. admin/profile tokens deferred). SSE streaming returns `501` (`stream: true` unsupported in v0.1). |
| **Chat Completions** | **Stub** | `POST /v1/chat/completions`, `src/backends/stub.ts` | Request presence validation (`model`, `messages`), policy lookup, OpenAI `chat.completion` JSON envelope with inline `mirevox` metadata (`backend`, `placement`, `activity`, `stub`). | `stubComplete()` echoes the last user message with `[mirevox-stub/<backend>]`, approximates tokens (`ceil(chars/4)`), and adds 5–24 ms artificial latency. Zero live HTTP/SDK calls to cloud or Ollama. |
| **Model Listing** | **Live wrapper / Stub data** | `GET /v1/models`, `src/registry/providers.ts` | Returns OpenAI `{ object: "list", data: [...] }` dynamically aggregated from enabled providers in `DiscoveryRegistry`. | Models are populated from static `STUB_CATALOG` per `ProviderKind` (`foundry`, `bedrock`, `vertex`, `local`, `mcp`, `mock`), each tagged `stub: true`. |
| **Central Key Vault** | **Live (local file + env)** | `src/vault/key-vault.ts`, `/admin/keys` | Plaintext JSON persistence (`./data/vault.json`, mode `0o600`), clean boot if file missing, env override `SMART_ROUTER_KEY_<BACKEND>` precedence, CRUD API (`GET`/`PUT`/`DELETE /admin/keys`), secret redaction on list (`has_secret: boolean`). | Not an encrypted vault or KMS. Stores a single secret string per entry (non-API-key auth such as AWS SigV4, Google ADC, and Azure Entra is deferred). No secret-canary log scrubber yet. |
| **Routing Policy** | **Live (preference resolver)** | `src/router/policy.ts`, `GET /admin/routes` | Declarative YAML `activities` (`chat`, `code`, `embed`, `tool`), `default_placement`, prefix-glob `model_routes`, `fallback_backend`, explicit per-request `activity`/`placement`/`backend` overrides, and `onprem` fallback nudge to `local-ollama` for `code`. | **Not yet a fail-closed deny gate**: explicitly requesting a cloud model (e.g., `foundry/gpt-4o`) under an `onprem` activity resolves to `azure-foundry` with `placement: "onprem"` rather than returning `403`. No live upstream retry/fallback loop yet. Hard fail-closed enforcement is a v0.2 gate. |
| **Task-Split Fan-Out** | **Live orchestration / Stub execution** | `POST /v1/fanout`, `src/fanout/splitter.ts` | Dedicated non-OpenAI endpoint accepting explicit `tasks[]`; bounded worker pool (`fanout.max_parallel`, default `8`); independent per-task `policy.decide()`; per-task timeout race (`timeout_ms`, default `60000`); per-task error isolation; strict input-order preservation. | Subtask execution calls `stubComplete()`. No upper cap on `tasks.length` validation yet (concurrency is capped, not batch length). Timeout `setTimeout` handle is not cleared when a task succeeds before deadline (v0.2 fix). |
| **Discovery & Polling Registry** | **Live loop / Stub catalogs** | `src/registry/providers.ts`, `/admin/registry`, `/admin/registry/poll` | Config-driven provider list (7 providers across 6 kinds), immediate startup poll + `setInterval` (`poll_interval_ms: 30000`), manual `POST /admin/registry/poll`, status inspection via `GET /admin/registry`. | `pollOne()` reads `STUB_CATALOG[p.kind]` and checks whether a vault secret exists; makes zero live network probes. No runtime `POST`/`DELETE` entry onboarding or staleness eviction in v0.1. |
| **Health & Lifecycle** | **Live** | `GET /`, `GET /health`, `src/index.ts` | Unauthenticated `/health` returning per-provider `{ id, healthy, stub }`; `SIGINT`/`SIGTERM` cleanly stops registry timer and closes server. | Single `/health` route (no separate `/healthz` + `/readyz`). Structured JSON per-request egress audit logging and `X-Mirevox-*` HTTP response headers are deferred to v0.2. |
| **Packaging & Ops** | **Live** | `Dockerfile`, `docker-compose.yml`, `config/default.yaml`, `.env.example` | Multi-stage `node:22-alpine` build, single-service Compose on `:18765`, persistent `router-data` volume, `wget` healthcheck, zero cloud credentials required. | No standalone `./scripts/acceptance.sh` bundled yet (`npm test` + `npm run typecheck` + `docker compose up` form the v0.1 verification suite). |

---

## 2. Vapor & Over-Specification Cut from `requirements-draft.md`

The requirements draft (`requirements-draft.md`) specified several features that are either absent in the shipped v0.1 code, premature for a stub contract, or rejected by adversarial review. All items below are explicitly **cut or narrowed** out of the v0.1 lock:

| Draft Requirement | Disposition | Reason & Locked v0.1 Reality |
| --- | --- | --- |
| `REQ-GW-01` SSE streaming (`stream: true`) | **Cut from v0.1** | Shipped gateway explicitly rejects `stream: true` with HTTP `501` (`"streaming not implemented in v0.1 stub"`). Re-open only when live adapters land. |
| `REQ-GW-03` `403`/`404`/`502`/`504` full OpenAI error taxonomy + `error.code` field | **Narrowed** | Shipped error envelope is `{ error: { message, type } }` covering `400`, `401`, `501`, `500`. `403`/`404`/`502`/`504` apply once fail-closed policy and live upstream HTTP adapters exist. |
| `REQ-KV-03` `/v1/vault/status` + separate admin token + masked last-4 | **Narrowed to shipped API** | Shipped endpoints are `GET /admin/keys`, `PUT /admin/keys/:id`, `DELETE /admin/keys/:id` returning `{ id, backend, updated_at, has_secret }`. Separate admin/client auth tokens are deferred to v0.2. |
| `REQ-RT-01/02/03` Fail-closed `503`/`403` outage rejection, ordered live fallback, `X-Mirevox-Activity` header | **Narrowed to shipped API; fail-closed deferred to v0.2** | Shipped v0.1 reads `activity`, `placement`, and `backend` from the JSON request body and resolves policy deterministically via `RoutingPolicy.decide()`. Hard-deny `403` enforcement and ordered retry/fallback are promoted to mandatory v0.2 hardening gates. |
| `REQ-RT-04` Six `X-Mirevox-*` HTTP response headers | **Cut from v0.1** | Routing provenance is returned inline in `mirevox: { backend, placement, activity, stub }` on completions and `decision` on fan-out results. Header mirroring deferred to v0.2. |
| `REQ-FS-01/02/03/04` Implicit splitting on `/v1/chat/completions`, `mirevox_tasks`, `require_all` mode, merged prose essay | **Cut; replaced by `/v1/fanout`** | Per Devil's Advocate, overloading `/v1/chat/completions` breaks standard OpenAI clients. v0.1 isolates explicit caller-supplied fan-out on `POST /v1/fanout` returning structured `mirevox.fanout_result`. |
| `REQ-REG-01/02/03/04` Live local-Ollama HTTP import, workflow-by-reference URLs, staleness eviction, runtime `POST/DELETE /v1/registry/entries` | **Cut from v0.1** | Static config-driven provider catalog in `config/default.yaml` + stub `pollAll()` avoids SSRF/RCE risks and unreviewed auto-onboarding. Live read-only discovery with human allowlist is deferred to v0.2+. |
| `REQ-OBS-01/02` Structured JSON audit event log + separate `/healthz` and `/readyz` | **Narrowed** | v0.1 ships unauthenticated `GET /health` with provider status summary. Structured JSON egress log (for sibling `evals` and `data-lineage` modules) is deferred to v0.2. |
| Vault encryption (`AES-256-GCM` passphrase in env) | **Permanently cut** | Passphrase in the same env file is security theater (per DA). Keep honest `0o600` local file + env until a real KMS/secret manager adapter is added. |
| n8n, Instagram, Sherali homelab, Web UI, bundled evals/lineage, billing/RBAC | **Permanently out of scope** | Belongs outside this repository. |

---

## 3. Disposition of Devil's Advocate (`devils-advocate.md`)

Devil's Advocate challenged the entire brief and recommended wrapping a pinned LiteLLM (or Bifrost) proxy instead of building a custom gateway. Below is the explicit council resolution for every challenge.

### Strategic Decision: Owned Hono Stub vs. LiteLLM Wrap

- **Devil's Advocate position:** Do not write an original Fastify/Hono/FastAPI proxy; ship a Docker Compose profile around pinned LiteLLM (or Bifrost) with a small policy check and log filter.
- **Council decision:** **Lock v0.1 to the shipped Hono TypeScript stub gateway; record LiteLLM/Bifrost wrapping as an explicit deferred alternative for v0.2+.**
- **Why:**
  1. The Hono stub already exists (~450 LOC across 8 files, zero external dependencies beyond `hono`, `@hono/node-server`, `yaml`, `zod`) and passes 12 automated tests cleanly with `tsc --noEmit`.
  2. Owning the thin control-plane front door keeps Mirevox's exact extension contracts (`POST /v1/fanout`, `/admin/*`, activity placement config) composable and independent of LiteLLM's Python runtime and config churn.
  3. **Crucial honesty concession:** Mirevox will **not** rewrite provider SDK normalization for 50+ clouds. When moving from v0.1 stubs to live execution in v0.2+, delegating cloud calls downstream to LiteLLM, Bifrost, or a narrow set of native adapters behind `src/backends/` remains the preferred integration path.

### Point-by-Point Keep / Cut / Defer Table

| DA Item | DA Verdict | Council v0.1 Verdict | Rationale & Guardrail |
| --- | --- | --- | --- |
| Pinned LiteLLM / Bifrost wrapper as sole proxy | Keep | **Deferred alternative (v0.2+)** | Documented in `architecture.md` as a downstream backend option; v0.1 locks to the shipped Hono stub APIs. |
| Original Hono TypeScript gateway | Cut | **Keep (locked v0.1)** | Already built, tiny, Apache-2.0, tested offline. Must stay honest about stub status. |
| Implicit task-split fan-out inside `/v1/chat/completions` | Cut | **Cut (agreed)** | `/v1/chat/completions` stays single-route OpenAI shape; fan-out lives strictly on `POST /v1/fanout`. |
| Explicit caller-supplied fan-out endpoint | Defer | **Keep on `POST /v1/fanout`** | Already shipped with bounded worker pool, per-task timeouts, per-task error status, and deterministic input ordering. |
| Workflow-by-reference URL fetch & MCP stdio execution | Cut | **Cut (agreed)** | Eliminates SSRF and RCE attack surface. MCP is a static stub catalog entry only. |
| Auto-onboard anything a poller discovers into live routes | Cut | **Cut (agreed)** | Providers are declared statically in `config/default.yaml`; no unreviewed dynamic route injection. |
| Stub discovery registry for Foundry, Bedrock, Vertex, local, MCP | Cut | **Keep as labeled stub** | Already shipped in `src/registry/providers.ts`. Every row explicitly sets `stub: true` so nothing claims live cloud support. |
| Key vault encryption theater / UI / KMS / virtual keys | Cut | **Cut (agreed)** | `KeyVault` stays a minimal `0o600` JSON file + `SMART_ROUTER_KEY_*` env store with redacted `/admin/keys` listing; no fake encryption. |
| Fail-closed `onprem` deny (`403`) + zero cloud hits | Keep | **Defer to v0.2 P0 gate** | Not yet enforced in `src/router/policy.ts`; explicitly tracked as the #1 v0.2 hardening requirement so v0.1 makes no false residency claim. |
| Distinct client vs. admin bearer tokens (VS Code vs. chatbot profiles) | Keep | **Defer to v0.2** | v0.1 uses one `SMART_ROUTER_API_KEY`; documented as a single-operator local-dev boundary. |
| Structured JSON egress log (no prompt/response bodies, canary scrub) | Keep | **Defer to v0.2** | Needed before wiring Mirevox `evals` and `data-lineage` subscribers. |
| Live cloud SDKs (Foundry, Bedrock, Vertex, Agent runtimes) | Cut / Defer | **Cut from v0.1 / Defer** | Zero live cloud calls in v0.1; Agent runtimes (threads/tools) remain out of scope for chat completions. |
| n8n, Instagram, Sherali homelab, VS Code ext, chatbot | Cut | **Cut (agreed)** | Explicitly listed under "Not in this repo". |

---

## 4. Tightened Acceptance Criteria (Locked to Shipped v0.1 APIs)

Every criterion below maps directly to an implemented v0.1 endpoint or module and is classified `[LIVE]` or `[STUB]`.

### 4.1 Gateway & Auth (`AC-GW`)
- **`AC-GW-01` `[LIVE]` Auth Gate:** Requests to `/v1/*` and `/admin/*` without `Authorization: Bearer <config.gateway.api_key>` return HTTP `401` with `{"error":{"message":"Invalid API key","type":"invalid_request_error"}}`. `GET /` and `GET /health` succeed (`200`) without auth. When `gateway.api_key` is empty (`""`), requests pass in open local-dev mode. *(Verified by `test/gateway.test.ts`: "rejects missing api key".)*
- **`AC-GW-02` `[LIVE]` Service & Health Probes:** `GET /` returns `200` with `{ name: "mirevox-smart-router", version: "0.1.0", openai_base: "/v1", docs }`. `GET /health` returns `200` with `{ status: "ok", providers: [{ id, healthy, stub }] }`.
- **`AC-GW-03` `[STUB]` Chat Completions Contract:** `POST /v1/chat/completions` with valid `model` and `messages[]` returns `200` with OpenAI-shaped `id` (`chatcmpl_*`), `object: "chat.completion"`, `created`, `model`, `choices[0].message.{role:"assistant", content}`, `choices[0].finish_reason: "stop"`, `usage.{prompt_tokens, completion_tokens, total_tokens}`, and `mirevox.{backend, placement, activity, stub: true}`. Content echoes the last user message prefixed with `[mirevox-stub/<backend>]`. *(Verified by `test/gateway.test.ts`: "completes chat with routing metadata".)*
- **`AC-GW-04` `[LIVE]` Payload Validation & Streaming Rejection:** `POST /v1/chat/completions` missing `model` or non-array `messages` returns `400`. Sending `stream: true` returns `501` with `"streaming not implemented in v0.1 stub"`.
- **`AC-GW-05` `[STUB]` Model Listing:** `GET /v1/models` with valid bearer returns `200` with `{ object: "list", data: DiscoveredModel[] }` containing models from all enabled providers (`azure-foundry`, `aws-bedrock`, `google-vertex`, `local-ollama`, `mcp-bridge`, `mock-openai`, `mock-anthropic`), each carrying `id`, `object: "model"`, `created`, `owned_by`, `backend`, `placement`, and `stub: true`. *(Verified by `test/gateway.test.ts`: "lists models".)*

### 4.2 Central Key Vault (`AC-KV`)
- **`AC-KV-01` `[LIVE]` File + Env Precedence:** `KeyVault.getSecret(backend)` checks `process.env["SMART_ROUTER_KEY_<BACKEND_UPPER_UNDERSCORE>"]` first, falling back to the JSON vault file (`config.vault.path`, default `./data/vault.json`). Missing vault file initializes cleanly to `{ version: 1, entries: [] }` without error.
- **`AC-KV-02` `[LIVE]` Secret Redaction & File Mode:** `PUT /admin/keys/:id` persists `{ id, backend, secret, updated_at }` with file mode `0o600` and returns `{ id, backend, updated_at, has_secret: true }` (no `secret` field). `GET /admin/keys` returns `{ data: [{ id, backend, updated_at, has_secret }] }` with zero raw `secret` properties. `DELETE /admin/keys/:id` returns `{ deleted: boolean }`. *(Verified by `test/vault.test.ts` and `test/gateway.test.ts`: "stores vault keys".)*
- **`AC-KV-03` `[LIVE]` Input Validation:** `PUT /admin/keys/:id` missing `backend` or `secret` returns `400`.

### 4.3 Routing Policy (`AC-RT`)
- **`AC-RT-01` `[LIVE]` Activity Placement Resolution:** `RoutingPolicy.decide()` resolves placement in order: explicit `placement` override > `routing.activities[activity]` (`chat: cloud`, `code: onprem`, `embed: cloud`, `tool: onprem`) > `routing.default_placement` (`cloud`), defaulting omitted `activity` to `"chat"`. *(Verified by `test/policy.test.ts`.)*
- **`AC-RT-02` `[LIVE]` Model-Route Pattern Matching:** `resolveBackend()` honors explicit `backend` override > prefix-glob matches in `routing.model_routes` (`gpt-*`, `claude-*`, `local/*`, `foundry/*`, `bedrock/*`, `vertex/*`, `mcp/*`) > `routing.fallback_backend` (`mock-openai`). When `placement === "onprem"`, `activity === "code"`, no explicit `backend` override is supplied, and the model falls through to `fallback_backend` without a `/` prefix, the decision nudges `backend` to the first enabled `local` provider (`local-ollama`). *(Verified by `test/policy.test.ts`.)*
- **`AC-RT-03` `[LIVE]` Route Inspection:** `GET /admin/routes` returns `200` with `{ routing, sample }` containing the loaded `routing` config and three evaluated sample decisions.

### 4.4 Parallel Task-Split Fan-Out (`AC-FO`)
- **`AC-FO-01` `[LIVE/STUB]` Explicit Parallel Dispatch:** `POST /v1/fanout` accepts `{ tasks: FanoutTask[], timeout_ms? }` (rejects empty/missing `tasks` with `400`), executes tasks across a worker pool bounded by `min(max(1, fanout.max_parallel), tasks.length)`, evaluates `RoutingPolicy.decide()` independently per task, and returns `200` with `{ object: "mirevox.fanout_result", parallel, results }`. *(Verified by `test/fanout.test.ts`.)*
- **`AC-FO-02` `[LIVE]` Deterministic Ordering & Fault Isolation:** `results[]` preserves the exact input order of `tasks[]` by `task.id`. Any task exceeding `timeout_ms` (default `60000`) or throwing an error yields `{ id, ok: false, decision, error, duration_ms }` without failing sibling tasks.

### 4.5 Discovery & Polling Registry (`AC-REG`)
- **`AC-REG-01` `[STUB]` Startup & On-Demand Polling:** `DiscoveryRegistry.start()` runs an initial `pollAll()` and schedules periodic polling every `registry.poll_interval_ms` (`30000 ms`, timer `.unref()`'d). `POST /admin/registry/poll` executes `pollAll()` immediately and returns `{ data: ProviderStatus[] }`. `GET /admin/registry` returns current statuses for all configured providers.
- **`AC-REG-02` `[STUB]` Honest Stub Marking:** In default mode (`SMART_ROUTER_STUB_MODE` unset or `"true"`), or whenever a polled provider has no secret in `KeyVault`, its `ProviderStatus.stub` and exported `DiscoveredModel.stub` are `true`. Zero outbound network calls are made during polling.

### 4.6 Packaging & Verification (`AC-OPS`)
- **`AC-OPS-01` `[LIVE]` Offline Test & Typecheck Gate:** From a clean checkout with zero cloud credentials, `npm run typecheck` and `npm test` (12 tests across 4 suites) exit `0`.
- **`AC-OPS-02` `[LIVE]` Zero-Credential Docker Compose Boot:** `docker compose up --build -d` builds the `node:22-alpine` image, starts `smart-router` on port `18765`, and passes the container healthcheck (`GET http://127.0.0.1:18765/health` = `200`) within 30 seconds with no external services or API keys.

---

## 5. Explicit Non-Goals (Not in v0.1 Repo)

- Live cloud inference adapters (Azure AI Foundry, AWS Bedrock, Google Vertex, Ollama) and downstream LiteLLM delegation (v0.2+).
- Fail-closed `403` residency enforcement on explicit cloud-model overrides under `onprem` activities (v0.2 P0 gate).
- SSE streaming (`stream: true`), embeddings, multimodal inputs, and tool-call execution.
- MCP runtime brokering (stdio/HTTP tool invocation) and workflow-by-reference URL fetching.
- Separate client/admin bearer profiles, virtual keys, budgets, spend dashboards, KMS/HSM encryption, or Web UI.
- Structured JSON egress audit streaming to Mirevox `evals` / `data-lineage` (v0.2).
- n8n, Instagram, or full Sherali homelab stack orchestration.
