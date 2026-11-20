import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { KeyVault } from "../src/vault/key-vault.js";
import { RoutingPolicy } from "../src/router/policy.js";
import { DiscoveryRegistry } from "../src/registry/providers.js";
import { createGateway } from "../src/gateway/openai.js";

describe("OpenAI gateway", () => {
  let dir: string;
  let registry: DiscoveryRegistry;
  let app: ReturnType<typeof createGateway>;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "mirevox-gw-"));
    const config = loadConfig("./config/default.yaml");
    config.vault.path = join(dir, "vault.json");
    const vault = new KeyVault(config.vault);
    const policy = new RoutingPolicy(config);
    registry = new DiscoveryRegistry(config, vault);
    await registry.pollAll();
    app = createGateway({ config, policy, registry, vault });
  });

  after(() => {
    registry.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects missing api key", async () => {
    const res = await app.request("/v1/models");
    assert.equal(res.status, 401);
  });

  it("lists models", async () => {
    const res = await app.request("/v1/models", {
      headers: { Authorization: "Bearer mirevox-dev-key" },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: unknown[] };
    assert.ok(body.data.length > 0);
  });

  it("completes chat with routing metadata", async () => {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer mirevox-dev-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "foundry/gpt-4o",
        activity: "chat",
        messages: [{ role: "user", content: "hello router" }],
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
      mirevox: { backend: string; stub: boolean };
    };
    assert.match(body.choices[0]?.message.content ?? "", /hello router/);
    assert.equal(body.mirevox.backend, "azure-foundry");
    assert.equal(body.mirevox.stub, true);
  });

  it("stores vault keys", async () => {
    const res = await app.request("/admin/keys/k1", {
      method: "PUT",
      headers: {
        Authorization: "Bearer mirevox-dev-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ backend: "azure-foundry", secret: "abc" }),
    });
    assert.equal(res.status, 200);
    const list = await app.request("/admin/keys", {
      headers: { Authorization: "Bearer mirevox-dev-key" },
    });
    const body = (await list.json()) as { data: Array<{ id: string }> };
    assert.ok(body.data.some((e) => e.id === "k1"));
  });
});
