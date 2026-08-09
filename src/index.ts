import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GoalCommandController } from "./commands.js";
import { registerGoalLifecycle } from "./lifecycle.js";
import { GoalRuntime } from "./runtime.js";
import { registerGoalTools } from "./tools.js";
import { GoalVerifier } from "./verifier.js";
import { VerificationUi } from "./verification-ui.js";

export default function goalExtension(pi: ExtensionAPI): void {
  const runtime = new GoalRuntime(pi);
  const verifier = new GoalVerifier();
  const verificationUi = new VerificationUi(pi);
  let commands: GoalCommandController;
  const dispatchEffects = registerGoalLifecycle(
    pi,
    runtime,
    verifier,
    verificationUi,
    () => commands,
  );
  commands = new GoalCommandController(pi, runtime, dispatchEffects);
  registerGoalTools(pi, runtime);
  commands.register();
}

export { parseGoalCommand } from "./commands.js";
export { buildExecutionSystemPrompt, buildRefinementSystemPrompt } from "./prompts.js";
export { GoalRuntime } from "./runtime.js";
export type { GoalSpec, GoalState, GoalStatus } from "./state.js";
