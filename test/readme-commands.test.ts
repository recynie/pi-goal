import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { completeGoalArguments, parseGoalCommand } from "../src/commands.js";

const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
const commandsSection = readme.match(/## Commands\n(?<body>[\s\S]*?)\n## /u)?.groups?.body;

assert.ok(commandsSection, "README must contain a Commands section");

function documentedCommands(): Map<string, string> {
  const commandBlock = commandsSection?.match(/```text\n(?<body>[\s\S]*?)```/u)?.groups?.body;
  assert.ok(commandBlock, "README Commands section must contain a text command block");

  return new Map(
    commandBlock
      .trim()
      .split("\n")
      .map((line) => {
        const [form, description] = line.split(/\s+#\s+/u);
        assert.ok(form && description, `README command needs a description: ${line}`);
        return [form.trim(), description.trim()];
      }),
  );
}

test("README documents the complete implemented Goal command surface", () => {
  const completions = completeGoalArguments("") ?? [];
  const implementedForms = [
    "/goal <main goal>",
    "/goal",
    ...completions.map(({ value }) => `/goal ${value}`),
  ];

  assert.deepEqual([...documentedCommands().keys()], implementedForms);
  assert.deepEqual(parseGoalCommand("ship the feature"), {
    kind: "start",
    mainGoal: "ship the feature",
  });
  assert.deepEqual(parseGoalCommand(""), { kind: "panel" });
  for (const { value } of completions) {
    assert.equal(parseGoalCommand(value).kind, value);
  }
});

test("README documents uncertainty-led proportional refinement", () => {
  assert.match(readme, /lists only material uncertainties/iu);
  assert.match(readme, /resolves discoverable facts.*itself/iu);
  assert.match(readme, /dependency-aware rounds/iu);
  assert.match(readme, /avoids exhaustive grilling/iu);
  assert.match(readme, /never silently selects among materially different interpretations/iu);
});

test("README documents popup editing, external editing, and proposal expansion", () => {
  assert.match(readme, /centered multiline editor overlay/iu);
  assert.match(readme, /Ctrl\+G/iu);
  assert.match(readme, /collapsed tool result shows the proposed main goal/iu);
  assert.match(readme, /expanding tool output shows all subtasks and details/iu);
});

test("README documents the observable verifier card lifecycle", () => {
  assert.match(readme, /built-in-tool-call-style card/iu);
  assert.match(readme, /title is \*\*Verifying\*\* while the verifier runs/iu);
  assert.match(readme, /rolling, four-line viewport of the latest trace/iu);
  assert.match(readme, /complete bounded trace/iu);
  assert.match(readme, /trace labels and text use the ordinary body style/iu);
  assert.match(
    readme,
    /\*\*Verification pass\*\*.*\*\*Verification fail\*\*.*\*\*Verification error\*\*/iu,
  );
  assert.match(readme, /fail and error use the red failed-tool-call background/iu);
  assert.match(readme, /truncated after three wrapped lines/iu);
  assert.match(readme, /Settled cards no longer show verifier traces/iu);
  assert.match(readme, /TUI-only and never enter worker or verifier model context/iu);
});

test("README documents the exact user/verifier submission contract", () => {
  assert.match(readme, /goal_submit\(\{ result \}\)/u);
  assert.match(readme, /collapsed output shows at most four wrapped lines/iu);
  assert.match(readme, /expanded output shows the complete submitted result/iu);
  assert.match(readme, /exact final result shown to the user/iu);
  assert.match(readme, /exact `goal_submit\.result` already shown to the user/iu);
  assert.doesNotMatch(readme, /goal_complete/u);
});

test("README describes command purposes and settled-boundary behavior", () => {
  const descriptions = documentedCommands();
  assert.match(descriptions.get("/goal <main goal>") ?? "", /create.*draft.*refinement/iu);
  assert.match(descriptions.get("/goal") ?? "", /Control Panel/u);
  assert.match(descriptions.get("/goal status") ?? "", /non-interactive status/iu);
  assert.match(descriptions.get("/goal pause") ?? "", /active or verifying Goal/iu);
  assert.match(descriptions.get("/goal resume") ?? "", /resume a paused Goal.*execution/iu);
  assert.match(descriptions.get("/goal edit") ?? "", /edit.*draft.*return.*refinement/iu);
  assert.match(descriptions.get("/goal cancel") ?? "", /cancel the current Goal/iu);

  assert.match(
    commandsSection ?? "",
    /worker or verifier is running, pause, edit, and cancel are persisted as pending user actions/u,
  );
  assert.match(commandsSection ?? "", /current run is allowed to settle/u);
  assert.match(
    commandsSection ?? "",
    /user action is committed before worker submission, verification, or another automatic continuation/u,
  );
  assert.match(commandsSection ?? "", /\/goal cancel.*only cancellation UI/u);
  assert.match(commandsSection ?? "", /Control Panel has no Cancel button/u);
});
