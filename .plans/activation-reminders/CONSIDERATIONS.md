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

## Scheduler Lifecycle And Scaling

The interval and single-flight guard are process-local. Enabling reminders on multiple auth-server instances can select and send the same reminder before either instance writes its sent marker. Keep reminder sending single-instance unless a distributed lease or claim mechanism is added.

Graceful disposal stops the interval and declines queued candidates, then waits up to 15 seconds for the currently executing candidate to finish through its conditional marker write before MongoDB closes. Fastify stops accepting traffic concurrently. If FCM is still unresolved at the timeout, a late result cannot start stale-token cleanup or the marker write, so the reminder remains retryable and retains the existing narrow duplicate-delivery risk.

Reminder delivery is sequential within each kind. The default batch is 100, which keeps a pessimistic 200-400 ms FCM round-trip batch well below the 15-minute interval. Raise it only after measuring production FCM latency.

## Milestone Semantics

### App Setup

The first device-token registration from any supported app platform is used rather than user creation because it proves that an app is installed, authenticated, and has produced a push token. iOS, Android, macOS, Windows, and Linux registrations are equal evidence for this first funnel stage. Users without any device token may still be represented during active backfill for funnel completeness, but are not reminder-eligible. When the same FCM token moves between accounts, its token-document `createdAt` resets for the new owner so one user's setup timestamp is not imported into another user's activation history.

The persisted `mobileSetupAt` field, `MobileIncomplete` stage value, and `mobile_setup` structured-log value are historical names retained to avoid a data migration and analytics break. They all mean app setup across every supported platform. A same-owner token update retains its original `createdAt` even when its platform changes; an ownership change resets `createdAt`. Concurrent updates to one token serialize atomically, each update evaluates the owner left by the preceding write, and the last serialized update determines the final owner and platform.

### Bridge Setup

The first bridge registration is used rather than relay connectivity. Registration directly represents installation and first launch, is already handled by the auth server, and avoids coupling activation to relay webhook delivery.

Historical reconciliation should include revoked bridges. A revoked bridge still proves that the user completed this setup stage in the past and must not receive first-time bridge-install copy.

### First Session

The selected signal is the first valid authenticated request to `/sessions/generate-metadata`. The bridge treats metadata errors as non-fatal and continues session creation with no generated metadata, so a successful HTTP response is not required. Historical `metadataRequestCount` is therefore useful evidence of this signal, although a narrow crash window remains between the metadata call and local session creation.

Historical daily-usage documents do not store the exact first metadata-request time. Reconciliation uses the earliest qualifying document's `createdAt` as the best available timestamp; it may predate the metadata request within that UTC day when transcription created the document first.

Known limitation: command-only session creation may not call metadata generation. Such a user can receive a session reminder despite having created a command-only session. The agreed copy asks them to create a new session and remains directionally correct. A dedicated bridge-to-auth session-created event is deferred.

## Timestamp Semantics

Real milestone timestamps and reminder baselines serve different purposes and must not be conflated.

- Real timestamps support funnel analytics and historical reconciliation.
- Reminder baselines control when the current campaign begins.
- Organic bridge reminders use the app setup timestamp stored in `mobileSetupAt`.
- Organic session reminders use the later of app and bridge setup.
- Backfilled incomplete users preserve old real timestamps but use a new, jittered baseline for a controlled re-engagement wave.

## Account Revocation

Logout and account revoke remove device tokens, and account revoke also revokes bridges, but neither clears `activationStates`. Milestones represent lifetime first completion for this user, so re-authentication does not restart first-time onboarding. A future re-engagement campaign must use separate campaign baselines and sent markers rather than erasing activation history.

## Index Design

Each future due query uses equality conditions for stage completion and sent state followed by a range condition on the reminder baseline. Compound indexes therefore place the completion and sent fields before the baseline field.

Separate bridge indexes are intentional because bridge reminder 1 and bridge reminder 2 have independent sent markers. This avoids relying on a broad scan of all bridge-incomplete users.

Bridge reminder 2 additionally requires a bridge reminder 1 sent marker. The scheduler evaluates bridge reminder 2 before bridge reminder 1, so a first marker written during the current sweep cannot make an overdue user receive both messages back-to-back; the follow-up waits until at least the next sweep.

The bridge reminder 2 index covers stage completion, its own sent marker, and the baseline range. The `bridgeReminder1SentAt != null` sequence gate is a residual FETCH filter; this is acceptable at current scale but must be revisited with `explain("executionStats")` before roughly 100k activation-state documents. Replacing it with the baseline cutoff would change timing semantics and is not equivalent.

## Delivery Guarantees

The intended user-level behavior is one recorded completion per reminder kind. Unresolved sends remain eligible for retry, subject to the documented post-FCM/pre-MongoDB crash window. PR3 uses:

- A single-process, single-flight sweep.
- Conditional sent-marker updates.
- Completion checks before sending.
- A sent marker after `NotificationService.sendToUser` resolves while FCM is available, even when zero devices were notified because no registered tokens remain.
- An explicit unavailable outcome (or a disabled sweep) when Firebase initialization failed, leaving the reminder retryable.
- Retry when the send call throws before resolving.
- Retry when every token has a non-token FCM failure and no device receives the notification. If at least one device receives it, the user-level reminder is complete even if another token has a retryable failure.

Strict exactly-once push delivery is impossible with the current FCM API and MongoDB in separate systems. A process can crash after FCM accepts a push but before MongoDB records `sentAt`, causing a retry after restart. Marking before send would instead create a crash window that permanently loses reminders. The plan prefers the small duplicate-delivery risk over silent loss. Do not claim strict exactly-once delivery in implementation or documentation.

## Stage Races

A user can complete a milestone while the sweep is sending. PR3 should minimize stale reminders by rechecking eligibility through a conditional reservation or update pattern immediately before delivery. Because there is no atomic transaction spanning FCM, an extremely narrow race remains possible after the last database check. This is acceptable for a maximum of three onboarding reminders and should be documented in tests/comments without over-engineering a distributed transaction.

## Failure Isolation

Activation is secondary telemetry/engagement behavior. Existing endpoint success must not depend on it.

- Device-token registration must succeed if activation persistence fails.
- Bridge registration must succeed if activation persistence fails.
- Metadata generation must preserve its current response if activation persistence fails.
- Failures should be structured and observable, not silently ignored.

Milestone logs are emitted only by the atomic update that first claims a previously null milestone, avoiding duplicate funnel events when concurrent hooks race. MongoDB remains the authoritative source for funnel state and reminder completion.

## Backfill Safety

- Dry-run is the default.
- Applying writes requires an explicit operator flag.
- The script is idempotent and does not overwrite existing non-null milestones or sent markers.
- Deterministic jitter avoids changing baselines on repeated runs.
- Each command fixes its cohort to users created no later than that command's `backfilledAt`, so users created during a long run remain on organic enrollment.
- The first apply claims `backfilledAt` atomically and may replace only the currently relevant unsent stage's old organic baseline with `backfilledAt + jitter`; later runs cannot move it again. The update pipeline chooses that stage after merging historical evidence and milestones committed before the atomic write. A milestone committed afterward follows the normal organic stage-transition baseline rules.
- The two bridge reminders share one baseline. If bridge reminder 1 was already sent, bridge reminder 2 is the currently relevant unsent reminder and receives the controlled baseline.
- Backfill does not intentionally target fully activated users; a narrow send/completion race may still produce a stale reminder.
- Users without a device token on any supported app platform are not made reminder-eligible by backfill.
- Operational counts are reviewed before applying. Proposed counts describe the pre-write snapshot; applied counts describe the atomic post-write state and may differ when organic milestones race the command.
- Dry-run performs no writes, including index creation.

## Production Compatibility

Each slice must be safe to merge and deploy independently:

- PR1 only creates an unused collection and indexes.
- PR2 only records state and isolates failures.
- PR3 defaults sending off.
- PR4 is inert until an operator runs it with apply enabled.

No plaintext environment files or credentials are introduced. Configuration changes in PR3 follow the existing Zod/env conventions and encrypted environment workflow.

### App-Platform Deployment And Rollback

PR #43 widens the token-registration boundary from iOS/Android to iOS, Android, macOS, Windows, and Linux. Deploy it before releasing a future Windows or Linux app producer. The current apps producer emits iOS, Android, and macOS.

If a newly supported registration reaches the older auth server, the request receives a 400 and the client logs the failure. The current client does not retry on a timer; registration remains absent until application restart, a subsequent authentication-state transition, or FCM token refresh. A future Windows/Linux producer must therefore enforce the auth-first release gate or add and test bounded retry behavior.

Rolling back to the pre-PR server restores iOS/Android-only request validation, so desktop clients cannot add or refresh registrations until the fixed version returns. Existing desktop token documents do not require cleanup: repository reads do not runtime-parse or branch on their platform, and those documents remain valid push endpoints and app-setup evidence. Prefer rolling forward so desktop registrations continue to work.
