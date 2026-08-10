import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGoalTools } from "../src/tools.js";
import type { GoalRuntime } from "../src/runtime.js";

interface CapturedTool {
  name: string;
  renderResult?: (...args: any[]) => { render: (width: number) => string[] };
  execute: (
    toolCallId: string,
    params: Record<string, string>,
    signal: AbortSignal,
    onUpdate: () => void,
    context: unknown,
  ) => Promise<{
    content: Array<{ type: string; text?: string }>;
    details?: unknown;
  }>;
}

test("goal_propose renders main goal when collapsed and the full draft when expanded", () => {
  const tools = new Map<string, CapturedTool>();
  const pi = {
    registerTool: (tool: CapturedTool) => void tools.set(tool.name, tool),
  } as unknown as ExtensionAPI;
  registerGoalTools(pi, {} as GoalRuntime);
  const renderResult = tools.get("goal_propose")?.renderResult;
  assert.ok(renderResult);
  const draft = {
    mainGoal: "Ship the feature",
    subtasks: ["Tests pass."],
    details: ["Keep compatibility."],
  };
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const result = {
    content: [{ type: "text", text: "Goal draft recorded." }],
    details: { draft },
  };

  const collapsed = renderResult(result, { expanded: false }, theme, {}).render(120).join("\n");
  assert.match(collapsed, /Ship the feature/);
  assert.doesNotMatch(collapsed, /Tests pass|Keep compatibility/);
  assert.match(collapsed, /review popup opens after this run settles/);

  const expanded = renderResult(result, { expanded: true }, theme, {}).render(120).join("\n");
  assert.match(expanded, /Ship the feature/);
  assert.match(expanded, /Tests pass/);
  assert.match(expanded, /Keep compatibility/);
  assert.ok(
    expanded.indexOf("Keep compatibility") < expanded.indexOf("Goal draft recorded"),
    "supplemental status should render after the complete Goal",
  );
});

test("goal_submit collapses long results and expands to the complete result", () => {
  const tools = new Map<string, CapturedTool>();
  const pi = {
    registerTool: (tool: CapturedTool) => void tools.set(tool.name, tool),
  } as unknown as ExtensionAPI;
  registerGoalTools(pi, {} as GoalRuntime);
  const renderResult = tools.get("goal_submit")?.renderResult;
  assert.ok(renderResult);
  const submittedResult = `${"A long submitted result. ".repeat(15)}FINAL-MARKER`;
  const result = {
    content: [{ type: "text", text: submittedResult }],
    details: { result: submittedResult },
  };
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };

  const collapsedLines = renderResult(result, { expanded: false }, theme, {}).render(42);
  assert.equal(collapsedLines.length, 4);
  assert.match(collapsedLines.join("\n"), /…/);
  assert.doesNotMatch(collapsedLines.join("\n"), /FINAL-MARKER/);

  const expanded = renderResult(result, { expanded: true }, theme, {}).render(42).join("\n");
  assert.match(expanded, /FINAL-MARKER/);
});

test("goal_pause shows and records exactly the provided reason", async () => {
  const tools = new Map<string, CapturedTool>();
  const pi = {
    registerTool: (tool: CapturedTool) => void tools.set(tool.name, tool),
  } as unknown as ExtensionAPI;
  let pausedReason: string | undefined;
  const runtime = {
    pauseFromAgent: (reason: string) => void (pausedReason = reason),
  } as unknown as GoalRuntime;

  registerGoalTools(pi, runtime);
  const tool = tools.get("goal_pause");
  assert.ok(tool);
  const reason = "A user credential is required.";
  const output = await tool.execute(
    "call-1",
    { reason },
    new AbortController().signal,
    () => {},
    {},
  );

  assert.equal(pausedReason, reason);
  assert.deepEqual(output.content, [{ type: "text", text: reason }]);
  assert.deepEqual(output.details, { reason });
});

test("goal_submit shows and submits exactly the same result", async () => {
  const tools = new Map<string, CapturedTool>();
  const pi = {
    registerTool: (tool: CapturedTool) => void tools.set(tool.name, tool),
  } as unknown as ExtensionAPI;
  let submitted: string | undefined;
  const runtime = {
    submit: (result: string) => void (submitted = result),
  } as unknown as GoalRuntime;

  registerGoalTools(pi, runtime);
  const tool = tools.get("goal_submit");
  assert.ok(tool);
  const result = "The exact final result shown to the user.";
  const output = await tool.execute(
    "call-1",
    { result },
    new AbortController().signal,
    () => {},
    {},
  );

  assert.equal(submitted, result);
  assert.deepEqual(output.content, [{ type: "text", text: result }]);
  assert.deepEqual(output.details, { result });
});
