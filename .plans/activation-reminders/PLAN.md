# Activation Reminders

## Purpose

Improve user activation by measuring and nudging users through this funnel:

1. Mobile setup: the user registers a push-notification device token.
2. Bridge setup: the user registers the desktop bridge.
3. Full activation: the user creates a new session, represented by the first valid authenticated call to `POST /sessions/generate-metadata`.

This file is the authoritative implementation tracker. A future session should read this file and `.plans/activation-reminders/CONSIDERATIONS.md` before changing code.

## Current State

- Branch: `activation-rate-plan`
- Implementation checkpoint: PR1 complete; PR2 not started
- PR1 post-merge status: merged
- Live GitHub delivery state: do not infer it from this static file; verify with `gh pr list --head activation-rate-plan --state all`
- Last updated: 2026-07-12
- If PR1 is still open: review and merge PR1; do not start PR2 on top of an unmerged slice
- If PR1 is merged: begin PR2 by reviewing the PR1 repository API and adding the activation service/reconciliation methods described below

## Resume Instructions

1. Read this entire file and `CONSIDERATIONS.md`.
2. Run `git status --short` and inspect existing changes; do not undo unrelated work.
3. Verify live PR state with GitHub; the table records implementation and intended post-merge state, not live delivery state.
4. If an earlier slice is implemented but not merged, finish that delivery workflow before starting the next slice.
5. Find the first PR whose implementation is not complete in the status table below.
6. Work only on that PR's unchecked acceptance criteria unless the user explicitly expands scope.
7. Run that PR's verification commands.
8. Update implementation status, post-merge status, completed checkboxes, verification results, and continuation instructions.
9. Do not start the next PR in the same session unless the user asks.

## Product Decisions

- V1 implementation is auth-server-only. Full-stack changes remain permissible later, but no Flutter, bridge, or relay changes are needed for V1.
- Existing FCM infrastructure and the `system_update` notification category are reused.
- Notification taps rely on the app's default open behavior; V1 adds no activation-specific deep link.
- Mobile setup is the first device-token registration, not account creation.
- Bridge setup is the first bridge registration, not the first relay connection.
- First session is the first valid authenticated `POST /sessions/generate-metadata` call. Metadata failure is non-fatal in the bridge and session creation continues, so the response does not need to succeed. This deliberately measures creation of a new text-backed session, not messages in existing sessions.
- Bridge reminder 1 is due approximately 2 hours after mobile setup.
- Bridge reminder 2 is due approximately 24 hours after mobile setup.
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
- Milestone timestamps record the best known real event time and are set once.
- Backfill timestamps remain separate from reminder baselines so analytics are not rewritten to make scheduling convenient.
- Sent timestamps are independent so each reminder can be measured and suppressed separately.

Planned indexes:

- `{ userId: 1 }`, unique.
- `{ bridgeSetupAt: 1, bridgeReminder1SentAt: 1, bridgeReminderBaseAt: 1 }`.
- `{ bridgeSetupAt: 1, bridgeReminder2SentAt: 1, bridgeReminderBaseAt: 1 }`.
- `{ firstSessionAt: 1, sessionReminderSentAt: 1, sessionReminderBaseAt: 1 }`.

The equality fields precede each due-time range field so the future sweep queries can use the indexes directly.

## Delivery Architecture

- MongoDB is the durable source of truth.
- An in-process single-flight sweep queries due activation records about every 15 minutes.
- A process restart loses only the current polling interval, not reminder eligibility.
- Sending is gated by `ACTIVATION_REMINDERS_ENABLED`, defaulting to false.
- Milestone recording remains active independently of the sending flag.
- Activation tracking failures are logged and isolated from the user-facing endpoint that produced the milestone.
- Reminder completion is marked after `NotificationService.sendToUser` resolves while FCM is available, including a result with zero registered devices. FCM-unavailable and thrown-send outcomes remain retryable.
- See `CONSIDERATIONS.md` for the narrow crash window in which strict exactly-once delivery cannot be guaranteed.

## Configuration Target

| Variable                                | Default    | Purpose                                                    |
| --------------------------------------- | ---------- | ---------------------------------------------------------- |
| `ACTIVATION_REMINDERS_ENABLED`          | `false`    | Master switch for the reminder sweep.                      |
| `ACTIVATION_SWEEP_INTERVAL_MS`          | `900000`   | Approximate 15-minute sweep interval.                      |
| `ACTIVATION_BRIDGE_REMINDER_1_DELAY_MS` | `7200000`  | Two-hour first bridge delay.                               |
| `ACTIVATION_BRIDGE_REMINDER_2_DELAY_MS` | `86400000` | Twenty-four-hour second bridge delay.                      |
| `ACTIVATION_SESSION_REMINDER_DELAY_MS`  | `86400000` | Twenty-four-hour session delay after both setups.          |
| `ACTIVATION_SWEEP_BATCH_LIMIT`          | `500`      | Maximum records processed for one reminder kind per sweep. |

## PR Status

| PR  | Scope                                                                                         | Implementation | Post-merge status | Production behavior                       |
| --- | --------------------------------------------------------------------------------------------- | -------------- | ----------------- | ----------------------------------------- |
| PR1 | Plans, collection, indexes, schema, repository, composition wiring, repository tests          | complete       | merged            | Dormant; creates collection/indexes only. |
| PR2 | Milestone capture, enrollment reconciliation, endpoint hooks, failure isolation               | not started    | pending           | Records state only; sends nothing.        |
| PR3 | Config, reminder queries/service, FCM sends, 15-minute scheduler, structured logs             | not started    | pending           | Sending remains off by default.           |
| PR4 | Idempotent dry-run-capable active backfill with controlled re-engagement baselines and jitter | not started    | pending           | No effect until manually executed.        |

## PR1 - Dormant Data Layer

Implementation: complete

Post-merge status: merged

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

- `node --import tsx --test --test-concurrency=1 "tests/repositories/activation-state-repo.test.ts"`: passed, 6 tests.
- `npm run build`: passed.
- `npm run lint`: passed with no warnings.
- `npm run format:check`: passed.
- `npm test`: passed, 333 tests passed, 1 skipped, 0 failed across 37 top-level suites.
- `npm run circular-dependencies`: passed; no circular dependencies found.
- `git diff --check`: passed.

## PR2 - Milestone Capture

Status: pending

Planned work:

- Add an `ActivationService` that owns cross-collection reconciliation and milestone invariants.
- On first device-token registration, enroll the user and reconcile pre-existing bridge/session state.
- Reconcile bridge state from the earliest historical bridge, including revoked bridges, so a previously completed setup is not presented as new.
- Reconcile session state from historical `dailyUsage.metadataRequestCount > 0` data, using the best available date.
- Set `bridgeSetupAt` idempotently after bridge registration.
- Set `firstSessionAt` idempotently when a valid authenticated metadata request is accepted, before metadata generation, because the bridge proceeds with session creation even when metadata generation fails.
- Recompute `sessionReminderBaseAt` as the later setup time when both setup timestamps become available.
- Catch and log activation errors at each endpoint boundary so activation tracking cannot break existing behavior.
- Add route/service tests for ordering, retries, and failure isolation.

PR2 exit condition:

- Production can collect and query the funnel while sending remains impossible.

## PR3 - Reminder Sweep And Sending

Status: pending

Planned work:

- Add the activation configuration variables with sending disabled by default.
- Add indexed repository queries for each due reminder.
- Add conditional sent-marker writes so stale sweep results cannot mark an already-completed stage.
- Add `ActivationReminderService` with single-flight sweep behavior and bounded batches.
- Expose FCM availability so an uninitialized Firebase client cannot convert eligible reminders into completed zero-device sends.
- Send the approved copy through existing `NotificationService` under category `system_update`.
- Use distinct collapse keys per reminder kind.
- Start the interval only when enabled and dispose it during graceful shutdown.
- Emit structured milestone/reminder logs suitable for initial funnel analysis.
- Test cutoffs, stage completion races, no-overlap behavior, send outcomes, and retry behavior.

PR3 exit condition:

- Code is deployable with no sends under default configuration; enabling the flag starts organic reminders.

## PR4 - Existing-User Backfill

Status: pending

Planned work:

- Add an idempotent operator-run script and package command.
- Require dry-run by default and an explicit apply flag for writes.
- Iterate existing users in bounded batches.
- Set `mobileSetupAt` from the earliest extant device token; users without a token are recorded but are not reminder-eligible.
- Set `bridgeSetupAt` from the earliest historical bridge registration.
- Set `firstSessionAt` from historical metadata usage when available.
- Preserve real milestone timestamps for analytics.
- For currently incomplete, push-reachable users, set only the relevant reminder baseline to backfill time plus deterministic jitter.
- Do not schedule bridge reminders for users who already have a bridge.
- Do not schedule session reminders unless both mobile and bridge setup are known.
- Report proposed/applied counts by activation stage and reminder sequence.
- Test dry-run safety, idempotency, reconciliation, and controlled baseline assignment.

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
