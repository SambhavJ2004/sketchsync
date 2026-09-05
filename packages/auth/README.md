# @sketchsync/auth

Server-only token primitives: the session cookie **name**, `signToken`,
`verifyToken`, and `TokenPayload`.

Imported by `apps/api` and `apps/realtime`. **Never** by `apps/web`.

## Why this is its own package

It would be shorter to fold these into an existing package. Both options are
wrong, and this note exists so the shortcut isn't taken later:

- **Not `@sketchsync/shared`.** That package is imported by the browser bundle.
  Putting token code there pulls `jsonwebtoken` — and its crypto dependencies —
  into the client, bloating the bundle and shipping signing code to a place that
  must never sign anything. Shared is for cross-app *contracts* (Zod schemas and
  the types inferred from them), which are safe everywhere.
- **Not `@sketchsync/db`.** That would make token verification depend on Prisma.
  The gateway would then load the query engine just to check a JWT, and any
  future consumer that only needs to validate a token would inherit a database
  client it never uses.

The dependency rule that follows: this package depends on `jsonwebtoken` and
nothing else in the workspace. It has no database access, no HTTP framework, and
no knowledge of cookies beyond their name.

## Transport-agnostic on purpose

`verifyToken(token, secret)` takes a **raw token string**. It does not accept a
request, a cookie jar, or a header bag.

Today the API reads the token from an httpOnly cookie and the realtime gateway
reads it from the upgrade request's `Cookie` header. A future step will pass a
short-lived ticket through `Sec-WebSocket-Protocol` instead. All three are the
same verification with a different envelope, so extraction stays in the caller
and only the envelope changes.

Credentials must never be passed in a query string — those are recorded in
access logs, proxy logs, and browser history.

## Secret handling

The signing secret is a parameter, not read from `process.env` here. Each app
already validates its own environment through `@sketchsync/config`
(`loadEnv().JWT_SECRET`), and this package stays free of environment coupling so
it can be unit-tested with a literal secret.

`apps/api` and `apps/realtime` **must be configured with the same
`JWT_SECRET`** — the gateway verifies the token the API issued.
