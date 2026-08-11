# Architecture

## Composition

`src/index.ts` creates one extension-factory-owned `GoalRuntime`, `GoalVerifier`, and `GoalCommandController`. It registers lifecycle handlers first, then the four main-agent tools and `/goal` command.

The implementation keeps one mutable controller per Pi session runtime. Canonical Goal data is immutable at module boundaries: pure transitions in `state.ts` return new objects, and runtime handoffs use structured clones.

## Modules

- `state.ts`: GoalSpec/GoalState types, validation, pure lifecycle transitions, canonical custom-entry restore, and status formatting.
- `prompts.ts`: pure uncertainty-led refinement, execution, continuation, and verifier prompt builders.
- `safety.ts`: visible-output normalization, SHA-256 fingerprints, and no-progress accounting.
- `continuation.ts`: single-flight intent/delivery controller and cancellation interception.
- `runtime.ts`: current state, run ownership, transient intents, settled dispatch decisions, persistence, and concise statusline updates.
- `commands.ts`: `/goal` parsing, command registration, pending user actions, panel orchestration, and kickoff delivery.
- `ui.ts`: centered scrollable Goal Control overlay, direct external GoalSpec editing with validation and relaunch, keyboard controls, and status output.
- `tools.ts`: `goal_propose`, `goal_submit`, `goal_pause`, and `goal_resume` adapters plus compact/expanded proposal and submitted-result rendering.
- `verifier.ts`: isolated in-memory AgentSession, finalized interaction observation, and terminal verifier result tool.
- `verification-ui.ts`: bounded verifier transcript projection, append-only start/final display entries, and compact/expanded entry rendering.
- `lifecycle.ts`: Pi event bindings, branch-navigation restoration, and execution of runtime effects.
- `index.ts`: extension entrypoint and composition root.

## Canonical state and transient ownership

`goal-state-v1` custom entries contain only the current Goal state. The latest entry on the active session branch wins. The model has no Goal identity, run-generation, or revision field.

Pending user edit, pause, and cancel requests are canonical because they are explicit user decisions that must survive reload. Every `verifying` entry must contain `submissionResult`; normalization rejects entries that violate this invariant. The exact submitted result is canonical while verification is running so a resumed fresh verifier receives the same user-visible content. Agent proposal/submission/pause/resume intents, continuation tickets, verifier operation ownership, and panel ownership are transient. Losing a transient intent during process shutdown leaves the Goal in its prior safe state; the agent can repeat the lifecycle call in a later turn.

`session_tree` reloads canonical and observational state from the newly selected branch and clears transient ownership without writing the previous branch's in-memory state at the new leaf. Empty branches clear the Goal statusline. Refining state is restored unchanged. Active state stays idle until the user's next message completes, after which the normal automatic continuation loop resumes. Verifying state becomes a persisted Pi pause and any restored running verifier card settles as an interruption; tree navigation never restarts a historical verifier.

`goal-verification-ui-v1` custom entries are observational state. A start entry anchors one visible verifier card. Finalized interactions update its in-memory projection and request a TUI render; one invisible final snapshot preserves the bounded transcript and result for reload. An observational operation ID prevents attempt-number collisions between successive Goals; it is not Goal or run identity and never enters GoalState, prompts, tools, statusline, or the Control Panel. These entries never participate in Goal restoration or model context.

A continuation ticket has an internal delivery marker so a queued extension message can be intercepted after a user transition cancels it. The marker owns only that message delivery. It is never placed in GoalState, tool parameters, the Control Panel, or verifier context.

## Settled ordering

The main-session ordering is:

1. `before_agent_start` classifies the run as refining or active and injects the corresponding Goal prompt. Refinement identifies material uncertainties, self-discovers available facts, asks dependency-aware numbered question rounds, avoids exhaustive grilling, and proposes once remaining uncertainty cannot affect execution or acceptance.
2. Goal tools record proposal, terminal, or paused-state resume intent.
3. `/goal edit`, pause, or cancel during work persists `pendingUserAction` without changing status.
4. `agent_end` records run outcome, iteration, and automatic-progress observations.
5. `agent_settled` commits exactly one ordered decision:
   - pending user action;
   - proposal or agent pause, resume, or submission intent;
   - Pi interruption/safety pause;
   - automatic continuation.

Fresh verifier settlement uses the same user-first rule. A verifier result is held in its fresh session closure. The main `agent_settled` extension dispatch awaits the fresh verifier, so verification remains part of the owning Goal run and a successful run is not externally settled before verification completes. After `session.prompt()` fully resolves, the main controller first applies any pending user action, then commits pass/fail; a fail queues worker feedback before execution resumes.

## Independent verifier boundary

The verifier uses `DefaultResourceLoader` with extensions, skills, prompt templates, themes, and context files disabled. Its `SessionManager` is in-memory, so no verifier conversation is attached to the worker session.

The verifier receives the approved GoalSpec and exact user-visible `goal_submit.result`; it does not receive the rest of the worker transcript. Its complete tool allowlist is `read`, `bash`, and `goal_verification_result`. `bash` already covers search, listing, commands, tests, builds, temporary probes, and project-specific CLIs, so dedicated `edit`, `write`, `grep`, `find`, and `ls` wrappers are omitted. The strict investigation-only prompt remains a behavioral boundary because bash itself is mutation-capable; this is not a security sandbox.

The verifier session publishes only finalized message events to the display projection. This makes its request, reasoning text, tool calls, and tool results observable without exposing the worker transcript to the verifier or injecting the verifier transcript into either model context. A verifier operation is owned by its controller object. Session shutdown marks it aborted, calls `abort()`, disposes the session, and ignores its eventual promise completion.

## UI invariants

- The Control Panel is a centered overlay with a bounded viewport and line/page scrolling.
- In TUI mode, Edit directly launches Pi's configured external-editor command; valid JSON updates the draft, invalid JSON reopens in the external editor, and launch or exit failure preserves the draft. Non-TUI UI keeps Pi's editor dialog as a compatibility path.
- A collapsed `goal_propose` result shows the main goal; expansion adds every subtask and detail before a dim status note.
- A collapsed `goal_submit` result shows at most four width-aware lines and ends truncated content with an ellipsis; expansion shows the complete unchanged result, which remains identical to verifier input.
- Verification has one built-in-tool-call-style transcript card per attempt. Its title is `Verifying` over the pending-tool background while running; collapsed output directly tails the latest body-styled trace item, and expanded output shows the complete bounded body-styled trace. After settlement, the title becomes `Verification pass`, `Verification fail`, or `Verification error`; pass uses the successful-tool background, while fail/error use the red failed-tool background. Collapsed output shows a three-line details summary, expanded output shows complete details, and neither mode shows the trace.
- The final verification snapshot renders no row; the start-entry component reads the latest projection so completion updates the original card.
- Goal content is not persisted above the input editor; only the concise `Goal <status> [#N]` statusline remains.
- Every committed transition to `paused` emits a transcript warning. Agent and Pi pauses include the canonical reason; a reasonless user pause is labeled as user-requested.
- `goal_resume` accepts every paused Goal regardless of pause source, commits at the caller's settled boundary, and requests normal continuation without creating an agent wake-up while idle.
- No Control Panel state has a Cancel button.
- `/goal cancel` is the only user cancellation entry.
- Refining `Esc` resolves to the same `refine` action as **Refine with agent**.
- Active and verifying GoalSpec views are read-only; only `/goal edit` can request a change.
- A refining panel opened during a running main-agent turn is also read-only; Start/Edit appear only after the run settles.
- UI callbacks call runtime transitions or register pending actions. They never write Goal status directly.
