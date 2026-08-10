import { randomUUID } from "node:crypto";
import {
  type ExtensionAPI,
  type SessionEntry,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  Text,
  truncateToWidth,
  type Component,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

export const VERIFICATION_UI_ENTRY_TYPE = "goal-verification-ui-v1";
const MAX_INTERACTIONS = 80;
const MAX_INTERACTION_TEXT_LENGTH = 8_000;
const COLLAPSED_TRACE_BODY_LINES = 4;
const COLLAPSED_DETAILS_LINES = 3;
const EMPTY_COMPONENT: Component = {
  render: () => [],
  invalidate: () => {},
};

export interface VerificationInteraction {
  kind: "request" | "thinking" | "assistant" | "tool-call" | "tool-result";
  label: string;
  text: string;
  isError?: boolean;
}

type VerificationDisplayStatus = "verifying" | "pass" | "fail" | "error";

interface VerificationUiEntryData {
  version: 1;
  operationId: string;
  attempt: number;
  sequence: number;
  event:
    | { kind: "start" }
    | { kind: "interactions"; items: VerificationInteraction[] }
    | {
        kind: "finish";
        status: Exclude<VerificationDisplayStatus, "verifying">;
        details: string;
        interactions?: VerificationInteraction[];
        omittedInteractions?: number;
      };
}

interface VerificationView {
  operationId: string;
  attempt: number;
  sequence: number;
  status: VerificationDisplayStatus;
  interactions: VerificationInteraction[];
  omittedInteractions: number;
  details?: string;
}

export class VerificationUi {
  private readonly views = new Map<string, VerificationView>();

  constructor(private readonly pi: ExtensionAPI) {
    pi.registerEntryRenderer(VERIFICATION_UI_ENTRY_TYPE, (entry, { expanded }, theme) => {
      const data = parseEntryData(entry.data);
      if (!data || data.event.kind !== "start") return EMPTY_COMPONENT;
      return new VerificationEntryComponent(
        () => this.views.get(data.operationId),
        expanded,
        theme,
      );
    });
  }

  restore(entries: readonly SessionEntry[]): void {
    this.views.clear();
    for (const entry of entries) {
      if (entry.type !== "custom" || entry.customType !== VERIFICATION_UI_ENTRY_TYPE) continue;
      const data = parseEntryData(entry.data);
      if (data) this.apply(data);
    }
  }

  start(attempt: number): string {
    const operationId = randomUUID();
    this.append(operationId, attempt, { kind: "start" });
    return operationId;
  }

  addInteractions(operationId: string, items: readonly VerificationInteraction[]): void {
    const normalized = items.map(normalizeInteraction).filter((item) => item.text.length > 0);
    if (normalized.length === 0) return;
    const current = this.views.get(operationId);
    if (!current) return;
    const all = [...current.interactions, ...normalized];
    const overflow = Math.max(0, all.length - MAX_INTERACTIONS);
    this.views.set(operationId, {
      ...current,
      interactions: overflow > 0 ? all.slice(overflow) : all,
      omittedInteractions: current.omittedInteractions + overflow,
    });
  }

  finish(
    operationId: string,
    status: Exclude<VerificationDisplayStatus, "verifying">,
    details: string,
  ): void {
    const current = this.views.get(operationId);
    if (!current) return;
    this.append(operationId, current.attempt, {
      kind: "finish",
      status,
      details: truncateText(details.trim()),
      interactions: current.interactions,
      omittedInteractions: current.omittedInteractions,
    });
  }

  interruptRunning(details: string): void {
    const running = [...this.views.values()]
      .filter((view) => view.status === "verifying")
      .map((view) => view.operationId);
    for (const operationId of running) this.finish(operationId, "error", details);
  }

  private append(
    operationId: string,
    attempt: number,
    event: VerificationUiEntryData["event"],
  ): void {
    const data: VerificationUiEntryData = {
      version: 1,
      operationId,
      attempt,
      sequence: (this.views.get(operationId)?.sequence ?? 0) + 1,
      event,
    };
    this.apply(data);
    this.pi.appendEntry(VERIFICATION_UI_ENTRY_TYPE, data);
  }

  private apply(data: VerificationUiEntryData): void {
    if (data.event.kind === "start") {
      this.views.set(data.operationId, {
        operationId: data.operationId,
        attempt: data.attempt,
        sequence: data.sequence,
        status: "verifying",
        interactions: [],
        omittedInteractions: 0,
      });
      return;
    }

    const current = this.views.get(data.operationId) ?? {
      operationId: data.operationId,
      attempt: data.attempt,
      sequence: 0,
      status: "verifying" as const,
      interactions: [],
      omittedInteractions: 0,
    };
    if (data.sequence <= current.sequence) return;
    if (data.event.kind === "interactions") {
      const all = [...current.interactions, ...data.event.items.map(normalizeInteraction)];
      const overflow = Math.max(0, all.length - MAX_INTERACTIONS);
      this.views.set(data.operationId, {
        ...current,
        sequence: data.sequence,
        interactions: overflow > 0 ? all.slice(overflow) : all,
        omittedInteractions: current.omittedInteractions + overflow,
      });
      return;
    }
    const interactions = data.event.interactions?.map(normalizeInteraction);
    this.views.set(data.operationId, {
      ...current,
      sequence: data.sequence,
      status: data.event.status,
      ...(interactions ? { interactions } : {}),
      ...(data.event.omittedInteractions !== undefined
        ? { omittedInteractions: data.event.omittedInteractions }
        : {}),
      details: truncateText(data.event.details),
    });
  }
}

export function verificationInteractionsFromMessage(message: unknown): VerificationInteraction[] {
  if (!isRecord(message) || typeof message.role !== "string") return [];
  if (message.role === "user") {
    const text = messageText(message.content);
    return text ? [{ kind: "request", label: "Verification request", text }] : [];
  }
  if (message.role === "toolResult") {
    const text = messageText(message.content);
    const name = typeof message.toolName === "string" ? message.toolName : "tool";
    return text
      ? [{
          kind: "tool-result",
          label: `${name} result`,
          text,
          ...(message.isError === true ? { isError: true } : {}),
        }]
      : [];
  }
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];

  const items: VerificationInteraction[] = [];
  for (const block of message.content) {
    if (!isRecord(block) || typeof block.type !== "string") continue;
    if (block.type === "thinking" && typeof block.thinking === "string") {
      items.push({ kind: "thinking", label: "Verifier thinking", text: block.thinking });
    } else if (block.type === "text" && typeof block.text === "string") {
      items.push({ kind: "assistant", label: "Verifier", text: block.text });
    } else if (block.type === "toolCall") {
      const name = typeof block.name === "string" ? block.name : "tool";
      items.push({
        kind: "tool-call",
        label: name,
        text: formatJson(block.arguments),
      });
    }
  }
  return items.map(normalizeInteraction).filter((item) => item.text.length > 0);
}

class VerificationEntryComponent implements Component {
  constructor(
    private readonly getView: () => VerificationView | undefined,
    private readonly expanded: boolean,
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    const view = this.getView();
    return view ? renderVerificationView(view, this.expanded, this.theme).render(width) : [];
  }

  invalidate(): void {}
}

function renderVerificationView(view: VerificationView, expanded: boolean, theme: Theme): Box {
  const background =
    view.status === "verifying"
      ? "toolPendingBg"
      : view.status === "pass"
        ? "toolSuccessBg"
        : "toolErrorBg";
  const title =
    view.status === "verifying"
      ? "Verifying"
      : view.status === "pass"
        ? "Verification pass"
        : view.status === "fail"
          ? "Verification fail"
          : "Verification error";
  const box = new Box(1, 0, (text) => theme.bg(background, text));
  box.addChild(new Text(theme.fg("toolTitle", theme.bold(title)), 0, 0));

  if (view.status !== "verifying") {
    if (view.details) {
      box.addChild(
        expanded
          ? new Text(
              `${theme.fg("toolOutput", theme.bold("Details"))}\n${theme.fg("toolOutput", view.details)}`,
              0,
              1,
            )
          : new DetailsSummaryComponent(view.details, theme),
      );
    }
    return box;
  }

  if (!expanded) {
    const latest = view.interactions.at(-1);
    box.addChild(
      latest
        ? new LatestTraceComponent(latest, theme)
        : new Text(theme.fg("dim", "Waiting for verifier output…"), 0, 0),
    );
    return box;
  }

  box.addChild(new Text(theme.fg("dim", `Attempt #${view.attempt}`), 0, 1));
  if (view.omittedInteractions > 0) {
    box.addChild(
      new Text(
        theme.fg("dim", `${view.omittedInteractions} earlier interactions omitted.`),
        0,
        0,
      ),
    );
  }
  if (view.interactions.length === 0) {
    box.addChild(new Text(theme.fg("dim", "Waiting for verifier output…"), 0, 0));
  } else {
    for (const interaction of view.interactions) {
      box.addChild(
        new Text(
          theme.fg("toolOutput", `${interaction.label}\n${interaction.text}`),
          0,
          1,
        ),
      );
    }
  }
  return box;
}

class LatestTraceComponent implements Component {
  constructor(
    private readonly interaction: VerificationInteraction,
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    const bodyLines = wrapTextWithAnsi(this.interaction.text, Math.max(1, width));
    const omitted = Math.max(0, bodyLines.length - COLLAPSED_TRACE_BODY_LINES);
    const visibleBody = bodyLines.slice(-COLLAPSED_TRACE_BODY_LINES);
    if (omitted > 0 && visibleBody.length > 0) {
      visibleBody[0] = truncateToWidth(`… ${visibleBody[0]}`, Math.max(1, width), "");
    }
    return [
      this.theme.fg("toolOutput", this.interaction.label),
      ...visibleBody.map((line) => this.theme.fg("toolOutput", line)),
    ];
  }

  invalidate(): void {}
}

class DetailsSummaryComponent implements Component {
  constructor(
    private readonly details: string,
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    const contentWidth = Math.max(1, width);
    const lines = wrapTextWithAnsi(this.details, contentWidth);
    const visible = lines.slice(0, COLLAPSED_DETAILS_LINES);
    if (lines.length > COLLAPSED_DETAILS_LINES && visible.length > 0) {
      visible[visible.length - 1] =
        contentWidth === 1
          ? "…"
          : `${truncateToWidth(
              visible[visible.length - 1] ?? "",
              contentWidth - 1,
              "",
            )}…`;
    }
    return visible.map((line) => this.theme.fg("toolOutput", line));
  }

  invalidate(): void {}
}

function parseEntryData(value: unknown): VerificationUiEntryData | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  if (typeof value.operationId !== "string" || !value.operationId) return undefined;
  if (!Number.isInteger(value.attempt) || (value.attempt as number) < 1) return undefined;
  if (!Number.isInteger(value.sequence) || (value.sequence as number) < 1) return undefined;
  if (!isRecord(value.event) || typeof value.event.kind !== "string") return undefined;
  const operationId = value.operationId;
  const attempt = value.attempt as number;
  const sequence = value.sequence as number;
  if (value.event.kind === "start") {
    return { version: 1, operationId, attempt, sequence, event: { kind: "start" } };
  }
  if (value.event.kind === "interactions" && Array.isArray(value.event.items)) {
    const items = value.event.items
      .map(parseInteraction)
      .filter((item): item is VerificationInteraction => item !== undefined);
    return {
      version: 1,
      operationId,
      attempt,
      sequence,
      event: { kind: "interactions", items },
    };
  }
  if (
    value.event.kind === "finish" &&
    (value.event.status === "pass" || value.event.status === "fail" || value.event.status === "error") &&
    typeof value.event.details === "string"
  ) {
    return {
      version: 1,
      operationId,
      attempt,
      sequence,
      event: {
        kind: "finish",
        status: value.event.status,
        details: truncateText(value.event.details),
        ...(Array.isArray(value.event.interactions)
          ? {
              interactions: value.event.interactions
                .map(parseInteraction)
                .filter((item): item is VerificationInteraction => item !== undefined),
            }
          : {}),
        ...(Number.isInteger(value.event.omittedInteractions) &&
        (value.event.omittedInteractions as number) >= 0
          ? { omittedInteractions: value.event.omittedInteractions as number }
          : {}),
      },
    };
  }
  return undefined;
}

function parseInteraction(value: unknown): VerificationInteraction | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.kind !== "request" &&
    value.kind !== "thinking" &&
    value.kind !== "assistant" &&
    value.kind !== "tool-call" &&
    value.kind !== "tool-result"
  ) {
    return undefined;
  }
  if (typeof value.label !== "string" || typeof value.text !== "string") return undefined;
  return normalizeInteraction({
    kind: value.kind,
    label: value.label,
    text: value.text,
    ...(value.isError === true ? { isError: true } : {}),
  });
}

function normalizeInteraction(item: VerificationInteraction): VerificationInteraction {
  return {
    ...item,
    label: truncateText(item.label.trim(), 200),
    text: truncateText(item.text.trim()),
  };
}

function messageText(content: unknown): string {
  if (typeof content === "string") return truncateText(content.trim());
  if (!Array.isArray(content)) return "";
  return truncateText(
    content
      .map((block) => {
        if (!isRecord(block)) return "";
        if (block.type === "text" && typeof block.text === "string") return block.text;
        if (block.type === "image") return "[image]";
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim(),
  );
}

function formatJson(value: unknown): string {
  try {
    return truncateText(JSON.stringify(value ?? {}, null, 2));
  } catch {
    return truncateText(String(value));
  }
}

function truncateText(value: string, maximum = MAX_INTERACTION_TEXT_LENGTH): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
