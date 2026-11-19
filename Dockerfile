FROM node:24-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}/bin:${PATH}"

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY third_party ./third_party
RUN corepack enable && pnpm install --frozen-lockfile --ignore-scripts

COPY tsconfig.json tsconfig.web.json vite.config.ts ./
COPY src ./src
COPY web ./web

RUN pnpm build && pnpm prune --prod

FROM node:24-bookworm-slim

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

CMD ["node", "src/main.ts"]
