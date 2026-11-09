# syntax=docker/dockerfile:1

FROM node:22.23.4-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22.23.4-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup -S app && adduser -S app -G app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

USER app

EXPOSE 3000

# node directly (not `npm start`): no resident npm parent in the container memory, and
# SIGTERM reaches the app. Same flags as the "start" script.
CMD ["node", "-r", "dotenv/config", "server.js"]
