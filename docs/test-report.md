# Test report — Smart Router v0.1

**Command:** `npm test`  
**Result:** **35/35 pass** (6 suites), typecheck/build green  
**SHA:** see `git rev-parse HEAD` after this commit

## Suites

| Suite | Coverage |
| --- | --- |
| `test/policy.test.ts` | model glob routes, placement/backend overrides |
| `test/vault.test.ts` | CRUD, no secret leak on list, env overrides file |
| `test/fanout.test.ts` | parallel backends, order, max_parallel, timeouts |
| `test/gateway.test.ts` | 401s on OpenAI/admin, models, chat metadata, vault, health |
| `test/registry.test.ts` | Foundry/Bedrock/Vertex/local/MCP poll stubs, start/stop |
| (embedded) | health before/after poll paths in gateway/registry |

## Gaps

- No Docker image build in this VM (no docker daemon)
- No live provider integration tests (stub mode by design)
