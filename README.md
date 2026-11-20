# Mirevox Smart Router

OpenAI-compatible control-plane gateway for hybrid home-lab + cloud AI.

Point VS Code, Continue, Open WebUI, or a home chatbot at one local base URL. The router holds provider keys, applies on-prem vs cloud placement by activity, discovers Foundry / Bedrock / Vertex / local / MCP catalogs (stub polling in v0.1), and can fan out multi-part work across backends.

Part of the [Mirevox](https://github.com/Mirevox) open-source control-plane modules. Composes with planned `evals`, `data-lineage`, and harness workflow modules via a single observable choke point.

**License:** Apache-2.0

## Status (v0.1)

Runnable stub. Real mechanisms: HTTP gateway, file/env key vault, routing policy, parallel fan-out, discovery registry with polling loop. Provider adapters return deterministic OpenAI-shaped responses tagged `mirevox.stub: true` until credentials + live SDKs are wired.

| Capability | v0.1 |
| --- | --- |
| `POST /v1/chat/completions` | Stub complete + routing metadata |
| `GET /v1/models` | From discovery registry |
| `POST /v1/fanout` | Parallel task split (Mirevox extension) |
| Key vault | File + `SMART_ROUTER_KEY_*` env |
| Placement policy | Activity → onprem/cloud |
| Registry poll | Foundry / Bedrock / Vertex / local / MCP stubs |
| Streaming | Not yet |
| Live provider SDKs | Deferred |

## Quick start

```bash
npm install
npm test
npm run dev
# listens on http://127.0.0.1:18765
```

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

Docker Compose:

```bash
docker compose up --build
```

Configure via `config/default.yaml` and `.env.example`.

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
docs/                   Council artifacts (problem, requirements, architecture, market, DA)
```

## Docs

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
