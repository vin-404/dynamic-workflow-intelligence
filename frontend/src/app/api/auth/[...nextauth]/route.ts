/**
 * Auth.js's own endpoints: sign-in, callback, sign-out, session, csrf, providers.
 *
 * This is the one path under `/api` that is *not* proxied to FastAPI.
 * `proxy.ts` lets it through untouched, and it resolves here because
 * filesystem routes are matched before any `afterFiles` rewrite.
 */
import { handlers } from "../../../../../auth";

export const { GET, POST } = handlers;
