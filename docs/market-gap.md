# Mirevox Smart Router — Market Gap Analysis

- **Status:** Locked (v0.1 Council Record)
- **Related Docs:** `docs/requirements.md`, `docs/architecture.md`, `docs/devils-advocate.md`

---

## Bottom line

The market does not need another generic OpenAI-compatible proxy. LiteLLM and several commercial gateways already cover provider normalization, retries, fallbacks, budgets, virtual keys, and observability. Mirevox has a credible opening only if it stays narrower: an operator-owned, home-lab-friendly control plane that inventories both cloud and local capabilities, makes explicit per-activity egress decisions, and can dispatch distinct parts of one task to different models or tools.

That opening is real but not protected. Existing gateways could add similar features. Mirevox must prove that its cross-environment discovery and policy workflow is simpler and more useful than composing LiteLLM, scripts, and a workflow engine.

## Competitive and adjacent products

| Product | What it already does well | Relevance and remaining gap |
|---|---|---|
| **LiteLLM** | Broad provider normalization behind OpenAI-style APIs; routing, retries, fallbacks, load balancing, budgets, rate limits, virtual keys, logging, and self-hosted deployment. It is the strongest direct baseline for a programmable multi-provider proxy. | Mirevox should not claim novelty for unified APIs or basic routing. The possible gap is an opinionated inventory of an operator's Foundry, Bedrock, Vertex, local-model, MCP, and workflow assets, coupled to activity-level local-versus-cloud policy and task decomposition. LiteLLM could plausibly close much of this gap. |
| **OpenRouter** | Very low-friction hosted access to many models through one API, with model availability, pricing, provider selection, and fallback/routing conveniences. It removes provider-account integration work for users willing to use an intermediary. | It is not primarily an operator-owned home-lab control plane. Mirevox can serve users who need their own provider credentials, local endpoints, explicit no-cloud routes, and MCP/workflow inventory. OpenRouter remains more convenient when broad model access matters more than local control. |
| **Portkey** | Mature AI gateway features: multi-provider routing, retries/fallbacks, virtual keys, budgets, guardrails, caching, and detailed observability. It targets production and enterprise governance, with deployment options beyond a simple hosted-only service. | Mirevox cannot credibly beat Portkey on enterprise gateway breadth in v1. Its narrower opportunity is a transparent Dockerized appliance for a single operator or small lab, especially discovery of local and cloud resources plus a simple activity policy. "Self-hosted" alone is not differentiation. |
| **Helicone** | Open-source-oriented LLM observability and gateway capabilities, including request tracing, cost/latency analysis, caching, rate controls, sessions, and integrations. It is useful when understanding traffic is the first problem. | Mirevox's intended center is inventory, egress choice, and orchestration rather than analytics. It should integrate with or export to observability systems instead of rebuilding a full Helicone-class product. |
| **Cloudflare AI Gateway** | Managed edge gateway with analytics, caching, rate limiting, provider abstraction, retries/fallbacks, and tight integration with Workers and Cloudflare's network. It offers a low-operations path for internet-facing applications. | It is cloud-edge-centric. Mirevox can own an offline-capable/local-first decision point and direct access to LAN services, but only if requests truly remain local when policy says so. Cloudflare is the better choice for global edge reach and managed operations. |
| **Custom Nginx/OpenResty/Envoy proxies** | Proven TLS termination, authentication hooks, rate limiting, traffic shaping, health checks, and predictable operations. Teams can build exactly the static routes they need without adopting an AI-specific control plane. | They lack built-in AI resource inventory, model metadata, semantic activity policy, MCP awareness, and task decomposition. However, a few upstreams plus header-based routing may be simpler and safer than Mirevox. Mirevox must justify itself through reduced configuration and useful normalized discovery, not proxy performance. |
| **Hyperscaler-native routers and gateways** | Azure AI Foundry, Amazon Bedrock, and Google Vertex AI provide strong native IAM, audit integration, managed endpoints, model catalogs, regional controls, and provider-specific routing or model-selection features. They are the default for organizations already standardized on one cloud. | Their incentives and abstractions remain centered on their own estates. Mirevox can normalize inventory and policy across multiple clouds and a home lab. It should not pretend to reproduce each cloud's IAM, compliance controls, quotas, or service reliability. Native services will remain preferable inside a single-cloud boundary. |

## Gaps Mirevox can credibly target

### 1. One inventory across owned and rented capabilities

Polling adapters can turn resources the operator already controls into a normalized registry:

- Azure AI Foundry deployments and endpoints
- Amazon Bedrock models, profiles, agents, or configured endpoints
- Google Vertex AI models and endpoints
- local OpenAI-compatible servers or model runners
- MCP servers and selected workflow endpoints

The useful result is not a giant public model catalog. It is a current inventory of *this operator's usable resources*, with source, reachability, capabilities, credentials reference, and last-seen state. Discovery must degrade safely: a failed poll should mark data stale, not silently delete or reroute resources.

### 2. Explicit on-prem versus cloud policy per activity

The router can expose understandable policies such as:

- `private-code-review`: local only; fail closed
- `general-chat`: prefer local, permit named cloud fallbacks
- `image-generation`: cloud allowed, only approved regions/providers
- `tool-use`: only approved MCP servers

This is more concrete than "intelligent routing." The value is an inspectable decision and reason, not an opaque model score. Later versions could incorporate data classification, cost, latency, and health, but v1 should use deterministic rules.

### 3. Task-split fan-out rather than replica selection

Most gateway routing selects one backend for one request or retries equivalent backends. Mirevox can explore decomposing a multi-part request and sending distinct sub-tasks to different model/tool sets in parallel, then returning a structured aggregate.

This is also the riskiest claimed gap. Decomposition, dependency ordering, cancellation, partial failure, aggregation, token growth, and tool permissions make it workflow orchestration—not ordinary load balancing. V1 should use an explicit caller-supplied split plan or deterministic mock splitter, not claim autonomous planning quality.

### 4. One endpoint shaped for a developer and a household interface

A single base URL for VS Code clients and a home chatbot can centralize credentials and policy while exposing different profiles. "Single endpoint" should not mean identical permissions: client identity or separate router keys must select allowed resources, policy, and limits. Otherwise a chatbot compromise could inherit developer-tool access.

### 5. Composable control plane, not a replacement for every gateway

Mirevox should make adapters and policy decisions observable and exportable. It can sit in front of a local server, call a provider directly, or delegate downstream to LiteLLM or another gateway. This is more realistic than immediately reproducing mature spend, telemetry, and enterprise-access features.

## What v1 must not claim

The runnable stub must be described as a contract and integration prototype. It should not claim:

- **Production security or a real secrets vault.** File/env secret references are central configuration, not hardened storage, rotation, envelope encryption, or tenant isolation.
- **Guaranteed privacy, residency, or "data never leaves home."** That requires verified fail-closed routing, DNS/egress controls, tool-call inspection, logs, and testing beyond application-level policy.
- **Complete OpenAI compatibility.** Streaming, tool calls, multimodal payloads, embeddings, errors, usage accounting, and every SDK behavior need separate conformance tests.
- **Working universal discovery.** Registry fixtures and polling interfaces are not authenticated enumeration of Foundry, Bedrock, Vertex, local runtimes, and arbitrary MCP servers.
- **Intelligent or optimal routing.** Deterministic policy rules are useful, but they do not prove quality-, cost-, or latency-optimal selection.
- **Autonomous task decomposition.** A deterministic or caller-supplied fan-out plan does not establish that arbitrary work can be split correctly.
- **Enterprise governance.** V1 will not match hyperscaler IAM/audit controls or Portkey-class tenancy, approvals, quotas, and compliance.
- **High availability or reliable distributed execution.** A Docker Compose process does not provide durable queues, idempotency, recovery, backpressure, or multi-node failover.
- **Safe MCP brokering.** Discovering an MCP server does not validate its tools, constrain arguments, sandbox execution, or prevent prompt/tool injection.
- **Cost savings or benchmark superiority.** These require representative workloads and measured comparisons.

Mocks must be labeled in API responses, logs, documentation, and the registry. A stub that silently substitutes a fake backend would undermine the policy-control premise.

## Why shipping the stub is still worthwhile

1. **It tests the product boundary.** A working request path reveals whether "gateway + inventory + policy + fan-out" is coherent or should be split into separate modules.
2. **It fixes contracts before expensive integrations.** Provider adapter, registry record, policy decision, fan-out result, error, and health schemas can be exercised with fixtures and changed cheaply.
3. **It makes the differentiator testable.** Reviewers can run Docker Compose, submit local-only/cloud-allowed activities, inspect the route reason, and invoke an explicit fan-out without cloud credentials.
4. **It identifies operational hazards early.** Stale discovery, missing secrets, unavailable local models, partial fan-out failure, cancellation, and accidental fallback can be represented and tested before real accounts are connected.
5. **It creates a credible contribution surface.** Contributors can add one provider poller or backend adapter against a stable interface instead of first understanding a full home-lab stack.

The stub is only valuable if its acceptance criteria emphasize observable decisions and failure behavior. Minimum evidence should include: fail-closed local-only routing; no secret values in logs or API output; stale/failed poll status; deterministic parallel fan-out with partial-failure reporting; explicit mock markers; and one endpoint supporting at least two separately authorized client profiles. Without those behaviors, the release is merely another proxy skeleton.

## Positioning test

A defensible one-sentence description is:

> A self-hosted control-plane prototype that inventories your cloud, local, and MCP resources, applies explicit per-activity egress policy, and exposes them through one OpenAI-style endpoint with experimental task fan-out.

If the implementation cannot demonstrate inventory, policy reasons, and fan-out failure semantics, it should be positioned simply as an early gateway scaffold—not as a smart router.
