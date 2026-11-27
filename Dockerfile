# syntax=docker/dockerfile:1

# tree-sitter 문법은 WASM이라 네이티브 빌드 도구가 필요 없다
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx tsc -p tsconfig.build.json

FROM deps AS test
COPY . .
CMD ["npx", "vitest", "run"]

FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY data ./data
COPY skills ./skills
USER node
EXPOSE 3000
CMD ["node", "dist/server/main.js"]
