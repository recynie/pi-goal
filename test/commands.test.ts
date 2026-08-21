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

test("propose parses its remaining text as an immediately approved main goal", () => {
  assert.deepEqual(parseGoalCommand("propose ship the docs"), {
    kind: "propose",
    mainGoal: "ship the docs",
  });
  assert.deepEqual(parseGoalCommand("propose"), { kind: "propose", mainGoal: "" });
});

test("command completion includes descriptions for propose and slash-only cancel", () => {
  assert.deepEqual(completeGoalArguments("pr"), [
    {
      value: "propose",
      label: "propose",
      description: "Approve a main goal and start execution immediately",
    },
  ]);
  assert.deepEqual(completeGoalArguments("ca"), [
    { value: "cancel", label: "cancel", description: "Cancel the current Goal" },
  ]);
  for (const completion of completeGoalArguments("") ?? []) {
    assert.ok(completion.description, `${completion.value} should have a description`);
  }
});
