import assert from "node:assert/strict";
import test from "node:test";
import { ContinuationController, extractContinuationMarker } from "../src/continuation.js";

const idleContext = {
  isIdle: () => true,
  hasPendingMessages: () => false,
};

test("continuation dispatch is single-flight and claimable", () => {
  const controller = new ContinuationController();
  const sent: string[] = [];
  assert.equal(controller.request(), true);
  assert.equal(controller.request(), false);
  assert.equal(
    controller.dispatch({ sendUserMessage: (prompt: string) => void sent.push(prompt) }, idleContext),
    true,
  );
  assert.equal(sent.length, 1);
  assert.ok(extractContinuationMarker(sent[0] ?? ""));
  assert.equal(controller.claimPrompt(sent[0] ?? ""), true);
  assert.equal(controller.hasWork(), false);
});

test("pending messages prevent dispatch", () => {
  const controller = new ContinuationController();
  controller.request();
  const dispatched = controller.dispatch(
    { sendUserMessage: () => assert.fail("must not send") },
    { isIdle: () => true, hasPendingMessages: () => true },
  );
  assert.equal(dispatched, false);
  assert.equal(controller.hasWork(), true);
});

test("cancelled delivered prompt can be intercepted", () => {
  const controller = new ContinuationController();
  let prompt = "";
  controller.request();
  controller.dispatch(
    { sendUserMessage: (value: string) => void (prompt = value) },
    idleContext,
  );
  controller.cancel();
  assert.equal(controller.consumeCancelledPrompt(prompt), true);
  assert.equal(controller.consumeCancelledPrompt(prompt), false);
});
