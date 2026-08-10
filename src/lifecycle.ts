import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GoalCommandController } from "./commands.js";
import { buildExecutionSystemPrompt, buildRefinementSystemPrompt } from "./prompts.js";
import type { GoalRuntime, RuntimeEffect, VerifierOutcome } from "./runtime.js";
import type { GoalVerifier } from "./verifier.js";
import type { VerificationUi } from "./verification-ui.js";

export function registerGoalLifecycle(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  verifier: GoalVerifier,
  verificationUi: VerificationUi,
  getCommands: () => GoalCommandController,
): (effects: RuntimeEffect[], ctx: ExtensionContext) => Promise<void> {
  const dispatchEffects = async (effects: RuntimeEffect[], ctx: ExtensionContext): Promise<void> => {
    for (const effect of effects) {
      if (runtime.disposed) return;
      switch (effect.kind) {
        case "open-panel":
          // Auto-review is interactive. RPC receives a status notification through
          // openPanel; print/json have no UI channel and must not turn settlement
          // into an extension error.
          if (ctx.mode === "tui" || ctx.hasUI) await getCommands().openPanel(ctx);
          break;
        case "dispatch-continuation":
          if (!runtime.continuation.dispatch(pi, ctx)) {
            runtime.updateUi(ctx);
          }
          break;
        case "start-verifier": {
          const verificationOperationId = verificationUi.start(effect.attempt);
          await verifier.verify(
            effect.spec,
            effect.result,
            ctx,
            (items) => {
              verificationUi.addInteractions(verificationOperationId, items);
              runtime.updateUi(ctx);
            },
            async (outcome: VerifierOutcome) => {
              if (runtime.disposed) return;
              verificationUi.finish(
                verificationOperationId,
                outcome.kind === "result" ? outcome.result : "error",
                outcome.kind === "result" ? outcome.details : outcome.reason,
              );
              await dispatchEffects(runtime.settleVerifier(outcome, ctx), ctx);
            },
          );
          break;
        }
        case "send-verification-feedback":
          try {
            pi.sendUserMessage(
              [
                "Independent Goal verification failed. Continue the normal execution loop and fix every reported gap.",
                "Verifier details:",
                effect.details,
              ].join("\n"),
              { deliverAs: "followUp" },
            );
          } catch (error) {
            const reason = `Could not return verifier feedback to the worker: ${formatError(error)}`;
            runtime.pauseForPi(reason, ctx);
            ctx.ui.notify(reason, "error");
          }
          break;
        case "interrupt-verification-display":
          verificationUi.interruptRunning(effect.details);
          runtime.updateUi(ctx);
          break;
      }
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    verificationUi.restore(ctx.sessionManager.getBranch());
    const effects = runtime.startSession(ctx);
    await dispatchEffects(effects, ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    verifier.shutdown();
    runtime.shutdown(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    verifier.shutdown();
    verificationUi.restore(ctx.sessionManager.getBranch());
    await dispatchEffects(runtime.restoreTreeBranch(ctx), ctx);
  });

  pi.on("input", (event) => {
    if (event.source === "extension") {
      if (runtime.continuation.consumeCancelledPrompt(event.text)) {
        return { action: "handled" as const };
      }
      return;
    }
    runtime.continuation.cancel();
  });

  pi.on("before_agent_start", (event) => {
    const state = runtime.state;
    if (!state) return;
    const automatic = runtime.continuation.claimPrompt(event.prompt);
    if (state.status === "refining") {
      runtime.beginMainRun("refining", false);
      return { systemPrompt: `${event.systemPrompt}\n\n${buildRefinementSystemPrompt(state)}` };
    }
    if (state.status === "active") {
      runtime.beginMainRun("active", automatic);
      return { systemPrompt: `${event.systemPrompt}\n\n${buildExecutionSystemPrompt(state)}` };
    }
  });

  pi.on("agent_start", () => {
    runtime.beginRetryRun();
  });

  pi.on("tool_call", () => {
    runtime.markToolAttempted();
  });

  pi.on("agent_end", (event) => {
    runtime.finishMainRun(event.messages);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    await dispatchEffects(runtime.settleMain(ctx), ctx);
  });

  pi.on("session_before_compact", (_event, ctx) => {
    if (runtime.state) runtime.persist(ctx);
    runtime.continuation.cancel();
  });

  pi.on("session_compact", (_event, ctx) => {
    if (runtime.state?.status !== "active") return;
    runtime.continuation.request();
    setTimeout(() => {
      if (!runtime.disposed) void dispatchEffects([{ kind: "dispatch-continuation" }], ctx);
    }, 0);
  });

  return dispatchEffects;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
