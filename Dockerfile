FROM node:24-bookworm-slim AS application

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json drizzle.config.ts ./
COPY src ./src
RUN npm run build
RUN mkdir -p /app/.data/documents && chown -R node:node /app/.data

ENV NODE_ENV=production
USER node

CMD ["npm", "start"]
