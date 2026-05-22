FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-alpine AS runner
ENV NODE_ENV=production \
    DOCKER=1 \
    HOST=0.0.0.0 \
    PORT=3001
WORKDIR /app
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/dist ./dist
EXPOSE 3001
VOLUME ["/app/data"]
CMD ["node", "server/index.js"]
