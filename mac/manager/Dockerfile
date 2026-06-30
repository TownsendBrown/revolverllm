# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
ENV NODE_ENV=production
ENV PORT=3099
ENV LLAMA_CONFIG_DIR=/config
ENV REVOLVER_MODELS_DIR=/models
EXPOSE 3099
CMD ["npm", "start"]
