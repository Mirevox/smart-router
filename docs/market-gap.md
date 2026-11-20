# Mirevox Smart Router — Market Gap Analysis

- **Status:** Validation refresh (2026-11-20)
- **Related:** `docs/problem-statement.md`, `docs/requirements.md`, `docs/devils-advocate.md`
- **Source research:** internal validation report (GPT)

---

## Bottom line

The market does **not** need another generic OpenAI-compatible proxy. LiteLLM, Bifrost, Agent Router, and Portkey already cover unified APIs, credentials, routing, and easy local deployment. Two Apache-2.0 peers (Bifrost, Agent Router) remove license as a differentiator.

**Smart Router v0.1 fills a contract/positioning gap, not an operational product gap.** Inference and Foundry/Bedrock/Vertex/local/MCP catalogs are stubs; on-prem placement is a preference, not fail-closed. A narrow later opportunity remains: reviewed operator-owned inventory + fail-closed per-activity egress—but leaders can close that too.

---

## Top 4 open-source alternatives

| Product | License | What it does | Strengths | Weakness vs Mirevox intent | URL |
| --- | --- | --- | --- | --- | --- |
| **LiteLLM** | MIT (+ paid Enterprise) | Self-hosted gateway/SDK for 100+ providers behind OpenAI APIs | Broadest coverage; virtual keys, budgets, routing, MCP; live wildcard discovery (Bedrock, Vertex, vLLM, …); Docker | No first-class activity residency or task-split endpoint; discovery ≠ full owned-estate inventory | [litellm.ai](https://www.litellm.ai/) · [docs](https://docs.litellm.ai/) |
| **Bifrost** | Apache-2.0 (+ Enterprise) | High-performance Go gateway unifying 20+ providers | Apache peer; Bedrock/Vertex/Azure/Ollama; MCP; background live model-catalog refresh | Polling is provider model lists, not normalized Foundry+local+MCP estate inventory; no activity egress contract / fan-out | [GitHub](https://github.com/maximhq/bifrost) · [docs](https://docs.getbifrost.ai/overview) |
| **Agent Router** | Apache-2.0 | Envoy-based control plane for models + MCP | Apache peer; strong policy/extensions; one-command local CLI + Docker; K8s path | Heavier ops; no documented task fan-out or activity policy; not cross-estate poller | [theagentrouter.ai](https://theagentrouter.ai/) · [GitHub](https://github.com/theagentrouter/agent-router) |
| **Portkey AI Gateway OSS** | MIT | Lightweight OSS gateway + commercial control plane | Mature routing/resilience; tiny local start (`npx`) | Owned-estate discovery, activity residency, fan-out not in OSS center of gravity | [GitHub](https://github.com/Portkey-AI/gateway) · [OSS docs](https://portkey.ai/docs/product/open-source) |

**License note:** Prefer Apache-2.0 for Mirevox (shipped). Bifrost/Agent Router already offer Apache-2.0 engines—license alone is not a gap.

---

## Top 4 paid / commercial alternatives

| Product | Delivery | Strengths | Weakness vs Mirevox intent | Pricing (public) | URL |
| --- | --- | --- | --- | --- | --- |
| **OpenRouter** | Hosted API | Lowest-friction multi-model access; smart provider routing; BYOK | Intermediary, not local control plane; no local/MCP estate poller | Free tier; Standard **5.5%**; Business **8%**; Enterprise custom | [openrouter.ai/pricing](https://openrouter.ai/pricing) |
| **Portkey / PRISMA AIRS** | SaaS / hybrid / VPC / self-host | Enterprise keys, guardrails, observability, MCP registry | Enterprise-shaped; not home-lab appliance; no task fan-out API | Dev free 10k req; Pro **$49**/mo; Enterprise custom | [portkey.ai](https://portkey.ai/docs/product/ai-gateway) |
| **Cloudflare AI Gateway** | Managed edge | Low ops; analytics; BYOK; Workers integration | Not LAN fail-closed; no owned local/MCP inventory | Core free; Unified Billing **5%** on credits | [developers.cloudflare.com/ai-gateway](https://developers.cloudflare.com/ai-gateway/reference/pricing/) |
| **Kong AI Gateway / Konnect** | Managed / hybrid / self-host | Enterprise API/AI governance; MCP bundling | Enterprise API-platform weight; configured not discovered estate | Konnect Plus from **$25**/mo + usage; Enterprise custom | [konghq.com/products/kong-ai-gateway](https://konghq.com/products/kong-ai-gateway) |

---

## Capability gap matrix

Legend: **Yes** / **Partial** / **No** / **Stub** (interface live, data/exec fake).

| Capability | Mirevox v0.1 | LiteLLM | Bifrost | Agent Router | Portkey OSS | OpenRouter | Portkey paid | Cloudflare | Kong |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Unified OpenAI API | **Partial** | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Central provider keys | **Partial** | Yes | Yes | Yes | Partial | Yes | Yes | Yes | Yes |
| Activity on-prem/cloud policy | **Partial** | Partial | Partial | Partial | Partial | Partial | Partial | No | Partial |
| Discovery Foundry+Bedrock+Vertex+local+MCP | **Stub** | Partial | Partial | Partial | No | No | Partial | No | Partial |
| Parallel multi-task fan-out | **Partial** | No | No | No | No | No | No | No | No |
| Home-lab Docker / local appliance | **Yes** | Yes | Yes | Yes | Yes | No | Partial | No | Partial |
| Composable control-plane hooks | **Partial** | Yes | Yes | Yes | Partial | No | Yes | Partial | Yes |

### Matrix notes

- Mirevox OpenAI API is Partial: HTTP shape live; `stream: true` → `501`; inference stubbed.
- Activity policy is Partial until fail-closed `403` + zero-cloud-call tests (`H-01`).
- Fan-out executor is real; completions are stubs—unusual among gateways, not a moat alone.
- **Docker standup is table stakes**, not differentiation (LiteLLM/Bifrost/Agent Router/Portkey OSS all ship easy local paths).

---

## Verdict

| Question | Answer |
| --- | --- |
| Does **v0.1** solve a real market gap? | **No** — runnable contract prototype in a saturated category. |
| Is there a real gap in **intent**? | **Yes, narrow:** reviewed owned-estate inventory + fail-closed activity egress. |
| Is Apache-2.0 a differentiator? | **No** (Bifrost, Agent Router). |
| Is the gap durable? | **Probably not** — incumbents can add activity fields and broader pollers. |

### What v1 must not claim

Production vault/KMS · guaranteed residency · complete OpenAI compatibility · working universal discovery · intelligent routing · autonomous decomposition · enterprise governance · HA · safe MCP brokering · cost/benchmark superiority. Stubs must stay labeled.

### Evidence to flip Stub/Partial → Yes

1. Live local + cloud inference paths (no silent stub fallback).
2. ≥2 live discovery adapters with stale/error semantics; discovered ≠ auto-routable.
3. Local-only activity → stable deny + **zero** outbound cloud calls in test.
4. Separate client vs admin credentials.
5. Event/hook consumed by `evals` or `data-lineage`.
6. Side-by-side: same outcome not easier in LiteLLM/Bifrost alone—else ship policy as an extension.

---

## Why the stub is still worth shipping

Locks Mirevox contracts (`/v1/fanout`, `/admin/*`, activity placement metadata) before expensive adapters; enables honest module composition; makes overclaims reviewable. Position as an **early control-plane scaffold**, not a replacement for mature gateways—until the evidence bar above is met.
