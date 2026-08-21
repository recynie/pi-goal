# AGENTS.md

This workspace implements `@recynie/pi-goal`. It builds on the lifecycle and continuation concepts of `@narumitw/pi-goal`. Each session branch maintains one current Goal, and `/tree` navigation restores the selected branch without automatically restarting historical work or verification. The user and main agent refine and confirm the main goal, verifiable subtasks, and details in the original session. Lifecycle changes made during a run are committed serially at settled boundaries, including agent-requested recovery of any paused Goal through `goal_resume`. After the work is submitted, an independent fresh-context verifier with access only to `read`, `bash`, and the result tool validates it. The main interface displays the verifier interaction in an expandable card, and the verifier submits its conclusion through the result tool using `pass` or `fail` plus details. `@misunders2d/pi-goal` serves only as a product-concept reference and is not an implementation base.

## Workspace Map

- `.gitignore`: Ignores upstream source snapshots, dependencies, build artifacts, coverage output, and logs.
- `AGENTS.md`: Describes the workspace and provides a high-level directory index.
- `DESIGN.md`: Defines the single-current-Goal design based on the narumitw implementation, including the scrollable Control Panel, direct `/goal propose` activation, direct external GoalSpec editing, expandable proposal and verifier rendering, concise statusline, visible pause warnings with reasons, user and agent pause/resume behavior, serial settled-boundary transitions, main goal/subtasks/details refinement flow, the required verifying-state `goal_submit.result`, independent verifier protocol, and proposed architecture.
- `LICENSE`: The project's MIT license.
- `README.md`: GitHub-facing project overview with motivation, lifecycle diagram, requirements, canonical Pi git-source installation, trial, update, removal, local-development and quick-start instructions, commands, Goal refinement and Control Panel behavior, agent tools, independent-verifier trust boundaries, safety mechanisms, scope, and development entry points.
- `docs/`: Implementation-level documentation.
  - `docs/architecture.md`: Module boundaries, canonical and transient state, strict persisted-verification invariants, `/tree` restoration semantics, settled ordering, verifier behavior, and UI invariants.
  - `docs/testing.md`: Incremental automated testing, branch-navigation coverage, isolated Pi/tmux startup, live direct-proposal activation evidence, and verifier validation workflows.
- `package.json`: Pi package manifest, peer and development dependencies, and development scripts.
- `package-lock.json`: Reproducible npm development dependency lockfile.
- `src/`: Complete extension implementation, including branch-aware state persistence with strict rejection of incomplete verifying entries and `/tree` restoration; refinement, direct `/goal propose` activation, execution, and verifier prompts; safety; continuation; runtime with transcript warnings for every committed pause, settled agent resume of any paused Goal, and normal continuation recovery; commands with descriptive argument completions; the scrollable overlay Control Panel; direct external GoalSpec editing with validation and relaunch; the statusline; lifecycle tools with collapsible and expandable proposal and submission-result views; the fresh verifier; verifier transcript UI with a subdued non-bold animated trailing running-title spinner, state-dependent tool-call titles and outcome backgrounds, a body-style trace viewport, settled details views, and navigation interruption settlement; lifecycle coordination that keeps verification inside the owning run until verifier settlement; and the composition root.
- `test/`: Node test runner tests covering state and statusline behavior, including rejection of verifying state without a submitted result; direct `/goal propose` activation with empty subtasks/details and persistence restore; `/tree` restoration for empty, refining, active, and verifying branches; proportional refinement prompts driven by material uncertainty; execution and verifier prompts; safety; continuation; settled precedence, including agent resume and user-action priority; verifier-held lifecycle dispatch; commands and descriptive argument completions; user-visible agent pause reasons and network-failure pause warnings; identical submission results for the user and verifier; four-line collapsed submission-result truncation and full expansion; the verifier's minimal tool allowlist; collapsed and expanded proposal and verifier rendering; subdued non-bold animated trailing running-title behavior; state-dependent title, trace, and tool-outcome background styling; the latest-trace viewport; details-summary truncation; settled-trace hiding; verifier transcript restoration and interruption; README command documentation; direct external editor and Control Panel overlay contracts; and Pi resource-loader smoke loading.
- `tsconfig.json`: Strict TypeScript configuration.
- `references/`: Upstream source snapshots of existing Pi goal-pattern extensions.
  - `references/README.md`: Versions, sources, and snapshot information for the reference projects.
  - `references/narumitw-pi-goal/`: Source, tests, and project documentation for `@narumitw/pi-goal`.
  - `references/misunders2d-pi-goal/`: Source, tests, skill, and project documentation for `@misunders2d/pi-goal`.

Update `AGENTS.md` whenever any of the following occurs:

- A file or directory is created, or file contents are modified.
- A file or directory description needs revision because a significant content change has made the existing description outdated.
- A directory is moved or copied.
