# Sesori Auth Server

Node.js/TypeScript authentication service. Social login (GitHub, Google) via OAuth2 PKCE, RS256 JWT issuance, token refresh/revocation. Relay verifies tokens using the public key endpoint.

## STRUCTURE

```
.plan/
└── active/real-time-transcription/ # Staged realtime plan; TRACKER.md is the authoritative checkpoint
.plans/
└── activation-reminders/ # Resumable multi-PR plan + design considerations for the activation funnel
src/
├── types/             # Enums + shared types (mongo.ts, oauth.ts, transcription.ts — realtime protocol enums + pinned Soniox URLs)
├── clients/
│   ├── auth/          # OAuth provider abstraction
│   │   ├── oauth-client.ts   # Abstract base — template method: exchangeCode → resolveIdentity
│   │   ├── github-client.ts  # GithubClient extends OAuthClient
│   │   └── google-client.ts  # GoogleClient extends OAuthClient (JWKS verification)
│   ├── openai-client.ts      # OpenAI transcription client
│   ├── realtime-transcription-client.ts       # Provider-neutral realtime client/session contracts
│   ├── soniox-realtime-transcription-client.ts # Soniox realtime adapter (only consumer of raw SDK realtime values)
│   └── soniox-realtime-sdk-factory.ts         # Region-pinned SDK options (region + base_url + realtime.ws_base_url)
├── api/               # Typed adapters translating external SDK values/errors into local models
│   └── soniox-realtime-api.ts # Mandatory realtime validation boundary (safeParse + toRealtimeFailureReason)
├── db/
│   ├── mongo-db-connector.ts  # MongoDbConnector — connection lifecycle, health check
│   └── mongo-db-accessor.ts   # MongoDbAccessor — generic DB access + config-driven ensureIndexes
├── lib/               # Utilities (state-store.ts — LRU singleton, errors.ts — ApiError hierarchy)
├── middleware/         # createAuthMiddleware factory → requireAuth preHandler hook
│   └── realtime-upgrade-rate-limit.ts # Pre-auth, process-wide WebSocket upgrade limiter
├── models/            # Zod schemas — api.ts, bridge.ts (shared bridge enums/schemas), documents.ts, jwt.ts
│   └── voice.ts       # Realtime protocol v1 frame/event schemas + REALTIME_PROTOCOL_ERROR_RETRYABLE
├── repositories/      # Data access — user-repo.ts, oauth-account-repo.ts, bridge-repo.ts, activation-state-repo.ts, …
├── routes/
│   ├── auth/          # OAuth + pending-confirmation flow
│   │   ├── github.ts             # GET /auth/github, POST /auth/github/init, POST/GET callbacks
│   │   ├── google.ts             # mirror of github.ts for Google
│   │   ├── init.ts               # Shared helpers: parseSessionTokenHeader, createPendingOAuthInit, …
│   │   ├── provider-callback.ts  # GET interstitial + POST confirm/deny (HTML responses)
│   │   └── session-status.ts     # GET /auth/session/status long-poll
│   ├── voice-realtime.ts         # GET /voice/realtime registration + post-auth start limiter
│   ├── voice-realtime-socket.ts  # Frame state machine and session handoff
│   └── voice-realtime-support.ts # Frame parsing/validation, wire ceilings, closeCodeForError
├── services/          # Business logic - auth, activation, reminders, tokens, voice, etc.
│   ├── pending-auth-store.ts     # In-memory LRU of pending OAuth sessions (anti-phishing flow)
│   ├── realtime-transcription-service.ts   # Admission, concurrency ceilings, budget read, dispose
│   ├── realtime-transcription-contracts.ts # Injected RealtimeTranscriptionPolicy + session contracts
│   ├── realtime-transcription-errors.ts    # RealtimeAdmissionError + provider→protocol code mapping
│   ├── realtime-transcription-events.ts    # Session callback types + public event validation
│   ├── realtime-public-event-emitter.ts    # Ready/transcript/terminal emission, validated before send
│   ├── realtime-session-controller.ts      # Per-session state, timers, pacing, terminal ordering
│   ├── realtime-session-terminal.ts        # Ready/finish/force-close helpers + billable seconds
│   ├── realtime-session-utils.ts           # Deferred, timers, withTimeout
│   └── realtime-audio-accounting.ts        # Frame validation, cumulative cap, pace budget
├── config.ts          # Zod-validated env config
├── index.ts           # Composition root (wires all dependencies)
├── shutdown.ts        # Ordered shutdown coordinator + hard deadline (see SHUTDOWN)
└── server.ts          # Fastify app factory (buildApp receives typed AppServices)
```

## WHERE TO LOOK

| Task                       | Location                                                                                                                                | Notes                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Add OAuth provider         | `src/clients/auth/` + `src/routes/auth/`                                                                                                | Extend OAuthClient, implement exchangeCode + resolveIdentity, add route plugin in server.ts |
| OAuth pending/confirm flow | `src/routes/auth/init.ts` + `provider-callback.ts` + `session-status.ts`                                                                | Anti-phishing interstitial; pending state in `src/services/pending-auth-store.ts`           |
| Modify JWT claims          | `src/models/jwt.ts` + `src/services/token-service.ts`                                                                                   | Zod schema defines payload shape                                                            |
| Add API endpoint           | `src/routes/`                                                                                                                           | Register as Fastify plugin in `server.ts`, add to AppServices if deps needed                |
| Change DB schema           | `src/models/documents.ts` + `src/repositories/`                                                                                         | Zod document schemas, raw MongoDB driver                                                    |
| Add DB collection          | `src/types/mongo.ts` + `src/db/mongo-db-accessor.ts`                                                                                    | Add to AuthDbCollection enum + DATABASE_CONFIG                                              |
| Auth middleware            | `src/middleware/auth.ts`                                                                                                                | `createAuthMiddleware(tokenService, { devBypassEnabled })` factory; the bypass is injected, never read from the environment |
| Manage bridges             | `src/routes/bridges.ts` + `src/services/bridge-service.ts` + `src/repositories/bridge-repo.ts` + `src/services/bridge-state-tracker.ts` | Per-bridge registry behind `/auth/me bridges[]`; see BRIDGE SUBSYSTEM below                 |
| Product analytics preference/export/deletion | `src/types/product-analytics.ts`, `src/models/{documents,api,product-analytics-export}.ts`, `src/clients/bigquery-product-analytics-*.ts`, `src/api/product-analytics-*.ts`, `src/repositories/{user-repo,product-analytics-*}.ts`, `src/services/product-analytics-*.ts`, `src/routes/product-analytics.ts`, `src/scripts/{backfill-product-analytics-preference,export-product-analytics,suppress-product-analytics-export}.ts` | Required revisioned preference, isolated auth-private export, and separately permissioned privacy-target handoff; see README rollout and IAM boundaries |
| Activation reminders       | `.plans/activation-reminders/` + `src/services/activation-reminder-service.ts` + `src/repositories/activation-state-repo.ts`            | Read `PLAN.md` and `CONSIDERATIONS.md` before continuing the staged implementation          |
| Per-device settings        | `src/routes/settings/settings.ts` + `src/services/settings-service.ts` + `src/repositories/settings-configuration-repo.ts` + `src/models/settings.ts` | Settings keyed by `{userId, deviceId}`; toggle registry + server-resolved defaults live in `models/settings.ts` |
| Async transcription providers | `src/types/transcription.ts` + `src/clients/{async-transcription-client,openai-client,soniox-transcription-client}.ts` + `src/api/soniox-transcription-api.ts` + `src/services/voice-service.ts` + `src/routes/voice.ts` + `src/scripts/purge-soniox-transcription.ts` | One provider chosen at startup, no fallback; OpenAI default, Soniox region-pinned. See ASYNC TRANSCRIPTION below |
| Realtime transcription proxy | `.plan/active/real-time-transcription/` + `src/routes/voice-realtime.ts`, `src/routes/voice-realtime-support.ts`, `src/services/realtime-transcription-service.ts`, `src/services/realtime-session-controller.ts`, `src/clients/soniox-realtime-transcription-client.ts`, `src/api/soniox-realtime-api.ts`, `src/middleware/realtime-upgrade-rate-limit.ts`, `src/shutdown.ts`, `scripts/ci-auth-container-smoke.sh` | Key-aware default: enabled when a Soniox key is configured unless explicitly disabled; provider-neutral protocol v1 over WebSocket. Read `TRACKER.md` for the staged checkpoint before continuing. See REALTIME TRANSCRIPTION below |
| Push notification filtering | `src/models/notification.ts` + `src/services/notification-service.ts` | `NotificationCategory` is the wire contract; `NOTIFICATION_CATEGORY_SETTING_KEYS` maps each category to the toggle that silences it |
| Ordered shutdown           | `src/shutdown.ts` + the `onClose` hook in `src/server.ts`                                                                                | Waiter release, drain ordering, and which failures are fatal; see SHUTDOWN below            |
| Wire dependencies          | `src/index.ts`                                                                                                                          | Composition root — all instantiation happens here                                           |

## CONVENTIONS

- **DI**: Constructor injection for stateful classes. Composition root in `index.ts`.
- **Validation**: All request/response types defined with Zod — safeParse, no .parse()
- **No ODM**: Raw MongoDB driver. Collections via `MongoDbAccessor.getCollection()`
- **Error handling**: Fastify error handler, ApiError hierarchy in `src/lib/errors.ts`
- **ESM**: `"type": "module"` in package.json
- **Config**: All env vars validated by Zod schema at startup (`src/config.ts`)
- **Secrets**: SOPS + age encryption for env files (`env/app/*.env`). NEVER commit plaintext `.env` or `*.pem`
- **Types**: Shared types in `src/types/`. DB-specific config types stay in `src/db/`.
- **Enums**: Use string-valued enums for domain discriminators that are compared or switched on. Do not scatter raw string literals through string-literal unions.
- **Control flow**: Always use braces for `if`, loops, and other control-flow bodies. Separate adjacent guard blocks with a blank line.

## SCALING CONSTRAINTS

- **Pending OAuth sessions are in-process only.** `PendingAuthStore` is an in-memory LRU with a 5-minute TTL. The store is NOT shared between instances. Horizontal scaling of this service requires either sticky sessions (`X-Sesori-Session-Token` → consistent instance) OR migrating the store to Redis. Until then: **single-instance deploys only**.
- Tunable via `PENDING_AUTH_MAX_SESSIONS` (default 10k entries ≈ 10 MB) and `PENDING_AUTH_POLL_TIMEOUT_MS` (default 30s long-poll cap).
- **App-client presence waiters are in-process only.** `AppClientPresenceService` wakes long polls on the instance that commits a device-token registration. Keep auth single-instance until app-presence signaling is distributed.
- **Bridge notification debounce is in-process only.** `BridgeStateTracker` keeps per-(userId, bridgeId) debounce timers and last-notified state in a process-local Map: pending notifications are lost on restart, the map is unbounded for the process lifetime (acceptable under the 50-bridges-per-user registration cap), and multiple instances would double-notify. Same single-instance constraint as above.
- **Activation reminder polling is in-process only.** `ActivationReminderService` has a process-local interval and single-flight guard. Multiple enabled instances can send the same reminder before either writes its MongoDB marker. Keep `ACTIVATION_REMINDERS_ENABLED=false` on all but one instance unless a distributed lease or claim is added.
- **Rate-limit counters are in-process only.** `@fastify/rate-limit` keeps every allowance — the global one and the per-route settings-write one — in a process-local LRU, so N instances grant N times the intended allowance. The route store also defaults to 5000 keys, and an evicted key starts a fresh window, so a limit is a bound on sustained abuse rather than a hard guarantee once distinct keys exceed that. Raise `cache` or move to a shared store before scaling out or before treating any limit as a correctness control. Route limits are compile-time constants (`SETTINGS_WRITE_MAX_PER_MINUTE`, `REALTIME_START_MAX_PER_MINUTE`, and the voice/session equivalents), so retuning one is a deploy, not an env flip.
- **Realtime admission and sessions are in-process only.** The realtime pre-auth upgrade limiter grants 120 attempts/minute by default for the process, the post-auth start limiter grants a fixed 12 starts/minute per verified user in that process, and both ignore forwarding headers. The concurrent-session ceilings (`REALTIME_MAX_CONCURRENT_SESSIONS_PER_USER`, `REALTIME_MAX_CONCURRENT_SESSIONS`) are counted from the same process-local `#active` set, so N instances admit N times the intended concurrency. Realtime active sessions, timers, and shutdown drains also live in memory. Keep auth single-instance while realtime is enabled unless these limits and drains are moved to shared infrastructure.

## ACTIVATION REMINDERS

The activation-reminder feature is intentionally split into independently deployable PRs. `.plans/activation-reminders/PLAN.md` is the authoritative implementation checkpoint and `.plans/activation-reminders/CONSIDERATIONS.md` records the product and architecture decisions. Verify live GitHub state before starting the next slice; do not infer merge status from the static plan alone.

`activationStates` stores one document per user. Milestones are real event timestamps, reminder baselines are campaign scheduling timestamps that may diverge during backfill, and sent markers independently suppress each reminder. Do not conflate these categories. `ActivationService` records milestones from device-token registration, bridge registration, and accepted metadata requests; these secondary writes are failure-isolated from the existing endpoint response. Logout/revoke does not erase lifetime activation history.

`ActivationReminderService` is disabled by default. Its delivery order is due query, immediate eligibility recheck, FCM send, then conditional sent-marker write. Genuine zero-device results are marked complete; FCM-unavailable, thrown sends, and zero-success results with retryable token failures remain eligible. Disposal stops queued candidates and waits up to 15 seconds for the current candidate through its marker write before MongoDB closes; a late FCM result cannot start stale-token cleanup or a marker after that timeout. `dispose()` rejects on that timeout because the drain genuinely did not finish, but the shutdown coordinator treats it as degraded rather than fatal — see SHUTDOWN. Later backfill behavior must follow the staged acceptance criteria in the plan.

## BRIDGE SUBSYSTEM

Desktop bridge instances register via `POST /auth/bridges` (idempotent: clients resend their `bridgeId`; an owned non-revoked id updates in place, anything else mints a new `br_` id). `GET /auth/me` returns `bridges[]` (id, name, platform, addedAt, lastSeenAt — no live status; clients get live connectivity from the relay). The relay reports per-bridge connect/disconnect to `POST /internal/bridge-status`, which requires `bridgeId`; missing or malformed IDs get a 400. Unknown/revoked bridgeIds get a 404, which the relay turns into a WS close 4006 so the bridge re-registers. Bridges authenticate to the relay with the **user access token** — there is no bridge-scoped token. Bridge-scoped JWTs were prototyped and dropped (`8b600dd`): they added a second credential lifecycle (24h TTL, no re-issue path) and a synchronous relay→auth call per connect without buying real revocation, since the bridge host holds the user refresh token regardless. Re-evaluate only if bridge auth must outlive user sessions.

Push notifications debounce through `BridgeStateTracker` (120s), keyed per bridge by `(userId, bridgeId)`.

## ASYNC TRANSCRIPTION

`POST /voice/transcribe` runs on exactly one provider, selected at startup by `ASYNC_TRANSCRIPTION_PROVIDER` and injected as an `AsyncTranscriptionClient`. There is no automatic fallback and no per-request provider choice; switching is a config change plus a restart. OpenAI is the default and deliberately collapses every non-cancellation failure to `internal` behind a `COMPATIBILITY` marker, because released apps expect HTTP 500 for any provider failure. Soniox uses the detailed failure enum.

`src/api/soniox-transcription-api.ts` is a mandatory validation boundary: every SDK status, ID, duration, transcript, and error payload passes through a `safeParse` helper before it reaches the client or the service. Do not consume a raw `@soniox/node` value anywhere else.

`SONIOX_BASE_DOMAIN` is declared in the config schema **only so that setting it fails startup**. It is not a setting, and it is not dead code: the SDK reads it from the environment itself, and it outranks `region` when deriving the default host for *every* Soniox service. Its narrower siblings `SONIOX_API_BASE_URL` and `SONIOX_WS_URL` are deliberately **not** rejected, because each targets exactly one endpoint and our explicit `base_url` / `realtime.ws_base_url` options outrank both — `tests/config.test.ts` proves both cases against the real SDK. `SONIOX_BASE_DOMAIN` is rejected instead of pinned because it moves whatever we have *not* pinned, so refusing it keeps that residual surface closed without depending on every future SDK call site remembering to pass a URL.

Four invariants in `SonioxTranscriptionClient` are load-bearing and easy to undo:

1. **Regional residency** is pinned with an explicit allowlisted `base_url` in `src/index.ts`. `SONIOX_REGION` must match the key's project (`us` for official production, or `eu`), and `region` alone is insufficient because it resolves below `SONIOX_BASE_DOMAIN` and `SONIOX_API_BASE_URL`; an environment variable could otherwise redirect audio and the API key.
2. **Cancellation and timeout are decided from the signals we own**, never from an SDK error shape. `toFailureReason` deliberately maps abort shapes to `unavailable`, not `cancelled`. `toRealtimeFailureReason` in `src/api/soniox-realtime-api.ts` reproduces this exactly; both must move together.
3. **Job identity is correlated.** `wait` and `getTranscript` address the job by the ID we created, and a record echoing a different ID is `malformed_output` — otherwise another job's transcript could be returned and billed.
4. **Cleanup deletes the transcription before the file**, and skips the file entirely when a job delete fails or when a create attempt returned no usable ID. Leaving both for the purge command is the safe state; deleting the file alone strands a job against the provider's cap.

`npm run purge-soniox-transcription` audits residue and only deletes with `--apply`. It reports counts and a closed outcome enum, never IDs or transcript content. Deletes use bounded concurrency, and the file sweep is held back whenever any job delete or list item failed.

Retryable failures carry `Retry-After`: a provider-stated cooldown when present (clamped to 300s), 5s for an unquantified capacity rejection, 1s otherwise.

## REALTIME TRANSCRIPTION

`GET /voice/capabilities` is public and always reports protocol version `1`;
`enabled` mirrors the resolved `REALTIME_TRANSCRIPTION_ENABLED`. With realtime disabled,
`/voice/realtime` is not registered and upgrades return 404. With realtime
enabled, the route uses the normal bearer auth middleware during upgrade and
then keys the post-auth start limiter only from verified `request.user.userId`;
forwarding headers must not influence either realtime limiter.
When `REALTIME_TRANSCRIPTION_ENABLED` is omitted, validated config resolves it
to true exactly when `SONIOX_API_KEY` is present. Explicit `false`/`0` remains
the rollout opt-out; explicit `true`/`1` without a key fails startup.
The pre-auth limiter is process-wide and defaults to 120 upgrades/minute; the
post-auth limiter is fixed at 12 starts/minute per verified user. Both are
process-local, as are active realtime sessions and route/service timers.

`voice-realtime.ts` owns only WebSocket frame validation and session handoff.
It has no general audio queue: a second frame while `start` is still resolving is
invalid, binary-before-ready is `invalid_audio`, duplicate start/control frames
are rejected or ignored according to the state machine, and `finish` keeps the
socket open until the service emits one terminal `complete` or `error`.

Admission enforces concurrency ceilings before it reads the daily budget,
synchronously and including sessions still resolving `start`, because the start
limiter bounds starts per minute and not sessions held at once. Over-ceiling
admissions are refused with retryable `provider_capacity`; a new wire code would
break protocol v1 clients. Budget is read but never reserved, so per-user
overshoot is bounded by the per-user ceiling times the session cap rather than
eliminated.

Each admitted session is bounded twice more. The audio deadline is armed at
provider ready and rearmed on every *accepted* frame — never cleared before the
frame validates — so silence ends the session with `audio_timeout` instead of
holding both sockets to the wall clock. Inbound audio is paced against elapsed
session time plus a burst allowance rather than paused via socket watermarks;
pacing keeps transport detail off the provider-neutral session contract and
bounds what can ever be in flight. Do not replace it with the cumulative cap
alone, which permits a whole session of audio to arrive at once. The cap is
resolved *before* the pace check so pacing measures the prefix that would
actually be forwarded; measuring the delivered payload instead turns the
ordinary last frame of a session — which overruns the cap by design — into
`invalid_audio` rather than a truncated send and a normal `session_limit`
completion, and it buys nothing, because a prefix that outruns the budget is
still refused.

Route limits come from the injected immutable `RealtimeRoutePolicy`; service
limits come from the injected immutable `RealtimeTranscriptionPolicy`. Every
field of both is required, so there is no defaults layer beneath them — the
composition root is the single source of runtime policy. Do not import config or
hardcode runtime policy in route/service internals, and do not reintroduce a
`DEFAULT_*_POLICY` object: an unreachable default that drifts from the config
schema is worse than a compile error. The frame ceilings in
`voice-realtime-support.ts` (`MAX_TEXT_BYTES`, `MAX_BINARY_BYTES`,
`MAX_TRANSPORT_PAYLOAD_BYTES`) are the exception because they are protocol v1
wire contract rather than tuning, and `MAX_TRANSPORT_PAYLOAD_BYTES` must stay one
byte above the audio cap so an oversized frame fails our validation as
`invalid_audio` instead of being dropped by `ws` first. The Soniox realtime
adapter remains the only place that consumes raw `@soniox/node` realtime values;
every SDK result/error crosses `src/api/soniox-realtime-api.ts` before reaching
the service.

The two async-Soniox invariants below apply verbatim to the realtime path, and
both look like cleanups to a reader who does not know why they exist:

1. **Regional residency is pinned three times over.** `createSonioxRealtimeSdkOptions`
   passes `region`, `base_url` *and* `realtime.ws_base_url`. The URL fields are
   not redundant: `region` only selects the base the SDK derives defaults from
   and loses to `SONIOX_BASE_DOMAIN`, while `base_url` and `realtime.ws_base_url`
   are the highest-precedence REST and realtime endpoints and outrank
   `SONIOX_API_BASE_URL` and `SONIOX_WS_URL` respectively. Deleting either URL
   lets an environment variable redirect audio and the API key.
2. **An abort is not a cancellation.** `toRealtimeFailureReason` maps
   `code === "aborted"` and `name === "AbortError"` to `Unavailable`, exactly as
   `toFailureReason` does on the async path. Cancellation is decided from the
   signals we own, never from an SDK error shape; mapping these to `Cancelled`
   would let a provider-initiated teardown be silently swallowed as a user
   cancellation.

Shutdown ordering is load-bearing for the realtime terminal frame — see
SHUTDOWN below.

## SHUTDOWN

`src/shutdown.ts` runs one ordered path: release pending-OAuth and app-client
waiters, `beginShutdown()` on realtime, start the producer drains, **await
realtime disposal to completion**, `app.close()`, await the producer drains,
drain app-presence repository reads quiescently, then close MongoDB.

Realtime disposal must finish *before* `app.close()`. `@fastify/websocket`
registers a `preClose` hook that closes every client socket and Fastify runs
`preClose` ahead of `onClose`, while a session emits its terminal frame only
after an awaited usage write. Running the two concurrently loses that race and
the client gets a bare close instead of `service_restarting` + 1013, which is
the entire reason `ServiceRestarting` and `beginShutdown()` exist. The `onClose`
hook in `src/server.ts` is only a safety net for closes that bypass the
coordinator; it cannot substitute for this ordering, because by the time it runs
the sockets are already gone.

Authenticated realtime sockets waiting for their first frame register a shutdown
listener with the realtime service. `beginShutdown()` synchronously sends them
`service_restarting` and close 1013; registration invokes the listener immediately
when shutdown already began, covering upgrades admitted during the drain window.

**A failed or timed-out disposal is degraded, not fatal.** Producer and realtime
drains are logged as `[Shutdown] disposal degraded` and the ordered shutdown
continues to `mongo.close()` and exit 0. Keeping MongoDB open bought nothing:
the handler's own `process.exit(1)` killed the in-flight work the connection was
supposedly protecting, while turning a routine SIGTERM that landed mid-sweep
into a failed container termination. Failures of the steps that actually own
resources and ordering — `app.close()`, `drainReleasedReads()`, `mongo.close()`
— remain fatal, as does the 22-second hard deadline, which is the real backstop
for "could not stop cleanly". For that reason `app.close()` must never reject
merely because a drain did.

Waiters are released before `app.close()`, so the server keeps serving in-flight
and newly-arrived requests through that window. Anything that cannot answer
truthfully in it must refuse rather than guess: `/auth/session/status` returns
`503 service_restarting` for `PendingAuthStatus.Shutdown`, and
`/auth/app-clients/status?wait=true` returns the same signal via
`AppClientPresenceShuttingDown`. An *immediate* app-client read still answers
normally — its result is a confirmed database read, so shutdown never turns it
into a false `{ registered: false }`.

## NOTIFICATION CATEGORY FILTERING

Every push producer funnels through `NotificationService.sendToUser`, so that is the only place category filtering belongs — adding a second filter at a route or producer would double-apply it. `NotificationCategory` values are the wire contract shared with the client's own enum; changing a value breaks the bridge and the apps. `NOTIFICATION_CATEGORY_SETTING_KEYS` is typed `Record<NotificationCategory, NotificationSettingKey>` so a new category cannot compile until it is mapped to a toggle.

`deviceTokens.deviceId` is the join key to `settingsConfiguration`. It is optional while clients roll it out: a token without one **fails open** and keeps delivering, because it cannot be matched to a stored preference and silently muting it would be worse than an unwanted notification. Do not invert that default until clients reliably send `deviceId`. A token that changes owner has its `deviceId` cleared so it is never filtered against the previous account's settings.

`register-token` predates this feature and every shipped client already calls it with only `{ token, platform }`, so requiring `deviceId` outright would 400 every existing install and remove it from push entirely — a registration failure is not a degraded filter, it is no notifications at all. `AUTH_REQUIRE_DEVICE_ID_IN_TOKEN_REGISTRATION` gates that cutover: ship with it unset, ship the client that sends `deviceId`, then flip it once the install base has rolled over. Same shape as the retired `AUTH_REQUIRE_BRIDGE_ID_IN_STATUS` gate; delete it the same way once every client sends the field.

Fail-open has a cost worth stating: `deviceTokens` is unique on `token`, not `deviceId`, so a device can hold several rows and a token rotation leaves the previous one behind until FCM reports it unregistered. A row predating the client change still has `deviceId: null` and delivers a category that device switched off. Enabling the gate stops new null rows but does not rewrite existing ones, so the window closes by attrition unless the remaining `deviceId: null` rows are deleted deliberately. Do not "fix" this by inverting the fail-open default while clients are mid-rollout — that mutes every install that has not updated.

Filtering applies to activation reminders too — they send `system_update`, so a user who disables that toggle stops receiving them. When every device opts out, `sendToUser` returns `devicesNotified: 0` without calling FCM, and `ActivationReminderService` treats that as a genuine zero-device result and marks the reminder complete rather than retrying forever.

## ANTI-PATTERNS

- **No Mongoose / ODM** — raw MongoDB driver only
- **No `as any`** — TypeScript strict mode, `@typescript-eslint/no-explicit-any: warn`
- **No unvalidated input** — every request body/param goes through Zod
- **No plaintext secrets** — `env/app/prod.env` is the SOPS-encrypted production environment. Use `npm run env:edit` to modify it and `npm run start:prod` only when production-backed local execution is explicitly intended.
- **No ObjectId in services/routes** — string IDs above repository layer, repos convert at boundary
- **No environment-driven auth decisions** — `requireAuth` takes `devBypassEnabled` by injection. Never reintroduce a `process.env` check inside the middleware, and never set `AUTH_DEV_BYPASS_ENABLED` on a deployed instance; it disables JWT verification for every route
- **Never amend commits** — always create new follow-up commits. Amending erases audit trail and makes PR reviews impossible. Force-push is only acceptable for fixing sensitive data leaks.

## PASSWORD ACCOUNTS

Password login (`/auth/email`) is live but there is **no registration endpoint**. Accounts must be seeded out-of-band (e.g. admin CLI, ops tool, direct DB insert). The expected flow:

1. Create a `User` document (generates `userId`)
2. Create a `PasswordAccount` document with the same `userId`, hashed password (Argon2id), and email

See `src/repositories/password-account-repo.ts` for the schema. Do not enable the route in production until a seeding path is documented or a registration flow is implemented.

## TESTING

- **Framework**: Node.js native test runner (`node:test`), NOT Jest/Vitest
- **Assertions**: `node:assert/strict`
- **Concurrency**: Sequential (`--test-concurrency=1`)
- **Setup**: `tests/helpers/setup.ts` → `createTestApp()` returns app + cleanup + user factories
- **Database**: Test MongoDB on `localhost:27017`, DB dropped per suite via cleanup

## COMMANDS

```bash
npm install                    # Install deps
npm run start:prod             # Start locally with SOPS-decrypted production env
npm run dev                    # Start with file watching
npm test                       # Run tests (needs MongoDB)
npm run build                  # TypeScript compile to dist/
npm run lint                   # ESLint
npm run format:check           # Prettier check
npm run circular-dependencies  # Check for circular imports (madge)
npm run env:init               # First-time SOPS/age setup
npm run env:edit               # Edit encrypted production env in $EDITOR
npm run env:update-keys        # Re-encrypt after adding team member
```
