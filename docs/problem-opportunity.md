
# Mirevox Smart Router — Problem & Opportunity Brief

- **Brand:** Mirevox (`https://github.com/Mirevox/smart-router`)
- **License:** Apache-2.0
- **Stage:** Council Draft (Requirements Gatherer)
- **Target Slice:** Runnable v1 stub (OpenAI-compatible gateway, key vault, routing policy, task-split fan-out, discovery/polling registry stubs, Docker Compose)

---

## 1. The Problem

Builders running serious AI workloads rarely live inside a single provider. A typical setup mixes local models for private or low-cost work (Ollama, vLLM, llama.cpp), one or more hyperscaler model hubs (Azure AI Foundry, AWS Bedrock, Google Vertex AI / Agent Builder), Model Context Protocol (MCP) tool servers, and external workflows or UIs. Today, wiring these together breaks down in five predictable ways:

1. **Client and credential sprawl.** API keys and endpoint URLs get duplicated across VS Code extensions, home chatbots, terminal harnesses, and ad-hoc scripts. Rotating a key or revoking a provider means hunting down every client config by hand.
2. **Policy-blind routing.** Teams and self-hosters want a simple operational rule—keep sensitive code, personal notes, or regulated data on-prem, and send general reasoning or heavy generation to cloud providers—but existing clients hardcode model names rather than activity-level residency rules. Accidental fallback from a local model to a cloud API silently violates privacy and data-residency expectations.
3. **Catalog drift across clouds and local runtimes.** Models, MCP servers, and external workflows change constantly across Foundry, Bedrock, Vertex, and local machines. Static YAML lists go stale within days, forcing operators to manually re-register endpoints every time a model or tool comes online.
4. **Monolithic single-call execution.** Multi-part tasks (for example, summarizing a local document privately while drafting a public outline or querying a toolset) are typically pushed through one model in sequence instead of being split and fanned out in parallel across the best-fit backend for each subtask.
5. **Single-stack gateway lock-in.** Existing proxies such as LiteLLM solve basic OpenAI-to-provider translation, but operators who want to experiment beyond a single stack—onboarding MCP servers and external workflows by reference, enforcing strict on-prem vs. cloud policy per activity, fanning out subtasks, and plugging in live evaluation or data-lineage modules—end up fighting a monolith or writing brittle glue code.

---

## 2. Who Feels This Pain

- **Self-hosters and technical builders** running hybrid setups (a local workstation or home lab paired with cloud APIs) who want one stable endpoint for VS Code, coding harnesses, and a home chatbot.
- **Small engineering teams and enterprise sandboxes** experimenting across Azure AI Foundry, AWS Bedrock, Google Vertex, and on-prem hardware who need central key management and enforceable on-prem vs. cloud boundaries without deploying a heavy enterprise platform.
- **Downstream Mirevox control-plane modules**—specifically `evals` (live conversation evaluation and on-onboarding checks) and `data-lineage` (tracing where AI-bound data travels and enforcing residency)—which need a single, observable routing choke point rather than per-provider integrations.

---

## 3. The Opportunity

Mirevox Smart Router is a modular, open-source control-plane gateway that sits **above** Foundry, Bedrock, Vertex, local runtimes, MCP servers, and external workflows.

Rather than competing on foundation models or building another monolithic platform, Smart Router focuses on five focused responsibilities that compound together:

- **One OpenAI-compatible front door.** VS Code, side agents, home chatbots, and standard OpenAI SDKs point to a single URL and speak a protocol they already support.
- **Centralized keys, isolated from clients.** Clients authenticate to the router; the router holds provider credentials in one vault boundary and never exposes raw upstream secrets to callers or logs.
- **Activity-aware on-prem vs. cloud routing.** Requests declare or resolve to an activity (such as private code review vs. general chat), and declarative policy decides whether traffic stays strictly on-prem (fail-closed) or routes to cloud/hybrid targets.
- **Parallel task-split fan-out.** Multi-part requests can be split into independent subtasks, routed individually through policy, executed concurrently across different backends or toolsets, and merged back into a standard response.
- **Continuous discovery plus by-reference onboarding.** Polling adapters automatically discover available models and MCP capabilities across Foundry, Bedrock, Vertex, and local hosts, while operators can also onboard any model, MCP server, or external workflow/UI simply by reference.

### Fit Within the Mirevox Umbrella

Smart Router is designed to stand alone as a useful Apache-2.0 module while acting as the traffic backbone for the wider Mirevox ecosystem:

- **With `evals`:** Every routed call and newly discovered model emits structured metadata so live traffic and newly onboarded models can be evaluated without duplicating proxy code.
- **With `data-lineage`:** Routing decisions record locality (`on-prem` vs. `cloud`), provider, and policy rule on every request and subtask, providing an authoritative egress trail.
- **With `stage-gate`, `shadow-versioning`, and `context-engine`:** Harnesses and workflows consume the router as their unified model endpoint and can register their MCP servers or external workflows into the router's registry by reference.

In keeping with the Mirevox philosophy, the goal is practical utility: ship a clean, composable open-source component that people can run locally, embed in their own stacks, or commercialize—without over-investing in features hyperscalers will eventually commoditize.

---

## 4. Honest v1 Scope & Boundaries

To ship a working, verifiable v1 quickly without collapsing into a multi-month platform build, v1 targets a **runnable stub architecture**: real gateway contracts, real policy enforcement, real fan-out orchestration, real registry/polling mechanics, and a real local key vault—paired with deterministic stub provider adapters when live cloud credentials are absent.

### In Scope for v1

- OpenAI-compatible HTTP gateway (`/v1/chat/completions`, `/v1/models`, health/readiness endpoints) usable directly by VS Code, chatbots, and `curl`.
- Central key vault backed by environment variables and a local file store, behind a clean adapter interface so KMS backends can be added later.
- Declarative routing policy enforcing on-prem vs. cloud selection per activity, with fail-closed residency guarantees for on-prem-pinned work.
- Task-split fan-out executing multi-part work concurrently across policy-selected backends with timeouts and partial-failure handling.
- Discovery and polling registry with stubbed adapters for Foundry, Bedrock, Vertex, local runtimes, and MCP servers, plus manual by-reference onboarding of models, MCPs, and external workflows/UIs.
- Single-command `docker compose up` setup that boots and passes end-to-end verification with zero cloud API keys required.

### Explicitly Out of Scope for v1

- **No n8n or Instagram integrations.**
- **No full homelab / Sherali stack orchestration.** The router runs standalone via Docker Compose or local process; full homelab deployment is deferred.
- **No mandatory live cloud credentials.** Real provider SDK integration is structured behind provider adapters, but v1 ships deterministic stub adapters returning valid OpenAI-shaped responses so anyone can run, test, and evaluate the full system offline.
- **No enterprise KMS/HSM or multi-tenant RBAC.** Local file/env vault and simple gateway token auth are sufficient for v1.
- **No bundled web UI, eval engine, or data-lineage engine.** Those belong in their own Mirevox modules; Smart Router exposes clean REST APIs and structured event logs for them.
- **No foundation model training, hosting, or cloud Terraform provisioning.**

---

## 5. What Success Looks Like for v1

v1 succeeds when an operator can clone the repository, run `docker compose up` with zero cloud credentials, and verify five concrete outcomes:

1. A standard OpenAI client (such as `curl`, the OpenAI SDK, or a VS Code extension) gets valid completions and model listings from one endpoint.
2. Changing an activity tag shifts traffic deterministically between on-prem and cloud backends, and an on-prem-only activity fails closed rather than leaking to a cloud backend when local targets are down.
3. A multi-part request splits into parallel subtasks across distinct backends (demonstrated by concurrent wall-clock timing and per-subtask trace metadata) and returns a merged OpenAI-compatible response.
4. Background pollers populate and refresh stubbed catalogs across all five ecosystems (Foundry, Bedrock, Vertex, local, MCP), and an operator can onboard or remove a model, MCP, or workflow by reference at runtime.
5. Upstream credentials remain isolated inside the vault and never leak in logs, errors, or API responses.

---

## 6. Open Questions for Downstream Council Roles

To avoid premature lock-in before the next council stages, the following decisions are flagged for explicit resolution:

- **Architect:** Choose one implementation stack for v1—TypeScript (Fastify or Hono) vs. Python (FastAPI)—based on SSE streaming ergonomics, parallel fan-out concurrency, and Docker footprint.
- **Requirements Vetter & Architect:** Confirm the v1 task-split trigger contract: should v1 support an explicit structured subtask list (via extension field or dedicated endpoint), a deterministic delimiter/heuristic splitter for standard OpenAI chat payloads, or both?
- **Requirements Vetter & Architect:** Define SSE streaming (`stream: true`) behavior during task-split fan-out (e.g., stream chunked progress/merged output vs. explicit non-streaming fallback or buffered merge).
- **Market Researcher & Devil's Advocate:** Benchmark Smart Router's wedge against LiteLLM, OpenRouter, Portkey, Bifrost, and Gateway-style proxies—specifically testing whether activity-level fail-closed residency + by-reference MCP/workflow registry + parallel fan-out is a durable differentiator worth shipping.
- **Devil's Advocate:** Challenge where stub realism stops—identify any v1 stub shortcuts that would make swapping in live Foundry/Bedrock/Vertex/Ollama adapters painful later.
