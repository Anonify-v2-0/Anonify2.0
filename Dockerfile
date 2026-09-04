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
# Selected at build time as well as at runtime: withWorkflow() falls back to the
# local file-backed world when this is unset, and the build bakes that choice in.
ENV WORKFLOW_TARGET_WORLD="@workflow/world-postgres"
RUN pnpm run build

# ---- migrator ---------------------------------------------------------------
# Applies the schema and creates the workflow tables, then exits. Kept separate
# from the runtime image so the server does not carry the Prisma CLI.
FROM builder AS migrator
CMD ["sh", "-c", "pnpm exec prisma migrate deploy && pnpm run workflow:bootstrap"]

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

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
