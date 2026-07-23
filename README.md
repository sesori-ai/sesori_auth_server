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

## Quick start

```bash
# Prerequisites: Node.js 22+, MongoDB running on localhost:27017

# Install dependencies
npm install

# Generate RSA keys for JWT signing
mkdir -p keys
openssl genrsa -out keys/private.pem 2048
openssl rsa -in keys/private.pem -pubout -out keys/public.pem

# Set up encrypted environment (first time only)
npm run env:init

# Edit secrets (opens encrypted file in $EDITOR)
npm run env:edit

# Start the server (decrypts env inline via sops)
npm run start:local
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
| `GET`  | `/auth/session/status`          | No   | Long-poll status (requires `X-Sesori-Session-Token`) — returns pending / complete / denied / expired / error |

### Tokens

| Method | Path               | Auth   | Description                                                     |
| ------ | ------------------ | ------ | --------------------------------------------------------------- |
| `POST` | `/auth/refresh`    | No     | Refresh access token (requires `refreshToken` body)             |
| `GET`  | `/auth/me`         | Bearer | Get current user profile + registered `bridges[]`               |
| `POST` | `/auth/logout`     | Bearer | Logout (increments token version; old refresh tokens are rejected) |
| `POST` | `/auth/revoke`     | Bearer | Revoke refresh tokens (token version) and soft-revoke all registered bridges |
| `GET`  | `/auth/public-key` | No     | Get RS256 public key (PEM) — used by relay for JWT verification |

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

Both endpoints return the complete resolved shape:

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
| `AUTH_REQUIRE_BRIDGE_ID_IN_STATUS` | Transition gate for per-bridge tracking: when `true`, `/internal/bridge-status` rejects payloads without `bridgeId` (400). Default `false`. Flip together with the relay's `RELAY_REQUIRE_BRIDGE_ID` once the bridge fleet has rolled over. |
| `ACTIVATION_REMINDERS_ENABLED` | Master switch for activation reminder polling. Default `false`. Enable on only one server instance until distributed leasing exists.                                                         |
| `ACTIVATION_SWEEP_INTERVAL_MS` | Reminder polling interval in milliseconds. Default `900000` (15 minutes).                                                                                                                    |
| `ACTIVATION_BRIDGE_REMINDER_1_DELAY_MS` | Delay from the bridge reminder baseline to the first bridge reminder. Default `7200000` (2 hours).                                                                                           |
| `ACTIVATION_BRIDGE_REMINDER_2_DELAY_MS` | Delay from the bridge reminder baseline to the second bridge reminder. Default `86400000` (24 hours).                                                                                        |
| `ACTIVATION_SESSION_REMINDER_DELAY_MS` | Delay from the session reminder baseline to the first-session reminder. Default `86400000` (24 hours).                                                                                       |
| `ACTIVATION_SWEEP_BATCH_LIMIT` | Maximum candidates queried per reminder kind per sweep. Default `100`; delivery is sequential, so raise only after measuring FCM latency.                                                    |

Activation reminder timers and single-flight state are process-local. Keep `ACTIVATION_REMINDERS_ENABLED=false` on every instance except the single designated sender; multiple enabled instances can duplicate notifications.

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

## npm scripts

| Script                    | Description                                               |
| ------------------------- | --------------------------------------------------------- |
| `npm start`               | Start server (requires `.env` file)                       |
| `npm run start:local`     | Start with sops-decrypted local env                       |
| `npm run start:prod`      | Start with sops-decrypted prod env                        |
| `npm run dev`             | Start with file watching                                  |
| `npm test`                | Run all tests (requires MongoDB)                          |
| `npm run build`           | TypeScript compile                                        |
| `npm run env:init`        | First-time sops/age setup                                 |
| `npm run env:decrypt`     | Decrypt `env/app/local.env` → `.env`                      |
| `npm run env:edit`        | Edit encrypted env in `$EDITOR`                           |
| `npm run env:update-keys` | Re-encrypt all env files after adding a team member's key |
| `npm run backfill-activation` | Preview activation backfill; pass `-- --apply` to persist |

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
