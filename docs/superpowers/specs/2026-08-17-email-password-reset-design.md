# Email-based password reset — design

Date: 2026-08-17
Status: approved, pending implementation plan

## Problem

Splash Helper accounts (`User` model) currently have exactly one password-reset
mechanism: `POST /auth/reset-password` accepts `{ username, token, newPassword }`,
where `token` is the RuneLite plugin's per-account sync token. Knowledge of that
token is treated as sufficient proof of account ownership to set a new password.

`GET /api/admin/users` deliberately returns every user's plaintext sync `token`
so admin staff can help a splasher who lost theirs reconfigure the plugin. That's
a legitimate need on its own — but combined with the reset endpoint above, it
means **any admin can read a user's token from the admin panel and then use it to
silently set that user's password and take over the account**, with no signal to
the user and no audit trail. This is a real privilege-escalation hole in the
current design, not a hypothetical.

There is also no email field on `User` at all today, and no outbound-email
infrastructure anywhere in the project.

## Goals

1. Give users a self-service "forgot password" flow that doesn't depend on the
   RuneLite plugin token.
2. Close the admin/token account-takeover hole: the sync token must stop being
   sufficient to authorize a password change.
3. Preserve a support path for admins to help a locked-out user recover, without
   ever letting an admin see or set a usable password/reset secret themselves.
4. Do all of this without requiring existing users to have an email — it stays
   optional, self-service, added later.

## Non-goals

- Making email mandatory for account creation or login.
- Building a general notification/email-marketing system — this is transactional
  auth email only.
- CAPTCHA or bot-mitigation beyond existing rate limiting (YAGNI at current scale).

## Data model changes

### `User` (additions)

| Field | Type | Notes |
|---|---|---|
| `email` | `string?` | Optional, lowercase-normalized, unique **sparse** index (many users will have none). |
| `emailVerifiedAt` | `Date?` | Unset until the verification link is clicked. An unverified email is never eligible to receive a password-reset link. |
| `tokenVersion` | `number`, default `0` | Embedded in the JWT payload (`JwtPayload.tv`). Bumped on every password change so `requireAuth` can reject JWTs issued before the bump — closes a separate gap where a stolen 7-day session survives a password reset. |

### `EmailVerificationToken` (new collection)

| Field | Type | Notes |
|---|---|---|
| `userId` | `ObjectId` | ref `User` |
| `tokenHash` | `string` | SHA-256 of the raw token; raw value only ever exists in the emailed URL |
| `expiresAt` | `Date` | 24h from creation; TTL index for auto-cleanup |

### `PasswordResetToken` (new collection)

| Field | Type | Notes |
|---|---|---|
| `userId` | `ObjectId` | ref `User` |
| `tokenHash` | `string` | SHA-256 of the raw token |
| `expiresAt` | `Date` | 30 min from creation; TTL index |
| `requestedByAdmin` | `boolean`, default `false` | Audit metadata only — token behaves identically either way |

Both tokens are single-use: deleted from their collection immediately on
successful consumption, independent of the TTL expiry.

### `SecurityEvent`

Extend `SecurityEventType` with `'admin-generated-reset-link'`, recording the
acting admin's username and the target user's username. Reuses the existing
audit-log pattern (`setup-token-mismatch`, etc.) rather than inventing a new one.

## Token design rationale

Reset/verification tokens are **opaque random values, hashed at rest**, not
signed JWTs like the existing `SETUP_LINK_SECRET`-based account-setup link.
Rationale: a JWT stays valid until it expires regardless of "used" state, so
revocability still requires DB-side bookkeeping anyway (as `setupLinkUsed`
already shows) — an opaque hashed token gets single-use and instant revocation
for free via a DB delete, and doesn't tie reset-link security to a signing
secret that's also used for other purposes. A leaked DB dump alone can't be
replayed into a reset, since only the hash is stored.

## Endpoints

### Self-service — email management (authenticated)

- **`POST /auth/email`** `{ email, currentPassword }`
  Requires current password as a second factor before attaching/changing an
  email — a stolen JWT alone can't plant a backdoor recovery address. Stores
  the email unverified, issues an `EmailVerificationToken`, sends a
  verification email. Per-account rate limit (resend cooldown).
  If replacing an already-verified email, also sends an "account email
  changed" notice to the **old** address, so a hijacker who has temporary
  access can't quietly redirect recovery without the real owner noticing.

- **`GET /auth/verify-email/:token`**
  Hashes the token, looks it up unexpired, sets `emailVerifiedAt`, deletes the
  token. Single use.

### Self-service — forgot password (unauthenticated)

- **`POST /auth/forgot-password`** `{ email }`
  Always responds `200 { message: "If that address is registered, a reset
  link has been sent." }` regardless of whether the email exists or is
  verified — prevents account enumeration. If it matches a verified email,
  issues a `PasswordResetToken` and emails the link. Rate-limited per-IP and
  per-email.

- **`POST /auth/reset-password/:token`** `{ newPassword }`
  Hashes the token, looks it up unexpired and unused. On success: sets
  `passwordHash`, bumps `tokenVersion` (invalidates every existing session),
  deletes the token, sends a "your password was changed" notice to the
  verified email. Invalid/expired/already-used all return the same generic
  `400 Invalid or expired link` — no distinguishing signal.

  **This replaces the current `POST /auth/reset-password`.** The old
  `{ username, token, newPassword }` route (sync-token-authorizes-password)
  is deleted outright. The RuneLite sync token goes back to having exactly
  one job — WebSocket `AUTH` — and can no longer authorize anything else.
  `GET /api/admin/users` keeps returning the raw token (still needed for
  plugin-relink support), but that token is no longer usable to take over
  the account.

### Admin-assisted recovery

- **`POST /api/admin/users/:username/send-reset-link`** (admin-only)
  Only succeeds if the target user has a **verified** email: the server
  generates a `PasswordResetToken` (`requestedByAdmin: true`) and emails it
  directly to that address. The admin never sees the raw link — only a
  confirmation it was sent. Logged as a `SecurityEvent`.
  If the target has no verified email, the endpoint returns
  `400 { error: "User has no verified email to send a reset link to" }` —
  there is deliberately **no fallback** (no manual relay, no admin-visible
  link, no temporary-email workaround). A user with no verified email and no
  working RuneLite token has no recovery path until they can log in normally
  and add one. This is intentional: no third party — including an admin —
  should ever be able to see or hold a usable reset secret for someone else's
  account.

## Email sending

New `src/services/email.ts`, a thin interface over a transactional email
provider (recommended: **Resend** — simple API, workable free tier for this
project's volume, standard SPF/DKIM/DMARC setup docs):

```ts
sendVerificationEmail(to: string, link: string): Promise<void>
sendPasswordResetEmail(to: string, link: string): Promise<void>
sendPasswordChangedNotice(to: string): Promise<void>
sendEmailChangedNotice(oldEmail: string): Promise<void>
```

Kept behind this interface so the provider can be swapped later without
touching route code. New env vars: `RESEND_API_KEY`, `EMAIL_FROM_ADDRESS`.
Requires a verified sending domain with the provider (SPF/DKIM) — cannot send
authenticated mail "from" a personal inbox through it.

## Error handling & security properties

- Enumeration-safe responses on `/auth/forgot-password` and
  `/auth/reset-password/:token` (generic success/failure messages).
- All new sensitive routes reuse the existing `rateLimit` middleware
  (per-IP on the unauthenticated routes, per-account on `/auth/email`).
- Tokens are single-use and hashed at rest; TTL indexes provide defense in
  depth beyond the explicit expiry checks.
- `tokenVersion` bump on password change invalidates all other active
  sessions immediately, not just future logins.
- Every admin-initiated recovery action is audit-logged via `SecurityEvent`.
- No endpoint, including admin ones, ever returns a usable password-reset
  secret to anyone other than the account owner's own inbox.

## Frontend changes (`splash-helper-frontend`)

- `ForgotPasswordView` — email input, calls `/auth/forgot-password`, shows the
  generic success message.
- `ResetPasswordView` (`/reset-password?token=...`) — new password + confirm,
  calls `/auth/reset-password/:token`.
- Account settings: new "Email" section — add/change email (prompts for
  current password), shows verified/unverified state, resend-verification
  action.
- Admin panel's user table: "Send reset link" action, disabled/explained when
  the target has no verified email; shows a confirmation toast only, never a
  link.

### Chatbox reminder for missing/unverified email

`GET /splashers/:username` (the existing self-lookup route) additionally
returns `email`/`emailVerifiedAt` when the requester is viewing their own
data — same self-only gating it already applies to the plugin `token` field.

A new `useEmailReminder` hook (alongside Chatbox's other feed hooks) fires
once per mount (i.e. once per fresh visit — not on an interval) for an
authenticated user whose `emailVerifiedAt` is unset:

- No email on file → `logSystemEvent('Add an email to your account for
  recovery access.')`
- Email added but not yet verified → `logSystemEvent("Your email isn't
  verified yet — check your inbox to finish setup.")`

Nothing fires once `emailVerifiedAt` is set.

The reminder is also visually surfaced, not just logged quietly:
- Chatbox gains a transient `spotlightMessageId` state. When the reminder
  fires, it switches the active tab to Private, opens the chat window if
  closed, and sets the spotlight to the new message's id. While set, the
  Private tab renders only that one message instead of the full log.
- The chatbox container briefly gets a `chatbox--alert` CSS class (a
  yellow/orange pulse animation), cleared after ~1.5s via a timeout.
- Any manual tab selection through the existing `handleSelect` clears the
  spotlight — so switching to All and back to Private afterward shows the
  full Private history again, not just the warning.

## Testing

Follows the existing `__tests__/routes/auth.test.ts` pattern:
- Token hashing/expiry/single-use behavior (unit level).
- Route tests for every new endpoint, including the enumeration-safe response
  shape and rate-limit behavior.
- Confirms the old `{ username, token, newPassword }` reset route is gone
  (404/405).
- Confirms a `tokenVersion` bump actually invalidates a previously-issued JWT
  via `requireAuth`.
- Admin `send-reset-link`: success path (verified email), rejection path (no
  verified email), and that a `SecurityEvent` row is written.
