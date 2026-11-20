# Mirevox Smart Router — Problem & Opportunity Brief

- **Brand:** Mirevox (`https://github.com/Mirevox/smart-router`)
- **License:** Apache-2.0
- **Status:** Locked (v0.1 Runnable Stub)
- **Implementation Stack:** TypeScript / Hono (`@hono/node-server`), Node.js `>= 20`, Docker Compose

---

## 1. The Problem

Builders running serious AI workloads rarely live inside a single provider. A typical setup mixes local models for private or low-cost work (Ollama, vLLM, llama.cpp), one or more hyperscaler model hubs (Azure AI Foundry, AWS Bedrock, Google Vertex AI / Agent Builder), Model Context Protocol (MCP) tool servers, and external workflows or UIs. Today, wiring these together breaks down in five predictable ways:

1. **Client and credential sprawl.** API keys and endpoint URLs get duplicated across VS Code extensions, home chatbots, terminal harnesses, and ad-hoc scripts. Rotating a key or revoking a provider means hunting down every client config by hand.
2. **Policy-blind routing.** Teams and self-hosters want a simple operational rule—keep sensitive code, personal notes, or regulated data on-prem, and send general reasoning or heavy generation to cloud providers—but existing clients hardcode model names rather than activity-level residency rules. Accidental fallback from a local model to a cloud API silently violates privacy and data-residency expectations.
3. **Catalog drift across clouds and local runtimes.** Models, MCP servers, and external workflows change constantly across Foundry, Bedrock, Vertex, and local machines. Static YAML lists go stale within days, forcing operators to manually re-register endpoints every time a model or tool comes online.
4. **Monolithic single-call execution.** Multi-part tasks (for example, summarizing a local document privately while drafting a public outline or querying a toolset) are typically pushed through one model in sequence instead of being split and fanned out in parallel across the best-fit backend for each subtask.
5. **Single-stack gateway lock-in.** Existing proxies such as LiteLLM solve basic OpenAI-to-provider translation, but operators who want to experiment beyond a single stack—owning explicit activity policies, structured parallel fan-out, and clean integration points for live evaluation or data-lineage modules—end up fighting a monolith or writing brittle glue code.

---

## 2. Who Feels This Pain

- **Self-hosters and technical builders** running hybrid setups (a local workstation or home lab paired with cloud APIs) who want one stable endpoint for VS Code, coding harnesses, and a home chatbot.
- **Small engineering teams and enterprise sandboxes** experimenting across Azure AI Foundry, AWS Bedrock, Google Vertex, and on-prem hardware who need central key management and enforceable on-prem vs. cloud boundaries without deploying a heavy enterprise platform.
- **Downstream Mirevox control-plane modules**—specifically `evals` (live conversation evaluation and onboarding checks) and `data-lineage` (tracing where AI-bound data travels and enforcing residency)—which need a single, observable routing choke point rather than per-provider integrations.

---

## 3. The Opportunity

Mirevox Smart Router is a modular, open-source control-plane gateway designed to sit **above** Foundry, Bedrock, Vertex, local runtimes, and MCP servers.

Rather than competing on foundation models or building another monolithic platform, Smart Router focuses on five focused responsibilities that compound together:

- **One OpenAI-compatible front door.** VS Code, side agents, home chatbots, and standard OpenAI SDKs point to a single URL and speak a protocol they already support (`/v1/models`, `/v1/chat/completions`).
- **Centralized keys, isolated from clients.** Clients authenticate to the router; the router holds provider credentials in one local vault boundary (`./data/vault.json` + `SMART_ROUTER_KEY_*` env overrides) and never exposes raw upstream secrets in `/admin/keys` listings.
- **Activity-aware on-prem vs. cloud routing.** Requests declare an activity (such as `code` vs. `chat`), and declarative YAML policy resolves placement (`onprem` vs. `cloud`) and backend targets.
- **Parallel task-split fan-out.** Multi-part requests submitted to `POST /v1/fanout` execute concurrently across policy-selected backends with bounded parallelism, per-task timeouts, and order-preserving results.
- **Polling discovery registry.** Background polling tracks configured Foundry, Bedrock, Vertex, local, MCP, and mock providers behind one catalog API (`/admin/registry`, `/v1/models`).

### Fit Within the Mirevox Umbrella

Smart Router is designed to stand alone as a useful Apache-2.0 module while acting as the traffic backbone for the wider Mirevox ecosystem:

- **With `evals`:** Every routed call carries routing metadata (`backend`, `placement`, `activity`, `stub`), laying the groundwork for structured evaluation hooks in v0.2+.
- **With `data-lineage`:** Activity-level placement decisions establish the egress boundary where structured audit logging attaches in v0.2+.
- **With `stage-gate`, `shadow-versioning`, and `context-engine`:** Harnesses consume the router as their unified model endpoint without embedding provider credentials.

---

## 4. Honest v0.1 Scope & Boundaries

To ship a working, verifiable v0.1 without collapsing into a multi-month platform build, v0.1 targets a **runnable stub architecture that Mirevox owns**: real gateway routes, real bearer auth, real YAML/env configuration, real `0o600` file + env key storage, real policy resolution, real parallel fan-out orchestration, and a real periodic registry poll loop—paired with **deterministic stub execution and stub discovery catalogs** (`stub: true`) so zero cloud credentials are required.

### In Scope for v0.1 (Shipped)

- OpenAI-compatible HTTP gateway (`POST /v1/chat/completions`, `GET /v1/models`, `GET /health`, `GET /`) on port `18765`.
- Central file + env key vault (`src/vault/key-vault.ts`, `/admin/keys`) with redacted listings and `0o600` persistence.
- Declarative YAML routing policy (`src/router/policy.ts`, `GET /admin/routes`) resolving `onprem` vs. `cloud` placement per activity and backend via prefix-glob patterns.
- Explicit parallel task-split fan-out on `POST /v1/fanout` (`src/fanout/splitter.ts`) with bounded concurrency (`max_parallel`), per-task timeouts, error isolation, and input-order preservation.
- Config-driven discovery & polling registry (`src/registry/providers.ts`, `/admin/registry`, `/admin/registry/poll`) with deterministic stub catalogs for Foundry, Bedrock, Vertex, local, MCP, and mock providers.
- Single-command `docker compose up --build` setup that boots cleanly with zero cloud API keys.

### Explicitly Out of Scope for v0.1

- **No n8n or Instagram integrations.**
- **No full homelab / Sherali stack orchestration.**
- **No live cloud provider SDKs or live Ollama HTTP calls.** All completions and discovery polls in v0.1 are labeled stubs (`stub: true`); live adapters (or downstream LiteLLM delegation) land in v0.2+.
- **No fail-closed `403` policy deny yet.** v0.1 resolves placement and nudges fallback `code` traffic to `local-ollama`; strict `403` rejection of explicit cloud models under `onprem` activities is the #1 v0.2 hardening gate (see `docs/requirements.md`).
- **No SSE streaming (`stream: true` returns `501`), workflow URL fetching (SSRF), or MCP stdio execution (RCE).**
- **No enterprise KMS/HSM, encryption theater, multi-tenant RBAC, Web UI, bundled evals, or bundled data-lineage engine.**

---

## 5. Resolved v0.1 Council Decisions

Questions raised during early scoping were resolved and locked for v0.1 (see `docs/requirements.md`, `docs/architecture.md`, and `docs/devils-advocate.md`):

1. **Stack Selection:** Locked to **TypeScript + Hono (`@hono/node-server`)** on Node.js `>= 20`.
2. **Task-Split Contract:** Locked to a **separate explicit endpoint (`POST /v1/fanout`)** with caller-supplied `tasks[]`, keeping `POST /v1/chat/completions` strictly single-route OpenAI-compatible.
3. **Streaming:** Deferred; `POST /v1/chat/completions` returns HTTP `501` when `stream: true`.
4. **Owned Gateway vs. LiteLLM Wrap:** Devil's Advocate (`docs/devils-advocate.md`) recommended wrapping a pinned LiteLLM/Bifrost proxy rather than owning a new gateway. v0.1 locks to the shipped Hono stub gateway to own Mirevox's control-plane contracts, while recording **LiteLLM/Bifrost delegation behind `src/backends/` as a deferred v0.2+ alternative**.
