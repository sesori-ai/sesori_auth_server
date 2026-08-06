# S04-W02-M01: Enable Production Safely

## Metadata

- **ID:** S04-W02-M01
- **Why manual:** This requires production maintenance, SOPS-protected secrets, legal/contractual confirmation, app rollout judgment, provider console checks, and rollback authority.
- **Worker executable:** Only if explicitly granted production and secret-management access; otherwise User-owned.

## Setup

1. Confirm S04-W01-M01 passed and its User/Worker evidence is recorded before beginning this production-policy gate. Manual tracking remains advisory, but operators must not execute this checklist without that evidence.
2. Confirm the released app version containing protocol 1 and longer async timeout is available to the intended population.
3. Confirm Soniox DPA/subprocessor approval, dedicated EU project, regional key/endpoints, project budget, and concurrency limits.
4. Prepare auth rollback configuration: realtime disabled and async OpenAI.
5. In the auth repository root, check out the exact full SHA in `TRACKER.md` field `Merged auth artifact SHA`, set `REVIEWED_AUTH_SHA` to that value, and require `test "$(git rev-parse HEAD)" = "$REVIEWED_AUTH_SHA"` plus a clean `git status --short` before `npm ci`. Confirm the released app build equals `TRACKER.md` field `Merged apps artifact SHA`. Do not run from a moving branch or a different artifact.

## Checklist

- [ ] Remove/stop the single auth instance and confirm no writer remains.
- [ ] From that pinned auth root, run `sops exec-env env/app/prod.env 'npm run migrate-project-glossary-index'`; require `outcome: "completed"`, `documentCount: 0`, all invalid/duplicate counts zero, legacy exact, and target absent. Any other closed outcome/count stops rollout.
- [ ] Run `sops exec-env env/app/prod.env 'npm run migrate-project-glossary-index -- --apply'`, then `sops exec-env env/app/prod.env 'npm run migrate-project-glossary-index -- --verify'`; require `outcome: "completed"`, target exact, legacy absent, and all invalid/duplicate counts zero. Any command error, `safe_to_rerun`, or `repair_required` stops rollout.
- [ ] Start new auth with async OpenAI and realtime disabled; verify health and old/new app async behavior.
- [ ] Run `sops exec-env env/app/prod.env 'npm run purge-soniox-transcription'`; continue only on its closed `completed` audit outcome. If residual counts are nonzero, run `sops exec-env env/app/prod.env 'npm run purge-soniox-transcription -- --apply'`, then rerun audit and require zero files/transcriptions. Any unknown/error outcome stops rollout.
- [ ] Select Soniox async and restart; verify short production-backed smoke, latency, safe error outcome, and ordinary cleanup.
- [ ] Enable realtime protocol 1 and restart; verify one authorized internal iOS and Android session.
- [ ] Observe safe logs, provider cost/concurrency/storage, process RSS, and error counts for the agreed initial window.
- [ ] Confirm no secret/content/PII exposure and no relay change.
- [ ] Confirm rollback flags work. If any scoped glossary row now exists, database rollback is forbidden; roll forward.

## Expected Evidence

- Deployed auth/apps SHAs and timestamps.
- Glossary command outcome enums/counts only.
- Provider residual/concurrency/cost counts without content or identifiers.
- Health, smoke, shutdown, and rollback-configuration confirmation.
- Links to protected operational dashboards rather than copied sensitive values.

## Pass Criteria

- Migration and both provider modes operate as planned.
- Realtime is enabled only after app and staging readiness.
- Ordinary provider cleanup returns to zero and accepted residual policy is understood.
- Rollback to realtime-off/OpenAI is available without schema reversal.
- Tracker records User and Worker evidence status and any plan delta.
