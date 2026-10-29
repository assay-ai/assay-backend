# check=skip=CopyIgnoredFile
# node 24, not 20. `@solana-program/token` declares `engines: node >=24`, and yarn
# refuses the install outright on 20 — so this image could not be built at all.
# `engines.node` in package.json is raised to match rather than left saying 18.
# Pinned to a patch release by digest so a rebuild cannot silently fall back to
# an older cached `node:24-alpine`. 24.22.1 carries the October 2026 security
# fixes (Brotli decoder RCE, TLS hostname checks); Dependabot proposes bumps.
FROM node:26.12.1-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS development

WORKDIR /app

COPY package.json yarn.lock ./
# `packages/*` is a yarn workspace, so its manifest has to exist before
# `yarn install` — without it yarn resolves `@assay/settlement-client` against the
# registry, where it does not exist, and the install fails.
COPY packages/settlement-client/package.json ./packages/settlement-client/

# `--frozen-lockfile`: install exactly what yarn.lock pins and fail if the
# manifest and the lockfile disagree, rather than resolving anew from the
# registry (non-reproducible, and a dependency-confusion opening for any name
# the lockfile does not cover).
RUN yarn install --frozen-lockfile

COPY . .

# `yarn build` is `yarn client:build && nest build` — the generated settlement
# client compiles first because `dist/` resolves it as an ordinary dependency.
RUN yarn build

FROM node:26.12.1-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS production

ARG NODE_ENV=production
ENV NODE_ENV=${NODE_ENV}

WORKDIR /app

COPY package.json yarn.lock ./
COPY packages/settlement-client/package.json ./packages/settlement-client/

# `--ignore-scripts`: no runtime dependency needs its install script — the only
# ones are a telemetry ping (@scarf/scarf), an opencollective banner
# (@nestjs/core), and msgpackr-extract's fallback compile, which is a no-op
# because its prebuilt binary arrives as an optional dependency.
#
# The yarn cache (~650 MB) and the dependencies' source maps (~80 MB) are
# removed in the same layer, otherwise they stay in the image underneath it.
# Nothing loads a .map at runtime: node is not started with --enable-source-maps.
RUN yarn install --production --frozen-lockfile --ignore-scripts \
  && yarn cache clean \
  && find node_modules -type f \( -name '*.js.map' -o -name '*.cjs.map' -o -name '*.mjs.map' -o -name '*.ts.map' \) -delete

# The workspace symlink in node_modules points at packages/settlement-client, so
# the runtime image needs that package's build output as well as the app's.
COPY --from=development /app/packages/settlement-client/dist ./packages/settlement-client/dist
COPY --from=development /app/dist ./dist

# Drop root before anything runs. The app writes nothing under /app at runtime,
# so the root-owned files above only need to be readable; `node` (uid 1000) is
# the unprivileged user the base image ships for exactly this.
USER node

ENTRYPOINT ["yarn"]
CMD ["start:prod"]
