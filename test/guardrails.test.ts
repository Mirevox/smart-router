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

function makeConfig(
  guardrails?: AppConfig["guardrails"],
): { config: AppConfig; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mirevox-gr-"));
  const config: AppConfig = {
    server: { host: "127.0.0.1", port: 0 },
    gateway: { api_key: "" },
    routing: {
      default_placement: "cloud",
      activities: { chat: "cloud" },
      model_routes: { "gpt-*": "openai_cloud" },
      fallback_backend: "openai_cloud",
    },
    vault: {
      path: join(dir, "vault.json"),
      entries: [],
    },
    registry: {
      poll_interval_ms: 60_000,
      providers: [{ id: "openai_cloud", kind: "foundry", enabled: true }],
    },
    fanout: {
      max_parallel: 2,
      default_timeout_ms: 5_000,
    },
    guardrails,
  };
  return {
    config,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("Smart Router execution guardrails and trace propagation", () => {
  it("Loop Detector kills runs when identical tool+args exceed 3 invocations and logs a circuit-breaker event", async () => {
    const { config, cleanup } = makeConfig({ max_identical_tool_calls: 3 });
    try {
      const app = createGateway({
        config,
        policy: new RoutingPolicy(config),
        registry: new DiscoveryRegistry(config),
        vault: new KeyVault(config.vault),
      });

      const sendToolStep = () =>
        app.request("/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "gpt-4o",
            session_id: "loop-sess-1",
            trace_id: "trace-loop-test",
            messages: [{ role: "user", content: "read config" }],
            tool_calls: [{ name: "read_file", arguments: { path: "a.ts" } }],
          }),
        });

      assert.equal((await sendToolStep()).status, 200);
      assert.equal((await sendToolStep()).status, 200);
      assert.equal((await sendToolStep()).status, 200);

      const fourth = await sendToolStep();
      assert.equal(fourth.status, 429);
      const errBody = (await fourth.json()) as {
        error: { code: string; trace_id: string };
      };
      assert.equal(errBody.error.code, "LOOP_CIRCUIT_BREAKER");
      assert.equal(errBody.error.trace_id, "trace-loop-test");

      const eventsRes = await app.request("/admin/guardrails/events");
      assert.equal(eventsRes.status, 200);
      const eventsBody = (await eventsRes.json()) as {
        data: Array<{ type: string; blocked: boolean; trace_id: string }>;
      };
      assert.ok(
        eventsBody.data.some(
          (e) =>
            e.type === "loop_detected" &&
            e.blocked === true &&
            e.trace_id === "trace-loop-test",
        ),
      );
    } finally {
      cleanup();
    }
  });

  it("Per-Task Budget Cap hard-stops oversized requests before upstream dispatch", async () => {
    const { config, cleanup } = makeConfig({
      max_task_tokens: 50,
      max_task_cost_usd: 0.001,
      cost_per_1k_tokens_usd: 0.02,
    });
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
          trace_id: "trace-budget-test",
          max_tokens: 200,
          messages: [{ role: "user", content: "generate report ".repeat(30) }],
        }),
      });
      assert.equal(res.status, 402);
      const errBody = (await res.json()) as { error: { code: string } };
      assert.equal(errBody.error.code, "BUDGET_CAP_EXCEEDED");
    } finally {
      cleanup();
    }
  });

  it("Context Exhaustion Alert fires warning and compaction_triggered above 80% window", async () => {
    const { config, cleanup } = makeConfig({
      context_window_tokens: 100,
      context_warn_ratio: 0.8,
    });
    try {
      const app = createGateway({
        config,
        policy: new RoutingPolicy(config),
        registry: new DiscoveryRegistry(config),
        vault: new KeyVault(config.vault),
      });

      // ~340 chars => ~85 tokens => >= 80% of 100
      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o",
          trace_id: "trace-context-test",
          messages: [{ role: "user", content: "x".repeat(340) }],
        }),
      });
      assert.equal(res.status, 200);
      assert.equal(
        res.headers.get("x-mirevox-context-alert"),
        "compaction_triggered",
      );
      const body = (await res.json()) as {
        mirevox: {
          trace_id: string;
          context_alert?: {
            status: string;
            compaction_triggered: boolean;
            usage_ratio: number;
          };
        };
      };
      assert.equal(body.mirevox.trace_id, "trace-context-test");
      assert.equal(body.mirevox.context_alert?.status, "warning");
      assert.equal(body.mirevox.context_alert?.compaction_triggered, true);
      assert.ok((body.mirevox.context_alert?.usage_ratio ?? 0) >= 0.8);
    } finally {
      cleanup();
    }
  });

  it("propagates trace_id to Data Lineage and Evals webhook endpoints", async () => {
    const seenLineage: Array<Record<string, unknown>> = [];
    const seenEvals: Array<Record<string, unknown>> = [];

    const hookServer = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const ch of req) chunks.push(Buffer.from(ch));
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
        string,
        unknown
      >;
      if (req.url === "/v1/trace") {
        seenLineage.push(payload);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === "/api/capture/webhook") {
        seenEvals.push(payload);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ accepted: 1 }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) =>
      hookServer.listen(0, "127.0.0.1", resolve),
    );
    const port = (hookServer.address() as { port: number }).port;
    const prevLineage = process.env.SMART_ROUTER_LINEAGE_URL;
    const prevEvals = process.env.SMART_ROUTER_EVALS_WEBHOOK_URL;
    const prevAwait = process.env.SMART_ROUTER_AWAIT_HOOKS;
    process.env.SMART_ROUTER_LINEAGE_URL = `http://127.0.0.1:${port}`;
    process.env.SMART_ROUTER_EVALS_WEBHOOK_URL = `http://127.0.0.1:${port}/api/capture/webhook`;
    process.env.SMART_ROUTER_AWAIT_HOOKS = "true";

    const { config, cleanup } = makeConfig();
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
          trace_id: "trace-e2e-prop-1",
          messages: [{ role: "user", content: "audit trace propagation" }],
        }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        mirevox: { trace_id: string; lineage_correlation_id?: string };
      };
      assert.equal(body.mirevox.trace_id, "trace-e2e-prop-1");
      assert.equal(body.mirevox.lineage_correlation_id, "trace-e2e-prop-1");
      assert.equal(seenLineage.length, 1);
      assert.equal(seenLineage[0].correlationId, "trace-e2e-prop-1");
      const candidate = seenLineage[0].candidate as { endpoint: string };
      assert.match(candidate.endpoint, /^(?:https?|local):\/\//);
      assert.equal(seenEvals.length, 1);
      assert.equal(seenEvals[0].traceId, "trace-e2e-prop-1");
    } finally {
      hookServer.close();
      cleanup();
      if (prevLineage === undefined) delete process.env.SMART_ROUTER_LINEAGE_URL;
      else process.env.SMART_ROUTER_LINEAGE_URL = prevLineage;
      if (prevEvals === undefined) delete process.env.SMART_ROUTER_EVALS_WEBHOOK_URL;
      else process.env.SMART_ROUTER_EVALS_WEBHOOK_URL = prevEvals;
      if (prevAwait === undefined) delete process.env.SMART_ROUTER_AWAIT_HOOKS;
      else process.env.SMART_ROUTER_AWAIT_HOOKS = prevAwait;
    }
  });
});
