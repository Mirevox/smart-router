# Mirevox Smart Router — Requirements (draft pending vet lock)

> Source: council gatherer. Devil’s advocate keep/cut applied in architecture honesty boundary; full FR/NFR lock awaits Gemini vetter.


# Mirevox Smart Router — Draft Requirements (Runnable v1 Stub)

- **Brand:** Mirevox (`https://github.com/Mirevox/smart-router`)
- **License:** Apache-2.0
- **Stage:** Council Draft (Requirements Gatherer — awaiting Requirements Vetter, Architect, and FR/NFR tightening)
- **Implementation Stack:** Single stack to be selected by Architect — TypeScript (Fastify/Hono) or Python (FastAPI)

---

## 1. Scope & Stub Honesty Principle

Smart Router v1 is a **runnable stub**: every control-plane mechanism (HTTP gateway, key vault, routing policy engine, parallel task-split fan-out, background polling registry, and structured event emission) is implemented for real and verified end-to-end, while upstream provider connectors (Azure AI Foundry, AWS Bedrock, Google Vertex/Agent Builder, local model runtimes, and MCP servers) operate as **deterministic stub adapters** whenever real credentials or live endpoints are absent.

Stubs must satisfy two honesty rules:
1. They implement the same internal adapter interface that live SDK/HTTP connectors will use, returning valid OpenAI-shaped responses.
2. Every stubbed response is explicitly tagged in response metadata/headers (e.g., `X-Mirevox-Mode: stub`) so neither users nor automated tests mistake canned output for a live model call.

---

## 2. User Stories, Capabilities & Draft Acceptance Criteria

### 2.1 OpenAI-Compatible Gateway (`REQ-GW`)

**User Story:** As a developer using VS Code, a coding harness, or a home chatbot, I want to point my existing OpenAI-compatible client at one local endpoint so I can access local and cloud models without changing client code.

- **`REQ-GW-01` — Chat Completions Endpoint (`POST /v1/chat/completions`)**
  - Capability: Accept standard OpenAI chat completion requests (`model`, `messages`, `temperature`, `max_tokens`, `stream`, optional Mirevox routing headers/metadata) and return OpenAI-shaped completion responses.
  - Draft Acceptance Criteria:
    - Sending a standard OpenAI SDK or `curl` request to `POST /v1/chat/completions` returns HTTP `200` with valid JSON containing `id`, `object` (`"chat.completion"`), `created`, `model`, `choices[0].message.{role,content}`, `choices[0].finish_reason`, and `usage.{prompt_tokens,completion_tokens,total_tokens}`.
    - Non-streaming (`stream: false` or omitted) works for both single-route and fan-out requests.
    - Streaming (`stream: true`) returns `text/event-stream` SSE chunks formatted as `chat.completion.chunk` terminating with `data: [DONE]` for single-backend routes (fan-out streaming behavior is explicitly defined and returns either merged SSE chunks or a documented `400` error if unsupported in v1).

- **`REQ-GW-02` — Model Listing Endpoint (`GET /v1/models`)**
  - Capability: Expose all currently active models (discovered via polling or onboarded by reference) in the standard OpenAI models list format.
  - Draft Acceptance Criteria:
    - `GET /v1/models` returns HTTP `200` with `{"object": "list", "data": [...]}` where each entry includes `id`, `object: "model"`, `created`, and `owned_by`.
    - Inactive/unhealthy models excluded by the registry do not appear in default listings (or are filterable via query param).
    - Adding a model via registry onboarding makes it appear in `GET /v1/models` within `<= 1 s` without restarting the gateway.

- **`REQ-GW-03` — Client Authentication & Standard Error Envelope**
  - Capability: Protect gateway endpoints with configurable client API keys (`Authorization: Bearer <token>`) and return consistent OpenAI-shaped error bodies.
  - Draft Acceptance Criteria:
    - When gateway auth is enabled, requests without a valid bearer token return HTTP `401`.
    - Policy denials return HTTP `403`; invalid payloads return HTTP `400`; unknown models/routes return HTTP `404`; upstream timeouts/errors return HTTP `504`/`502`.
    - 100% of `4xx`/`5xx` gateway responses match `{"error": {"message": "<string>", "type": "<string>", "code": "<string>"}}`.

- **`REQ-GW-04` — Deterministic Zero-Credential Stub Backends**
  - Capability: Execute end-to-end routing against built-in stub adapters for Foundry, Bedrock, Vertex, and local runtimes when no live credentials are configured.
  - Draft Acceptance Criteria:
    - With zero external API keys configured, `POST /v1/chat/completions` routed to any stubbed provider (`foundry`, `bedrock`, `vertex`, `local`) returns HTTP `200` with a valid OpenAI-shaped response in `< 100 ms` (excluding any test-injected artificial latency).
    - Stub responses include response header `X-Mirevox-Mode: stub` and deterministic content referencing the resolved provider, model, and activity so automated tests can assert exact routing outcomes.

---

### 2.2 Central Key Vault (`REQ-KV`)

**User Story:** As an operator, I want to store all upstream provider keys in one place inside Smart Router so my IDE, chatbot, and scripts never hold provider secrets.

- **`REQ-KV-01` — File & Environment-Backed Key Store**
  - Capability: Load provider credentials (Foundry, Bedrock, Vertex, local auth tokens, MCP tokens) and gateway client keys from a local vault file (JSON/YAML) with environment-variable overrides.
  - Draft Acceptance Criteria:
    - Vault resolves credentials in deterministic precedence order: environment variable override > local vault file > unconfigured (triggers stub fallback where allowed).
    - Rotating a provider key in the vault file or env config requires zero changes to any downstream client configuration.
    - Missing vault file on first boot does not crash the router; it boots cleanly in stub mode and logs a clear startup notice.

- **`REQ-KV-02` — Secret Isolation & Zero-Leak Redaction**
  - Capability: Prevent upstream API keys and tokens from ever appearing in HTTP responses, error payloads, registry endpoints, or logs.
  - Draft Acceptance Criteria:
    - Automated test suite injects canary secret values into every vault slot, exercises success, `4xx`, `5xx`, timeout, and debug-log paths, and asserts `0` occurrences of any raw canary string across all response bodies, response headers, and stdout/stderr logs.

- **`REQ-KV-03` — Key Status Inspection Without Secret Exposure**
  - Capability: Allow operators to verify which providers have configured credentials vs. running in stub mode.
  - Draft Acceptance Criteria:
    - Admin status endpoint (e.g., `GET /v1/vault/status`) returns per-provider status (`configured | missing`), source (`env | file | none`), and masked identifier (e.g., last 4 characters or `"not-set"`), and never returns raw key material.
    - Admin endpoints require an admin bearer token (or loopback-only binding when configured).

- **`REQ-KV-04` — Pluggable Vault Adapter Boundary**
  - Capability: Isolate secret retrieval behind a single internal `KeyVault` interface.
  - Draft Acceptance Criteria:
    - No gateway handler, policy rule, or provider adapter reads `process.env` / `os.environ` directly for provider secrets; 100% of secret lookups go through the vault interface so future KMS adapters (HashiCorp Vault, AWS Secrets Manager, Azure Key Vault) can be added without modifying callers.

---

### 2.3 Routing Policy: On-Prem vs. Cloud per Activity (`REQ-RT`)

**User Story:** As a privacy-conscious builder, I want to declare routing rules by activity so sensitive work stays strictly on-prem while general work can use cloud models.

- **`REQ-RT-01` — Declarative Activity-Based Policy Config**
  - Capability: Load routing rules from a versioned YAML/JSON policy file mapping an activity (supplied via header `X-Mirevox-Activity`, model alias, or default fallback) to target locality (`on-prem`, `cloud`, `hybrid`), ordered provider/model targets, and fallback flags.
  - Draft Acceptance Criteria:
    - At least 3 distinct activities (e.g., `private-code`, `general-chat`, `research-hybrid`) can be configured in a single policy file and resolved deterministically at runtime.
    - Invalid policy files fail fast on startup with a human-readable validation error citing the offending rule and field (exit code non-zero).

- **`REQ-RT-02` — Fail-Closed On-Prem Residency Enforcement**
  - Capability: Guarantee that activities pinned to `on-prem` never spill over to cloud providers when local backends are unavailable.
  - Draft Acceptance Criteria:
    - For any rule with `locality: on-prem` and `allow_cloud_fallback: false` (default for `on-prem` rules), if all eligible local targets are unhealthy, timed out, or unconfigured, the router returns HTTP `503` (or `403` when an explicit cloud model is requested under an `on-prem` activity) and dispatches `0` outbound requests to any cloud adapter.
    - Verified by automated negative test simulating local backend outage while healthy cloud adapters are available.

- **`REQ-RT-03` — Ordered Fallback Within Permitted Locality**
  - Capability: Automatically fall back across ordered targets permitted by the matched rule when a primary backend fails or times out.
  - Draft Acceptance Criteria:
    - Given a `cloud` or `hybrid` rule with `[primary, secondary]`, simulating a `500` or timeout on `primary` causes the router to succeed via `secondary` on the same client request, recording both attempts in routing telemetry.
    - Fallback never crosses a forbidden locality boundary (e.g., `on-prem`-only rules never fall back to `cloud`).

- **`REQ-RT-04` — Non-Intrusive Routing Transparency Headers**
  - Capability: Surface routing decisions on every response without breaking OpenAI client compatibility.
  - Draft Acceptance Criteria:
    - Every completion response includes HTTP headers: `X-Mirevox-Request-Id`, `X-Mirevox-Activity`, `X-Mirevox-Route-Locality` (`on-prem | cloud | mixed`), `X-Mirevox-Provider`, `X-Mirevox-Policy-Rule`, and `X-Mirevox-Mode` (`stub | live`).
    - Standard OpenAI SDK clients parse the response body without errors or warnings.

---

### 2.4 Task-Split Fan-Out Across Backends (`REQ-FS`)

**User Story:** As a user sending a multi-part request, I want Smart Router to split the work and execute subtasks in parallel across appropriate backends/toolsets, then combine the results into one response.

- **`REQ-FS-01` — Parallel Subtask Decomposition & Dispatch**
  - Capability: Detect multi-part fan-out requests (via an explicit structured extension field such as `mirevox_tasks: [{id, prompt, activity?, model?}]` or a configured fan-out model/header trigger) and dispatch subtasks concurrently across resolved backends.
  - Draft Acceptance Criteria:
    - A fan-out request containing `N = 3` subtasks targeting stub backends each configured with an artificial delay of `d = 150 ms` completes in `< 250 ms` total wall-clock time (strictly `< 1.7 * d` vs. `450 ms` sequential), proving parallel execution.
    - Each subtask executes against its own resolved provider/model according to routing policy.

- **`REQ-FS-02` — Independent Per-Subtask Policy Enforcement**
  - Capability: Evaluate routing policy independently for each subtask in a fan-out batch.
  - Draft Acceptance Criteria:
    - A single fan-out request containing one subtask tagged `activity: private-code` (`on-prem`) and one subtask tagged `activity: general-chat` (`cloud`) routes the first exclusively to a local backend and the second to a cloud backend; response header reports `X-Mirevox-Route-Locality: mixed`.
    - If the `on-prem` subtask's local backend is unavailable, it fails closed without leaking to cloud, even while the `cloud` subtask succeeds.

- **`REQ-FS-03` — Result Aggregation & Partial-Failure Resilience**
  - Capability: Merge subtask outputs into a single OpenAI-compatible `chat.completion` response while handling individual subtask failures and timeouts cleanly.
  - Draft Acceptance Criteria:
    - When all `N` subtasks succeed, the merged `choices[0].message.content` includes all `N` labeled subtask outputs in deterministic input order, and `usage` aggregates token counts across subtasks.
    - When `1` of `N` subtasks fails or exceeds `subtask_timeout_ms` under default `partial_ok` mode, the gateway still returns HTTP `200` within `total_timeout_ms` with the `N - 1` succeeded outputs plus an explicit error marker for the failed subtask (and a structured `mirevox_fanout` summary or trace header).
    - Under `require_all` mode, any subtask failure returns an OpenAI-shaped `502`/`504` error naming the failed subtask ID.

- **`REQ-FS-04` — Fan-Out Guardrails**
  - Capability: Bound concurrency and latency to prevent runaway fan-out.
  - Draft Acceptance Criteria:
    - Configurable `max_subtasks` (default `5`), `subtask_timeout_ms` (default `5000`), and `total_timeout_ms` (default `10000`).
    - Requests containing `> max_subtasks` subtasks are rejected before dispatch with HTTP `400` and `0` upstream calls made.

---

### 2.5 Discovery, Polling & By-Reference Registry (`REQ-REG`)

**User Story:** As an operator, I want Smart Router to auto-discover models and MCP servers across my cloud accounts and local machines via polling, and let me onboard any model, MCP, or external workflow by reference without copying its code into the router.

- **`REQ-REG-01` — Unified Typed Registry Catalog**
  - Capability: Maintain an in-memory (optionally file-persisted) registry of three resource types: `model`, `mcp`, and `workflow`.
  - Draft Acceptance Criteria:
    - Every registry entry stores: `id`, `kind` (`model | mcp | workflow`), `provider` (`foundry | bedrock | vertex | local | mcp | external`), `locality` (`on-prem | cloud`), `reference_uri`, `source` (`polled | manual`), `status` (`active | degraded | unavailable`), `capabilities` (tags/metadata), and `last_seen_at` (ISO-8601).
    - `GET /v1/registry` returns all entries with optional query filters (`kind`, `provider`, `locality`, `status`).

- **`REQ-REG-02` — Discovery & Polling Adapters for All 5 Ecosystems**
  - Capability: Provide background polling adapters behind a common `DiscoveryAdapter` interface for: (1) Azure AI Foundry, (2) AWS Bedrock, (3) Google Vertex / Agent Builder, (4) Local model runtimes (e.g., Ollama / OpenAI-compatible local URL), and (5) MCP servers.
  - Draft Acceptance Criteria:
    - Each of the 5 pollers runs on a configurable interval (`poll_interval_sec`, plus manual trigger `POST /v1/registry/poll` for fast testing).
    - When real credentials/endpoints are absent, each poller runs in deterministic stub mode and seeds at least `1` representative catalog entry (e.g., Foundry model, Bedrock model, Vertex model, local model, and stub MCP server with tool metadata).
    - For the `local` adapter, pointing it at a reachable mock/real HTTP server (e.g., OpenAI `/v1/models` or Ollama `/api/tags` shape) dynamically imports returned models without stub data.

- **`REQ-REG-03` — Auto-Onboarding & Staleness Eviction**
  - Capability: Automatically onboard newly discovered items and demote entries that vanish or fail consecutive polls.
  - Draft Acceptance Criteria:
    - When a mock discovery source adds a new model or MCP server, it appears in `GET /v1/registry` (and `GET /v1/models` if `kind=model`) within `1` poll cycle (or immediately upon `POST /v1/registry/poll`) with zero restart.
    - When a previously discovered entry disappears or fails `K` consecutive polls (default `K = 2`), its status transitions to `unavailable` and the router excludes it from routing eligibility.

- **`REQ-REG-04` — Manual Onboarding & Removal by Reference**
  - Capability: Onboard any model, MCP server, or external workflow/UI by reference via config file or admin REST API.
  - Draft Acceptance Criteria:
    - `POST /v1/registry/entries` accepts a valid `model`, `mcp`, or `workflow` reference (including external UI/workflow URLs) and returns HTTP `201`; the entry is immediately queryable via `GET /v1/registry`.
    - `DELETE /v1/registry/entries/:id` removes the manual entry (HTTP `200`/`204`) and excludes it from subsequent routing/listings.
    - Manual entries are never overwritten or evicted by background pollers.

---

### 2.6 Control-Plane Observability & Mirevox Composability (`REQ-OBS`)

**User Story:** As the maintainer of sibling Mirevox modules (`evals` and `data-lineage`), I want Smart Router to emit clean routing/egress events and health signals so external modules can attach without modifying router internals.

- **`REQ-OBS-01` — Structured Routing & Egress Audit Log**
  - Capability: Emit one structured JSON event per handled request and per fan-out subtask.
  - Draft Acceptance Criteria:
    - Each JSON log/event record includes: `event_type`, `request_id`, `parent_request_id` (for subtasks), `timestamp`, `activity`, `policy_rule`, `locality`, `provider`, `model`, `mode` (`stub | live`), `status_code`, `latency_ms`, and `token_usage`.
    - Prompt/response payload capture is disabled or explicitly opt-in by config flag (`log_payloads: false` default) to protect sensitive on-prem content.
    - Zero raw secrets appear in any event record.

- **`REQ-OBS-02` — Health & Readiness Endpoints**
  - Capability: Provide container-friendly liveness and readiness probes.
  - Draft Acceptance Criteria:
    - `GET /healthz` returns HTTP `200` with `{"status": "ok"}` in `< 50 ms`.
    - `GET /readyz` returns HTTP `200` when policy is loaded and at least one initial discovery pass has completed, including per-poller status (`last_poll_at`, `mode`, `entry_count`, `last_error`).

---

### 2.7 Packaging, Local Run & Docker Compose (`REQ-OPS`)

**User Story:** As a first-time user, I want to clone the repo and run `docker compose up` to try the complete Smart Router flow in under a minute without signing up for cloud accounts.

- **`REQ-OPS-01` — Zero-Credential Docker Compose Quickstart**
  - Capability: Ship a `Dockerfile`, `docker-compose.yml`, example policy/vault configs, and an automated smoke verification script.
  - Draft Acceptance Criteria:
    - From a fresh checkout with zero `.env` cloud keys, `docker compose up --build -d` brings the service to healthy (`/readyz` = `200`) within `< 30 s` on a standard dev VM.
    - Running the repository smoke script against the running container verifies: `/healthz`, `/readyz`, `/v1/models`, `on-prem` vs. `cloud` routing, fail-closed `on-prem` rejection, parallel task-split fan-out, and registry polling/manual onboarding—all exiting `0`.
    - No external services (no n8n, no Instagram, no database cluster, no homelab stack) are required to boot or pass tests.

- **`REQ-OPS-02` — Modular Code Layout & Open-Source Hygiene**
  - Capability: Structure the codebase into clear, testable modules with Apache-2.0 licensing and honest documentation.
  - Draft Acceptance Criteria:
    - Repository contains `LICENSE` (Apache-2.0), `README.md` (with quickstart, curl examples, stub vs. live explanation, and Mirevox module composition diagram/notes), and cleanly separated internal modules: `gateway`, `vault`, `policy`, `fanout`, `registry` (with 5 poller adapters), and `providers` (with stub adapters).
    - Unit and integration test suites run via a single documented command with `0` external network dependencies.

---

## 3. Explicit Non-Goals (Out of Scope for v1)

| Excluded Area | Why Deferred |
| --- | --- |
| n8n / Instagram workflows | Explicit product boundary; unrelated to core router slice. |
| Full Sherali / homelab stack deployment | Memory and coupling constraint; v1 ships standalone Docker Compose. |
| Mandatory live cloud SDK integrations | v1 proves control-plane contracts via deterministic stub adapters; live SDK connectors plug into the same adapter interface in v1.1+. |
| Enterprise KMS / HSM (Vault, AWS KMS, Azure Key Vault) | Local file/env vault behind a `KeyVault` interface is sufficient for v1. |
| Built-in Web UI / Admin Dashboard | Separate concern; REST APIs + Mirevox showcase/modules own UI. |
| Bundled Evals or Data-Lineage engines | Separate Mirevox modules (`evals`, `data-lineage`) consuming router events. |
| Billing, rate-limit quotas, multi-tenant RBAC | Post-v1 operational hardening once core routing and fan-out stabilize. |
| Custom model hosting or Terraform cloud provisioning | Explicitly deprioritized in Mirevox product synthesis. |

---

## 4. Draft Verification Matrix

| Area | IDs | Verification Method | Measurable Exit Gate |
| --- | --- | --- | --- |
| Gateway | `REQ-GW-01..04` | Integration tests + OpenAI client check | Valid OpenAI JSON/SSE; `401/403/400/404/502/504` envelopes; `< 100 ms` stub latency |
| Key Vault | `REQ-KV-01..04` | Unit + canary leak scan | Precedence works; `0` raw canary leaks in logs/responses/errors |
| Routing Policy | `REQ-RT-01..04` | Unit + outage simulation | `0` cloud egress on failed `on-prem` rule; ordered fallback succeeds within boundary |
| Task-Split Fan-Out | `REQ-FS-01..04` | Concurrency timing + fault injection | `N = 3` at `d = 150 ms` finishes `< 250 ms`; mixed locality enforced; `partial_ok` & `max_subtasks` enforced |
| Registry & Polling | `REQ-REG-01..04` | Poller unit + mock HTTP integration | All 5 ecosystems seeded; dynamic add/evict works in `1..K` polls; manual CRUD works |
| Observability | `REQ-OBS-01..02` | Log schema validation + probe tests | Valid JSON audit events with `0` secrets; `/healthz` `< 50 ms`, `/readyz` reports all pollers |
| Packaging | `REQ-OPS-01..02` | Clean Docker Compose smoke test | Zero-key boot `< 30 s`; full smoke script exits `0`; offline test suite exits `0` |

---

## 5. Open Decisions & Risks for Council Review

1. **Stack Selection (Architect):** Fastify/Hono (TypeScript) vs. FastAPI (Python). Key evaluation factors: SSE streaming ergonomics, lightweight async fan-out, Docker image size, and contributor accessibility.
2. **Task-Split Trigger Ergonomics (Vetter + Architect):** Explicit JSON field (`mirevox_tasks`) is unambiguous and easy to test, whereas prompt-based splitting (e.g., splitting numbered sub-prompts via a deterministic rule) allows unmodified chat UIs to trigger fan-out. Recommend confirming whether v1 supports both (explicit field + opt-in deterministic prompt splitter) or explicit-only first.
3. **Streaming Under Fan-Out (Vetter + Architect):** Merging concurrent streams into a single OpenAI SSE response adds complexity. Recommend deciding whether v1 buffers and emits final merged SSE chunks or returns `400` when `stream: true` is combined with fan-out.
4. **Vault File Security Baseline (Vetter + Devil's Advocate):** Should v1 support optional symmetric encryption (e.g., `MIREVOX_VAULT_MASTER_KEY` + AES-256-GCM) or strictly plaintext JSON/YAML with file-mode warnings + env overrides? Decide the cleanest honest baseline that does not create false security theater.
5. **MCP Execution vs. Discovery Scope (Devil's Advocate):** Clarify whether v1 fan-out can invoke a stubbed MCP tool reference alongside model subtasks, or whether MCP in v1 is strictly discovery/registry + reference lookup (with tool execution stubbed as a subtask target).
