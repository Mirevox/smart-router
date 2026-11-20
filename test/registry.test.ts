import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { KeyVault } from "../src/vault/key-vault.js";
import { DiscoveryRegistry } from "../src/registry/providers.js";

describe("DiscoveryRegistry", () => {
  let dir: string;
  let registry: DiscoveryRegistry;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "mirevox-reg-"));
    const config = loadConfig("./config/default.yaml");
    config.vault.path = join(dir, "vault.json");
    const vault = new KeyVault(config.vault);
    registry = new DiscoveryRegistry(config, vault);
  });

  after(() => {
    registry.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("polls Foundry/Bedrock/Vertex/local/MCP stubs", async () => {
    const statuses = await registry.pollAll();
    const kinds = new Set(statuses.map((s) => s.kind));
    for (const k of ["foundry", "bedrock", "vertex", "local", "mcp", "mock"] as const) {
      assert.ok(kinds.has(k), `missing kind ${k}`);
    }
    assert.ok(statuses.every((s) => s.last_poll_at));
    assert.ok(statuses.filter((s) => s.enabled).every((s) => s.healthy));
  });

  it("exposes discovered models with placement", async () => {
    await registry.pollAll();
    const models = registry.listModels();
    assert.ok(models.some((m) => m.id.startsWith("foundry/")));
    assert.ok(models.some((m) => m.id.startsWith("local/")));
    assert.ok(models.some((m) => m.placement === "onprem"));
    assert.ok(models.some((m) => m.placement === "cloud"));
  });

  it("lists OpenAI model fields for each seeded backend", async () => {
    await registry.pollAll();
    const models = registry.listModels();
    const local = models.find((m) => m.id === "local/llama3.2");
    const mcp = models.find((m) => m.id === "mcp/filesystem");
    const vertex = models.find((m) => m.id === "vertex/gemini-2.0-flash");
    assert.equal(local?.object, "model");
    assert.equal(local?.owned_by, "local-ollama");
    assert.equal(local?.backend, "local-ollama");
    assert.equal(local?.placement, "onprem");
    assert.equal(typeof local?.created, "number");
    assert.equal(mcp?.placement, "onprem");
    assert.equal(mcp?.owned_by, "mcp-bridge");
    assert.equal(vertex?.placement, "cloud");
    assert.equal(vertex?.backend, "google-vertex");
    assert.equal(registry.getBackend("missing-backend"), undefined);
  });

  it("catalogs providers that opt out of polling", async () => {
    const statuses = await registry.pollAll();
    const mock = statuses.find((s) => s.id === "mock-openai");
    assert.ok(mock);
    assert.equal(mock.healthy, true);
    assert.equal(mock.stub, true);
    assert.ok(mock.models.includes("gpt-4o-mini"));
    assert.ok(mock.models.includes("claude-sonnet-mock"));
  });

  it("omits a disabled provider from the model list", async () => {
    const config = loadConfig("./config/default.yaml");
    config.vault.path = join(dir, "vault-disabled.json");
    const foundry = config.registry.providers.find((p) => p.id === "azure-foundry");
    assert.ok(foundry);
    foundry.enabled = false;
    const local = new DiscoveryRegistry(config, new KeyVault(config.vault));
    try {
      const statuses = await local.pollAll();
      const status = statuses.find((s) => s.id === "azure-foundry");
      assert.equal(status?.enabled, false);
      assert.equal(status?.healthy, false);
      assert.deepEqual(status?.models, []);
      const models = local.listModels();
      assert.ok(!models.some((m) => m.backend === "azure-foundry" || m.id.startsWith("foundry/")));
      assert.ok(models.some((m) => m.backend === "aws-bedrock"));
    } finally {
      local.stop();
    }
  });

  it("marks a provider live only when stub mode is off and a key is stored", async () => {
    const previous = process.env.SMART_ROUTER_STUB_MODE;
    process.env.SMART_ROUTER_STUB_MODE = "0";
    const config = loadConfig("./config/default.yaml");
    config.vault.path = join(dir, "vault-live.json");
    const vault = new KeyVault(config.vault);
    const canary = "canary-registry-secret";
    vault.put("foundry-live", "azure-foundry", canary);
    const local = new DiscoveryRegistry(config, vault);
    try {
      const statuses = await local.pollAll();
      const foundry = statuses.find((s) => s.id === "azure-foundry");
      const ollama = statuses.find((s) => s.id === "local-ollama");
      const mock = statuses.find((s) => s.id === "mock-openai");
      assert.equal(foundry?.healthy, true);
      assert.equal(foundry?.stub, false);
      assert.equal(ollama?.stub, true);
      assert.equal(mock?.stub, true);
      assert.equal(
        local.listModels().find((m) => m.id === "foundry/gpt-4o")?.stub,
        false,
      );
      assert.equal(JSON.stringify(statuses).includes(canary), false);
    } finally {
      local.stop();
      if (previous === undefined) delete process.env.SMART_ROUTER_STUB_MODE;
      else process.env.SMART_ROUTER_STUB_MODE = previous;
    }
  });

  it("polls immediately on start and stops when asked", async () => {
    const config = loadConfig("./config/default.yaml");
    config.vault.path = join(dir, "vault-timer.json");
    config.registry.poll_interval_ms = 20;
    const local = new DiscoveryRegistry(config, new KeyVault(config.vault));
    try {
      assert.equal(local.listModels().length, 0);
      assert.equal(local.getBackend("azure-foundry")?.healthy, false);
      assert.equal(local.getBackend("azure-foundry")?.last_poll_at, null);
      local.start();
      const first = await waitForPollStamp(local, null);
      const second = await waitForPollStamp(local, first);
      assert.notEqual(second, first);
      assert.equal(local.getBackend("azure-foundry")?.healthy, true);
      assert.ok(local.listModels().some((m) => m.id === "foundry/gpt-4o"));
      local.stop();
      await new Promise((resolve) => setTimeout(resolve, 40));
      const frozen = local.getBackend("azure-foundry")?.last_poll_at;
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(local.getBackend("azure-foundry")?.last_poll_at, frozen);
    } finally {
      local.stop();
    }
  });
});

async function waitForPollStamp(
  registry: DiscoveryRegistry,
  previous: string | null,
): Promise<string> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const stamp = registry.getBackend("azure-foundry")?.last_poll_at ?? null;
    if (stamp && stamp !== previous) return stamp;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("registry poll did not update last_poll_at");
}
