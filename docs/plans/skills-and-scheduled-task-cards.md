# Skills and scheduled task cards implementation plan

**Goal:** Explain and show the real skill installation roots, dispatch scheduled group work through formal task cards, and stop presenting global plugins/MCP as per-Bot configuration.
**Architecture:** Keep DSH's filesystem skill provider and public schedule APIs. Reuse the existing TaskflowService and SQLite card lifecycle; no synthetic success, model-generated task identity, direct writes to live user data, or Harness patches. Hide global resource selectors without deleting installed resources or changing secret/tool authorization.
**Tech Stack:** DS Bot JavaScript, DSH public plugin APIs, SQLite scheduler, React, Node test runner.

## Approved requirements and boundaries

The user explicitly requests: the skill installation location; scheduled work dispatched from the task panel as formal cards instead of group @ exchanges; global plugin/MCP details omitted from Bot-specific configuration. Main Agent implements and verifies; independent agents review only. Preserve the pending native-card, observed-work, duplicate-display and poll-order fixes. Production remains 0.3.23 until normal-exit installation is authorized; candidate 0.3.25 is not yet released.

## Skills and configuration display

- [x] Read actual filesystem-provider docs and installed base bundle, profile-skills.js, profiles.js, and the running process's selected non-secret DSH_HOME.
- [x] Expose global skills root and an active profile root only when its provider is mounted, using profiles.js rather than hard-coded client paths.
- [x] Display `<name>/SKILL.md` guidance with mandatory name/description and explain registry discovery versus actual skill use. See `docs/guides/group-scheduled-tasks.zh.md`.
- [x] Remove process-plugin lists/selectors and MCP entries from per-Bot profile assignment and Bot capability cards. Keep shared service management and existing stored assignments/permissions intact.
- [x] Profile edits without a plugins field preserve existing references, including stale ones; the hidden settings must not make an ordinary skill edit fail or silently erase references.
- [x] Exercise real profile-save handlers and client edit/save callbacks with isolated fixtures, and rebuild the generated client.

Evidence: `.tmp-verify/skill-roots-and-global-display-red.log` has the four intended failures before the implementation. `.tmp-verify/skill-roots-and-global-display-focused.log` passes the profile handlers, client edit/save callbacks, task-message identities and real SlotCore contracts. Plugin build, lint and generated-client check returned exit 0. These are source/fixture checks; production remains unchanged and no live skill invocation was made.

## Scheduled work

- User steering explicitly requests an additional **group** schedule entry; existing single-Bot reminders stay intact. The group form selects an existing group and one non-principal executor, plus title, goal and existing timing controls.
- Main/independent design comparison: retain DSH's public schedule service for calendar/time-zone behavior, use a dedicated internal trigger Session per schedule to avoid mixed reminder batches, and consume trusted schedule frames before model execution. Reject the resolve-agent substitution and model-prompt-based planning alternatives. Reuse the existing structured Taskflow group-card transport and explicit recipient routing; scheduled assignment bodies omit the textual @ prefix. This preserves group execution monitoring, result capture, principal return and native card metadata instead of introducing a second unmonitored delivery path.
- Save the trigger reservation before registering its timer; bind the returned DSH schedule id before enabling dispatch. Consume internal Session inputs without a model call even when a reservation needs repair. Persist occurrence admission before execution, and record schedule/occurrence identity atomically with a new plan in the coordination ledger. Duplicate or uncertain occurrences never auto-send again.
- Use the current valid principal when firing. An existing open group plan blocks the new occurrence with a visible reason; it is neither overwritten nor described as successfully dispatched. Deleting a schedule removes future firings, not its already created task history.
- Expose the group-schedule entry from both the task panel and the scheduled-tasks page. The panel supplies its current group; the common form owns timing and executor selection. List group schedules with their next time and last actual dispatch outcome, and keep the normal single-Bot reminder path.

- [x] Trace the public schedule-delivery extension point and compare independent design evidence with the main call-chain analysis before changing delivery.
- [x] Route scheduled group work through the current group's principal and a real plan/card, with stable firing identity and no automatic replay after unknown transport acceptance.
- [x] Keep scheduled single-Bot reminders working; expose formal group-card scheduling in the task panel and preserve legacy schedules without silently rewriting live records.
- [x] Verify the actual scheduled delivery → scheduler ledger → dispatch → executor submission → principal receipt chain using isolated public-API fixtures. No real group messages or billable model calls.

Focused evidence: `group-schedule-final-regression.log` is 17 pass / 0 fail. Tests cover native channel and on-disk binding, the real TaskflowService and SQLite card lifecycle, concurrent/recovered duplicates, transaction rollback, current principal/member checks, uncertain transport, failed saves, deletion and client callbacks. `group-schedule-startup-red.log` reproduces GS-001 before the load-before-lookup fix; closure is requested separately. The production TaskForm rendered at 460/800px and submitted its selected group/executor through actual DOM controls (`group-schedule-render.json`); this used an isolated sample roster and intercepted callback, not a real group timer.

Candidate: rebuilt 0.3.25 package contains 131 files, all matching source (`group-schedule-package-verification.json`), not installed. Full `npm test` runs as `proc_497b4828c760` against 440 frozen inputs (`group-schedule-final-inputs.json`); do not duplicate it. The preceding canonical wrapper completed with package tests and nested unit/build/lint passing, smoke/web/desktop blocked before boot and readiness null; its 432 inputs were unchanged, but that earlier run predates group scheduling and is not final combined evidence.

- [ ] Before promotion, change the duplicate-occurrence row copy from “Already dispatched” to “Occurrence already recorded”: the durable identity proves admission, including a possible crash before transport, not that a send happened. Keep the current full-suite inputs frozen until it exits, then verify this small display delta and regenerate/recheck the package.

## Combined candidate verification

- [ ] Close native-card review findings, run affected regression tests, full project unit/build/lint/client consistency gates and app package contracts.
- [ ] Retain prior wrapper environment failures as distinct evidence; do not describe direct tests as a passing full Harness wrapper.
- [ ] Rebuild and hash a fresh 0.3.25 candidate; existing 0.3.24 package does not cover the later changes.
- [ ] Install only after normal exit and exact package/source checks; actual installed-window acceptance remains a separate gate.
