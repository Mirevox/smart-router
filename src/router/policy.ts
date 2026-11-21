import type {
  AppConfig,
  Placement,
  RouteDecision,
} from "../types.js";

function matchPattern(pattern: string, model: string): boolean {
  if (pattern.endsWith("*")) {
    return model.startsWith(pattern.slice(0, -1));
  }
  return pattern === model;
}

export class RoutingPolicy {
  constructor(private readonly config: AppConfig) {}

  resolvePlacement(
    activity: string,
    override?: Placement,
  ): Placement {
    if (override) return override;
    return (
      this.config.routing.activities[activity] ??
      this.config.routing.default_placement
    );
  }

  resolveBackend(model: string, override?: string): string {
    if (override) return override;
    for (const [pattern, backend] of Object.entries(
      this.config.routing.model_routes,
    )) {
      if (matchPattern(pattern, model)) return backend;
    }
    return this.config.routing.fallback_backend;
  }

  decide(input: {
    model: string;
    activity?: string;
    placement?: Placement;
    backend?: string;
  }): RouteDecision {
    const activity = input.activity ?? "chat";
    const placement = this.resolvePlacement(activity, input.placement);
    const backend = this.resolveBackend(input.model, input.backend);

    // Placement filter: if activity says onprem, prefer local backends when model is ambiguous
    let finalBackend = backend;
    if (placement === "onprem" && !input.backend) {
      const local = this.config.registry.providers.find(
        (p) => p.kind === "local" && p.enabled,
      );
      if (local && (input.model.startsWith("local/") || backend === this.config.routing.fallback_backend)) {
        if (input.model.startsWith("local/") || !input.model.includes("/")) {
          // keep explicit model routes; only nudge fallback chat toward local when activity=onprem
          if (backend === this.config.routing.fallback_backend && activity === "code") {
            finalBackend = local.id;
          }
        }
      }
    }

    const provider = this.config.registry.providers.find(
      (p) => p.id === finalBackend,
    );
    const isLive = Boolean(provider?.live && provider?.endpoint);

    return {
      model: input.model,
      backend: finalBackend,
      placement,
      activity,
      stub: !isLive,
    };
  }

  isPlacementViolation(decision: RouteDecision): {
    violated: boolean;
    reason?: string;
  } {
    if (!this.config.routing.enforce_placement || decision.placement !== "onprem") {
      return { violated: false };
    }
    const provider = this.config.registry.providers.find(
      (p) => p.id === decision.backend,
    );
    if (provider && provider.kind !== "local" && provider.kind !== "mcp") {
      return {
        violated: true,
        reason: `Placement policy requires onprem for activity '${decision.activity}', but backend '${decision.backend}' is '${provider.kind}'`,
      };
    }
    return { violated: false };
  }
}
