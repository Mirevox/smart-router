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

  it("preserves input order when ids are not sorted", async () => {
    const ids = ["z", "a", "m"];
    const res = await fanoutTasks(config, policy, {
      timeout_ms: 500,
      tasks: [
        {
          id: "z",
          model: "foundry/gpt-4o",
          messages: [{ role: "user", content: "payload-z" }],
        },
        {
          id: "a",
          model: "local/llama3.2",
          activity: "code",
          messages: [{ role: "user", content: "payload-a" }],
        },
        {
          id: "m",
          model: "bedrock/amazon.nova-pro",
          messages: [{ role: "user", content: "payload-m" }],
        },
      ],
    });

    assert.deepEqual(
      res.results.map((r) => r.id),
      ids,
    );
    assert.deepEqual(
      res.results.map((r) => r.decision?.backend),
      ["azure-foundry", "local-ollama", "aws-bedrock"],
    );
    assert.match(res.results[0]?.result?.choices[0]?.message.content ?? "", /payload-z/);
    assert.match(res.results[1]?.result?.choices[0]?.message.content ?? "", /payload-a/);
    assert.match(res.results[2]?.result?.choices[0]?.message.content ?? "", /payload-m/);
    assert.equal(res.parallel, 3);
  });

  it("reports the configured parallelism cap", async () => {
    const limited = {
      ...config,
      fanout: { ...config.fanout, max_parallel: 2 },
    };
    const res = await fanoutTasks(limited, policy, {
      timeout_ms: 500,
      tasks: ["c", "a", "b", "d"].map((id) => ({
        id,
        messages: [{ role: "user" as const, content: id }],
      })),
    });
    assert.equal(res.parallel, 2);
    assert.deepEqual(
      res.results.map((r) => r.id),
      ["c", "a", "b", "d"],
    );
    assert.ok(res.results.every((r) => r.ok));
  });

  it("treats a non-positive parallelism cap as one worker", async () => {
    const limited = {
      ...config,
      fanout: { ...config.fanout, max_parallel: 0 },
    };
    const res = await fanoutTasks(limited, policy, {
      timeout_ms: 500,
      tasks: [
        { id: "b", messages: [{ role: "user", content: "b" }] },
        { id: "a", messages: [{ role: "user", content: "a" }] },
      ],
    });
    assert.equal(res.parallel, 1);
    assert.deepEqual(
      res.results.map((r) => r.id),
      ["b", "a"],
    );
  });

  it("keeps input order when tasks time out", async () => {
    const res = await fanoutTasks(config, policy, {
      timeout_ms: 0,
      tasks: [
        {
          id: "later",
          messages: [{ role: "user", content: "x" }],
        },
        {
          id: "sooner",
          model: "local/llama3.2",
          activity: "code",
          messages: [{ role: "user", content: "y" }],
        },
      ],
    });
    assert.deepEqual(
      res.results.map((r) => r.id),
      ["later", "sooner"],
    );
    assert.ok(res.results.every((r) => r.ok === false));
    assert.ok(res.results.every((r) => r.error === "task timeout"));
    assert.equal(res.results[0]?.decision?.backend, "mock-openai");
    assert.equal(res.results[1]?.decision?.backend, "local-ollama");
  });

  it("overlaps task time when several workers run", async () => {
    const tasks = ["t0", "t1", "t2", "t3", "t4", "t5"].map((id) => ({
      id,
      messages: [{ role: "user" as const, content: id }],
    }));
    const started = Date.now();
    const res = await fanoutTasks(
      { ...config, fanout: { ...config.fanout, max_parallel: 6 } },
      policy,
      { timeout_ms: 500, tasks },
    );
    const wall = Date.now() - started;
    const sum = res.results.reduce((total, r) => total + r.duration_ms, 0);
    assert.equal(res.parallel, 6);
    assert.deepEqual(
      res.results.map((r) => r.id),
      tasks.map((t) => t.id),
    );
    assert.ok(res.results.every((r) => r.ok));
    assert.ok(wall < sum, `wall ${wall}ms should be below summed task time ${sum}ms`);
  });
});
