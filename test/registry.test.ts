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
});
