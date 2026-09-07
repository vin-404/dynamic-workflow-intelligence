# Frontend image. Build context is ./frontend, not the repo root.
FROM node:20-alpine

WORKDIR /app

# Dependencies first, so a source change does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# NEXT_PUBLIC_* is inlined at build time, so the API URL has to be known here.
# It defaults to localhost for a local build and is overridden per deployment.
ARG NEXT_PUBLIC_API_URL=http://localhost:8001
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

RUN npm run build

ENV PORT=3000
EXPOSE 3000

# `next start` reads $PORT, so a PaaS can inject its own.
CMD ["sh", "-c", "exec npm start -- --port ${PORT:-3000} --hostname 0.0.0.0"]
