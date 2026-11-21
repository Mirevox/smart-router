import type {
  ChatCompletionRequest,
  ProviderConfig,
  RouteDecision,
} from "../types.js";
import type { CompletionResult } from "./stub.js";

function normalizeModelForUpstream(model: string): string {
  const slash = model.indexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}

export async function liveComplete(
  provider: ProviderConfig,
  apiKey: string | undefined,
  decision: RouteDecision,
  req: ChatCompletionRequest,
): Promise<CompletionResult> {
  if (!provider.endpoint) {
    throw new Error(`Provider '${provider.id}' has no endpoint configured`);
  }

  const base = provider.endpoint.replace(/\/+$/, "");
  const path = provider.api_path
    ? provider.api_path.startsWith("/")
      ? provider.api_path
      : `/${provider.api_path}`
    : "/v1/chat/completions";
  const url = `${base}${path}`;

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (apiKey) {
    headers["authorization"] = `Bearer ${apiKey}`;
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: normalizeModelForUpstream(req.model),
      messages: req.messages,
      temperature: req.temperature,
      max_tokens: req.max_tokens,
      stream: false,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `Upstream '${provider.id}' returned HTTP ${res.status}${errText ? `: ${errText.slice(0, 200)}` : ""}`,
    );
  }

  const data = (await res.json()) as Partial<CompletionResult> & {
    choices?: Array<{
      index?: number;
      message?: { role?: string; content?: string | null };
      finish_reason?: string;
    }>;
  };

  const firstContent = data.choices?.[0]?.message?.content ?? "";
  return {
    id:
      data.id ??
      `chatcmpl_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
    object: "chat.completion",
    created: data.created ?? Math.floor(Date.now() / 1000),
    model: data.model ?? decision.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: firstContent },
        finish_reason: "stop",
      },
    ],
    usage: data.usage ?? {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
    mirevox: {
      backend: decision.backend,
      placement: decision.placement,
      activity: decision.activity,
      stub: false,
    },
  };
}
