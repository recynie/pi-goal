import assert from "node:assert/strict";
import test from "node:test";
import { VERIFIER_TOOL_NAMES } from "../src/verifier.js";

test("fresh verifier exposes only read, bash, and its result tool", () => {
  assert.deepEqual(VERIFIER_TOOL_NAMES, [
    "read",
    "bash",
    "goal_verification_result",
  ]);
  assert.equal(
    VERIFIER_TOOL_NAMES.some((name) =>
      ["edit", "write", "grep", "find", "ls"].includes(name),
    ),
    false,
  );
});
