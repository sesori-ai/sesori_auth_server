# Stage S03: Mobile Realtime Voice Adoption

## 0. Stage Metadata

- **Stage ID:** S03
- **Repository:** `sesori-ai/sesori_apps_monorepo`
- **Base:** `main`
- **PR count:** 1

## 1. Outcome

The mobile app chooses the Sesori realtime protocol before capture when the auth server advertises it, streams PCM16 through auth, previews confirmed/provisional text, and commits one final or confirmed-partial voice span. Older servers and disabled realtime continue through the current file path.

## 2. Entry Criteria and Baseline

- S02 server contract is merged and available in a disabled staging deployment.
- S03/W01 pins current apps `main` after drift assessment.
- Contract fixtures from S02 are available to reproduce in Dart tests.

## 3. Invariants and Non-Goals

- App source and wire models remain provider-neutral.
- `module_core` owns auth-server protocol transport; Flutter app owns recording and UI.
- The draft is not mutated by provisional text.
- No full realtime recording is retained for mid-session upload fallback.
- No relay changes, provider SDK, temporary provider key, new state-management library, or desktop UI work.

## 4. Execution Waves

| Wave | Step | Repository | Base | Parallel safety | Outcome |
|---|---|---|---|---|---|
| W01 | S03-W01-P01 | `sesori-ai/sesori_apps_monorepo` | `main` | Sole step | Complete mobile realtime interaction with async compatibility |

## 5. Integration and Manual Verification

- Unit/widget tests use fake capability, channel, recorder, and lifecycle sources.
- Validate affected `module_core` and mobile app packages.
- Real iOS/Android and cross-version checks occur in S04.

## 6. Exit Criteria

- New app with old server uses async without a failed recording.
- New app with disabled new server uses async.
- New app with enabled new server previews realtime and commits correctly.
- Provider details are absent from app source/contracts.
- Existing voice-first/text-first, cancellation, haptic, amplitude, wake lock, stale interaction, and draft behavior remains covered.

## 7. Stage-Specific Detail

The server capability decision is cached only as needed for the voice interaction. A realtime setup failure before the recorder starts may select async for the same hold; after PCM streaming starts, failure never initiates an upload fallback.
