
# Test report — Smart Router v0.1

**Command:** `cd /home/ubuntu/mirevox/smart-router && npm test`  
**Result:** **25/25 pass** (5 suites), typecheck/build green  
**SHA:** `c200a4506c2d4177f277f15c3ab6d29f288ecd73`

## Suites

| Suite | Coverage |
| --- | --- |
| `test/policy.test.ts` | model glob routes, placement/backend overrides |
| `test/vault.test.ts` | CRUD, no secret leak on list, env overrides file |
| `test/fanout.test.ts` | parallel backends, order preservation, max_parallel cap, timeouts |
| `test/gateway.test.ts` | 401, models list, chat + mirevox metadata, vault admin |
| `test/registry.test.ts` | Foundry/Bedrock/Vertex/local/MCP poll stubs, placement tags |

## Gaps

- No Docker image build in this VM (no docker daemon)
- No live provider integration tests (stub mode by design)
- Streaming 501 path not asserted in automated suite yet
