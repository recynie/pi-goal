import assert from "node:assert/strict";
import test from "node:test";
import { completeGoalArguments, parseGoalCommand } from "../src/commands.js";

test("bare goal opens the control panel", () => {
  assert.deepEqual(parseGoalCommand("  "), { kind: "panel" });
});

test("lifecycle subcommands are exact and other text is a main goal", () => {
  assert.deepEqual(parseGoalCommand("edit"), { kind: "edit" });
  assert.deepEqual(parseGoalCommand("cancel"), { kind: "cancel" });
  assert.deepEqual(parseGoalCommand("edit the docs"), {
    kind: "start",
    mainGoal: "edit the docs",
  });
});

test("command completion includes slash-only cancel", () => {
  assert.deepEqual(completeGoalArguments("ca"), [{ value: "cancel", label: "cancel" }]);
});
