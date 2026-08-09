import { StringEnum } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildVerificationSystemPrompt, buildVerificationTask } from "./prompts.js";
import type { GoalSpec } from "./state.js";
import type { VerifierOutcome } from "./runtime.js";
import {
  verificationInteractionsFromMessage,
  type VerificationInteraction,
} from "./verification-ui.js";

export const VERIFIER_TOOL_NAMES = [
  "read",
  "bash",
  "goal_verification_result",
] as const;

interface VerificationOperation {
  aborted: boolean;
  session?: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
}

export class GoalVerifier {
  private current: VerificationOperation | undefined;

  async verify(
    spec: GoalSpec,
    submittedResult: string,
    ctx: ExtensionContext,
    onInteraction: (items: readonly VerificationInteraction[]) => void,
    onSettled: (outcome: VerifierOutcome) => Promise<void>,
  ): Promise<void> {
    if (this.current) throw new Error("A Goal verifier is already running.");
    if (!ctx.model) {
      await onSettled({ kind: "error", reason: "No active model is available for Goal verification." });
      return;
    }

    const operation: VerificationOperation = { aborted: false };
    this.current = operation;
    let result: { result: "pass" | "fail"; details: string } | undefined;
    try {
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: true },
        retry: { enabled: true },
      });
      const loader = new DefaultResourceLoader({
        cwd: ctx.cwd,
        agentDir: getAgentDir(),
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: buildVerificationSystemPrompt(),
      });
      await loader.reload();

      const resultTool = defineTool({
        name: "goal_verification_result",
        label: "Goal Verification Result",
        description:
          "Finish independent Goal verification with a pass or fail and details explaining the conclusion.",
        parameters: Type.Object({
          result: StringEnum(["pass", "fail"] as const),
          details: Type.String({ minLength: 1, maxLength: 8_000 }),
        }),
        async execute(_toolCallId, params) {
          if (result) throw new Error("goal_verification_result was already called.");
          const details = params.details.trim();
          if (!details) throw new Error("Verification details cannot be empty.");
          result = { result: params.result, details };
          return {
            content: [{ type: "text", text: `Verification ${params.result} recorded.` }],
            details: result,
            terminate: true,
          };
        },
      });

      const created = await createAgentSession({
        cwd: ctx.cwd,
        model: ctx.model,
        ...(ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel } : {}),
        tools: [...VERIFIER_TOOL_NAMES],
        customTools: [resultTool],
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(ctx.cwd),
        settingsManager,
      });
      operation.session = created.session;
      const unsubscribe = created.session.subscribe((event) => {
        if (event.type !== "message_end" || operation.aborted || this.current !== operation) return;
        const items = verificationInteractionsFromMessage(event.message);
        if (items.length > 0) onInteraction(items);
      });
      if (operation.aborted || this.current !== operation) {
        unsubscribe();
        return;
      }
      try {
        await created.session.prompt(buildVerificationTask(spec, submittedResult, ctx.cwd));
      } finally {
        unsubscribe();
      }
      if (operation.aborted || this.current !== operation) return;
      if (!result) {
        await onSettled({
          kind: "error",
          reason: "The independent verifier settled without calling goal_verification_result.",
        });
        return;
      }
      await onSettled({ kind: "result", ...result });
    } catch (error) {
      if (!operation.aborted && this.current === operation) {
        await onSettled({
          kind: "error",
          reason: `Independent verifier failed: ${formatError(error)}`,
        });
      }
    } finally {
      operation.session?.dispose();
      if (this.current === operation) this.current = undefined;
    }
  }

  shutdown(): void {
    const operation = this.current;
    if (!operation) return;
    operation.aborted = true;
    void operation.session?.abort().catch(() => {});
    operation.session?.dispose();
    this.current = undefined;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
