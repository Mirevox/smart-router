# Architecture — Mirevox Smart Router v0.1

**Stack:** TypeScript · Hono · Node 22 · optional Docker Compose  
**License:** Apache-2.0  
**Working tree:** `/home/ubuntu/mirevox/smart-router` (GitHub `Mirevox/smart-router` when org create is unblocked)

## Goals

One OpenAI-compatible endpoint for VS Code and home chatbots that:

1. Holds provider keys centrally
2. Chooses on-prem vs cloud per activity
3. Discovers / polls Foundry, Bedrock, Vertex, local, and MCP catalogs
4. Splits multi-part work and fans out in parallel

v0.1 implements these control-plane mechanisms with **stub provider adapters**. Live SDKs plug into the same backend ids later.

## Module boundaries

```
src/
  index.ts                 boot + graceful shutdown
  config.ts                YAML + env overlay
  types.ts                 shared contracts
  gateway/openai.ts        HTTP surface (OpenAI + admin + fanout)
  vault/key-vault.ts       file/env key vault
  router/policy.ts         model/activity → backend + placement
  fanout/splitter.ts       bounded parallel task runner
  registry/providers.ts    discovery + polling loop
  backends/stub.ts         deterministic OpenAI-shaped completions
```

| Module | Owns | Does not own |
| --- | --- | --- |
| Gateway | Auth, request validation, OpenAI JSON shapes, admin APIs | Provider SDKs |
| Vault | Secret storage/retrieval, redacted listing | IAM / KMS |
| Policy | Placement + backend selection rules | Prompt classification |
| Fan-out | Concurrency, timeouts, ordered results | Planner / LLM task decomposition |
| Registry | Poll schedule, health, model catalog | Credential minting |
| Stub backend | Canned completions tagged `mirevox.stub` | Real inference |

## HTTP API

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/health` | Unauthenticated liveness + provider health |
| GET | `/v1/models` | OpenAI model list from registry |
| POST | `/v1/chat/completions` | Non-streaming stub complete + routing metadata |
| POST | `/v1/fanout` | Mirevox extension: parallel tasks |
| GET/PUT/DELETE | `/admin/keys` | Vault admin |
| GET | `/admin/routes` | Policy dump + samples |
| GET/POST | `/admin/registry` / `.../poll` | Discovery status / force poll |

Auth: `Authorization: Bearer <SMART_ROUTER_API_KEY>` (except `/` and `/health`).

## Request path

```
Client
  → Bearer check
  → RoutingPolicy.decide({ model, activity?, placement?, backend? })
  → stubComplete (v0.1)  [future: live adapter by backend id]
  → { ...openai fields, mirevox: { backend, placement, activity, stub } }
```

Fan-out runs the same path per task with `fanout.max_parallel` workers and preserves input order.

## Placement policy (defaults)

| Activity | Placement |
| --- | --- |
| `chat` | cloud |
| `code` | onprem |
| `embed` | cloud |
| `tool` | onprem |

Model glob routes (`gpt-*`, `local/*`, `foundry/*`, …) map to registry backend ids in `config/default.yaml`.

## Discovery stubs

Registry polls (or marks static) providers:

- `azure-foundry` (foundry)
- `aws-bedrock` (bedrock)
- `google-vertex` (vertex)
- `local-ollama` (local)
- `mcp-bridge` (mcp)
- `mock-openai` / `mock-anthropic` (mock)

Stub catalogs are deterministic. `stub: true` when `SMART_ROUTER_STUB_MODE` is on or no vault key exists for that backend.

## Docker

- `Dockerfile` — multi-stage `npm ci` + `tsc` → `node dist/index.js`
- `docker-compose.yml` — port `18765`, vault volume, healthcheck on `/health`

## Composition

Downstream Mirevox modules (`evals`, `data-lineage`) should consume `mirevox` metadata and request ids rather than re-integrating each provider. This repo does not start a full homelab stack.

## Deferred (see devil’s advocate)

- Wrap LiteLLM / Bifrost as the inference engine instead of a custom stub
- Streaming SSE
- Live Foundry/Bedrock/Vertex/Ollama/MCP SDK adapters
- Encrypted vault / external secret manager
- Prompt-based activity classification
