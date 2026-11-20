import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { RoutingPolicy } from "../src/router/policy.js";
import { fanoutTasks } from "../src/fanout/splitter.js";

describe("fanoutTasks", () => {
  const config = loadConfig("./config/default.yaml");
  const policy = new RoutingPolicy(config);

  it("runs tasks in parallel across backends", async () => {
    const res = await fanoutTasks(config, policy, {
      tasks: [
        {
          id: "a",
          model: "gpt-4o-mini",
          activity: "chat",
          messages: [{ role: "user", content: "alpha" }],
        },
        {
          id: "b",
          model: "local/llama3.2",
          activity: "code",
          messages: [{ role: "user", content: "beta" }],
        },
        {
          id: "c",
          model: "bedrock/amazon.nova-pro",
          messages: [{ role: "user", content: "gamma" }],
        },
      ],
    });

    assert.equal(res.object, "mirevox.fanout_result");
    assert.equal(res.results.length, 3);
    assert.ok(res.parallel >= 2);
    assert.ok(res.results.every((r) => r.ok));
    assert.equal(res.results[0]?.id, "a");
    assert.equal(res.results[1]?.decision?.backend, "local-ollama");
    assert.equal(res.results[2]?.decision?.backend, "aws-bedrock");
  });
});
