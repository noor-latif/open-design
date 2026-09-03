ARG NODE_IMAGE=docker.io/library/node:24-bookworm-slim
ARG RUNTIME_IMAGE=docker.io/library/node:24-bookworm-slim

FROM ${NODE_IMAGE} AS build

ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG http_proxy
ARG https_proxy
ARG no_proxy
ARG NO_PROXY

ENV HTTP_PROXY=${HTTP_PROXY}
ENV HTTPS_PROXY=${HTTPS_PROXY}
ENV http_proxy=${http_proxy}
ENV https_proxy=${https_proxy}
ENV no_proxy=${no_proxy}
ENV NO_PROXY=${NO_PROXY}
ENV CI=true
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Use bookworm-slim by default because `playwright install --with-deps` requires
# apt (Debian) and Playwright's bundled Chromium is glibc-linked (incompatible
# with Alpine musl). Alpine alternative would be `apk add --no-cache chromium
# nss freetype harfbuzz ca-certificates ttf-freefont` plus `executablePath`
# overrides, but the glibc/apt path is smaller-maintenance. Override back to
# alpine via --build-arg NODE_IMAGE=... if needed.
RUN if command -v apk >/dev/null 2>&1; then \
      apk add --no-cache python3 make g++; \
    else \
      apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*; \
    fi

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts/postinstall.mjs ./scripts/postinstall.mjs
COPY packages ./packages
COPY tools ./tools
COPY apps/daemon/package.json ./apps/daemon/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY e2e/package.json ./e2e/package.json
RUN corepack enable && \
    corepack prepare pnpm@10.33.2 --activate && \
    pnpm install --frozen-lockfile

# Playwright Chromium for daemon screenshot endpoint (POST /api/preview/screenshot).
# Matches daemon dep `playwright-core@1.53.0` (browser is same for `playwright` package).
# Placed after pnpm install and before pnpm build so the layer caches until lockfile changes.
# Use `playwright` binary (not `playwright-core` binary) — `playwright-core: not found` otherwise.
RUN npx --yes playwright@1.53.0 install --with-deps chromium

COPY apps ./apps
RUN pnpm --filter @open-design/daemon build && \
    pnpm --filter @open-design/web build && \
    pnpm --filter @open-design/daemon deploy --legacy --prod /app/deploy/daemon && \
    pnpm store prune && \
    rm -rf \
      /root/.cache \
      /root/.local/share/pnpm/store \
      /app/deploy/daemon/node_modules/.cache \
      /app/deploy/daemon/node_modules/@types \
      /app/deploy/daemon/node_modules/.pnpm/@types+* \
      /app/deploy/daemon/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/deps \
      /app/deploy/daemon/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/src && \
    find /app/deploy/daemon/node_modules -type d \( \
      -name test -o \
      -name tests -o \
      -name "__tests__" -o \
      -name docs -o \
      -name doc -o \
      -name example -o \
      -name examples -o \
      -name ".github" \
    \) -prune -exec rm -rf '{}' + && \
    find /app/deploy/daemon/node_modules -type f \( \
      -name "*.md" -o \
      -name "*.markdown" -o \
      -name "*.d.ts" -o \
      -name "*.d.cts" -o \
      -name "*.d.mts" -o \
      -name "*.map" -o \
      -name "*.tsbuildinfo" -o \
      -name "binding.gyp" \
    \) -delete

# Stage-2 assets — copied into the build stage so the runtime stage
# can pull them via --from=build instead of reaching back into the
# build context.  This lets the Dockerfile work when the build context
# differs from the repo root (Railway, CI runners with a subdirectory
# context, etc.).
COPY skills ./skills
COPY design-systems ./design-systems
COPY craft ./craft
COPY prompt-templates ./prompt-templates
COPY assets ./assets
# `data/plugin-previews/manifest.json` is committed by the bake pipeline and is
# what `resolvePluginPreviewsDir()` looks for at runtime. Without it in the
# image, `loadManifest()` returns `{}` and every plugin silently falls back to
# the live-iframe preview path — the exact cost the bakes exist to avoid.
COPY data ./data
COPY plugins/_official ./plugins/_official

FROM ${RUNTIME_IMAGE}

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Runtime deps: tini, poppler-utils, bash, git. Handle both Alpine (apk) and Debian (apt).
# Then install Playwright Chromium for the screenshot endpoint. Using the same
# PLAYWRIGHT_BROWSERS_PATH as the build stage keeps the runtime browser outside
# /root/.cache and makes it readable for the non-root daemon user.
RUN if command -v apk >/dev/null 2>&1; then \
      apk add --no-cache tini poppler-utils bash git ca-certificates freetype harfbuzz nss ttf-freefont && \
      addgroup -S -g 1001 open-design && adduser -S -D -H -u 1001 -G open-design open-design; \
    else \
      apt-get update && apt-get install -y --no-install-recommends tini poppler-utils bash git ca-certificates && \
      rm -rf /var/lib/apt/lists/* && groupadd -r -g 1001 open-design && useradd -r -u 1001 -g open-design -d /home/open-design -m open-design; \
    fi && \
    npx --yes playwright@1.53.0 install --with-deps chromium && \
    chmod -R 755 /ms-playwright 2>/dev/null || true; \
    chown -R open-design:open-design /ms-playwright 2>/dev/null || chmod -R 755 /ms-playwright

WORKDIR /app
COPY --from=build --chown=open-design:open-design /app/deploy/daemon ./apps/daemon
COPY --from=build --chown=open-design:open-design /app/apps/web/out ./apps/web/out
COPY --from=build --chown=open-design:open-design /app/skills ./skills
COPY --from=build --chown=open-design:open-design /app/design-systems ./design-systems
COPY --from=build --chown=open-design:open-design /app/craft ./craft
COPY --from=build --chown=open-design:open-design /app/prompt-templates ./prompt-templates
COPY --from=build --chown=open-design:open-design /app/data ./data
COPY --from=build --chown=open-design:open-design /app/assets/frames ./assets/frames
COPY --from=build --chown=open-design:open-design /app/assets/community-pets ./assets/community-pets
# Plan §3.J4 / spec §23.3.5 — bundled atom plugins registered on
# daemon boot. The directory contains `plugins/_official/atoms/<atom>/`
# pairs (SKILL.md + open-design.json); registerBundledPlugins() walks
# it on startup so the container ships with first-party atoms reachable
# via the same registry path third-party plugins use.
COPY --from=build --chown=open-design:open-design /app/plugins/_official ./plugins/_official

RUN mkdir -p /app/.od && \
    chown -R open-design:open-design /app

ENV NODE_ENV=production
ENV NODE_OPTIONS=--max-old-space-size=192
ENV OD_BIND_HOST=0.0.0.0
ENV OD_PORT=7456

EXPOSE 7456

USER open-design
ENTRYPOINT ["tini", "--"]
CMD ["node", "apps/daemon/dist/cli.js", "--no-open"]
