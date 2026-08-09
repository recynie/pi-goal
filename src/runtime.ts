import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ContinuationController } from "./continuation.js";
import { nextAutomaticProgress, DEFAULT_AUTOMATIC_TURN_LIMIT, DEFAULT_NO_PROGRESS_LIMIT } from "./safety.js";
import {
  applyPendingUserAction,
  approveDraft,
  beginVerification,
  createRefiningGoal,
  finishVerification,
  formatGoalStatus,
  GOAL_STATE_ENTRY_TYPE,
  type GoalSpec,
  type GoalState,
  loadGoalStateFromSession,
  pauseGoal,
  recordActiveRun,
  requestUserAction,
  resumeGoal,
  serializeGoalState,
  setDraft,
  type PendingUserActionKind,
} from "./state.js";

export const GOAL_STATUS_KEY = "goal";

export type RuntimeEffect =
  | { kind: "open-panel" }
  | { kind: "start-verifier"; attempt: number; spec: GoalSpec; result: string }
  | { kind: "dispatch-continuation" }
  | { kind: "send-verification-feedback"; details: string };

export type VerifierOutcome =
  | { kind: "result"; result: "pass" | "fail"; details: string }
  | { kind: "error"; reason: string };

interface MainRun {
  phase: "refining" | "active";
  automatic: boolean;
  toolAttempted: boolean;
}

interface CompletedRun extends MainRun {
  messages: readonly unknown[];
  stopReason?: string;
  errorMessage?: string;
}

export class GoalRuntime {
  state: GoalState | undefined;
  readonly continuation = new ContinuationController();
  currentRun: MainRun | undefined;
  completedRun: CompletedRun | undefined;
  proposalIntent: GoalSpec | undefined;
  terminalIntent:
    | { kind: "submit"; result: string }
    | { kind: "pause"; reason: string }
    | undefined;
  piPauseIntent: string | undefined;
  verifierRunning = false;
  disposed = false;
  panelOpen = false;
  private autoOpenDraft = false;

  constructor(readonly pi: ExtensionAPI) {}

  startSession(ctx: ExtensionContext): RuntimeEffect[] {
    this.disposed = false;
    this.clearTransient();
    this.state = loadGoalStateFromSession(ctx);
    if (!this.state) {
      this.updateUi(ctx);
      return [];
    }

    const effects: RuntimeEffect[] = [];
    if (this.state.pendingUserAction) {
      const action = this.state.pendingUserAction.kind;
      this.state = applyPendingUserAction(this.state);
      this.persist(ctx);
      if (action === "edit") effects.push({ kind: "open-panel" });
    }
    if (this.state.status === "active") {
      this.continuation.request();
      effects.push({ kind: "dispatch-continuation" });
    } else if (
      this.state.status === "verifying" &&
      this.state.approved &&
      this.state.submissionResult
    ) {
      this.verifierRunning = true;
      effects.push({
        kind: "start-verifier",
        attempt: this.state.verificationAttempts,
        spec: structuredClone(this.state.approved),
        result: this.state.submissionResult,
      });
    }
    this.updateUi(ctx);
    return effects;
  }

  shutdown(ctx: ExtensionContext): void {
    if (this.state) this.persist(ctx);
    this.disposed = true;
    this.clearTransient();
    this.state = undefined;
    ctx.ui.setStatus(GOAL_STATUS_KEY, undefined);
  }

  createGoal(mainGoal: string, ctx: ExtensionContext): void {
    if (this.state && this.state.status !== "complete" && this.state.status !== "cancelled") {
      throw new Error("A current Goal already exists. Use /goal edit or /goal cancel first.");
    }
    this.clearTransient();
    this.state = createRefiningGoal(mainGoal);
    this.persist(ctx);
  }

  setDraft(draft: GoalSpec, ctx: ExtensionContext): void {
    if (!this.state) throw new Error("No Goal is being refined.");
    this.state = setDraft(this.state, draft);
    this.autoOpenDraft = false;
    this.persist(ctx);
  }

  startApprovedGoal(ctx: ExtensionContext): GoalSpec {
    if (!this.state) throw new Error("No Goal draft exists.");
    this.state = approveDraft(this.state);
    this.clearRunIntents();
    this.continuation.cancel();
    this.persist(ctx);
    return structuredClone(this.state.approved as GoalSpec);
  }

  resume(ctx: ExtensionContext): GoalSpec {
    if (!this.state) throw new Error("No Goal exists.");
    this.state = resumeGoal(this.state);
    this.clearRunIntents();
    this.continuation.cancel();
    this.persist(ctx);
    return structuredClone(this.state.approved as GoalSpec);
  }

  pauseForPi(reason: string, ctx: ExtensionContext): void {
    if (!this.state || (this.state.status !== "active" && this.state.status !== "verifying")) {
      return;
    }
    this.verifierRunning = false;
    this.continuation.cancel();
    this.clearRunIntents();
    this.state = pauseGoal(this.state, { source: "pi", reason });
    this.persist(ctx);
  }

  requestUserAction(kind: PendingUserActionKind, ctx: ExtensionContext): RuntimeEffect[] {
    if (!this.state) throw new Error("No current Goal exists.");
    if (kind === "pause" && this.state.status !== "active" && this.state.status !== "verifying") {
      throw new Error("Only an active or verifying Goal can be paused.");
    }
    if (kind === "edit" && this.state.status === "refining") return [{ kind: "open-panel" }];

    this.state = requestUserAction(this.state, kind);
    this.persist(ctx);
    if (!ctx.isIdle() || this.verifierRunning || this.currentRun || this.completedRun) return [];
    return this.commitPendingUserAction(ctx);
  }

  beginMainRun(phase: "refining" | "active", automatic: boolean): void {
    this.completedRun = undefined;
    this.piPauseIntent = undefined;
    this.currentRun = { phase, automatic, toolAttempted: false };
  }

  beginRetryRun(): void {
    if (this.currentRun || !this.completedRun) return;
    const previous = this.completedRun;
    this.completedRun = undefined;
    this.piPauseIntent = undefined;
    this.currentRun = {
      phase: previous.phase,
      automatic: previous.automatic,
      toolAttempted: false,
    };
  }

  markToolAttempted(): void {
    if (this.currentRun) this.currentRun.toolAttempted = true;
  }

  finishMainRun(messages: readonly unknown[]): void {
    const run = this.currentRun;
    this.currentRun = undefined;
    if (!run) return;
    const assistant = findFinalAssistant(messages);
    this.completedRun = {
      ...run,
      messages,
      ...(typeof assistant?.stopReason === "string" ? { stopReason: assistant.stopReason } : {}),
      ...(typeof assistant?.errorMessage === "string" ? { errorMessage: assistant.errorMessage } : {}),
    };
    if (run.phase === "active" && assistant?.stopReason === "error") {
      this.piPauseIntent =
        typeof assistant.errorMessage === "string"
          ? assistant.errorMessage
          : "Agent run failed after Pi retries.";
    } else if (
      run.phase === "active" &&
      assistant?.stopReason !== "aborted" &&
      !this.terminalIntent
    ) {
      // Match Pi's safe lifecycle boundary: agent_end records intent, while
      // agent_settled is the only place allowed to dispatch it.
      this.continuation.request();
    }
  }

  propose(draft: GoalSpec): void {
    if (this.state?.status !== "refining" || this.currentRun?.phase !== "refining") {
      throw new Error("goal_propose is only available in the current refining run.");
    }
    if (this.proposalIntent) throw new Error("A Goal proposal is already pending for this run.");
    this.proposalIntent = structuredClone(draft);
  }

  submit(result: string): void {
    if (this.state?.status !== "active" || this.currentRun?.phase !== "active") {
      throw new Error("goal_submit is only available in the current active Goal run.");
    }
    if (this.terminalIntent) throw new Error("A terminal Goal intent is already pending.");
    this.terminalIntent = { kind: "submit", result: result.trim() };
  }

  pauseFromAgent(reason: string): void {
    if (this.state?.status !== "active" || this.currentRun?.phase !== "active") {
      throw new Error("goal_pause is only available in the current active Goal run.");
    }
    if (this.terminalIntent) throw new Error("A terminal Goal intent is already pending.");
    this.terminalIntent = { kind: "pause", reason: reason.trim() };
  }

  settleMain(ctx: ExtensionContext): RuntimeEffect[] {
    if (!this.state) {
      this.clearRunIntents();
      return [];
    }

    const completed = this.completedRun;
    this.completedRun = undefined;
    if (completed?.phase === "active" && this.state.status === "active") {
      let progress:
        | { noProgressTurns?: number; lastAutomaticOutputFingerprint?: string }
        | undefined;
      if (completed.automatic) {
        const next = nextAutomaticProgress(
          this.state.lastAutomaticOutputFingerprint,
          this.state.noProgressTurns,
          completed.messages,
          completed.toolAttempted,
        );
        progress = {
          noProgressTurns: next.noProgressTurns,
          ...(next.fingerprint ? { lastAutomaticOutputFingerprint: next.fingerprint } : {}),
        };
      }
      this.state = recordActiveRun(this.state, {
        automatic: completed.automatic,
        ...progress,
      });
    }

    if (this.state.pendingUserAction) {
      const effects = this.commitPendingUserAction(ctx);
      this.clearRunIntents();
      return effects;
    }

    if (this.proposalIntent && this.state.status === "refining") {
      this.state = setDraft(this.state, this.proposalIntent);
      this.proposalIntent = undefined;
      this.autoOpenDraft = true;
      this.persist(ctx);
      this.clearCompletedOnly();
      return ctx.hasPendingMessages() ? [] : [{ kind: "open-panel" }];
    }

    if (this.terminalIntent && this.state.status === "active") {
      const terminal = this.terminalIntent;
      this.terminalIntent = undefined;
      this.continuation.cancel();
      if (terminal.kind === "pause") {
        this.state = pauseGoal(this.state, { source: "agent", reason: terminal.reason });
        this.persist(ctx);
        this.clearCompletedOnly();
        return [];
      }
      this.state = beginVerification(this.state, terminal.result);
      this.verifierRunning = true;
      this.persist(ctx);
      const spec = structuredClone(this.state.approved as GoalSpec);
      this.clearCompletedOnly();
      return [{
        kind: "start-verifier",
        attempt: this.state.verificationAttempts,
        spec,
        result: terminal.result,
      }];
    }

    if (this.piPauseIntent && this.state.status === "active") {
      this.continuation.cancel();
      this.state = pauseGoal(this.state, { source: "pi", reason: this.piPauseIntent });
      this.persist(ctx);
      this.clearRunIntents();
      return [];
    }

    if (completed?.stopReason === "aborted" && this.state.status === "active") {
      this.continuation.cancel();
      this.state = pauseGoal(this.state, {
        source: "pi",
        reason: "The Goal run was interrupted before it settled.",
      });
      this.persist(ctx);
      this.clearRunIntents();
      return [];
    }

    if (
      this.state.status === "active" &&
      (this.state.automaticTurns >= DEFAULT_AUTOMATIC_TURN_LIMIT ||
        this.state.noProgressTurns >= DEFAULT_NO_PROGRESS_LIMIT)
    ) {
      const reason =
        this.state.automaticTurns >= DEFAULT_AUTOMATIC_TURN_LIMIT
          ? `Automatic-work limit reached (${this.state.automaticTurns}/${DEFAULT_AUTOMATIC_TURN_LIMIT}).`
          : `No progress detected across ${this.state.noProgressTurns} automatic runs.`;
      this.continuation.cancel();
      this.state = pauseGoal(this.state, { source: "pi", reason });
      this.persist(ctx);
      this.clearRunIntents();
      return [];
    }

    this.clearRunIntents();
    if (this.state.status === "active" && this.continuation.hasWork()) {
      return [{ kind: "dispatch-continuation" }];
    }
    this.updateUi(ctx);
    return [];
  }

  settleVerifier(outcome: VerifierOutcome, ctx: ExtensionContext): RuntimeEffect[] {
    this.verifierRunning = false;
    if (!this.state || this.state.status !== "verifying") return [];
    if (this.state.pendingUserAction) return this.commitPendingUserAction(ctx);

    if (outcome.kind === "error") {
      this.state = pauseGoal(this.state, { source: "pi", reason: outcome.reason });
      this.persist(ctx);
      return [];
    }

    this.state = finishVerification(this.state, outcome.result, outcome.details);
    this.persist(ctx);
    if (outcome.result === "pass") {
      ctx.ui.notify("Goal verification passed.", "info");
      return [];
    }
    return [{ kind: "send-verification-feedback", details: outcome.details }];
  }

  shouldAutoOpenDraft(): boolean {
    if (!this.autoOpenDraft || this.panelOpen) return false;
    this.autoOpenDraft = false;
    return true;
  }

  setPanelOpen(open: boolean): void {
    this.panelOpen = open;
  }

  persist(ctx: ExtensionContext): void {
    this.pi.appendEntry(GOAL_STATE_ENTRY_TYPE, serializeGoalState(this.state));
    this.updateUi(ctx);
  }

  updateUi(ctx: ExtensionContext): void {
    ctx.ui.setStatus(
      GOAL_STATUS_KEY,
      this.state ? formatGoalStatus(this.state) : undefined,
    );
  }

  private commitPendingUserAction(ctx: ExtensionContext): RuntimeEffect[] {
    if (!this.state?.pendingUserAction) return [];
    const kind = this.state.pendingUserAction.kind;
    this.state = applyPendingUserAction(this.state);
    this.continuation.cancel();
    this.clearRunIntents();
    this.persist(ctx);
    return kind === "edit" ? [{ kind: "open-panel" }] : [];
  }

  private clearTransient(): void {
    this.continuation.reset();
    this.currentRun = undefined;
    this.completedRun = undefined;
    this.proposalIntent = undefined;
    this.terminalIntent = undefined;
    this.piPauseIntent = undefined;
    this.verifierRunning = false;
    this.panelOpen = false;
    this.autoOpenDraft = false;
  }

  private clearRunIntents(): void {
    this.proposalIntent = undefined;
    this.terminalIntent = undefined;
    this.piPauseIntent = undefined;
    this.completedRun = undefined;
    this.currentRun = undefined;
  }

  private clearCompletedOnly(): void {
    this.piPauseIntent = undefined;
    this.completedRun = undefined;
    this.currentRun = undefined;
  }
}

function findFinalAssistant(messages: readonly unknown[]): {
  stopReason?: unknown;
  errorMessage?: unknown;
} | undefined {
  return messages
    .filter((message): message is Record<string, unknown> => typeof message === "object" && message !== null)
    .filter((message) => message.role === "assistant")
    .at(-1);
}

