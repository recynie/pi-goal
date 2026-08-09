import { createHash } from "node:crypto";

export const DEFAULT_AUTOMATIC_TURN_LIMIT = 25;
export const DEFAULT_NO_PROGRESS_LIMIT = 3;

interface MessageLike {
  role?: unknown;
  content?: unknown;
}

interface ContentLike {
  type?: unknown;
  text?: unknown;
}

export interface AutomaticProgress {
  noProgressTurns: number;
  fingerprint?: string;
}

export function nextAutomaticProgress(
  previousFingerprint: string | undefined,
  previousCount: number,
  messages: readonly unknown[],
  toolAttempted: boolean,
): AutomaticProgress {
  if (toolAttempted || hasToolCall(messages)) return { noProgressTurns: 0 };
  const fingerprint = fingerprintAssistantOutput(messages);
  const noProgressTurns = !fingerprint || fingerprint === previousFingerprint ? previousCount + 1 : 1;
  return fingerprint ? { noProgressTurns, fingerprint } : { noProgressTurns };
}

export function fingerprintAssistantOutput(messages: readonly unknown[]): string | undefined {
  const text = messages
    .filter(isMessageLike)
    .filter((message) => message.role === "assistant")
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter(isContentLike)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("\n");
  const normalized = normalizeVisibleText(text);
  if (!normalized) return undefined;
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

export function hasToolCall(messages: readonly unknown[]): boolean {
  return messages
    .filter(isMessageLike)
    .filter((message) => message.role === "assistant")
    .some(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some((part) => isContentLike(part) && part.type === "toolCall"),
    );
}

export function normalizeVisibleText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{C}\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function isMessageLike(value: unknown): value is MessageLike {
  return typeof value === "object" && value !== null;
}

function isContentLike(value: unknown): value is ContentLike {
  return typeof value === "object" && value !== null;
}
