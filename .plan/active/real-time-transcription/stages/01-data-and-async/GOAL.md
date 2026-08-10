# Stage S01: Project Scope and Provider-Neutral Async Transcription

## 0. Stage Metadata

- **Stage ID:** S01
- **Repositories:** `sesori-ai/sesori_auth_server`
- **Base:** `master`
- **PR count:** 2

## 1. Outcome

The auth server reads and mutates glossary terms under an opaque project scope, and async transcription can select OpenAI or Soniox through one Sesori interface. Soniox remains disabled by default, stores no provider type above the client boundary, and performs ordinary immediate cleanup without durable coordination.

## 2. Entry Criteria and Baseline

- Plan review is approved and its digest is recorded.
- S01/W01 pins the current auth `master` tip after drift assessment.
- The merged PR #53 migration command and its tests are present.
- Production glossary dry-run is known to have reported zero rows, but implementation does not assume that remains true at rollout.

## 3. Invariants and Non-Goals

- Raw project IDs and glossary terms are never logged or persisted outside their intended stores.
- Auth receives only a valid `prj_v1_` project key.
- MongoDB shapes are Zod-validated at repository boundaries.
- Caps are safety bounds, not strict concurrent entitlements.
- OpenAI remains the default async provider through this stage.
- No realtime route, app streaming, receipt collection, migration framework, queue, lease, provider failover, or cleanup scheduler is added.

## 4. Execution Waves

| Wave | Step | Repository | Base | Parallel safety | Outcome |
|---|---|---|---|---|---|
| W01 | S01-W01-P01 | `sesori-ai/sesori_auth_server` | `master` | Sole step | Runtime and index config use project-scoped glossary entries |
| W02 | S01-W02-P01 | `sesori-ai/sesori_auth_server` | `master` | Starts only after W01 merges | Async transcription uses a deploy-selected provider interface with disabled-by-default Soniox |

Every W01 PR must merge before W02 begins.

## 5. Integration and Manual Verification

- Run the existing glossary migration command against a disposable MongoDB fixture in dry-run, apply, verify, and empty-only rollback modes.
- Exercise OpenAI async behavior before and after the provider refactor with the existing route contract.
- Exercise Soniox through a fake injected SDK boundary in automated tests; no CI egress or secret is required.
- Real Soniox and production migration checks remain in S04.

## 6. Exit Criteria

- Both PRs are merged.
- Default configuration still serves async through OpenAI.
- Project-key omission on the async route returns a normal transcript with no glossary fallback.
- Soniox configuration, error mapping, cleanup command, and legal text are present but no production audio is sent.
- No excluded coordination collection, scheduler, queue, or lease exists.

## 7. Stage-Specific Detail

The runtime index configuration changes only after the migration helper already exists. Production apply is intentionally deferred to the final maintenance-window checkpoint so code PR merge order is not confused with deployment order.
