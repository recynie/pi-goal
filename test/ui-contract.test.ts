import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GoalRuntime } from "../src/runtime.js";
import { approveDraft, createRefiningGoal, pauseGoal, setDraft, type GoalSpec } from "../src/state.js";
import {
  editGoalDraft,
  goalPanelActions,
  goalPanelEscapeAction,
  goalPanelLayout,
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

test("draft editing uses an overlay and saves the edited GoalSpec", async () => {
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
        return JSON.stringify(edited);
      },
      notify: () => {},
    },
  } as unknown as ExtensionContext;

  assert.equal(await editGoalDraft(runtime, ctx), true);
  assert.equal(overlay, true);
  assert.deepEqual(saved, edited);
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
