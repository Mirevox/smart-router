# Devil's Advocate — Mirevox Smart Router

> **Council Disposition Note (v0.1):** This document preserves the unedited adversarial review from the v0.1 council. Its recommendation to wrap a pinned LiteLLM (or Bifrost) proxy instead of owning a custom gateway is recorded as a **deferred v0.2+ architectural alternative** (backend delegation behind `src/backends/`). For v0.1, Mirevox locks to the shipped Hono TypeScript stub gateway while adopting this review's key cuts (separate `POST /v1/fanout` endpoint, no workflow URL fetching or MCP stdio execution, no vault encryption theater, explicit stub labeling, and v0.2 hardening gates for fail-closed `403` enforcement and structured egress logging). See `docs/requirements.md` and `docs/architecture.md` for the full keep/cut/defer disposition.

---

Status: adversarial review of the council brief and product synthesis. Nothing here is a locked requirement. Claims that fail this note should come out of v1 before anyone writes a provider adapter.

Sources for the overlap, checked 20 November 2026:

- LiteLLM proxy: OpenAI-compatible endpoint, Bedrock, Azure OpenAI, Vertex, Ollama, vLLM, fallbacks, load balancing, virtual keys, budgets, provider keys held at the gateway, MCP gateway. [Quick start](https://docs.litellm.ai/docs/proxy/quick_start), [fallbacks](https://docs.litellm.ai/docs/proxy/reliability), [MCP](https://docs.litellm.ai/docs/mcp), [overview](https://docs.litellm.ai/).
- Same category, already shipping: Bifrost (Apache-2.0), Portkey Gateway (MIT), Envoy AI Gateway (Apache-2.0), MLflow AI Gateway. 2026 roundups: [Tyk](https://tyk.io/learning-center/open-source-ai-gateways/), [Vercel](https://vercel.com/i/open-source-ai-gateways).

## Verdict

Yes. The v1 in the brief is LiteLLM with extra steps, and the extra steps are the ones that make it vapor.

A from-scratch Fastify, Hono, or FastAPI gateway that stores keys in a file, stubs Foundry, Bedrock, Vertex, and local, and "fans out" is a second-rate copy of a proxy that already speaks `/v1/chat/completions` to those providers. Mock JSON named `foundry` does not sit above Foundry. A dotenv file is not a vault. A function that concatenates two mock completions is not task splitting.

The one sentence in the intent that is not already a gateway checkbox is "split multi-part work and fan out." That sentence is an orchestrator (a planner, a merge rule, cancellation, partial failure). Putting it inside a new proxy does not make it smaller. It makes the OpenAI-compatible promise false, because VS Code and a home chatbot send one chat completion and expect one completion.

Ship a policy profile on an existing engine. Do not write another engine.

## The thesis, claim by claim

**"Sit above Foundry, Bedrock, Vertex/Agent Builder, and local models."** LiteLLM already routes Azure OpenAI, Bedrock, Vertex, and Ollama through one OpenAI-shaped endpoint, with region-aware fallbacks. Foundry Agent Service, Vertex Agent Builder, and Bedrock Agents are not chat models. They have threads, tools, and their own state. A registry row `{provider: "foundry"}` pretends that impedance match exists. It does not. v1 can sit in front of chat-completion deployments only. Agent runtimes are a different product.

**"Onboard any model, MCP, and workflow by reference."** "Any" is the tell. LiteLLM's MCP gateway already registers MCP servers once and exposes them on a fixed endpoint with per-key permissions, including streamable HTTP, SSE, and stdio. Workflow URLs are an integration catalog. The build plan already defers n8n. "Workflow by reference" puts n8n back in through the side door, and a router that fetches caller-supplied URLs is an SSRF bug.

**"Auto-onboard via polling."** Static `model_list` config is what every serious gateway uses on purpose. A poller that registers whatever it can see will attach new deployments, new regions, and new fine-tunes with no human. That is the opposite of the residency story the data-lineage module wants. Discovery credentials are admin-shaped. Inference credentials are not. One poller holding both is the largest key in the house, stored so a stub can look finished.

**"Central API keys."** This is the gateway's entire job, and it is done. LiteLLM's own pitch is that apps hold a virtual key and provider keys stay in the gateway. Reimplementing virtual keys, budgets, and team ACLs is how v1 dies. A file or env map is the tutorial step those projects tell you to leave.

**"Choose on-prem vs provider per activity."** This is the only routing claim worth keeping, and only if "activity" is an explicit input, not a classifier. A header or a named route group that may use `local` or `cloud` deployments is a small config. Inferring the activity from the prompt is a second model call, a policy bug, and an eval problem. LiteLLM fallback lists do not encode "this activity must not leave the machine." That deny rule is the wedge. It is a config and a test, not a new proxy.

**"Single endpoint for VS Code and the home chatbot."** Continue, Cline, Open WebUI, and LibreChat already take a base URL. The clients are not this repo. One endpoint is the admission ticket, not the product.

**"Experiment beyond a single stack."** An experiment is not a ship goal. Bifrost, Portkey, and Envoy exist for people who do not want LiteLLM's Python. Picking a second stack "to learn" doubles the adapter surface and halves the chance of a green compose file. TensorZero already tried gateway plus evals plus experimentation in one product. That bundle is occupied territory; do not reopen it as a stub.

**"Composable with evals and lineage."** Those modules need a request id, a deployment class, a model id, latency, and token counts. They do not need Mirevox to own the bytes. A LiteLLM callback or a proxy access log can emit that schema. Building a new data path so later modules have something to subscribe to inverts the dependency: every other council waits on a gateway war this org will not win.

**"Open source charity umbrella."** A thinner MIT/Apache gateway fragments the thing a charity should reuse. Apache-2.0 is already Bifrost's license and Envoy AI Gateway's license. License is not the gap.

## Honest v1

v1 is a Docker Compose profile plus contract tests. The engine is a pinned LiteLLM proxy image (Bifrost is the escape hatch if the council rejects the MIT core; it is not a reason to write a third runtime).

In the box:

- A checked-in config: two mock deployments, `mock-local` (class `local`) and `mock-cloud` (class `cloud`), plus the gateway auth key.
- One policy: request header `X-Mirevox-Activity`. Unknown activity fails closed. The activity `local-only` may call only class `local`. Anything else in v1 may call only what that activity's allowlist names.
- Mocks are tiny OpenAI-compatible HTTP servers in the same compose file. They echo a deterministic function of the prompt and count hits.
- A log line per request: time, request id, activity, model, class, status, latency, usage. No prompt, no response body, no keys.
- README section titled "Not in this repo" listing discovery, MCP, workflows, fan-out, vault UI, VS Code, and the chatbot.

Out of the box, with no placeholder packages named after them:

- No `discovery/` tree, no poll loop, no fake Foundry/Bedrock/Vertex/MCP clients.
- No fan-out code path.
- No key store beyond what the engine already reads from env injected by Compose. No file called `vault`.
- No original server. If the council rejects wrapping, the most original code allowed is the policy check and the log filter, in one process, in front of the two mocks. Still no provider SDKs.

Stack debate is closed by that choice. "TypeScript or Python" is bikeshedding on top of a proxy that already exists in Python. Do not start a Hono port to feel original.

## Failure modes

### Stub discovery

- The stub returns 200 and a later README says Foundry is supported. The acceptance report then grades a fixture. That is the vapor path.
- Foundry deployments, Bedrock inference profiles, and Vertex publisher models do not share an id space. A stub schema with `{id, provider}` will not survive the first real list call. Code written against the stub gets thrown away, which is the cost of having written it.
- Name collisions: `gpt-4o` in Azure and `gpt-4o` at OpenAI become one route. The local-only policy attaches to the wrong one.
- Polling flaps. A deleted deployment stays in the registry until the next tick, and requests keep going there. A newly appeared cross-region deployment starts receiving traffic with no config change and no diff to review.
- The poller's identity can list every account the lab credentials can see. A bug or a prompt injection that reads the registry now enumerates the estate.
- Fail-open versus fail-closed is undefined. A timeout in the poller that keeps the last snapshot serves stale routes. A timeout that empties the registry takes the house down. A stub never times out, so the choice never gets made.
- MCP "discovery" that shells out to stdio, or that HTTP-GETs a user-supplied URL, executes or fetches attacker content. Tool lists are code. Auto-onboarding them is remote tool execution with a friendly name.
- Workflow fetch is SSRF against the docker network, cloud metadata, and the key file's host.

### Key vault

- File plus env is a config. Calling it a vault teaches the next contributor to put production keys in git, in an image layer, and in a Compose file.
- One map that holds every provider key means one container compromise is every provider. Virtual keys exist so clients never see those values. v1 that hands the same bearer to VS Code and the chatbot, and also uses that bearer as the upstream key, fails this.
- Env is readable via `/proc`, `docker inspect`, and crash dumps. A debug log of the outbound request, or an error body that echoes `Authorization`, publishes the key. This bug class is routine in proxies.
- The stub never performs a real signature. Bedrock wants SigV4 or a bearer that is not an OpenAI key. Vertex wants ADC or a service-account JSON. Azure Foundry wants a per-deployment key or Entra. A vault that stores one string called `apiKey` cannot represent those, and tests against a mock will stay green while the abstraction is wrong.
- Rotation, audit, and per-caller scope are absent. The first leaked Compose file is forever.
- "Encryption" added as a passphrase in the same env file is theater. Skip it until there is a real secret manager. Do not ship a fake one.

### Fan-out

- OpenAI clients have one response slot. A gateway that sometimes returns a merged essay has broken the only client contract v1 claimed.
- Who splits the task is unspecified. A heuristic splits wrong. A model that splits is another routed call, which can itself fan out. A stub that splits on a delimiter tests the delimiter.
- Partial failure has no status code. Two shards succeed, one returns 500, and the handler either hangs, drops the error, or invents a 200 with a hole in it. Callers cannot tell.
- The slow shard sets the latency. Without a deadline and cancellation, the other calls keep billing after the client gave up. Retrying the gateway request runs the whole fan again. Side effects double.
- Error rates compound. Five backends at 5 percent error is roughly a 23 percent failed fan before you count timeouts.
- Merge order follows completion order unless the plan carries an order. The stub that concatenates in arrival order will flap in CI and look "flaky" instead of wrong.
- Each shard needs a subset of the context. The naive split drops the constraint that lived in another part. Mock echoes hide this because they have nothing to misunderstand.
- The fan uses the most privileged key for every shard, including a shard that the activity policy would have denied on a direct call. Policy has to be checked per shard or it is decoration.
- Cost is linear in shards and invisible in a mock. A home lab pointed at a real cloud will notice on the invoice, not in the unit test.
- There is no idempotency key. The chatbot retries. The fan-out becomes a stampede. Combined with a poller that just added three deployments, it is a self-inflicted outage.

## Acceptance tests

These run from a clean clone with `docker compose up --build -d` and `./scripts/acceptance.sh`. No cloud credentials, no manual step. A skipped test is a failure. A stub that is not on this list does not count as covered.

External network is blackholed for the script (invalid `HTTPS_PROXY`, or an equivalent deny). The suite still passes. Any attempt to reach a real provider fails the run.

| # | Proves | Pass condition |
| --- | --- | --- |
| 1 | The process exists | `GET /health` returns 200 within 30 seconds of compose up. |
| 2 | The registry is the config file | `GET /v1/models` returns exactly `mock-local` and `mock-cloud`. A canary id is absent. |
| 3 | The endpoint is real OpenAI shape | `POST /v1/chat/completions` to `mock-local` returns `id`, `object`, `choices[0].message.content`, and `usage`. Content equals the mock's deterministic function of the prompt, so a hard-coded `"hello"` fails. |
| 4 | Local-only is enforced | Activity `local-only` aimed at `mock-cloud` returns a stable 4xx, body names the activity and the class, and the cloud mock's hit counter stays 0. |
| 5 | The allowlisted path is taken | An activity allowed to use `mock-cloud` increments only the cloud mock. The access log records `class=cloud` and the request id. |
| 6 | Unknowns fail closed | Unknown model returns an OpenAI-style 404. Missing activity header returns 4xx. Missing or wrong gateway bearer returns 401. |
| 7 | Keys are not the product surface | The mock observes an upstream credential that differs from the client bearer. The canary string inside that upstream credential is absent from logs, from `/v1/models`, and from every error body in this suite. |
| 8 | Bodies stay out of logs | A unique prompt canary and a unique completion canary are absent from the log stream. |
| 9 | The deadline exists | A mock that sleeps past the configured timeout produces a gateway timeout. The test returns in timeout plus a small slack. No hung request. |
| 10 | It survives a small crowd | 20 concurrent calls to `mock-local` all return. p95 under a number written in the README. No retry storm against the mock (hit count equals request count). |
| 11 | Nothing is discovered | After the suite, the model list is unchanged. No poll interval in the config. No extra models. |
| 12 | The commands match the docs | The README's compose and script commands are the ones CI runs. Drift fails CI. |

Re-opening a cut feature requires new tests in the same script, or it stays cut:

- **Catalog sync:** default off. With the flag off, test 11 still passes. With the flag on, input is a fixture file, not a network call. Output rows carry a provider prefix and a region. Rows missing a region are rejected. Nothing in the fixture is routable until a human adds it to the allowlist. A test proves a new fixture row is listed as discovered and is not callable.
- **Explicit fan-out:** a separate path, never `POST /v1/chat/completions`. The caller sends the shards and the merge order. Hit count equals shard count. One shard 500 produces a non-200 with per-shard status, and the test finishes inside the deadline. Merge follows plan order. A `local-only` activity cannot include a cloud shard. Implicit "split this sentence" stays illegal.

If those tests are "later," the feature is later.

## Keep / cut / defer

| Feature | Verdict | Reason |
| --- | --- | --- |
| Pinned existing gateway (LiteLLM, or Bifrost if the council refuses LiteLLM) as the only proxy | Keep | The OpenAI endpoint, provider map, and key indirection already exist. |
| Checked-in static registry of two mock deployments, `local` and `cloud` | Keep | Only onboarding story that stays true with the network blackholed. |
| Explicit activity allowlist, fail closed, `local-only` cannot call `cloud` | Keep | The only routing behavior that is not a fallback list. |
| Docker Compose, `/health`, `./scripts/acceptance.sh` in CI | Keep | The brief's ship bar. This is the definition of not-vapor. |
| Client bearer distinct from upstream secret; canary scrub; no bodies in logs | Keep | Makes "central keys" a constraint instead of a leak. |
| One log schema: request id, activity, model, class, status, latency, usage | Keep | The composition point for evals and lineage. No more. |
| README "Not in this repo" | Keep | Stops the stub from growing aliases for cut features. |
| Original gateway in Fastify, Hono, or FastAPI | Cut | Second implementation of LiteLLM. Policy and log filter are the most code allowed. |
| Discovery or polling stubs for Foundry, Bedrock, Vertex, local, MCP | Cut | A green stub is a false support claim. Failure modes above are untestable until one real, allowlisted, default-off sync exists. |
| Auto-onboard anything the poller can see | Cut | Silent route changes break residency and the activity policy. |
| MCP gateway, workflow-by-reference, URL fetch | Cut | LiteLLM already gateways MCP. URL fetch is SSRF. Workflows smuggle n8n back in. |
| Implicit task-split fan-out on the chat endpoint | Cut | Breaks the client contract, hides cost, and has no failure semantics. Orchestrator work, not a router. |
| Key vault as a component, encrypted file, vault UI, rotation | Cut | Env injected into the engine is the v1 store. A vault abstraction that only holds one string is a lie. |
| Provider SDKs and live Foundry, Bedrock, Vertex, Agent Builder adapters | Cut | Mocks behind the engine prove the policy. Live clouds need credentials and a design this brief does not have. |
| VS Code extension and the home chatbot | Cut | Clients of any OpenAI base URL. Different repos if they ever exist. |
| Experimenting with a second gateway stack inside v1 | Cut | One pinned engine. An experiment branch is not a release. |
| Virtual keys, budgets, admin UI, spend dashboards | Cut | Engine features. Configuring them is allowed; rewriting them is not. |
| n8n, Instagram, full Sherali homelab | Cut | Already out. Keep them out of examples and fixtures. |
| One real local runtime (Ollama or equivalent) beside the mock | Defer | Only after tests 1–12 are green. Same policy, same log schema, still no discovery. |
| Read-only catalog sync, one provider, default off, human allowlist | Defer | Requires the extra tests in the section above. Discovered is not routable. |
| Explicit caller-supplied fan-out endpoint | Defer | Requires the fan-out tests above. Never inside `/v1/chat/completions`. |
| Per-caller virtual keys and rotation, using the engine's existing mechanism | Defer | Turn on when someone other than the author holds a client key. |
| Evals and lineage subscribers | Defer | They consume the log schema. They do not add routes to this repo. |
| Agent runtime mediation (Foundry agents, Agent Builder, Bedrock Agents) | Defer | Different contract than chat completions. A registry row is not a design. |

If the council keeps a cut row, it attaches that row's failure modes and the matching acceptance tests in the same change. A stub with none of those tests is a failed v1, including a stub that returns 200.
