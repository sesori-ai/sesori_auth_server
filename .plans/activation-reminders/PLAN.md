# Activation Reminders

## Purpose

Improve user activation by measuring and nudging users through this funnel:

1. Mobile setup: the user registers a push-notification device token.
2. Bridge setup: the user registers the desktop bridge.
3. Full activation: the user creates a new session, represented by the first valid authenticated call to `POST /sessions/generate-metadata`.

This file is the authoritative implementation tracker. A future session should read this file and `.plans/activation-reminders/CONSIDERATIONS.md` before changing code.

## Current State

- Branch: `activation-reminder-backfill`
- Implementation checkpoint: PR4 complete; delivery pending
- PR1 delivery status: merged as PR #38
- PR2 delivery status: merged as PR #40
- PR3 delivery status: merged as PR #41 (`c0ec782`)
- PR4 intended post-merge status: merged; verify live state rather than inferring it from this file
- Live GitHub delivery state: verify with `gh pr list --head activation-reminder-backfill --state all`
- Last updated: 2026-07-16
- PR4 is the final planned implementation slice. Finish its commit, review, PR, and merge workflow before running the production backfill.

## Resume Instructions

1. Read this entire file and `CONSIDERATIONS.md`.
2. Run `git status --short` and inspect existing changes; do not undo unrelated work.
3. Verify live PR state with GitHub; the table records implementation and intended post-merge state, not live delivery state.
4. If an earlier slice is implemented but not merged, finish that delivery workflow before starting the next slice.
5. Find the first PR whose implementation is not complete in the status table below.
6. Work only on that PR's unchecked acceptance criteria unless the user explicitly expands scope.
7. Run that PR's verification commands.
8. Update implementation status, intended post-merge status, completed checkboxes, verification results, and continuation instructions.
9. Do not start the next PR in the same session unless the user asks.

## Product Decisions

- V1 implementation is auth-server-only. Full-stack changes remain permissible later, but no Flutter, bridge, or relay changes are needed for V1.
- Existing FCM infrastructure and the `system_update` notification category are reused.
- Notification taps rely on the app's default open behavior; V1 adds no activation-specific deep link.
- Mobile setup is the first device-token registration, not account creation.
- Bridge setup is the first bridge registration, not the first relay connection.
- First session is the first valid authenticated `POST /sessions/generate-metadata` call. Metadata failure is non-fatal in the bridge and session creation continues, so the response does not need to succeed. This deliberately measures creation of a new text-backed session, not messages in existing sessions.
- Bridge reminder 1 is due approximately 2 hours after mobile setup.
- Bridge reminder 2 is due approximately 24 hours after mobile setup, but only after bridge reminder 1 completed in an earlier sweep.
- The single session reminder is due approximately 24 hours after both mobile and bridge setup. Its organic baseline is `max(mobileSetupAt, bridgeSetupAt)`.
- A roughly 15-minute sweep is sufficient; reminder timing is intentionally approximate.
- No quiet-hours handling in V1.
- Existing users are actively backfilled. Incomplete users enter a controlled re-engagement sequence measured from backfill time with deterministic jitter.
- V1 reporting consists of structured logs and direct MongoDB queries; no metrics endpoint or dashboard.

## Notification Copy

All reminders use category `system_update`.

| Reminder      | Title                           | Body                                                                                         |
| ------------- | ------------------------------- | -------------------------------------------------------------------------------------------- |
| Bridge 1      | Finish setting up Sesori        | Install the Sesori bridge on your computer to start using Sesori from your phone.            |
| Bridge 2      | Your Sesori setup is unfinished | You haven't connected your computer yet. Install the Sesori bridge to unlock Sesori.         |
| First session | Start your first session        | You're all set up! You haven't started a new session yet - create one to put Sesori to work. |

## Target Data Model

Collection: `activationStates`. One document per user.

```text
_id: ObjectId
userId: ObjectId (unique)

mobileSetupAt: Date | null
bridgeSetupAt: Date | null
firstSessionAt: Date | null

bridgeReminderBaseAt: Date | null
sessionReminderBaseAt: Date | null

bridgeReminder1SentAt: Date | null
bridgeReminder2SentAt: Date | null
sessionReminderSentAt: Date | null

backfilledAt: Date | null
createdAt: Date
updatedAt: Date
```

Field invariants:

- `bridgeReminderBaseAt` is set only after mobile setup is known.
- `sessionReminderBaseAt` is set only after both mobile and bridge setup are known.
- Mobile and bridge timestamps are set once; `firstSessionAt` retains the earliest observed candidate when better evidence arrives.
- Backfill timestamps remain separate from reminder baselines so analytics are not rewritten to make scheduling convenient.
- Sent timestamps are independent so each reminder can be measured and suppressed separately.

Planned indexes:

- `{ userId: 1 }`, unique.
- `{ bridgeSetupAt: 1, bridgeReminder1SentAt: 1, bridgeReminderBaseAt: 1 }`.
- `{ bridgeSetupAt: 1, bridgeReminder2SentAt: 1, bridgeReminderBaseAt: 1 }`.
- `{ firstSessionAt: 1, sessionReminderSentAt: 1, sessionReminderBaseAt: 1 }`.
- Supporting historical mobile reconciliation: `deviceTokens { userId: 1, createdAt: 1 }`.
- Supporting historical bridge reconciliation: `bridges { userId: 1, addedAt: 1 }`.

The equality fields precede each due-time range field so the future sweep queries can use the indexes directly.

## Delivery Architecture

- MongoDB is the durable source of truth.
- An in-process single-flight sweep queries due activation records about every 15 minutes.
- A process restart loses only the current polling interval, not reminder eligibility.
- Sending is gated by `ACTIVATION_REMINDERS_ENABLED`, defaulting to false.
- Milestone recording remains active independently of the sending flag.
- Activation tracking failures are logged and isolated from the user-facing endpoint that produced the milestone.
- Reminder completion is marked after `NotificationService.sendToUser` resolves while FCM is available, including a result with zero registered devices. FCM-unavailable, thrown-send, and zero-success results containing retryable per-token failures remain retryable.
- See `CONSIDERATIONS.md` for the narrow crash window in which strict exactly-once delivery cannot be guaranteed.

## Configuration Target

| Variable                                | Default    | Purpose                                                    |
| --------------------------------------- | ---------- | ---------------------------------------------------------- |
| `ACTIVATION_REMINDERS_ENABLED`          | `false`    | Master switch for the reminder sweep.                      |
| `ACTIVATION_SWEEP_INTERVAL_MS`          | `900000`   | Approximate 15-minute sweep interval.                      |
| `ACTIVATION_BRIDGE_REMINDER_1_DELAY_MS` | `7200000`  | Two-hour first bridge delay.                               |
| `ACTIVATION_BRIDGE_REMINDER_2_DELAY_MS` | `86400000` | Twenty-four-hour second bridge delay.                      |
| `ACTIVATION_SESSION_REMINDER_DELAY_MS`  | `86400000` | Twenty-four-hour session delay after both setups.          |
| `ACTIVATION_SWEEP_BATCH_LIMIT`          | `100`      | Maximum records processed for one reminder kind per sweep. |

## PR Status

| PR  | Scope                                                                                         | Implementation | Intended post-merge status | Production behavior                       |
| --- | --------------------------------------------------------------------------------------------- | -------------- | -------------------------- | ----------------------------------------- |
| PR1 | Plans, collection, indexes, schema, repository, composition wiring, repository tests          | complete       | merged                     | Dormant; creates collection/indexes only. |
| PR2 | Milestone capture, enrollment reconciliation, endpoint hooks, failure isolation               | complete       | merged                     | Records state only; sends nothing.        |
| PR3 | Config, reminder queries/service, FCM sends, 15-minute scheduler, structured logs             | complete       | merged                     | Sending remains off by default.           |
| PR4 | Idempotent dry-run-capable active backfill with controlled re-engagement baselines and jitter | complete       | merged                     | No effect until manually executed.        |

## PR1 - Dormant Data Layer

Implementation: complete

Intended post-merge status: merged

Acceptance criteria:

- [x] Add this resumable plan and considerations document.
- [x] Add `ActivationStates` to `AuthDbCollection`.
- [x] Add the four planned indexes to `DATABASE_CONFIG`.
- [x] Add the complete Zod document schema and inferred type.
- [x] Add `ActivationStateRepository` with dormant persistence primitives needed by later slices.
- [x] Instantiate and pass the repository through composition without adding behavior.
- [x] Add focused repository/index tests.
- [x] `npm run build` passes.
- [x] `npm run lint` passes without new warnings.
- [x] `npm run format:check` passes.
- [x] Focused PR1 tests pass.
- [x] Full test suite passes, or any environment blocker is recorded below.

PR1 non-goals:

- No route or service hook records activation yet.
- No reminder query or scheduler exists yet.
- No configuration variables are added yet.
- No push is sent.
- No backfill script is added.

PR1 verification results:

- `node --import tsx --test --test-concurrency=1 "tests/repositories/activation-state-repo.test.ts"`: passed, 7 tests.
- `npm run build`: passed.
- `npm run lint`: passed with no warnings.
- `npm run format:check`: passed.
- `npm test`: passed, 334 tests passed, 1 skipped, 0 failed across 37 top-level suites.
- `npm run circular-dependencies`: passed; no circular dependencies found.
- `git diff --check`: passed.

## PR2 - Milestone Capture

Implementation: complete

Intended post-merge status: merged

Acceptance criteria:

- [x] Add `ActivationService` to own reconciliation and milestone invariants.
- [x] Add an atomic milestone update that preserves first-event timestamps and derives reminder baselines correctly for either event order.
- [x] Retain the earliest first-session candidate when concurrent initial reads/writes reach MongoDB out of order.
- [x] On device-token registration, enroll the user from the earliest extant token, reset transferred-token history for the new owner, and retry unresolved bridge/session reconciliation.
- [x] Add `{ userId: 1, createdAt: 1 }` to support historical device-token lookup.
- [x] Remove the superseded `{ userId: 1 }` token index only after confirming the exact desired compound replacement exists.
- [x] Validate token owner IDs with the typed internal error used at repository boundaries.
- [x] Reconcile bridge state from the earliest historical bridge, including revoked bridges.
- [x] Add `{ userId: 1, addedAt: 1 }` to support historical bridge lookup.
- [x] Reconcile session state from historical `dailyUsage.metadataRequestCount > 0` data using the earliest qualifying document's `createdAt`.
- [x] Set `bridgeSetupAt` idempotently after bridge registration, using the earliest historical `addedAt` across active and revoked bridges.
- [x] Set `firstSessionAt` before metadata generation for a valid authenticated request, preferring earlier historical metadata evidence when present, because the bridge proceeds when metadata generation fails.
- [x] Reconcile all still-missing historical milestones from each event hook so a later event repairs an earlier failure-isolated write.
- [x] Derive `sessionReminderBaseAt` from the later of mobile and bridge setup.
- [x] Catch and log activation errors at every endpoint boundary without changing the existing endpoint response.
- [x] Document that logout/revoke retains lifetime activation history.
- [x] Add repository, service, event-order, reconciliation, route, metadata-failure, and failure-isolation tests.
- [x] `npm run build` passes.
- [x] `npm run lint` passes without warnings.
- [x] `npm run format:check` passes.
- [x] Focused PR2 tests pass.
- [x] Full test suite passes.
- [x] `npm run circular-dependencies` passes.
- [x] `git diff --check` passes.

PR2 non-goals:

- No reminder due-query or scheduler exists yet.
- No activation configuration variables are added yet.
- No activation push is sent.
- No existing-user backfill command is added.

PR2 verification results:

- Focused activation/repository/route suite: passed, 106 tests.
- `npm run build`: passed.
- `npm run lint`: passed with no warnings.
- `npm run format:check`: passed.
- `npm test`: passed, 358 tests passed, 1 skipped, 0 failed across 39 top-level suites.
- `npm run circular-dependencies`: passed; no circular dependencies found.
- `git diff --check`: passed.

PR2 exit condition:

- Production can collect and query the funnel while sending remains impossible.

## PR3 - Reminder Sweep And Sending

Implementation: complete

Intended post-merge status: merged

Acceptance criteria:

- [x] Add validated activation configuration with `ACTIVATION_REMINDERS_ENABLED=false` by default.
- [x] Add indexed, inclusive-cutoff due queries with an independently bounded batch for each reminder kind.
- [x] Recheck eligibility immediately before delivery and conditionally write each sent marker afterward.
- [x] Add `ActivationReminderService` with single-flight sweeps and no interval overlap.
- [x] Expose FCM availability so failed Firebase initialization cannot become a completed zero-device send.
- [x] Mark genuine zero-device sends complete while leaving thrown sends and all-transient token failures retryable.
- [x] Send the approved copy through `NotificationService` under `system_update` with a distinct collapse key per kind.
- [x] Start polling only when enabled, stop queued work during disposal, and wait up to 15 seconds for the current candidate before MongoDB closes.
- [x] Emit structured, first-writer milestone logs and per-reminder/sweep outcome logs.
- [x] Test inclusive cutoffs, independent markers, batch caps, stage races, conditional writes, send outcomes, retry behavior, single-flight behavior, and scheduler disposal.
- [x] Prevent overdue users from receiving both bridge reminders in the same sweep.
- [x] `npm run build` passes.
- [x] `npm run lint` passes without warnings.
- [x] `npm run format:check` passes.
- [x] Focused PR3 tests pass.
- [x] Full test suite passes.
- [x] `npm run circular-dependencies` passes.
- [x] `git diff --check` passes.

PR3 non-goals:

- No existing-user backfill command is added.
- No distributed lease or multi-instance exactly-once guarantee is added.
- No metrics endpoint, dashboard, deep link, quiet-hours policy, or notification preference is added.

PR3 verification results:

- Focused repository, reminder, activation, and notification suite: passed, 48 tests.
- `npm run build`: passed.
- `npm run lint`: passed with no warnings.
- `npm run format:check`: passed.
- `npm test`: passed, 376 tests passed, 1 skipped, 0 failed across 41 top-level suites.
- `npm run circular-dependencies`: passed; no circular dependencies found.
- `git diff --check`: passed.
- Two independent pre-delivery reviews reported no findings after retry, timer-bound, shutdown, and concurrent-log hardening.

PR3 exit condition:

- Code is deployable with no sends under default configuration; enabling the flag starts organic reminders.

## PR4 - Existing-User Backfill

Implementation: complete

Intended post-merge status: merged

Acceptance criteria:

- [x] Add an idempotent operator-run script and package command.
- [x] Require dry-run by default and an explicit apply flag for writes.
- [x] Iterate existing users in bounded keyset batches, with each command's cohort fixed at its start timestamp.
- [x] Set `mobileSetupAt` from the earliest extant device token; record users without a current token without making them reminder-eligible.
- [x] Set `bridgeSetupAt` from the earliest historical bridge registration, including revoked bridges.
- [x] Set `firstSessionAt` from historical metadata usage when available without replacing precise organic timestamps.
- [x] Preserve real milestone timestamps and sent markers for analytics and suppression.
- [x] For currently incomplete, push-reachable users, atomically set only the current unsent reminder baseline to backfill time plus deterministic jitter.
- [x] Re-evaluate the current stage in the atomic write so a milestone committed during reconciliation cannot strand the controlled baseline on a completed stage.
- [x] Do not schedule bridge reminders for users who already have a bridge.
- [x] Do not schedule session reminders unless both mobile and bridge setup are known.
- [x] Report cumulative and final proposed/applied counts by activation stage and reminder sequence.
- [x] Document dry-run review, apply, timing, interruption, rerun, and monitoring operations.
- [x] Test dry-run safety, explicit apply gating, idempotency, reconciliation, fixed cohorts, stage races, tokenless users, and controlled baseline assignment.
- [x] `npm run build` passes.
- [x] `npm run lint` passes without warnings.
- [x] `npm run format:check` passes.
- [x] Focused PR4 and reminder-hardening tests pass.
- [x] Full test suite passes.
- [x] `npm run circular-dependencies` passes.
- [x] `git diff --check origin/master` passes.

PR4 verification results:

- Focused backfill, repository, reminder, and notification suite: passed, 55 tests.
- `npm run build`: passed.
- `npm run lint`: passed with no warnings.
- `npm run format:check`: passed.
- `npm test`: passed, 393 tests passed, 1 skipped, 0 failed across 71 suites.
- `npm run circular-dependencies`: passed; no circular dependencies found.
- `npm run backfill-activation -- --help`: passed without requiring database configuration.
- `git diff --check origin/master`: passed.
- Independent pre-delivery reviews hardened atomic current-stage assignment, fixed run cohorts, tokenless-user behavior, CLI validation/lifecycle, partial progress reporting, and bounded shutdown writes.

PR4 exit condition:

- Operators can preview and then launch a controlled existing-user re-engagement wave.

## Rollout

1. Merge/deploy PR1. Confirm collection and indexes exist; user behavior is unchanged.
2. Merge/deploy PR2. Inspect activation records and establish baseline funnel conversion.
3. Merge/deploy PR3 with `ACTIVATION_REMINDERS_ENABLED=false`. Confirm no sends.
4. Enable organic reminders and monitor logs/error rate.
5. Merge PR4, run dry-run, review counts, then apply at a suitable time for primary user regions.
6. Compare conversion timestamps before/after reminder sends through MongoDB aggregation.

## Deferred

- Dedicated activation notification category and in-app preference.
- Explicit activation deep links in the Flutter notification dispatcher.
- Device-timezone capture and local quiet hours.
- Internal metrics endpoint or dashboard.
- Generic durable job infrastructure.
- Multi-instance worker leasing. Current deployment is intentionally single-instance.

## Change Log

- 2026-07-12: Interview completed. Product behavior, scheduling, copy, backfill policy, reporting, and four-PR split agreed.
- 2026-07-12: PR1 implementation completed. Added the resumable plan, activation-state collection/schema/indexes, dormant repository/composition wiring, and focused tests. All verification passed. This document records PR1's intended post-merge status as merged; live GitHub status must always be verified separately. PR2 is next and has not started.
- 2026-07-15: PR1 review feedback addressed. Clarified metadata-attempt semantics, retry and FCM-unavailable behavior, and backfill race guarantees; added defensive ObjectId validation and tests. All verification passed.
- 2026-07-15: Human PR1 review feedback addressed. Documented timestamp and index invariants in source, clarified intended status labels, and made concurrent first-enrollment upserts recover from duplicate-key races. All verification passed.
- 2026-07-15: PR1 merged as #38. PR2 implementation completed: atomic milestone recording, historical reconciliation, three failure-isolated endpoint hooks, lifetime revoke semantics, and comprehensive tests. Pre-delivery review also hardened transferred-token timestamps, direct bridge/session historical reconciliation, retry repair, and concurrent first writes. All verification passed. PR3 is next and has not started.
- 2026-07-15: PR2 automated review feedback addressed. Added cross-stage repair from every event hook, earliest-wins concurrent session recording, defensive token user validation, and the compound token reconciliation index. Retained the documented metadata-attempt and historical timestamp semantics. All verification passed.
- 2026-07-15: PR2 second automated review addressed. Added safe cleanup for the superseded device-token index and changed invalid token owner handling to the typed repository-boundary error. Confirmed mobile/bridge concurrency already resolves from earliest durable source timestamps. All verification passed.
- 2026-07-15: PR2 third automated review addressed. Required a full desired-index option match before cleanup and preserved earlier observed session timestamps when an initial read loses a race. All verification passed.
- 2026-07-15: PR2 merged as #40. PR3 implementation completed and opened as #41: default-off configuration, indexed due queries, conditional markers, FCM delivery, a bounded single-flight scheduler, graceful disposal, and structured logs. Pre-delivery review hardened transient per-token retries, timer validation, shutdown cancellation, and concurrent milestone-log ownership. All verification passed. PR4 must wait for live merge verification.
- 2026-07-15: PR3 review feedback addressed. Restored the plan's static intended-status semantics and staged overdue bridge reminders across separate sweeps so enabling a delayed scheduler cannot send both messages back-to-back.
- 2026-07-16: PR3 merged as #41 (`c0ec782`). PR4 implementation completed on `activation-reminder-backfill`: dry-run-first operator tooling, fixed-cohort keyset batching, historical reconciliation, atomic controlled baselines, deterministic jitter, progress/final reporting, an operations runbook, and comprehensive tests. Post-merge PR3 feedback was also addressed with enums, CAS semantics, bounded disposal, token-safe logging, structured-log regressions, throughput defaults, and architecture documentation. All verification passed; PR4 delivery is pending.
