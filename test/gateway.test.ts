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

  it("serves health and the root document without a key", async () => {
    const health = await app.request("/health", {
      headers: { Authorization: "Bearer wrong-key" },
    });
    assert.equal(health.status, 200);
    const body = (await health.json()) as {
      status: string;
      providers: Array<{ id: string; healthy: boolean; stub: boolean }>;
    };
    assert.equal(body.status, "ok");
    assert.equal(body.providers.length, 7);
    assert.ok(body.providers.every((p) => p.healthy && p.stub));
    assert.ok(body.providers.some((p) => p.id === "azure-foundry"));
    assert.ok(body.providers.some((p) => p.id === "local-ollama"));

    const root = await app.request("/");
    assert.equal(root.status, 200);
    const info = (await root.json()) as { name: string; openai_base: string };
    assert.equal(info.name, "mirevox-smart-router");
    assert.equal(info.openai_base, "/v1");
  });

  it("rejects missing and wrong credentials on protected routes", async () => {
    const routes: Array<{ method: string; path: string; body?: string }> = [
      { method: "GET", path: "/v1/models" },
      { method: "POST", path: "/v1/chat/completions", body: "{}" },
      {
        method: "POST",
        path: "/v1/fanout",
        body: JSON.stringify({ tasks: [] }),
      },
      { method: "GET", path: "/admin/keys" },
      {
        method: "PUT",
        path: "/admin/keys/rejected",
        body: JSON.stringify({ backend: "aws-bedrock", secret: "nope" }),
      },
      { method: "DELETE", path: "/admin/keys/rejected" },
      { method: "GET", path: "/admin/routes" },
      { method: "GET", path: "/admin/registry" },
      { method: "POST", path: "/admin/registry/poll" },
    ];
    const headersList: Array<Record<string, string>> = [
      {},
      { Authorization: "Bearer wrong-key" },
      { Authorization: "Bearer" },
      { Authorization: "Basic mirevox-dev-key" },
    ];

    for (const route of routes) {
      for (const auth of headersList) {
        const res = await app.request(route.path, {
          method: route.method,
          headers: { ...auth, "Content-Type": "application/json" },
          body: route.body,
        });
        const label = `${route.method} ${route.path} ${auth.Authorization ?? "(none)"}`;
        assert.equal(res.status, 401, label);
        const body = (await res.json()) as {
          error: { message: string; type: string };
        };
        assert.equal(body.error.message, "Invalid API key", label);
        assert.equal(body.error.type, "invalid_request_error", label);
        assert.equal(JSON.stringify(body).includes("mirevox-dev-key"), false);
      }
    }

    const leaked = await app.request("/admin/keys", {
      headers: { Authorization: "Bearer mirevox-dev-key" },
    });
    const listed = (await leaked.json()) as { data: Array<{ id: string }> };
    assert.equal(listed.data.some((e) => e.id === "rejected"), false);
  });

  it("does not accept the api key as a query parameter", async () => {
    const res = await app.request("/v1/models?api_key=mirevox-dev-key");
    assert.equal(res.status, 401);
  });

  it("accepts a case-insensitive bearer token", async () => {
    const res = await app.request("/admin/routes", {
      headers: { Authorization: "bearer   mirevox-dev-key" },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { routing: { fallback_backend: string } };
    assert.equal(body.routing.fallback_backend, "mock-openai");
  });

  it("fans out over HTTP in request order", async () => {
    const res = await app.request("/v1/fanout", {
      method: "POST",
      headers: {
        Authorization: "Bearer mirevox-dev-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        timeout_ms: 500,
        tasks: [
          {
            id: "z-last-name",
            model: "foundry/gpt-4o",
            messages: [{ role: "user", content: "one" }],
          },
          {
            id: "a-first-name",
            model: "local/llama3.2",
            activity: "code",
            messages: [{ role: "user", content: "two" }],
          },
          {
            id: "m-mid",
            model: "bedrock/amazon.nova-pro",
            messages: [{ role: "user", content: "three" }],
          },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      object: string;
      parallel: number;
      results: Array<{ id: string; ok: boolean; decision?: { backend: string } }>;
    };
    assert.equal(body.object, "mirevox.fanout_result");
    assert.deepEqual(
      body.results.map((r) => r.id),
      ["z-last-name", "a-first-name", "m-mid"],
    );
    assert.equal(body.results[0]?.decision?.backend, "azure-foundry");
    assert.equal(body.results[1]?.decision?.backend, "local-ollama");
    assert.equal(body.results[2]?.decision?.backend, "aws-bedrock");
    assert.ok(body.results.every((r) => r.ok));
    assert.equal(body.parallel, 3);
  });

  it("returns provider snapshots from a manual registry poll", async () => {
    const denied = await app.request("/admin/registry/poll", { method: "POST" });
    assert.equal(denied.status, 401);

    const res = await app.request("/admin/registry/poll", {
      method: "POST",
      headers: { Authorization: "Bearer mirevox-dev-key" },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      data: Array<{
        id: string;
        healthy: boolean;
        last_poll_at: string | null;
        models: string[];
      }>;
    };
    const foundry = body.data.find((p) => p.id === "azure-foundry");
    assert.equal(foundry?.healthy, true);
    assert.ok(foundry?.last_poll_at);
    assert.ok(foundry?.models.includes("foundry/gpt-4o"));

    const listed = await app.request("/admin/registry", {
      headers: { Authorization: "Bearer mirevox-dev-key" },
    });
    assert.equal(listed.status, 200);
    const snapshot = (await listed.json()) as { data: Array<{ id: string }> };
    assert.ok(snapshot.data.some((p) => p.id === "mcp-bridge"));
  });

  it("rejects invalid chat, stream, fanout, and vault payloads", async () => {
    const headers = {
      Authorization: "Bearer mirevox-dev-key",
      "Content-Type": "application/json",
    };
    const chat = await app.request("/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({ messages: [] }),
    });
    assert.equal(chat.status, 400);
    const chatBody = (await chat.json()) as { error: { message: string; type: string } };
    assert.equal(chatBody.error.message, "model and messages are required");
    assert.equal(chatBody.error.type, "invalid_request_error");

    const stream = await app.request("/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "x" }],
        stream: true,
      }),
    });
    assert.equal(stream.status, 501);
    const streamBody = (await stream.json()) as { error: { message: string } };
    assert.match(streamBody.error.message, /streaming not implemented/);

    const fan = await app.request("/v1/fanout", {
      method: "POST",
      headers,
      body: JSON.stringify({ tasks: [] }),
    });
    assert.equal(fan.status, 400);
    const fanBody = (await fan.json()) as { error: { message: string } };
    assert.equal(fanBody.error.message, "tasks[] required");

    const key = await app.request("/admin/keys/incomplete", {
      method: "PUT",
      headers,
      body: JSON.stringify({ backend: "aws-bedrock" }),
    });
    assert.equal(key.status, 400);
  });

  it("does not echo vault secrets and deletes keys", async () => {
    const secret = "canary-secret-xyz";
    const headers = {
      Authorization: "Bearer mirevox-dev-key",
      "Content-Type": "application/json",
    };
    const res = await app.request("/admin/keys/canary", {
      method: "PUT",
      headers,
      body: JSON.stringify({ backend: "aws-bedrock", secret }),
    });
    assert.equal(res.status, 200);
    const putText = await res.text();
    assert.equal(putText.includes(secret), false);

    const list = await app.request("/admin/keys", {
      headers: { Authorization: "Bearer mirevox-dev-key" },
    });
    const listText = await list.text();
    assert.equal(listText.includes(secret), false);
    assert.equal(listText.includes('"canary"'), true);

    const del = await app.request("/admin/keys/canary", {
      method: "DELETE",
      headers: { Authorization: "Bearer mirevox-dev-key" },
    });
    assert.equal(del.status, 200);
    const deleted = (await del.json()) as { deleted: boolean };
    assert.equal(deleted.deleted, true);

    const again = await app.request("/admin/keys/canary", {
      method: "DELETE",
      headers: { Authorization: "Bearer mirevox-dev-key" },
    });
    const missing = (await again.json()) as { deleted: boolean };
    assert.equal(missing.deleted, false);
  });
});

describe("gateway auth and health edges", () => {
  it("reports providers unhealthy before the first poll", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mirevox-health-"));
    try {
      const config = loadConfig("./config/default.yaml");
      config.vault.path = join(dir, "vault.json");
      const vault = new KeyVault(config.vault);
      const registry = new DiscoveryRegistry(config, vault);
      const edge = createGateway({
        config,
        policy: new RoutingPolicy(config),
        registry,
        vault,
      });
      const res = await edge.request("/health");
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        status: string;
        providers: Array<{ healthy: boolean; stub: boolean }>;
      };
      assert.equal(body.status, "ok");
      assert.equal(body.providers.length, 7);
      assert.ok(body.providers.every((p) => p.healthy === false && p.stub === true));
      const models = await edge.request("/v1/models", {
        headers: { Authorization: "Bearer mirevox-dev-key" },
      });
      const listed = (await models.json()) as { data: unknown[] };
      assert.equal(listed.data.length, 0);
      registry.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows protected routes when the gateway api key is empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mirevox-open-"));
    try {
      const config = loadConfig("./config/default.yaml");
      config.gateway.api_key = "";
      config.vault.path = join(dir, "vault.json");
      const vault = new KeyVault(config.vault);
      const registry = new DiscoveryRegistry(config, vault);
      await registry.pollAll();
      const open = createGateway({
        config,
        policy: new RoutingPolicy(config),
        registry,
        vault,
      });
      const models = await open.request("/v1/models");
      assert.equal(models.status, 200);
      const keys = await open.request("/admin/keys");
      assert.equal(keys.status, 200);
      registry.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
