# Proportional Real-Time Transcription: Tracker

## Plan State

- **Status:** Approved — ready for implementation
- **Active slug:** `real-time-transcription`
- **Implementation base:** auth `master`
- **Merged auth artifact SHA:** `2ed90a743f348102a2c023e4b1aae934886abe2d`
- **Merged apps artifact SHA:** —
- **Plan definition PR:** https://github.com/sesori-ai/sesori_auth_server/pull/59

## Current Pointer

- **Stage:** S02
- **Wave:** W01
- **Next action:** S02-W01-P01 is implemented on the session-provided branch as an unmerged candidate. Run and review focused/full/static/Docker gates, then open the S02 PR when the candidate is ready; do not record an S02 PR number or merge SHA until one exists.

## Plan Review

- **Verdict:** Approved (sixth round; delta re-approval after PR #59 feedback edits)
- **Reviewer:** `aristotle-plan-review`
- **Date:** 2026-08-06
- **Reviewed commit:** `020afc0c456bdbf4edd13bbea56b2e95410bec29` (invocation worktree; selected implementation base remains auth `master` at `9cc495397158722e4bf9c7ee2ed10f4b17b59e26`)
- **Plan-definition digest:** `sesori-plan-definition-v1:sha256:c5529eb3838299e0488e3dbfa616a5514f0faabb447c140ebd615f83874c22e7`

## Wave Baselines

| Stage | Wave | Repository | Base | Pinned SHA | Drift Decision |
|---|---|---|---|---|---|
| S01 | W01 | `sesori-ai/sesori_auth_server` | `master` | `287abb307f1e1cbd77c19bb81030b11749ff351b` | Assessed 2026-08-06: drift from the audited `9cc4953` tip is the merged plan-definition PR #59 only, which adds `.plan/active/real-time-transcription/` documentation and no runtime, schema, route, or composition change. Audited baseline remains valid. |
| S01 | W02 | `sesori-ai/sesori_auth_server` | `master` | `1f1138be21fdbbd6a93ab256303307d5a766443f` | Assessed 2026-08-06: drift from the S01/W01 baseline is the merged S01-W01-P01 PR #61 plus the agent-config commit `65b1173`. Both are expected; no third-party change touched the voice, client, or config seams this step edits. |
| S02 | W01 | `sesori-ai/sesori_auth_server` | `master` | `2ed90a743f348102a2c023e4b1aae934886abe2d` | Assessed 2026-08-13: PR #64 is merged as `2ed90a743f348102a2c023e4b1aae934886abe2d`, so S02 starts from the same SHA. Drift decisions carried into this implementation: realtime pre-auth limiting is process-wide and ignores forwarding headers, the post-auth limiter keys only verified `request.user.userId` with no IP fallback, route/service policy values are injected from config-derived immutable policies, and shutdown uses feature-owned drains rather than a broad admitted-handler tracker. |
| S03 | W01 | `sesori-ai/sesori_apps_monorepo` | `main` | — | Not started |

## PR Steps

| Done | ID | Stage | Wave | PR | Branch | Notes |
|---|---|---|---|---|---|---|
| [x] | S01-W01-P01 | S01 | W01 | [#61](https://github.com/sesori-ai/sesori_auth_server/pull/61) | `real-time-config-next-step` | Merged `1f1138b`. Production index migration applied and verified before merge: documentCount 0, legacy absent, target exact. Implemented on the session-provided worktree branch instead of the planned branch name. |
| [x] | S01-W02-P01 | S01 | W02 | [#64](https://github.com/sesori-ai/sesori_auth_server/pull/64) | `real-time-config-next-step` | Auth: provider boundary, Soniox async, legal/config/cleanup. Merged as `2ed90a743f348102a2c023e4b1aae934886abe2d`. Implemented on the session-provided worktree branch instead of the planned branch name. |
| [ ] | S02-W01-P01 | S02 | W01 | — | `plan/real-time-transcription/s02-w01-p01-realtime-voice-proxy` | Auth: protocol v1 proxy and minimal shutdown. Current pointer: implemented on this branch as an unmerged S02 candidate; no PR number or merge SHA exists yet. |
| [ ] | S03-W01-P01 | S03 | W01 | — | `plan/real-time-transcription/s03-w01-p01-stream-mobile-voice` | Apps: PCM streaming, preview, commit, async fallback |
| [ ] | S05-W01-P01 | S05 | W01 | — | `plan/real-time-transcription/s05-w01-p01-remove-scaffolding` | Auth: delete compatibility/migration scaffolding whose trigger has fired; runs after S04 and may run more than once |

## Manual Checkpoints

| User | Worker | ID | Check | Evidence |
|---|---|---|---|---|
| [ ] | [ ] | S04-W01-M01 | Cross-repository staging and real-device verification | Pending |
| [ ] | [ ] | S04-W02-M01 | Production migration, enablement, observation, and rollback readiness | Pending |

## Blockers and Staleness

- Full-plan review is approved and the definition digest is recorded; implementation may begin from the pinned S01/W01 baseline.
- Open auth PR #55 is explicitly superseded and must not be used as an implementation base.
- Production enablement requires Soniox contractual approval, dedicated EU project configuration, and the glossary migration gate.

## Findings and Plan Deltas

- 2026-08-11 — S02/W01 drift input recorded while refreshing PR #64. `master` advanced five commits past the pinned S01/W02 baseline `1f1138b` (#57, #66, #65, #56, #63), so PR #64 was merged forward to `c2323b8`; the five conflicts (`src/config.ts`, `tests/config.test.ts`, `tests/helpers/setup.ts`, `AGENTS.md`, `README.md`) were additive and both sides were retained. Three of those commits land directly on seams S02-W01-P01 edits and must be reconciled in its drift assessment rather than assumed compatible. #66 added `src/lib/client-ip.ts` and `src/types/client-ip.ts` and keys rate limiting by Cloudflare-verified IP, while the step file specifies a pre-auth realtime upgrade limiter that is "deliberately independent of headers, peer IP, and forwarding trust" and requires tests proving spoofed forwarding headers cannot change either limit — the shipped client-IP helper and that independence claim need an explicit decision. #57 introduced per-route write rate limiting with compile-time constants, which is the pattern the planned post-auth 12/user/minute start limiter should follow. #65 changed `src/middleware/auth.ts` to require an explicit opt-in for the development auth bypass, and S02 reuses that middleware for WebSocket upgrade authentication. The S02/W01 pinned SHA is still unset because it must be the `master` SHA produced by merging PR #64, which does not exist yet.

- 2026-08-13 — S02-W01-P01 candidate implemented after PR #64 merged as `2ed90a743f348102a2c023e4b1aae934886abe2d`. Review defects corrected in the candidate: no unbounded route message queue, finish waits for provider terminal callbacks, invalid binary frames map to `invalid_audio`, post-auth limiter has no IP fallback after auth, route policy is injected from config, start timeout is cleared/guarded, waiter owners expose release/drain contracts, producers reject disposal timeouts, `src/shutdown.ts` owns the memoized ordered signal path, and CI delegates Docker smoke to `scripts/ci-auth-container-smoke.sh`. This is not a merge record; leave S02 unchecked until a PR is opened and merged.

- 2026-08-07 — S01-W02-P01 implemented. Deltas from the step file: retryable failures no longer emit a fixed `Retry-After: 1`, because a provider that states its own cooldown on a 429 is better guidance than a constant — the shipped rule honors that value clamped to 300 s, falls back to 5 s for a capacity rejection the provider did not quantify, and uses 1 s otherwise. The step file described `durationSeconds` as positive whole seconds rounded up; the shipped `AsyncTranscriptionClient` contract instead permits fractional metadata precision, since the OpenAI adapter returns the parsed `music-metadata` duration and only its size-based fallback rounds up. The rule that an absent, non-positive, or absurd provider duration is `malformed_output` rather than a free request is unchanged, and the 24-hour ceiling is inclusive. The purge command was hardened past its step-file description: deletes run in bounded batches of five, the file sweep is held back whenever any transcription list item or delete is uncertain, and a list iterator that throws after yielding still flushes the IDs it already produced. Work used the session-provided worktree branch pushed to `real-time-config-next-step`.

- 2026-08-06 — Added stage S05 to own removal of compatibility and migration scaffolding. The plan previously required retaining glossary rollback tooling and several `COMPATIBILITY` markers but never scheduled their deletion, so the debt was orphaned. S05-W01-P01 carries a per-item trigger inventory and an explicit retention list; legacy index *detection* and the startup guard are permanent, only *reversal* paths are in scope. Triggers are evidence-based, so the glossary rollback removal waits until a project-scoped document actually exists.

- 2026-08-06 — S01-W01-P01 implementation review found one blocking defect and it was fixed before the PR: rewriting the multipart reader initially caught `FST_REQ_FILE_TOO_LARGE` inside the route and reported an oversized upload as HTTP 400 instead of the shipped 413. The reader now rethrows that framework error and a regression test asserts the preserved 413.
- 2026-08-06 — S01-W01-P01 implemented. Deltas from the step file: the live `GlossaryEntry` schema is now strict and the migration-only project-scoped schema aliases it rather than re-extending a non-strict base, so one shape owns scoped documents; `src/db/glossary-index-migration.ts` needed no change; and the work uses the session-provided worktree branch. The repository fails closed on malformed persisted documents through `glossaryEntrySchema.safeParse` and returns `InternalServerError` without document content. Legacy unscoped rows are unreachable through scoped reads rather than erroring, so a stale row cannot break a valid project read.
- 2026-08-06 — PR #59 bot review feedback addressed: re-review date sync, post-merge next-action pointer, reuse of shipped `createRequestCloseSignal` for async cancellation, no-user-ID quota-race logging with regression test, admission-fixed realtime cap without mid-session usage re-reads, explicit staging Soniox/realtime enablement steps, and a production realtime rollback rehearsal. Sixth `aristotle-plan-review` round re-APPROVED; digest refreshed.
- 2026-08-06 — Fifth `aristotle-plan-review` round APPROVED the plan. All six fourth-round corrections were verified concretely present and consistent with shipped code, the record 7.1.1 SDK, CI workflows, and pinned baselines; digest recorded.
- 2026-08-04 — Fourth `aristotle-plan-review` rejected six residual contradictions. The plan now gives the pre-auth limiter a named middleware and `src/index.ts` composition owner with corrected hook order; assigns retry headers solely to `src/server.ts`; atomically stops bridge admission and awaits tracker cleanup; uses a recorder start-paused/effective-config-before-start-frame sequence; clamps overshot glossary capacity at zero; and preserves shipped OpenAI HTTP 500 failures through an exact compatibility-marked mapping while Soniox uses detailed errors.
- 2026-08-04 — Third `aristotle-plan-review` rejected seven remaining gaps. The plan now adds a bounded O(1) pre-auth upgrade limiter before the user limiter; tracks and quiescently drains every app-presence repository read only after `app.close()`; hardens and tests activation/bridge producer disposal; assigns realtime connect timeout to the Soniox client signal seam; closes first-frame, fractional-quota, and serialized-event protocol outcomes; defines exact async `ApiError`/HTTP/retry mappings; and separates staging/production operational waves with explicit merged auth/apps artifact SHA fields.
- 2026-08-04 — Second `aristotle-plan-review` rejected the corrected draft on nine concrete gaps: it incorrectly referenced access-token `tokenVersion`; protocol-v1 schemas/races were incomplete; auth/test composition and SDK seams were not explicit; async abort ownership was missing; realtime disposal could detach MongoDB work; IP limiting lacked trusted-proxy design; README retained bridge-based project derivation; glossary limits/normalization were unspecified; and build/SOPS maintenance commands were incomplete. The plan now uses the existing stateless bearer-upgrade auth, strict closed protocol schemas/fixtures and terminal rules, explicit production/test DI, route-owned async aborts, rejecting Mongo-safe disposal, post-auth user-keyed rate limiting with no proxy trust dependency, one canonical project-only vector/README update, exact glossary policy, and exact build/pinned SOPS commands. Re-review is pending.
- 2026-08-04 — Initial plan review rejected the draft because it did not distinguish unmerged PR #55 files from the selected `master` baseline strongly enough, omitted exact PR #52/#53/#55 history evidence, left Soniox adapter ownership optional, and did not name every focused/Docker/mobile verification command. The definition now records the baseline provenance and history, fixes exact collaborator/file ownership, and names executable Node 22/MongoDB 7/Docker/Dart/Flutter checks; re-review is pending.
- 2026-08-04 — Replaced the legacy 13-slice design with four cohesive PRs and two rollout checks. Removed receipts, reconcilers, leases, exact mutation serialization, custom provider transport, broad capacity registries, and server-wide handler tracking.
- 2026-08-04 — Locked server proxying and provider-neutral app contracts; direct Soniox app access is prohibited.
- 2026-08-04 — Locked bounded best-effort quota and glossary-cap policy, official Soniox SDK use, staged async/realtime selection, preview-then-commit UX, and proportional provider cleanup.
