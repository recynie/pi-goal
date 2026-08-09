import {
  defineTool,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Text,
  truncateToWidth,
  type Component,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { GoalRuntime } from "./runtime.js";
import {
  MAX_SUBMISSION_RESULT_LENGTH,
  normalizeGoalSpec,
  type GoalSpec,
} from "./state.js";

const MAX_REASON_LENGTH = 4_000;
const COLLAPSED_SUBMISSION_RESULT_LINES = 4;

export function registerGoalTools(pi: ExtensionAPI, runtime: GoalRuntime): void {
  pi.registerTool(
    defineTool({
      name: "goal_propose",
      label: "Propose Goal",
      description:
        "Submit the complete GoalSpec after refining it with the user. This records a draft for user review; it does not start execution.",
      promptSnippet: "Submit a complete GoalSpec for user review while /goal is refining",
      promptGuidelines: [
        "Use goal_propose only while refining a /goal, after necessary questions are resolved.",
        "Every goal_propose subtask must describe a result that can be independently verified.",
        "Put constraints, assumptions, scope, and other execution or acceptance information in goal_propose details.",
      ],
      parameters: Type.Object({
        mainGoal: Type.String({ minLength: 1, maxLength: 4_000 }),
        subtasks: Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), {
          minItems: 1,
          maxItems: 100,
        }),
        details: Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), {
          maxItems: 100,
        }),
      }),
      async execute(_toolCallId, params) {
        const draft = normalizeGoalSpec(params);
        runtime.propose(draft);
        return {
          content: [
            {
              type: "text",
              text: "Goal draft recorded. The user will review it after this run settles.",
            },
          ],
          details: { draft },
          terminate: true,
        };
      },
      renderCall(_args, theme) {
        return new Text(theme.fg("toolTitle", theme.bold("Propose Goal")), 0, 0);
      },
      renderResult(result, { expanded }, theme) {
        const details = result.details as { draft?: GoalSpec } | undefined;
        if (!details?.draft) {
          const text = result.content.find((item) => item.type === "text");
          return new Text(text?.type === "text" ? text.text : "", 0, 0);
        }
        const draft = details.draft;
        const lines = [theme.fg("toolOutput", draft.mainGoal)];
        if (expanded) {
          lines.push("", theme.fg("accent", theme.bold("Subtasks")));
          lines.push(
            ...draft.subtasks.map(
              (subtask, index) => `${theme.fg("accent", `${index + 1}.`)} ${theme.fg("toolOutput", subtask)}`,
            ),
          );
          lines.push("", theme.fg("accent", theme.bold("Details")));
          lines.push(
            ...(draft.details.length
              ? draft.details.map((detail) => `${theme.fg("dim", "-")} ${theme.fg("toolOutput", detail)}`)
              : [theme.fg("dim", "(none)")]),
          );
        }
        lines.push(
          "",
          theme.fg(
            "dim",
            "Goal draft recorded. The review popup opens after this run settles.",
          ),
        );
        return new Text(lines.join("\n"), 0, 0);
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "goal_submit",
      label: "Submit Goal Result",
      description:
        "Submit the exact final result shown to the user for independent verification. This does not complete the Goal directly.",
      promptSnippet: "Submit the exact final Goal result for independent verification",
      promptGuidelines: [
        "Keep working on an active /goal until every approved requirement is complete.",
        "Call goal_submit only after checking the whole Goal against authoritative evidence.",
        "The result must be the complete final result intended for the user; the verifier receives exactly the same content.",
        "goal_submit starts independent verification; it never marks the Goal complete by itself.",
      ],
      parameters: Type.Object({
        result: Type.String({
          minLength: 1,
          maxLength: MAX_SUBMISSION_RESULT_LENGTH,
          description:
            "The exact final result to show the user and submit unchanged to the independent verifier.",
        }),
      }),
      async execute(_toolCallId, params) {
        const result = params.result.trim();
        runtime.submit(result);
        return {
          content: [{ type: "text", text: result }],
          details: { result },
          terminate: true,
        };
      },
      renderResult(result, { expanded }, theme) {
        const details = result.details as { result?: string } | undefined;
        const content = result.content.find((item) => item.type === "text");
        const submittedResult =
          details?.result ?? (content?.type === "text" ? content.text : "");
        return expanded
          ? new Text(theme.fg("toolOutput", submittedResult), 0, 0)
          : new CollapsedSubmissionResult(submittedResult, theme);
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "goal_pause",
      label: "Pause Goal",
      description:
        "Request a pause when user or external action is required. Ordinary difficulty or a recoverable failure is not a reason to pause.",
      promptSnippet: "Pause an active Goal with a concrete reason when external action is required",
      promptGuidelines: [
        "Use goal_pause only when the active /goal cannot continue without user or external action.",
        "Do not use goal_pause for ordinary difficulty, incomplete work, or a recoverable command failure.",
      ],
      parameters: Type.Object({
        reason: Type.String({
          minLength: 1,
          maxLength: MAX_REASON_LENGTH,
          description: "The concrete user or external action required before work can continue.",
        }),
      }),
      async execute(_toolCallId, params) {
        const reason = params.reason.trim();
        runtime.pauseFromAgent(reason);
        return {
          content: [{ type: "text", text: "Pause intent recorded for the settled boundary." }],
          details: { reason },
          terminate: true,
        };
      },
    }),
  );
}

class CollapsedSubmissionResult implements Component {
  constructor(
    private readonly result: string,
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    const contentWidth = Math.max(1, width);
    const lines = wrapTextWithAnsi(this.result, contentWidth);
    const visible = lines.slice(0, COLLAPSED_SUBMISSION_RESULT_LINES);
    if (lines.length > COLLAPSED_SUBMISSION_RESULT_LINES && visible.length > 0) {
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
