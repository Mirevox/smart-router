import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
  });

  it("deletes keys", () => {
    assert.equal(vault.delete("foundry-prod"), true);
    assert.equal(vault.list().length, 0);
  });
});
