# Issues

- `npm test && npm run lint && npm run format:check && npm run build` did not complete as a full chain because `npm test` hit the external MongoDB prerequisite first: `MongoServerSelectionError: connect ECONNREFUSED ::1:27017, connect ECONNREFUSED 127.0.0.1:27017` from the auth and notifications suites.
- Repo-wide QA still has the documented environment blocker: `npm test` in this worktree fails outside the install-specific suites because the auth suites attempt to connect to MongoDB on `localhost:27017`, producing `MongoServerSelectionError: connect ECONNREFUSED ::1:27017, connect ECONNREFUSED 127.0.0.1:27017` and follow-on `MongoTopologyClosedError: Topology is closed` hook failures.
