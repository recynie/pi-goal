import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerGoalLifecycle } from "../src/lifecycle.js";
import type { GoalCommandController } from "../src/commands.js";
import type { GoalRuntime, RuntimeEffect, VerifierOutcome } from "../src/runtime.js";
import type { GoalVerifier } from "../src/verifier.js";
import type { VerificationUi } from "../src/verification-ui.js";

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
