import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type { VaultConfig } from "../types.js";

export interface VaultEntry {
  id: string;
  backend: string;
  /** Redacted when listed publicly */
  secret: string;
  updated_at: string;
}

interface VaultFile {
  version: 1;
  entries: VaultEntry[];
}

/**
 * File-backed key vault with env override.
 * v1: plaintext local file for home-lab; do not commit data/.
 */
export class KeyVault {
  private readonly path: string;
  private data: VaultFile;

  constructor(config: VaultConfig) {
    this.path = resolve(config.path);
    this.data = this.load();
  }

  private load(): VaultFile {
    if (!existsSync(this.path)) {
      return { version: 1, entries: [] };
    }
    return JSON.parse(readFileSync(this.path, "utf8")) as VaultFile;
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.data, null, 2) + "\n", {
      mode: 0o600,
    });
  }

  list(): Array<Omit<VaultEntry, "secret"> & { has_secret: boolean }> {
    return this.data.entries.map(({ id, backend, updated_at, secret }) => ({
      id,
      backend,
      updated_at,
      has_secret: Boolean(secret) || Boolean(this.envSecret(backend)),
    }));
  }

  private envSecret(backend: string): string | undefined {
    const key = `SMART_ROUTER_KEY_${backend.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`;
    const v = process.env[key];
    return v && v.length > 0 ? v : undefined;
  }

  getSecret(backend: string): string | undefined {
    const fromEnv = this.envSecret(backend);
    if (fromEnv) return fromEnv;
    return this.data.entries.find((e) => e.backend === backend)?.secret;
  }

  put(id: string, backend: string, secret: string): VaultEntry {
    const updated_at = new Date().toISOString();
    const existing = this.data.entries.findIndex((e) => e.id === id);
    const entry: VaultEntry = { id, backend, secret, updated_at };
    if (existing >= 0) {
      this.data.entries[existing] = entry;
    } else {
      this.data.entries.push(entry);
    }
    this.persist();
    return entry;
  }

  delete(id: string): boolean {
    const before = this.data.entries.length;
    this.data.entries = this.data.entries.filter((e) => e.id !== id);
    if (this.data.entries.length !== before) {
      this.persist();
      return true;
    }
    return false;
  }
}
