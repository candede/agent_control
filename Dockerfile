ARG DEPENDENCY_BASE=node:24-bookworm-slim
ARG BROWSER_BASE=mcr.microsoft.com/playwright:v1.58.2-noble
FROM ${DEPENDENCY_BASE} AS dependencies
ARG REUSE_INSTALLED_DEPENDENCIES=0
ENV NPM_CONFIG_REGISTRY=https://packagefeedproxy.microsoft.io/npm/
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc if [ "$REUSE_INSTALLED_DEPENDENCIES" = 1 ]; then test -f node_modules/tsx/dist/cli.mjs && test -f node_modules/vitest/vitest.mjs; else npm ci; fi

FROM dependencies AS application-base
RUN rm -rf backend/src backend/scripts backend/dist frontend/src frontend/browser frontend/dist scripts docs infra plans

FROM application-base AS application-source
COPY backend/src backend/src
COPY frontend/src frontend/src
RUN find backend/src -type f \( -name '*.test.ts' -o -name '*TestSupport.ts' \) -delete \
    && find frontend/src -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) -delete \
    && rm -rf backend/src/test frontend/src/test

FROM application-base AS build
COPY --from=application-source /app/backend/src backend/src
COPY --from=application-source /app/frontend/src frontend/src
COPY backend/tsconfig.json backend/tsconfig.json
COPY frontend/public frontend/public
COPY frontend/index.html frontend/vite.config.ts frontend/tsconfig.app.json frontend/tsconfig.node.json frontend/tsconfig.build.json frontend/
COPY frontend/tsconfig.build.json frontend/tsconfig.json
RUN npm run build

FROM dependencies AS test
RUN rm -rf backend/src backend/scripts backend/dist frontend/src frontend/browser frontend/dist scripts docs infra plans
COPY backend backend
COPY frontend frontend
COPY scripts scripts
COPY Dockerfile compose.yaml compose.large-tenant-test.yaml deploy-local.ps1 deploy-azure.ps1 README.md ./
COPY docs docs
COPY infra infra
CMD ["npm", "test"]

FROM test AS security-scan
COPY --from=build /app/backend/dist backend/dist
COPY --from=build /app/frontend/dist frontend/dist
COPY scripts scripts
COPY compose.yaml deploy-local.ps1 deploy-azure.ps1 README.md ./
CMD ["node", "backend/scripts/security-scan.mjs"]

FROM dependencies AS production-dependencies
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc if [ "$REUSE_INSTALLED_DEPENDENCIES" = 1 ]; then npm prune --omit=dev --ignore-scripts --offline; else npm prune --omit=dev; fi
RUN find node_modules -type d \( -name test -o -name tests -o -name __tests__ \) -prune -exec rm -rf {} +
RUN find node_modules -type f \( -name '*.test.*' -o -name '*.spec.*' \) -delete

FROM postgres:17-bookworm AS operator
ENV NPM_CONFIG_REGISTRY=https://packagefeedproxy.microsoft.io/npm/
COPY --from=dependencies /usr/local /usr/local
WORKDIR /app
COPY --from=dependencies /app/node_modules node_modules
COPY --from=dependencies /app/package.json /app/package-lock.json ./
COPY --from=dependencies /app/frontend/package.json frontend/package.json
COPY backend/package.json backend/package.json
COPY backend/tsconfig.json backend/tsconfig.json
COPY --from=application-source /app/backend/src backend/src
COPY backend/scripts/database.ts backend/scripts/databaseReset.ts backend/scripts/backup.ts backend/scripts/backupInventory.ts backend/scripts/backupFingerprintStream.ts \
     backend/scripts/azure-database.ts backend/scripts/azure-pitr.ts backend/scripts/release-inspect.mjs backend/scripts/
ENTRYPOINT ["node", "node_modules/tsx/dist/cli.mjs"]

FROM operator AS qualification
COPY --from=test /app /app
COPY --from=build /app/backend/dist backend/dist
COPY --from=build /app/frontend/dist frontend/dist

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
COPY backend/scripts backend/scripts
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

FROM ${BROWSER_BASE} AS browser-test
ARG REUSE_INSTALLED_DEPENDENCIES=0
ENV NPM_CONFIG_REGISTRY=https://packagefeedproxy.microsoft.io/npm/
WORKDIR /browser
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc if [ "$REUSE_INSTALLED_DEPENDENCIES" = 1 ]; then rm -rf /app; else npm install --no-save --ignore-scripts playwright@1.58.2; fi
COPY scripts/browser-smoke.mjs /browser/browser-smoke.mjs
ENTRYPOINT ["node", "/browser/browser-smoke.mjs"]

FROM browser-test AS permission-browser-test
WORKDIR /app/backend
COPY --from=dependencies /usr/local /usr/local
COPY --from=test /app /app
COPY --from=build /app/frontend/dist /app/frontend/dist
ENV NODE_ENV=test AGENT_CONTROL_FIXTURE_MODE=browser
ENTRYPOINT ["node", "/app/node_modules/vitest/vitest.mjs", "run", "--config", "scripts/browser-fixture.config.ts"]