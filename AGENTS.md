# Sesori Auth Server

Node.js/TypeScript authentication service. Social login (GitHub, Google) via OAuth2 PKCE, RS256 JWT issuance, token refresh/revocation. Relay verifies tokens using the public key endpoint.

## STRUCTURE

```
src/
├── clients/           # OAuth API clients (github-client.ts, google-client.ts)
├── db/                # MongoDB connector + collection accessors with ensureIndexes
├── lib/               # Utilities (state-store.ts — LRU cache with TTL for OAuth state)
├── middleware/         # requireAuth preHandler hook (JWT verification)
├── models/            # Zod schemas — documents.ts (User, OAuthAccount), jwt.ts (payload + constants)
├── repositories/      # Data access — user-repo.ts, oauth-account-repo.ts (find/upsert/tokenVersion)
├── routes/            # HTTP handlers — github.ts, google.ts, token.ts (refresh/me/logout/revoke/public-key)
├── services/          # Business logic — auth-service.ts (orchestration), token-service.ts (RS256 sign/verify)
├── config.ts          # Zod-validated env config
├── index.ts           # Entry point (loads keys → DB → app)
└── server.ts          # Fastify app factory with route plugin registration
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add OAuth provider | `src/clients/` + `src/routes/` | Follow github-client.ts pattern, add route plugin in server.ts |
| Modify JWT claims | `src/models/jwt.ts` + `src/services/token-service.ts` | Zod schema defines payload shape |
| Add API endpoint | `src/routes/` | Register as Fastify plugin in `server.ts` |
| Change DB schema | `src/models/documents.ts` + `src/repositories/` | Zod document schemas, raw MongoDB driver |
| Auth middleware | `src/middleware/auth.ts` | `requireAuth` preHandler hook |

## CONVENTIONS

- **Validation**: All request/response types defined with Zod — no manual validation
- **No ODM**: Raw MongoDB driver. Collections accessed via `src/db/collections.ts`
- **Error handling**: Fastify error handler, custom errors in `src/lib/errors.ts`
- **ESM**: `"type": "module"` in package.json, `--loader ts-node/esm` for dev
- **Config**: All env vars validated by Zod schema at startup (`src/config.ts`)
- **Secrets**: SOPS + age encryption for env files (`env/app/*.env`). NEVER commit plaintext `.env` or `*.pem`

## ANTI-PATTERNS

- **No Mongoose / ODM** — raw MongoDB driver only
- **No `as any`** — TypeScript strict mode, `@typescript-eslint/no-explicit-any: warn`
- **No unvalidated input** — every request body/param goes through Zod
- **No plaintext secrets** — use `npm run env:edit` to modify encrypted env, `npm run start:local` to run with SOPS

## TESTING

- **Framework**: Node.js native test runner (`node:test`), NOT Jest/Vitest
- **Assertions**: `node:assert/strict`
- **Concurrency**: Sequential (`--test-concurrency=1`)
- **Setup**: `tests/helpers/setup.ts` → `createTestApp()` returns app + cleanup + user factories
- **Database**: Test MongoDB on `localhost:27017`, DB dropped per suite via cleanup

## COMMANDS

```bash
npm install                    # Install deps
npm run start:local            # Start with SOPS-decrypted local env
npm run dev                    # Start with file watching
npm test                       # Run tests (needs MongoDB)
npm run build                  # TypeScript compile to dist/
npm run lint                   # ESLint
npm run format:check           # Prettier check
npm run env:init               # First-time SOPS/age setup
npm run env:edit               # Edit encrypted env in $EDITOR
npm run env:update-keys        # Re-encrypt after adding team member
```
