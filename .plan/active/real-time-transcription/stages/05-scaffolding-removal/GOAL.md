# Stage S05: Compatibility Scaffolding Removal

## 0. Stage Metadata

- **Stage ID:** S05
- **Repositories:** `sesori-ai/sesori_auth_server`
- **Base:** `master`
- **PR count:** 1

## 1. Outcome

Scaffolding that existed only for the staged provider/realtime rollout is deleted once its trigger has fired. The codebase stops carrying compatibility paths that can no longer be exercised, and every remaining marker is one whose trigger is still genuinely open.

## 2. Entry Criteria and Baseline

This stage does not start on a schedule. Each removal below is gated on its own trigger, and the PR removes only the subset whose triggers have fired.

- S04-W02-M01 is complete: the selected async provider and realtime state are settled.
- For OpenAI async removal: Soniox is the only intentionally supported async provider and OpenAI rollback support is explicitly retired by decision, not merely unused.
- For transcribe project-key removal: the minimum supported app always sends project context.

## 3. Invariants and Non-Goals

- Never remove a fallback while it is still the documented recovery route for a state production can reach.
- Removal is mechanical deletion, not redesign. No behavior change reaches a live client.
- No new abstraction is introduced to make deletion tidier.

## 4. Execution Waves

| Wave | Step | Repository | Base | Parallel safety | Outcome |
|---|---|---|---|---|---|
| W01 | S05-W01-P01 | `sesori-ai/sesori_auth_server` | `master` | Sole step | Triggered scaffolding is deleted; untriggered scaffolding is retained with its trigger restated |

## 5. Integration and Manual Verification

- Full auth suite and static checks pass with the deleted paths gone.

## 6. Exit Criteria

- Every marker whose trigger has fired is gone, along with the code it guarded and its tests.
- Every retained marker names a trigger that is still open, and this stage records why.
- No orphaned enum value, CLI flag, config branch, script, README section, or test remains for a deleted path.

## 7. Stage-Specific Detail

OpenAI async support and the optional transcribe project key close at different times, so this stage may run more than once. Re-running it is expected and cheap; removing something early is not.
