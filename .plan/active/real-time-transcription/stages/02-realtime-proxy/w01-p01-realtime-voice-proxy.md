# S02-W01-P01: Add the Realtime Voice Proxy

## Metadata

- **ID:** S02-W01-P01
- **Repository:** `sesori-ai/sesori_auth_server`
- **Worktree:** worker-created `sesori_auth_server/.worktrees/real-time-transcription-s02-w01-p01`
- **Base branch:** `master`
- **Initial audited base tip:** `9cc495397158722e4bf9c7ee2ed10f4b17b59e26` (2026-08-04 15:07:23 +0300)
- **Branch:** `plan/real-time-transcription/s02-w01-p01-realtime-voice-proxy`

## Goal and Cohesion

Deliver one complete, provider-neutral, disabled-by-default realtime proxy from public WebSocket through Soniox and back, including quota, cancellation, safe failure mapping, capability discovery, and feature-owned shutdown. This single PR avoids intermediate dead code and is one independently deployable backend feature.

## Dependencies

- S01-W02-P01 merged.
- S02/W01 auth baseline pinned after drift assessment.
- Production remains disabled until S03 and S04.

## Scope

- Register `@fastify/websocket` and protocol version 1 route/capability contracts.
- Add provider-neutral realtime interfaces and a Soniox SDK adapter.
- Add Zod schemas/adapters for every request and provider event/error consumed.
- Add `RealtimeTranscriptionService` with straight-line lifecycle, exact-project context, 15-minute/quota duration bounds, confirmed/provisional translation, and one best-effort usage increment.
- Add minimal session-owned timers and an active-session set for shutdown.
- Add a small memoized shutdown coordinator that releases existing parked long polls before Fastify close and disposes realtime sessions before MongoDB close.
- Keep realtime disabled by default.

## Non-Goals

- App implementation, relay changes, direct provider credentials, automatic failover, endpoint detection, translation, diarization, language labels, or resampling.
- Per-user/global custom admission maps duplicating provider limits.
- Audio queues with frame acknowledgements, transcript coalescing schedulers, cleanup receipts, usage receipts, or recovery timers.
- Porting unrelated diagnostics/refactors from PR #55.
- Tracking every admitted HTTP handler.

## Audited Current Code and Assumptions

- `server.ts` has no WebSocket plugin and builds auth middleware for HTTP routes.
- `index.ts` owns inline duplicate signal handlers and waits on `app.close()` before DB close.
- `PendingAuthStore` and `AppClientPresenceService` park long polls up to bounded time; release-before-close is an observed shutdown need.
- Soniox final tokens are sent once; non-final tokens replace the previous non-final window. Provider progress exposes processed audio milliseconds.
- Soniox enforces project concurrency/rate caps. Ordinary app audio arrives at near-real-time cadence.

## Touched Modules and Files

- `package.json`, `package-lock.json`
- `src/models/voice.ts`, `src/models/api.ts`
- `src/types/transcription.ts`
- `src/clients/realtime-transcription-client.ts` (new interface)
- `src/clients/soniox-realtime-transcription-client.ts` (new)
- `src/api/soniox-realtime-api.ts` (new mandatory Zod translation boundary)
- `src/services/realtime-transcription-service.ts` (new)
- `src/routes/voice-realtime.ts` (new) and `src/routes/voice.ts` capability endpoint
- `src/services/pending-auth-store.ts`
- `src/services/app-client-presence-service.ts`
- `src/services/bridge-state-tracker.ts`
- `src/services/activation-reminder-service.ts`
- `src/middleware/realtime-upgrade-rate-limit.ts` (new)
- `src/shutdown.ts` (new focused coordinator) and `src/index.ts`
- `src/server.ts`, `src/config.ts`
- `.github/workflows/ci.yml`, `scripts/ci-auth-container-smoke.sh` (new)
- `tests/models/voice-realtime.test.ts` (new)
- `tests/config.test.ts`
- `tests/api/soniox-realtime-api.test.ts` (new)
- `tests/clients/soniox-realtime-transcription-client.test.ts` (new)
- `tests/services/realtime-transcription-service.test.ts` (new)
- `tests/routes/voice-realtime.test.ts` (new)
- `tests/helpers/realtime-transcription-fakes.ts` (new)
- `tests/helpers/setup.ts`
- `tests/fixtures/voice-realtime-protocol-v1.json` (new canonical auth fixture)
- `tests/index-shutdown.test.ts` (new from the pinned base, not copied wholesale from PR #55)
- `tests/services/pending-auth-store.test.ts`, `tests/services/app-client-presence-service.test.ts`
- `tests/notifications/bridge-state-tracker.test.ts`, `tests/services/activation-reminder-service.test.ts`

## Collaborator Contracts

- `RealtimeTranscriptionClient.connect(input, handlers)` receives provider-neutral `{audioFormat, languageHint, terms, signal}` plus typed result/error callbacks and returns `RealtimeTranscriptionSession` with `sendAudio`, `finish`, and `cancel` methods.
- `SonioxRealtimeTranscriptionClient` alone calls the SDK realtime API. Its constructor accepts a narrow `SonioxRealtimeSdkFactory` structural interface plus `connectTimeoutMs`; `src/index.ts` supplies the official SDK factory and validated `REALTIME_CONNECT_TIMEOUT_MS`, while tests supply a fake factory/session. `connect()` composes the session cancellation signal with `AbortSignal.timeout(connectTimeoutMs)` using `AbortSignal.any`, passes that signal to SDK construction/connect, drops listeners when connect settles, and maps only its timeout abort to `provider_timeout`. Every SDK token/result/progress/error value is passed through pure `safeParse` helpers in `src/api/soniox-realtime-api.ts` before a provider-neutral callback runs.
- `RealtimeTranscriptionService` receives `RealtimeTranscriptionClient`, `GlossaryService`, `DailyUsageRepository`, and an immutable `RealtimeServicePolicy` through constructor injection. The policy contains `dailyLimitSeconds`, `maxSessionSeconds`, `firstAudioTimeoutMs`, `finishTimeoutMs`, and `disposeTimeoutMs`; the service never calls `loadConfig()` or imports `@soniox/node`.
- `voice-realtime.ts` owns Fastify WebSocket frames and JWT handoff and calls the service; it does not calculate quota, glossary context, or transcript state.

## Production and Test Composition

- With realtime disabled, `src/index.ts` constructs no Soniox realtime SDK/client and passes `realtimeTranscriptionService: null` plus the capability/route policy to `src/server.ts`; server exposes the public capability response and does not register `/voice/realtime`.
- With realtime enabled, `src/index.ts` constructs one process-wide `RealtimeUpgradeLimiter({maxAttemptsPerMinute, now})`, then the official US SDK factory -> `SonioxRealtimeTranscriptionClient` -> `RealtimeTranscriptionService`, translating validated config into `RealtimeServicePolicy` and `RealtimeRoutePolicy`. `RealtimeRoutePolicy` contains `firstFrameTimeoutMs`, `maxTextFrameBytes: 2048`, `maxAudioFrameBytes: 65536`, and `outboundBufferMaxBytes`. `src/server.ts` receives the limiter through typed `AppServices` and passes its pre-auth hook through typed `voice-realtime.ts` route options.
- `tests/helpers/setup.ts` sets realtime disabled by default; adds `realtimeUpgradeLimiter`, `realtimeTranscriptionClient`, `realtimeTranscriptionService`, `realtimeServicePolicy`, and `realtimeEnabled` overrides; exposes the limiter/service when enabled; and registers test cleanup through `app.close()`. It awaits `bridgeStateTracker.dispose()` before database cleanup. Fake SDK factories are injected only into client unit tests, while route tests inject the provider-neutral fake service/client graph and limiter with a controlled clock.
- The Fastify close hook and process shutdown coordinator both call the same memoized `RealtimeTranscriptionService.dispose()` promise, so test cleanup cannot double-dispose.

## Public Contract

### Client `start`

```json
{
  "type": "start",
  "protocolVersion": 1,
  "projectKey": "prj_v1_<base64url-digest>",
  "audio": { "encoding": "pcm_s16le", "sampleRate": 16000, "channels": 1 }
}
```

The frame is a strict object: unknown or omitted required fields fail. `projectKey` may instead be JSON `null`; non-null values are exactly 50 characters and must pass `projectKeySchema`. `encoding` is exactly `pcm_s16le`, `sampleRate` is exactly one of `16000|24000|44100|48000`, and `channels` is exactly `1`. The UTF-8 JSON frame is at most 2,048 bytes.

### Capability

- Public `GET /voice/capabilities` returns exactly `{"realtime":{"enabled":<boolean>,"protocolVersions":[1]}}`; `enabled` reflects configuration, while protocol 1 remains listed for disabled staged deployments. It carries no account/provider data and requires no token.
- When disabled, `/voice/realtime` is not registered and upgrade receives HTTP 404. When enabled, the existing auth middleware requires `Authorization: Bearer` during upgrade and validates the stateless access JWT's RS256 signature, issuer, audience, expiry, and strict access payload. Access tokens have no `tokenVersion`; logout/revoke continues to stop refresh only, exactly as for existing routes and relay consumers.
- Authentication is fixed at accepted upgrade: a socket is not terminated merely because its access token later expires, and the application session cannot exceed 900 seconds. Reconnect always requires a fresh valid access token.

### Client controls

- `{"type":"finish"}` and `{"type":"cancel"}` are strict objects with no additional fields and fit the 2,048-byte text limit.
- Binary PCM16 is accepted only in `streaming`; each frame is 2 through 65,536 bytes and its length must be divisible by two. Empty, odd-length, oversized, text-instead-of-audio, binary-before-`ready`, and binary-after-finish are rejected as `invalid_audio` or `invalid_message` as applicable.

### Server events

- All server JSON objects are strict and at most 65,536 UTF-8 bytes. `ready` is `{"type":"ready","protocolVersion":1,"maxSessionSeconds":<integer 1..900>,"dailySecondsRemaining":<nonnegative integer>}`.
- `transcript` is `{"type":"transcript","confirmedDelta":<string 0..32768 UTF-16 units>,"provisional":<string 0..32768 UTF-16 units>}` and requires at least one non-empty field. `confirmedDelta` is append-only; `provisional` wholly replaces the previous provisional value.
- `complete` is `{"type":"complete","reason":<"finished"|"session_limit"|"quota_limit">,"dailySecondsRemaining":<nonnegative integer>}`.
- `error` is `{"type":"error","code":<closed code>,"retryable":<fixed boolean>}` with no message. Closed mappings are: `invalid_message`, `unsupported_protocol`, `quota_exhausted`, and `invalid_audio` -> `false`/close 1008; `provider_rejected` -> `false`/close 1011; `audio_timeout`, `provider_timeout`, and `internal_error` -> `true`/close 1011; `start_timeout`, `provider_capacity`, `provider_unavailable`, `slow_client`, and `service_restarting` -> `true`/close 1013. First-frame deadline expiry emits `start_timeout` if writable, then closes 1013 without provider or repository work.
- Successful complete and client cancel close 1000 after the terminal event where one exists. HTTP 401/404/429 upgrade failures occur before WebSocket events. Close reason strings are fixed code names only; apps make retry decisions from validated events/HTTP status, never provider text.
- Auth and apps each own a byte-for-byte JSON fixture file named `tests/fixtures/voice-realtime-protocol-v1.json` and `client/module_core/test/fixtures/voice_realtime_protocol_v1.json`. They contain every valid event/control plus invalid unknown-field, omitted-field, enum, bound, and error-code cases; the two files must remain semantically identical under their repository parsers.

## Data Flow and Ownership

1. `RealtimeUpgradeLimiter` runs before authentication and allows at most `REALTIME_UPGRADE_MAX_PER_MINUTE` attempts process-wide. It has one `{windowStartedAt,count}` record, uses an injected clock, resets lazily when a minute elapses, has no timer/map/disposal work, and returns HTTP 429 before JWT verification when exhausted. It is deliberately independent of headers, peer IP, and forwarding trust.
2. Existing auth middleware then validates the access JWT during upgrade; route obtains string user ID, starts the configured first-frame deadline, and `safeParse`s the strict `start` frame.
3. An encapsulated `@fastify/rate-limit` pre-handler after authentication keys 12 starts/minute by validated `request.user.userId`, has no loopback allowlist, and disables the existing global IP limiter for only this route. Forwarding headers and `trustProxy` are therefore not security inputs for realtime admission.
4. Service prechecks usage, resolves exact-project terms, creates the injected Soniox-backed implementation of the provider-neutral realtime client, then returns `ready`.
5. Route forwards bounded binary frames to the service; service counts aligned accepted PCM bytes and passes them to the adapter.
6. Adapter validates SDK results. Service appends final tokens once and replaces provisional text per result, then emits provider-neutral updates.
7. Finish/cap asks the provider to finish and await final tokens; cancel/disconnect closes immediately.
8. One local terminal promise removes listeners/timers/session membership and performs one best-effort usage increment.

## Error, Cancellation, Concurrency, and Lifecycle

- States are only `awaiting_start`, `streaming`, `finishing`, `closed`.
- First frame and first audio each have one bounded timeout. Recorder silence still arrives as audio, so no speech/VAD timer is needed.
- Disable per-message compression and cap public payloads at 64 KiB; start/control text is further Zod length-bounded.
- Require TLS at deployment ingress. Reject access tokens in query parameters or frames. The process-wide pre-auth bound plus user-keyed post-auth bound avoids any trusted-proxy/client-IP dependency; tests prove spoofed `Forwarded`/`X-Forwarded-For` headers do not change either limit and two users sharing one socket IP retain independent post-auth limits.
- Provider connect maps capacity to `provider_capacity`, transport/5xx to `provider_unavailable`, deadline to `provider_timeout`, and provider credential/config rejection to nonretryable `provider_rejected`; raw provider errors never cross the adapter.
- Client cancel and disconnect close provider work and discard provisional text.
- Session/quota limit slices only on a PCM sample boundary, asks for finalization, and returns the corresponding completion reason.
- Slow outbound clients are closed when `bufferedAmount` crosses one configured threshold. No scheduler is added.
- Rely on provider 10-concurrent/100-per-minute limits and route rate limiting. No parallel custom capacity registry.
- Persisted usage may be fractional. Before admission, calculate integer `remainingBudgetSeconds = max(0, floor(dailyLimitSeconds - usedSeconds))`; zero rejects as `quota_exhausted`, and `ready.maxSessionSeconds = min(configuredMaxSessionSeconds, remainingBudgetSeconds)`. A tie between quota and product cap reports `quota_limit`. Final usage seconds equal `ceil(max(acceptedPcmDurationMs, validatedProviderProcessedMs)/1000)`. `complete.dailySecondsRemaining` is `max(0, floor(dailyLimitSeconds - newTotal))`, or the same floor using the safe estimated total when the best-effort write fails. Zero-audio sessions do not increment.
- Before sending any server event, serialize once and require `Buffer.byteLength(json, "utf8") <= 65536`. A transcript whose field bound or serialized byte bound is exceeded is not sliced or emitted; it begins terminal `internal_error`, preserving only confirmed text sent by earlier valid events.

### Deterministic terminal rules

1. JavaScript event-loop order decides simultaneous inputs. The first valid `finish` or `cancel` control seen in `streaming` fixes the client intent: `finish` moves to `finishing`; later client controls are ignored, while `cancel` immediately begins terminal cancellation.
2. The effective cap is fixed once at admission as `ready.maxSessionSeconds = min(configuredMaxSessionSeconds, remainingBudgetSeconds)`, with the tie already resolved to `quota_limit` there; the session stores that integer and which bound produced it. Before forwarding each aligned frame, the service compares only its in-memory `acceptedPcmDurationMs` against that stored cap — it never re-reads persisted usage mid-session. Crossing the cap fixes the stored completion reason (`session_limit` or `quota_limit`) and moves to `finishing`.
3. In `finishing`, validated final provider results are still accepted. Provider success begins `complete`; provider error begins the mapped `error`. Socket disconnect or service shutdown before provider success/error begins `disconnect` or `service_restarting`, cancels provider work, and wins by being the first terminal claimant.
4. One synchronous `beginTerminal(outcome)` gate creates and memoizes the sole terminal promise. Later controls, provider callbacks, timer callbacks, disconnects, and shutdown calls reuse it and cannot change the outcome, emit another terminal event, or write usage twice.
5. That promise clears every timer/listener/provider callback, removes active-session membership, closes/cancels the provider as required, performs the single best-effort usage increment when accepted audio is nonzero, emits at most one terminal event if writable, and closes the app socket. Usage persistence completes before `complete`; on write failure it uses the safe estimated remaining value and logs only the closed outcome/error type.

## Shutdown

- Baseline fact: selected remote `master` has inline signal handling and no shutdown module. The `src/shutdown.ts` visible on the invocation branch is unmerged PR #55 code and is not inherited.
- Add idempotent methods to the two known waiter owners to refuse new waits and release existing waits as ordinary early timeouts.
- `src/shutdown.ts` declares the narrow `ShutdownRequestWaiters` contract with `releaseWaiters()` and `drainReleasedReads()`. `PendingAuthStore` implements release and an immediately fulfilled drain. `AppClientPresenceService` registers every `DeviceTokenRepository` read—immediate presence checks, initial reads, and race-closing rechecks—in one active-read set before exposing its promise and removes it only in `finally`; this is feature repository-work tracking, not a general admitted-handler tracker.
- `RealtimeTranscriptionService.dispose()` first refuses new sessions, calls `beginTerminal(service_restarting)` for every nonterminal session, and awaits every memoized terminal promise, including any usage write. If any finalizer rejects or they do not all settle within `disposeTimeoutMs`, `dispose()` rejects; it never reports success while database-capable work continues.
- `BridgeStateTracker.dispose()` synchronously flips an accepting flag before its first await. Every later `handleStatusChangeForBridge`/cancel call from an already-admitted handler is a no-op; pending timers are cleared, and no new callback can enter after the in-flight snapshot. Each callback is inserted into the set synchronously when its timer fires, and disposal awaits every callback, including notification-service stale-token MongoDB cleanup. Its 15,000 ms timeout rejects with `BridgeStateTrackerDrainTimeout` while retaining unresolved work; it never resolves by fencing a live callback.
- `ActivationReminderService.dispose()` stops candidate admission and awaits the current candidate through FCM handling, stale-token cleanup, and marker write. Its existing 15,000 ms disposal bound must reject with `ActivationReminderDrainTimeout` while retaining unresolved work; it must not fulfill merely because the timeout elapsed.
- One memoized signal path invokes waiter release and producer/realtime disposal, then awaits `app.close()` to stop admission and settle all handlers. Only after `app.close()` fulfills does it call `drainReleasedReads()`, which repeatedly snapshots/awaits the active-read set until it is empty; this quiescent loop includes a read registered while shutdown began. Mongo closes only after the drain fulfills.
- One 22,000 ms hard process deadline starts at the first signal and exits 1 exactly once while deliberately skipping Mongo close when any prerequisite rejects/remains pending, so a timed-out finalizer may finish only while MongoDB stays open. Successful ordered drain exits 0. No late-operation fences or admitted-handler tracker.
- Register the same realtime disposal through Fastify close hooks so direct `app.close()` tests do not depend on OS signals.

## Backward Compatibility

- Existing HTTP routes and apps are unchanged when realtime is disabled.
- Capability response is additive. New app compatibility for missing endpoints is owned by S03.
- Protocol version mismatch returns a bounded unsupported-protocol error before provider work.
- No Soniox field appears in the public wire model, so changing provider later requires a new adapter only if its semantics fit protocol 1.

## Configuration and Deployment

- Add validated `REALTIME_TRANSCRIPTION_ENABLED=false`; `SONIOX_REALTIME_MODEL=stt-rt-v5`; `REALTIME_CONNECT_TIMEOUT_MS=10000` (1,000..30,000); `REALTIME_FINISH_TIMEOUT_MS=10000` (1,000..30,000); `REALTIME_DISPOSE_TIMEOUT_MS=15000` (1,000..20,000); `REALTIME_SESSION_MAX_SECONDS=900` (1..900); `REALTIME_FIRST_FRAME_TIMEOUT_MS=5000` (1,000..15,000); `REALTIME_FIRST_AUDIO_TIMEOUT_MS=5000` (1,000..15,000); `REALTIME_OUTBOUND_BUFFER_MAX_BYTES=1048576` (65,536..8,388,608); and `REALTIME_UPGRADE_MAX_PER_MINUTE=120` (12..1000). Realtime has one initial provider implementation, so do not add a one-value provider selector. The post-auth start limit is a fixed 12/user/minute safety policy.
- Extend config's conditional validation so `SONIOX_API_KEY` is required when either async Soniox is selected or realtime is enabled. Disabled realtime must not construct the SDK or require its key.
- The explicit US Soniox WebSocket URL is constructed from validated configuration and passed to the SDK.
- Preserve single-instance deployment and at least the existing 25-second stop grace.

## Automated Tests

- Every valid/invalid control frame, binary-before-ready, duplicate start, protocol mismatch, auth failure, and payload limit.
- Pre-auth limiter bounds missing, malformed, forged, and random bearer attempts before JWT verification; lazy reset, no forwarding-header influence, and no timer/state growth. Post-auth limiter remains independent per validated user.
- Strict fixture parity for every frame/event, all error codes, unknown/omitted fields, sample-rate enum, UTF-8/text bounds, odd/empty/oversized PCM, and exact close mapping in auth and apps.
- Boundary fixtures/tests include first-frame `start_timeout`, fractional persisted usage rounding at admission/completion, quota/product-cap ties, multibyte transcript payloads below/above 65,536 serialized bytes, and proof that an oversized event is never partially emitted.
- Ready, final token append, provisional replacement, finish, cancel, disconnect, provider error, quota/session cap, no-audio, and one usage write.
- Usage write failure preserves terminal behavior; no retry/receipt is created.
- Slow-client buffer threshold and provider limit mapping.
- Provider adapter Zod rejection and safe error mapping.
- Connect caller-abort versus connect-timeout distinction, composed-signal cleanup, and exact `provider_timeout` mapping.
- Disabled capability and route behavior.
- Direct `app.close()` and SIGTERM with active realtime, pending OAuth poll, and app-presence poll.
- App-presence shutdown races cover immediate/initial/recheck reads detached by normal timeout, client abort, shutdown release, and a read registered as shutdown begins; Mongo close follows `app.close()` and an empty quiescent active-read drain.
- Repeated signals share one shutdown promise; DB closes only after successful app/service disposal.
- Table-driven races: finish/cancel, finish/disconnect, finish/provider error, limit/disconnect, provider completion/shutdown, repeated callbacks, and dispose timeout; assert first claimant, one event/close, one usage write, timer/listener removal, and MongoDB-last or no-Mongo-close behavior.
- Bridge tests cover an already-admitted handler attempting status change as disposal begins, prove no new timer/callback is accepted, and prove test-harness cleanup awaits asynchronous tracker disposal.

## Manual Verification

- Use a local fake provider to inspect all protocol events without network egress.
- Confirm logs never contain frame contents, token, project key, user ID, terms, or provider raw messages.
- Real ingress/provider/device checks occur in S04.

## Regression Guide and Commands

```bash
npm ci
docker rm -f rtt-mongo 2>/dev/null || true
docker run --rm -d --name rtt-mongo -p 27018:27017 mongo:7
MONGODB_URI_TEST=mongodb://localhost:27018/auth-backend-test node --import tsx --test --test-concurrency=1 tests/config.test.ts tests/models/voice-realtime.test.ts tests/api/soniox-realtime-api.test.ts tests/clients/soniox-realtime-transcription-client.test.ts tests/services/realtime-transcription-service.test.ts tests/routes/voice-realtime.test.ts tests/index-shutdown.test.ts tests/services/pending-auth-store.test.ts tests/services/app-client-presence-service.test.ts tests/notifications/bridge-state-tracker.test.ts tests/services/activation-reminder-service.test.ts tests/voice/transcribe.test.ts tests/repositories/daily-usage-repo.test.ts
MONGODB_URI_TEST=mongodb://localhost:27018/auth-backend-test npm test
npx tsc --noEmit
npm run lint
npm run format:check
npm run build
npm run circular-dependencies
docker build -t auth-backend:ci .
bash scripts/ci-auth-container-smoke.sh
docker rm -f rtt-mongo
```

`scripts/ci-auth-container-smoke.sh` is the single executable Docker smoke owner. It must create and always clean up an isolated Docker network plus `mongo:7` and `auth-backend:ci` containers; generate only ephemeral masked JWT/analytics/FCM test values; start auth with OpenAI selected and realtime disabled; poll `/health` until `{"status":"ok"}`; assert public `GET /voice/capabilities` reports protocol 1 disabled; assert a `/voice/realtime` upgrade receives HTTP 404 without provider egress; park an OAuth session-status poll; send SIGTERM through `docker stop --time 25`; require the poll's ordinary pending response, auth exit code 0, completion under 10 seconds, and log ordering of waiter registration, shutdown start, waiter release, and MongoDB close. The workflow invokes exactly `bash scripts/ci-auth-container-smoke.sh`; failures dump content-free container logs before cleanup.

## Risks

- SDK outbound buffering is not directly observable; bounded cadence/session plus RSS observation is accepted.
- A hard restart drops sessions and can undercount usage.
- Provider cap can reject legitimate simultaneous users; surface retryable capacity instead of building a queue.
- The small shutdown replacement may not solve unknown handler failures; only reproduced behavior is in scope.

## Acceptance Criteria

- Realtime proxy works end to end with a fake provider and is absent/disabled by default.
- Public protocol contains no provider-specific value.
- Confirmed/provisional semantics and one terminal finalizer are deterministic without an exhaustive race table.
- Shutdown releases observed long polls and owned sessions without broad tracking.
- No excluded coordination subsystem exists.

## Definition of Done

- Focused/full/static/Docker verification passes.
- PR #55 code is not merged or cherry-picked wholesale.
- Safe manual protocol transcript contains metadata only, never user content.
