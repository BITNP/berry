FROM node:24-bookworm-slim AS build

WORKDIR /app

RUN npm install -g pnpm@12.9.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY third_party ./third_party
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY tsconfig.json tsconfig.node.json tsconfig.web.json vite.config.ts ./
COPY src ./src
COPY web ./web

RUN pnpm build && pnpm prune --prod

FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends tzdata ca-certificates \
  && ln -snf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
  && echo Asia/Shanghai > /etc/timezone \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/third_party ./third_party
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/dist ./dist

ENV NODE_ENV=production
ENV BERRY_HOST=0.0.0.0
ENV BERRY_PORT=3220
ENV BERRY_DATA_DIR=/app/data
ENV TZ=Asia/Shanghai

VOLUME ["/app/data"]
EXPOSE 3220

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.BERRY_PORT || 3220) + '/api/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "src/main.ts"]
