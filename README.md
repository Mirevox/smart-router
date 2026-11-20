# Mirevox Smart Router

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

OpenAI-compatible control-plane gateway for hybrid home-lab + cloud AI.

Part of [Mirevox](https://github.com/Mirevox).

## Problem

AI setups rarely use one provider. A home lab or small team may mix local models with Azure AI Foundry, Amazon Bedrock, Google Vertex AI, and MCP tools, while VS Code, chat UIs, and scripts each keep their own endpoints and credentials.

Existing gateways already solve the basic “one API for many models” problem. The harder part for a hybrid setup is knowing which resources are actually available, deciding which activities may leave the local network, and making that decision visible and enforceable. Static model lists drift, and a client-selected cloud model can bypass an intended local-only workflow.

Smart Router explores that narrower control-plane problem: one operator-owned inventory, explicit per-activity placement rules, and an OpenAI-shaped entry point that other Mirevox modules can observe. **v0.1 is a contract prototype:** routing, polling, and fan-out machinery run locally, but provider catalogs and completions are stubs, live provider SDKs are not wired, and local-only policy is not yet a fail-closed security boundary.

## Quick start (Docker)

One command (no cloud keys required; stub mode on by default):

```bash
docker compose up --build
# http://127.0.0.1:18765/health
```

Optional: `cp .env.example .env` and set `SMART_ROUTER_API_KEY` (and later `SMART_ROUTER_KEY_*`). Secrets stay in env / the `router-data` volume — **nothing secret is baked into the image**.

```bash
curl -s http://127.0.0.1:18765/health

curl -s http://127.0.0.1:18765/v1/models \
  -H "Authorization: Bearer mirevox-dev-key"

curl -s http://127.0.0.1:18765/v1/chat/completions \
  -H "Authorization: Bearer mirevox-dev-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "local/llama3.2",
    "activity": "code",
    "messages": [{"role":"user","content":"explain this router"}]
  }'
```

### Local Node (optional)

```bash
cp .env.example .env   # optional
npm install
npm test
npm run dev            # http://127.0.0.1:18765
```

Configure via `config/default.yaml` and `.env.example`.

## Status (v0.1)

Runnable **stub** appliance. Real mechanisms: HTTP gateway, file/env key vault, routing policy, parallel fan-out, discovery registry with polling loop, Docker Compose + healthcheck. Provider adapters return deterministic OpenAI-shaped responses tagged `mirevox.stub: true` until credentials + live SDKs are wired.

| Capability | v0.1 |
| --- | --- |
| `POST /v1/chat/completions` | Stub complete + routing metadata |
| `GET /v1/models` | From discovery registry |
| `POST /v1/fanout` | Parallel task split (Mirevox extension) |
| Key vault | File + `SMART_ROUTER_KEY_*` env (volume-mounted in Compose) |
| Placement policy | Activity → onprem/cloud |
| Registry poll | Foundry / Bedrock / Vertex / local / MCP stubs |
| Docker standup | `Dockerfile` + `docker-compose.yml` + healthcheck + `.env.example` |
| Streaming | Not yet |
| Live provider SDKs | Deferred |
| Production security | **Not claimed** — see honest gaps below |

### Honest Docker / production gaps

| Bar | v0.1 |
| --- | --- |
| One-command `docker compose up --build` | Supported (defaults; no `.env` required) |
| Healthcheck | Image `HEALTHCHECK` + Compose healthcheck via Node `fetch` → `/health` |
| `.env.example` | Present; `.env` gitignored |
| No secrets in image | Enforced via `.dockerignore` + runtime-only env/volume; default config has a **well-known** `mirevox-dev-key` placeholder only |
| Non-root container user | `mirevox` user in runtime image |
| TLS termination / reverse proxy | Not included |
| Separate client vs admin API keys | Deferred (`H-03`) |
| Encrypted vault / KMS | Not included (plaintext `0o600` file on volume) |
| Fail-closed residency `403` | Deferred (`H-01`) |
| Live multi-replica / HA | Not included |
| Compose verified on this agent VM | **Unverified here** (no Docker daemon) — verify on a Docker host/CI |

This is an easy **home-lab stub standup**, not a production-hardened gateway.

## Client setup

Set any OpenAI-compatible client:

- **Base URL:** `http://127.0.0.1:18765/v1`
- **API key:** value of `SMART_ROUTER_API_KEY` (default `mirevox-dev-key`)

Optional request fields (JSON body):

- `activity` — drives placement (`chat` → cloud, `code` → onprem by default)
- `placement` — force `cloud` or `onprem`
- `backend` — force a registry backend id

## Module layout

```
src/
  gateway/openai.ts     OpenAI-shaped HTTP surface + admin APIs
  vault/key-vault.ts    Central key store (file + env)
  router/policy.ts      Model/activity → backend + placement
  fanout/splitter.ts    Parallel task fan-out
  registry/providers.ts Discovery + polling stubs
  backends/stub.ts      Deterministic stub completions
config/default.yaml
Dockerfile / docker-compose.yml / .env.example
docs/                   Council + validation artifacts
```

## Docs

- [Problem statement](docs/problem-statement.md)
- [Problem & opportunity](docs/problem-opportunity.md)
- [Requirements (FR/NFR)](docs/requirements.md)
- [Architecture](docs/architecture.md)
- [Market gap](docs/market-gap.md)
- [Devil’s advocate](docs/devils-advocate.md)

## Compose with other Mirevox modules

Smart Router is the traffic choke point. Downstream modules should subscribe to request metadata (`backend`, `placement`, `activity`, `stub`) rather than re-integrating each provider. Do not start a full homelab stack from this repo.

## Development

```bash
npm run typecheck
npm test
npm run build && npm start
```

Default port `18765` avoids clashing with common 3000/5173/8080 services.

## License

Licensed under the [Apache License, Version 2.0](LICENSE). See `LICENSE` in the repository root. `package.json` declares `"license": "Apache-2.0"`.
