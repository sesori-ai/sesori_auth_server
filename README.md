# Sesori Auth Server

Authentication service for [Sesori Mobile App](https://github.com/sesori-ai/sesori_mobile). Manages user accounts via social login (GitHub, Google, Apple) and password login, and issues JWT tokens for relay authentication.

## What it does

- **Social login** — GitHub, Google, and Apple OAuth2 with PKCE (Authorization Code flow). Apple native iOS sign-in via id_token verification is also supported.
- **Password login** — Login with email and password for existing admin-provisioned accounts. No registration endpoint; accounts are seeded out-of-band.
- **JWT tokens** — RS256 access + refresh tokens; relay verifies with the public key
- **Token revocation** — revoke all tokens for a user account (used by bridge when account is compromised)

## Tech stack

| Concern | Choice |
|---------|--------|
| Runtime | Node.js 22 |
| Framework | Fastify |
| Validation | Zod (all request/response types) |
| Database | MongoDB (official driver, no ODM) |
| JWT | RS256 asymmetric (jsonwebtoken) |
| Secrets | SOPS + age encrypted env files |

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
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | No | Health check → `{"status":"ok"}` |

### OAuth
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/auth/github` | No | Get GitHub OAuth URL (requires `redirect_uri`, `code_challenge` query params) |
| `POST` | `/auth/github/callback` | No | Exchange GitHub auth code for JWT tokens |
| `GET` | `/auth/google` | No | Get Google OAuth URL (requires `redirect_uri`, `code_challenge` query params) |
| `POST` | `/auth/google/callback` | No | Exchange Google auth code for JWT tokens |
| `GET` | `/auth/apple` | No | Get Apple OAuth URL (requires `redirect_uri`, `code_challenge` query params). HTTPS redirect URI required. |
| `POST` | `/auth/apple/callback` | No | Exchange Apple auth code for JWT tokens |
| `POST` | `/auth/apple/native` | No | Verify Apple native id_token and return JWT tokens (requires `idToken`, `nonce`) |
| `POST` | `/auth/email` | No | Login with email and password for existing admin-provisioned accounts |

### Tokens
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/auth/refresh` | No | Refresh access token (requires `refreshToken` body) |
| `GET` | `/auth/me` | Bearer | Get current user profile |
| `POST` | `/auth/logout` | Bearer | Logout (clears refresh token) |
| `POST` | `/auth/revoke` | Bearer | Revoke all tokens (increments token version) |
| `GET` | `/auth/public-key` | No | Get RS256 public key (PEM) — used by relay for JWT verification |

## Environment variables

Managed via SOPS-encrypted files in `env/app/`. See `.sops.yaml` for key configuration.

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 3001) |
| `MONGODB_URI` | MongoDB connection string |
| `JWT_PRIVATE_KEY` | RS256 private key (PEM string, `\n`-escaped) |
| `JWT_PUBLIC_KEY` | RS256 public key (PEM string, `\n`-escaped) |
| `GITHUB_CLIENT_ID` | GitHub OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth app client secret |
| `GOOGLE_CLIENT_ID` | Google OAuth app client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth app client secret |
| `APPLE_CLIENT_ID` | Apple Services ID client ID (web OAuth) |
| `APPLE_IOS_CLIENT_ID` | Apple iOS bundle ID (native sign-in) |
| `APPLE_TEAM_ID` | Apple Developer Team ID |
| `APPLE_KEY_ID` | Apple Sign in with Apple key ID |
| `APPLE_PRIVATE_KEY` | Apple `.p8` private key (PEM string, `\n`-escaped) |
| `RELAY_URL` | Relay server WebSocket URL |

## npm scripts

| Script | Description |
|--------|-------------|
| `npm start` | Start server (requires `.env` file) |
| `npm run start:local` | Start with sops-decrypted local env |
| `npm run start:prod` | Start with sops-decrypted prod env |
| `npm run dev` | Start with file watching |
| `npm test` | Run all tests (requires MongoDB) |
| `npm run build` | TypeScript compile |
| `npm run env:init` | First-time sops/age setup |
| `npm run env:decrypt` | Decrypt `env/app/local.env` → `.env` |
| `npm run env:edit` | Edit encrypted env in `$EDITOR` |
| `npm run env:update-keys` | Re-encrypt all env files after adding a team member's key |

## Project structure

```
src/
├── clients/
│   ├── github-client.ts        GitHub API client (token exchange, user fetch)
│   └── google-client.ts        Google API client (token exchange, id_token decode)
├── db/
│   ├── client.ts               MongoDB client (connect/close/getDb)
│   └── collections.ts          Collection accessors + ensureIndexes
├── lib/
│   └── state-store.ts          OAuth state store (LRU cache with TTL)
├── middleware/
│   └── auth.ts                 requireAuth preHandler hook
├── models/
│   ├── documents.ts            Zod document schemas (User, OAuthAccount)
│   └── jwt.ts                  JWT payload schemas + constants
├── repositories/
│   ├── oauth-account-repo.ts       OAuth account find/upsert
│   └── user-repo.ts                User create/find/tokenVersion
├── routes/
│   ├── github.ts               GitHub OAuth2 + PKCE routes
│   ├── google.ts               Google OAuth2 + PKCE routes
│   └── token.ts                Refresh, /auth/me, logout, revoke, public-key routes
├── services/
│   ├── auth-service.ts         OAuth signup/login orchestration + token revocation
│   └── token-service.ts        RS256 key loading, JWT sign/verify
├── config.ts                   Zod-validated env config
├── index.ts                    Entry point (loads keys + DB + app)
└── server.ts                   Fastify app with all route plugins

env/
└── app/
    └── local.env               SOPS-encrypted local environment

scripts/
└── env-init.sh                 First-time sops + age setup

tests/
├── auth/
│   ├── token.test.ts           Token refresh/validate/logout tests
│   ├── github.test.ts          GitHub OAuth route tests
│   ├── google.test.ts          Google OAuth route tests
│   └── revoke.test.ts          Token revocation + bridge removal tests
```

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
