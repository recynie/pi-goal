import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildContinuationPrompt } from "./prompts.js";

const MARKER_PREFIX = "<!-- pi-goal-continuation:";
const MARKER_PATTERN = /<!-- pi-goal-continuation:([a-f0-9-]+) -->/u;
const MAX_CANCELLED = 20;

export interface ContinuationTicket {
  marker: string;
  prompt: string;
}

export class ContinuationController {
  private intent: ContinuationTicket | undefined;
  private delivery: ContinuationTicket | undefined;
  private readonly cancelled = new Set<string>();

  request(): boolean {
    if (this.intent || this.delivery) return false;
    const marker = randomUUID();
    this.intent = {
      marker,
      prompt: `${buildContinuationPrompt()}\n${MARKER_PREFIX}${marker} -->`,
    };
    return true;
  }

  hasWork(): boolean {
    return Boolean(this.intent || this.delivery);
  }

  dispatch(pi: Pick<ExtensionAPI, "sendUserMessage">, ctx: Pick<ExtensionContext, "isIdle" | "hasPendingMessages">): boolean {
    const ticket = this.intent;
    if (!ticket || !ctx.isIdle() || ctx.hasPendingMessages()) return false;
    this.intent = undefined;
    this.delivery = ticket;
    try {
      pi.sendUserMessage(ticket.prompt, { deliverAs: "followUp" });
      return true;
    } catch {
      if (this.delivery === ticket) this.delivery = undefined;
      this.intent = ticket;
      return false;
    }
  }

  claimPrompt(prompt: string): boolean {
    const marker = extractContinuationMarker(prompt);
    if (!marker || this.delivery?.marker !== marker) return false;
    this.delivery = undefined;
    return true;
  }

  consumeCancelledPrompt(prompt: string): boolean {
    const marker = extractContinuationMarker(prompt);
    return marker ? this.cancelled.delete(marker) : false;
  }

  cancel(): void {
    if (this.delivery) {
      this.cancelled.add(this.delivery.marker);
      while (this.cancelled.size > MAX_CANCELLED) {
        const oldest = this.cancelled.values().next().value;
        if (oldest) this.cancelled.delete(oldest);
      }
    }
    this.intent = undefined;
    this.delivery = undefined;
  }

  reset(): void {
    this.intent = undefined;
    this.delivery = undefined;
    this.cancelled.clear();
  }
}

export function extractContinuationMarker(prompt: string): string | undefined {
  return MARKER_PATTERN.exec(prompt)?.[1];
}
