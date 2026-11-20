# Architecture — Mirevox Smart Router v0.1

Stack: TypeScript, Hono, Node 22. Docker Compose optional.

## Runtime modules

| Module | Path | Responsibility |
| --- | --- | --- |
| Gateway | `src/gateway/openai.ts` | OpenAI-compatible HTTP + admin APIs |
| Key vault | `src/vault/key-vault.ts` | File/env secrets; list without leaking |
| Routing policy | `src/router/policy.ts` | activity/model → placement + backend |
| Fan-out | `src/fanout/splitter.ts` | Parallel task execution with concurrency cap |
| Registry | `src/registry/providers.ts` | Discovery/polling stubs (Foundry/Bedrock/Vertex/local/MCP/mock) |
| Stub backend | `src/backends/stub.ts` | Deterministic OpenAI-shaped completions |

## Request path

```
Client (VS Code / chatbot)
  → Bearer auth
  → RoutingPolicy.decide(model, activity, overrides)
  → stubComplete (v0.1) | future live adapter
  → response + mirevox{backend,placement,activity,stub}
```

Fan-out uses the same decide + stub path per task, ordered results, `max_parallel` workers.

## Config & data

- `config/default.yaml` — server, routes, registry, fanout
- `data/vault.json` — local secrets (gitignored)
- Env overrides: `SMART_ROUTER_*` and `SMART_ROUTER_KEY_<BACKEND>`

## Docker

`Dockerfile` multi-stage build; `docker-compose.yml` publishes `18765` and persists vault volume.

## Honesty boundary

v0.1 adapters are stubs. Live SDKs plug into the same backend id surface without changing the OpenAI client contract. Devil’s-advocate alternative (wrap LiteLLM) is deferred — see `docs/devils-advocate.md`.
