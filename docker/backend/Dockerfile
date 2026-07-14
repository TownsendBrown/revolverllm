# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS backend
RUN apt-get update \
  && apt-get install -y --no-install-recommends docker.io curl python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY electron ./electron
COPY shared ./shared
COPY engines ./engines
COPY server ./server
COPY docker/config.json ./config.json
ENV NODE_ENV=production
ENV REVOLVER_ROOT=/app
ENV REVOLVER_DOCKER=1
ENV LLAMA_CONFIG_DIR=/llama-config
ENV PORT=3001
EXPOSE 3001
CMD ["npm", "run", "server"]
