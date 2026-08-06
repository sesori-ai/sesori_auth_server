# S05-W01-P01: Remove Triggered Compatibility and Migration Scaffolding

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
| 1 | Glossary index rollback mode | `GlossaryIndexMigrationMode.Rollback`, `rollbackMigration()`, `canRollback()`, `isRolledBack()`, `legacyGlossaryIndexSpec`/`legacyGlossaryIndexName` recreation at the rollback create-index call, `--rollback` CLI flag and usage line, README rollback runbook, rollback tests | Rollback window closed: production holds at least one project-scoped glossary document, so the empty-collection precondition can never hold again |
| 2 | Legacy glossary document schema | `legacyGlossaryEntryMigrationSchema` and its `COMPATIBILITY 2026-08-02` marker in `src/models/documents.ts`, plus the unscoped branch of `auditDocuments` | No unscoped glossary document can exist in any environment the tooling still audits, and the forward audit no longer needs to classify one |
| 3 | Optional transcribe project key | `COMPATIBILITY 2026-08-06` markers in `src/models/voice.ts` and `src/routes/voice.ts`, the optional schema member, the omission-to-`null` normalization, and the legacy-omission test | Minimum supported app always sends project context |
| 4 | OpenAI async compatibility error mapping | `COMPATIBILITY` marker and legacy mapping in `src/clients/openai-client.ts` | OpenAI async rollback support explicitly retired, or a breaking error-contract rollout approved |
| 5 | OpenAI async adapter and provider branch | OpenAI transcription adapter, `ASYNC_TRANSCRIPTION_PROVIDER` branch and config | Soniox is the only intentionally supported async provider. Preserve the independent OpenAI metadata client |
| 6 | Capability-absent app fallback | Apps-monorepo `COMPATIBILITY` fallback to async when capability discovery fails | All supported auth deployments expose capability protocol 1. Apps-repo change; coordinate separately |

## Explicitly Retained

- **Legacy index detection.** `classifyIndex` against the legacy spec, `legacyIndexState`, and the `ensureIndexes` startup guard stay permanently. They assert the legacy index is *absent*; that assertion is what prevents silent word loss from a resurrected index, and it is not a reversal path.
- **The migration command itself**, including dry-run, `--apply`, and `--verify`. Only rollback mode is in scope.

## Non-Goals

- Redesigning the migration tool or the startup guard.
- Removing any marker whose trigger has not fired.
- Database changes of any kind. This PR is code and documentation only.

## Data Flow and Ownership

No runtime data flow changes. Deletions are confined to migration tooling, provider adapters, request schemas, and their tests.

## Backward Compatibility

- Items 1, 2, 4, and 5 are invisible to clients by construction.
- Item 3 makes `projectKey` required on `POST /voice/transcribe`. It is a breaking change for any app that omits it, which is why its trigger is minimum-supported-app coverage rather than elapsed time.
- No compatibility marker is added by this PR; markers are only removed.

## Automated Tests

- Delete tests that exercised removed paths; do not weaken tests that cover retained behavior.
- Keep and re-run dry-run, `--apply`, and `--verify` migration tests.
- Keep the startup-guard negative tests, including the legacy-index-present case.
- If item 3 is removed, replace the legacy-omission test with one asserting that omission is now rejected.

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

- Removing a reversal path too early leaves no recovery for a state production can still reach. Mitigated by evidence-based triggers and by requiring a nonzero scoped-document count before item 1.
- Deleting legacy *detection* along with legacy *reversal* would blind the startup guard. Mitigated by the explicit retention list.

## Acceptance Criteria

- Every removed item's trigger is evidenced in the PR description, not asserted.
- Retained items are listed with their still-open triggers.
- No dead enum value, flag, config branch, script, README section, or test survives a removal.
- Startup guard and forward migration audit behavior are unchanged.

## Definition of Done

- Focused and full verification passes.
- The PR states which inventory rows were removed and which were retained, with evidence for each.
