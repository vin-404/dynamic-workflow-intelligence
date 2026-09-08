# Frontend image. Build context is ./frontend, not the repo root.
FROM node:20-alpine

WORKDIR /app

# Dependencies first, so a source change does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Deliberately no NEXT_PUBLIC_API_URL.
#
# The browser must only ever talk to this app's own origin: `src/proxy.ts`
# verifies the Google session there and injects the identity headers the
# backend trusts. Baking an absolute backend URL into the bundle would send
# the browser straight to FastAPI, past the session check and the injection -
# the app would look signed-in while every request arrived anonymous. The
# backend URL is a *runtime, server-side* setting (API_REWRITE_URL), so it is
# not needed at build time and is not accepted here.

RUN npm run build

ENV PORT=3000
EXPOSE 3000

# `next start` reads $PORT, so a PaaS can inject its own.
CMD ["sh", "-c", "exec npm start -- --port ${PORT:-3000} --hostname 0.0.0.0"]
