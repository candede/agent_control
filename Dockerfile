FROM node:24-bookworm-slim AS dependencies
ENV NPM_CONFIG_REGISTRY=https://packagefeedproxy.microsoft.io/npm/
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci

FROM dependencies AS test
COPY backend backend
COPY frontend frontend
COPY docs docs
COPY infra infra
COPY plans/admin-poc-production/README.md plans/admin-poc-production/README.md
CMD ["npm", "test"]

FROM test AS build
RUN npm run build

FROM build AS security-scan
COPY scripts scripts
COPY compose.yaml deploy-local.ps1 deploy-azure.ps1 README.md ./
CMD ["node", "backend/scripts/security-scan.mjs"]

FROM dependencies AS production-dependencies
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm prune --omit=dev
RUN find node_modules -type d \( -name test -o -name tests -o -name __tests__ \) -prune -exec rm -rf {} +
RUN find node_modules -type f \( -name '*.test.*' -o -name '*.spec.*' \) -delete

FROM postgres:17-bookworm AS operator
ENV NPM_CONFIG_REGISTRY=https://packagefeedproxy.microsoft.io/npm/
COPY --from=dependencies /usr/local /usr/local
WORKDIR /app
COPY --from=test /app /app
ENTRYPOINT ["node", "node_modules/tsx/dist/cli.mjs"]

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3001
WORKDIR /app
COPY --from=production-dependencies /app/node_modules node_modules
COPY --from=build /app/backend/dist backend/dist
COPY --from=build /app/backend/package.json backend/package.json
COPY --from=build /app/frontend/dist frontend/dist
USER node
EXPOSE 3001
CMD ["node", "backend/dist/server.js"]

FROM runtime AS runtime-inspection
COPY backend/scripts/production-inspect.mjs /inspection/production-inspect.mjs
ENTRYPOINT ["node", "/inspection/production-inspect.mjs"]

FROM build AS package
ARG TARGETARCH
ARG RELEASE_REVISION=uncommitted-phase11
ENV RELEASE_REVISION=$RELEASE_REVISION
RUN test "$TARGETARCH" = amd64 && test "$(node -p process.platform)" = linux && test "$(node -p process.arch)" = x64
COPY --from=production-dependencies /app/node_modules /release/node_modules
COPY --from=runtime /app/backend /release/backend
COPY --from=runtime /app/frontend /release/frontend
RUN node backend/scripts/package.mjs

FROM scratch AS export
COPY --from=package /export/ /

FROM mcr.microsoft.com/playwright:v1.58.2-noble AS browser-test
ENV NPM_CONFIG_REGISTRY=https://packagefeedproxy.microsoft.io/npm/
WORKDIR /browser
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm install --no-save --ignore-scripts playwright@1.58.2
COPY scripts/browser-smoke.mjs /browser/browser-smoke.mjs
ENTRYPOINT ["node", "/browser/browser-smoke.mjs"]

FROM browser-test AS permission-browser-test
WORKDIR /app/backend
COPY --from=test /app /app
COPY --from=build /app/frontend/dist /app/frontend/dist
ENV NODE_ENV=test AGENT_CONTROL_FIXTURE_MODE=browser
ENTRYPOINT ["node", "/app/node_modules/vitest/vitest.mjs", "run", "--config", "scripts/browser-fixture.config.ts"]