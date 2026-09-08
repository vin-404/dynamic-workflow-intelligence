/**
 * What this app adds to an Auth.js session.
 *
 * The backend owns user rows; Google owns the identity. `backendUserId` is
 * the bridge - the UUID of the `User` row that `POST /api/users` upserted for
 * this email - and it is what gets sent upstream as `X-User-Id`. Declaring it
 * here means `session.user.backendUserId` and `token.backendUserId` are typed
 * everywhere rather than cast at each use.
 *
 * The augmentation targets `@auth/core`, not `next-auth`. `next-auth` only
 * re-exports these interfaces (`export type { Session } from "@auth/core/types"`),
 * so declaring them under `"next-auth"` would create a second, shadowing
 * interface that Auth.js's own callback signatures never see.
 */
import "@auth/core/types";
import "@auth/core/jwt";

declare module "@auth/core/types" {
  interface Session {
    user?: User;
  }

  interface User {
    /**
     * The backend's `User.id`. Present on every session this app mints:
     * sign-in fails rather than produce a session without one.
     */
    backendUserId?: string;
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    /** Set once, when the token is first minted. See `auth.ts`. */
    backendUserId?: string;
  }
}
