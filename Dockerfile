# Anonify, self-hosted.
#
# Debian rather than Alpine on purpose: sharp, @napi-rs/canvas and the pdf.js
# renderer all ship native binaries, and musl builds are the usual source of
# "works on my machine, segfaults in the container".

# ---- base -------------------------------------------------------------------
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
# The version comes from package.json's packageManager field, so the image and a
# developer's machine install with the same pnpm.
# Prisma's migration engine links against OpenSSL, which node:*-slim omits.
RUN apt-get update  && apt-get install -y --no-install-recommends openssl  && rm -rf /var/lib/apt/lists/*  && corepack enable
WORKDIR /app

# ---- dependencies -----------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY prisma ./prisma
COPY scripts ./scripts
# postinstall generates the Prisma client and copies the pdf.js worker, so both
# the schema and the scripts have to be present before install runs.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---- build ------------------------------------------------------------------
FROM deps AS builder
COPY . .
# Placeholders: the build never opens a connection, but modules that read these
# at import time must find something well-formed.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
ENV ENCRYPTION_KEY="0000000000000000000000000000000000000000000000000000000000000000"
ENV FINGERPRINT_SECRET="1111111111111111111111111111111111111111111111111111111111111111"
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_OUTPUT=standalone
# ANONIFY_PUBLIC_URL is not needed here: the root layout reads it per request,
# so one image serves whatever address it is run at.
# Selected at build time as well as at runtime: withWorkflow() falls back to the
# local file-backed world when this is unset, and the build bakes that choice in.
ENV WORKFLOW_TARGET_WORLD="@workflow/world-postgres"
# Turbopack's cache survives between builds on the same machine, so a rebuild
# after a small change recompiles only what changed (#172). It is not part of
# the image: the standalone output under .next/standalone is.
RUN --mount=type=cache,id=next-cache,target=/app/.next/cache \
    pnpm run build
# `anonify cleanup`: the expiry sweep as one bundled file, since the image has
# no tsx and no TypeScript sources to run scripts/cleanup.ts from (#175).
RUN node scripts/build-cli.mjs

# ---- migrate ----------------------------------------------------------------
# `anonify migrate` runs the Prisma CLI, and nothing else in the image does
# (#175). It used to run from a stage built on the builder, 2 GB of dev
# dependencies nobody should pull to apply a migration. Installed here on its
# own like the world below, at the lockfile's version.
#
# Then pruned to what `migrate deploy` loads, found by deleting each piece
# and applying every migration to an empty database without it: the CLI
# requires Studio's data layer and `prisma dev`'s state module at start, but
# not Studio's UI, the embedded Postgres `prisma dev` runs, the client query
# compilers, the WebAssembly schema engine (the native one does the work),
# React, lodash, mysql2, or any source map and type declaration. 240 MB
# installed, about 70 MB kept. A Prisma upgrade that starts needing one of
# them fails Compose's migrate step in CI, loudly, rather than shipping.
FROM base AS migrate
WORKDIR /opt/anonify/migrate
RUN --mount=type=bind,from=builder,source=/app/node_modules,target=/deps \
    V=$(node -p "require('/deps/prisma/package.json').version") \
 && npm init -y > /dev/null \
 && npm install --omit=dev --no-audit --no-fund "prisma@$V" \
 && rm -f package.json package-lock.json \
 && cd node_modules \
 && rm -rf react react-dom @visx elkjs @electric-sql @types csstype effect/src \
      lodash mysql2 @prisma/query-plan-executor @prisma/streams-local \
      @prisma/studio-core/dist/ui @prisma/dev/dist/runtime-assets \
 && rm -f @prisma/studio-core/dist/metafile-*.json prisma/build/query_compiler_* \
      prisma/build/schema_engine_bg.wasm prisma/build/studio.* \
 && find . -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.cts' -o -name '*.d.mts' \) -delete
COPY prisma.config.ts ./
COPY prisma ./prisma

# ---- world ------------------------------------------------------------------
# The workflow runtime loads its world with `require(WORKFLOW_TARGET_WORLD)` at
# run time. Nothing static points at it, so the standalone build traces neither
# the package nor its Postgres driver, and the container would start and then
# fail to load its own world.
#
# Installed on its own rather than copied out of the pnpm store, because the
# store's layout is symlinks into a 2 GB tree. The version is read from the
# lockfile-resolved install, so this cannot drift from package.json.
FROM base AS world
RUN --mount=type=bind,from=builder,source=/app/node_modules,target=/deps     V=$(node -p "require('/deps/@workflow/world-postgres/package.json').version")  && mkdir -p /world && cd /world  && npm init -y > /dev/null  && npm install --omit=dev "@workflow/world-postgres@$V"

# ---- runtime ----------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# Durable runs live in Postgres. instrumentation.ts defaults the world's
# connection string from DATABASE_URL, so one setting configures both.
ENV WORKFLOW_TARGET_WORLD="@workflow/world-postgres"
# Written to on first OCR use; a volume keeps the ~5 MB across restarts.
ENV TESSERACT_CACHE_PATH=/data/tesseract

RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs nextjs \
 && mkdir -p /data/tesseract \
 && chown -R nextjs:nodejs /data

# The standalone build carries its own traced node_modules — the whole point of
# it is that this layer is small.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Apache-2.0 section 4(a): a copy of the licence travels with the Work, and
# publishing an image is distributing it.
COPY --chown=nextjs:nodejs LICENSE NOTICE ./

# Deliberately outside /app. Node walks up from /app/node_modules to
# /node_modules, so the world resolves while nothing here can shadow a package
# the traced build already ships — merging the two trees would quietly swap
# shared dependencies like zod for a different copy.
COPY --from=world --chown=nextjs:nodejs /world/node_modules /node_modules

# One image, several jobs (#175): `anonify serve` (the default), `anonify
# migrate` and `anonify cleanup`. Owned by root, so the server cannot rewrite
# the tools that migrate its database.
COPY --from=migrate /opt/anonify/migrate /opt/anonify/migrate
COPY --from=builder /app/build/cli/cleanup.mjs /opt/anonify/bin/cleanup.mjs
COPY docker/migrate.mjs /opt/anonify/bin/migrate.mjs
COPY --chmod=755 docker/anonify /usr/local/bin/anonify

USER nextjs
EXPOSE 3000

# Liveness, as Docker means it: is the process answering? /api/health touches
# no database or storage, so an outage elsewhere does not restart the
# container in a loop. Orchestrators that route traffic use /api/ready (#167).
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `docker run IMAGE` serves; `docker run IMAGE migrate` migrates. A command
# that names a program, such as `node server.js`, still runs as given.
ENTRYPOINT ["anonify"]
CMD ["serve"]
