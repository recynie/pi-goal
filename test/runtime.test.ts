import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GoalRuntime } from "../src/runtime.js";

function harness() {
  const entries: unknown[] = [];
  const statuses: Array<string | undefined> = [];
  let widgetCalls = 0;
  let idle = true;
  const pi = {
    appendEntry: (_type: string, data: unknown) => void entries.push(structuredClone(data)),
  } as unknown as ExtensionAPI;
  const ctx = {
    isIdle: () => idle,
    hasPendingMessages: () => false,
    ui: {
      setStatus: (_key: string, value: string | undefined) => void statuses.push(value),
      setWidget: () => void (widgetCalls += 1),
      notify: () => {},
    },
  } as unknown as ExtensionContext;
  return {
    runtime: new GoalRuntime(pi),
    ctx,
    entries,
    statuses,
    widgetCalls: () => widgetCalls,
    setIdle: (value: boolean) => void (idle = value),
  };
}

function activeRuntime() {
  const value = harness();
  value.runtime.createGoal("Ship", value.ctx);
  value.runtime.setDraft(
    { mainGoal: "Ship", subtasks: ["Tests pass."], details: [] },
    value.ctx,
  );
  value.runtime.startApprovedGoal(value.ctx);
  return value;
}

const assistant = (stopReason = "stop", text = "working") => ({
  role: "assistant",
  stopReason,
  content: [{ type: "text", text }],
});

test("runtime uses the statusline without setting an above-editor widget", () => {
  const { statuses, widgetCalls } = activeRuntime();
  assert.equal(widgetCalls(), 0);
  assert.equal(statuses.at(-1), "Goal active");
});

test("a busy edit stays pending until main settlement and beats submission", () => {
  const { runtime, ctx, setIdle } = activeRuntime();
  setIdle(false);
  runtime.beginMainRun("active", false);
  runtime.submit("Final result");
  assert.deepEqual(runtime.requestUserAction("edit", ctx), []);
  assert.equal(runtime.state?.status, "active");
  runtime.finishMainRun([assistant("toolUse")]);
  setIdle(true);
  const effects = runtime.settleMain(ctx);
  assert.equal(runtime.state?.status, "refining");
  assert.equal(runtime.state?.verificationAttempts, 0);
  assert.deepEqual(effects, [{ kind: "open-panel" }]);
});

test("agent_end records continuation intent but only settled dispatches it", () => {
  const { runtime, ctx } = activeRuntime();
  runtime.beginMainRun("active", false);
  runtime.finishMainRun([assistant("stop")]);
  assert.equal(runtime.continuation.hasWork(), true);
  assert.deepEqual(runtime.settleMain(ctx), [{ kind: "dispatch-continuation" }]);
});

test("submission becomes verifying only at main settled boundary", () => {
  const { runtime, ctx } = activeRuntime();
  runtime.beginMainRun("active", false);
  runtime.submit("All checks pass.");
  assert.equal(runtime.state?.status, "active");
  runtime.finishMainRun([assistant("toolUse")]);
  const effects = runtime.settleMain(ctx);
  assert.equal(runtime.state?.status, "verifying");
  assert.equal(runtime.state?.submissionResult, "All checks pass.");
  assert.deepEqual(effects[0], {
    kind: "start-verifier",
    attempt: 1,
    spec: runtime.state?.approved,
    result: "All checks pass.",
  });
});

test("verifier failure returns to active and emits feedback effect", () => {
  const { runtime, ctx } = activeRuntime();
  runtime.beginMainRun("active", false);
  runtime.submit("Final result");
  runtime.finishMainRun([assistant("toolUse")]);
  runtime.settleMain(ctx);
  const effects = runtime.settleVerifier(
    { kind: "result", result: "fail", details: "Acceptance test fails." },
    ctx,
  );
  assert.equal(runtime.state?.status, "active");
  assert.deepEqual(effects, [
    { kind: "send-verification-feedback", details: "Acceptance test fails." },
  ]);
});

test("agent pause intent commits only at settlement", () => {
  const { runtime, ctx } = activeRuntime();
  runtime.beginMainRun("active", false);
  runtime.pauseFromAgent("A user credential is required.");
  assert.equal(runtime.state?.status, "active");
  runtime.finishMainRun([assistant("toolUse")]);
  runtime.settleMain(ctx);
  assert.equal(runtime.state?.status, "paused");
  assert.deepEqual(runtime.state?.pause, {
    source: "agent",
    reason: "A user credential is required.",
  });
});

test("three identical tool-free automatic runs trigger a Pi pause", () => {
  const { runtime, ctx } = activeRuntime();
  for (let index = 0; index < 3; index += 1) {
    runtime.beginMainRun("active", true);
    runtime.finishMainRun([assistant("stop", "Still checking")]);
    runtime.settleMain(ctx);
    if (index < 2) runtime.continuation.cancel();
  }
  assert.equal(runtime.state?.status, "paused");
  assert.equal(runtime.state?.pause?.source, "pi");
  assert.match(runtime.state?.pause?.reason ?? "", /No progress/);
});

test("pending verifier pause wins over pass", () => {
  const { runtime, ctx, setIdle } = activeRuntime();
  runtime.beginMainRun("active", false);
  runtime.submit("Final result");
  runtime.finishMainRun([assistant("toolUse")]);
  runtime.settleMain(ctx);
  setIdle(false);
  runtime.requestUserAction("pause", ctx);
  const effects = runtime.settleVerifier(
    { kind: "result", result: "pass", details: "Everything passes." },
    ctx,
  );
  assert.deepEqual(effects, []);
  assert.equal(runtime.state?.status, "paused");
  assert.equal(runtime.state?.lastVerification, undefined);
});
