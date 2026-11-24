import type { ChatMessage, RouteDecision } from "../types.js";

export interface CompletionResult {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string };
    finish_reason: "stop";
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  mirevox: {
    backend: string;
    placement: string;
    activity: string;
    stub: boolean;
    trace_id?: string;
    lineage_correlation_id?: string;
    context_alert?: {
      status: "warning";
      compaction_triggered: true;
      prompt_tokens: number;
      context_window_tokens: number;
      usage_ratio: number;
    };
    token_analytics?: {
      prompt_tokens: number;
      completion_tokens: number;
      estimated_cost_usd: number;
      context_tokens_saved: number;
      appcode: string;
    };
  };
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export async function stubComplete(
  decision: RouteDecision,
  messages: ChatMessage[],
): Promise<CompletionResult> {
  const lastUser = [...messages]
    .reverse()
    .find((m) => m.role === "user")?.content;
  const prompt = typeof lastUser === "string" ? lastUser : "";
  const content =
    `[mirevox-stub/${decision.backend}] ` +
    `placement=${decision.placement} activity=${decision.activity} ` +
    `echo: ${prompt.slice(0, 500) || "(empty)"}`;

  const prompt_tokens = estimateTokens(
    messages.map((m) => m.content ?? "").join(" "),
  );
  const completion_tokens = estimateTokens(content);

  // Simulate tiny latency variance
  await new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 20)));

  return {
    id: `chatcmpl_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: decision.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens,
      completion_tokens,
      total_tokens: prompt_tokens + completion_tokens,
    },
    mirevox: {
      backend: decision.backend,
      placement: decision.placement,
      activity: decision.activity,
      stub: true,
    },
  };
}
