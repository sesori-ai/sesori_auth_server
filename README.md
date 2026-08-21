# Sesori Auth Server

Authentication service for [Sesori Mobile App](https://github.com/sesori-ai/sesori_mobile). Manages user accounts via social login (GitHub, Google, Apple) and password login, and issues JWT tokens for relay authentication.

## What it does

- **Social login** — GitHub, Google, and Apple OAuth2 with PKCE (Authorization Code flow). Apple native iOS sign-in via id_token verification is also supported.
- **Password login** — Login with email and password for existing admin-provisioned accounts. No registration endpoint; accounts are seeded out-of-band.
- **JWT tokens** — RS256 access + refresh tokens; relay verifies with the public key
- **Token revocation** — revoke all tokens for a user account (used by bridge when account is compromised)

## Tech stack

| Concern    | Choice                            |
| ---------- | --------------------------------- |
| Runtime    | Node.js 22                        |
| Framework  | Fastify                           |
| Validation | Zod (all request/response types)  |
| Database   | MongoDB (official driver, no ODM) |
| JWT        | RS256 asymmetric (jsonwebtoken)   |
| Secrets    | SOPS + age encrypted env files    |

## Production environment setup

> **Warning:** The tracked SOPS file is `env/app/prod.env` and contains
> production credentials. Commands that load it can affect deployed production
> data and services. Do not treat this as an isolated local-development
> environment.

```bash
# Prerequisites: Node.js 22+ and authorized SOPS/age access

# Install dependencies
npm install

# Set up encrypted environment (first time only)
npm run env:init

# Edit production secrets (opens env/app/prod.env in $EDITOR)
npm run env:edit

# Start locally with production configuration; this can mutate production data
npm run start:prod
```

## API endpoints

### Health

| Method | Path      | Auth | Description                      |
| ------ | --------- | ---- | -------------------------------- |
| `GET`  | `/health` | No   | Health check → `{"status":"ok"}` |

### OAuth (legacy direct-exchange)

| Method | Path                    | Auth | Description                                                                                                |
| ------ | ----------------------- | ---- | ---------------------------------------------------------------------------------------------------------- |
| `GET`  | `/auth/github`          | No   | Get GitHub OAuth URL (requires `redirect_uri`, `code_challenge` query params)                              |
| `POST` | `/auth/github/callback` | No   | Exchange GitHub auth code for JWT tokens                                                                   |
| `GET`  | `/auth/google`          | No   | Get Google OAuth URL (requires `redirect_uri`, `code_challenge` query params)                              |
| `POST` | `/auth/google/callback` | No   | Exchange Google auth code for JWT tokens                                                                   |
| `GET`  | `/auth/apple`           | No   | Get Apple OAuth URL (requires `redirect_uri`, `code_challenge` query params). HTTPS redirect URI required. |
| `POST` | `/auth/apple/callback`  | No   | Exchange Apple auth code for JWT tokens                                                                    |
| `POST` | `/auth/apple/native`    | No   | Verify Apple native id_token and return JWT tokens (requires `idToken`, `nonce`)                           |
| `POST` | `/auth/email`           | No   | Login with email and password for existing admin-provisioned accounts                                      |

### OAuth (anti-phishing confirmation flow)

The newer flow keeps the client in control of when tokens are issued. The client generates a random 64-char hex `X-Sesori-Session-Token` (case-insensitive on input, canonicalized to lowercase server-side), sends the **raw** value in the header on every request to `/auth/{provider}/init` and `/auth/session/status`, and the server stores only the SHA-256 digest internally — the raw token never touches disk or logs. The browser-side confirmation page describes the device that started the sign-in — its type/OS (from the enum-bounded `clientType`) plus an optional human-readable device name — and the user explicitly confirms before tokens are issued. The device name is an untrusted recognition aid (HTML-escaped); the trustworthy signal is `clientType`.

| Method | Path                            | Auth | Description                                                                                                  |
| ------ | ------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------ |
| `POST` | `/auth/github/init`             | No   | Start pending GitHub OAuth (requires `X-Sesori-Session-Token` header, `clientType` body; optional `device` `{ name, osVersion?, appVersion? }`) |
| `GET`  | `/auth/github/callback`         | No   | Provider redirect → renders the confirmation interstitial HTML                                               |
| `POST` | `/auth/github/callback/confirm` | No   | User confirms/denies sign-in (form-encoded body `state`, `action`)                                           |
| `POST` | `/auth/google/init`             | No   | (same shape as github)                                                                                       |
| `GET`  | `/auth/google/callback`         | No   | (same)                                                                                                       |
| `POST` | `/auth/google/callback/confirm` | No   | (same)                                                                                                       |
| `GET`  | `/auth/session/status`          | No   | Long-poll status (requires `X-Sesori-Session-Token`) — returns pending / complete / denied / expired / error, or `503 service_restarting` during shutdown |

`/auth/session/status` answers `503` with `{"status":"error","message":"service_restarting"}` once shutdown has released its
waiters. It is a refusal, not a verdict: the pending session was neither
confirmed nor denied, and the in-memory store is about to be discarded. Clients
must treat it as retryable — reconnect to a healthy instance and resume polling
with the same `X-Sesori-Session-Token` — and must not surface it as a denied or
expired sign-in. Because the pending store is process-local, a session started
on an instance that restarts cannot be recovered and the client should restart
the flow if polling then reports `expired`.

### Tokens

| Method | Path               | Auth   | Description                                                     |
| ------ | ------------------ | ------ | --------------------------------------------------------------- |
| `POST` | `/auth/refresh`    | No     | Refresh access token (requires `refreshToken` body)             |
| `GET`  | `/auth/me`         | Bearer | Get current user profile + registered `bridges[]`               |
| `POST` | `/auth/logout`     | Bearer | Logout (increments token version; old refresh tokens are rejected) |
| `POST` | `/auth/revoke`     | Bearer | Revoke refresh tokens (token version) and soft-revoke all registered bridges |
| `GET`  | `/auth/public-key` | No     | Get RS256 public key (PEM) — used by relay for JWT verification |

### Product analytics preference

These dedicated endpoints keep product state out of auth profiles, tokens, and
login/refresh responses. New accounts start at `enabled`, revision `1`.

| Method | Path                            | Auth   | Description |
| ------ | ------------------------------- | ------ | ----------- |
| `GET`  | `/product-analytics/preference` | Bearer | Returns `{ "preference": "enabled" | "disabled", "revision": number, "userKey": string }`; `userKey` is the server-derived pseudonymous identity for enabled client events. |
| `PUT`  | `/product-analytics/preference` | Bearer | Compare-and-set update with `{ "preference": "enabled" | "disabled", "expectedRevision": number, "operationId": uuid }`. |

A successful PUT returns the same shape as GET with the incremented revision.
Repeating the same operation ID with the same preference and original expected
revision returns the committed result without another increment. A stale
revision, mismatched operation-ID reuse, or attempted re-enable after permanent
export suppression returns HTTP `409` with the current state:

```json
{
  "error": "conflict",
  "preference": "disabled",
  "revision": 2,
  "userKey": "<64-character lowercase HMAC>"
}
```

`productAnalyticsExportSuppressedAt` is a permanent privacy-deletion tombstone,
not an ordinary opt-out. Reads are forced to `disabled`, re-enable requests
conflict, and the migration backfill persists `disabled` when that tombstone is
present. There is no public endpoint that creates or clears the tombstone.

### Bridges

Bridges authenticate with the user's access token everywhere (relay included) — there are no bridge-specific tokens. The API returns `BridgeSummary` objects (`id`, `name`, `platform`, `addedAt`, `lastSeenAt`); per-bridge connection status is tracked internally for push notifications but never exposed.

Up to **50 non-revoked bridges per user**; registration beyond the cap returns 400. A `bridgeId` belonging to another user is deliberately treated as unknown (a new bridge is minted) rather than returning 403 — this prevents `POST /auth/bridges` from being used to probe bridgeId existence across accounts.

| Method   | Path                       | Auth   | Description                                                                                                                              |
| -------- | -------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/auth/bridges`            | Bearer | Idempotent registration. Body: `{ name, platform, bridgeId? }`. An owned non-revoked `bridgeId` updates that bridge (200); otherwise a new bridge is minted server-side (201). |
| `GET`    | `/auth/bridges`            | Bearer | List the user's non-revoked bridges                                                                                                       |
| `DELETE` | `/auth/bridges/:bridgeId`  | Bearer | Soft-revoke a bridge (404 if unknown, another user's, or already revoked)                                                                 |

### Settings

Per-device application settings (currently notification toggles), keyed by a client-generated `deviceId` (UUIDv4) and always scoped to the authenticated user — a leaked `deviceId` cannot cross accounts. Settings are stored sparse and **resolved against server-side defaults on read**, so a device with no record (or one predating a newly added toggle) reads back a complete, all-enabled set with no migration.

| Method  | Path                       | Auth   | Description                                                                                                                                                     |
| ------- | -------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`   | `/auth/settings/:deviceId` | Bearer | Get the device's fully-resolved settings (defaults applied; returns 200 with defaults when nothing is stored)                                                  |
| `PATCH` | `/auth/settings/:deviceId` | Bearer | Merge-update settings. Body `{ notifications?: { aiInteraction?, sessionMessage?, connectionStatus?, systemUpdate? } }` — all toggles optional, at least one required |
| `DELETE` | `/auth/settings` | Bearer | Drop the stored overrides for **every** device on the account, returning them all to the server defaults. Idempotent — an account that stored nothing returns 200 |

`GET` and `PATCH` return the complete resolved shape:

```json
{
  "deviceId": "550e8400-e29b-41d4-a716-446655440000",
  "notifications": {
    "aiInteraction": true,
    "sessionMessage": true,
    "connectionStatus": true,
    "systemUpdate": true
  },
  "updatedAt": null
}
```

`updatedAt` is `null` until the device stores its first override, then an ISO 8601 timestamp. Missing or invalid bearer authentication returns 401. A malformed/non-v4 `deviceId`, an empty PATCH, unknown groups or toggles, and non-boolean toggle values return 400.

`DELETE` exists for account deletion and is account-wide rather than per-device: it removes the stored document for every device the account configured. It responds `{ "ok": true }` and removes those documents outright rather than rewriting them to all-true, so a subsequent `GET` for any of those devices reads back the defaults with `updatedAt` back to `null`. It never 404s: an absent document already resolves to the defaults, so an account that stored nothing reaches the same end state.

The account is taken from the verified access token, never from a caller-supplied id, so it can only ever clear the caller's own settings. Two accounts that share a `deviceId` hold separate documents, and one deleting its settings leaves the other's untouched.

`PATCH` and `DELETE` are each additionally limited to **30 writes per minute per account**, returning 429 beyond that. `deviceId` is client-generated, so each `PATCH` for an unseen device inserts a row; the limit bounds how fast one client can grow the collection. `DELETE` only ever shrinks it and carries the limit because it is still a mutation, not because it contributes to that growth. The counters are per route rather than pooled, so an account can spend 30 of each in the same minute rather than 30 across both. It is deliberately well above real use — a settings screen has four toggles — so normal clients never reach it. `GET` creates nothing and is not limited beyond the global allowance. This bounds growth rather than capping total devices: an earlier per-user cap was removed in `2e370cb` because the count-then-write pre-check it needed was a persistent source of races.

The allowance is keyed on the access token's `userId` claim rather than the token string, so refreshing does not hand out a new allowance. The signature is verified before that claim is trusted; a request whose token cannot be verified is keyed on the caller's address instead, so forged traffic carrying someone else's `userId` consumes only its own bucket and cannot deny a real account its writes.

Counters live in the process, so this is a bound on sustained abuse rather than a hard guarantee: multiple instances would each grant the full allowance, and the route's LRU holds 5000 keys, after which an evicted key starts a fresh window. That is adequate for the storage-growth concern it exists to address, but do not treat it as a correctness control.

### Notifications

Push notifications are forwarded to Firebase Cloud Messaging. Every notification carries a `category`, and the server **drops it per device** when that device has switched the matching toggle off in `/auth/settings/:deviceId`.

| Wire category      | Settings toggle    | Origin                                        |
| ------------------ | ------------------ | --------------------------------------------- |
| `ai_interaction`   | `aiInteraction`    | Bridge, via `POST /notifications/send`        |
| `session_message`  | `sessionMessage`   | Bridge, via `POST /notifications/send`        |
| `system_update`    | `systemUpdate`     | Bridge, plus activation reminders             |
| `connection_status`| `connectionStatus` | Server, on bridge connect/disconnect          |

`connection_status` is server-originated and is rejected on `POST /notifications/send`.

| Method   | Path                            | Auth   | Description                                                                                     |
| -------- | ------------------------------- | ------ | ----------------------------------------------------------------------------------------------- |
| `POST`   | `/notifications/register-token`  | Bearer | Register an FCM token. Body `{ token, platform, deviceId? }`                                     |
| `DELETE` | `/notifications/tokens/:token`   | Bearer | Unregister an FCM token                                                                          |
| `POST`   | `/notifications/send`            | Bearer | Forward a notification to the user's opted-in devices. Body `{ category, title, body, collapseKey, data? }` |

Filtering is applied to every producer, since they all funnel through `NotificationService.sendToUser` — including activation reminders, which a user can silence via the `systemUpdate` toggle.

**`deviceId` rollout.** `deviceId` on `register-token` is the join key between a push token and its settings document, and it is optional while clients roll it out. A token registered without one cannot be matched to a stored preference, so it **keeps delivering unfiltered** rather than going silent. Per-device filtering only takes full effect once clients send `deviceId`; until then those devices behave exactly as before. A token that changes owner has its `deviceId` cleared, so a recycled token is never filtered against the previous account's settings.

`/notifications/register-token` is not a new endpoint — every shipped client already calls it on sign-in and on FCM token refresh, currently sending only `{ token, platform }`. That is why `deviceId` starts optional: requiring it before clients send it would return 400 on every registration and leave those users with **no push notifications at all**, which is worse than leaving them unfiltered.

Sequence the cutover with `AUTH_REQUIRE_DEVICE_ID_IN_TOKEN_REGISTRATION`:

1. **Deploy this version** with the flag unset. The server stores `deviceId` when a client sends one and filters only those devices.
2. **Ship the client** that includes its existing `deviceId` in the `register-token` body, and wait for the install base to roll over. Tokens still arriving without one remain unfiltered in the meantime.
3. **Flip the flag to `true`.** Registrations without a `deviceId` are then rejected with 400, so every push token is filterable.

Do not flip it before step 2 completes. Registration failures do not degrade filtering — they remove the client from push entirely until it updates, because the token never reaches the server. Flipping back to unset restores the previous behaviour immediately; no data migration is involved either way.

**Known gap while `deviceId` is still optional.** `deviceTokens` is unique on `token`, not on `deviceId`, so one device can hold more than one row. When FCM rotates a token the client registers the new one, and the previous row survives until FCM reports it unregistered on a later send. A row registered before the client sent `deviceId` therefore still has `deviceId: null`, fails open, and can deliver a category that device has switched off. It resolves itself once the stale token is cleaned up, but it is a real window in which an opt-out is not honoured.

Step 3 stops new rows from being created without a `deviceId`; it does **not** retroactively fix rows that already have `deviceId: null`. Those keep failing open until FCM disowns them.

If you need the gap closed immediately rather than by attrition, delete the remaining `deviceId: null` rows after step 3. Deleting a row that is still a live token does remove push for that install until it registers again, so the cost depends on what triggers re-registration:

- **App start.** The client registers on launch for a signed-in user, so a device that is opened again recovers on that launch. This is the normal case and bounds the outage to the user's next session.
- **Sign-in or FCM token refresh.** Also triggers registration, but neither is time-bounded on its own.

A device whose app is never opened again does not self-heal, and the loss there is real rather than theoretical: its token is live and still receiving push today, precisely because an unmatched token fails open. Deleting that row stops notifications the device would otherwise have kept getting, permanently until the app is next opened.

So the choice is between leaving a filtering gap open while it drains by attrition, and closing it immediately at the cost of silencing installs that are still reachable but no longer launched. Run the deletion only where recovering registrations can be observed, and prefer attrition when that recovery cannot be confirmed.

### Realtime voice

Realtime transcription is disabled by default during the staged rollout. Public
`GET /voice/capabilities` is always available, requires no token, and carries no
account or provider data:

```json
{"realtime":{"enabled":false,"protocolVersions":[1]}}
```

| Method | Path                   | Auth                        | Description                                                                                                       |
| ------ | ---------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/voice/capabilities`  | No                          | Capability discovery. Always registered, exempt from the global rate limit. `enabled` mirrors `REALTIME_TRANSCRIPTION_ENABLED`; `protocolVersions` is always `[1]`. |
| `GET`  | `/voice/realtime`      | Bearer (upgrade header)     | WebSocket upgrade for protocol v1 streaming. Only registered when `REALTIME_TRANSCRIPTION_ENABLED` is true; otherwise upgrades receive HTTP 404. |

Clients connect with the standard `Authorization: Bearer <access-token>` upgrade
header; tokens are never accepted in the URL or in frames. Authentication is
fixed at upgrade time, and a live socket is not closed merely because its access
token later expires. Every reconnect requires a fresh valid access token.

Protocol v1 accepts one strict JSON `start` control as the first frame, then
bounded PCM16 binary audio frames, followed by strict `finish` or `cancel`
controls. Binary frames before `ready`, after finish, empty, odd-sized, or over
65,536 bytes are rejected as protocol errors. `finish` asks the provider to
finalize and keeps the socket open until a single `complete` or `error` terminal
event closes it.

#### Session length

One session is capped at `min(REALTIME_SESSION_MAX_SECONDS, remaining daily
quota)` seconds of accepted audio, not at a flat 900. Both halves matter:

- The **configured ceiling** defaults to 900 seconds and is the maximum the
  variable itself accepts, so 900 is the upper bound rather than the value.
- The **remaining daily quota** is `DAILY_TRANSCRIPTION_LIMIT_SECONDS` minus
  seconds already used today. When it is zero the session is refused at
  admission with `quota_exhausted` **before** any provider connection is opened,
  so an exhausted quota costs nothing at the provider.

The effective cap is reported to the client as `maxSessionSeconds` on `ready`,
and both `ready` and `complete` carry `dailySecondsRemaining`. `ready` reports
the remaining quota observed at admission; `complete` reports it after this
session's usage has been written. Reaching the cap ends the session with a
`complete` whose `reason` says which limit bound it.

#### Server events

| Event        | Payload                                                                                     |
| ------------ | --------------------------------------------------------------------------------------------- |
| `ready`      | `{ type, protocolVersion: 1, maxSessionSeconds, dailySecondsRemaining }` — provider is connected and audio may start |
| `transcript` | `{ type, confirmedDelta, provisional }` — at least one is non-empty; each at most 32,768 characters |
| `complete`   | `{ type, reason, dailySecondsRemaining }` — terminal, closes with 1000                        |
| `error`      | `{ type, code, retryable }` — terminal, close code per the table below                        |

`complete.reason` is one of:

| Reason          | Meaning                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------ |
| `finished`      | The client sent `finish` and the provider finalized normally                                    |
| `session_limit` | The session reached `REALTIME_SESSION_MAX_SECONDS`, which was the binding limit at admission     |
| `quota_limit`   | The session reached the remaining daily quota, which was the binding limit at admission          |

#### Error codes

Every `error` event carries a `retryable` boolean, enforced against this table by
the response schema, so a client may trust the flag rather than switch on the
code. The close code follows deterministically from the error code.

| Code                   | Retryable | Close | Raised when                                                                                       |
| ---------------------- | --------- | ----- | --------------------------------------------------------------------------------------------------- |
| `invalid_message`      | no        | 1008  | A text frame is not a valid `start`/`finish`/`cancel`, exceeds the text frame cap, or arrives while `start` is still resolving |
| `unsupported_protocol` | no        | 1008  | A `start` frame names a `protocolVersion` other than `1`                                            |
| `invalid_audio`        | no        | 1008  | A binary frame arrives before `start` resolves, is empty, is odd-sized, exceeds 65,536 bytes, arrives after `finish`, or runs further ahead of real time than the pace budget allows |
| `quota_exhausted`      | no        | 1008  | The daily quota is already spent at admission; no provider connection is attempted                  |
| `provider_rejected`    | no        | 1011  | The provider rejected our credentials or configuration                                              |
| `audio_timeout`        | yes       | 1011  | No accepted audio frame within `REALTIME_FIRST_AUDIO_TIMEOUT_MS` of `ready` or of the previous accepted frame |
| `provider_timeout`     | yes       | 1011  | The provider exceeded `REALTIME_CONNECT_TIMEOUT_MS` or `REALTIME_FINISH_TIMEOUT_MS`                 |
| `internal_error`       | yes       | 1011  | A server-side fault, including provider output that fails our validation boundary                   |
| `start_timeout`        | yes       | 1013  | No `start` frame within `REALTIME_FIRST_FRAME_TIMEOUT_MS` of the upgrade                             |
| `provider_capacity`    | yes       | 1013  | A concurrency ceiling was hit, or the provider reported capacity exhaustion                          |
| `provider_unavailable` | yes       | 1013  | The provider connection failed or dropped for an unclassified reason                                 |
| `slow_client`          | yes       | 1013  | Outbound buffering exceeded `REALTIME_OUTBOUND_BUFFER_MAX_BYTES`                                      |
| `service_restarting`   | yes       | 1013  | The server is shutting down; see the shutdown section                                                |

Close codes are `1008` (policy violation — the client sent something invalid or
exceeded a quota), `1011` (internal error — the failure was ours or the
provider's), and `1013` (try again later — transient, and the only group worth
an automatic reconnect). A non-retryable code will fail the same way on
reconnect; fix the request or wait for the quota to reset instead.

A client implementing against this contract should switch on `retryable`, back
off before reconnecting on `1013`, and treat any unknown future code as
non-retryable.

Realtime upgrade admission has two process-local limits: a pre-auth default of
120 upgrades per minute for the process, and a fixed post-auth limit of 12
starts per verified user per minute. Forwarding headers, `trustProxy`, and
socket IP do not affect either realtime limiter; authentication and rate keys
come only from the verified bearer token after the pre-auth gate. Realtime
active sessions, first-frame/first-audio timers, and shutdown drains are also
process-local. Keep auth single-instance while realtime is enabled unless these
limits and session drains are moved to shared infrastructure.

Rate limits bound how often a session may be *started*, not how many may be held
at once, so admission also enforces concurrency ceilings
(`REALTIME_MAX_CONCURRENT_SESSIONS_PER_USER`, `REALTIME_MAX_CONCURRENT_SESSIONS`)
before it reads the daily budget. Both are counted synchronously, including
sessions still resolving `start`, and a session over either ceiling is refused
with a retryable `provider_capacity`. The daily budget is read but never
reserved, so concurrent sessions still each observe the same remaining seconds:
a user can overshoot the daily limit by at most
`REALTIME_MAX_CONCURRENT_SESSIONS_PER_USER × REALTIME_SESSION_MAX_SECONDS`
before the terminal usage writes land. That overshoot is bounded and accepted;
closing it fully requires reserving budget at admission and reconciling at
terminal, which changes daily-usage accounting and its crash semantics.

Two per-session limits bound what one admitted session can hold. The audio
deadline (`REALTIME_FIRST_AUDIO_TIMEOUT_MS`) is armed when the provider becomes
ready and rearmed on every accepted frame, so a session that goes silent ends
with `audio_timeout` instead of pinning both sockets until the wall-clock cap.
Inbound audio is additionally paced: accepted bytes must stay within
`elapsed session seconds + REALTIME_AUDIO_PACE_BURST_SECONDS` of audio, and a
client beyond that is terminated with `invalid_audio`. The frame that crosses
the cumulative session cap is truncated to the bytes that still fit and the
session completes on `session_limit`/`quota_limit`; pacing measures that
accepted prefix, so a client's ordinary final frame is not refused as a protocol
error for overshooting a limit the server was about to enforce anyway. Live
capture produces one
second of audio per elapsed second, so a client that buffers during a network
stall stays within budget — the stall advances the elapsed clock by the same
amount it buffered. Without pacing the cumulative session cap alone allows an
entire session of audio to be delivered as fast as the client uplink permits,
which queues on this process's heap once the provider applies backpressure.

## Environment variables

Managed via SOPS-encrypted files in `env/app/`. See `.sops.yaml` for key configuration.

| Variable                       | Description                                                                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                         | Server port (default: 3001)                                                                                                                                                                 |
| `MONGODB_URI`                  | MongoDB connection string                                                                                                                                                                   |
| `JWT_PRIVATE_KEY`              | RS256 private key (PEM string, `\n`-escaped)                                                                                                                                                |
| `JWT_PUBLIC_KEY`               | RS256 public key (PEM string, `\n`-escaped)                                                                                                                                                 |
| `GITHUB_CLIENT_ID`             | GitHub OAuth app client ID                                                                                                                                                                  |
| `GITHUB_CLIENT_SECRET`         | GitHub OAuth app client secret                                                                                                                                                              |
| `GOOGLE_CLIENT_ID`             | Google OAuth app client ID                                                                                                                                                                  |
| `GOOGLE_CLIENT_SECRET`         | Google OAuth app client secret                                                                                                                                                              |
| `APPLE_CLIENT_ID`              | Apple Services ID client ID (web OAuth)                                                                                                                                                     |
| `APPLE_IOS_CLIENT_ID`          | Apple iOS bundle ID (native sign-in)                                                                                                                                                        |
| `APPLE_TEAM_ID`                | Apple Developer Team ID                                                                                                                                                                     |
| `APPLE_KEY_ID`                 | Apple Sign in with Apple key ID                                                                                                                                                             |
| `APPLE_PRIVATE_KEY`            | Apple `.p8` private key (PEM string, `\n`-escaped)                                                                                                                                          |
| `RELAY_URL`                    | Relay server WebSocket URL                                                                                                                                                                  |
| `AUTH_BASE_URL`                | Public base URL of this service. Used to build the OAuth `redirect_uri` for the pending-confirmation flow. Must match each provider's registered URI. Defaults to `https://api.sesori.com`. |
| `PENDING_AUTH_MAX_SESSIONS`    | Max concurrent pending OAuth sessions in-memory. Default `10000` (~10 MB).                                                                                                                  |
| `PENDING_AUTH_POLL_TIMEOUT_MS` | Max long-poll duration on `/auth/session/status`. Default `30000`.                                                                                                                          |
| `RELAY_WEBHOOK_SECRET`         | Shared secret authenticating the relay on `/internal/*` endpoints.                                                                                                                          |
| `ASYNC_TRANSCRIPTION_PROVIDER` | Async transcription provider: `openai` (default) or `soniox`. Selected once at startup; a failed request is never retried against the other provider. |
| `SONIOX_API_KEY`               | Soniox API key. Required when `ASYNC_TRANSCRIPTION_PROVIDER=soniox` **or** when `REALTIME_TRANSCRIPTION_ENABLED` is true — realtime always runs on Soniox, so enabling it on the default OpenAI async provider still requires this key or startup fails. Keep it in the encrypted env only. |
| `SONIOX_REGION`                | Soniox project region: `us` or `eu`. Must match the API key's project region. Default `us`. |
| `SONIOX_ASYNC_MODEL`           | Soniox async model. Default `stt-async-v5`. |
| `SONIOX_ASYNC_TIMEOUT_MS`      | Budget covering upload, processing, and transcript fetch. Default `100000` (range 1,000-110,000). |
| `SONIOX_CLEANUP_TIMEOUT_MS`    | Independent budget for deleting provider-side audio. Default `10000` (range 1,000-30,000). |
| `SONIOX_REALTIME_MODEL`        | Soniox realtime model. Default `stt-rt-v5`. |
| `SONIOX_BASE_DOMAIN`           | **Not a setting.** Declared in the schema only so that setting it *fails startup* with `SONIOX_BASE_DOMAIN is forbidden`. The Soniox SDK reads this variable itself and it outranks `SONIOX_REGION` when deriving the default host of every Soniox service, so honouring it would silently move any endpoint we have not pinned. Leave it unset. See "Soniox endpoint pinning" below. |
| `REALTIME_TRANSCRIPTION_ENABLED` | Enables the `/voice/realtime` WebSocket route. Default `false`; disabled deployments still expose protocol 1 capability discovery. Accepted values: `false`, `0`, `true`, `1`. Anything else — including an empty string, `TRUE`, or `yes` — fails startup rather than defaulting to off. Requires `SONIOX_API_KEY`. |
| `REALTIME_CONNECT_TIMEOUT_MS`  | Soniox realtime connect timeout. Default `10000` (range 1,000-30,000). |
| `REALTIME_FINISH_TIMEOUT_MS`   | Provider finalization timeout after client finish/session cap. Default `10000` (range 1,000-30,000). |
| `REALTIME_DISPOSE_TIMEOUT_MS`  | Realtime service shutdown drain timeout. Default `15000` (range 1,000-20,000). |
| `REALTIME_SESSION_MAX_SECONDS` | Maximum accepted audio duration per realtime session. Default `900` (range 1-900). |
| `REALTIME_FIRST_FRAME_TIMEOUT_MS` | Deadline for the first WebSocket `start` frame. Default `5000` (range 1,000-15,000). |
| `REALTIME_FIRST_AUDIO_TIMEOUT_MS` | Deadline for first audio after provider ready. Default `5000` (range 1,000-15,000). |
| `REALTIME_OUTBOUND_BUFFER_MAX_BYTES` | Slow-client outbound buffer threshold. Default `1048576` (range 65,536-8,388,608). |
| `REALTIME_UPGRADE_MAX_PER_MINUTE` | Process-wide pre-auth realtime upgrade allowance. Default `120` (range 12-1000). |
| `REALTIME_MAX_CONCURRENT_SESSIONS_PER_USER` | Concurrent realtime sessions one user may hold in this process, counting sessions still resolving `start`. Default `3` (range 1-50). Exceeding it is refused with `provider_capacity`. Must not exceed `REALTIME_MAX_CONCURRENT_SESSIONS`. |
| `REALTIME_MAX_CONCURRENT_SESSIONS` | Concurrent realtime sessions this process will hold across all users. Default `200` (range 1-10,000). Each session holds a client socket, a provider socket, and timers. |
| `REALTIME_AUDIO_PACE_BURST_SECONDS` | How many seconds of audio a client may deliver ahead of real time before the session is terminated with `invalid_audio`. Default `5` (range 1-60). |
| `CLIENT_IP_SOURCE`             | Source used for per-client rate-limit keys. `socket` (default) ignores proxy headers; `cloudflare` uses `CF-Connecting-IP` only when syntactically valid.                                  |
| `CLOUDFLARE_INGRESS_CIDRS`     | Optional comma-separated Cloudflare ingress CIDRs/IPs. In `cloudflare` mode, `CF-Connecting-IP` is honored only when the socket peer matches this list; otherwise the socket IP is used.       |
| `AUTH_DEV_BYPASS_ENABLED`      | **Local development only — disables JWT verification on every authenticated route.** Default `false`. Accepted values: `false`, `0`, `true`, `1`. Startup fails unless `NODE_ENV=development`. See "Development auth bypass" below. |
| `PRODUCT_ANALYTICS_PSEUDONYMIZATION_KEY` | Canonical base64 for at least 32 random bytes. The web/export/suppression runtimes must use the same long-lived key to derive stable HMAC user keys. |
| `AUTH_REQUIRE_DEVICE_ID_IN_TOKEN_REGISTRATION` | Transition gate for per-device notification filtering. When `true`, `POST /notifications/register-token` rejects a body without `deviceId` (400). Default `false`. Flip only after clients send `deviceId`; doing so earlier drops those clients from push entirely. See the Notifications section. |
| `ACTIVATION_REMINDERS_ENABLED` | Master switch for activation reminder polling. Default `false`. Enable on only one server instance until distributed leasing exists.                                                         |
| `ACTIVATION_SWEEP_INTERVAL_MS` | Reminder polling interval in milliseconds. Default `900000` (15 minutes).                                                                                                                    |
| `ACTIVATION_BRIDGE_REMINDER_1_DELAY_MS` | Delay from the bridge reminder baseline to the first bridge reminder. Default `7200000` (2 hours).                                                                                           |
| `ACTIVATION_BRIDGE_REMINDER_2_DELAY_MS` | Delay from the bridge reminder baseline to the second bridge reminder. Default `86400000` (24 hours).                                                                                        |
| `ACTIVATION_SESSION_REMINDER_DELAY_MS` | Delay from the session reminder baseline to the first-session reminder. Default `86400000` (24 hours).                                                                                       |
| `ACTIVATION_SWEEP_BATCH_LIMIT` | Maximum candidates queried per reminder kind per sweep. Default `100`; delivery is sequential, so raise only after measuring FCM latency.                                                    |

Relay reports to `POST /internal/bridge-status` must include the registered `bridgeId`; missing or malformed IDs are rejected with `400`.

### Client IP source and rate limiting

Global rate limiting keys clients by the socket peer by default. This preserves
the historical behavior and ignores all proxy-supplied headers.

Set `CLIENT_IP_SOURCE=cloudflare` only when the service is reached through
Cloudflare. In that mode, the limiter reads `CF-Connecting-IP` as the client IP
when it is exactly one valid IPv4 or IPv6 address. Missing, empty, malformed, or
comma-separated values fall back to the socket address. The server does not set
Fastify's global `trustProxy`; `X-Forwarded-For`, `request.host`,
`request.hostname`, `request.protocol`, and `request.ips` keep their normal
socket-derived behavior.

> **Warning:** Enabling `cloudflare` mode without restricting origin ingress to
> Cloudflare (firewall or `CLOUDFLARE_INGRESS_CIDRS`) makes rate limiting
> *weaker* than leaving it on `socket`, because a direct-to-origin attacker can
> forge the header for unlimited fresh buckets.

For defense in depth, set `CLOUDFLARE_INGRESS_CIDRS` to the current Cloudflare
ingress CIDR list, published at <https://www.cloudflare.com/ips/>. When
configured, `CF-Connecting-IP` is honored only if the socket peer matches one of
those ranges; direct-origin traffic falls back to the unspoofable socket
address. Cloudflare changes these ranges occasionally, so treat the value as
operational config to re-check rather than a constant.

`/health` and `POST /internal/bridge-status` are exempt from the global limiter.
A throttled liveness probe can get a container restart-looped, and the relay
reports every bridge connect/disconnect from a single source IP, so a reconnect
storm would otherwise exceed the limit and stall bridge status updates.
`/internal/bridge-status` remains authenticated by `RELAY_WEBHOOK_SECRET`.

The loopback exemption (`127.0.0.1`, `::1`) is evaluated against the socket
address, never the resolved client IP, so it cannot be claimed by sending
`CF-Connecting-IP: 127.0.0.1`.

Post-deploy verification: send repeated requests through Cloudflare from two
different client networks and confirm they receive independent rate-limit
budgets, then send a direct-origin request with a forged `CF-Connecting-IP` and
confirm it shares the socket-IP budget rather than the forged header value.

### Development auth bypass

> **Warning:** `AUTH_DEV_BYPASS_ENABLED=true` turns off authentication for the
> entire service. Every route that normally requires a bearer token skips JWT
> verification and runs as one fixed local user, across bridges, voice,
> sessions, settings, analytics and `/auth/me`. It is not a debug log level or a
> verbosity switch. Never set it on a deployed instance.

The bypass is an explicitly injected, default-off option on
`createAuthMiddleware`. The middleware itself reads no environment variable, so
the only way to enable it is to set `AUTH_DEV_BYPASS_ENABLED` **and** run with
`NODE_ENV=development`; the server refuses to start otherwise. The match on
`NODE_ENV` is exact — `Development`, `dev` and `staging` will not enable it.

Earlier revisions of this service bypassed authentication whenever
`NODE_ENV=development` was present, with no second flag and no startup
validation. Any process that happened to carry that value served every
unauthenticated request as a hardcoded user. If you operate a deployment that
predates this change, audit `NODE_ENV` in its environment before assuming it was
unaffected.

Activation reminder timers and single-flight state are process-local. Keep `ACTIVATION_REMINDERS_ENABLED=false` on every instance except the single designated sender; multiple enabled instances can duplicate notifications.

## Graceful shutdown

`SIGTERM` and `SIGINT` run one ordered shutdown: release long-poll waiters, tell
realtime to stop admitting, drain in-flight background work, close the HTTP
server, then close MongoDB. Callers that cannot be answered truthfully in that
window are refused rather than guessed at — `/auth/session/status` and
`/auth/app-clients/status?wait=true` return `503 service_restarting`, and live
realtime sessions receive a `service_restarting` error frame and close 1013.

**The deployment platform must allow at least 25 seconds of SIGTERM grace.** The
process enforces its own 22-second hard deadline (`SHUTDOWN_HARD_DEADLINE_MS` in
`src/shutdown.ts`), which is the only mechanism that reports "could not stop
cleanly" — it exits 1 when the ordered shutdown does not finish in time. A grace
period shorter than 22 seconds makes that deadline unreachable: the platform
SIGKILLs first, in-flight work is lost without a signal, and the container
records an abnormal termination instead. `scripts/ci-auth-container-smoke.sh`
stops the container with `docker stop --time 25` and asserts the normal path
finishes well inside it. Configure Kubernetes
`terminationGracePeriodSeconds`, Cloud Run request timeouts, or the equivalent
accordingly.

**The tunable drains must sum to less than the fixed deadline.** The deadline is
a constant; the drains that must fit inside it are not:

| Drain                        | Budget                                        | Ordering                                        |
| ---------------------------- | --------------------------------------------- | ----------------------------------------------- |
| Realtime session disposal    | `REALTIME_DISPOSE_TIMEOUT_MS` (default 15s, max 20s) | Awaited to completion **before** the HTTP server closes |
| Bridge notification debounce | 15s, fixed in code                            | Started early, awaited after the HTTP server closes |
| Activation reminders         | 15s, fixed in code                            | Started early, awaited after the HTTP server closes |

Realtime disposal is the only one on the critical path, because a session's
terminal frame must be written before `@fastify/websocket` closes the client
sockets. Raising `REALTIME_DISPOSE_TIMEOUT_MS` to its 20-second maximum leaves
roughly 2 seconds for the remaining steps, so raise the platform grace period
and revisit the hard deadline together if you need a longer realtime drain.

**A drain that fails or times out is degraded, not fatal.** It is logged as
`[Shutdown] disposal degraded` and shutdown continues to close MongoDB and exit
`0`. This is deliberate: exiting 1 on a slow drain turned a routine SIGTERM that
happened to land mid-sweep into a failed container termination, while the
immediate exit killed the very in-flight work the still-open database connection
was supposed to protect. Failures of the steps that own resources and ordering —
closing the HTTP server, draining released reads, closing MongoDB — remain
fatal, as does the hard deadline. Treat a nonzero exit on shutdown as a real
fault to investigate; treat a `disposal degraded` log line on an otherwise clean
exit as informational.

## Project-scoped glossary migration

Glossary ownership uses an opaque, stable client-derived project key rather than
a filesystem path or raw bridge project ID:

```text
digestInput = "sesori-project-glossary-v1\0" + projectId
projectKey = "prj_v1_" + base64url(sha256(utf8(digestInput)))
```

The result is exactly `prj_v1_` plus a 43-character unpadded base64url digest.
The canonical cross-repository vector is project ID `project-123` →
`prj_v1_xgjNDm_yyduAKisFHr498ZgcjIU1FACdyEj68wSmbhc`. Using stable `Project.id`
keeps the key unchanged when a directory moves. The server validates only this
opaque shape and scopes it to the authenticated user; the key is not an
authorization credential. It never accepts or persists a raw path for glossary
ownership. Equal project IDs on two bridges deliberately share one glossary for
that user, because the composer flow does not carry bridge identity.

Glossary CRUD requires a project key: `GET /voice/glossary?projectKey=…` and
`POST`/`DELETE /voice/glossary` with `{ projectKey, words }`. `POST
/voice/transcribe` accepts an optional `projectKey` multipart field; omission
means no glossary context is applied and never falls back to a global glossary.
Safety caps are 100 words per request, 500 per project, 5,000 per user, 200
characters per word, and an 8,000-character provider context. Caps are checked
per request rather than serialized, so concurrent requests may narrowly exceed
them; the compound unique index still prevents duplicates.

The scoped runtime and the `{userId, projectKey, word}` startup index
configuration ship together; the previously merged migration command owns the
destructive index cutover. The command defaults to a read-only dry-run and
reports only counts and closed state enums, never words, user IDs, project keys,
documents, or index names:

```bash
sops exec-env env/app/prod.env \
  'npm run migrate-project-glossary-index'
```

The expected production preview is `documentCount: 0`, no invalid/duplicate
counts, `legacyIndexState: "exact"`, `targetIndexState: "absent"`, and
`outcome: "completed"`. Any document, malformed metadata, non-simple collection
collation, index mismatch, or `repair_required` outcome stops the rollout and
requires a separately reviewed data/index plan. Do not infer a project key or
delete production terms ad hoc.

Do **not** deploy the scoped runtime before applying the index. Mutation happens
with the single auth instance stopped, in a maintenance window. For that cutover:

1. Remove the single auth instance from ingress, stop it, and confirm no glossary
   writer remains. Permit exactly one migration command and no manual index DDL.
2. Run `--apply` from the reviewed scoped-runtime artifact:

   ```bash
   sops exec-env env/app/prod.env \
     'npm run migrate-project-glossary-index -- --apply'
   ```

3. Keep auth stopped while handling the closed outcome:
   - `completed`: proceed to read-only `--verify`.
   - `safe_to_rerun`: rerun the same mode; this is limited to valid data with
     absent/exact indexes, such as interruption before the destructive drop.
   - `repair_required`: do not rerun blindly or start either binary. Restore DB
     observability if needed and obtain a separately reviewed repair.
4. Run `--verify` and require target `exact`, legacy `absent`, every invalid/
   duplicate count zero, and `completed` before starting the scoped runtime:

   ```bash
   sops exec-env env/app/prod.env \
     'npm run migrate-project-glossary-index -- --verify'
   ```

The maintenance/no-DDL exclusion remains held through each command's exit and
capture of its report. Apply creates and reload-verifies the target unique index,
re-audits all data/index metadata, drops the old index, and performs the complete
audit again. An exact-both interruption is resumable. Post-drop invalid data,
mismatched DDL, or unknown state is `repair_required`, not automatically
recoverable.

Rollback is allowed only while the glossary collection is empty. If the scoped
runtime fails before any project-scoped term is written, keep it stopped and run:

```bash
sops exec-env env/app/prod.env \
  'npm run migrate-project-glossary-index -- --rollback'
```

Require the rollback report itself to show legacy `exact`, target `absent`, zero
documents, and `completed` before restoring the old binary. Do not use forward
`--verify` after rollback. Once any scoped term exists, rollback is forbidden;
repair or roll forward with the scoped runtime.

## Async transcription providers

`POST /voice/transcribe` runs on exactly one provider, chosen at startup by
`ASYNC_TRANSCRIPTION_PROVIDER`. There is no automatic fallback: if the selected
provider fails, the request fails with a provider-neutral error. Switching
providers is a configuration change plus a restart.

OpenAI remains the default. **Do not select Soniox in production until the
Soniox DPA is signed, a regional project and key matching `SONIOX_REGION` are
provisioned, the matching privacy disclosure is published, and the mobile app's
request timeout exceeds the server budget.**
Soniox async processing can take longer than the app's current 30-second
timeout.

Before rolling back to a binary that predates US-region support, first set
`ASYNC_TRANSCRIPTION_PROVIDER=openai` and `SONIOX_REGION=eu`, then restart and
verify OpenAI transcription on the current binary. The older binary rejects
`SONIOX_REGION=us`; never start it before this configuration transition.

Provider failures map to bounded errors, each carrying an additive `retryable`
boolean that older apps may ignore:

| Condition | Status | Error | Retryable |
| --- | --- | --- | --- |
| Provider rejected the audio | `400` | `bad_request` | no |
| Provider capacity or outage | `503` | `transcription_unavailable` | yes |
| Provider exceeded the time budget | `504` | `transcription_timeout` | yes |
| Provider rejected our credentials or configuration | `500` | `transcription_configuration_error` | no |
| Provider returned an unparseable response | `502` | `transcription_provider_error` | yes |

`Retry-After` accompanies the retryable statuses. When the provider states its
own cooldown (a `Retry-After` on its 429) that value is honored, clamped to at
most 300 seconds so a misconfigured provider cannot stall clients. A capacity
rejection the provider did not quantify falls back to 5 seconds; every other
retryable failure uses 1 second. The daily Sesori quota remains a separate
`429 quota_exceeded` and is never reported as provider capacity. OpenAI
deliberately keeps its shipped behavior of reporting every provider failure as
`500 internal_server_error`.

Each request deletes its provider-side transcription and then its uploaded file.
A hard crash, or a job creation whose outcome never came back, can strand those
resources, so audit them periodically:

```bash
sops exec-env env/app/prod.env 'npm run purge-soniox-transcription'
```

The command audits by default and only deletes with `--apply`. It prints counts
and an outcome, never IDs, filenames, or transcript content.

> **Warning:** `--apply` deletes every file and job the project lists, including
> one an in-flight request just created. Run it only after switching the
> provider away from Soniox or draining auth traffic, and after confirming no
> Soniox transcription is still in flight.

```bash
sops exec-env env/app/prod.env 'npm run purge-soniox-transcription -- --apply'
```

The report shape is `{ mode, outcome, fileCount, transcriptionCount,
deletedFileCount, deletedTranscriptionCount }`. Any `outcome: "failed"` exits
nonzero and should be investigated before a rerun. Deletes are issued with
bounded concurrency, and the file sweep is held back whenever any job delete or
list item failed, so the command is safe to rerun and is idempotent once a sweep
completes.

### Soniox endpoint pinning

Regional data residency is enforced with a closed server-owned endpoint
allowlist; official production uses the US project. Both the async and realtime
Soniox clients are constructed with explicit endpoints — `base_url`
for REST and, for realtime, `realtime.ws_base_url` — because `SONIOX_REGION`
alone is not sufficient. The SDK resolves each endpoint in this order, highest
precedence first:

1. The explicit option we pass (`base_url`, `realtime.ws_base_url`)
2. The matching environment variable (`SONIOX_API_BASE_URL`, `SONIOX_WS_URL`)
3. A host derived from `SONIOX_BASE_DOMAIN`, which **overrides the region**
4. A host derived from `region`

`SONIOX_API_BASE_URL` and `SONIOX_WS_URL` are therefore harmless in our
deployments: each targets one endpoint, and our explicit option outranks it.
They are deliberately left alone rather than rejected.

`SONIOX_BASE_DOMAIN` is different. It rewrites the base that *every* default
Soniox service host is derived from, so it moves any endpoint that is not pinned
explicitly. Rather than depend on every present and future SDK call site
remembering to pass a URL, the config schema **rejects it outright**: setting it
fails startup with `SONIOX_BASE_DOMAIN is forbidden`. It appears in the schema
only for that purpose — it is not a tunable, and deleting the declaration would
silently re-open the hole. `tests/config.test.ts` covers the rejection and
asserts the precedence claims against the real SDK.

## Activation backfill

Deploy the activation-state schema and indexes before running the existing-user backfill. The command requires `MONGODB_URI`, defaults to dry-run, and does not create indexes or write documents unless `--apply` is present.

```bash
# Preview with the production encrypted environment.
sops exec-env env/app/prod.env \
  'npm run backfill-activation -- --batch-limit 500 --jitter-window-ms 86400000'

# Persist after reviewing the preview report.
sops exec-env env/app/prod.env \
  'npm run backfill-activation -- --apply --batch-limit 500 --jitter-window-ms 86400000'
```

Before applying, require `usersFailed: 0` and review `byStage` and `byReminder` against the expected cohort. A reminder baseline is the command start time plus deterministic per-user jitter; the configured reminder delay is added afterward. With the default jitter, bridge reminder 1 is due roughly 2-26 hours after the command, while bridge reminder 2 and the session reminder are due roughly 24-48 hours afterward.

The command fixes its cohort at startup, so accounts created while it runs continue through organic enrollment. It logs cumulative counters after every batch and exits nonzero on fatal or per-user failures. Apply is idempotent: each successful user is atomically stamped with `backfilledAt`, and a rerun skips that user while retrying unstamped failures. If the command is interrupted, rerun it with `--apply`; do not edit activation records manually. Proposed and applied stage counts can differ when an organic milestone lands during the run because the atomic write assigns the baseline to the stage current at write time.

The backfill itself sends no notifications. Delivery still requires the default-off activation reminder scheduler to be enabled on exactly one server instance; monitor `[ActivationBackfill]` and `[ActivationReminderService]` logs during rollout.

## Product analytics preference rollout

This is a write-first migration. Deploy the version that writes all preference
fields on every new account to every serving instance before applying the
backfill. The command pages candidates in `_id` order, limits each read/write
batch, logs cumulative progress, and writes only when `--apply` is present.
The default batch limit is 500 and the maximum is 1000.

```bash
# Validate only. This exits nonzero while any legacy account is incomplete.
sops exec-env env/app/prod.env \
  'npm run backfill-product-analytics-preference -- --batch-limit 500'

# Apply bounded, idempotent batches.
sops exec-env env/app/prod.env \
  'npm run backfill-product-analytics-preference -- --apply --batch-limit 500'

# Validate again after apply; repeat this check before enforcing the schema.
sops exec-env env/app/prod.env \
  'npm run backfill-product-analytics-preference -- --batch-limit 500'
```

Before Step 2 enforcement, verify newly created users contain
`productAnalyticsPreference`, `productAnalyticsPreferenceUpdatedAt`,
`productAnalyticsPreferenceRevision: 1`, and
`productAnalyticsPreferenceLastOperationId: null`. Then require
the validation report to show `usersFound: 0` and `missingAfter: 0` on repeated
runs. Do not enforce the required schema based only on a successful apply exit.
Apply mode is safe to rerun after interruption: it preserves existing values,
fills only missing migration fields, and keeps permanently suppressed accounts
disabled.

The enforcing server now fails startup if any required preference field is
missing or a permanently suppressed account is still stored as enabled. Deploy
it only after the write-first version is live everywhere and repeated validation
reports zero candidates. Roll back to the write-first release—not an older
schema—if enforcement must be reverted.

This version also requires `PRODUCT_ANALYTICS_PSEUDONYMIZATION_KEY` at web
startup because the authenticated preference API returns the server-derived
HMAC user key. Configure the shared secret before merge/auto-deploy; do not let
the web, export, and suppression runtimes receive different values.

## Product analytics auth export

The one-shot auth export is isolated from the web process and is intended for a
least-privileged daily Cloud Run Job. The web server never constructs BigQuery
clients. The job uses Application Default Credentials and accepts only its
auth-private dataset plus one fully qualified, read-only internal-exclusion
view:

- `PRODUCT_ANALYTICS_GCP_PROJECT_ID`
- `PRODUCT_ANALYTICS_AUTH_DATASET_ID`
- `PRODUCT_ANALYTICS_INTERNAL_EXCLUSION_VIEW`
- `PRODUCT_ANALYTICS_BIGQUERY_LOCATION`
- `PRODUCT_ANALYTICS_PSEUDONYMIZATION_KEY`
- optional `PRODUCT_ANALYTICS_EXPORT_BATCH_LIMIT` (default 500, maximum 1000)
- optional `PRODUCT_ANALYTICS_INTERNAL_EXCLUSION_MAX_KEYS` (default 10000, maximum 100000)
- optional `PRODUCT_ANALYTICS_INTERNAL_EXCLUSION_MAX_AGE_MS` (default 48 hours)
- `MONGODB_URI`

Generate the pseudonymization key once with `openssl rand -base64 32`, store it
as a secret, and provide the exact same value to the web, export, and suppression
runtimes. It is an HMAC key, not a public salt. Do not rotate it without a
coordinated re-key migration for client events, auth snapshots, and deletion
targets; a mismatched key breaks privacy joins.

The control view must return `user_key`, `is_active`, and a common
`control_updated_at`. It must include one row with a nullable `user_key` as a
freshness sentinel even when there are no active exclusions. Missing, stale,
malformed, duplicate, or oversized controls abort publication. The job stages
only pseudonymous/aggregate rows in tables expiring within 24 hours, reconciles
late preference changes, validates both products, and transactionally replaces
`auth_user_milestones` and `auth_weekly_setup_cohorts`. Failed runs leave the
previous publication intact. The same transaction appends aggregate source,
exclusion, reconciliation, cutoff, and freshness metadata to
`product_analytics_export_runs`; it contains no source account identifiers.

The deployment identity—not the export job—must provision and own the permanent
schemas for `auth_user_milestones`, `auth_weekly_setup_cohorts`,
`product_analytics_export_runs`, and the singleton
`product_analytics_export_state`. At startup the job requires exact schemas,
then acquires a distributed lease in the state table. Promotion verifies lease
ownership and a strictly newer `run_cutoff` in the same transaction, preventing
an older or overlapping run from republishing stale privacy state. The runtime
creates only expiring staging tables.

The final preference pass records its start as `preference_scan_cutoff` and
conservatively scans every current preference timestamp after `run_cutoff`
without an upper bound. This is deliberate: a later write cannot hide an
earlier in-window change when Mongo stores only the latest timestamp. A change
after scan start may be excluded early when observed; otherwise it belongs to
the next successful run. An observed source-suppression change aborts. The job
also reloads the internal control immediately before cohort write/promotion and
aborts when that snapshot differs; a control update after this final snapshot is
applied by the next run rather than coordinated through a cross-dataset lock.

Build the production image normally and override its command with:

```bash
node dist/scripts/export-product-analytics.js
```

The equivalent source command is `npm run export-product-analytics`. Keep the
job disabled until the same-location private dataset, authorized exclusion
view, and split IAM described by the analytics rollout exist. Do not give the
web identity any BigQuery role or provide service-account JSON keys.

## Permanent product analytics suppression

`npm run suppress-product-analytics-export` is a protected operator command,
not an HTTP route. Its separate identity needs source suppression access plus
append/read-status access only to
`privacy_private.product_analytics_deletion_targets`; it must not receive auth
export, control, raw-event, curated, or reporting access. Supply a verified
request as bounded JSON on protected stdin—never argv or shell history:

- `MONGODB_URI`
- `PRODUCT_ANALYTICS_GCP_PROJECT_ID`
- `PRODUCT_ANALYTICS_PRIVACY_DATASET_ID`
- `PRODUCT_ANALYTICS_BIGQUERY_LOCATION`
- `PRODUCT_ANALYTICS_PSEUDONYMIZATION_KEY` (the same long-lived key used by the web and export job)

```json
{"userId":"<verified Mongo account id>","requestId":"<external privacy request id>"}
```

The command first atomically disables and permanently tombstones the source
account, then derives the new HMAC pseudonym plus the deletion-only legacy
SHA-256 Firebase user ID and hands only those values, the external request ID,
tombstone time, and pending status to the restricted target table. The legacy
value exists only so the downstream processor can delete data created before
the HMAC migration; it must never enter new analytics exports. Output contains
only request ID and status. If target
handoff fails, the source tombstone remains and rerunning the same request is
idempotent. In a production image invoke
`node dist/scripts/suppress-product-analytics-export.js`. Do not run it before
the restricted target dataset/table and deletion identity exist.

## npm scripts

| Script                    | Description                                               |
| ------------------------- | --------------------------------------------------------- |
| `npm start`               | Start server using the current process environment        |
| `npm run start:prod`      | Start with SOPS-decrypted production configuration        |
| `npm run dev`             | Start with file watching                                  |
| `npm test`                | Run all tests (requires MongoDB)                          |
| `npm run build`           | TypeScript compile                                        |
| `npm run env:init`        | First-time sops/age setup                                 |
| `npm run env:decrypt`     | Decrypt `env/app/prod.env` → plaintext `.env`             |
| `npm run env:edit`        | Edit encrypted production env in `$EDITOR`                |
| `npm run env:update-keys` | Re-encrypt all env files after adding a team member's key |
| `npm run backfill-activation` | Preview activation backfill; pass `-- --apply` to persist |
| `npm run backfill-product-analytics-preference` | Validate preference migration; pass `-- --apply` to persist bounded batches |
| `npm run export-product-analytics` | Run one isolated auth-private export using ADC (unscheduled until analytics IAM exists) |
| `npm run suppress-product-analytics-export` | Read one protected suppression request from stdin and hand off a restricted deletion target |
| `npm run migrate-project-glossary-index` | Dry-run glossary index migration; mutation flags require the documented maintenance window |
| `npm run purge-soniox-transcription` | Audit Soniox async residue; `-- --apply` deletes it. Reports counts only |

## Project structure

See the **STRUCTURE** section in [AGENTS.md](AGENTS.md) — it is the maintained, authoritative map of the codebase.

## Tests

```bash
# Requires MongoDB running on localhost:27017
npm test
```

## Related

- [Sesori Mobile App](https://github.com/sesori-ai/sesori_mobile) — Flutter mobile client
- [Sesori Relay](https://github.com/sesori-ai/sesori_relay_server) — WebSocket relay server
- [Sesori Bridge](https://github.com/sesori-ai/sesori_bridge) — Laptop-side bridge CLI
