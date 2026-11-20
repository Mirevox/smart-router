# Smart Router — Problem Statement

- **Repo:** https://github.com/Mirevox/smart-router
- **License:** Apache-2.0
- **Status:** v0.1 runnable stub (contract prototype)

## The problem we solve

Hybrid AI operators do not lack another OpenAI-compatible proxy. They lack a **small, operator-owned control point** that answers three questions for every request:

1. **What can I actually call?** Which Foundry / Bedrock / Vertex / local / MCP resources are configured and currently known—not a public mega-catalog.
2. **Where may this activity go?** Which work (code review, chat, tools) must stay on-prem versus may use cloud—without each client reinventing the rule.
3. **Who holds the keys?** One place for provider credentials so VS Code, a home chatbot, and scripts do not each store every upstream secret.

Today those answers are scattered across client configs, static YAML, and ad-hoc scripts. Accidental cloud fallback is easy; a shared inventory goes stale; multi-part work is forced through a single model sequentially.

## Who it is for

- Home-lab and self-host builders mixing local models with one or more cloud hubs.
- Small teams that want a Dockerized choke point before adopting a heavy enterprise gateway.
- Other Mirevox modules (`evals`, `data-lineage`, stage-gate harnesses) that need one observable routing surface.

## What Smart Router is

A modular Apache-2.0 gateway that sits **above** providers (not a foundation model):

| Capability | Intent |
| --- | --- |
| Single OpenAI-shaped base URL | Clients point at one `/v1` |
| Central key vault | File + env; clients auth to the router |
| Activity → placement policy | Declarative on-prem vs cloud |
| Discovery / polling registry | Inventory of *this operator’s* backends |
| Explicit fan-out | `POST /v1/fanout` for caller-supplied parallel tasks |
| Compose standup | `docker compose up --build` with healthcheck |

It composes with the Mirevox control plane; it does not replace LiteLLM/Bifrost-class provider coverage in v0.1.

## Honest v0.1 boundary

v0.1 ships **real** HTTP auth, policy resolution, vault file permissions, fan-out orchestration, registry poll loop, and Docker packaging. Upstream completions and discovery catalogs are **deterministic stubs** (`stub: true` / `mirevox.stub: true`).

| Claim | v0.1 truth |
| --- | --- |
| Unified OpenAI API | Partial — shape live; streaming `501`; inference stubbed |
| Central keys | Partial — local file/env, not KMS; one shared gateway key |
| Activity on-prem/cloud policy | Partial — preference/nudge, **not** fail-closed `403` |
| Cross-estate discovery | Stub catalogs only |
| Parallel fan-out | Live executor; stub task completions |
| Docker one-command standup | Supported; Compose runtime verify on a Docker host |
| Production security / HA / TLS | **Not claimed** |

## Market honesty (validation pass)

Top alternatives already cover “one API + routing + Docker”: LiteLLM, Bifrost (Apache-2.0), Agent Router (Apache-2.0), Portkey OSS, plus paid OpenRouter / Portkey / Cloudflare AI Gateway / Kong AI Gateway. **v0.1 does not close an operational product gap**—it locks contracts for a narrower wedge: reviewed owned-estate inventory + fail-closed activity egress + composable hooks for sibling modules. See `docs/market-gap.md`.

## Success for the next release (not this stub)

Call a later release a real solution only when live local+cloud inference, live discovery adapters with stale/error semantics, fail-closed local-only denial with zero cloud calls in test, separate client/admin credentials, and a small event hook consumed by another Mirevox module are demonstrated—and the same outcome is not easier to configure in LiteLLM or Bifrost alone.
