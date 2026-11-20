import type { AppConfig, FanoutRequest, FanoutTask } from "../types.js";
import type { RoutingPolicy } from "../router/policy.js";
import { stubComplete, type CompletionResult } from "../backends/stub.js";

export interface FanoutTaskResult {
  id: string;
  ok: boolean;
  decision?: ReturnType<RoutingPolicy["decide"]>;
  result?: CompletionResult;
  error?: string;
  duration_ms: number;
}

export interface FanoutResponse {
  object: "mirevox.fanout_result";
  parallel: number;
  results: FanoutTaskResult[];
}

async function runOne(
  policy: RoutingPolicy,
  task: FanoutTask,
  timeoutMs: number,
): Promise<FanoutTaskResult> {
  const started = Date.now();
  const decision = policy.decide({
    model: task.model ?? "gpt-4o-mini",
    activity: task.activity,
    placement: task.placement,
    backend: task.backend,
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      stubComplete(decision, task.messages),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("task timeout")), timeoutMs);
      }),
    ]);
    return {
      id: task.id,
      ok: true,
      decision,
      result,
      duration_ms: Date.now() - started,
    };
  } catch (err) {
    return {
      id: task.id,
      ok: false,
      decision,
      error: err instanceof Error ? err.message : String(err),
      duration_ms: Date.now() - started,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Split multi-part work and fan out in parallel across backends.
 * Caps concurrency at fanout.max_parallel.
 */
export async function fanoutTasks(
  config: AppConfig,
  policy: RoutingPolicy,
  req: FanoutRequest,
): Promise<FanoutResponse> {
  const timeout =
    req.timeout_ms ?? config.fanout.default_timeout_ms;
  const limit = Math.max(1, config.fanout.max_parallel);
  const results: FanoutTaskResult[] = [];
  const queue = [...req.tasks];

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const task = queue.shift();
      if (!task) return;
      results.push(await runOne(policy, task, timeout));
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, req.tasks.length) },
    () => worker(),
  );
  await Promise.all(workers);

  // Preserve input order
  const byId = new Map(results.map((r) => [r.id, r]));
  const ordered = req.tasks.map(
    (t) =>
      byId.get(t.id) ?? {
        id: t.id,
        ok: false,
        error: "missing result",
        duration_ms: 0,
      },
  );

  return {
    object: "mirevox.fanout_result",
    parallel: Math.min(limit, req.tasks.length),
    results: ordered,
  };
}
