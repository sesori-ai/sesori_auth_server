# Activation Reminders - Considerations

## Existing Capabilities

- Push delivery already exists through Firebase Admin in `NotificationService`.
- Device tokens are stored in MongoDB and registered by the Flutter app.
- The auth server already receives all three selected milestones.
- The Flutter app already renders `system_update` notifications.
- No durable job queue, cron framework, or Redis deployment exists.

## Why Activation State Instead Of A Generic Job Queue

Every reminder is conditional: send at a rough time only if a later milestone is still missing. Persisting the funnel state and deriving due reminders from it avoids stale queued jobs, makes cancellation implicit, and creates the desired analytics dataset. A generic queue would add a second source of truth without solving a current broader requirement.

## Why Poll MongoDB

Reminder timing is measured in hours and does not need exact execution. A roughly 15-minute query interval is acceptable and inexpensive. MongoDB persists eligibility across restarts, while the in-process interval only triggers a stateless sweep. This avoids introducing Redis or another operational dependency.

MongoDB TTL indexes are not a scheduler: they delete documents eventually but do not execute application code, so they are not suitable here.

## Milestone Semantics

### Mobile Setup

The first device-token registration is used rather than user creation because it means the app is installed, authenticated, has notification permission, and can actually receive a reminder. Users without a device token may still be represented during active backfill for funnel completeness, but are not reminder-eligible.

### Bridge Setup

The first bridge registration is used rather than relay connectivity. Registration directly represents installation and first launch, is already handled by the auth server, and avoids coupling activation to relay webhook delivery.

Historical reconciliation should include revoked bridges. A revoked bridge still proves that the user completed this setup stage in the past and must not receive first-time bridge-install copy.

### First Session

The selected signal is the first valid authenticated request to `/sessions/generate-metadata`. The bridge treats metadata errors as non-fatal and continues session creation with no generated metadata, so a successful HTTP response is not required. Historical `metadataRequestCount` is therefore useful evidence of this signal, although a narrow crash window remains between the metadata call and local session creation.

Known limitation: command-only session creation may not call metadata generation. Such a user can receive a session reminder despite having created a command-only session. The agreed copy asks them to create a new session and remains directionally correct. A dedicated bridge-to-auth session-created event is deferred.

## Timestamp Semantics

Real milestone timestamps and reminder baselines serve different purposes and must not be conflated.

- Real timestamps support funnel analytics and historical reconciliation.
- Reminder baselines control when the current campaign begins.
- Organic bridge reminders use the mobile setup timestamp.
- Organic session reminders use the later of mobile and bridge setup.
- Backfilled incomplete users preserve old real timestamps but use a new, jittered baseline for a controlled re-engagement wave.

## Index Design

Each future due query uses equality conditions for stage completion and sent state followed by a range condition on the reminder baseline. Compound indexes therefore place the completion and sent fields before the baseline field.

Separate bridge indexes are intentional because bridge reminder 1 and bridge reminder 2 have independent sent markers. This avoids relying on a broad scan of all bridge-incomplete users.

## Delivery Guarantees

The intended user-level behavior is one recorded completion per reminder kind. Unresolved sends remain eligible for retry, subject to the documented post-FCM/pre-MongoDB crash window. PR3 should use:

- A single-process, single-flight sweep.
- Conditional sent-marker updates.
- Completion checks before sending.
- A sent marker after `NotificationService.sendToUser` resolves while FCM is available, even when zero devices were notified because no registered tokens remain.
- An explicit unavailable outcome (or a disabled sweep) when Firebase initialization failed, leaving the reminder retryable.
- Retry when the send call throws before resolving.

Strict exactly-once push delivery is impossible with the current FCM API and MongoDB in separate systems. A process can crash after FCM accepts a push but before MongoDB records `sentAt`, causing a retry after restart. Marking before send would instead create a crash window that permanently loses reminders. The plan prefers the small duplicate-delivery risk over silent loss. Do not claim strict exactly-once delivery in implementation or documentation.

## Stage Races

A user can complete a milestone while the sweep is sending. PR3 should minimize stale reminders by rechecking eligibility through a conditional reservation or update pattern immediately before delivery. Because there is no atomic transaction spanning FCM, an extremely narrow race remains possible after the last database check. This is acceptable for a maximum of three onboarding reminders and should be documented in tests/comments without over-engineering a distributed transaction.

## Failure Isolation

Activation is secondary telemetry/engagement behavior. Existing endpoint success must not depend on it.

- Device-token registration must succeed if activation persistence fails.
- Bridge registration must succeed if activation persistence fails.
- Metadata generation must preserve its current response if activation persistence fails.
- Failures should be structured and observable, not silently ignored.

## Backfill Safety

- Dry-run is the default.
- Applying writes requires an explicit operator flag.
- The script is idempotent and does not overwrite existing non-null milestones or sent markers.
- Deterministic jitter avoids changing baselines on repeated runs.
- Backfill does not intentionally target fully activated users; a narrow send/completion race may still produce a stale reminder.
- Users without device tokens are not made reminder-eligible.
- Operational counts are reviewed before applying.

## Production Compatibility

Each slice must be safe to merge and deploy independently:

- PR1 only creates an unused collection and indexes.
- PR2 only records state and isolates failures.
- PR3 defaults sending off.
- PR4 is inert until an operator runs it with apply enabled.

No plaintext environment files or credentials are introduced. Configuration changes in PR3 follow the existing Zod/env conventions and encrypted environment workflow.
