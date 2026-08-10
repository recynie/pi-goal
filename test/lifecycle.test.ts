import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerGoalLifecycle } from "../src/lifecycle.js";
import type { GoalCommandController } from "../src/commands.js";
import type { GoalRuntime, RuntimeEffect, VerifierOutcome } from "../src/runtime.js";
import type { GoalVerifier } from "../src/verifier.js";
import type { VerificationUi } from "../src/verification-ui.js";

test("tree navigation aborts transient verification and restores the selected branch", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const pi = {
    on: (name: string, handler: (...args: any[]) => unknown) => void handlers.set(name, handler),
  } as unknown as ExtensionAPI;
  const calls: string[] = [];
  const runtime = {
    disposed: false,
    restoreTreeBranch: () => {
      calls.push("restore-state");
      return [{ kind: "interrupt-verification-display", details: "Tree navigation." }];
    },
    updateUi: () => void calls.push("update-ui"),
  } as unknown as GoalRuntime;
  const verifier = {
    shutdown: () => void calls.push("shutdown-verifier"),
  } as unknown as GoalVerifier;
  const branch = [{ type: "custom", customType: "goal-state-v1", data: null }];
  const verificationUi = {
    restore: (entries: unknown) => {
      assert.equal(entries, branch);
      calls.push("restore-display");
    },
    interruptRunning: (details: string) => {
      assert.equal(details, "Tree navigation.");
      calls.push("interrupt-display");
    },
  } as unknown as VerificationUi;
  registerGoalLifecycle(
    pi,
    runtime,
    verifier,
    verificationUi,
    () => ({}) as GoalCommandController,
  );
  const handler = handlers.get("session_tree");
  assert.ok(handler);
  const ctx = {
    sessionManager: { getBranch: () => branch },
  } as unknown as ExtensionContext;

  await handler({}, ctx);

  assert.deepEqual(calls, [
    "shutdown-verifier",
    "restore-display",
    "restore-state",
    "interrupt-display",
    "update-ui",
  ]);
});

test("verification keeps the owning lifecycle dispatch running until the verifier settles", async () => {
  const pi = { on: () => {} } as unknown as ExtensionAPI;
  let releaseVerifier: (() => Promise<void>) | undefined;
  const verifier = {
    verify: async (
      _spec: unknown,
      _result: string,
      _ctx: ExtensionContext,
      _onInteraction: (items: readonly unknown[]) => void,
      onSettled: (outcome: VerifierOutcome) => Promise<void>,
    ) => new Promise<void>((resolve) => {
      releaseVerifier = async () => {
        await onSettled({ kind: "result", result: "pass", details: "Verified." });
        resolve();
      };
    }),
  } as unknown as GoalVerifier;
  const runtime = {
    disposed: false,
    settleVerifier: () => [] as RuntimeEffect[],
  } as unknown as GoalRuntime;
  const verificationUi = {
    start: () => "operation-1",
    addInteractions: () => {},
    finish: () => {},
  } as unknown as VerificationUi;
  const dispatch = registerGoalLifecycle(
    pi,
    runtime,
    verifier,
    verificationUi,
    () => ({}) as GoalCommandController,
  );
  const ctx = {} as ExtensionContext;

  let dispatchSettled = false;
  const dispatchPromise = dispatch(
    [{
      kind: "start-verifier",
      attempt: 1,
      spec: { mainGoal: "Ship", subtasks: ["Tests pass."], details: [] },
      result: "Ready.",
    }],
    ctx,
  ).then(() => void (dispatchSettled = true));

  await Promise.resolve();
  assert.equal(dispatchSettled, false);
  assert.ok(releaseVerifier);
  await releaseVerifier();
  await dispatchPromise;
  assert.equal(dispatchSettled, true);
});
