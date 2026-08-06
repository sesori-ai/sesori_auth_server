# Stage S04: Verify and Enable the Cross-Repository Feature

## 0. Stage Metadata

- **Stage ID:** S04
- **Repositories:** Auth and apps; relay is reference-only
- **PR count:** 0
- **Manual checkpoints:** 2

## 1. Outcome

The merged feature is verified against real EU Soniox, staging ingress, physical iOS/Android devices, old/new app-server combinations, migration rules, shutdown, privacy, and rollback before production enablement.

## 2. Entry Criteria and Baseline

- S01, S02, and S03 PRs are merged.
- Their exact CI results and deployed build identifiers are known.
- Auth is deployed first with async OpenAI and realtime disabled.
- Soniox contractual approval and dedicated EU project/key are available without exposing secrets to plan/tracker evidence.

## 3. Invariants and Non-Goals

- Manual evidence never contains audio, transcript text, terms, JWTs, keys, raw project IDs, or user IDs.
- Relay remains unchanged.
- Enablement is configuration-driven; no emergency code patch or automatic provider failover is introduced.
- A failed gate rolls back flags or stops rollout rather than adding speculative machinery.

## 4. Execution Waves

| Wave | Step | Owner | Blocking semantics | Outcome |
|---|---|---|---|---|
| W01 | S04-W01-M01 | User + Worker | Advisory checkpoint; production policy prerequisite for W02 | Staging, device, compatibility, privacy, and shutdown evidence |
| W02 | S04-W02-M01 | User + Worker if deployment access exists | Advisory checkpoint; execute only after W01 pass evidence | Controlled production migration and enablement evidence |

Manual checkpoints are audited separately for User and Worker and do not create merge barriers. The waves encode required operational order: W02 has no code/merge dependency, but its own setup and production policy prohibit execution until W01 evidence passes.

## 5. Integration and Manual Verification

- Follow both manual step files exactly.
- Record only pass/fail, safe counts, timings, versions/SHAs, and links to protected operational evidence.
- Any contract, schema, provider, security, or intent discrepancy triggers explicit stale-plan re-review.

## 6. Exit Criteria

- Both User and applicable Worker boxes are audited in `TRACKER.md` with evidence, and W01 pass evidence predates W02 execution.
- Glossary index migration is verified before scoped runtime starts.
- Async Soniox and realtime protocol 1 are enabled only after their gates pass.
- Rollback flags and roll-forward database rule are confirmed.
- No unresolved production blocker remains.

## 7. Stage-Specific Detail

The plan is complete when production evidence exists, not merely when all code PRs merge. Provider availability or quota imperfections are handled through documented rollback and accepted-risk policy, not post-hoc coordination systems.
