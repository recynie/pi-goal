export const GOAL_STATE_ENTRY_TYPE = "goal-state-v1";
export const GOAL_STATE_VERSION = 1 as const;

export const MAX_MAIN_GOAL_LENGTH = 4_000;
export const MAX_SUBTASK_LENGTH = 2_000;
export const MAX_DETAIL_LENGTH = 2_000;
export const MAX_SUBTASKS = 100;
export const MAX_DETAILS = 100;
export const MAX_SUBMISSION_RESULT_LENGTH = 32_000;

export type GoalStatus =
  | "refining"
  | "active"
  | "paused"
  | "verifying"
  | "complete"
  | "cancelled";

export interface GoalSpec {
  mainGoal: string;
  subtasks: string[];
  details: string[];
}

export type PendingUserActionKind = "edit" | "pause" | "cancel";

export interface PauseInfo {
  source: "user" | "agent" | "pi";
  reason?: string | undefined;
}

export interface GoalState {
  version: typeof GOAL_STATE_VERSION;
  status: GoalStatus;
  draft?: GoalSpec | undefined;
  approved?: GoalSpec | undefined;
  pause?: PauseInfo | undefined;
  pendingUserAction?:
    | {
        kind: PendingUserActionKind;
        requestedAt: number;
      }
    | undefined;
  iteration: number;
  automaticTurns: number;
  noProgressTurns: number;
  lastAutomaticOutputFingerprint?: string | undefined;
  verificationAttempts: number;
  submissionResult?: string | undefined;
  lastVerification?:
    | {
        result: "pass" | "fail";
        details: string;
      }
    | undefined;
  createdAt: number;
  updatedAt: number;
}

export interface SessionEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
}

export interface SessionContextLike {
  sessionManager?: {
    getBranch?: () => SessionEntryLike[];
    getEntries?: () => SessionEntryLike[];
  };
}

export function createRefiningGoal(mainGoal: string, now = Date.now()): GoalState {
  const normalized = normalizeRequiredText(mainGoal, MAX_MAIN_GOAL_LENGTH, "main goal");
  return {
    version: GOAL_STATE_VERSION,
    status: "refining",
    draft: { mainGoal: normalized, subtasks: [], details: [] },
    iteration: 0,
    automaticTurns: 0,
    noProgressTurns: 0,
    verificationAttempts: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function normalizeGoalSpec(value: unknown, requireSubtasks = true): GoalSpec {
  if (!isRecord(value)) throw new Error("GoalSpec must be an object.");
  const mainGoal = normalizeRequiredText(value.mainGoal, MAX_MAIN_GOAL_LENGTH, "mainGoal");
  const subtasks = normalizeTextArray(
    value.subtasks,
    "subtasks",
    MAX_SUBTASKS,
    MAX_SUBTASK_LENGTH,
  );
  const details = normalizeTextArray(value.details, "details", MAX_DETAILS, MAX_DETAIL_LENGTH);
  if (requireSubtasks && subtasks.length === 0) {
    throw new Error("GoalSpec must contain at least one verifiable subtask.");
  }
  return { mainGoal, subtasks, details };
}

export function setDraft(state: GoalState, draft: GoalSpec, now = Date.now()): GoalState {
  if (state.status !== "refining") throw new Error("A Goal draft can only be set while refining.");
  return {
    ...state,
    draft: normalizeGoalSpec(draft),
    updatedAt: now,
  };
}

export function approveDraft(state: GoalState, now = Date.now()): GoalState {
  if (state.status !== "refining" || !state.draft) {
    throw new Error("A draft is required before the Goal can start.");
  }
  const approved = normalizeGoalSpec(state.draft);
  return {
    ...state,
    status: "active",
    draft: undefined,
    approved,
    pause: undefined,
    pendingUserAction: undefined,
    automaticTurns: 0,
    noProgressTurns: 0,
    lastAutomaticOutputFingerprint: undefined,
    submissionResult: undefined,
    updatedAt: now,
  };
}

export function requestUserAction(
  state: GoalState,
  kind: PendingUserActionKind,
  now = Date.now(),
): GoalState {
  if (state.status === "complete" || state.status === "cancelled") {
    throw new Error(`Cannot ${kind} a ${state.status} Goal.`);
  }
  return {
    ...state,
    pendingUserAction: { kind, requestedAt: now },
    updatedAt: now,
  };
}

export function applyPendingUserAction(state: GoalState, now = Date.now()): GoalState {
  const pending = state.pendingUserAction;
  if (!pending) return state;
  if (pending.kind === "cancel") {
    return {
      ...state,
      status: "cancelled",
      pause: undefined,
      pendingUserAction: undefined,
      updatedAt: now,
    };
  }
  if (pending.kind === "pause") {
    return pauseGoal(
      { ...state, pendingUserAction: undefined },
      { source: "user" },
      now,
    );
  }
  if (!state.approved) throw new Error("An approved Goal is required before editing execution.");
  return {
    ...state,
    status: "refining",
    draft: structuredClone(state.approved),
    pause: undefined,
    pendingUserAction: undefined,
    submissionResult: undefined,
    updatedAt: now,
  };
}

export function pauseGoal(state: GoalState, pause: PauseInfo, now = Date.now()): GoalState {
  if (state.status === "complete" || state.status === "cancelled") {
    throw new Error(`Cannot pause a ${state.status} Goal.`);
  }
  if (pause.source !== "user" && !pause.reason?.trim()) {
    throw new Error(`${pause.source} pauses require a reason.`);
  }
  return {
    ...state,
    status: "paused",
    pause: pause.reason
      ? { source: pause.source, reason: normalizeRequiredText(pause.reason, 4_000, "pause reason") }
      : { source: pause.source },
    pendingUserAction: undefined,
    updatedAt: now,
  };
}

export function resumeGoal(state: GoalState, now = Date.now()): GoalState {
  if (state.status !== "paused" || !state.approved) {
    throw new Error("Only a paused approved Goal can resume.");
  }
  return {
    ...state,
    status: "active",
    pause: undefined,
    pendingUserAction: undefined,
    automaticTurns: 0,
    noProgressTurns: 0,
    lastAutomaticOutputFingerprint: undefined,
    submissionResult: undefined,
    updatedAt: now,
  };
}

export function beginVerification(
  state: GoalState,
  result: string,
  now = Date.now(),
): GoalState {
  if (state.status !== "active" || !state.approved) {
    throw new Error("Only an active approved Goal can enter verification.");
  }
  return {
    ...state,
    status: "verifying",
    submissionResult: normalizeRequiredText(
      result,
      MAX_SUBMISSION_RESULT_LENGTH,
      "submission result",
    ),
    verificationAttempts: state.verificationAttempts + 1,
    updatedAt: now,
  };
}

export function finishVerification(
  state: GoalState,
  result: "pass" | "fail",
  details: string,
  now = Date.now(),
): GoalState {
  if (state.status !== "verifying") throw new Error("No Goal is being verified.");
  const normalizedDetails = normalizeRequiredText(details, 8_000, "verification details");
  return {
    ...state,
    status: result === "pass" ? "complete" : "active",
    lastVerification: { result, details: normalizedDetails },
    updatedAt: now,
  };
}

export function recordActiveRun(
  state: GoalState,
  options: {
    automatic: boolean;
    noProgressTurns?: number;
    lastAutomaticOutputFingerprint?: string;
  },
  now = Date.now(),
): GoalState {
  if (state.status !== "active") return state;
  return {
    ...state,
    iteration: state.iteration + 1,
    automaticTurns: state.automaticTurns + (options.automatic ? 1 : 0),
    noProgressTurns: options.automatic ? (options.noProgressTurns ?? state.noProgressTurns) : state.noProgressTurns,
    lastAutomaticOutputFingerprint: options.automatic
      ? options.lastAutomaticOutputFingerprint
      : state.lastAutomaticOutputFingerprint,
    updatedAt: now,
  };
}

export function serializeGoalState(state: GoalState | undefined): GoalState | null {
  return state ? structuredClone(state) : null;
}

export function loadGoalStateFromSession(ctx: SessionContextLike): GoalState | undefined {
  const entries = ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? [];
  const entry = entries
    .filter((candidate) => candidate.type === "custom" && candidate.customType === GOAL_STATE_ENTRY_TYPE)
    .at(-1);
  if (!entry || entry.data === null) return undefined;
  return normalizeGoalState(entry.data);
}

export function normalizeGoalState(value: unknown): GoalState | undefined {
  if (!isRecord(value) || value.version !== GOAL_STATE_VERSION || !isGoalStatus(value.status)) {
    return undefined;
  }
  try {
    const draft = value.draft === undefined ? undefined : normalizeGoalSpec(value.draft, false);
    const approved = value.approved === undefined ? undefined : normalizeGoalSpec(value.approved);
    const pause = normalizePause(value.pause);
    const pendingUserAction = normalizePendingUserAction(value.pendingUserAction);
    const lastVerification = normalizeLastVerification(value.lastVerification);
    const fingerprint = normalizeFingerprint(value.lastAutomaticOutputFingerprint);
    const submissionResult =
      value.submissionResult === undefined
        ? undefined
        : normalizeRequiredText(
            value.submissionResult,
            MAX_SUBMISSION_RESULT_LENGTH,
            "submission result",
          );
    const state: GoalState = {
      version: GOAL_STATE_VERSION,
      status: value.status,
      ...(draft ? { draft } : {}),
      ...(approved ? { approved } : {}),
      ...(pause ? { pause } : {}),
      ...(pendingUserAction ? { pendingUserAction } : {}),
      iteration: normalizeCounter(value.iteration),
      automaticTurns: normalizeCounter(value.automaticTurns),
      noProgressTurns: normalizeCounter(value.noProgressTurns),
      ...(fingerprint ? { lastAutomaticOutputFingerprint: fingerprint } : {}),
      verificationAttempts: normalizeCounter(value.verificationAttempts),
      ...(submissionResult ? { submissionResult } : {}),
      ...(lastVerification ? { lastVerification } : {}),
      createdAt: normalizeTimestamp(value.createdAt),
      updatedAt: normalizeTimestamp(value.updatedAt),
    };
    if ((state.status === "active" || state.status === "verifying") && !state.approved) return undefined;
    if (state.status === "refining" && !state.draft) return undefined;
    if (state.status === "verifying" && !state.submissionResult) return undefined;
    return state;
  } catch {
    return undefined;
  }
}

export function formatGoalStatus(state: GoalState | undefined): string {
  if (!state) return "Goal empty";
  return `Goal ${state.status}${state.iteration > 0 ? ` #${state.iteration}` : ""}`;
}

function normalizeTextArray(value: unknown, name: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array.`);
  if (value.length > maxItems) throw new Error(`${name} contains too many items.`);
  return value.map((item, index) => normalizeRequiredText(item, maxLength, `${name}[${index}]`));
}

function normalizeRequiredText(value: unknown, maxLength: number, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} cannot be empty.`);
  if (normalized.length > maxLength) throw new Error(`${name} is too long.`);
  return normalized;
}

function normalizeCounter(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function normalizeTimestamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : Date.now();
}

function normalizeFingerprint(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : undefined;
}

function normalizePause(value: unknown): PauseInfo | undefined {
  if (!isRecord(value) || !["user", "agent", "pi"].includes(String(value.source))) return undefined;
  const source = value.source as PauseInfo["source"];
  if (source === "user") {
    return typeof value.reason === "string" && value.reason.trim()
      ? { source, reason: normalizeRequiredText(value.reason, 4_000, "pause reason") }
      : { source };
  }
  return { source, reason: normalizeRequiredText(value.reason, 4_000, "pause reason") };
}

function normalizePendingUserAction(value: unknown): GoalState["pendingUserAction"] {
  if (!isRecord(value) || !["edit", "pause", "cancel"].includes(String(value.kind))) return undefined;
  return {
    kind: value.kind as PendingUserActionKind,
    requestedAt: normalizeTimestamp(value.requestedAt),
  };
}

function normalizeLastVerification(value: unknown): GoalState["lastVerification"] {
  if (!isRecord(value) || (value.result !== "pass" && value.result !== "fail")) return undefined;
  return {
    result: value.result,
    details: normalizeRequiredText(value.details, 8_000, "verification details"),
  };
}

function isGoalStatus(value: unknown): value is GoalStatus {
  return ["refining", "active", "paused", "verifying", "complete", "cancelled"].includes(String(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
