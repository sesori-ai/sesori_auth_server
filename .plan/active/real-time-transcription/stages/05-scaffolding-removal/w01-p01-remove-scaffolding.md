# S05-W01-P01: Remove Triggered Compatibility Scaffolding

## Metadata

- **ID:** S05-W01-P01
- **Repository:** `sesori-ai/sesori_auth_server`
- **Worktree:** worker-created `sesori_auth_server/.worktrees/real-time-transcription-s05-w01-p01`
- **Base branch:** `master`
- **Audited base tip:** pin at implementation time after drift assessment
- **Branch:** `plan/real-time-transcription/s05-w01-p01-remove-scaffolding`

## Goal and Cohesion

Delete the scaffolding this plan added only to survive its own transitions, once each trigger has fired. Cohesive because it changes no runtime behavior for any supported client: it removes paths that can no longer be reached or reversed.

## Dependencies

- S04-W02-M01 complete.
- Per-item triggers below individually satisfied. Items whose triggers have not fired are explicitly retained.

## Removal Inventory and Triggers

Each row is independent. Remove a row only when its trigger has fired; otherwise restate the trigger in the PR and leave the code untouched.

| # | Scaffolding | Location | Trigger |
|---|---|---|---|
| 1 | Optional transcribe project key | `COMPATIBILITY 2026-08-06` markers in `src/models/voice.ts` and `src/routes/voice.ts`, the optional schema member, the omission-to-`null` normalization, and the legacy-omission test | Minimum supported app always sends project context |
| 2 | OpenAI async compatibility error mapping | `COMPATIBILITY` marker and `LegacyOpenAiV1` branch in `src/services/voice-service.ts`, the policy enum, composition selection, and policy-specific tests | OpenAI async rollback support explicitly retired, or a breaking error-contract rollout approved |
| 3 | OpenAI async adapter and provider branch | OpenAI transcription adapter, `ASYNC_TRANSCRIPTION_PROVIDER` branch and config | Soniox is the only intentionally supported async provider. Preserve the independent OpenAI metadata client |
| 4 | Capability-absent app fallback | Apps-monorepo `COMPATIBILITY` fallback to async when capability discovery fails | All supported auth deployments expose capability protocol 1. Apps-repo change; coordinate separately |

## Non-Goals

- Removing any marker whose trigger has not fired.
- Database changes of any kind. This PR is code and documentation only.

## Data Flow and Ownership

No runtime data flow changes. Deletions are confined to provider adapters, request schemas, and their tests.

## Backward Compatibility

- Items 2 and 3 are invisible to clients by construction.
- Item 1 makes `projectKey` required on `POST /voice/transcribe`. It is a breaking change for any app that omits it, which is why its trigger is minimum-supported-app coverage rather than elapsed time.
- No compatibility marker is added by this PR; markers are only removed.

## Automated Tests

- Delete tests that exercised removed paths; do not weaken tests that cover retained behavior.
- If item 1 is removed, replace the legacy-omission test with one asserting that omission is now rejected.

## Regression Guide and Commands

```bash
npm ci
docker rm -f rtt-mongo 2>/dev/null || true
docker run --rm -d --name rtt-mongo -p 27018:27017 mongo:7
MONGODB_URI_TEST=mongodb://localhost:27018/auth-backend-test npm test
npx tsc --noEmit
npm run lint
npm run format:check
npm run build
npm run circular-dependencies
docker rm -f rtt-mongo
```

## Risks

- Removing a fallback too early can break a supported client or provider rollback. Mitigated by evidence-based triggers.

## Acceptance Criteria

- Every removed item's trigger is evidenced in the PR description, not asserted.
- Retained items are listed with their still-open triggers.
- No dead enum value, flag, config branch, script, README section, or test survives a removal.

## Definition of Done

- Focused and full verification passes.
- The PR states which inventory rows were removed and which were retained, with evidence for each.
