FROM node:22.22.0-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22.22.0-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY assets/legal/ ./assets/legal/
COPY --from=builder /app/dist ./dist/

USER node
EXPOSE 3001

CMD ["node", "dist/index.js"]
