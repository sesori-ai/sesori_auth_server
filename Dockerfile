FROM node:22.22.1-slim AS builder

WORKDIR /app
RUN npm install -g npm@11.12.1
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22.22.1-slim

WORKDIR /app
RUN npm install -g npm@11.12.1
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force
COPY assets/legal/ ./assets/legal/
COPY --from=builder /app/dist ./dist/

USER node
EXPOSE 3001

CMD ["node", "dist/index.js"]
