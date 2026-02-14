# Stage 1: Install dependencies
FROM node:20-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json yarn.lock* package-lock.json* pnpm-lock.yaml* ./
RUN npm install

# Stage 2: Build the app
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build
# Stage 3: Runner
FROM node:20-alpine AS runner
WORKDIR /app

# 1. Install necessary libs
RUN apk add --no-cache libstdc++ 

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# 2. Setup users
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# 3. Create the directory (Docker will use this as a mount point)
RUN mkdir -p /app/data && chown nextjs:nodejs /app/data

# 4. Copy your app files
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# Ensure better-sqlite3 is handled correctly for the target architecture
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3

# 5. THE FIX: Set permissions right before switching users
# This ensures that even if the volume mount changed ownership, we reclaim it.
USER root
RUN chown -R nextjs:nodejs /app/data

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
