import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../src/types.js";
import { RoutingPolicy } from "../src/router/policy.js";
import { KeyVault } from "../src/vault/key-vault.js";
import { DiscoveryRegistry } from "../src/registry/providers.js";
import { createGateway } from "../src/gateway/openai.js";

function makeConfig(overrides?: {
  enforce_placement?: boolean;
  liveEndpoint?: string;
}): { config: AppConfig; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mirevox-sr-"));
  const config: AppConfig = {
    server: { host: "127.0.0.1", port: 0 },
    gateway: { api_key: "" },
    routing: {
      default_placement: "cloud",
      activities: { secret_code: "onprem" },
      model_routes: { "gpt-*": "openai_cloud", "local/*": "ollama_local" },
      fallback_backend: "openai_cloud",
      enforce_placement: overrides?.enforce_placement,
    },
    vault: {
      path: join(dir, "vault.json"),
      entries: [],
    },
    registry: {
      poll_interval_ms: 60_000,
      providers: [
        { id: "openai_cloud", kind: "foundry", enabled: true },
        {
          id: "ollama_local",
          kind: "local",
          enabled: true,
          endpoint: overrides?.liveEndpoint,
          live: Boolean(overrides?.liveEndpoint),
        },
      ],
    },
    fanout: {
      max_parallel: 3,
      default_timeout_ms: 5_000,
    },
  };
  return {
    config,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("live backend, placement enforcement, and /v1/split", () => {
  it("blocks onprem placement routed to cloud backend with 403 when enforce_placement is true", async () => {
    const { config, cleanup } = makeConfig({ enforce_placement: true });
    try {
      const app = createGateway({
        config,
        policy: new RoutingPolicy(config),
        registry: new DiscoveryRegistry(config),
        vault: new KeyVault(config.vault),
      });

      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o",
          activity: "secret_code",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      assert.equal(res.status, 403);
      const body = (await res.json()) as { error: { message: string } };
      assert.match(body.error.message, /onprem/i);
    } finally {
      cleanup();
    }
  });

  it("decomposes a multi-step prompt via POST /v1/split", async () => {
    const { config, cleanup } = makeConfig();
    try {
      const app = createGateway({
        config,
        policy: new RoutingPolicy(config),
        registry: new DiscoveryRegistry(config),
        vault: new KeyVault(config.vault),
      });

      const res = await app.request("/v1/split", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "1. Summarize PR diff\n2. Check license headers\n3. Draft release notes",
          model: "local/llama3.2",
        }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        decomposed_tasks: number;
        results: Array<{ id: string; ok: boolean }>;
      };
      assert.equal(body.decomposed_tasks, 3);
      assert.equal(body.results.length, 3);
      assert.ok(body.results.every((r) => r.ok));
    } finally {
      cleanup();
    }
  });

  it("dispatches live HTTP completion when provider has live: true", async () => {
    let seenAuth: string | undefined;
    let seenModel: string | undefined;
    const upstream = createServer(async (req, res) => {
      seenAuth = req.headers.authorization;
      const chunks: Buffer[] = [];
      for await (const ch of req) chunks.push(Buffer.from(ch));
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        model?: string;
      };
      seenModel = payload.model;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "live-123",
          model: "llama3.2",
          choices: [{ index: 0, message: { role: "assistant", content: "live-pong" } }],
        }),
      );
    });

    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const addr = upstream.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const { config, cleanup } = makeConfig({
      liveEndpoint: `http://127.0.0.1:${port}`,
    });

    try {
      const vault = new KeyVault(config.vault);
      vault.put("k1", "ollama_local", "test-secret-xyz");
      const app = createGateway({
        config,
        policy: new RoutingPolicy(config),
        registry: new DiscoveryRegistry(config),
        vault,
      });

      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "local/llama3.2",
          messages: [{ role: "user", content: "ping" }],
        }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        choices: Array<{ message: { content: string } }>;
        mirevox: { stub: boolean; backend: string };
      };
      assert.equal(body.choices[0].message.content, "live-pong");
      assert.equal(body.mirevox.stub, false);
      assert.equal(body.mirevox.backend, "ollama_local");
      assert.equal(seenAuth, "Bearer test-secret-xyz");
      assert.equal(seenModel, "llama3.2");
    } finally {
      upstream.close();
      cleanup();
    }
  });
});
