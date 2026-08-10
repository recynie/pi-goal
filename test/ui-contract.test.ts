import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GoalRuntime } from "../src/runtime.js";
import { approveDraft, createRefiningGoal, pauseGoal, setDraft, type GoalSpec } from "../src/state.js";
import {
  editGoalDraft,
  goalPanelActions,
  goalPanelEscapeAction,
  goalPanelLayout,
  runExternalGoalEditor,
} from "../src/ui.js";

const refining = setDraft(createRefiningGoal("Ship"), {
  mainGoal: "Ship",
  subtasks: ["Tests pass."],
  details: [],
});
const active = approveDraft(refining);

test("Control Panel never contains a Cancel action", () => {
  const states = [refining, active, { ...active, status: "verifying" as const }, pauseGoal(active, { source: "user" })];
  for (const state of states) {
    assert.doesNotMatch(goalPanelActions(state, false).join(","), /cancel/u);
  }
});

test("refining Escape maps to refine and other states map to close", () => {
  assert.equal(goalPanelEscapeAction(refining), "refine");
  assert.equal(goalPanelEscapeAction(active), "close");
});

test("running refinement is read-only until settlement", () => {
  assert.deepEqual(goalPanelActions(refining, true), ["refine"]);
  assert.deepEqual(goalPanelActions(refining, false), ["start", "edit", "refine"]);
});

test("draft editing launches an external-editor overlay and saves the edited GoalSpec", async () => {
  let saved: GoalSpec | undefined;
  let overlay = false;
  const runtime = {
    state: refining,
    setDraft: (draft: GoalSpec) => void (saved = draft),
  } as unknown as GoalRuntime;
  const edited = {
    mainGoal: "Ship edited",
    subtasks: ["Edited tests pass."],
    details: ["Edited detail."],
  };
  const ctx = {
    mode: "tui",
    cwd: process.cwd(),
    isProjectTrusted: () => true,
    ui: {
      custom: async (_factory: unknown, options: { overlay?: boolean }) => {
        overlay = options.overlay === true;
        return { status: "complete", content: JSON.stringify(edited) };
      },
      notify: () => {},
    },
  } as unknown as ExtensionContext;

  assert.equal(await editGoalDraft(runtime, ctx), true);
  assert.equal(overlay, true);
  assert.deepEqual(saved, edited);
});

test("invalid external edits reopen with the edited content", async () => {
  let saved: GoalSpec | undefined;
  let calls = 0;
  const notices: string[] = [];
  const edited = {
    mainGoal: "Ship after correction",
    subtasks: ["Corrected tests pass."],
    details: [],
  };
  const runtime = {
    state: refining,
    setDraft: (draft: GoalSpec) => void (saved = draft),
  } as unknown as GoalRuntime;
  const ctx = {
    mode: "tui",
    cwd: process.cwd(),
    isProjectTrusted: () => true,
    ui: {
      custom: async () => {
        calls += 1;
        return calls === 1
          ? { status: "complete", content: "{ invalid" }
          : { status: "complete", content: JSON.stringify(edited) };
      },
      notify: (message: string) => notices.push(message),
    },
  } as unknown as ExtensionContext;

  assert.equal(await editGoalDraft(runtime, ctx), true);
  assert.equal(calls, 2);
  assert.match(notices.join("\n"), /Invalid GoalSpec JSON/u);
  assert.deepEqual(saved, edited);
});

test("external Goal editor reads the file after the configured command exits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-goal-ui-test-"));
  const script = join(directory, "editor.mjs");
  const edited = JSON.stringify({ mainGoal: "Edited", subtasks: ["Verified"], details: [] });
  try {
    await writeFile(
      script,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[2], ${JSON.stringify(edited)});\n`,
      "utf8",
    );
    const result = await runExternalGoalEditor(`${process.execPath} ${script}`, "{}");
    assert.deepEqual(result, { status: "complete", content: edited });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("active and verifying GoalSpec views do not offer Edit", () => {
  assert.deepEqual(goalPanelActions(active, false), ["pause"]);
  assert.deepEqual(goalPanelActions({ ...active, status: "verifying" }, false), ["pause"]);
});

test("long Goal content uses a bounded scrolling viewport", () => {
  assert.deepEqual(goalPanelLayout(5, 40), {
    viewport: 5,
    showIndicator: false,
    maxRows: 36,
  });
  assert.deepEqual(goalPanelLayout(100, 40), {
    viewport: 32,
    showIndicator: true,
    maxRows: 36,
  });
});
