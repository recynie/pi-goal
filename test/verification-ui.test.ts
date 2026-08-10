import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  VERIFICATION_UI_ENTRY_TYPE,
  VerificationUi,
  verificationInteractionsFromMessage,
} from "../src/verification-ui.js";

interface CapturedEntry {
  customType: string;
  data: unknown;
}

interface ThemeStub {
  fg: (color: string, text: string) => string;
  bg: (color: string, text: string) => string;
  bold: (text: string) => string;
}

test("verifier messages become readable request, reasoning, tool, and result interactions", () => {
  assert.deepEqual(
    verificationInteractionsFromMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Inspect the tests." },
        { type: "toolCall", name: "bash", arguments: { command: "npm test" } },
      ],
    }),
    [
      { kind: "thinking", label: "Verifier thinking", text: "Inspect the tests." },
      { kind: "tool-call", label: "bash", text: '{\n  "command": "npm test"\n}' },
    ],
  );
  assert.deepEqual(
    verificationInteractionsFromMessage({
      role: "toolResult",
      toolName: "bash",
      content: [{ type: "text", text: "42 tests passed" }],
      isError: false,
    }),
    [{ kind: "tool-result", label: "bash result", text: "42 tests passed" }],
  );
});

test("verification entry rerenders from verifying to pass with expandable transcript and details", () => {
  const appended: CapturedEntry[] = [];
  let renderer:
    | ((
        entry: { data: unknown },
        options: { expanded: boolean },
        theme: ThemeStub,
      ) => { render: (width: number) => string[] })
    | undefined;
  const pi = {
    registerEntryRenderer: (_type: string, value: typeof renderer) => void (renderer = value),
    appendEntry: (customType: string, data: unknown) => void appended.push({ customType, data }),
  } as unknown as ExtensionAPI;
  const ui = new VerificationUi(pi);

  const operationId = ui.start(1);
  assert.ok(renderer);
  const anchor = renderer({ data: appended[0]?.data }, { expanded: false }, theme);
  const expandedAnchor = renderer({ data: appended[0]?.data }, { expanded: true }, theme);
  ui.addInteractions(operationId, [
    { kind: "tool-call", label: "bash", text: '{ "command": "npm test" }' },
    { kind: "tool-result", label: "bash result", text: "42 tests passed" },
  ]);
  assert.equal(appended.every((entry) => entry.customType === VERIFICATION_UI_ENTRY_TYPE), true);

  const running = anchor.render(120).join("\n");
  assert.match(running, /Verifying/);
  assert.doesNotMatch(running, /Verifier/);
  assert.match(running, /bash result/);
  assert.match(running, /42 tests passed/);
  assert.doesNotMatch(running, /npm test/);

  const runningExpanded = expandedAnchor.render(120).join("\n");
  assert.match(runningExpanded, /npm test/);
  assert.match(runningExpanded, /42 tests passed/);

  assert.equal(appended.length, 1, "live interactions should rerender without transcript entries");

  ui.finish(operationId, "pass", "All approved standards are satisfied.");
  const finalDelta = appended[1];
  assert.ok(finalDelta);
  assert.equal(
    renderer({ data: finalDelta.data }, { expanded: true }, theme).render(120).join(""),
    "",
  );
  const completed = anchor.render(120).join("\n");
  assert.match(completed, /Verification pass/);
  assert.doesNotMatch(completed, /\bPASS\b/);
  assert.match(completed, /All approved standards are satisfied/);
  assert.doesNotMatch(completed, /npm test|42 tests passed/);

  const completedExpanded = expandedAnchor.render(120).join("\n");
  assert.match(completedExpanded, /Verification pass/);
  assert.match(completedExpanded, /Details/);
  assert.match(completedExpanded, /All approved standards are satisfied/);
  assert.doesNotMatch(completedExpanded, /npm test|42 tests passed/);
});

test("verification cards stay isolated when separate Goals both use attempt one", () => {
  const appended: CapturedEntry[] = [];
  let renderer: ((...args: any[]) => { render: (width: number) => string[] }) | undefined;
  const ui = new VerificationUi({
    registerEntryRenderer: (_type: string, value: typeof renderer) => void (renderer = value),
    appendEntry: (customType: string, data: unknown) => void appended.push({ customType, data }),
  } as unknown as ExtensionAPI);
  const firstOperation = ui.start(1);
  assert.ok(renderer);
  const firstCard = renderer({ data: appended[0]?.data }, { expanded: false }, theme);
  ui.finish(firstOperation, "pass", "First Goal passed.");
  assert.match(firstCard.render(120).join("\n"), /Verification pass/);

  ui.start(1);
  const secondCard = renderer({ data: appended[2]?.data }, { expanded: false }, theme);
  const secondText = secondCard.render(120).join("\n");
  assert.match(secondText, /Verifying/);
  assert.match(secondText, /Waiting for verifier output/);
  assert.doesNotMatch(secondText, /Verification pass|Verification fail/);
  assert.match(firstCard.render(120).join("\n"), /Verification pass/);
});

test("verification display restores the latest event from session entries", () => {
  const appended: CapturedEntry[] = [];
  let renderer: ((...args: any[]) => { render: (width: number) => string[] }) | undefined;
  const firstPi = {
    registerEntryRenderer: (_type: string, value: typeof renderer) => void (renderer = value),
    appendEntry: (customType: string, data: unknown) => void appended.push({ customType, data }),
  } as unknown as ExtensionAPI;
  const first = new VerificationUi(firstPi);
  const operationId = first.start(2);
  first.addInteractions(operationId, [
    { kind: "tool-result", label: "test result", text: "One test failed." },
  ]);
  first.finish(operationId, "fail", "A required check failed.");

  let restoredRenderer: typeof renderer;
  const restored = new VerificationUi({
    registerEntryRenderer: (_type: string, value: typeof renderer) => void (restoredRenderer = value),
    appendEntry: () => {},
  } as unknown as ExtensionAPI);
  restored.restore(
    appended.map((entry, index) => ({
      type: "custom",
      customType: entry.customType,
      data: entry.data,
      id: String(index),
      parentId: index === 0 ? null : String(index - 1),
      timestamp: new Date(0).toISOString(),
    })) as SessionEntry[],
  );
  assert.ok(restoredRenderer);
  const text = restoredRenderer(
    { data: appended[0]?.data },
    { expanded: true },
    theme,
  ).render(120).join("\n");
  assert.match(text, /Verification fail/);
  assert.doesNotMatch(text, /One test failed/);
  assert.match(text, /A required check failed/);
});

test("verification titles and traces use tool styles with tool outcome backgrounds", () => {
  const appended: CapturedEntry[] = [];
  let renderer: ((...args: any[]) => { render: (width: number) => string[] }) | undefined;
  const ui = new VerificationUi({
    registerEntryRenderer: (_type: string, value: typeof renderer) => void (renderer = value),
    appendEntry: (customType: string, data: unknown) => void appended.push({ customType, data }),
  } as unknown as ExtensionAPI);
  const fgCalls: Array<{ color: string; text: string }> = [];
  const bgCalls: Array<{ color: string; text: string }> = [];
  const boldCalls: string[] = [];
  const recordingTheme = {
    fg: (color: string, text: string) => {
      fgCalls.push({ color, text });
      return text;
    },
    bg: (color: string, text: string) => {
      bgCalls.push({ color, text });
      return text;
    },
    bold: (text: string) => {
      boldCalls.push(text);
      return text;
    },
  };
  const operationId = ui.start(1);
  assert.ok(renderer);
  const card = renderer({ data: appended[0]?.data }, { expanded: false }, recordingTheme);
  ui.addInteractions(operationId, [
    { kind: "tool-call", label: "bash", text: "npm test" },
  ]);
  card.render(120);
  assert.ok(fgCalls.some((call) => call.color === "toolTitle" && call.text === "Verifying"));
  assert.ok(fgCalls.some((call) => call.color === "toolOutput" && call.text === "bash"));
  assert.ok(bgCalls.some((call) => call.color === "toolPendingBg"));
  assert.deepEqual(boldCalls, ["Verifying"]);
  assert.equal(fgCalls.some((call) => call.color === "accent" || call.color === "muted"), false);

  fgCalls.length = 0;
  bgCalls.length = 0;
  boldCalls.length = 0;
  ui.finish(operationId, "pass", "Everything passed.");
  card.render(120);
  assert.ok(
    fgCalls.some((call) => call.color === "toolTitle" && call.text === "Verification pass"),
  );
  assert.ok(bgCalls.some((call) => call.color === "toolSuccessBg"));

  const failedOperation = ui.start(1);
  const failedCard = renderer({ data: appended[2]?.data }, { expanded: false }, recordingTheme);
  ui.finish(failedOperation, "fail", "A check failed.");
  fgCalls.length = 0;
  bgCalls.length = 0;
  failedCard.render(120);
  assert.ok(
    fgCalls.some((call) => call.color === "toolTitle" && call.text === "Verification fail"),
  );
  assert.ok(bgCalls.some((call) => call.color === "toolErrorBg"));
});

test("collapsed final details are width-aware and truncated to three lines", () => {
  const appended: CapturedEntry[] = [];
  let renderer: ((...args: any[]) => { render: (width: number) => string[] }) | undefined;
  const ui = new VerificationUi({
    registerEntryRenderer: (_type: string, value: typeof renderer) => void (renderer = value),
    appendEntry: (customType: string, data: unknown) => void appended.push({ customType, data }),
  } as unknown as ExtensionAPI);
  const operationId = ui.start(1);
  assert.ok(renderer);
  const collapsed = renderer({ data: appended[0]?.data }, { expanded: false }, theme);
  const expanded = renderer({ data: appended[0]?.data }, { expanded: true }, theme);
  const details = `${"A detailed verification conclusion. ".repeat(12)}FINAL-MARKER`;
  ui.finish(operationId, "fail", details);

  const collapsedLines = collapsed.render(42);
  assert.equal(collapsedLines.length, 4);
  assert.match(collapsedLines.join("\n"), /…/);
  assert.doesNotMatch(collapsedLines.join("\n"), /FINAL-MARKER/);

  const expandedText = expanded.render(42).join("\n");
  assert.match(expandedText, /FINAL-MARKER/);
});

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};
