import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type {
  AppConfig,
  ChatCompletionRequest,
  FanoutRequest,
  SplitPromptRequest,
} from "../types.js";
import type { RoutingPolicy } from "../router/policy.js";
import type { DiscoveryRegistry } from "../registry/providers.js";
import type { KeyVault } from "../vault/key-vault.js";
import { stubComplete } from "../backends/stub.js";
import { liveComplete } from "../backends/live.js";
import { decomposePromptToTasks, fanoutTasks } from "../fanout/splitter.js";

type Vars = {
  Variables: {
    authed: boolean;
  };
};

export function createGateway(deps: {
  config: AppConfig;
  policy: RoutingPolicy;
  registry: DiscoveryRegistry;
  vault: KeyVault;
}): Hono<Vars> {
  const app = new Hono<Vars>();

  app.use("*", async (c, next) => {
    if (c.req.path === "/health" || c.req.path === "/") {
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
      version: "0.1.0",
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
        throw new HTTPException(502, {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      result = await stubComplete(decision, body.messages);
    }

    const evalsWebhook = process.env.SMART_ROUTER_EVALS_WEBHOOK_URL?.trim();
    if (evalsWebhook) {
      void fetch(evalsWebhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId: result.id,
          model: body.model,
          provider: decision.backend,
          prompt: body.messages.map((m) => m.content ?? "").join("\n"),
          response: result.choices[0]?.message?.content ?? "",
        }),
      }).catch(() => {});
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
    return c.json(result);
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
    return c.json({ ...fanout, decomposed_tasks: tasks.length });
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
