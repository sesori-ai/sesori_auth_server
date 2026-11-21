FROM node:26.13.1-slim AS builder

WORKDIR /app
RUN npm install -g npm@12.2.2
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build
# Build time for GET /version. It sits after the compile step, so a cached
# layer keeps the time those exact compiled sources were first built.
RUN date -u +%Y-%m-%dT%H:%M:%SZ > dist/built-at.txt
# Commit for GET /version, resolved from the checkout's .git (detached HEAD,
# loose ref, or packed ref). Copying the whole context never fails, so a
# context without .git (a git worktree has only a .git file) writes an empty
# file and the server falls back to GIT_COMMIT_SHA.
# No ${var...} operators: App Platform's kaniko expands RUN lines for its
# layer cache key and rejects them ("missing ':' in substitution").
COPY . /tmp/context/
RUN cd /tmp/context && head="$(cat .git/HEAD 2>/dev/null)"; \
    ref="$(printf '%s\n' "$head" | sed -n 's/^ref: //p')"; \
    if [ -n "$ref" ]; then \
      head="$(cat ".git/$ref" 2>/dev/null || awk -v ref="$ref" '$2 == ref { print $1 }' .git/packed-refs 2>/dev/null)"; \
    fi; \
    printf '%s\n' "$head" > /app/dist/commit.txt

FROM node:26.13.1-slim

WORKDIR /app
RUN npm install -g npm@12.2.2
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force
COPY assets/legal/ ./assets/legal/
COPY --from=builder /app/dist ./dist/

USER node
EXPOSE 3001

CMD ["node", "dist/index.js"]
