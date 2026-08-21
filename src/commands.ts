import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { buildExecutionKickoff, buildRefinementKickoff } from "./prompts.js";
import type { GoalRuntime, RuntimeEffect } from "./runtime.js";
import { editGoalDraft, showGoalControlPanel, showGoalStatus } from "./ui.js";

export type EffectDispatcher = (
  effects: RuntimeEffect[],
  ctx: ExtensionContext,
) => Promise<void>;

export class GoalCommandController {
  constructor(
    private readonly pi: ExtensionAPI,
    private readonly runtime: GoalRuntime,
    private readonly dispatchEffects: EffectDispatcher,
  ) {}

  register(): void {
    this.pi.registerCommand("goal", {
      description: "Create, inspect, pause, resume, edit, or cancel a verified Goal lifecycle",
      getArgumentCompletions: completeGoalArguments,
      handler: async (args, ctx) => this.handle(args, ctx),
    });
  }

  async handle(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const command = parseGoalCommand(args);
    try {
      switch (command.kind) {
        case "panel":
          await this.openPanel(ctx);
          return;
        case "status":
          showGoalStatus(this.runtime, ctx);
          return;
        case "start":
          this.runtime.createGoal(command.mainGoal, ctx);
          this.pi.sendUserMessage(buildRefinementKickoff(command.mainGoal), { deliverAs: "followUp" });
          return;
        case "propose": {
          const spec = this.runtime.createApprovedGoal(command.mainGoal, ctx);
          this.sendExecutionPrompt(buildExecutionKickoff(spec), ctx);
          return;
        }
        case "pause":
        case "edit":
        case "cancel": {
          const effects = this.runtime.requestUserAction(command.kind, ctx);
          await this.dispatchEffects(effects, ctx);
          if (effects.length === 0 && this.runtime.state?.pendingUserAction) {
            ctx.ui.notify(
              `Goal ${command.kind} is waiting for the current run to settle.`,
              "info",
            );
          }
          return;
        }
        case "resume": {
          const spec = this.runtime.resume(ctx);
          this.sendExecutionPrompt(buildExecutionKickoff(spec), ctx);
          return;
        }
      }
    } catch (error) {
      this.reportError(error, ctx);
    }
  }

  async openPanel(ctx: ExtensionContext): Promise<void> {
    if (this.runtime.panelOpen) return;
    this.runtime.setPanelOpen(true);
    try {
      let keepOpen = true;
      while (keepOpen && !this.runtime.disposed) {
        const action = await showGoalControlPanel(this.runtime, ctx);
        switch (action) {
          case "start": {
            const spec = this.runtime.startApprovedGoal(ctx);
            this.sendExecutionPrompt(buildExecutionKickoff(spec), ctx);
            keepOpen = false;
            break;
          }
          case "edit": {
            if (this.runtime.state?.status === "paused") {
              await this.dispatchEffects(this.runtime.requestUserAction("edit", ctx), ctx);
            }
            if (this.runtime.state?.status !== "refining") {
              ctx.ui.notify("Use /goal edit while this Goal is active or verifying.", "warning");
              keepOpen = false;
              break;
            }
            await editGoalDraft(this.runtime, ctx);
            break;
          }
          case "refine": {
            if (this.runtime.state?.status === "paused") {
              await this.dispatchEffects(this.runtime.requestUserAction("edit", ctx), ctx);
            }
            keepOpen = false;
            break;
          }
          case "pause":
            await this.dispatchEffects(this.runtime.requestUserAction("pause", ctx), ctx);
            keepOpen = false;
            break;
          case "resume": {
            const spec = this.runtime.resume(ctx);
            this.sendExecutionPrompt(buildExecutionKickoff(spec), ctx);
            keepOpen = false;
            break;
          }
          case "close":
            keepOpen = false;
            break;
        }
      }
    } catch (error) {
      this.reportError(error, ctx);
    } finally {
      this.runtime.setPanelOpen(false);
    }
  }

  private sendExecutionPrompt(prompt: string, ctx: ExtensionContext): void {
    try {
      this.pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    } catch (error) {
      const reason = `Could not start Goal execution: ${formatError(error)}`;
      this.runtime.pauseForPi(reason, ctx);
      ctx.ui.notify(reason, "error");
    }
  }

  private reportError(error: unknown, ctx: ExtensionContext): void {
    const message = formatError(error);
    if (!ctx.hasUI) throw error instanceof Error ? error : new Error(message);
    ctx.ui.notify(message, "warning");
  }
}

export type ParsedGoalCommand =
  | { kind: "panel" }
  | { kind: "status" | "pause" | "resume" | "edit" | "cancel" }
  | { kind: "start" | "propose"; mainGoal: string };

export function parseGoalCommand(args: string): ParsedGoalCommand {
  const trimmed = args.trim();
  if (!trimmed) return { kind: "panel" };
  if (["status", "pause", "resume", "edit", "cancel"].includes(trimmed)) {
    return { kind: trimmed as "status" | "pause" | "resume" | "edit" | "cancel" };
  }
  if (/^propose(?:\s|$)/u.test(trimmed)) {
    return { kind: "propose", mainGoal: trimmed.slice("propose".length).trim() };
  }
  return { kind: "start", mainGoal: trimmed };
}

export function completeGoalArguments(prefix: string): AutocompleteItem[] | null {
  const commands = ["propose", "status", "pause", "resume", "edit", "cancel"];
  const matches = commands
    .filter((command) => command.startsWith(prefix.trim()))
    .map((command) => ({ value: command, label: command }));
  return matches.length > 0 ? matches : null;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
