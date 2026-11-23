ARG NODE_VERSION=22.23.5
FROM node:${NODE_VERSION}-alpine AS dependencies
RUN apk add --no-cache openssl
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci && npm run prisma:generate

FROM dependencies AS development
COPY . .
EXPOSE 3000
CMD ["npm", "run", "start:dev"]

FROM development AS builder
RUN npm run build

# Schema/index provisioning uses the locked CLI and never migrates legacy data.
FROM builder AS provisioning
CMD ["npm", "run", "db:provision"]

FROM builder AS runtime-dependencies
RUN npm prune --omit=dev

FROM node:${NODE_VERSION}-alpine AS production
RUN apk add --no-cache openssl
ENV NODE_ENV=production
WORKDIR /app
COPY --from=runtime-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/prisma ./prisma
COPY --from=builder --chown=node:node /app/package*.json ./
USER node
EXPOSE 3000
CMD ["npm", "run", "start:prod"]
