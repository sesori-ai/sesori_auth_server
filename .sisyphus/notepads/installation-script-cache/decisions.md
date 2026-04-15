# Decisions

- The initial service contract is limited to deterministic release selection from a GitHub releases payload; cache refresh, fetch orchestration, and route wiring remain out of scope for later tasks.
- When multiple eligible releases share the same `published_at`, the service breaks ties by descending `tag_name` so selection stays deterministic across identical timestamps.
- Task 2 adds a single shared `refreshPromise` around lazy cache refreshes so concurrent expired-cache reads collapse into one upstream load instead of racing duplicate work.
- The refresh seam is a small overridable `loadInstallScripts()` method rather than real GitHub content fetching, which keeps Task 2 focused on cache semantics and leaves Task 3 free to plug in upstream retrieval later.
- Task 3 keeps GitHub access unauthenticated and uses the contents API with `Accept: application/vnd.github.raw+json` for both `install.sh` and `install.ps1`, avoiding release assets, `download_url`, and branch-based fallbacks.
- Cache replacement remains atomic by fetching both script bodies for a newly selected tag before storing the new entry; if the refresh fails after a stale entry exists, the service extends the stale TTL instead of partially swapping script content.
- Task 4 adds `installScriptService` to `AppServices` even though no route consumes it yet, because the goal is to stabilize the injection surface before route work lands.
- The wiring test uses a tiny fake MongoDB surface (`connect`, `close`, `getDb`, `collection`, `dropDatabase`) so it validates boot plumbing without expanding the task into database integration coverage.
- Task 5 exposes the installer downloads as top-level public routes (`/install.sh` and `/install.ps1`) registered directly in `server.ts`, keeping them outside `/auth` and relying on Fastify's global error handler to surface any `BadGatewayError` from `InstallScriptService` unchanged.

# Decisions

- Use the real install script service in one route regression so the HTTP layer verifies tag refresh coupling, while keeping the existing lightweight plain-text smoke tests for direct route wiring.
- Keep the cold-cache 502 assertion at the route boundary with a mocked upstream GitHub failure; this validates the public API contract without depending on implementation-specific error plumbing.
