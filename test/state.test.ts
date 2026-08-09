import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPendingUserAction,
  approveDraft,
  beginVerification,
  createRefiningGoal,
  finishVerification,
  formatGoalStatus,
  GOAL_STATE_ENTRY_TYPE,
  loadGoalStateFromSession,
  normalizeGoalSpec,
  requestUserAction,
  resumeGoal,
  setDraft,
} from "../src/state.js";

test("refining draft must have verifiable subtasks before approval", () => {
  const state = createRefiningGoal("Ship the feature", 1);
  assert.throws(() => approveDraft(state, 2), /at least one verifiable subtask/);

  const draft = normalizeGoalSpec({
    mainGoal: "Ship the feature",
    subtasks: ["The CLI returns the expected result for a valid input."],
    details: ["Keep existing command syntax compatible."],
  });
  const active = approveDraft(setDraft(state, draft, 2), 3);
  assert.equal(active.status, "active");
  assert.deepEqual(active.approved, draft);
});

test("pending user edit is committed only when the dispatcher applies it", () => {
  const active = approveDraft(
    setDraft(
      createRefiningGoal("Ship", 1),
      { mainGoal: "Ship", subtasks: ["Tests pass."], details: [] },
      2,
    ),
    3,
  );
  const pending = requestUserAction(active, "edit", 4);
  assert.equal(pending.status, "active");
  assert.equal(pending.pendingUserAction?.kind, "edit");

  const refining = applyPendingUserAction(pending, 5);
  assert.equal(refining.status, "refining");
  assert.deepEqual(refining.draft, active.approved);
  assert.equal(refining.pendingUserAction, undefined);
});

test("pause and resume preserve the approved Goal and reset safety counters", () => {
  const active = approveDraft(
    setDraft(createRefiningGoal("Ship"), {
      mainGoal: "Ship",
      subtasks: ["The release artifact exists."],
      details: [],
    }),
  );
  const paused = applyPendingUserAction(requestUserAction(active, "pause"));
  assert.equal(paused.status, "paused");
  assert.equal(paused.pause?.source, "user");
  const resumed = resumeGoal({ ...paused, automaticTurns: 9, noProgressTurns: 2 });
  assert.equal(resumed.status, "active");
  assert.equal(resumed.automaticTurns, 0);
  assert.equal(resumed.noProgressTurns, 0);
  assert.deepEqual(resumed.approved, active.approved);
});

test("verification pass is the only path to complete", () => {
  const active = approveDraft(
    setDraft(createRefiningGoal("Ship"), {
      mainGoal: "Ship",
      subtasks: ["Tests pass."],
      details: [],
    }),
  );
  const verifying = beginVerification(active, "The exact final result.");
  assert.equal(verifying.status, "verifying");
  assert.equal(verifying.submissionResult, "The exact final result.");
  assert.equal(finishVerification(verifying, "fail", "A test fails.").status, "active");
  const complete = finishVerification(verifying, "pass", "All acceptance checks pass.");
  assert.equal(complete.status, "complete");
});

test("statusline is concise and counts settled execution rounds", () => {
  const refining = createRefiningGoal("Ship");
  assert.equal(formatGoalStatus(refining), "Goal refining");
  assert.equal(
    formatGoalStatus({ ...refining, status: "paused", iteration: 2 }),
    "Goal paused #2",
  );
  assert.doesNotMatch(formatGoalStatus({ ...refining, pendingUserAction: { kind: "edit", requestedAt: 1 } }), /pending|revision/i);
});

test("legacy verification without a user-visible result restores paused", () => {
  const active = approveDraft(
    setDraft(createRefiningGoal("Ship"), {
      mainGoal: "Ship",
      subtasks: ["Tests pass."],
      details: [],
    }),
  );
  const loaded = loadGoalStateFromSession({
    sessionManager: {
      getBranch: () => [
        {
          type: "custom",
          customType: GOAL_STATE_ENTRY_TYPE,
          data: { ...active, status: "verifying" },
        },
      ],
    },
  });
  assert.equal(loaded?.status, "paused");
  assert.equal(loaded?.pause?.source, "pi");
  assert.match(loaded?.pause?.reason ?? "", /goal_submit/);
});

test("session restore uses the latest canonical branch entry", () => {
  const active = approveDraft(
    setDraft(createRefiningGoal("Ship", 1), {
      mainGoal: "Ship",
      subtasks: ["Tests pass."],
      details: [],
    }),
    2,
  );
  const loaded = loadGoalStateFromSession({
    sessionManager: {
      getBranch: () => [
        { type: "custom", customType: GOAL_STATE_ENTRY_TYPE, data: null },
        { type: "custom", customType: GOAL_STATE_ENTRY_TYPE, data: active },
      ],
    },
  });
  assert.equal(loaded?.status, "active");
  assert.equal(loaded?.approved?.mainGoal, "Ship");
});
