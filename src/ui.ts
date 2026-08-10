import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SettingsManager,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  type Component,
  type TUI,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { GoalRuntime } from "./runtime.js";
import { formatGoalSpec } from "./prompts.js";
import {
  formatGoalStatus,
  normalizeGoalSpec,
  type GoalSpec,
  type GoalState,
} from "./state.js";

export type GoalPanelAction = "start" | "edit" | "refine" | "pause" | "resume" | "close";

export async function showGoalControlPanel(
  runtime: GoalRuntime,
  ctx: ExtensionContext,
): Promise<GoalPanelAction> {
  if (!runtime.state) {
    ctx.ui.notify("No current Goal. Start one with /goal <main goal>.", "info");
    return "close";
  }
  if (ctx.mode !== "tui") {
    showGoalStatus(runtime, ctx);
    return "close";
  }

  return ctx.ui.custom<GoalPanelAction>(
    (tui, theme, _keybindings, done) =>
      new GoalControlOverlay(
        tui,
        theme,
        runtime,
        () => !ctx.isIdle() || Boolean(runtime.currentRun),
        done,
      ),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "92%",
        minWidth: 44,
        maxHeight: "90%",
        margin: 1,
      },
    },
  );
}

export async function editGoalDraft(runtime: GoalRuntime, ctx: ExtensionContext): Promise<boolean> {
  const draft = runtime.state?.draft;
  if (!draft) throw new Error("No Goal draft is available to edit.");
  let prefill = `${JSON.stringify(draft, null, 2)}\n`;

  while (true) {
    const value =
      ctx.mode === "tui"
        ? await showGoalExternalEditor(ctx, prefill)
        : await ctx.ui.editor("Edit GoalSpec JSON", prefill);
    if (value === undefined) return false;

    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      ctx.ui.notify(`Invalid GoalSpec JSON: ${formatError(error)}`, "error");
      if (ctx.mode !== "tui") return false;
      prefill = value;
      continue;
    }

    try {
      runtime.setDraft(normalizeGoalSpec(parsed), ctx);
      return true;
    } catch (error) {
      ctx.ui.notify(formatError(error), "error");
      if (ctx.mode !== "tui") return false;
      prefill = value;
    }
  }
}

export type ExternalGoalEditorResult =
  | { status: "complete"; content: string }
  | { status: "failed"; reason: string };

export async function runExternalGoalEditor(
  command: string,
  content: string,
): Promise<ExternalGoalEditorResult> {
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "pi-goal-editor-"));
    const filePath = join(directory, "goal.json");
    await writeFile(filePath, content, "utf8");

    const [editor, ...editorArgs] = command.split(" ");
    if (!editor) return { status: "failed", reason: "No external editor command is configured." };

    process.stdout.write(`Launching external editor: ${command}\nPi will resume when the editor exits.\n`);
    const outcome = await new Promise<{ code: number | null; error?: string }>((resolve) => {
      const child = spawn(editor, [...editorArgs, filePath], {
        stdio: "inherit",
        shell: process.platform === "win32",
      });
      child.once("error", (error) => resolve({ code: null, error: formatError(error) }));
      child.once("close", (code) => resolve({ code }));
    });

    if (outcome.error) {
      return {
        status: "failed",
        reason: `Could not launch external editor "${command}": ${outcome.error}`,
      };
    }
    if (outcome.code !== 0) {
      return {
        status: "failed",
        reason: `External editor exited with code ${outcome.code ?? "unknown"}.`,
      };
    }
    return { status: "complete", content: await readFile(filePath, "utf8") };
  } catch (error) {
    return { status: "failed", reason: `External editor failed: ${formatError(error)}` };
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function showGoalExternalEditor(
  ctx: ExtensionContext,
  prefill: string,
): Promise<string | undefined> {
  const command = SettingsManager.create(ctx.cwd, undefined, {
    projectTrusted: ctx.isProjectTrusted(),
  }).getExternalEditorCommand();
  const result = await ctx.ui.custom<ExternalGoalEditorResult>(
    (tui, _theme, _keybindings, done) => {
      const launcher = new ExternalGoalEditorLauncher(tui, command, prefill, done);
      queueMicrotask(() => void launcher.open());
      return launcher;
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "60%",
        minWidth: 44,
        maxHeight: 5,
        margin: 1,
      },
    },
  );
  if (result.status === "failed") {
    ctx.ui.notify(result.reason, "error");
    return undefined;
  }
  return result.content;
}

class ExternalGoalEditorLauncher implements Component {
  private opened = false;

  constructor(
    private readonly tui: TUI,
    private readonly command: string,
    private readonly content: string,
    private readonly done: (result: ExternalGoalEditorResult) => void,
  ) {}

  async open(): Promise<void> {
    if (this.opened) return;
    this.opened = true;
    let result: ExternalGoalEditorResult;
    try {
      this.tui.stop();
      result = await runExternalGoalEditor(this.command, this.content);
    } catch (error) {
      result = { status: "failed", reason: `External editor failed: ${formatError(error)}` };
    } finally {
      this.tui.start();
    }
    this.done(result);
    this.tui.requestRender(true);
  }

  render(width: number): string[] {
    return [truncateToWidth("Opening external Goal editor…", width)];
  }

  invalidate(): void {}
}

export function showGoalStatus(runtime: GoalRuntime, ctx: ExtensionContext): void {
  const state = runtime.state;
  const text = state ? panelLines(runtime).join("\n") : "Goal empty";
  if (!ctx.hasUI) throw new Error(text);
  ctx.ui.notify(text, "info");
}

export function serializeGoalForDisplay(spec: GoalSpec | undefined): string {
  return spec ? formatGoalSpec(spec) : "No GoalSpec is available.";
}

export function goalPanelEscapeAction(state: GoalState | undefined): "refine" | "close" {
  return state?.status === "refining" ? "refine" : "close";
}

export function goalPanelActions(
  state: GoalState | undefined,
  mainRunBusy: boolean,
): GoalPanelAction[] {
  if (!state) return [];
  if (state.status === "refining") {
    if (mainRunBusy) return ["refine"];
    return [
      ...(state.draft && state.draft.subtasks.length > 0 ? (["start"] as const) : []),
      "edit",
      "refine",
    ];
  }
  if (state.status === "active" || state.status === "verifying") return ["pause"];
  if (state.status === "paused") return ["resume", "edit", "refine"];
  return [];
}

export function goalPanelLayout(
  contentLength: number,
  terminalRows: number,
): { viewport: number; showIndicator: boolean; maxRows: number } {
  const rows = Number.isFinite(terminalRows) ? Math.max(0, Math.floor(terminalRows)) : 30;
  const maxRows = Math.max(6, Math.floor(rows * 0.9));
  const withoutIndicator = Math.max(1, maxRows - 3);
  if (contentLength <= withoutIndicator) {
    return { viewport: contentLength, showIndicator: false, maxRows };
  }
  return { viewport: Math.max(1, maxRows - 4), showIndicator: true, maxRows };
}

class GoalControlOverlay implements Component {
  private scroll = 0;
  private viewport = 1;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly runtime: GoalRuntime,
    private readonly mainRunBusy: () => boolean,
    private readonly done: (action: GoalPanelAction) => void,
  ) {}

  render(width: number): string[] {
    const innerWidth = Math.max(10, width - 2);
    const content = panelContent(this.runtime, innerWidth);
    const layout = goalPanelLayout(content.length, this.tui.terminal.rows);
    this.viewport = layout.viewport;
    this.scroll = Math.min(this.scroll, Math.max(0, content.length - this.viewport));
    const visible = content.slice(this.scroll, this.scroll + this.viewport);
    const lines = [topBorder(this.theme, "Goal control", width)];
    for (const line of visible) lines.push(boxLine(this.theme, line, innerWidth));
    if (layout.showIndicator) {
      const end = Math.min(content.length, this.scroll + this.viewport);
      lines.push(
        boxLine(
          this.theme,
          this.theme.fg("dim", `↑↓/PgUp/PgDn scroll  ${this.scroll + 1}-${end}/${content.length}`),
          innerWidth,
        ),
      );
    }
    lines.push(boxLine(this.theme, this.theme.fg("dim", panelHelp(this.runtime.state, this.mainRunBusy())), innerWidth));
    lines.push(bottomBorder(this.theme, width));
    return lines;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.scroll = Math.max(0, this.scroll - 1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.scroll += 1;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "pageUp")) {
      this.scroll = Math.max(0, this.scroll - this.viewport);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "pageDown")) {
      this.scroll += this.viewport;
      this.tui.requestRender();
      return;
    }

    const state = this.runtime.state;
    const actions = goalPanelActions(state, this.mainRunBusy());
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.done(goalPanelEscapeAction(state));
      return;
    }
    if (matchesKey(data, Key.enter) && actions.includes("start")) {
      this.done("start");
      return;
    }
    if (data.toLowerCase() === "e" && actions.includes("edit")) {
      this.done("edit");
      return;
    }
    if (data.toLowerCase() === "r" && actions.includes("refine")) {
      this.done("refine");
      return;
    }
    if (data.toLowerCase() === "p") {
      if (actions.includes("pause")) this.done("pause");
      else if (actions.includes("resume")) this.done("resume");
    }
  }

  invalidate(): void {}
}

function panelContent(runtime: GoalRuntime, width: number): string[] {
  const state = runtime.state;
  if (!state) return ["Goal empty"];
  const lines: string[] = [];
  section(lines, "Status", panelMetadata(runtime), width);
  const spec = state.draft ?? state.approved;
  if (spec) {
    section(lines, "Main goal", [spec.mainGoal], width);
    section(
      lines,
      "Subtasks",
      spec.subtasks.length
        ? spec.subtasks.map((subtask, index) => `${index + 1}. ${subtask}`)
        : ["(none yet)"],
      width,
    );
    section(lines, "Details", spec.details.length ? spec.details.map((detail) => `- ${detail}`) : ["(none)"], width);
  }
  if (state.submissionResult) section(lines, "Submitted result", [state.submissionResult], width);
  if (state.lastVerification) {
    section(
      lines,
      `Latest verification: ${state.lastVerification.result}`,
      [state.lastVerification.details],
      width,
    );
  }
  return lines.length ? lines : ["Goal has no displayable content."];
}

function panelMetadata(runtime: GoalRuntime): string[] {
  const state = runtime.state;
  if (!state) return ["Goal empty"];
  return [
    formatGoalStatus(state),
    `Agent: ${runtime.verifierRunning ? "verifier running" : runtime.currentRun ? "main agent running" : "idle"}`,
    `Automatic turns: ${state.automaticTurns}`,
    `Verification attempts: ${state.verificationAttempts}`,
    ...(state.pendingUserAction ? [`Pending action: ${state.pendingUserAction.kind}`] : []),
    ...(state.pause
      ? [`Pause: ${state.pause.source}${state.pause.reason ? ` — ${state.pause.reason}` : ""}`]
      : []),
  ];
}

function panelLines(runtime: GoalRuntime): string[] {
  const state = runtime.state;
  if (!state) return ["Goal empty"];
  return [
    ...panelMetadata(runtime),
    "",
    serializeGoalForDisplay(state.draft ?? state.approved),
    ...(state.submissionResult ? ["", "Submitted result:", state.submissionResult] : []),
    ...(state.lastVerification
      ? ["", `Latest verification: ${state.lastVerification.result}`, state.lastVerification.details]
      : []),
    "",
    "Cancellation is available only through /goal cancel.",
  ];
}

function panelHelp(state: GoalState | undefined, mainRunBusy: boolean): string {
  const actions = goalPanelActions(state, mainRunBusy);
  return [
    ...(actions.includes("start") ? ["Enter start"] : []),
    ...(actions.includes("edit") ? ["E external edit"] : []),
    ...(actions.includes("refine") ? ["R refine"] : []),
    ...(actions.includes("pause") ? ["P pause"] : []),
    ...(actions.includes("resume") ? ["P resume"] : []),
    state?.status === "refining" ? "Esc refine" : "Esc close",
  ].join("  •  ");
}

function section(lines: string[], title: string, values: string[], width: number): void {
  if (lines.length) lines.push("");
  lines.push(title);
  for (const value of values) {
    for (const line of wrapBlock(value, Math.max(8, width - 2))) lines.push(`  ${line}`);
  }
}

function wrapBlock(value: string, width: number): string[] {
  return value.split("\n").flatMap((line) => (line ? wrapTextWithAnsi(line, width) : [""]));
}

function topBorder(theme: Theme, title: string, width: number): string {
  const inner = Math.max(1, width - 2);
  const label = truncateToWidth(` ${title} `, inner, "");
  const fill = "─".repeat(Math.max(0, inner - visibleWidth(label)));
  return theme.fg("border", "╭") + theme.fg("accent", label) + theme.fg("border", `${fill}╮`);
}

function bottomBorder(theme: Theme, width: number): string {
  return theme.fg("border", `╰${"─".repeat(Math.max(1, width - 2))}╯`);
}

function boxLine(theme: Theme, text: string, width: number): string {
  const clipped = truncateToWidth(text, width, "…", true);
  const padding = " ".repeat(Math.max(0, width - visibleWidth(clipped)));
  return theme.fg("border", "│") + clipped + padding + theme.fg("border", "│");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
