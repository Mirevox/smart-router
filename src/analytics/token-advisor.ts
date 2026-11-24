import crypto from "node:crypto";
import type {
  AppConfig,
  ChatMessage,
  ModelTier,
  Placement,
} from "../types.js";
import type { ContextAlert, GuardrailEvent } from "../guardrails/engine.js";

export type SuggestionCode =
  | "use_context_engine_pack"
  | "deduplicate_repo_dump"
  | "downgrade_model_tier"
  | "compact_session_history";

export type SuggestionSeverity = "high" | "medium" | "low";

export interface TokenAnalyticsSummary {
  prompt_tokens: number;
  completion_tokens: number;
  estimated_cost_usd: number;
  context_tokens_saved: number;
  appcode: string;
}

export interface TokenSuggestion {
  id: string;
  code: SuggestionCode;
  severity: SuggestionSeverity;
  title: string;
  message: string;
  recommendation: string;
  affected_requests: number;
  potential_tokens_saved: number;
  potential_cost_savings_usd: number;
  appcodes: string[];
  models: string[];
  affected_sessions: number;
  details: Record<string, unknown>;
}

export interface TokenAggregateBucket {
  requests: number;
  blocked_requests: number;
  error_requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  context_tokens_saved: number;
  duplicate_context_tokens: number;
  estimated_cost_usd: number;
  estimated_savings_usd: number;
}

export interface TokenAnalyticsSnapshot {
  version: "0.2.0";
  generated_at: string;
  filters: AnalyticsFilter;
  totals: TokenAggregateBucket;
  by_appcode: Record<string, TokenAggregateBucket>;
  by_model: Record<string, TokenAggregateBucket & { tier: ModelTier }>;
  by_backend: Record<string, TokenAggregateBucket>;
  by_placement: Record<string, TokenAggregateBucket>;
  by_activity: Record<string, TokenAggregateBucket>;
  by_session: Record<string, TokenAggregateBucket>;
  guardrail_events: Record<string, number>;
  fingerprints: {
    tracked: number;
    max_tracked: number;
    repeated_count: number;
  };
  suggestions_summary: {
    total: number;
    by_severity: Record<SuggestionSeverity, number>;
  };
}

export interface AnalyticsFilter {
  appcode?: string;
  model?: string;
  backend?: string;
  activity?: string;
  session_id?: string;
}

export interface SuggestionFilter {
  code?: SuggestionCode | string;
  severity?: SuggestionSeverity | string;
  limit?: number;
}

export interface RecordExecutionInput {
  route: "/v1/chat/completions" | "/v1/fanout" | "/v1/split";
  appcode?: string;
  model: string;
  backend: string;
  placement: Placement;
  activity: string;
  session_id?: string;
  messages?: ChatMessage[];
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens?: number;
  context_tokens_saved?: number;
  context_window_tokens?: number;
  contextAlert?: ContextAlert;
  guardrailEvent?: GuardrailEvent;
  blocked?: boolean;
  error?: boolean;
}

interface AnalyticsRecord {
  seq: number;
  timestamp: string;
  route: string;
  appcode: string;
  model: string;
  tier: ModelTier;
  backend: string;
  placement: Placement;
  activity: string;
  session_id?: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  context_tokens_saved: number;
  duplicate_context_tokens: number;
  estimated_cost_usd: number;
  estimated_savings_usd: number;
  rate_per_1k_usd: number;
  blocked: boolean;
  error: boolean;
  guardrail_event_type?: string;
  message_count: number;
  context_window_tokens: number;
  compaction_triggered: boolean;
  token_growth_above_half: boolean;
  downgrade_eligible: boolean;
}

/**
 * Privacy-preserving fingerprint record: stores only SHA-256 hash and
 * numeric/structural metadata — NEVER raw prompt or message strings.
 */
interface FingerprintEntry {
  hash: string;
  kind: "prompt" | "block";
  char_length: number;
  estimated_tokens: number;
  count: number;
  duplicate_tokens: number;
  duplicate_savings_usd: number;
  has_code_markers: boolean;
  intra_request_repeats: number;
  max_same_session_count: number;
  session_counts: Map<string, number>;
  appcodes: Set<string>;
  models: Set<string>;
  request_seqs: Set<number>;
  last_seen_at: string;
}

interface SessionHistoryState {
  baseline_prompt_tokens: number;
  max_prompt_tokens: number;
  request_count: number;
}

interface PromptHistogramSeries {
  model: string;
  backend: string;
  placement: string;
  buckets: number[];
  sum: number;
  count: number;
}

const DEFAULT_TIER_COST_PER_1K_USD: Record<ModelTier, number> = {
  frontier: 0.015,
  standard: 0.005,
  economy: 0.001,
  local: 0,
};

const PROMPT_TOKEN_BUCKETS = [
  64, 256, 600, 1024, 2048, 4096, 8192, 16384, 32768,
] as const;

const MIN_FINGERPRINT_CHARS = 1000;
const DEFAULT_MAX_FINGERPRINTS = 1000;
const DEFAULT_MAX_EVENTS = 10_000;
const MAX_TRACKED_SESSIONS = 10_000;
const MAX_DYNAMIC_PROM_VALUES = 100;

const SEVERITY_RANK: Record<SuggestionSeverity, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

function roundUsd(value: number): number {
  return Number(value.toFixed(6));
}

function emptyBucket(): TokenAggregateBucket {
  return {
    requests: 0,
    blocked_requests: 0,
    error_requests: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    context_tokens_saved: 0,
    duplicate_context_tokens: 0,
    estimated_cost_usd: 0,
    estimated_savings_usd: 0,
  };
}

function accumulateBucket(
  target: TokenAggregateBucket,
  rec: AnalyticsRecord,
): void {
  target.requests += 1;
  if (rec.blocked) target.blocked_requests += 1;
  if (rec.error) target.error_requests += 1;
  target.prompt_tokens += rec.prompt_tokens;
  target.completion_tokens += rec.completion_tokens;
  target.total_tokens += rec.total_tokens;
  target.context_tokens_saved += rec.context_tokens_saved;
  target.duplicate_context_tokens += rec.duplicate_context_tokens;
  target.estimated_cost_usd = roundUsd(
    target.estimated_cost_usd + rec.estimated_cost_usd,
  );
  target.estimated_savings_usd = roundUsd(
    target.estimated_savings_usd + rec.estimated_savings_usd,
  );
}

function normalizePayload(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim();
}

function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function estimateTokensFromChars(charLen: number): number {
  return Math.max(1, Math.ceil(charLen / 4));
}

function hasCodeOrTreeMarkers(raw: string): boolean {
  if (/[├└│─]{2,}/.test(raw) || /^\s*[├└|]\s*[-─]/m.test(raw)) {
    return true;
  }
  if (/^(?:diff --git |---\s+a\/|\+\+\+\s+b\/|@@\s+-\d)/m.test(raw)) {
    return true;
  }
  if (/```[\w-]*\r?\n/.test(raw)) {
    return true;
  }
  const codePathMatches = raw.match(
    /(?:^|[\s(`"'])(?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|yaml|yml|json|md)\b/gim,
  );
  if (codePathMatches && codePathMatches.length >= 2) {
    return true;
  }
  const codeFileMatches = raw.match(
    /\b[\w.-]+\.(?:ts|tsx|js|jsx|py|go|rs|java)\b/gim,
  );
  if (codeFileMatches && codeFileMatches.length >= 3) {
    return true;
  }
  if (
    /\b(?:import\s+[\w*{}\s,]+\s+from\s+['"]|export\s+(?:async\s+)?(?:function|class|interface|type|const)\s+\w+|def\s+\w+\s*\(|class\s+\w+\s*[{:(])/.test(
      raw,
    )
  ) {
    return true;
  }
  return false;
}

function isDowngradeableActivity(activity: string): boolean {
  const norm = activity.trim().toLowerCase();
  return /^(?:tool|tools|code|summar|classify|extract|lint)/.test(norm);
}

function escapePromLabel(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/"/g, '\\"');
}

function formatPromLabels(labels: Record<string, string>): string {
  const parts = Object.entries(labels).map(
    ([k, v]) => `${k}="${escapePromLabel(v)}"`,
  );
  return `{${parts.join(",")}}`;
}

function formatMetricNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function matchModelCostPattern(
  table: Record<string, number> | undefined,
  model: string,
): number | undefined {
  if (!table) return undefined;
  if (table[model] !== undefined) return table[model];
  const slash = model.indexOf("/");
  if (slash >= 0) {
    const stripped = model.slice(slash + 1);
    if (table[stripped] !== undefined) return table[stripped];
  }
  for (const [pattern, rate] of Object.entries(table)) {
    if (
      pattern.endsWith("*") &&
      model.startsWith(pattern.slice(0, -1)) &&
      Number.isFinite(rate)
    ) {
      return rate;
    }
  }
  return undefined;
}

export class TokenAnalyticsEngine {
  private readonly events: AnalyticsRecord[] = [];
  private readonly fingerprints = new Map<string, FingerprintEntry>();
  private readonly sessions = new Map<string, SessionHistoryState>();
  private readonly totals = emptyBucket();
  private readonly byAppcode = new Map<string, TokenAggregateBucket>();
  private readonly byModel = new Map<
    string,
    TokenAggregateBucket & { tier: ModelTier }
  >();
  private readonly byBackend = new Map<string, TokenAggregateBucket>();
  private readonly byPlacement = new Map<string, TokenAggregateBucket>();
  private readonly byActivity = new Map<string, TokenAggregateBucket>();
  private readonly bySession = new Map<string, TokenAggregateBucket>();
  private readonly guardrailCounts = new Map<string, number>();

  // Bounded Prometheus metric stores (NO session_id labels ever stored here)
  private readonly promTokens = new Map<
    string,
    { labels: Record<string, string>; value: number }
  >();
  private readonly promTokensSaved = new Map<
    string,
    { labels: Record<string, string>; value: number }
  >();
  private readonly promCostUsd = new Map<
    string,
    { labels: Record<string, string>; value: number }
  >();
  private readonly promCostSavedUsd = new Map<
    string,
    { labels: Record<string, string>; value: number }
  >();
  private readonly promDupContextTokens = new Map<
    string,
    { labels: Record<string, string>; value: number }
  >();
  private readonly promRequests = new Map<
    string,
    { labels: Record<string, string>; value: number }
  >();
  private readonly promGuardrailEvents = new Map<
    string,
    { labels: Record<string, string>; value: number }
  >();
  private readonly promPromptHistograms = new Map<
    string,
    PromptHistogramSeries
  >();
  private readonly seenLabelValues = new Map<string, Set<string>>();

  private seq = 0;

  constructor(private readonly config: AppConfig) {
    // Seed known guardrail label pairs so Prometheus scrape starts cleanly
    this.seedGuardrailSeries("loop_detected", "true");
    this.seedGuardrailSeries("budget_exceeded", "true");
    this.seedGuardrailSeries("context_exhaustion_warning", "false");
  }

  private get maxTrackedFingerprints(): number {
    const configured = this.config.analytics?.max_tracked_fingerprints;
    if (
      configured !== undefined &&
      Number.isFinite(configured) &&
      configured >= 0
    ) {
      return Math.floor(configured);
    }
    return DEFAULT_MAX_FINGERPRINTS;
  }

  private get maxEvents(): number {
    const configured = this.config.analytics?.max_events;
    if (
      configured !== undefined &&
      Number.isFinite(configured) &&
      configured > 0
    ) {
      return Math.floor(configured);
    }
    return DEFAULT_MAX_EVENTS;
  }

  private seedGuardrailSeries(type: string, blocked: string): void {
    const key = `${type}::${blocked}`;
    if (!this.promGuardrailEvents.has(key)) {
      this.promGuardrailEvents.set(key, {
        labels: { type, blocked },
        value: 0,
      });
    }
  }

  private boundLabelValue(dimension: string, raw: string): string {
    const clean = raw.trim().slice(0, 64) || "unknown";
    let set = this.seenLabelValues.get(dimension);
    if (!set) {
      set = new Set<string>();
      this.seenLabelValues.set(dimension, set);
    }
    if (set.has(clean)) return clean;
    if (set.size < MAX_DYNAMIC_PROM_VALUES) {
      set.add(clean);
      return clean;
    }
    return "other";
  }

  private addPromCounter(
    store: Map<string, { labels: Record<string, string>; value: number }>,
    labels: Record<string, string>,
    delta: number,
    isUsd = false,
  ): void {
    const key = Object.entries(labels)
      .map(([k, v]) => `${k}=${v}`)
      .join("|");
    const existing = store.get(key);
    if (existing) {
      existing.value = isUsd
        ? roundUsd(existing.value + delta)
        : existing.value + delta;
    } else {
      store.set(key, {
        labels,
        value: isUsd ? roundUsd(delta) : delta,
      });
    }
  }

  private observePromptHistogram(
    model: string,
    backend: string,
    placement: string,
    promptTokens: number,
  ): void {
    const labels = {
      model: this.boundLabelValue("model", model),
      backend: this.boundLabelValue("backend", backend),
      placement: this.boundLabelValue("placement", placement),
    };
    const key = `${labels.model}|${labels.backend}|${labels.placement}`;
    let series = this.promPromptHistograms.get(key);
    if (!series) {
      series = {
        ...labels,
        buckets: new Array<number>(PROMPT_TOKEN_BUCKETS.length).fill(0),
        sum: 0,
        count: 0,
      };
      this.promPromptHistograms.set(key, series);
    }
    for (let i = 0; i < PROMPT_TOKEN_BUCKETS.length; i += 1) {
      const bound = PROMPT_TOKEN_BUCKETS[i]!;
      if (promptTokens <= bound) {
        series.buckets[i] = (series.buckets[i] ?? 0) + 1;
      }
    }
    series.sum += promptTokens;
    series.count += 1;
  }

  classifyModelTier(model: string, backend?: string): ModelTier {
    if (backend) {
      const provider = this.config.registry.providers.find(
        (p) => p.id === backend,
      );
      if (provider && (provider.kind === "local" || provider.kind === "mcp")) {
        return "local";
      }
    }
    const lower = model.trim().toLowerCase();
    if (
      lower.startsWith("local/") ||
      lower.startsWith("mcp/") ||
      lower.startsWith("ollama/")
    ) {
      return "local";
    }
    if (
      /(?:^|[/-])(?:mini|flash|haiku|nano|lite|micro|small)(?:$|[/-])|gpt-3\.5|gemma|phi/.test(
        lower,
      )
    ) {
      return "economy";
    }
    if (
      /(?:gpt-4o|gpt-4\.1|gpt-4\.5|gpt-5|\bo1\b|\bo3\b|\bo4\b|opus|claude-3-5-sonnet|claude-3-7-sonnet|claude-sonnet-4|claude-4|gemini-1\.5-pro|gemini-2\.5-pro|gemini-pro)/.test(
        lower,
      )
    ) {
      return "frontier";
    }
    return "standard";
  }

  resolveCostPer1kUsd(
    model: string,
    backend?: string,
  ): { tier: ModelTier; ratePer1kUsd: number } {
    const tier = this.classifyModelTier(model, backend);

    const modelOverride = matchModelCostPattern(
      this.config.analytics?.model_cost_per_1k_usd,
      model,
    );
    if (modelOverride !== undefined && Number.isFinite(modelOverride)) {
      return { tier, ratePer1kUsd: Math.max(0, modelOverride) };
    }

    const tierOverride = this.config.analytics?.tier_cost_per_1k_usd?.[tier];
    if (tierOverride !== undefined && Number.isFinite(tierOverride)) {
      return { tier, ratePer1kUsd: Math.max(0, tierOverride) };
    }

    const guardrailRate = this.config.guardrails?.cost_per_1k_tokens_usd;
    if (
      tier !== "local" &&
      guardrailRate !== undefined &&
      Number.isFinite(guardrailRate)
    ) {
      return { tier, ratePer1kUsd: Math.max(0, guardrailRate) };
    }

    return { tier, ratePer1kUsd: DEFAULT_TIER_COST_PER_1K_USD[tier] };
  }

  private touchOrCreateFingerprint(
    hash: string,
    kind: "prompt" | "block",
    charLength: number,
    hasCodeMarkers: boolean,
    nowIso: string,
  ): FingerprintEntry | null {
    const maxSize = this.maxTrackedFingerprints;
    if (maxSize <= 0) return null;

    const existing = this.fingerprints.get(hash);
    if (existing) {
      // Refresh LRU position
      this.fingerprints.delete(hash);
      existing.last_seen_at = nowIso;
      if (hasCodeMarkers) existing.has_code_markers = true;
      this.fingerprints.set(hash, existing);
      return existing;
    }

    while (this.fingerprints.size >= maxSize) {
      const oldestKey = this.fingerprints.keys().next().value;
      if (oldestKey === undefined) break;
      this.fingerprints.delete(oldestKey);
    }

    const entry: FingerprintEntry = {
      hash,
      kind,
      char_length: charLength,
      estimated_tokens: estimateTokensFromChars(charLength),
      count: 0,
      duplicate_tokens: 0,
      duplicate_savings_usd: 0,
      has_code_markers: hasCodeMarkers,
      intra_request_repeats: 0,
      max_same_session_count: 0,
      session_counts: new Map<string, number>(),
      appcodes: new Set<string>(),
      models: new Set<string>(),
      request_seqs: new Set<number>(),
      last_seen_at: nowIso,
    };
    this.fingerprints.set(hash, entry);
    return entry;
  }

  private recordFingerprintHit(
    entry: FingerprintEntry,
    appcode: string,
    model: string,
    sessionId: string | undefined,
    ratePer1kUsd: number,
    requestSeq: number,
    countDuplicateTokens: boolean,
  ): number {
    entry.count += 1;
    entry.appcodes.add(appcode);
    entry.models.add(model);
    const alreadyInThisRequest = entry.request_seqs.has(requestSeq);
    entry.request_seqs.add(requestSeq);
    if (alreadyInThisRequest) {
      entry.intra_request_repeats += 1;
    }

    if (sessionId) {
      const prevSessionCount = entry.session_counts.get(sessionId) ?? 0;
      const nextSessionCount = prevSessionCount + 1;
      if (
        !entry.session_counts.has(sessionId) &&
        entry.session_counts.size >= 200
      ) {
        const oldestSession = entry.session_counts.keys().next().value;
        if (oldestSession !== undefined) {
          entry.session_counts.delete(oldestSession);
        }
      }
      entry.session_counts.set(sessionId, nextSessionCount);
      if (nextSessionCount > entry.max_same_session_count) {
        entry.max_same_session_count = nextSessionCount;
      }
    }

    if (entry.count >= 2 && countDuplicateTokens) {
      const dupTokens = entry.estimated_tokens;
      const dupUsd = roundUsd((dupTokens / 1000) * ratePer1kUsd);
      entry.duplicate_tokens += dupTokens;
      entry.duplicate_savings_usd = roundUsd(
        entry.duplicate_savings_usd + dupUsd,
      );
      return dupTokens;
    }
    return 0;
  }

  private processPayloads(
    messages: ChatMessage[] | undefined,
    appcode: string,
    model: string,
    sessionId: string | undefined,
    ratePer1kUsd: number,
    requestSeq: number,
    nowIso: string,
  ): number {
    if (!messages || messages.length === 0) return 0;

    let blockDuplicateTokens = 0;
    const processedHashesInReq = new Set<string>();

    // 1. Fingerprint individual >1000-char message payloads
    for (const msg of messages) {
      const raw = typeof msg.content === "string" ? msg.content : "";
      if (!raw) continue;
      const normalized = normalizePayload(raw);
      if (normalized.length <= MIN_FINGERPRINT_CHARS) continue;

      const hash = sha256Hex(normalized);
      const isCodeOrTree = hasCodeOrTreeMarkers(raw);
      const entry = this.touchOrCreateFingerprint(
        hash,
        "block",
        normalized.length,
        isCodeOrTree,
        nowIso,
      );
      if (entry) {
        processedHashesInReq.add(hash);
        blockDuplicateTokens += this.recordFingerprintHit(
          entry,
          appcode,
          model,
          sessionId,
          ratePer1kUsd,
          requestSeq,
          true,
        );
      }
    }

    // 2. Fingerprint full concatenated normalized prompt (>1000 chars)
    const fullRaw = messages
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    const fullNormalized = normalizePayload(fullRaw);
    let promptDuplicateTokens = 0;

    if (fullNormalized.length > MIN_FINGERPRINT_CHARS) {
      const fullHash = sha256Hex(fullNormalized);
      // Avoid double-counting when there is a single >1000-char message whose hash matches full prompt
      if (!processedHashesInReq.has(fullHash)) {
        const entry = this.touchOrCreateFingerprint(
          fullHash,
          "prompt",
          fullNormalized.length,
          hasCodeOrTreeMarkers(fullRaw),
          nowIso,
        );
        if (entry) {
          // Only add full-prompt duplicate tokens when individual blocks didn't already account for it
          promptDuplicateTokens = this.recordFingerprintHit(
            entry,
            appcode,
            model,
            sessionId,
            ratePer1kUsd,
            requestSeq,
            blockDuplicateTokens === 0,
          );
        }
      }
    }

    return blockDuplicateTokens > 0
      ? blockDuplicateTokens
      : promptDuplicateTokens;
  }

  private getOrCreateMapBucket<T extends TokenAggregateBucket>(
    map: Map<string, T>,
    key: string,
    create: () => T,
  ): T {
    let bucket = map.get(key);
    if (!bucket) {
      bucket = create();
      map.set(key, bucket);
    }
    return bucket;
  }

  record(input: RecordExecutionInput): TokenAnalyticsSummary {
    const seq = ++this.seq;
    const nowIso = new Date().toISOString();
    const appcode = input.appcode?.trim() || "default";
    const sessionId = input.session_id?.trim() || undefined;
    const blocked = Boolean(input.blocked);
    const error = Boolean(input.error);
    const activeSuccess = !blocked && !error;

    const promptTokens = activeSuccess
      ? Math.max(0, Math.round(input.prompt_tokens))
      : 0;
    const completionTokens = activeSuccess
      ? Math.max(0, Math.round(input.completion_tokens))
      : 0;
    const totalTokens = activeSuccess
      ? Math.max(
          promptTokens + completionTokens,
          Math.round(input.total_tokens ?? promptTokens + completionTokens),
        )
      : 0;
    const contextTokensSaved = activeSuccess
      ? Math.max(0, Math.round(input.context_tokens_saved ?? 0))
      : 0;

    const { tier, ratePer1kUsd } = this.resolveCostPer1kUsd(
      input.model,
      input.backend,
    );
    const estimatedCostUsd = activeSuccess
      ? roundUsd((totalTokens / 1000) * ratePer1kUsd)
      : 0;
    const estimatedSavingsUsd = activeSuccess
      ? roundUsd((contextTokensSaved / 1000) * ratePer1kUsd)
      : 0;

    const duplicateContextTokens = activeSuccess
      ? this.processPayloads(
          input.messages,
          appcode,
          input.model,
          sessionId,
          ratePer1kUsd,
          seq,
          nowIso,
        )
      : 0;

    const messageCount = Array.isArray(input.messages)
      ? input.messages.length
      : 0;
    const contextWindowTokens = Math.max(
      1,
      input.contextAlert?.context_window_tokens ??
        input.context_window_tokens ??
        this.config.guardrails?.context_window_tokens ??
        4096,
    );
    const compactionTriggered = Boolean(
      input.contextAlert?.compaction_triggered,
    );

    let tokenGrowthAboveHalf = false;
    if (activeSuccess && sessionId && promptTokens > 0) {
      let state = this.sessions.get(sessionId);
      if (!state) {
        if (this.sessions.size >= MAX_TRACKED_SESSIONS) {
          const oldest = this.sessions.keys().next().value;
          if (oldest !== undefined) this.sessions.delete(oldest);
        }
        state = {
          baseline_prompt_tokens: promptTokens,
          max_prompt_tokens: promptTokens,
          request_count: 1,
        };
        this.sessions.set(sessionId, state);
      } else {
        this.sessions.delete(sessionId);
        state.request_count += 1;
        if (
          state.request_count >= 2 &&
          state.baseline_prompt_tokens > 0 &&
          promptTokens >= state.baseline_prompt_tokens * 2 &&
          promptTokens > contextWindowTokens * 0.5
        ) {
          tokenGrowthAboveHalf = true;
        }
        if (promptTokens > state.max_prompt_tokens) {
          state.max_prompt_tokens = promptTokens;
        }
        if (promptTokens < state.baseline_prompt_tokens) {
          state.baseline_prompt_tokens = promptTokens;
        }
        this.sessions.set(sessionId, state);
      }
    }

    const downgradeEligible =
      activeSuccess &&
      tier === "frontier" &&
      ((promptTokens <= 600 && completionTokens <= 400) ||
        isDowngradeableActivity(input.activity));

    const record: AnalyticsRecord = {
      seq,
      timestamp: nowIso,
      route: input.route,
      appcode,
      model: input.model,
      tier,
      backend: input.backend,
      placement: input.placement,
      activity: input.activity,
      session_id: sessionId,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      context_tokens_saved: contextTokensSaved,
      duplicate_context_tokens: duplicateContextTokens,
      estimated_cost_usd: estimatedCostUsd,
      estimated_savings_usd: estimatedSavingsUsd,
      rate_per_1k_usd: ratePer1kUsd,
      blocked,
      error,
      guardrail_event_type: input.guardrailEvent?.type,
      message_count: messageCount,
      context_window_tokens: contextWindowTokens,
      compaction_triggered: compactionTriggered,
      token_growth_above_half: tokenGrowthAboveHalf,
      downgrade_eligible: downgradeEligible,
    };

    this.events.push(record);
    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }

    // Cumulative breakdowns
    accumulateBucket(this.totals, record);
    accumulateBucket(
      this.getOrCreateMapBucket(this.byAppcode, appcode, emptyBucket),
      record,
    );
    accumulateBucket(
      this.getOrCreateMapBucket(this.byModel, input.model, () => ({
        ...emptyBucket(),
        tier,
      })),
      record,
    );
    accumulateBucket(
      this.getOrCreateMapBucket(this.byBackend, input.backend, emptyBucket),
      record,
    );
    accumulateBucket(
      this.getOrCreateMapBucket(this.byPlacement, input.placement, emptyBucket),
      record,
    );
    accumulateBucket(
      this.getOrCreateMapBucket(this.byActivity, input.activity, emptyBucket),
      record,
    );
    accumulateBucket(
      this.getOrCreateMapBucket(
        this.bySession,
        sessionId ?? "anonymous",
        emptyBucket,
      ),
      record,
    );

    if (input.guardrailEvent) {
      this.guardrailCounts.set(
        input.guardrailEvent.type,
        (this.guardrailCounts.get(input.guardrailEvent.type) ?? 0) + 1,
      );
      this.addPromCounter(
        this.promGuardrailEvents,
        {
          type: input.guardrailEvent.type,
          blocked: input.guardrailEvent.blocked ? "true" : "false",
        },
        1,
      );
    }

    // Bounded Prometheus series (strictly NO session_id labels)
    const promAppcode = this.boundLabelValue("appcode", appcode);
    const promModel = this.boundLabelValue("model", input.model);
    const promBackend = this.boundLabelValue("backend", input.backend);
    const promPlacement = this.boundLabelValue("placement", input.placement);
    const promActivity = this.boundLabelValue("activity", input.activity);
    const statusLabel = blocked ? "blocked" : error ? "error" : "ok";

    this.addPromCounter(
      this.promRequests,
      {
        appcode: promAppcode,
        model: promModel,
        backend: promBackend,
        placement: promPlacement,
        activity: promActivity,
        status: statusLabel,
      },
      1,
    );

    if (activeSuccess) {
      if (promptTokens > 0) {
        this.addPromCounter(
          this.promTokens,
          {
            appcode: promAppcode,
            model: promModel,
            backend: promBackend,
            placement: promPlacement,
            token_type: "prompt",
          },
          promptTokens,
        );
      }
      if (completionTokens > 0) {
        this.addPromCounter(
          this.promTokens,
          {
            appcode: promAppcode,
            model: promModel,
            backend: promBackend,
            placement: promPlacement,
            token_type: "completion",
          },
          completionTokens,
        );
      }
      if (contextTokensSaved > 0) {
        this.addPromCounter(
          this.promTokensSaved,
          {
            appcode: promAppcode,
            model: promModel,
            backend: promBackend,
            placement: promPlacement,
          },
          contextTokensSaved,
        );
      }
      if (estimatedCostUsd > 0) {
        this.addPromCounter(
          this.promCostUsd,
          {
            appcode: promAppcode,
            model: promModel,
            backend: promBackend,
            placement: promPlacement,
            tier,
          },
          estimatedCostUsd,
          true,
        );
      }
      if (estimatedSavingsUsd > 0) {
        this.addPromCounter(
          this.promCostSavedUsd,
          {
            appcode: promAppcode,
            model: promModel,
            backend: promBackend,
            placement: promPlacement,
            tier,
          },
          estimatedSavingsUsd,
          true,
        );
      }
      if (duplicateContextTokens > 0) {
        this.addPromCounter(
          this.promDupContextTokens,
          {
            appcode: promAppcode,
            model: promModel,
            backend: promBackend,
          },
          duplicateContextTokens,
        );
      }
      this.observePromptHistogram(
        input.model,
        input.backend,
        input.placement,
        promptTokens,
      );
    }

    return {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      estimated_cost_usd: estimatedCostUsd,
      context_tokens_saved: contextTokensSaved,
      appcode,
    };
  }

  getSnapshot(filters: AnalyticsFilter = {}): TokenAnalyticsSnapshot {
    const cleanFilters: AnalyticsFilter = {};
    if (filters.appcode?.trim()) cleanFilters.appcode = filters.appcode.trim();
    if (filters.model?.trim()) cleanFilters.model = filters.model.trim();
    if (filters.backend?.trim()) cleanFilters.backend = filters.backend.trim();
    if (filters.activity?.trim()) cleanFilters.activity = filters.activity.trim();
    if (filters.session_id?.trim()) {
      cleanFilters.session_id = filters.session_id.trim();
    }

    const hasFilters = Object.keys(cleanFilters).length > 0;
    const suggestions = this.getSuggestions();
    const bySeverity: Record<SuggestionSeverity, number> = {
      high: 0,
      medium: 0,
      low: 0,
    };
    for (const s of suggestions) {
      bySeverity[s.severity] += 1;
    }

    let repeatedCount = 0;
    for (const fp of this.fingerprints.values()) {
      if (fp.count >= 2) repeatedCount += 1;
    }

    if (!hasFilters) {
      return {
        version: "0.2.0",
        generated_at: new Date().toISOString(),
        filters: cleanFilters,
        totals: { ...this.totals },
        by_appcode: Object.fromEntries(
          [...this.byAppcode.entries()].map(([k, v]) => [k, { ...v }]),
        ),
        by_model: Object.fromEntries(
          [...this.byModel.entries()].map(([k, v]) => [k, { ...v }]),
        ),
        by_backend: Object.fromEntries(
          [...this.byBackend.entries()].map(([k, v]) => [k, { ...v }]),
        ),
        by_placement: Object.fromEntries(
          [...this.byPlacement.entries()].map(([k, v]) => [k, { ...v }]),
        ),
        by_activity: Object.fromEntries(
          [...this.byActivity.entries()].map(([k, v]) => [k, { ...v }]),
        ),
        by_session: Object.fromEntries(
          [...this.bySession.entries()].map(([k, v]) => [k, { ...v }]),
        ),
        guardrail_events: Object.fromEntries(this.guardrailCounts.entries()),
        fingerprints: {
          tracked: this.fingerprints.size,
          max_tracked: this.maxTrackedFingerprints,
          repeated_count: repeatedCount,
        },
        suggestions_summary: {
          total: suggestions.length,
          by_severity: bySeverity,
        },
      };
    }

    const matched = this.events.filter((r) => {
      if (cleanFilters.appcode && r.appcode !== cleanFilters.appcode) {
        return false;
      }
      if (cleanFilters.model && r.model !== cleanFilters.model) return false;
      if (cleanFilters.backend && r.backend !== cleanFilters.backend) {
        return false;
      }
      if (cleanFilters.activity && r.activity !== cleanFilters.activity) {
        return false;
      }
      if (
        cleanFilters.session_id &&
        (r.session_id ?? "anonymous") !== cleanFilters.session_id
      ) {
        return false;
      }
      return true;
    });

    const totals = emptyBucket();
    const byAppcode = new Map<string, TokenAggregateBucket>();
    const byModel = new Map<string, TokenAggregateBucket & { tier: ModelTier }>();
    const byBackend = new Map<string, TokenAggregateBucket>();
    const byPlacement = new Map<string, TokenAggregateBucket>();
    const byActivity = new Map<string, TokenAggregateBucket>();
    const bySession = new Map<string, TokenAggregateBucket>();
    const guardrailEvents: Record<string, number> = {};

    for (const r of matched) {
      accumulateBucket(totals, r);
      accumulateBucket(
        this.getOrCreateMapBucket(byAppcode, r.appcode, emptyBucket),
        r,
      );
      accumulateBucket(
        this.getOrCreateMapBucket(byModel, r.model, () => ({
          ...emptyBucket(),
          tier: r.tier,
        })),
        r,
      );
      accumulateBucket(
        this.getOrCreateMapBucket(byBackend, r.backend, emptyBucket),
        r,
      );
      accumulateBucket(
        this.getOrCreateMapBucket(byPlacement, r.placement, emptyBucket),
        r,
      );
      accumulateBucket(
        this.getOrCreateMapBucket(byActivity, r.activity, emptyBucket),
        r,
      );
      accumulateBucket(
        this.getOrCreateMapBucket(
          bySession,
          r.session_id ?? "anonymous",
          emptyBucket,
        ),
        r,
      );
      if (r.guardrail_event_type) {
        guardrailEvents[r.guardrail_event_type] =
          (guardrailEvents[r.guardrail_event_type] ?? 0) + 1;
      }
    }

    return {
      version: "0.2.0",
      generated_at: new Date().toISOString(),
      filters: cleanFilters,
      totals,
      by_appcode: Object.fromEntries(byAppcode.entries()),
      by_model: Object.fromEntries(byModel.entries()),
      by_backend: Object.fromEntries(byBackend.entries()),
      by_placement: Object.fromEntries(byPlacement.entries()),
      by_activity: Object.fromEntries(byActivity.entries()),
      by_session: Object.fromEntries(bySession.entries()),
      guardrail_events: guardrailEvents,
      fingerprints: {
        tracked: this.fingerprints.size,
        max_tracked: this.maxTrackedFingerprints,
        repeated_count: repeatedCount,
      },
      suggestions_summary: {
        total: suggestions.length,
        by_severity: bySeverity,
      },
    };
  }

  getSuggestions(filters: SuggestionFilter = {}): TokenSuggestion[] {
    const suggestions: TokenSuggestion[] = [];
    const fingerprints = [...this.fingerprints.values()];

    // Rule 1: use_context_engine_pack (repeated >1000-char prompt/block >= 2 times)
    const repeatedFingerprints = fingerprints.filter((f) => f.count >= 2);
    if (repeatedFingerprints.length > 0) {
      const appcodes = new Set<string>();
      const models = new Set<string>();
      const sessions = new Set<string>();
      const reqSeqs = new Set<number>();
      let potentialTokens = 0;
      let potentialUsd = 0;
      let maxRepeatCount = 0;

      for (const fp of repeatedFingerprints) {
        for (const a of fp.appcodes) appcodes.add(a);
        for (const m of fp.models) models.add(m);
        for (const s of fp.session_counts.keys()) sessions.add(s);
        for (const seq of fp.request_seqs) reqSeqs.add(seq);
        const tokens =
          fp.duplicate_tokens > 0
            ? fp.duplicate_tokens
            : fp.estimated_tokens * Math.max(1, fp.count - 1);
        potentialTokens += tokens;
        potentialUsd = roundUsd(potentialUsd + fp.duplicate_savings_usd);
        if (fp.count > maxRepeatCount) maxRepeatCount = fp.count;
      }

      const severity: SuggestionSeverity =
        potentialTokens >= 1000 || maxRepeatCount >= 3 ? "high" : "medium";
      suggestions.push({
        id: "sug_use_context_engine_pack",
        code: "use_context_engine_pack",
        severity,
        title: "Replace repeated large prompts with Context Engine packs",
        message: `Detected ${repeatedFingerprints.length} repeated >1000-char payload fingerprint(s) across ${reqSeqs.size} request(s) (max ${maxRepeatCount}x).`,
        recommendation:
          "Call Mirevox Context Engine get_appcode_context_pack and pass x-mirevox-tokens-saved instead of re-sending raw >1000-char context.",
        affected_requests: reqSeqs.size,
        potential_tokens_saved: Math.max(1, potentialTokens),
        potential_cost_savings_usd: potentialUsd,
        appcodes: [...appcodes],
        models: [...models],
        affected_sessions: sessions.size,
        details: {
          repeated_fingerprints: repeatedFingerprints.length,
          max_repeat_count: maxRepeatCount,
        },
      });
    }

    // Rule 2: deduplicate_repo_dump (repeated >1000-char block in same session or matching code/tree markers)
    const repoDumpFingerprints = repeatedFingerprints.filter(
      (f) =>
        f.max_same_session_count >= 2 ||
        f.intra_request_repeats > 0 ||
        f.has_code_markers,
    );
    if (repoDumpFingerprints.length > 0) {
      const appcodes = new Set<string>();
      const models = new Set<string>();
      const sessions = new Set<string>();
      const reqSeqs = new Set<number>();
      let potentialTokens = 0;
      let potentialUsd = 0;
      let sameSessionMax = 0;
      let codeMarkerCount = 0;

      for (const fp of repoDumpFingerprints) {
        for (const a of fp.appcodes) appcodes.add(a);
        for (const m of fp.models) models.add(m);
        for (const s of fp.session_counts.keys()) sessions.add(s);
        for (const seq of fp.request_seqs) reqSeqs.add(seq);
        if (fp.has_code_markers) codeMarkerCount += 1;
        if (fp.max_same_session_count > sameSessionMax) {
          sameSessionMax = fp.max_same_session_count;
        }
        const tokens =
          fp.duplicate_tokens > 0
            ? fp.duplicate_tokens
            : fp.estimated_tokens * Math.max(1, fp.count - 1);
        potentialTokens += tokens;
        potentialUsd = roundUsd(potentialUsd + fp.duplicate_savings_usd);
      }

      const severity: SuggestionSeverity =
        sameSessionMax >= 2 || potentialTokens >= 1000 ? "high" : "medium";
      suggestions.push({
        id: "sug_deduplicate_repo_dump",
        code: "deduplicate_repo_dump",
        severity,
        title: "Deduplicate repeated repository / code context dumps",
        message: `Detected ${repoDumpFingerprints.length} repeated >1000-char block(s) within the same session or containing code/tree markers.`,
        recommendation:
          "Strip unchanged file trees and code excerpts between turns or reference indexed Context Engine file summaries.",
        affected_requests: reqSeqs.size,
        potential_tokens_saved: Math.max(1, potentialTokens),
        potential_cost_savings_usd: potentialUsd,
        appcodes: [...appcodes],
        models: [...models],
        affected_sessions: sessions.size,
        details: {
          matching_fingerprints: repoDumpFingerprints.length,
          same_session_max_repeats: sameSessionMax,
          code_marker_matches: codeMarkerCount,
        },
      });
    }

    // Rule 3: downgrade_model_tier (frontier model for short <=600 prompt & <=400 completion or tool/code/summarize)
    const downgradeEvents = this.events.filter((e) => e.downgrade_eligible);
    if (downgradeEvents.length > 0) {
      const appcodes = new Set<string>();
      const models = new Set<string>();
      const sessions = new Set<string>();
      const activities = new Set<string>();
      let totalEligibleTokens = 0;
      let potentialUsd = 0;
      const economyBaseRate =
        this.config.analytics?.tier_cost_per_1k_usd?.economy ??
        DEFAULT_TIER_COST_PER_1K_USD.economy;

      for (const e of downgradeEvents) {
        appcodes.add(e.appcode);
        models.add(e.model);
        activities.add(e.activity);
        if (e.session_id) sessions.add(e.session_id);
        totalEligibleTokens += e.total_tokens;
        const targetRate = Math.min(e.rate_per_1k_usd, economyBaseRate);
        const deltaRate = Math.max(0, e.rate_per_1k_usd - targetRate);
        potentialUsd = roundUsd(
          potentialUsd + (e.total_tokens / 1000) * deltaRate,
        );
      }

      const potentialTokens = Math.max(1, Math.round(totalEligibleTokens * 0.25));
      const severity: SuggestionSeverity =
        downgradeEvents.length >= 3 || potentialUsd >= 0.05
          ? "high"
          : downgradeEvents.length >= 2 || totalEligibleTokens >= 200
            ? "medium"
            : "low";

      suggestions.push({
        id: "sug_downgrade_model_tier",
        code: "downgrade_model_tier",
        severity,
        title: "Route short or structured tasks to economy/local models",
        message: `${downgradeEvents.length} frontier model call(s) used short payloads (<=600 prompt & <=400 completion) or tool/code/summarize activities.`,
        recommendation:
          "Route short or tool/code/summarize workloads to economy or local models (e.g. gpt-4o-mini, vertex/gemini-2.0-flash, or local/qwen2.5-coder).",
        affected_requests: downgradeEvents.length,
        potential_tokens_saved: potentialTokens,
        potential_cost_savings_usd: potentialUsd,
        appcodes: [...appcodes],
        models: [...models],
        affected_sessions: sessions.size,
        details: {
          activities: [...activities],
          eligible_total_tokens: totalEligibleTokens,
        },
      });
    }

    // Rule 4: compact_session_history (contextAlert.compaction_triggered or >=10 messages or token growth >=2x above 50% window)
    const compactionEvents = this.events.filter(
      (e) =>
        e.compaction_triggered ||
        e.message_count >= 10 ||
        e.token_growth_above_half,
    );
    if (compactionEvents.length > 0) {
      const appcodes = new Set<string>();
      const models = new Set<string>();
      const sessions = new Set<string>();
      let sumPromptTokens = 0;
      let potentialUsd = 0;
      let alertsCount = 0;
      let longHistoryCount = 0;
      let growthCount = 0;

      for (const e of compactionEvents) {
        appcodes.add(e.appcode);
        models.add(e.model);
        if (e.session_id) sessions.add(e.session_id);
        const promptForSaving =
          e.prompt_tokens > 0
            ? e.prompt_tokens
            : Math.round(e.context_window_tokens * 0.5);
        sumPromptTokens += promptForSaving;
        potentialUsd = roundUsd(
          potentialUsd + ((promptForSaving * 0.5) / 1000) * e.rate_per_1k_usd,
        );
        if (e.compaction_triggered) alertsCount += 1;
        if (e.message_count >= 10) longHistoryCount += 1;
        if (e.token_growth_above_half) growthCount += 1;
      }

      const severity: SuggestionSeverity =
        alertsCount > 0 ? "high" : "medium";
      suggestions.push({
        id: "sug_compact_session_history",
        code: "compact_session_history",
        severity,
        title: "Compact growing multi-turn session history",
        message: `${compactionEvents.length} request(s) exhibited context exhaustion warnings (${alertsCount}), >=10-message histories (${longHistoryCount}), or >=2x token growth above 50% window (${growthCount}).`,
        recommendation:
          "Summarize older assistant/tool turns and prune stale messages before hitting the 80% context window threshold.",
        affected_requests: compactionEvents.length,
        potential_tokens_saved: Math.max(1, Math.round(sumPromptTokens * 0.5)),
        potential_cost_savings_usd: potentialUsd,
        appcodes: [...appcodes],
        models: [...models],
        affected_sessions: sessions.size,
        details: {
          compaction_alerts: alertsCount,
          long_message_histories: longHistoryCount,
          growth_spikes: growthCount,
        },
      });
    }

    suggestions.sort((a, b) => {
      const sevDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
      if (sevDiff !== 0) return sevDiff;
      const tokDiff = b.potential_tokens_saved - a.potential_tokens_saved;
      if (tokDiff !== 0) return tokDiff;
      return b.affected_requests - a.affected_requests;
    });

    const codeFilter = filters.code?.trim().toLowerCase();
    const sevFilter = filters.severity?.trim().toLowerCase();
    let filtered = suggestions.filter((s) => {
      if (codeFilter && s.code !== codeFilter) return false;
      if (sevFilter && s.severity !== sevFilter) return false;
      return true;
    });

    if (
      filters.limit !== undefined &&
      Number.isFinite(filters.limit) &&
      filters.limit > 0
    ) {
      filtered = filtered.slice(0, Math.floor(filters.limit));
    }

    return filtered;
  }

  renderPrometheus(): string {
    const lines: string[] = [];

    const emitMetricBlock = (
      name: string,
      help: string,
      type: "counter" | "gauge",
      entries: Iterable<{ labels: Record<string, string>; value: number }>,
    ): void => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} ${type}`);
      for (const entry of entries) {
        lines.push(
          `${name}${formatPromLabels(entry.labels)} ${formatMetricNumber(entry.value)}`,
        );
      }
    };

    emitMetricBlock(
      "mirevox_router_tokens_total",
      "Total LLM tokens processed by Mirevox Smart Router.",
      "counter",
      this.promTokens.values(),
    );

    emitMetricBlock(
      "mirevox_router_tokens_saved_total",
      "Context tokens saved via Context Engine packs and deduplication.",
      "counter",
      this.promTokensSaved.values(),
    );

    emitMetricBlock(
      "mirevox_router_cost_usd_total",
      "Estimated cumulative LLM spend in USD.",
      "counter",
      this.promCostUsd.values(),
    );

    emitMetricBlock(
      "mirevox_router_cost_saved_usd_total",
      "Estimated cumulative LLM cost saved in USD.",
      "counter",
      this.promCostSavedUsd.values(),
    );

    emitMetricBlock(
      "mirevox_router_duplicate_context_tokens_total",
      "Repeated context tokens detected across >1000-char prompts or message blocks.",
      "counter",
      this.promDupContextTokens.values(),
    );

    const activeSuggestions = this.getSuggestions();

    emitMetricBlock(
      "mirevox_router_optimization_potential_tokens",
      "Estimated token reduction potential from active optimization suggestions.",
      "gauge",
      activeSuggestions.map((s) => ({
        labels: { code: s.code, severity: s.severity },
        value: s.potential_tokens_saved,
      })),
    );

    emitMetricBlock(
      "mirevox_smart_router_requests_total",
      "Total requests handled by Mirevox Smart Router.",
      "counter",
      this.promRequests.values(),
    );

    lines.push(
      "# HELP mirevox_smart_router_prompt_tokens Distribution of prompt token counts per request.",
    );
    lines.push("# TYPE mirevox_smart_router_prompt_tokens histogram");
    for (const series of this.promPromptHistograms.values()) {
      const baseLabels = {
        model: series.model,
        backend: series.backend,
        placement: series.placement,
      };
      for (let i = 0; i < PROMPT_TOKEN_BUCKETS.length; i += 1) {
        const le = String(PROMPT_TOKEN_BUCKETS[i]!);
        lines.push(
          `mirevox_smart_router_prompt_tokens_bucket${formatPromLabels({ ...baseLabels, le })} ${series.buckets[i] ?? 0}`,
        );
      }
      lines.push(
        `mirevox_smart_router_prompt_tokens_bucket${formatPromLabels({ ...baseLabels, le: "+Inf" })} ${series.count}`,
      );
      lines.push(
        `mirevox_smart_router_prompt_tokens_sum${formatPromLabels(baseLabels)} ${series.sum}`,
      );
      lines.push(
        `mirevox_smart_router_prompt_tokens_count${formatPromLabels(baseLabels)} ${series.count}`,
      );
    }

    emitMetricBlock(
      "mirevox_smart_router_guardrail_events_total",
      "Total guardrail events triggered by Mirevox Smart Router.",
      "counter",
      this.promGuardrailEvents.values(),
    );

    emitMetricBlock(
      "mirevox_smart_router_active_suggestions",
      "Number of active token optimization suggestions by rule code and severity.",
      "gauge",
      activeSuggestions.map((s) => ({
        labels: { code: s.code, severity: s.severity },
        value: 1,
      })),
    );

    return `${lines.join("\n")}\n`;
  }
}
