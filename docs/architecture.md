# Mirevox Smart Router — Architecture (v0.1)

- **Package:** `@mirevox/smart-router` v`0.1.0` (`https://github.com/Mirevox/smart-router`)
- **License:** Apache-2.0
- **Runtime:** Node.js `>= 20` (ESM, TypeScript `strict`), HTTP framework **Hono** (`@hono/node-server`)
- **Status:** Locked v0.1 Runnable Stub Architecture

---

## 1. Architectural Posture & Stack Decision

Mirevox Smart Router v0.1 is a lightweight, single-process HTTP control-plane gateway written in TypeScript on **Hono**. It exposes an OpenAI-compatible front door (`/v1/models`, `/v1/chat/completions`), an explicit parallel fan-out endpoint (`/v1/fanout`), and local management routes (`/admin/keys`, `/admin/routes`, `/admin/registry`).

### Why Hono + TypeScript for v0.1

- **Minimal runtime footprint:** Only four runtime dependencies (`hono`, `@hono/node-server`, `yaml`, `zod`) and a small `node:22-alpine` multi-stage Docker image.
- **Zero-socket in-process testing:** Hono's Web Standards `app.request(...)` API allows `node --test` integration suites to exercise full HTTP routing, middleware, and error handling without binding ports.
- **Native async concurrency:** Built-in `Promise.all` / `Promise.race` worker pools make bounded parallel fan-out straightforward without thread/GIL contention.

### Honest Stub Boundary & Deferred Alternative (LiteLLM / Bifrost Wrap)

v0.1 is explicitly a **runnable stub gateway that Mirevox owns**:
- **Real (live) in v0.1:** HTTP gateway, Bearer auth, YAML config + env overrides, local `0o600` JSON + env `KeyVault`, activity/pattern `RoutingPolicy`, bounded parallel `fanoutTasks` orchestrator, periodic `DiscoveryRegistry` polling timer, and Docker Compose packaging.
- **Stubbed in v0.1:** Upstream inference (`src/backends/stub.ts`) returns deterministic OpenAI-shaped echoes marked `mirevox.stub: true`, and `DiscoveryRegistry.pollOne()` populates a static `STUB_CATALOG` per provider kind marked `stub: true`.

**Deferred Alternative — LiteLLM / Bifrost Delegation:** During council review (`docs/devils-advocate.md`), the adversarial review recommended wrapping a pinned LiteLLM (or Apache-2.0 Bifrost) proxy instead of building and maintaining a new provider-normalizing gateway. That critique is preserved as an explicit **deferred architectural option for v0.2+**:
- v0.1 keeps the owned Hono gateway (~450 LOC) to lock Mirevox's exact extension APIs (`POST /v1/fanout`, `/admin/*`, activity placement rules) without coupling to LiteLLM's Python stack.
- When moving to live cloud traffic in v0.2+, Mirevox does **not** need to reimplement every cloud SDK from scratch—`src/backends/` is designed so a downstream LiteLLM/Bifrost HTTP adapter (or narrow native adapters for Ollama, Foundry, Bedrock, and Vertex) can drop behind the existing gateway contract.

---

## 2. System Context & Component Layout

```text
  VS Code / Home Chatbot / curl / OpenAI SDK / Admin CLI
                           │
                           │ HTTP (default 0.0.0.0:18765)
                           ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │                 Hono Gateway (src/gateway/openai.ts)            │
  │   Auth middleware (Bearer SMART_ROUTER_API_KEY; / & /health     │
  │   open) + JSON error envelope ({ error: { message, type } })    │
  ├─────────────────────┬───────────────────────┬───────────────────┤
  │  OpenAI Surface     │  Mirevox Extension    │  Admin Surface    │
  │  GET  /v1/models    │  POST /v1/fanout      │  /admin/keys*     │
  │  POST /v1/chat/     │                       │  /admin/routes    │
  │       completions   │                       │  /admin/registry* │
  └──────┬──────────────┴──────────┬────────────┴────────┬──────────┘
         │                         │                     │
         ▼                         ▼                     ▼
  ┌──────────────┐       ┌───────────────────┐    ┌─────────────────┐
  │ RoutingPolicy│◄──────│   fanoutTasks     │    │DiscoveryRegistry│
  │ (src/router/ │       │ (src/fanout/      │    │(src/registry/   │
  │  policy.ts)  │       │  splitter.ts)     │    │ providers.ts)   │
  └──────┬───────┘       └─────────┬─────────┘    └────────┬────────┘
         │                         │                       │
         └────────────┬────────────┘                       │
                      ▼                                    ▼
             ┌─────────────────┐                  ┌─────────────────┐
             │  stubComplete   │                  │    KeyVault     │
             │ (src/backends/  │                  │ (src/vault/     │
             │  stub.ts)       │                  │  key-vault.ts)  │
             │  [v0.1 STUB]    │                  │ env > vault.json│
             └─────────────────┘                  └────────┬────────┘
                                                           │
                       config/default.yaml ────────────────┤
                       ./data/vault.json (0o600) ──────────┘
```

---

## 3. Module Boundaries (`src/`)

Imports are strictly acyclic from the composition root (`src/index.ts`) down to domain types (`src/types.ts`) and config (`src/config.ts`).

| File | Primary Exports | Responsibilities | Dependencies |
| --- | --- | --- | --- |
| `src/index.ts` | Process entry point | Loads `AppConfig`, instantiates `KeyVault`, `RoutingPolicy`, `DiscoveryRegistry` (calls `start()`), creates Hono app via `createGateway()`, starts `@hono/node-server`, and handles `SIGINT`/`SIGTERM` shutdown (`registry.stop()`, `server.close()`). | `config`, `vault/key-vault`, `router/policy`, `registry/providers`, `gateway/openai`, `@hono/node-server` |
| `src/types.ts` | `AppConfig`, `Placement`, `ProviderKind`, `ProviderConfig`, `ProviderStatus`, `DiscoveredModel`, `ChatMessage`, `ChatCompletionRequest`, `FanoutTask`, `FanoutRequest`, `RouteDecision` | Pure TypeScript interfaces and union types shared across all modules. Zero runtime code. | None |
| `src/config.ts` | `loadConfig(path?)`, `stubMode()` | Reads YAML config from `SMART_ROUTER_CONFIG` (default `./config/default.yaml`), throws if file missing, overlays env vars (`SMART_ROUTER_HOST`, `SMART_ROUTER_PORT`, `SMART_ROUTER_API_KEY`, `SMART_ROUTER_VAULT_PATH`), and resolves `SMART_ROUTER_STUB_MODE` (defaults to `true`). | `node:fs`, `node:path`, `yaml`, `types` |
| `src/gateway/openai.ts` | `createGateway(deps)` | Constructs the Hono app, attaches Bearer auth middleware, mounts all 11 HTTP routes (`/`, `/health`, `/v1/*`, `/admin/*`), validates required request fields, rejects `stream: true` with `501`, and normalizes errors in `app.onError`. | `hono`, `types`, `router/policy`, `registry/providers`, `vault/key-vault`, `backends/stub`, `fanout/splitter` |
| `src/router/policy.ts` | `RoutingPolicy` (`resolvePlacement`, `resolveBackend`, `decide`) | Evaluates activity -> placement (`cloud \| onprem`), matches `model_routes` prefix globs (`*` suffix) to backend IDs, honors explicit overrides, and nudges fallback `code` requests on `onprem` placement to an enabled `local` provider. | `types`, `config` |
| `src/fanout/splitter.ts` | `fanoutTasks(config, policy, req)`, `FanoutTaskResult`, `FanoutResponse` | Runs explicit `tasks[]` through a bounded async worker pool (`Math.min(Math.max(1, max_parallel), tasks.length)`). Each task resolves policy independently, races `stubComplete` against `timeout_ms`, captures per-task failures as `ok: false`, and returns results in original input order. | `types`, `router/policy`, `backends/stub` |
| `src/registry/providers.ts` | `DiscoveryRegistry` (`start`, `stop`, `pollAll`, `pollOne`, `listStatuses`, `listModels`, `getBackend`) | Maintains in-memory `Map<string, ProviderStatus>` for configured providers (`foundry`, `bedrock`, `vertex`, `local`, `mcp`, `mock`). Runs immediate + periodic (`setInterval`, `.unref()`'d) stub polls returning `STUB_CATALOG` models and marking `stub: stubMode() \|\| !hasKey`. | `types`, `config`, `vault/key-vault` |
| `src/vault/key-vault.ts` | `KeyVault` (`list`, `getSecret`, `put`, `delete`), `VaultEntry` | Loads/persists `{ version: 1, entries }` JSON at `config.vault.path` with POSIX mode `0o600`. Env vars (`SMART_ROUTER_KEY_<BACKEND_NORMALIZED>`) override file entries on lookup. `list()` omits raw `secret` and returns `has_secret: boolean`. | `node:fs`, `node:path`, `types` |
| `src/backends/stub.ts` | `stubComplete(decision, messages)`, `CompletionResult` | Deterministic stub backend producing OpenAI `chat.completion` payloads with `chatcmpl_*` IDs, last-user-message echo prefixed `[mirevox-stub/<backend>]`, approximate token counts (`ceil(len/4)`), `5–24 ms` latency jitter, and `mirevox` routing metadata. | `types` |

---

## 4. HTTP API Reference (v0.1 Shipped Surface)

All authenticated routes accept `Authorization: Bearer <SMART_ROUTER_API_KEY>` (default `mirevox-dev-key`). Errors return `{ "error": { "message": "...", "type": "invalid_request_error" | "server_error" } }`.

| Method | Path | Auth | Mode | Request / Parameters | Response (`200`) & Error Codes |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/` | Public | Live | — | `{ name, version, openai_base: "/v1", docs }` |
| `GET` | `/health` | Public | Live | — | `{ status: "ok", providers: [{ id, healthy, stub }] }` |
| `GET` | `/v1/models` | Bearer | Stub data | — | `{ object: "list", data: DiscoveredModel[] }` (`401`) |
| `POST` | `/v1/chat/completions` | Bearer | Stub exec | `{ model, messages[], temperature?, stream?, max_tokens?, activity?, placement?, backend? }` | OpenAI `chat.completion` + `mirevox: { backend, placement, activity, stub }` (`400`, `401`, `501` if `stream: true`) |
| `POST` | `/v1/fanout` | Bearer | Live orch / Stub exec | `{ tasks: [{ id, model?, activity?, placement?, backend?, messages[] }], timeout_ms? }` | `{ object: "mirevox.fanout_result", parallel, results: FanoutTaskResult[] }` (`400`, `401`) |
| `GET` | `/admin/keys` | Bearer | Live | — | `{ data: [{ id, backend, updated_at, has_secret }] }` (never includes `secret`) (`401`) |
| `PUT` | `/admin/keys/:id` | Bearer | Live | `{ backend, secret }` | `{ id, backend, updated_at, has_secret: true }` (`400`, `401`) |
| `DELETE` | `/admin/keys/:id` | Bearer | Live | `:id` path param | `{ deleted: boolean }` (`401`) |
| `GET` | `/admin/routes` | Bearer | Live | — | `{ routing: RoutingConfig, sample: RouteDecision[3] }` (`401`) |
| `GET` | `/admin/registry` | Bearer | Stub data | — | `{ data: ProviderStatus[] }` (`401`) |
| `POST` | `/admin/registry/poll` | Bearer | Stub poll | — | Triggers `pollAll()`, returns `{ data: ProviderStatus[] }` (`401`) |

### Representative Payloads

**`POST /v1/chat/completions` response:**
```json
{
  "id": "chatcmpl_a1b2c3d4e5f6a1b2c3d4e5f6",
  "object": "chat.completion",
  "created": 1795155720,
  "model": "foundry/gpt-4o",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "[mirevox-stub/azure-foundry] placement=cloud activity=chat echo: hello router"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 3, "completion_tokens": 18, "total_tokens": 21 },
  "mirevox": {
    "backend": "azure-foundry",
    "placement": "cloud",
    "activity": "chat",
    "stub": true
  }
}
```

**`POST /v1/fanout` response:**
```json
{
  "object": "mirevox.fanout_result",
  "parallel": 3,
  "results": [
    {
      "id": "a",
      "ok": true,
      "decision": { "model": "gpt-4o-mini", "backend": "mock-openai", "placement": "cloud", "activity": "chat", "stub": true },
      "result": { "id": "chatcmpl_...", "object": "chat.completion", "...": "..." },
      "duration_ms": 14
    }
  ]
}
```

---

## 5. Key Data Flows

### 5.1 Single Chat Completion
1. Client sends `POST /v1/chat/completions` with `Authorization: Bearer <key>`.
2. Auth middleware verifies token against `config.gateway.api_key` (unless empty).
3. Handler validates `body.model` and `Array.isArray(body.messages)` (`400`), and rejects `body.stream === true` (`501`).
4. `RoutingPolicy.decide()` maps `activity` -> `placement` and `model` -> `backend`, applying explicit overrides and the `onprem`/`code` fallback nudge.
5. `stubComplete(decision, body.messages)` generates the deterministic OpenAI-shaped completion with `mirevox` metadata and returns `200`.

### 5.2 Parallel Task-Split Fan-Out
1. Client sends `POST /v1/fanout` with an explicit `tasks[]` array (never implicitly split from `/v1/chat/completions`).
2. `fanoutTasks()` computes `limit = Math.min(Math.max(1, config.fanout.max_parallel), tasks.length)` and spawns `limit` async workers pulling from a shared queue.
3. Each worker runs `policy.decide()` for its task (defaulting omitted `task.model` to `"gpt-4o-mini"`), then races `stubComplete()` against `req.timeout_ms ?? config.fanout.default_timeout_ms`.
4. Exceptions or timeouts are caught per task (`ok: false, error`) so sibling tasks still complete.
5. Results are indexed by `task.id` and re-emitted in original `req.tasks` order.

### 5.3 Credential Resolution Precedence
1. `KeyVault.getSecret(backend)` normalizes `backend` to `SMART_ROUTER_KEY_<UPPER_ALNUM_UNDERSCORE>` (e.g., `azure-foundry` -> `SMART_ROUTER_KEY_AZURE_FOUNDRY`).
2. If set and non-empty in `process.env`, the environment variable wins.
3. Otherwise `KeyVault` searches `this.data.entries` loaded from `config.vault.path` (`./data/vault.json`).
4. If absent in both, returns `undefined`; `DiscoveryRegistry` keeps `stub: true` for that provider.

### 5.4 Discovery Poll Loop
1. `DiscoveryRegistry` initializes all providers from `config.registry.providers` with `healthy: false, last_poll_at: null, models: []`.
2. `registry.start()` triggers an immediate `pollAll()` and schedules `setInterval(..., config.registry.poll_interval_ms)` (default `30000 ms`, `.unref()`'d so it never blocks shutdown).
3. Providers with `poll: false` (e.g., `mock-openai`, `mock-anthropic`) are marked healthy with their `STUB_CATALOG` entries directly; polled providers call `pollOne()`, which in v0.1 assigns `STUB_CATALOG[p.kind]` and sets `stub: stubMode() || !hasKey`.
4. `GET /v1/models` projects enabled providers' `models[]` into OpenAI `DiscoveredModel` objects with `placement` inferred from `kind` (`local` | `mcp` -> `onprem`; others -> `cloud`).

---

## 6. Configuration & Security Posture

### Configuration Files & Env Vars

`config/default.yaml` defines 6 top-level blocks: `server`, `gateway`, `routing`, `vault`, `registry`, and `fanout`.

| Environment Variable | Default | Effect |
| --- | --- | --- |
| `SMART_ROUTER_CONFIG` | `./config/default.yaml` | Path to YAML configuration file |
| `SMART_ROUTER_HOST` | `0.0.0.0` | Bind address override |
| `SMART_ROUTER_PORT` | `18765` | Listen port override |
| `SMART_ROUTER_API_KEY` | `mirevox-dev-key` | Gateway/admin Bearer token (empty = open local-dev mode) |
| `SMART_ROUTER_VAULT_PATH` | `./data/vault.json` | JSON key vault file path |
| `SMART_ROUTER_STUB_MODE` | `true` | Forces stub mode when `"true"` / `"1"` or unset |
| `SMART_ROUTER_KEY_<BACKEND>` | *(unset)* | Per-backend upstream credential override (e.g., `SMART_ROUTER_KEY_AZURE_FOUNDRY`) |

### Known v0.1 Security & Runtime Limitations (Honest Disclosure)

1. **Single bearer token:** `/v1/*` and `/admin/*` currently share `SMART_ROUTER_API_KEY`; do not expose `:18765` to untrusted networks or share the admin key with untrusted clients.
2. **Plaintext local vault:** `./data/vault.json` is stored as plaintext JSON with mode `0o600` (gitignored via `data/`). Suitable for a single-operator local/home-lab prototype only.
3. **Preference-only placement policy:** `RoutingPolicy.decide()` does not yet hard-reject (`403`) an explicit cloud model requested under an `onprem` activity. Fail-closed enforcement is scheduled as v0.2 gate `H-01` (see `docs/requirements.md`).
4. **Fan-out timeout timer handle:** `fanoutTasks()` creates a `setTimeout` inside `Promise.race` without calling `clearTimeout` on fast completion (keeps Node event loop alive up to `default_timeout_ms` on process exit; scheduled for v0.2 fix `H-02`). Also, `tasks.length` has no upper-bound validation yet and duplicate `task.id` values collide in the order-preservation `Map`.
5. **Unwired Zod validation:** `zod` is declared in `package.json` but config and request payloads currently rely on manual checks; full schema validation is scheduled as v0.2 gate `H-05`.

---

## 7. Docker & Deployment Layout

Smart Router ships as a self-contained single-container deployment requiring zero external databases, queues, or cloud credentials.

### Multi-Stage `Dockerfile`
1. **Build stage (`node:22-alpine AS build`):** Copies `package.json` + `package-lock.json`, runs `npm ci`, copies `tsconfig.json`, `src/`, `config/`, compiles TypeScript (`npm run build` -> `dist/`), and strips devDependencies (`npm prune --omit=dev`).
2. **Runtime stage (`node:22-alpine`):** Sets `NODE_ENV=production`, `SMART_ROUTER_CONFIG=/app/config/default.yaml`, `SMART_ROUTER_VAULT_PATH=/app/data/vault.json`, `SMART_ROUTER_STUB_MODE=true`; copies pruned `node_modules/`, `dist/`, `config/`; creates `/app/data`; exposes `18765`; launches `node dist/index.js`.

### `docker-compose.yml` Topology
- **Service:** `smart-router` (built from `.`)
- **Port mapping:** `18765:18765`
- **Volume:** Named volume `router-data` mounted at `/app/data` (persists `vault.json` across restarts)
- **Healthcheck:** `wget -qO- http://127.0.0.1:18765/health` every `10s`, timeout `3s`, `5` retries
- **External dependencies:** None (no n8n, no database, no reverse proxy, no cloud keys required)

---

## 8. Evolution Path (v0.2+ Extension Seams)

To graduate from the v0.1 stub without breaking client or module contracts:

1. **Backend Adapter Interface (`src/backends/`):** Introduce a `CompletionBackend` interface with two initial implementations:
   - `stubBackend` (existing `stubComplete`, used when `stubMode()` is true or credentials are absent).
   - Live adapter(s): either a **local OpenAI-compatible HTTP adapter** (Ollama/vLLM) plus a **downstream LiteLLM/Bifrost proxy adapter** (honoring the reuse option in `docs/devils-advocate.md`) or direct provider adapters using structured credentials (SigV4/ADC/Entra).
2. **Fail-Closed Policy Enforcement (`src/router/policy.ts`):** Pass provider placement metadata from `DiscoveryRegistry` into `RoutingPolicy` so `onprem` activities reject any `cloud` backend with HTTP `403` before dispatch.
3. **Structured Egress Telemetry (Mirevox Composition):** Add a Hono middleware emitting one structured JSON line per request and fan-out task (`request_id`, `activity`, `backend`, `placement`, `model`, `status`, `latency_ms`, `usage`, zero payload bodies, zero secrets) so sibling Mirevox modules (`evals`, `data-lineage`) can subscribe out-of-process.
