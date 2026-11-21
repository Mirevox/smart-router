import crypto from "node:crypto";
import type { AppConfig, ChatCompletionRequest } from "../types.js";

export type GuardrailEventType =
  | "loop_detected"
  | "budget_exceeded"
  | "context_exhaustion_warning";

export interface GuardrailEvent {
  id: string;
  type: GuardrailEventType;
  trace_id: string;
  session_id?: string;
  timestamp: string;
  blocked: boolean;
  message: string;
  details: Record<string, unknown>;
}

export interface ContextAlert {
  status: "warning";
  compaction_triggered: true;
  prompt_tokens: number;
  context_window_tokens: number;
  usage_ratio: number;
}

export type GuardrailEvaluation =
  | {
      blocked: true;
      status: 402 | 429;
      code: "LOOP_CIRCUIT_BREAKER" | "BUDGET_CAP_EXCEEDED";
      message: string;
      event: GuardrailEvent;
    }
  | {
      blocked: false;
      contextAlert?: ContextAlert;
      event?: GuardrailEvent;
    };

function estimateTextTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function canonicalizeArgs(args: unknown): string {
  if (typeof args === "string") {
    const trimmed = args.trim();
    try {
      return JSON.stringify(JSON.parse(trimmed));
    } catch {
      return trimmed;
    }
  }
  return JSON.stringify(args ?? {});
}

function extractToolInvocations(req: ChatCompletionRequest): Array<{
  name: string;
  argsKey: string;
}> {
  const out: Array<{ name: string; argsKey: string }> = [];
  if (Array.isArray(req.tool_calls)) {
    for (const tc of req.tool_calls) {
      if (!tc?.name) continue;
      out.push({
        name: tc.name,
        argsKey: `${tc.name}::${canonicalizeArgs(tc.arguments)}`,
      });
    }
  }
  for (const msg of req.messages) {
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const fnName = tc?.function?.name;
        if (!fnName) continue;
        out.push({
          name: fnName,
          argsKey: `${fnName}::${canonicalizeArgs(tc.function?.arguments)}`,
        });
      }
    } else if (msg.role === "tool" && msg.name) {
      out.push({
        name: msg.name,
        argsKey: `${msg.name}::${canonicalizeArgs(msg.content ?? "")}`,
      });
    }
  }
  return out;
}

export class GuardrailEngine {
  private readonly events: GuardrailEvent[] = [];
  private readonly sessionToolCounts = new Map<string, Map<string, number>>();
  private readonly maxEvents = 500;

  constructor(private readonly config: AppConfig) {}

  private record(event: GuardrailEvent): void {
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }
  }

  listEvents(limit = 100): GuardrailEvent[] {
    return this.events.slice(-Math.max(1, limit));
  }

  evaluate(req: ChatCompletionRequest, traceId: string): GuardrailEvaluation {
    const cfg = this.config.guardrails ?? {};
    const maxLoop = cfg.max_identical_tool_calls ?? 3;
    const sessionKey = req.session_id?.trim() || undefined;

    // 1. Loop Detector: >N identical (tool, args) invocations -> kill run + circuit breaker event
    const invocations = extractToolInvocations(req);
    if (invocations.length > 0) {
      const priorMap = sessionKey
        ? (this.sessionToolCounts.get(sessionKey) ?? new Map<string, number>())
        : new Map<string, number>();
      const workingCounts = new Map(priorMap);

      for (const inv of invocations) {
        const nextCount = (workingCounts.get(inv.argsKey) ?? 0) + 1;
        workingCounts.set(inv.argsKey, nextCount);
        if (nextCount > maxLoop) {
          if (sessionKey) this.sessionToolCounts.set(sessionKey, workingCounts);
          const event: GuardrailEvent = {
            id: `gr_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
            type: "loop_detected",
            trace_id: traceId,
            session_id: sessionKey,
            timestamp: new Date().toISOString(),
            blocked: true,
            message: `Circuit breaker tripped: tool '${inv.name}' invoked ${nextCount} times with identical arguments (limit ${maxLoop}).`,
            details: {
              tool_name: inv.name,
              count: nextCount,
              limit: maxLoop,
            },
          };
          this.record(event);
          return {
            blocked: true,
            status: 429,
            code: "LOOP_CIRCUIT_BREAKER",
            message: event.message,
            event,
          };
        }
      }
      if (sessionKey) this.sessionToolCounts.set(sessionKey, workingCounts);
    }

    // 2. Per-Task Budget Cap: hard-stop before upstream dispatch
    const promptChars = req.messages
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n").length;
    const promptTokens = estimateTextTokens(
      req.messages.map((m) => m.content ?? "").join(" "),
    );
    const totalEstimatedTokens = promptTokens + (req.max_tokens ?? 0);
    const ratePer1k = cfg.cost_per_1k_tokens_usd ?? 0.01;
    const estimatedCostUsd = Number(
      ((totalEstimatedTokens / 1000) * ratePer1k).toFixed(6),
    );
    const maxTokens = req.budget?.max_tokens ?? cfg.max_task_tokens;
    const maxCostUsd = req.budget?.max_cost_usd ?? cfg.max_task_cost_usd;

    const tokenExceeded =
      maxTokens !== undefined && totalEstimatedTokens > maxTokens;
    const costExceeded =
      maxCostUsd !== undefined && estimatedCostUsd > maxCostUsd;

    if (tokenExceeded || costExceeded) {
      const event: GuardrailEvent = {
        id: `gr_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
        type: "budget_exceeded",
        trace_id: traceId,
        session_id: sessionKey,
        timestamp: new Date().toISOString(),
        blocked: true,
        message: tokenExceeded
          ? `Per-task token budget exceeded: estimated ${totalEstimatedTokens} tokens > limit ${maxTokens}.`
          : `Per-task cost budget exceeded: estimated $${estimatedCostUsd} > limit $${maxCostUsd}.`,
        details: {
          prompt_chars: promptChars,
          prompt_tokens: promptTokens,
          requested_max_tokens: req.max_tokens ?? 0,
          estimated_total_tokens: totalEstimatedTokens,
          estimated_cost_usd: estimatedCostUsd,
          max_tokens: maxTokens,
          max_cost_usd: maxCostUsd,
        },
      };
      this.record(event);
      return {
        blocked: true,
        status: 402,
        code: "BUDGET_CAP_EXCEEDED",
        message: event.message,
        event,
      };
    }

    // 3. Context Exhaustion Alert: >= 80% context window -> warning + compaction trigger
    const windowTokens =
      req.context_window_tokens ?? cfg.context_window_tokens ?? 4096;
    const warnRatio = cfg.context_warn_ratio ?? 0.8;
    const usageRatio = promptTokens / Math.max(1, windowTokens);
    if (usageRatio >= warnRatio) {
      const contextAlert: ContextAlert = {
        status: "warning",
        compaction_triggered: true,
        prompt_tokens: promptTokens,
        context_window_tokens: windowTokens,
        usage_ratio: Number(usageRatio.toFixed(3)),
      };
      const event: GuardrailEvent = {
        id: `gr_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
        type: "context_exhaustion_warning",
        trace_id: traceId,
        session_id: sessionKey,
        timestamp: new Date().toISOString(),
        blocked: false,
        message: `Context usage at ${(usageRatio * 100).toFixed(1)}% (${promptTokens}/${windowTokens} tokens); compaction triggered.`,
        details: { ...contextAlert },
      };
      this.record(event);
      return {
        blocked: false,
        contextAlert,
        event,
      };
    }

    return { blocked: false };
  }
}
