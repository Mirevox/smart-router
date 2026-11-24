import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../src/types.js";
import { RoutingPolicy } from "../src/router/policy.js";
import { KeyVault } from "../src/vault/key-vault.js";
import { DiscoveryRegistry } from "../src/registry/providers.js";
import { createGateway } from "../src/gateway/openai.js";
import { TokenAnalyticsEngine } from "../src/analytics/token-advisor.js";

function makeTestConfig(
  overrides: Partial<AppConfig> = {},
): { config: AppConfig; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mirevox-ta-"));
  const config: AppConfig = {
    server: { host: "127.0.0.1", port: 0 },
    gateway: overrides.gateway ?? { api_key: "" },
    routing: overrides.routing ?? {
      default_placement: "cloud",
      activities: {
        chat: "cloud",
        code: "onprem",
        tool: "onprem",
        summarize: "cloud",
      },
      model_routes: {
        "gpt-*": "mock-openai",
        "foundry/*": "azure-foundry",
        "local/*": "local-ollama",
        "vertex/*": "google-vertex",
      },
      fallback_backend: "mock-openai",
    },
    vault: {
      path: join(dir, "vault.json"),
      entries: [],
    },
    registry: overrides.registry ?? {
      poll_interval_ms: 60_000,
      providers: [
        { id: "mock-openai", kind: "mock", enabled: true },
        { id: "azure-foundry", kind: "foundry", enabled: true },
        { id: "google-vertex", kind: "vertex", enabled: true },
        { id: "local-ollama", kind: "local", enabled: true },
      ],
    },
    fanout: {
      max_parallel: 3,
      default_timeout_ms: 5_000,
    },
    guardrails: overrides.guardrails,
    analytics: overrides.analytics,
  };
  return {
    config,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("TokenAnalyticsEngine and Smart Router v0.2.0 analytics", () => {
  it("aggregates tokens by appcode and model, tracks context_tokens_saved, and exposes v0.2.0 root metadata", async () => {
    const { config, cleanup } = makeTestConfig({
      analytics: {
        model_cost_per_1k_usd: {
          "foundry/gpt-4o": 0.02,
        },
      },
    });
    try {
      const vault = new KeyVault(config.vault);
      const registry = new DiscoveryRegistry(config, vault);
      const app = createGateway({
        config,
        policy: new RoutingPolicy(config),
        registry,
        vault,
      });

      const rootRes = await app.request("/");
      assert.equal(rootRes.status, 200);
      const rootJson = (await rootRes.json()) as {
        name: string;
        version: string;
      };
      assert.equal(rootJson.name, "mirevox-smart-router");
      assert.equal(rootJson.version, "0.2.0");

      // Request 1: body context_tokens_saved + body appcode + frontier override rate
      const r1 = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "foundry/gpt-4o",
          appcode: "app-alpha",
          activity: "chat",
          session_id: "sess-a",
          context_tokens_saved: 500,
          messages: [{ role: "user", content: "Summarize release notes" }],
        }),
      });
      assert.equal(r1.status, 200);
      const j1 = (await r1.json()) as {
        usage: {
          prompt_tokens: number;
          completion_tokens: number;
          total_tokens: number;
        };
        mirevox: {
          token_analytics: {
            prompt_tokens: number;
            completion_tokens: number;
            estimated_cost_usd: number;
            context_tokens_saved: number;
            appcode: string;
          };
        };
      };
      assert.equal(j1.mirevox.token_analytics.appcode, "app-alpha");
      assert.equal(j1.mirevox.token_analytics.context_tokens_saved, 500);
      assert.equal(
        j1.mirevox.token_analytics.prompt_tokens,
        j1.usage.prompt_tokens,
      );
      assert.equal(
        j1.mirevox.token_analytics.completion_tokens,
        j1.usage.completion_tokens,
      );
      const expectedCost1 = Number(
        ((j1.usage.total_tokens / 1000) * 0.02).toFixed(6),
      );
      assert.equal(j1.mirevox.token_analytics.estimated_cost_usd, expectedCost1);

      // Request 2: x-mirevox-tokens-saved header + local model (cost = 0)
      const r2 = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-mirevox-tokens-saved": "250",
        },
        body: JSON.stringify({
          model: "local/llama3.2",
          appcode: "app-beta",
          activity: "code",
          session_id: "sess-b",
          messages: [{ role: "user", content: "Explain routing policy" }],
        }),
      });
      assert.equal(r2.status, 200);
      const j2 = (await r2.json()) as {
        mirevox: {
          token_analytics: {
            estimated_cost_usd: number;
            context_tokens_saved: number;
            appcode: string;
          };
        };
      };
      assert.equal(j2.mirevox.token_analytics.appcode, "app-beta");
      assert.equal(j2.mirevox.token_analytics.context_tokens_saved, 250);
      assert.equal(j2.mirevox.token_analytics.estimated_cost_usd, 0);

      // Request 3: /v1/fanout and /v1/split also record token_analytics
      const r3 = await app.request("/v1/fanout", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-mirevox-tokens-saved": "100",
        },
        body: JSON.stringify({
          appcode: "app-alpha",
          tasks: [
            {
              id: "t1",
              model: "gpt-4o-mini",
              messages: [{ role: "user", content: "check lint" }],
            },
          ],
        }),
      });
      assert.equal(r3.status, 200);
      const j3 = (await r3.json()) as {
        mirevox: {
          token_analytics: {
            context_tokens_saved: number;
            appcode: string;
          };
        };
        results: Array<{
          result?: {
            mirevox: { token_analytics?: { context_tokens_saved: number } };
          };
        }>;
      };
      assert.equal(j3.mirevox.token_analytics.appcode, "app-alpha");
      assert.equal(j3.mirevox.token_analytics.context_tokens_saved, 100);
      assert.equal(
        j3.results[0]?.result?.mirevox.token_analytics?.context_tokens_saved,
        100,
      );

      const r4 = await app.request("/v1/split", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appcode: "app-beta",
          model: "gpt-4o-mini",
          context_tokens_saved: 80,
          prompt: "1. Read spec\n2. Write tests",
        }),
      });
      assert.equal(r4.status, 200);
      const j4 = (await r4.json()) as {
        decomposed_tasks: number;
        mirevox: { token_analytics: { context_tokens_saved: number } };
      };
      assert.equal(j4.decomposed_tasks, 2);
      assert.equal(j4.mirevox.token_analytics.context_tokens_saved, 80);

      // Check unfiltered snapshot
      const snapRes = await app.request("/admin/analytics/tokens");
      assert.equal(snapRes.status, 200);
      const snap = (await snapRes.json()) as {
        version: string;
        totals: { requests: number; context_tokens_saved: number };
        by_appcode: Record<string, { requests: number; context_tokens_saved: number }>;
        by_model: Record<string, { requests: number; tier: string }>;
        by_backend: Record<string, { requests: number }>;
        by_placement: Record<string, { requests: number }>;
        by_activity: Record<string, { requests: number }>;
        by_session: Record<string, { requests: number }>;
      };
      assert.equal(snap.version, "0.2.0");
      assert.equal(snap.totals.requests, 5);
      assert.equal(snap.totals.context_tokens_saved, 930);
      assert.equal(snap.by_appcode["app-alpha"]?.requests, 2);
      assert.equal(snap.by_appcode["app-alpha"]?.context_tokens_saved, 600);
      assert.equal(snap.by_appcode["app-beta"]?.requests, 3);
      assert.equal(snap.by_appcode["app-beta"]?.context_tokens_saved, 330);
      assert.equal(snap.by_model["foundry/gpt-4o"]?.tier, "frontier");
      assert.equal(snap.by_model["local/llama3.2"]?.tier, "local");
      assert.equal(snap.by_model["gpt-4o-mini"]?.tier, "economy");
      assert.ok(snap.by_backend["azure-foundry"]);
      assert.ok(snap.by_placement["onprem"]);
      assert.ok(snap.by_activity["code"]);
      assert.ok(snap.by_session["sess-a"]);

      // Check filtered snapshot
      const filteredRes = await app.request(
        "/admin/analytics/tokens?appcode=app-alpha&model=foundry/gpt-4o",
      );
      assert.equal(filteredRes.status, 200);
      const filtered = (await filteredRes.json()) as {
        totals: { requests: number; context_tokens_saved: number };
      };
      assert.equal(filtered.totals.requests, 1);
      assert.equal(filtered.totals.context_tokens_saved, 500);
    } finally {
      cleanup();
    }
  });

  it("honors guardrails.cost_per_1k_tokens_usd when model override is absent", () => {
    const { config, cleanup } = makeTestConfig({
      guardrails: { cost_per_1k_tokens_usd: 0.05 },
    });
    try {
      const engine = new TokenAnalyticsEngine(config);
      const summary = engine.record({
        route: "/v1/chat/completions",
        appcode: "finops-test",
        model: "foundry/gpt-4o",
        backend: "azure-foundry",
        placement: "cloud",
        activity: "chat",
        prompt_tokens: 400,
        completion_tokens: 600,
        context_tokens_saved: 200,
      });
      assert.equal(summary.estimated_cost_usd, 0.05);
      const snap = engine.getSnapshot();
      assert.equal(snap.totals.estimated_savings_usd, 0.01);
    } finally {
      cleanup();
    }
  });

  it("detects repeated >1000-char payloads via bounded LRU SHA-256 without storing raw prompt text", () => {
    const { config, cleanup } = makeTestConfig({
      analytics: { max_tracked_fingerprints: 2 },
    });
    try {
      const engine = new TokenAnalyticsEngine(config);
      const secretMarkerA = "CANARY_SECRET_RAW_PROMPT_ALPHA_";
      const secretMarkerB = "CANARY_SECRET_RAW_PROMPT_BETA_";
      const secretMarkerC = "CANARY_SECRET_RAW_PROMPT_GAMMA_";

      const payloadA = `${secretMarkerA}${"x".repeat(1100)}`;
      const payloadB = `${secretMarkerB}${"y".repeat(1100)}`;
      const payloadC = `${secretMarkerC}${"z".repeat(1100)}`;
      const smallPayload = "short".repeat(50); // <= 1000 chars

      // Small payload repeated does NOT trigger fingerprint suggestions
      for (let i = 0; i < 3; i += 1) {
        engine.record({
          route: "/v1/chat/completions",
          model: "gpt-4o-mini",
          backend: "mock-openai",
          placement: "cloud",
          activity: "chat",
          messages: [{ role: "user", content: smallPayload }],
          prompt_tokens: 70,
          completion_tokens: 20,
        });
      }
      assert.equal(
        engine
          .getSuggestions({ code: "use_context_engine_pack" })
          .length,
        0,
      );

      // Insert A, B, C with max_tracked_fingerprints=2 -> A should be evicted by LRU
      engine.record({
        route: "/v1/chat/completions",
        model: "gpt-4o-mini",
        backend: "mock-openai",
        placement: "cloud",
        activity: "chat",
        messages: [{ role: "user", content: payloadA }],
        prompt_tokens: 300,
        completion_tokens: 20,
      });
      engine.record({
        route: "/v1/chat/completions",
        model: "gpt-4o-mini",
        backend: "mock-openai",
        placement: "cloud",
        activity: "chat",
        messages: [{ role: "user", content: payloadB }],
        prompt_tokens: 300,
        completion_tokens: 20,
      });
      engine.record({
        route: "/v1/chat/completions",
        model: "gpt-4o-mini",
        backend: "mock-openai",
        placement: "cloud",
        activity: "chat",
        messages: [{ role: "user", content: payloadC }],
        prompt_tokens: 300,
        completion_tokens: 20,
      });

      const snapBeforeRepeat = engine.getSnapshot();
      assert.equal(snapBeforeRepeat.fingerprints.tracked, 2);
      assert.equal(snapBeforeRepeat.fingerprints.max_tracked, 2);

      // Repeating B (still in LRU) triggers use_context_engine_pack
      engine.record({
        route: "/v1/chat/completions",
        model: "gpt-4o-mini",
        backend: "mock-openai",
        placement: "cloud",
        activity: "chat",
        messages: [{ role: "user", content: payloadB }],
        prompt_tokens: 300,
        completion_tokens: 20,
      });

      const suggestions = engine.getSuggestions({
        code: "use_context_engine_pack",
      });
      assert.equal(suggestions.length, 1);
      assert.ok((suggestions[0]?.potential_tokens_saved ?? 0) > 0);

      // Ensure raw prompt strings are NEVER stored anywhere on the engine
      const serialized = JSON.stringify(engine);
      assert.equal(serialized.includes(secretMarkerA), false);
      assert.equal(serialized.includes(secretMarkerB), false);
      assert.equal(serialized.includes(secretMarkerC), false);
    } finally {
      cleanup();
    }
  });

  it("triggers all 4 optimization advisor rules accurately and supports filtering", async () => {
    const { config, cleanup } = makeTestConfig({
      guardrails: {
        context_window_tokens: 500,
        context_warn_ratio: 0.8,
      },
    });
    try {
      const vault = new KeyVault(config.vault);
      const registry = new DiscoveryRegistry(config, vault);
      const app = createGateway({
        config,
        policy: new RoutingPolicy(config),
        registry,
        vault,
      });

      // Rule 1 + Rule 2: repeated >1000-char code/tree block in same session
      const codeDump = [
        "├── src/gateway/openai.ts",
        "├── src/analytics/token-advisor.ts",
        "import { Hono } from 'hono';",
        "export function run() { return true; }",
        "x".repeat(1050),
      ].join("\n");

      for (let i = 0; i < 2; i += 1) {
        const res = await app.request("/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            appcode: "advisor-app",
            session_id: "dup-session-1",
            messages: [
              { role: "system", content: "You are a reviewer" },
              { role: "user", content: codeDump },
            ],
          }),
        });
        assert.equal(res.status, 200);
      }

      // Rule 3: downgrade_model_tier (frontier model with short prompt <=600 & <=400 completion + summarize activity)
      const resDowngrade = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "foundry/gpt-4o",
          appcode: "advisor-app",
          activity: "summarize",
          messages: [{ role: "user", content: "Summarize this one sentence." }],
        }),
      });
      assert.equal(resDowngrade.status, 200);

      // Rule 4a: compact_session_history via >= 10 messages
      const tenMessages = Array.from({ length: 10 }, (_, idx) => ({
        role: (idx % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        content: `turn ${idx}`,
      }));
      const resTenMsgs = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          appcode: "advisor-app",
          session_id: "long-session-1",
          messages: tenMessages,
        }),
      });
      assert.equal(resTenMsgs.status, 200);

      // Rule 4b: compact_session_history via contextAlert.compaction_triggered (>=80% of 500 = 400 tokens => 1600+ chars)
      const resExhaust = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          appcode: "advisor-app",
          session_id: "exhaust-session-1",
          messages: [{ role: "user", content: "w".repeat(1680) }],
        }),
      });
      assert.equal(resExhaust.status, 200);
      assert.equal(
        resExhaust.headers.get("x-mirevox-context-alert"),
        "compaction_triggered",
      );

      // Rule 4c: compact_session_history via >=2x token growth above 50% window (with unit engine check)
      const growthEngine = new TokenAnalyticsEngine(config);
      growthEngine.record({
        route: "/v1/chat/completions",
        model: "gpt-4o-mini",
        backend: "mock-openai",
        placement: "cloud",
        activity: "chat",
        session_id: "growth-sess",
        context_window_tokens: 1000,
        messages: [{ role: "user", content: "hello" }],
        prompt_tokens: 150,
        completion_tokens: 20,
      });
      assert.equal(
        growthEngine.getSuggestions({ code: "compact_session_history" }).length,
        0,
      );
      // 600 tokens > 50% of 1000 window AND >= 2 * 150
      growthEngine.record({
        route: "/v1/chat/completions",
        model: "gpt-4o-mini",
        backend: "mock-openai",
        placement: "cloud",
        activity: "chat",
        session_id: "growth-sess",
        context_window_tokens: 1000,
        messages: [{ role: "user", content: "hello again" }],
        prompt_tokens: 600,
        completion_tokens: 20,
      });
      assert.equal(
        growthEngine.getSuggestions({ code: "compact_session_history" }).length,
        1,
      );

      // Verify all 4 suggestion codes on HTTP endpoint + filters
      const allSugRes = await app.request("/admin/analytics/suggestions");
      assert.equal(allSugRes.status, 200);
      const allSug = (await allSugRes.json()) as {
        data: Array<{ code: string; severity: string }>;
        total: number;
      };
      const codes = new Set(allSug.data.map((s) => s.code));
      assert.ok(codes.has("use_context_engine_pack"));
      assert.ok(codes.has("deduplicate_repo_dump"));
      assert.ok(codes.has("downgrade_model_tier"));
      assert.ok(codes.has("compact_session_history"));
      assert.equal(allSug.total, 4);

      const limitedRes = await app.request(
        "/admin/analytics/suggestions?severity=high&limit=2",
      );
      assert.equal(limitedRes.status, 200);
      const limited = (await limitedRes.json()) as {
        data: Array<{ severity: string }>;
      };
      assert.ok(limited.data.length <= 2);
      assert.ok(limited.data.every((s) => s.severity === "high"));

      const byCodeRes = await app.request(
        "/admin/analytics/suggestions?code=downgrade_model_tier",
      );
      assert.equal(byCodeRes.status, 200);
      const byCode = (await byCodeRes.json()) as {
        data: Array<{ code: string }>;
      };
      assert.equal(byCode.data.length, 1);
      assert.equal(byCode.data[0]?.code, "downgrade_model_tier");
    } finally {
      cleanup();
    }
  });

  it("records blocked guardrail stops and 502 live errors, enforces auth, and exports valid Prometheus /metrics without session_id labels", async () => {
    // Broken upstream server returning HTTP 500 -> gateway maps to 502
    const brokenUpstream = createServer((_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("upstream boom");
    });
    await new Promise<void>((resolve) =>
      brokenUpstream.listen(0, "127.0.0.1", resolve),
    );
    const port = (brokenUpstream.address() as { port: number }).port;

    const { config, cleanup } = makeTestConfig({
      gateway: { api_key: "secret-v2-key" },
      guardrails: {
        max_identical_tool_calls: 1,
        context_window_tokens: 1000,
      },
      registry: {
        poll_interval_ms: 60_000,
        providers: [
          { id: "mock-openai", kind: "mock", enabled: true },
          {
            id: "local-ollama",
            kind: "local",
            enabled: true,
            live: true,
            endpoint: `http://127.0.0.1:${port}`,
          },
        ],
      },
    });

    try {
      const vault = new KeyVault(config.vault);
      const registry = new DiscoveryRegistry(config, vault);
      const app = createGateway({
        config,
        policy: new RoutingPolicy(config),
        registry,
        vault,
      });

      // Auth check: /admin/analytics/* requires Bearer token
      assert.equal((await app.request("/admin/analytics/tokens")).status, 401);
      assert.equal(
        (await app.request("/admin/analytics/suggestions")).status,
        401,
      );

      // Auth check: GET /metrics is public by default
      const coldMetrics = await app.request("/metrics");
      assert.equal(coldMetrics.status, 200);
      assert.match(
        coldMetrics.headers.get("content-type") ?? "",
        /text\/plain;\s*version=0\.0\.4/,
      );

      const authHeaders = {
        Authorization: "Bearer secret-v2-key",
        "Content-Type": "application/json",
      };

      // 1. Successful completion with x-mirevox-tokens-saved
      const okRes = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: {
          ...authHeaders,
          "x-mirevox-tokens-saved": "120",
        },
        body: JSON.stringify({
          model: "gpt-4o",
          appcode: "prom-app",
          session_id: "private-session-secret-999",
          messages: [{ role: "user", content: "hello metrics" }],
        }),
      });
      assert.equal(okRes.status, 200);

      // 2. Guardrail loop trip (1st call allowed, 2nd call blocked with 429)
      const toolBody = JSON.stringify({
        model: "gpt-4o",
        appcode: "prom-app",
        session_id: "private-session-secret-999",
        messages: [{ role: "user", content: "run tool" }],
        tool_calls: [{ name: "grep", arguments: { q: "x" } }],
      });
      assert.equal(
        (
          await app.request("/v1/chat/completions", {
            method: "POST",
            headers: authHeaders,
            body: toolBody,
          })
        ).status,
        200,
      );
      const blockedRes = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: authHeaders,
        body: toolBody,
      });
      assert.equal(blockedRes.status, 429);

      // 3. Upstream 502 error
      const errRes = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          model: "local/llama3.2",
          appcode: "prom-app",
          session_id: "private-session-secret-999",
          messages: [{ role: "user", content: "live fail" }],
        }),
      });
      assert.equal(errRes.status, 502);

      // Verify /admin/analytics/tokens records all 4 requests including blocked + error
      const tokensRes = await app.request("/admin/analytics/tokens", {
        headers: { Authorization: "Bearer secret-v2-key" },
      });
      assert.equal(tokensRes.status, 200);
      const tokensSnap = (await tokensRes.json()) as {
        totals: {
          requests: number;
          blocked_requests: number;
          error_requests: number;
          context_tokens_saved: number;
        };
        guardrail_events: Record<string, number>;
      };
      assert.equal(tokensSnap.totals.requests, 4);
      assert.equal(tokensSnap.totals.blocked_requests, 1);
      assert.equal(tokensSnap.totals.error_requests, 1);
      assert.equal(tokensSnap.totals.context_tokens_saved, 120);
      assert.equal(tokensSnap.guardrail_events["loop_detected"], 1);

      // Verify Prometheus /metrics exposition format and zero session_id leakage
      const metricsRes = await app.request("/metrics");
      assert.equal(metricsRes.status, 200);
      const metricsText = await metricsRes.text();

      const requiredMetrics = [
        "mirevox_router_tokens_total",
        "mirevox_router_tokens_saved_total",
        "mirevox_router_cost_usd_total",
        "mirevox_router_cost_saved_usd_total",
        "mirevox_router_duplicate_context_tokens_total",
        "mirevox_router_optimization_potential_tokens",
        "mirevox_smart_router_requests_total",
        "mirevox_smart_router_prompt_tokens",
        "mirevox_smart_router_guardrail_events_total",
        "mirevox_smart_router_active_suggestions",
      ];
      for (const name of requiredMetrics) {
        assert.ok(
          metricsText.includes(`# TYPE ${name} `),
          `Missing # TYPE for ${name}`,
        );
      }
      assert.ok(metricsText.includes("mirevox_smart_router_prompt_tokens_bucket{"));
      assert.ok(metricsText.includes("mirevox_smart_router_prompt_tokens_sum{"));
      assert.ok(metricsText.includes("mirevox_smart_router_prompt_tokens_count{"));
      assert.equal(metricsText.includes("session_id"), false);
      assert.equal(metricsText.includes("private-session-secret-999"), false);

      // Verify public_metrics: false gates /metrics behind Bearer auth
      const { config: privateCfg, cleanup: cleanupPrivate } = makeTestConfig({
        gateway: { api_key: "secret-v2-key" },
        analytics: { public_metrics: false },
      });
      try {
        const privVault = new KeyVault(privateCfg.vault);
        const privApp = createGateway({
          config: privateCfg,
          policy: new RoutingPolicy(privateCfg),
          registry: new DiscoveryRegistry(privateCfg, privVault),
          vault: privVault,
        });
        assert.equal((await privApp.request("/metrics")).status, 401);
        assert.equal(
          (
            await privApp.request("/metrics", {
              headers: { Authorization: "Bearer secret-v2-key" },
            })
          ).status,
          200,
        );
      } finally {
        cleanupPrivate();
      }
    } finally {
      brokenUpstream.close();
      cleanup();
    }
  });

  it("validates grafana/smart-router-token-dashboard.json schema and panels", () => {
    const raw = readFileSync(
      new URL("../grafana/smart-router-token-dashboard.json", import.meta.url),
      "utf8",
    );
    const dashboard = JSON.parse(raw) as {
      schemaVersion: number;
      style: string;
      title: string;
      panels: Array<{
        id: number;
        title: string;
        type: string;
        targets: Array<{ expr: string }>;
      }>;
    };

    assert.equal(dashboard.schemaVersion, 39);
    assert.equal(dashboard.style, "dark");
    assert.ok(Array.isArray(dashboard.panels));
    assert.ok(dashboard.panels.length >= 6);

    const titles = dashboard.panels.map((p) => p.title);
    assert.ok(titles.some((t) => /Total Tokens.*Saved/i.test(t)));
    assert.ok(titles.some((t) => /Estimated Spend.*Cost Saved/i.test(t)));
    assert.ok(titles.some((t) => /Duplicate Context Waste/i.test(t)));
    assert.ok(titles.some((t) => /Active Optimization Suggestions/i.test(t)));
    assert.ok(titles.some((t) => /Guardrail Trips/i.test(t)));
    assert.ok(titles.some((t) => /Prompt Token P95 by Model/i.test(t)));

    const allExprs = dashboard.panels
      .flatMap((p) => p.targets.map((t) => t.expr))
      .join("\n");
    assert.ok(allExprs.includes("mirevox_router_tokens_total"));
    assert.ok(allExprs.includes("mirevox_router_tokens_saved_total"));
    assert.ok(allExprs.includes("mirevox_router_cost_usd_total"));
    assert.ok(allExprs.includes("mirevox_router_cost_saved_usd_total"));
    assert.ok(allExprs.includes("mirevox_router_duplicate_context_tokens_total"));
    assert.ok(allExprs.includes("mirevox_smart_router_active_suggestions"));
    assert.ok(allExprs.includes("mirevox_smart_router_guardrail_events_total"));
    assert.ok(allExprs.includes("mirevox_smart_router_prompt_tokens_bucket"));
  });
});
