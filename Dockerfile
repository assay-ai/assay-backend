# node 24, not 20. `@solana-program/token` declares `engines: node >=24`, and yarn
# refuses the install outright on 20 — so this image could not be built at all.
# `engines.node` in package.json is raised to match rather than left saying 18.
FROM node:24-alpine AS development

WORKDIR /app

COPY package*.json ./
COPY yarn.lock ./
# `packages/*` is a yarn workspace, so its manifest has to exist before
# `yarn install` — without it yarn resolves `@assay/settlement-client` against the
# registry, where it does not exist, and the install fails.
COPY packages/settlement-client/package.json ./packages/settlement-client/

RUN yarn install

COPY . .

# `yarn build` is `yarn client:build && nest build` — the generated settlement
# client compiles first because `dist/` resolves it as an ordinary dependency.
RUN yarn build

FROM node:24-alpine AS production

ARG NODE_ENV=production
ENV NODE_ENV=${NODE_ENV}

WORKDIR /app

COPY package*.json ./
COPY yarn.lock ./
COPY packages/settlement-client/package.json ./packages/settlement-client/

RUN yarn install --production

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
