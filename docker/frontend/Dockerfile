# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS web-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig.json tsconfig.node.json vite.config.web.ts ./
COPY img ./img
COPY icons ./icons
COPY src ./src
COPY shared ./shared
RUN npm run build:web

FROM nginx:1.27-alpine
COPY docker/frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/dist /usr/share/nginx/html
EXPOSE 80
