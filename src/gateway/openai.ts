import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type {
  AppConfig,
  ChatCompletionRequest,
  FanoutRequest,
  FanoutTask,
  SplitPromptRequest,
} from "../types.js";
import type { RoutingPolicy } from "../router/policy.js";
import type { DiscoveryRegistry } from "../registry/providers.js";
import type { KeyVault } from "../vault/key-vault.js";
import { stubComplete } from "../backends/stub.js";
import { liveComplete } from "../backends/live.js";
import {
  decomposePromptToTasks,
  fanoutTasks,
  type FanoutResponse,
} from "../fanout/splitter.js";
import { GuardrailEngine } from "../guardrails/engine.js";
import {
  TokenAnalyticsEngine,
  type TokenAnalyticsSummary,
} from "../analytics/token-advisor.js";

type Vars = {
  Variables: {
    authed: boolean;
  };
};

function resolveAppcode(
  bodyAppcode: string | undefined,
  headerValue: string | undefined,
): string {
  return bodyAppcode?.trim() || headerValue?.trim() || "default";
}

function resolveSessionId(
  bodySessionId: string | undefined,
  headerValue: string | undefined,
): string | undefined {
  return bodySessionId?.trim() || headerValue?.trim() || undefined;
}

function resolveTokensSaved(
  bodyValue: number | undefined,
  headerValue: string | undefined,
): number {
  if (
    typeof bodyValue === "number" &&
    Number.isFinite(bodyValue) &&
    bodyValue >= 0
  ) {
    return Math.round(bodyValue);
  }
  if (headerValue !== undefined) {
    const parsed = Number(headerValue.trim());
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.round(parsed);
    }
  }
  return 0;
}

function recordFanoutExecution(
  analytics: TokenAnalyticsEngine,
  route: "/v1/fanout" | "/v1/split",
  tasks: FanoutTask[],
  fanout: FanoutResponse,
  defaults: {
    appcode: string;
    sessionId?: string;
    contextTokensSaved: number;
  },
): TokenAnalyticsSummary {
  let promptTokens = 0;
  let completionTokens = 0;
  let estimatedCostUsd = 0;
  let totalSaved = 0;

  for (let i = 0; i < fanout.results.length; i += 1) {
    const res = fanout.results[i]!;
    const task = tasks[i];
    const taskAppcode = task?.appcode?.trim() || defaults.appcode;
    const taskSessionId = task?.session_id?.trim() || defaults.sessionId;
    const taskSaved =
      task?.context_tokens_saved !== undefined
        ? resolveTokensSaved(task.context_tokens_saved, undefined)
        : i === 0
          ? defaults.contextTokensSaved
          : 0;
    const decision = res.decision;
    const model = decision?.model ?? task?.model ?? "gpt-4o-mini";
    const backend = decision?.backend ?? task?.backend ?? "unknown";
    const placement = decision?.placement ?? task?.placement ?? "cloud";
    const activity = decision?.activity ?? task?.activity ?? "chat";

    if (res.ok && res.result) {
      const summary = analytics.record({
        route,
        appcode: taskAppcode,
        model,
        backend,
        placement,
        activity,
        session_id: taskSessionId,
        messages: task?.messages,
        prompt_tokens: res.result.usage.prompt_tokens,
        completion_tokens: res.result.usage.completion_tokens,
        total_tokens: res.result.usage.total_tokens,
        context_tokens_saved: taskSaved,
      });
      res.result.mirevox.token_analytics = summary;
      promptTokens += summary.prompt_tokens;
      completionTokens += summary.completion_tokens;
      estimatedCostUsd = Number(
        (estimatedCostUsd + summary.estimated_cost_usd).toFixed(6),
      );
      totalSaved += summary.context_tokens_saved;
    } else {
      analytics.record({
        route,
        appcode: taskAppcode,
        model,
        backend,
        placement,
        activity,
        session_id: taskSessionId,
        messages: task?.messages,
        prompt_tokens: 0,
        completion_tokens: 0,
        context_tokens_saved: 0,
        error: true,
      });
    }
  }

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    estimated_cost_usd: estimatedCostUsd,
    context_tokens_saved: totalSaved,
    appcode: defaults.appcode,
  };
}

export function createGateway(deps: {
  config: AppConfig;
  policy: RoutingPolicy;
  registry: DiscoveryRegistry;
  vault: KeyVault;
  analytics?: TokenAnalyticsEngine;
}): Hono<Vars> {
  const app = new Hono<Vars>();
  const guardrails = new GuardrailEngine(deps.config);
  const analytics = deps.analytics ?? new TokenAnalyticsEngine(deps.config);

  app.use("*", async (c, next) => {
    const publicMetrics = deps.config.analytics?.public_metrics !== false;
    if (
      c.req.path === "/health" ||
      c.req.path === "/" ||
      (publicMetrics && c.req.path === "/metrics" && c.req.method === "GET")
    ) {
      return next();
    }
    const expected = deps.config.gateway.api_key;
    if (!expected) {
      c.set("authed", true);
      return next();
    }
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    const token = match?.[1]?.trim() ?? "";
    if (token !== expected) {
      throw new HTTPException(401, { message: "Invalid API key" });
    }
    c.set("authed", true);
    return next();
  });

  app.get("/", (c) =>
    c.json({
      name: "mirevox-smart-router",
      version: "0.2.0",
      openai_base: "/v1",
      docs: "See README.md",
    }),
  );

  app.get("/health", (c) =>
    c.json({
      status: "ok",
      providers: deps.registry.listStatuses().map((p) => ({
        id: p.id,
        healthy: p.healthy,
        stub: p.stub,
      })),
    }),
  );

  app.get("/metrics", (c) =>
    c.body(analytics.renderPrometheus(), 200, {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
    }),
  );

  app.get("/v1/models", (c) => {
    const data = deps.registry.listModels();
    return c.json({ object: "list", data });
  });

  app.post("/v1/chat/completions", async (c) => {
    const body = (await c.req.json()) as ChatCompletionRequest;
    if (!body?.model || !Array.isArray(body.messages)) {
      throw new HTTPException(400, {
        message: "model and messages are required",
      });
    }
    if (body.stream) {
      throw new HTTPException(501, {
        message: "streaming not implemented in v0.1 stub",
      });
    }
    const decision = deps.policy.decide({
      model: body.model,
      activity: body.activity,
      placement: body.placement,
      backend: body.backend,
    });
    const violation = deps.policy.isPlacementViolation(decision);
    if (violation.violated) {
      throw new HTTPException(403, {
        message: violation.reason ?? "Placement policy violation",
      });
    }

    const appcode = resolveAppcode(
      body.appcode,
      c.req.header("x-mirevox-appcode"),
    );
    const sessionId = resolveSessionId(
      body.session_id,
      c.req.header("x-mirevox-session-id"),
    );
    const contextTokensSaved = resolveTokensSaved(
      body.context_tokens_saved,
      c.req.header("x-mirevox-tokens-saved"),
    );

    const traceId =
      body.trace_id?.trim() ||
      c.req.header("x-trace-id")?.trim() ||
      `trace_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

    const guardrailResult = guardrails.evaluate(body, traceId);
    if (guardrailResult.blocked) {
      analytics.record({
        route: "/v1/chat/completions",
        appcode,
        model: decision.model,
        backend: decision.backend,
        placement: decision.placement,
        activity: decision.activity,
        session_id: sessionId,
        messages: body.messages,
        prompt_tokens: 0,
        completion_tokens: 0,
        context_tokens_saved: 0,
        context_window_tokens: body.context_window_tokens,
        guardrailEvent: guardrailResult.event,
        blocked: true,
      });
      c.header("x-mirevox-trace-id", traceId);
      return c.json(
        {
          error: {
            message: guardrailResult.message,
            type: "guardrail_blocked",
            code: guardrailResult.code,
            trace_id: traceId,
            event_id: guardrailResult.event.id,
          },
        },
        guardrailResult.status,
      );
    }

    const provider = deps.config.registry.providers.find(
      (p) => p.id === decision.backend,
    );
    let result;
    if (provider?.live && provider?.endpoint) {
      try {
        result = await liveComplete(
          provider,
          deps.vault.getSecret(decision.backend),
          decision,
          body,
        );
      } catch (err) {
        analytics.record({
          route: "/v1/chat/completions",
          appcode,
          model: decision.model,
          backend: decision.backend,
          placement: decision.placement,
          activity: decision.activity,
          session_id: sessionId,
          messages: body.messages,
          prompt_tokens: 0,
          completion_tokens: 0,
          context_tokens_saved: 0,
          context_window_tokens: body.context_window_tokens,
          contextAlert: guardrailResult.contextAlert,
          guardrailEvent: guardrailResult.event,
          error: true,
        });
        throw new HTTPException(502, {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      result = await stubComplete(decision, body.messages);
    }

    result.mirevox.trace_id = traceId;
    c.header("x-mirevox-trace-id", traceId);
    if (guardrailResult.contextAlert) {
      result.mirevox.context_alert = guardrailResult.contextAlert;
      c.header("x-mirevox-context-alert", "compaction_triggered");
    }

    result.mirevox.token_analytics = analytics.record({
      route: "/v1/chat/completions",
      appcode,
      model: decision.model,
      backend: decision.backend,
      placement: decision.placement,
      activity: decision.activity,
      session_id: sessionId,
      messages: body.messages,
      prompt_tokens: result.usage.prompt_tokens,
      completion_tokens: result.usage.completion_tokens,
      total_tokens: result.usage.total_tokens,
      context_tokens_saved: contextTokensSaved,
      context_window_tokens: body.context_window_tokens,
      contextAlert: guardrailResult.contextAlert,
      guardrailEvent: guardrailResult.event,
    });

    const candidateEndpoint =
      provider?.endpoint && /^(?:https?|local):\/\//.test(provider.endpoint)
        ? provider.endpoint
        : `local://${decision.backend}`;

    const awaitHooks = process.env.SMART_ROUTER_AWAIT_HOOKS === "true";
    const lineageUrl = process.env.SMART_ROUTER_LINEAGE_URL?.trim();
    if (lineageUrl) {
      const lineageBase = lineageUrl.replace(/\/+$/, "");
      const lineagePromise = fetch(`${lineageBase}/v1/trace`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tenantId: "mirevox",
          sourceId: sessionId || "smart-router",
          declaredResidency: decision.placement === "onprem" ? "onprem" : "us",
          correlationId: traceId,
          labels: { trace_id: traceId, activity: decision.activity },
          payload: body.messages.map((m) => m.content ?? "").join("\n"),
          autoClassify: true,
          candidate: {
            providerId: decision.backend,
            modelId: body.model,
            residency: decision.placement === "onprem" ? "onprem" : "us",
            endpoint: candidateEndpoint,
            leavesPerimeter: decision.placement !== "onprem",
          },
        }),
      })
        .then((res) => {
          if (res.ok) {
            result.mirevox.lineage_correlation_id = traceId;
          }
        })
        .catch(() => {});
      if (awaitHooks) {
        await lineagePromise;
      } else {
        void lineagePromise;
      }
    }

    const evalsWebhook = process.env.SMART_ROUTER_EVALS_WEBHOOK_URL?.trim();
    if (evalsWebhook) {
      const evalPromise = fetch(evalsWebhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId: result.id,
          traceId,
          spanId: result.id,
          model: body.model,
          provider: decision.backend,
          routePolicy: decision.placement,
          prompt: body.messages.map((m) => m.content ?? "").join("\n"),
          response: result.choices[0]?.message?.content ?? "",
        }),
      }).catch(() => {});
      if (awaitHooks) {
        await evalPromise;
      } else {
        void evalPromise;
      }
    }

    return c.json(result);
  });

  /** Non-OpenAI extension: parallel task fan-out (accepts tasks[] or prompt) */
  app.post("/v1/fanout", async (c) => {
    const body = (await c.req.json()) as Partial<FanoutRequest> &
      Partial<SplitPromptRequest>;
    const tasks =
      Array.isArray(body?.tasks) && body.tasks.length > 0
        ? body.tasks
        : typeof body?.prompt === "string" && body.prompt.trim()
          ? decomposePromptToTasks(body as SplitPromptRequest)
          : [];
    if (tasks.length === 0) {
      throw new HTTPException(400, {
        message: "tasks[] required",
      });
    }
    const result = await fanoutTasks(deps.config, deps.policy, {
      tasks,
      timeout_ms: body.timeout_ms,
    });
    const tokenSummary = recordFanoutExecution(
      analytics,
      "/v1/fanout",
      tasks,
      result,
      {
        appcode: resolveAppcode(body.appcode, c.req.header("x-mirevox-appcode")),
        sessionId: resolveSessionId(
          body.session_id,
          c.req.header("x-mirevox-session-id"),
        ),
        contextTokensSaved: resolveTokensSaved(
          body.context_tokens_saved,
          c.req.header("x-mirevox-tokens-saved"),
        ),
      },
    );
    return c.json({ ...result, mirevox: { token_analytics: tokenSummary } });
  });

  /** Non-OpenAI extension: prompt decomposition + parallel task fan-out */
  app.post("/v1/split", async (c) => {
    const body = (await c.req.json()) as SplitPromptRequest;
    if (
      !body?.prompt ||
      typeof body.prompt !== "string" ||
      !body.prompt.trim()
    ) {
      throw new HTTPException(400, { message: "prompt is required" });
    }
    const tasks = decomposePromptToTasks(body);
    const fanout = await fanoutTasks(deps.config, deps.policy, {
      tasks,
      timeout_ms: body.timeout_ms,
    });
    const tokenSummary = recordFanoutExecution(
      analytics,
      "/v1/split",
      tasks,
      fanout,
      {
        appcode: resolveAppcode(body.appcode, c.req.header("x-mirevox-appcode")),
        sessionId: resolveSessionId(
          body.session_id,
          c.req.header("x-mirevox-session-id"),
        ),
        contextTokensSaved: resolveTokensSaved(
          body.context_tokens_saved,
          c.req.header("x-mirevox-tokens-saved"),
        ),
      },
    );
    return c.json({
      ...fanout,
      decomposed_tasks: tasks.length,
      mirevox: { token_analytics: tokenSummary },
    });
  });

  // Admin: vault
  app.get("/admin/keys", (c) => c.json({ data: deps.vault.list() }));

  app.put("/admin/keys/:id", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json()) as { backend: string; secret: string };
    if (!body?.backend || !body?.secret) {
      throw new HTTPException(400, { message: "backend and secret required" });
    }
    const entry = deps.vault.put(id, body.backend, body.secret);
    return c.json({
      id: entry.id,
      backend: entry.backend,
      updated_at: entry.updated_at,
      has_secret: true,
    });
  });

  app.delete("/admin/keys/:id", (c) => {
    const ok = deps.vault.delete(c.req.param("id"));
    return c.json({ deleted: ok });
  });

  // Admin: routing + registry
  app.get("/admin/routes", (c) =>
    c.json({
      routing: deps.config.routing,
      sample: [
        deps.policy.decide({ model: "gpt-4o-mini", activity: "chat" }),
        deps.policy.decide({ model: "local/llama3.2", activity: "code" }),
        deps.policy.decide({ model: "foundry/gpt-4o", activity: "chat" }),
      ],
    }),
  );

  app.get("/admin/registry", (c) =>
    c.json({ data: deps.registry.listStatuses() }),
  );

  app.post("/admin/registry/poll", async (c) => {
    const data = await deps.registry.pollAll();
    return c.json({ data });
  });

  app.get("/admin/guardrails/events", (c) => {
    const rawLimit = Number(c.req.query("limit") ?? 100);
    const limit = Number.isFinite(rawLimit) ? rawLimit : 100;
    return c.json({ data: guardrails.listEvents(limit) });
  });

  // Admin: token analytics & optimization advisor
  app.get("/admin/analytics/tokens", (c) =>
    c.json(
      analytics.getSnapshot({
        appcode: c.req.query("appcode"),
        model: c.req.query("model"),
        backend: c.req.query("backend"),
        activity: c.req.query("activity"),
        session_id: c.req.query("session_id"),
      }),
    ),
  );

  app.get("/admin/analytics/suggestions", (c) => {
    const rawLimit = c.req.query("limit");
    const parsedLimit =
      rawLimit !== undefined && rawLimit.trim() !== ""
        ? Number(rawLimit)
        : undefined;
    const data = analytics.getSuggestions({
      code: c.req.query("code"),
      severity: c.req.query("severity"),
      limit:
        parsedLimit !== undefined &&
        Number.isFinite(parsedLimit) &&
        parsedLimit > 0
          ? parsedLimit
          : undefined,
    });
    return c.json({ data, total: data.length });
  });

  app.notFound((c) =>
    c.json(
      { error: { message: "Not found", type: "invalid_request_error" } },
      404,
    ),
  );

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json(
        { error: { message: err.message, type: "invalid_request_error" } },
        err.status,
      );
    }
    if (err instanceof SyntaxError) {
      return c.json(
        {
          error: {
            message: "Invalid JSON body",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    console.error(err);
    return c.json(
      { error: { message: "internal_error", type: "server_error" } },
      500,
    );
  });

  return app;
}
