# Testing

The project uses short feedback loops. Run the closest test after each module change, then run the complete check before moving to another lifecycle area.

## Automated checks

```bash
npm run typecheck
npm test
npm run check
```

The Node test runner executes TypeScript through `tsx`.

Current coverage includes:

- GoalSpec validation and approval;
- pending user-action settlement;
- pause/resume safety reset;
- pass/fail verification transitions and verifier-held lifecycle dispatch until settlement;
- branch-aware canonical state restore;
- uncertainty-led refinement prompt boundaries, proportional questioning, self-discovered facts, and dependency-aware rounds;
- no-progress fingerprints;
- continuation single-flight, pending-message gating, and cancelled delivery interception;
- user edit precedence over worker submission;
- verifier user-action precedence;
- `/goal` parsing and completion;
- Goal editor overlay persistence, compact/expanded `goal_propose` rendering, and four-line collapsed versus complete expanded `goal_submit` rendering;
- verifier-message projection, rolling collapsed traces, complete expanded traces, settled details-only rendering, width-aware detail summaries, same-card completion rerendering, and display restoration;
- the verifier's exact `read`, `bash`, and `goal_verification_result` tool allowlist;
- real Pi resource-loader smoke loading of `src/index.ts`, `/goal`, all three tools, and the verifier entry renderer.

## Isolated Pi launch

Use Pi's explicit extension flag while disabling discovered extensions:

```bash
pi -ne -e ./src/index.ts --no-session
```

The useful manual sequence is:

1. Run `/goal status` and confirm the extension reports an empty Goal.
2. Run `/goal <small test goal>` and confirm the main agent refines without implementing: it lists only material uncertainties as concise numbered questions, investigates discoverable facts itself, and avoids exhaustive questioning.
3. Let the agent call `goal_propose` and confirm the panel opens only after settlement.
4. Press `Esc`; confirm the panel returns to chat and preserves the draft.
5. Reopen bare `/goal`; confirm there is no Cancel button.
6. Press `E`; confirm JSON editing remains in a centered popup. Press `Ctrl+G`; confirm the configured external editor opens with the same JSON and returns to the popup. Submit an edit, Start, and confirm active execution begins.
7. During execution run `/goal edit`; confirm the panel does not mutate until the agent settles.
8. Resume execution and let the worker call `goal_submit({ result })`; for a long result, confirm collapsed output is limited to four wrapped lines with an ellipsis and expansion shows the complete exact result. Confirm a white, tool-call-styled **Verifier** title appears after settlement. While it runs, collapsed output must directly tail the latest body-styled trace item without a verifying label; expanded output must show the complete bounded body-styled trace.
9. Confirm the same card emphasizes yellow **PASS** or red **FAIL**/**ERROR** when the verifier settles. Collapsed output must show a width-aware, three-line `details` summary; expanded output must show complete `details`; neither settled view may retain the verifier trace.
10. Run `/goal cancel`; confirm cancellation works without any panel action.

A named tmux session is convenient for repeatable TUI inspection:

```bash
tmux new-session -s pi-goal-test 'cd /path/to/pi-goal && pi -ne -e ./src/index.ts --no-session'
tmux capture-pane -pt pi-goal-test
```

Stop the test session when finished:

```bash
tmux kill-session -t pi-goal-test
```

## Verifier testing

A full verifier test calls the configured model and can consume provider quota. Keep automated tests deterministic by testing runtime settlement with synthetic verifier outcomes. Use a small real workspace Goal for final integration testing.

A real verifier pass should show all of these properties:

- a fresh context with no worker transcript;
- the approved GoalSpec and workspace path;
- exactly `read`, `bash`, and `goal_verification_result`;
- no `edit`, `write`, `grep`, `find`, `ls`, or Goal lifecycle tools;
- pass/fail applied only after the fresh session settles.

## Recorded live smoke

The initial implementation was exercised with Pi 0.84.1 using:

```bash
PI_OFFLINE=1 pi -ne -e ./src/index.ts --no-session
```

The initial implementation run covered an empty status, agent-assisted refinement, a structured `goal_propose`, automatic Control Panel opening after settlement, refining `Esc` returning to chat, panel reopening, Start, workspace edits and `npm run check`, a worker submission, a fresh independent verifier, a structured verifier pass, and final `complete` status.

After the submission/UI redesign, a second live run used a conversation-only two-sentence deliverable. It confirmed the centered overlay at normal terminal size, a bounded viewport and `1-14/22` → `9-22/22` PageDown movement after resizing to 100×20, keyboard Start, no above-editor widget, `Goal refining` → `Goal verifying #1` → `Goal complete #1`, exact `goal_submit.result` rendering in the main conversation, and a fresh verifier pass whose details explicitly assessed that same 33-word result.

A third live TUI run verified the editing and proposal-display fixes. Collapsed `goal_propose` output showed only the proposed main goal plus a dim status note; `Ctrl+O` expanded the same row to all subtasks and details. `E` opened a centered JSON editor overlay, `Ctrl+G` launched the configured `nvim` with the same draft, quitting `nvim` restored the popup editor, and `Esc` returned to the refreshed Goal Control Panel.

A fourth live run verified the initial observable verifier card with a conversation-only deliverable. A fifth live run verified the refined card in a 100×28 terminal: the fixed **Verifier** title and rolling latest-trace viewport appeared while collapsed and running; `Ctrl+O` exposed the complete request, thinking, tool call, and tool result trace; settlement rerendered the same card as **PASS** with a details summary; expanding it showed complete details and no trace. A sixth live run verified the style refinement: ANSI capture showed the **Verifier** title using the same white tool-title color as built-in calls and **PASS** using yellow emphasis; the running collapsed card omitted the redundant status label and rendered its latest trace as ordinary body text. FAIL/ERROR red styling is covered by renderer tests. A seventh live run submitted a six-line checklist in a 90×26 terminal: collapsed `goal_submit` output showed four lines ending in `Test…`, and `Ctrl+O` restored all six lines through `Release` without changing verifier input. An eighth live run exercised the uncertainty-led refinement prompt with `/goal Add a way to export Goal status`: the agent first inspected existing status commands, UI, state, and docs, then presented four numbered material uncertainties covering destination, format/content, intended use, and export-only versus import scope. It did not implement or ask the user for discoverable repository facts. In-memory progress updates and the invisible final snapshot produced no duplicate status cards.

A later user-session investigation explained an apparent `Ctrl+G` failure. Physical input reached the popup as Kitty sequence `ESC [ 103;5u`, Pi recognized it as `Ctrl+G`, and the TUI briefly stopped and resumed. The affected Pi process had resolved `$EDITOR` to `vim`, but `vim` was absent from its `PATH`; spawning the editor therefore failed immediately. A comparison process inherited `EDITOR=nvim` and launched `nvim /tmp/pi-editor-*/prompt.md` correctly. The reliable fix is a valid Pi `externalEditor` setting or shell `VISUAL`/`EDITOR`, not a keybinding fallback.
