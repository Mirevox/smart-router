import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyVault } from "../src/vault/key-vault.js";

describe("KeyVault", () => {
  let dir: string;
  let vault: KeyVault;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "mirevox-vault-"));
    vault = new KeyVault({ path: join(dir, "vault.json"), entries: [] });
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores and lists keys without leaking secrets", () => {
    vault.put("foundry-prod", "azure-foundry", "sk-test-secret");
    const listed = vault.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, "foundry-prod");
    assert.equal(listed[0]?.has_secret, true);
    assert.ok(!("secret" in (listed[0] as object)));
    assert.equal(vault.getSecret("azure-foundry"), "sk-test-secret");
    if (process.platform !== "win32") {
      const mode = statSync(join(dir, "vault.json")).mode & 0o777;
      assert.equal(mode, 0o600);
    }
  });

  it("deletes keys", () => {
    assert.equal(vault.delete("foundry-prod"), true);
    assert.equal(vault.list().length, 0);
    assert.equal(vault.delete("foundry-prod"), false);
  });

  it("prefers SMART_ROUTER_KEY_<BACKEND> over the file", () => {
    vault.put("bed", "aws-bedrock", "file-secret");
    const envName = "SMART_ROUTER_KEY_AWS_BEDROCK";
    const previous = process.env[envName];
    process.env[envName] = "env-secret";
    try {
      assert.equal(vault.getSecret("aws-bedrock"), "env-secret");
      const listed = vault.list().find((e) => e.id === "bed");
      assert.equal(listed?.has_secret, true);
      assert.equal("secret" in (listed as object), false);
      assert.equal(JSON.stringify(vault.list()).includes("env-secret"), false);
      assert.equal(JSON.stringify(vault.list()).includes("file-secret"), false);
    } finally {
      if (previous === undefined) delete process.env[envName];
      else process.env[envName] = previous;
    }
  });
});
