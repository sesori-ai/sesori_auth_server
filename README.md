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

The newer flow keeps the client in control of when tokens are issued. The client generates a random 64-char hex `X-Sesori-Session-Token` (case-insensitive on input, canonicalized to lowercase server-side), sends the **raw** value in the header on every request to `/auth/{provider}/init` and `/auth/session/status`, and the server stores only the SHA-256 digest internally — the raw token never touches disk or logs. The browser-side confirmation page shows a 4-char visual code that the client also displays — users only confirm when both match.

| Method | Path                            | Auth | Description                                                                                                  |
| ------ | ------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------ |
| `POST` | `/auth/github/init`             | No   | Start pending GitHub OAuth (requires `X-Sesori-Session-Token` header, `clientType` body)                     |
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

## Project structure

See the **STRUCTURE** section in [AGENTS.md](AGENTS.md) — it is the maintained, authoritative map of the codebase.

## Tests

```bash
# Requires MongoDB running on localhost:27017
npm test
```

36 tests across 4 suites covering all API endpoints.

## Related

- [Sesori Mobile App](https://github.com/sesori-ai/sesori_mobile) — Flutter mobile client
- [Sesori Relay](https://github.com/sesori-ai/sesori_relay_server) — WebSocket relay server
- [Sesori Bridge](https://github.com/sesori-ai/sesori_bridge) — Laptop-side bridge CLI
