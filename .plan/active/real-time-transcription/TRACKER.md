# Proportional Real-Time Transcription: Tracker

## Plan State

- **Status:** Approved — ready for implementation
- **Active slug:** `real-time-transcription`
- **Implementation base:** auth `master`
- **Merged auth artifact SHA:** —
- **Merged apps artifact SHA:** —

## Current Pointer

- **Stage:** S01
- **Wave:** W01
- **Next action:** Deliver the approved plan (PR/commit decision), then pin the S01/W01 auth `master` baseline before implementation.

## Plan Review

- **Verdict:** Approved (fifth round; four prior rejections corrected)
- **Reviewer:** `aristotle-plan-review`
- **Date:** 2026-08-06
- **Reviewed commit:** `020afc0c456bdbf4edd13bbea56b2e95410bec29` (invocation worktree; selected implementation base remains auth `master` at `9cc495397158722e4bf9c7ee2ed10f4b17b59e26`)
- **Plan-definition digest:** `sesori-plan-definition-v1:sha256:afce0de941b59a1a153908669cac1a6f9d4f817b17b1ea44ac96d95eaa49ef3f` (recomputed after recording the approved status in `PLAN.md`)

## Wave Baselines

| Stage | Wave | Repository | Base | Pinned SHA | Drift Decision |
|---|---|---|---|---|---|
| S01 | W01 | `sesori-ai/sesori_auth_server` | `master` | — | Not started |
| S01 | W02 | `sesori-ai/sesori_auth_server` | `master` | — | Not started |
| S02 | W01 | `sesori-ai/sesori_auth_server` | `master` | — | Not started |
| S03 | W01 | `sesori-ai/sesori_apps_monorepo` | `main` | — | Not started |

## PR Steps

| Done | ID | Stage | Wave | PR | Branch | Notes |
|---|---|---|---|---|---|---|
| [ ] | S01-W01-P01 | S01 | W01 | — | `plan/real-time-transcription/s01-w01-p01-project-scope-glossary` | Auth: scoped glossary runtime and migration-ready index config |
| [ ] | S01-W02-P01 | S01 | W02 | — | `plan/real-time-transcription/s01-w02-p01-provider-neutral-async-soniox` | Auth: provider boundary, Soniox async, legal/config/cleanup |
| [ ] | S02-W01-P01 | S02 | W01 | — | `plan/real-time-transcription/s02-w01-p01-realtime-voice-proxy` | Auth: protocol v1 proxy and minimal shutdown |
| [ ] | S03-W01-P01 | S03 | W01 | — | `plan/real-time-transcription/s03-w01-p01-stream-mobile-voice` | Apps: PCM streaming, preview, commit, async fallback |

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

- 2026-08-06 — Fifth `aristotle-plan-review` round APPROVED the plan. All six fourth-round corrections were verified concretely present and consistent with shipped code, the record 7.1.1 SDK, CI workflows, and pinned baselines; digest recorded.
- 2026-08-04 — Fourth `aristotle-plan-review` rejected six residual contradictions. The plan now gives the pre-auth limiter a named middleware and `src/index.ts` composition owner with corrected hook order; assigns retry headers solely to `src/server.ts`; atomically stops bridge admission and awaits tracker cleanup; uses a recorder start-paused/effective-config-before-start-frame sequence; clamps overshot glossary capacity at zero; and preserves shipped OpenAI HTTP 500 failures through an exact compatibility-marked mapping while Soniox uses detailed errors.
- 2026-08-04 — Third `aristotle-plan-review` rejected seven remaining gaps. The plan now adds a bounded O(1) pre-auth upgrade limiter before the user limiter; tracks and quiescently drains every app-presence repository read only after `app.close()`; hardens and tests activation/bridge producer disposal; assigns realtime connect timeout to the Soniox client signal seam; closes first-frame, fractional-quota, and serialized-event protocol outcomes; defines exact async `ApiError`/HTTP/retry mappings; and separates staging/production operational waves with explicit merged auth/apps artifact SHA fields.
- 2026-08-04 — Second `aristotle-plan-review` rejected the corrected draft on nine concrete gaps: it incorrectly referenced access-token `tokenVersion`; protocol-v1 schemas/races were incomplete; auth/test composition and SDK seams were not explicit; async abort ownership was missing; realtime disposal could detach MongoDB work; IP limiting lacked trusted-proxy design; README retained bridge-based project derivation; glossary limits/normalization were unspecified; and build/SOPS maintenance commands were incomplete. The plan now uses the existing stateless bearer-upgrade auth, strict closed protocol schemas/fixtures and terminal rules, explicit production/test DI, route-owned async aborts, rejecting Mongo-safe disposal, post-auth user-keyed rate limiting with no proxy trust dependency, one canonical project-only vector/README update, exact glossary policy, and exact build/pinned SOPS commands. Re-review is pending.
- 2026-08-04 — Initial plan review rejected the draft because it did not distinguish unmerged PR #55 files from the selected `master` baseline strongly enough, omitted exact PR #52/#53/#55 history evidence, left Soniox adapter ownership optional, and did not name every focused/Docker/mobile verification command. The definition now records the baseline provenance and history, fixes exact collaborator/file ownership, and names executable Node 22/MongoDB 7/Docker/Dart/Flutter checks; re-review is pending.
- 2026-08-04 — Replaced the legacy 13-slice design with four cohesive PRs and two rollout checks. Removed receipts, reconcilers, leases, exact mutation serialization, custom provider transport, broad capacity registries, and server-wide handler tracking.
- 2026-08-04 — Locked server proxying and provider-neutral app contracts; direct Soniox app access is prohibited.
- 2026-08-04 — Locked bounded best-effort quota and glossary-cap policy, official Soniox SDK use, staged async/realtime selection, preview-then-commit UX, and proportional provider cleanup.
