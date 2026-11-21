import type {
  AppConfig,
  DiscoveredModel,
  Placement,
  ProviderConfig,
  ProviderKind,
  ProviderStatus,
} from "../types.js";
import type { KeyVault } from "../vault/key-vault.js";

const STUB_CATALOG: Record<ProviderKind, string[]> = {
  foundry: ["foundry/gpt-4o", "foundry/gpt-4o-mini"],
  bedrock: ["bedrock/amazon.nova-pro", "bedrock/anthropic.claude-3-5-sonnet"],
  vertex: ["vertex/gemini-2.0-flash", "vertex/gemini-1.5-pro"],
  local: ["local/llama3.2", "local/qwen2.5-coder"],
  mcp: ["mcp/filesystem", "mcp/browser"],
  mock: ["gpt-4o-mini", "claude-sonnet-mock"],
};

function kindPlacement(kind: ProviderKind): Placement {
  return kind === "local" || kind === "mcp" ? "onprem" : "cloud";
}

export class DiscoveryRegistry {
  private statuses = new Map<string, ProviderStatus>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly vault: KeyVault,
  ) {
    for (const p of config.registry.providers) {
      this.statuses.set(p.id, this.initialStatus(p));
    }
  }

  private initialStatus(p: ProviderConfig): ProviderStatus {
    return {
      id: p.id,
      kind: p.kind,
      enabled: p.enabled,
      healthy: false,
      last_poll_at: null,
      models: [],
      // v0.1: catalogs are always stub data until live adapters ship (H-06)
      stub: true,
    };
  }

  start(): void {
    void this.pollAll();
    this.timer = setInterval(
      () => void this.pollAll(),
      this.config.registry.poll_interval_ms,
    );
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async pollAll(): Promise<ProviderStatus[]> {
    const results: ProviderStatus[] = [];
    for (const p of this.config.registry.providers) {
      if (!p.enabled || p.poll === false) {
        const status: ProviderStatus = {
          ...this.initialStatus(p),
          healthy: p.enabled,
          last_poll_at: new Date().toISOString(),
          models: p.enabled ? STUB_CATALOG[p.kind] : [],
          stub: true,
        };
        this.statuses.set(p.id, status);
        results.push(status);
        continue;
      }
      results.push(await this.pollOne(p));
    }
    return results;
  }

  async pollOne(p: ProviderConfig): Promise<ProviderStatus> {
    const now = new Date().toISOString();
    try {
      // v1: stub discovery. Real HTTP probes can replace this when credentials exist.
      // v0.1: always STUB_CATALOG — never claim live discovery from key presence alone
      const models = STUB_CATALOG[p.kind];
      const status: ProviderStatus = {
        id: p.id,
        kind: p.kind,
        enabled: p.enabled,
        healthy: true,
        last_poll_at: now,
        models,
        stub: true,
      };
      this.statuses.set(p.id, status);
      return status;
    } catch (err) {
      const status: ProviderStatus = {
        id: p.id,
        kind: p.kind,
        enabled: p.enabled,
        healthy: false,
        last_poll_at: now,
        models: [],
        error: err instanceof Error ? err.message : String(err),
        stub: true,
      };
      this.statuses.set(p.id, status);
      return status;
    }
  }

  listStatuses(): ProviderStatus[] {
    return [...this.statuses.values()];
  }

  listModels(): DiscoveredModel[] {
    const out: DiscoveredModel[] = [];
    const created = Math.floor(Date.now() / 1000);
    for (const status of this.statuses.values()) {
      if (!status.enabled) continue;
      for (const id of status.models) {
        out.push({
          id,
          object: "model",
          created,
          owned_by: status.id,
          backend: status.id,
          placement: kindPlacement(status.kind),
          stub: status.stub,
        });
      }
    }
    return out;
  }

  getBackend(id: string): ProviderStatus | undefined {
    return this.statuses.get(id);
  }
}
