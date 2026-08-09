import assert from "node:assert/strict";
import test from "node:test";
import {
  fingerprintAssistantOutput,
  nextAutomaticProgress,
  normalizeVisibleText,
} from "../src/safety.js";

const assistant = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

test("visible output normalization ignores punctuation and case", () => {
  assert.equal(normalizeVisibleText("  Hello, WORLD!!! "), "hello world");
});

test("repeated tool-free output increments the no-progress counter", () => {
  const first = nextAutomaticProgress(undefined, 0, [assistant("Still checking")], false);
  const second = nextAutomaticProgress(first.fingerprint, first.noProgressTurns, [assistant("still checking!")], false);
  assert.equal(first.noProgressTurns, 1);
  assert.equal(second.noProgressTurns, 2);
  assert.equal(second.fingerprint, first.fingerprint);
});

test("tool activity resets no-progress tracking", () => {
  const progress = nextAutomaticProgress("a".repeat(64), 2, [assistant("same")], true);
  assert.deepEqual(progress, { noProgressTurns: 0 });
});

test("fingerprint excludes thinking and tool calls", () => {
  const fingerprint = fingerprintAssistantOutput([
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "secret" },
        { type: "toolCall", name: "bash" },
        { type: "text", text: "Result" },
      ],
    },
  ]);
  assert.equal(fingerprint?.length, 64);
});
