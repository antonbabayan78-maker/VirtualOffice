# syntax=docker/dockerfile:1
#
# The two processes that run an office: the server and the worker.
#
# One build, two targets. The packages underneath them are the same packages,
# and building them twice would be twice the time for the same bytes — so
# everything is compiled once and each target takes the tree it needs.
#
# `pnpm deploy --prod` is what keeps the running images small: it resolves one
# workspace package into a self-contained directory holding its built output and
# only the dependencies it actually runs on. No sources, no test runner, no
# toolchain.
#
# Alpine with no build step at all: the SQLite store runs on Node's own
# `node:sqlite`, so there is nothing to compile and no compiler to install.
FROM node:24-alpine AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# The whole workspace, because a pnpm install needs every manifest in it and the
# build needs every source. `.dockerignore` is what keeps this small.
COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm build

# Two trees, each with its own node_modules and nothing it does not run on.
RUN pnpm deploy --filter @vo/server --prod /out/server \
 && pnpm deploy --filter @vo/worker --prod /out/worker

FROM node:24-alpine AS server
WORKDIR /app
COPY --from=build --chown=node:node /out/server ./
# The canvas, served from the office's own origin. That is what lets a browser
# hold no credential: the page and the API share an origin, so the cookie set at
# sign-in is simply sent, and there is no token built into the bundle.
COPY --from=build --chown=node:node /app/apps/web/dist ./web
ENV VO_WEB_ROOT=/app/web
# Where the office is kept. It exists in the image, owned by the user that runs,
# because an empty named volume takes the ownership of whatever it is mounted
# over — and a /data owned by root is a database the office cannot open. It
# boots, fails on the first file, and restarts for ever.
RUN mkdir -p /data && chown node:node /data
# Nothing here writes outside the volume, and a process that cannot write to its
# own image cannot be talked into overwriting itself.
USER node
ENV NODE_ENV=production
EXPOSE 3100
CMD ["node", "dist/main.js"]

FROM node:24-alpine AS worker
WORKDIR /app
COPY --from=build --chown=node:node /out/worker ./
USER node
ENV NODE_ENV=production
CMD ["node", "dist/main.js"]
