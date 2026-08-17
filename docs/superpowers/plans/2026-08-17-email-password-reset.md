# Email Password Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add email-based "forgot password" self-service recovery, and retire the existing RuneLite-sync-token-based reset route that lets any admin silently take over a user's account.

**Architecture:** Opaque, SHA-256-hashed, single-use reset/verification tokens stored in two new Mongo collections (never JWTs, so they're trivially revocable and don't share a secret's blast radius). A new `email.ts` service sends transactional mail via Resend's HTTP API, falling back to a console log when unconfigured (dev/test). `User` gains optional `email`/`emailVerifiedAt` fields plus a `tokenVersion` counter that, embedded in every JWT, lets `requireAuth` instantly invalidate all of a user's existing sessions the moment their password changes. The vulnerable `POST /auth/reset-password` route (sync token → password change) is deleted outright; admin-assisted recovery becomes "email a link to the user's verified address" only — an admin can never see or hold a usable reset secret.

**Tech Stack:** Backend: Node/TypeScript, Express, Mongoose, Jest + Supertest + mongodb-memory-server (existing). Frontend: React 19 + TypeScript + Vite (existing, no test framework installed).

**Spec:** [docs/superpowers/specs/2026-08-17-email-password-reset-design.md](../specs/2026-08-17-email-password-reset-design.md)

## Global Constraints

- Backend tests run via `npm test` from `splash-helper-backend/` (Jest + Supertest against an in-memory MongoDB — see `src/__tests__/globalSetup.ts`). Every backend task's "run the tests" step means this command, scoped with `-t`/a path where noted.
- The frontend has **no test framework installed** (no Jest/Vitest, no `*.test.ts(x)` files exist). Frontend task verification is `npm run build` (type-check + Vite bundle) from `splash-helper-frontend/` — a task is "passing" when that command exits 0. Do not introduce a new test framework as part of this plan; that would be its own separate decision.
- Password minimum length: 8 characters (existing convention, `src/routes/auth.ts`).
- Reset/verification tokens: 32 random bytes (`crypto.randomBytes`), hex-encoded for the raw value sent in links, SHA-256-hashed for the only copy stored at rest. Never store or log the raw value.
- Token lifetimes: password-reset tokens expire in 30 minutes; email-verification tokens expire in 24 hours (both via a Mongo TTL index with `expireAfterSeconds: 0` on `expiresAt`).
- Every new sensitive route uses the existing `src/middleware/rateLimit.ts` (extended in Task 6 to support a non-IP key).
- No endpoint — including admin ones — may ever return a raw reset/verification token or link in a JSON response body to anyone but the person whose email it was sent to. Admin-facing responses only ever confirm "sent" or explain why not.
- Every JWT signed in `src/routes/auth.ts` must include `tv: user.tokenVersion` in its payload (Task 4 onward).
- Follow existing style: frontend inline `style={}` objects built from `colors`/`fontSerif` tokens in `src/theme.ts`; backend doc-comments above each exported function/route explaining the non-obvious "why", matching the rest of `src/routes/auth.ts` and `src/routes/admin.ts`.
- Commit after each task using Conventional Commits (`feat(auth): ...`, `test(auth): ...`), per the git-feature-workflow already governing this branch (`feature/email-password-reset`).

---

## Task 1: `User` model — email, verification, and session-invalidation fields

**Files:**
- Modify: `splash-helper-backend/src/models/User.ts`
- Test: `splash-helper-backend/src/__tests__/models/user.test.ts` (new)

**Interfaces:**
- Produces: `IUser.email?: string`, `IUser.emailVerifiedAt?: Date`, `IUser.tokenVersion: number` — consumed by every later backend task.

- [ ] **Step 1: Write the failing test**

Create `splash-helper-backend/src/__tests__/models/user.test.ts`:

```ts
import { connectTestDB, disconnectTestDB, clearCollections } from '../testDb';
import { User } from '../../models/User';

beforeAll(async () => {
  await connectTestDB();
  await User.init(); // build indexes (incl. the new sparse unique email index) before asserting on them
});

afterAll(async () => {
  await disconnectTestDB();
});

beforeEach(async () => {
  await clearCollections();
});

describe('User model — email fields', () => {
  it('allows multiple users with no email set (sparse unique index)', async () => {
    await User.create({ username: 'alice', passwordHash: 'x', token: 'tok1', isAdmin: false, setupLinkUsed: true });
    await User.create({ username: 'bob', passwordHash: 'x', token: 'tok2', isAdmin: false, setupLinkUsed: true });
    expect(await User.countDocuments({})).toBe(2);
  });

  it('rejects a second user with the same email', async () => {
    await User.create({
      username: 'alice', passwordHash: 'x', token: 'tok1', isAdmin: false, setupLinkUsed: true,
      email: 'shared@example.com',
    });
    await expect(
      User.create({
        username: 'bob', passwordHash: 'x', token: 'tok2', isAdmin: false, setupLinkUsed: true,
        email: 'shared@example.com',
      }),
    ).rejects.toThrow(/duplicate key|E11000/);
  });

  it('defaults tokenVersion to 0', async () => {
    const user = await User.create({ username: 'alice', passwordHash: 'x', token: 'tok1', isAdmin: false, setupLinkUsed: true });
    expect(user.tokenVersion).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- user.test.ts` (from `splash-helper-backend/`)
Expected: FAIL — `email`/`tokenVersion` don't exist on the schema yet, so the uniqueness/default assertions fail.

- [ ] **Step 3: Modify the model**

In `splash-helper-backend/src/models/User.ts`, add to `IUser` (after `discordUserId?: string;`):

```ts
  /** Optional, self-service — see routes/auth.ts's POST /auth/email. Unset for most existing
   *  accounts, which keep working exactly as before; this is purely additive. */
  email?: string;
  /** Unset until the verification link is clicked. An email with no (or a stale) verification
   *  is never eligible to receive a password-reset link — see routes/auth.ts. */
  emailVerifiedAt?: Date;
  /** Bumped on every password change. Embedded in every issued JWT (see types/index.ts's
   *  JwtPayload.tv) so middleware/auth.ts's requireAuth can reject a token minted before the
   *  bump — a password reset instantly invalidates every other active session, not just ones
   *  that happen to expire naturally. */
  tokenVersion: number;
```

Add to `UserSchema`'s field definitions (after `discordUserId: { type: String },`):

```ts
    email: { type: String, trim: true, lowercase: true },
    emailVerifiedAt: { type: Date },
    tokenVersion: { type: Number, default: 0 },
```

Add a new index below the existing `UserSchema.index({ discordUserId: 1 });`:

```ts
// Sparse: most users have no email, and a sparse unique index only enforces uniqueness among
// documents where the field is actually set — unlike a plain unique index, it doesn't collide
// every emailless user against every other emailless user.
UserSchema.index({ email: 1 }, { unique: true, sparse: true });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- user.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/models/User.ts src/__tests__/models/user.test.ts
git commit -m "feat(auth): add email, emailVerifiedAt, tokenVersion to User"
```

---

## Task 2: Token infrastructure — hashing util + reset/verification token models

**Files:**
- Create: `splash-helper-backend/src/utils/secureToken.ts`
- Create: `splash-helper-backend/src/models/PasswordResetToken.ts`
- Create: `splash-helper-backend/src/models/EmailVerificationToken.ts`
- Test: `splash-helper-backend/src/__tests__/utils/secureToken.test.ts` (new)
- Test: `splash-helper-backend/src/__tests__/models/tokens.test.ts` (new)

**Interfaces:**
- Consumes: nothing new (Node's built-in `crypto`, `mongoose`).
- Produces: `generateToken(): { raw: string; hash: string }`, `hashToken(raw: string): string`, `PasswordResetToken` model (`userId`, `tokenHash`, `expiresAt`, `requestedByAdmin`), `EmailVerificationToken` model (`userId`, `tokenHash`, `expiresAt`) — consumed by Tasks 6, 7, 9.

- [ ] **Step 1: Write the failing tests**

Create `splash-helper-backend/src/__tests__/utils/secureToken.test.ts`:

```ts
import { generateToken, hashToken } from '../../utils/secureToken';

describe('secureToken', () => {
  it('generates a raw token whose hash matches hashToken(raw)', () => {
    const { raw, hash } = generateToken();
    expect(raw).toHaveLength(64); // 32 bytes, hex-encoded
    expect(hashToken(raw)).toBe(hash);
  });

  it('generates a different raw token on each call', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a.raw).not.toBe(b.raw);
    expect(a.hash).not.toBe(b.hash);
  });
});
```

Create `splash-helper-backend/src/__tests__/models/tokens.test.ts`:

```ts
import { Types } from 'mongoose';
import { connectTestDB, disconnectTestDB, clearCollections } from '../testDb';
import { PasswordResetToken } from '../../models/PasswordResetToken';
import { EmailVerificationToken } from '../../models/EmailVerificationToken';

beforeAll(async () => {
  await connectTestDB();
  await PasswordResetToken.init();
  await EmailVerificationToken.init();
});

afterAll(async () => {
  await disconnectTestDB();
});

beforeEach(async () => {
  await clearCollections();
});

describe('PasswordResetToken model', () => {
  it('defaults requestedByAdmin to false', async () => {
    const doc = await PasswordResetToken.create({
      userId: new Types.ObjectId(),
      tokenHash: 'abc123',
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });
    expect(doc.requestedByAdmin).toBe(false);
  });

  it('has a TTL index on expiresAt', async () => {
    const indexes = await PasswordResetToken.collection.indexes();
    const ttl = indexes.find((i) => i.expireAfterSeconds !== undefined);
    expect(ttl).toBeDefined();
    expect(ttl!.expireAfterSeconds).toBe(0);
  });
});

describe('EmailVerificationToken model', () => {
  it('ties a token to a user', async () => {
    const userId = new Types.ObjectId();
    const doc = await EmailVerificationToken.create({
      userId,
      tokenHash: 'def456',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    expect(doc.userId.toString()).toBe(userId.toString());
  });

  it('has a TTL index on expiresAt', async () => {
    const indexes = await EmailVerificationToken.collection.indexes();
    const ttl = indexes.find((i) => i.expireAfterSeconds !== undefined);
    expect(ttl).toBeDefined();
    expect(ttl!.expireAfterSeconds).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- secureToken.test.ts tokens.test.ts`
Expected: FAIL — none of the three modules exist yet (`Cannot find module`).

- [ ] **Step 3: Write the implementation**

Create `splash-helper-backend/src/utils/secureToken.ts`:

```ts
import { randomBytes, createHash } from 'crypto';

const TOKEN_BYTES = 32;

/** Hashes a raw token with SHA-256 — the only form ever persisted to the database, so a DB leak
 *  alone can never be replayed into a password reset or email verification (the raw value only
 *  ever existed in the one-time link sent to the user's inbox). */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Generates a fresh reset/verification token: the raw value (goes in the emailed link, never
 *  stored) and its hash (the only thing written to the database). */
export function generateToken(): { raw: string; hash: string } {
  const raw = randomBytes(TOKEN_BYTES).toString('hex');
  return { raw, hash: hashToken(raw) };
}
```

Create `splash-helper-backend/src/models/PasswordResetToken.ts`:

```ts
import mongoose, { Document, Schema, Types } from 'mongoose';

/** A single-use password-reset credential — see utils/secureToken.ts. Only `tokenHash` is ever
 *  stored; the raw value lives solely in the one-time link emailed to the user. Deleted on
 *  successful use (routes/auth.ts's POST /reset-password/:token), and self-expires via the TTL
 *  index below as a backstop if it's never used at all. */
export interface IPasswordResetToken extends Document {
  userId: Types.ObjectId;
  tokenHash: string;
  expiresAt: Date;
  /** Audit metadata only — an admin-generated link (see routes/admin.ts's
   *  POST /users/:username/send-reset-link) behaves identically to a self-requested one. */
  requestedByAdmin: boolean;
  createdAt: Date;
}

const PasswordResetTokenSchema = new Schema<IPasswordResetToken>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    requestedByAdmin: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } },
);

// expireAfterSeconds: 0 means "expire at the exact time in this Date field", not "immediately".
PasswordResetTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const PasswordResetToken = mongoose.model<IPasswordResetToken>('PasswordResetToken', PasswordResetTokenSchema);
```

Create `splash-helper-backend/src/models/EmailVerificationToken.ts`:

```ts
import mongoose, { Document, Schema, Types } from 'mongoose';

/** A single-use email-verification credential — see utils/secureToken.ts. Same shape and
 *  lifecycle as PasswordResetToken, kept as a separate collection since the two have different
 *  expiries (24h vs 30min) and are never valid for each other's purpose. */
export interface IEmailVerificationToken extends Document {
  userId: Types.ObjectId;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
}

const EmailVerificationTokenSchema = new Schema<IEmailVerificationToken>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } },
);

EmailVerificationTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const EmailVerificationToken = mongoose.model<IEmailVerificationToken>('EmailVerificationToken', EmailVerificationTokenSchema);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- secureToken.test.ts tokens.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/utils/secureToken.ts src/models/PasswordResetToken.ts src/models/EmailVerificationToken.ts src/__tests__/utils/secureToken.test.ts src/__tests__/models/tokens.test.ts
git commit -m "feat(auth): add hashed reset/verification token infrastructure"
```

---

## Task 3: Email service (Resend)

**Files:**
- Create: `splash-helper-backend/src/services/email.ts`
- Modify: `splash-helper-backend/.env.example`
- Modify: `.env.example` (repo root)
- Test: `splash-helper-backend/src/__tests__/services/email.test.ts` (new)

**Interfaces:**
- Produces: `sendVerificationEmail(to, link)`, `sendPasswordResetEmail(to, link)`, `sendPasswordChangedNotice(to)`, `sendEmailChangedNotice(oldEmail)` — all `(...) => Promise<void>` — consumed by Tasks 6, 7, 9.

- [ ] **Step 1: Write the failing test**

Create `splash-helper-backend/src/__tests__/services/email.test.ts`:

```ts
import * as email from '../../services/email';

// globalSetup.ts never sets RESEND_API_KEY, so the service's dev/test fallback (log instead of
// calling out) is what every one of these exercises — see services/email.ts.
describe('email service (RESEND_API_KEY unset)', () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('sendVerificationEmail resolves and logs instead of calling out', async () => {
    await expect(email.sendVerificationEmail('user@example.com', 'https://example.com/verify-email?token=abc')).resolves.toBeUndefined();
    expect(logSpy).toHaveBeenCalled();
  });

  it('sendPasswordResetEmail resolves and logs instead of calling out', async () => {
    await expect(email.sendPasswordResetEmail('user@example.com', 'https://example.com/reset-password?token=abc')).resolves.toBeUndefined();
    expect(logSpy).toHaveBeenCalled();
  });

  it('sendPasswordChangedNotice resolves and logs instead of calling out', async () => {
    await expect(email.sendPasswordChangedNotice('user@example.com')).resolves.toBeUndefined();
    expect(logSpy).toHaveBeenCalled();
  });

  it('sendEmailChangedNotice resolves and logs instead of calling out', async () => {
    await expect(email.sendEmailChangedNotice('old@example.com')).resolves.toBeUndefined();
    expect(logSpy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- email.test.ts`
Expected: FAIL — `Cannot find module '../../services/email'`

- [ ] **Step 3: Write the implementation**

Create `splash-helper-backend/src/services/email.ts`:

```ts
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM_ADDRESS = process.env.EMAIL_FROM_ADDRESS ?? 'Splash Helper <no-reply@example.com>';
const RESEND_TIMEOUT_MS = 5000;

/**
 * Sends one transactional email via Resend's HTTP API. Mirrors generateSetupLink's fallback
 * style in routes/auth.ts: without RESEND_API_KEY configured (local dev, tests), this just logs
 * instead of failing outright, so the rest of the app works without needing real mail
 * infrastructure set up.
 */
async function sendEmail(to: string, subject: string, text: string): Promise<void> {
  if (!RESEND_API_KEY) {
    console.log(`[email:dev] to=${to} subject="${subject}"\n${text}`);
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RESEND_TIMEOUT_MS);
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({ from: EMAIL_FROM_ADDRESS, to, subject, text }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Resend responded ${response.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

export async function sendVerificationEmail(to: string, link: string): Promise<void> {
  await sendEmail(
    to,
    'Verify your Splash Helper email',
    `Click the link below to verify your email address:\n\n${link}\n\nThis link expires in 24 hours. If you didn't request this, you can ignore this email.`,
  );
}

export async function sendPasswordResetEmail(to: string, link: string): Promise<void> {
  await sendEmail(
    to,
    'Reset your Splash Helper password',
    `Click the link below to reset your password:\n\n${link}\n\nThis link expires in 30 minutes. If you didn't request this, you can ignore this email.`,
  );
}

export async function sendPasswordChangedNotice(to: string): Promise<void> {
  await sendEmail(
    to,
    'Your Splash Helper password was changed',
    "Your account's password was just changed. If this wasn't you, contact an admin immediately.",
  );
}

export async function sendEmailChangedNotice(oldEmail: string): Promise<void> {
  await sendEmail(
    oldEmail,
    'Your Splash Helper account email was changed',
    "Your account's email address was just changed to a new address. If this wasn't you, contact an admin immediately.",
  );
}
```

In `splash-helper-backend/.env.example`, add a new section at the end:

```
# ── Transactional email (password reset / verification) ─────────────────────
# Optional: if unset, verification/reset emails are logged to the console instead of actually
# being sent — fine for local dev, not for production. Get an API key from resend.com and verify
# a sending domain there (SPF/DKIM) before setting these for real.
# RESEND_API_KEY=change-me-to-your-resend-api-key
# EMAIL_FROM_ADDRESS=Splash Helper <no-reply@yourdomain.com>
```

In the repo-root `.env.example`, add the same two commented lines under its existing `# ── Server` section or a new `# ── Email` section, matching that file's shorter style (no long comment block, matching its other entries).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- email.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/services/email.ts src/__tests__/services/email.test.ts .env.example
git -C .. add .env.example
git commit -m "feat(auth): add Resend-backed transactional email service"
```

---

## Task 4: JWT `tokenVersion` invalidation

**Files:**
- Modify: `splash-helper-backend/src/types/index.ts` (`JwtPayload`)
- Modify: `splash-helper-backend/src/middleware/auth.ts`
- Modify: `splash-helper-backend/src/routes/auth.ts:46-47` (login), `:94-95` (setup)
- Test: `splash-helper-backend/src/__tests__/middleware/auth.test.ts` (new)

**Interfaces:**
- Consumes: `User.tokenVersion` (Task 1)
- Produces: `JwtPayload.tv?: number`; `requireAuth`/`requireAdmin` become `async` (same call signature, callers unaffected) — every later task that signs a JWT must include `tv: user.tokenVersion`.

- [ ] **Step 1: Write the failing test**

Create `splash-helper-backend/src/__tests__/middleware/auth.test.ts`:

```ts
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { connectTestDB, disconnectTestDB, clearCollections } from '../testDb';
import { createTestApp } from '../testApp';
import { User } from '../../models/User';

const app = createTestApp();

beforeAll(async () => {
  await connectTestDB();
});

afterAll(async () => {
  await disconnectTestDB();
});

beforeEach(async () => {
  await clearCollections();
});

describe('requireAuth — tokenVersion invalidation', () => {
  it('accepts a freshly-issued token', async () => {
    const hash = await bcrypt.hash('password123', 12);
    await User.create({ username: 'alice', passwordHash: hash, token: 'tok1', isAdmin: false, setupLinkUsed: true });

    const login = await request(app).post('/api/auth/login').send({ username: 'alice', password: 'password123' });
    expect(login.status).toBe(200);

    const res = await request(app).get('/api/splashers/alice').set('Authorization', `Bearer ${login.body.token}`);
    expect(res.status).toBe(200);
  });

  it('rejects a token issued before a tokenVersion bump', async () => {
    const hash = await bcrypt.hash('password123', 12);
    await User.create({ username: 'alice', passwordHash: hash, token: 'tok1', isAdmin: false, setupLinkUsed: true });

    const login = await request(app).post('/api/auth/login').send({ username: 'alice', password: 'password123' });
    expect(login.status).toBe(200);

    // Simulate what a password reset will do in Task 7, independent of that endpoint.
    await User.updateOne({ username: 'alice' }, { $inc: { tokenVersion: 1 } });

    const res = await request(app).get('/api/splashers/alice').set('Authorization', `Bearer ${login.body.token}`);
    expect(res.status).toBe(401);
  });

  it('rejects a token for a user that no longer exists', async () => {
    const hash = await bcrypt.hash('password123', 12);
    await User.create({ username: 'alice', passwordHash: hash, token: 'tok1', isAdmin: false, setupLinkUsed: true });

    const login = await request(app).post('/api/auth/login').send({ username: 'alice', password: 'password123' });
    expect(login.status).toBe(200);

    await User.deleteOne({ username: 'alice' });

    const res = await request(app).get('/api/splashers/alice').set('Authorization', `Bearer ${login.body.token}`);
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- middleware/auth.test.ts`
Expected: FAIL on the second test — `requireAuth` doesn't check `tokenVersion` yet, so the bumped-version token is still accepted (200 instead of the expected 401).

- [ ] **Step 3: Write the implementation**

In `splash-helper-backend/src/types/index.ts`, modify `JwtPayload`:

```ts
export interface JwtPayload {
  sub: string;   // username
  isAdmin: boolean;
  communityEligible: boolean;
  /** User.tokenVersion at the time this JWT was issued. requireAuth compares this against the
   *  live value on the User document — bumping tokenVersion (e.g. on password reset) instantly
   *  invalidates every JWT issued before the bump, even ones that haven't expired yet. Missing
   *  on tokens minted before this field existed; treated as 0, matching User.tokenVersion's own
   *  default, so already-issued tokens keep working unaffected. */
  tv?: number;
  iat?: number;
  exp?: number;
}
```

Replace the full contents of `splash-helper-backend/src/middleware/auth.ts`:

```ts
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { JwtPayload } from '../types';
import { requireEnv } from '../config/env';
import { Community } from '../models/Community';
import { User } from '../models/User';

const JWT_SECRET = requireEnv('JWT_SECRET');

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const token = authHeader.slice(7);
  let payload: JwtPayload;
  try {
    payload = jwt.verify(token, JWT_SECRET) as JwtPayload;
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  // A password reset bumps the user's live tokenVersion — comparing it against the value this
  // JWT was issued with instantly invalidates every session token minted before the reset, not
  // just ones that happen to expire naturally over the following days.
  const user = await User.findOne({ username: payload.sub }, { tokenVersion: 1 });
  if (!user || user.tokenVersion !== (payload.tv ?? 0)) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  req.user = payload;
  next();
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  await requireAuth(req, res, () => {
    if (!req.user?.isAdmin) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }
    next();
  });
}

/**
 * Authenticates a request as belonging to a specific community, via the `X-Community-Token`
 * header matched against that community's `apiToken`. Used by every `/api/community-bot/*`
 * route (the Discord bot's ongoing per-guild calls) so handlers can trust `req.community`
 * without ever taking a community id from the request body/params.
 */
export async function requireCommunityToken(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = req.headers['x-community-token'];
  if (typeof token !== 'string' || !token.trim()) {
    res.status(401).json({ error: 'Community API token required' });
    return;
  }

  const community = await Community.findOne({ apiToken: token.trim() });
  if (!community) {
    res.status(401).json({ error: 'Invalid community API token' });
    return;
  }

  req.community = community;
  next();
}
```

In `splash-helper-backend/src/routes/auth.ts`, update the login route's JWT payload (currently `line 46`):

```ts
  const payload = { sub: user.username, isAdmin: user.isAdmin, communityEligible: user.communityEligible, tv: user.tokenVersion };
```

And the setup route's JWT payload (currently `line 94`):

```ts
  const jwtPayload = { sub: user.username, isAdmin: user.isAdmin, communityEligible: user.communityEligible, tv: user.tokenVersion };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- middleware/auth.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the full backend test suite to check for regressions**

Run: `npm test`
Expected: PASS — every existing `makeToken(username, isAdmin)` test helper across the suite signs a payload without `tv`, which resolves to `0` and matches every test user's default `tokenVersion` of `0`, so no existing test needs updating.

- [ ] **Step 6: Commit**

```bash
git add src/types/index.ts src/middleware/auth.ts src/routes/auth.ts src/__tests__/middleware/auth.test.ts
git commit -m "feat(auth): invalidate sessions via tokenVersion on password change"
```

---

## Task 5: Retire the sync-token password-reset route

This is the fix for the actual vulnerability: `POST /auth/reset-password` currently accepts the plugin sync `token` (visible to any admin via `GET /api/admin/users`) as sole proof to set a new password. Deleting it is a self-contained, independently reviewable step, ahead of building its replacement in Task 7.

**Files:**
- Modify: `splash-helper-backend/src/routes/auth.ts:1-19,99-146` (remove `timingSafeEqual` import, `resetPasswordLimiter`, `tokensMatch`, and the `POST /reset-password` handler)
- Modify: `splash-helper-backend/src/__tests__/routes/auth.test.ts:123-189` (remove the old `describe('POST /api/auth/reset-password')` block, add a regression check)

**Interfaces:**
- Produces: nothing (removal only) — Task 7 defines the replacement route at a different path shape (`/reset-password/:token`).

- [ ] **Step 1: Write the failing test**

In `splash-helper-backend/src/__tests__/routes/auth.test.ts`, replace the entire existing block (lines 123-189, `describe('POST /api/auth/reset-password', ...)`) with:

```ts
describe('POST /api/auth/reset-password (legacy sync-token route)', () => {
  it('no longer exists at the old bare path', async () => {
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ username: 'alice', token: 'tok1', newPassword: 'validpass123' });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- routes/auth.test.ts -t "legacy sync-token route"`
Expected: FAIL — the old route still exists and returns 401 (missing token match), not 404.

- [ ] **Step 3: Remove the old route**

In `splash-helper-backend/src/routes/auth.ts`:

Remove `import { timingSafeEqual } from 'crypto';` (line 4).

Remove this entire block (originally lines 99-146):

```ts
const resetPasswordLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

function tokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * POST /auth/reset-password
 * Body: { username: string; token: string; newPassword: string }
 * The plugin-held sync token doubles as proof of account ownership, so a user who forgot
 * their web password (but still has their RuneLite token) can reset it without any email
 * infrastructure or admin intervention.
 */
router.post('/reset-password', resetPasswordLimiter, async (req: Request, res: Response): Promise<void> => {
  const { username, token, newPassword } = req.body as { username?: string; token?: string; newPassword?: string };

  if (!username || !token || !newPassword) {
    res.status(400).json({ error: 'username, token, and newPassword are required' });
    return;
  }

  if (newPassword.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters' });
    return;
  }

  const user = await User.findOne({ username });
  if (!user || !tokensMatch(user.token, token)) {
    res.status(401).json({ error: 'Invalid username or token' });
    return;
  }

  user.passwordHash = await bcrypt.hash(newPassword, 12);
  await user.save();

  const jwtPayload = { sub: user.username, isAdmin: user.isAdmin, communityEligible: user.communityEligible, tv: user.tokenVersion };
  const jwtToken = jwt.sign(jwtPayload, JWT_SECRET, { expiresIn: '7d' });
  res.json({
    message: 'Password reset successfully',
    token: jwtToken,
    username: user.username,
    isAdmin: user.isAdmin,
    communityEligible: user.communityEligible,
  });
});
```

Leave everything else in the file (login, setup, `generateSetupLink`, `export default router;`) untouched for now — Tasks 6 and 7 add new routes back into this file.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- routes/auth.test.ts`
Expected: PASS — including the rest of the file's existing login/setup tests, unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/routes/auth.ts src/__tests__/routes/auth.test.ts
git commit -m "fix(auth): remove sync-token password reset — closes admin account-takeover hole"
```

---

## Task 6: Self-service email management

**Files:**
- Modify: `splash-helper-backend/src/middleware/rateLimit.ts` (add optional `keyFn`)
- Modify: `splash-helper-backend/src/routes/auth.ts` (add `POST /email`, `GET /verify-email/:token`, `POST /resend-verification`)
- Test: `splash-helper-backend/src/__tests__/middleware/rateLimit.test.ts` (new)
- Test: `splash-helper-backend/src/__tests__/routes/auth.test.ts` (append)

**Interfaces:**
- Consumes: `generateToken`/`hashToken` (Task 2), `EmailVerificationToken` (Task 2), `sendVerificationEmail`/`sendEmailChangedNotice` (Task 3), `requireAuth` (Task 4).
- Produces: `rateLimit({ windowMs, max, keyFn? })` — `keyFn` consumed again by Task 7's per-email limiter.

- [ ] **Step 1: Write the failing rate-limit test**

Create `splash-helper-backend/src/__tests__/middleware/rateLimit.test.ts`:

```ts
import express from 'express';
import request from 'supertest';
import { rateLimit } from '../../middleware/rateLimit';

function buildApp(keyFn?: (req: express.Request) => string) {
  const app = express();
  app.use(express.json());
  app.use(rateLimit({ windowMs: 60_000, max: 2, keyFn }));
  app.post('/probe', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('rateLimit keyFn', () => {
  it('limits per-IP by default', async () => {
    const app = buildApp();
    await request(app).post('/probe').expect(200);
    await request(app).post('/probe').expect(200);
    await request(app).post('/probe').expect(429);
  });

  it('limits per-key when keyFn is provided, independent of other keys', async () => {
    const app = buildApp((req) => (req.body as { email?: string }).email ?? 'unknown');
    await request(app).post('/probe').send({ email: 'a@example.com' }).expect(200);
    await request(app).post('/probe').send({ email: 'a@example.com' }).expect(200);
    await request(app).post('/probe').send({ email: 'a@example.com' }).expect(429);
    await request(app).post('/probe').send({ email: 'b@example.com' }).expect(200);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- middleware/rateLimit.test.ts`
Expected: FAIL — `rateLimit` doesn't accept `keyFn` yet (TypeScript compile error on the test file).

- [ ] **Step 3: Extend the rate limiter**

Replace the contents of `splash-helper-backend/src/middleware/rateLimit.ts`:

```ts
import { Request, Response, NextFunction } from 'express';

interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Defaults to per-IP (`req.ip`). Override to key by something else — e.g. the authenticated
   *  username, or a field pulled from the request body — for a per-account/per-target limiter
   *  instead of a per-client one. */
  keyFn?: (req: Request) => string;
}

/**
 * Minimal in-memory, per-IP sliding-window limiter for a single route. Not shared across
 * server instances — fine for the low-traffic, single-process deployment this project runs.
 */
export function rateLimit({ windowMs, max, keyFn }: RateLimitOptions) {
  const hits = new Map<string, number[]>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = (keyFn ? keyFn(req) : req.ip) ?? 'unknown';
    const now = Date.now();
    const windowStart = now - windowMs;

    const timestamps = (hits.get(key) ?? []).filter((t) => t > windowStart);
    if (timestamps.length >= max) {
      res.status(429).json({ error: 'Too many attempts. Please try again later.' });
      return;
    }

    timestamps.push(now);
    hits.set(key, timestamps);
    next();
  };
}
```

- [ ] **Step 4: Run the rate-limit test to verify it passes**

Run: `npm test -- middleware/rateLimit.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Write the failing route tests**

Append to `splash-helper-backend/src/__tests__/routes/auth.test.ts` (add these imports at the top, alongside the existing ones):

```ts
import { EmailVerificationToken } from '../../models/EmailVerificationToken';
import { generateToken } from '../../utils/secureToken';
```

Append these `describe` blocks at the end of the file:

```ts
describe('POST /api/auth/email', () => {
  function makeAuthToken(username: string) {
    return jwt.sign({ sub: username, isAdmin: false, tv: 0 }, JWT_SECRET, { expiresIn: '1h' });
  }

  it('returns 401 without auth', async () => {
    await request(app).post('/api/auth/email').send({ email: 'a@example.com', currentPassword: 'x' }).expect(401);
  });

  it('returns 400 for missing fields', async () => {
    const hash = await bcrypt.hash('password123', 12);
    await User.create({ username: 'alice', passwordHash: hash, token: 'tok1', isAdmin: false, setupLinkUsed: true });
    await request(app)
      .post('/api/auth/email')
      .set('Authorization', `Bearer ${makeAuthToken('alice')}`)
      .send({})
      .expect(400);
  });

  it('returns 400 for an invalid email address', async () => {
    const hash = await bcrypt.hash('password123', 12);
    await User.create({ username: 'alice', passwordHash: hash, token: 'tok1', isAdmin: false, setupLinkUsed: true });
    const res = await request(app)
      .post('/api/auth/email')
      .set('Authorization', `Bearer ${makeAuthToken('alice')}`)
      .send({ email: 'not-an-email', currentPassword: 'password123' });
    expect(res.status).toBe(400);
  });

  it('returns 401 for an incorrect current password', async () => {
    const hash = await bcrypt.hash('password123', 12);
    await User.create({ username: 'alice', passwordHash: hash, token: 'tok1', isAdmin: false, setupLinkUsed: true });
    const res = await request(app)
      .post('/api/auth/email')
      .set('Authorization', `Bearer ${makeAuthToken('alice')}`)
      .send({ email: 'alice@example.com', currentPassword: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('sets the email unverified and creates a verification token', async () => {
    const hash = await bcrypt.hash('password123', 12);
    await User.create({ username: 'alice', passwordHash: hash, token: 'tok1', isAdmin: false, setupLinkUsed: true });
    const res = await request(app)
      .post('/api/auth/email')
      .set('Authorization', `Bearer ${makeAuthToken('alice')}`)
      .send({ email: 'Alice@Example.com', currentPassword: 'password123' });
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('alice@example.com');
    expect(res.body.emailVerifiedAt).toBeNull();

    const user = await User.findOne({ username: 'alice' });
    expect(user!.email).toBe('alice@example.com');
    expect(user!.emailVerifiedAt).toBeUndefined();
    expect(await EmailVerificationToken.countDocuments({ userId: user!._id })).toBe(1);
  });

  it('returns 409 when the email is already in use on another account', async () => {
    const hash = await bcrypt.hash('password123', 12);
    await User.create({
      username: 'alice', passwordHash: hash, token: 'tok1', isAdmin: false, setupLinkUsed: true,
      email: 'taken@example.com', emailVerifiedAt: new Date(),
    });
    await User.create({ username: 'bob', passwordHash: hash, token: 'tok2', isAdmin: false, setupLinkUsed: true });

    const res = await request(app)
      .post('/api/auth/email')
      .set('Authorization', `Bearer ${makeAuthToken('bob')}`)
      .send({ email: 'taken@example.com', currentPassword: 'password123' });
    expect(res.status).toBe(409);
  });
});

describe('GET /api/auth/verify-email/:token', () => {
  it('returns 400 for an unknown token', async () => {
    const res = await request(app).get('/api/auth/verify-email/not-a-real-token');
    expect(res.status).toBe(400);
  });

  it('verifies the email and consumes the token on success', async () => {
    const hash = await bcrypt.hash('password123', 12);
    const user = await User.create({
      username: 'alice', passwordHash: hash, token: 'tok1', isAdmin: false, setupLinkUsed: true,
      email: 'alice@example.com',
    });
    const { raw, hash: tokenHash } = generateToken();
    await EmailVerificationToken.create({ userId: user._id, tokenHash, expiresAt: new Date(Date.now() + 60_000) });

    const res = await request(app).get(`/api/auth/verify-email/${raw}`);
    expect(res.status).toBe(200);

    const updated = await User.findOne({ username: 'alice' });
    expect(updated!.emailVerifiedAt).toBeInstanceOf(Date);
    expect(await EmailVerificationToken.countDocuments({ userId: user._id })).toBe(0);
  });

  it('returns 400 for an expired token', async () => {
    const hash = await bcrypt.hash('password123', 12);
    const user = await User.create({
      username: 'alice', passwordHash: hash, token: 'tok1', isAdmin: false, setupLinkUsed: true,
      email: 'alice@example.com',
    });
    const { raw, hash: tokenHash } = generateToken();
    await EmailVerificationToken.create({ userId: user._id, tokenHash, expiresAt: new Date(Date.now() - 1000) });

    const res = await request(app).get(`/api/auth/verify-email/${raw}`);
    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/resend-verification', () => {
  function makeAuthToken(username: string) {
    return jwt.sign({ sub: username, isAdmin: false, tv: 0 }, JWT_SECRET, { expiresIn: '1h' });
  }

  it('returns 400 when there is no email on file', async () => {
    const hash = await bcrypt.hash('password123', 12);
    await User.create({ username: 'alice', passwordHash: hash, token: 'tok1', isAdmin: false, setupLinkUsed: true });
    const res = await request(app)
      .post('/api/auth/resend-verification')
      .set('Authorization', `Bearer ${makeAuthToken('alice')}`);
    expect(res.status).toBe(400);
  });

  it('returns 400 when the email is already verified', async () => {
    const hash = await bcrypt.hash('password123', 12);
    await User.create({
      username: 'alice', passwordHash: hash, token: 'tok1', isAdmin: false, setupLinkUsed: true,
      email: 'alice@example.com', emailVerifiedAt: new Date(),
    });
    const res = await request(app)
      .post('/api/auth/resend-verification')
      .set('Authorization', `Bearer ${makeAuthToken('alice')}`);
    expect(res.status).toBe(400);
  });

  it('issues a fresh token, replacing any previous one', async () => {
    const hash = await bcrypt.hash('password123', 12);
    const user = await User.create({
      username: 'alice', passwordHash: hash, token: 'tok1', isAdmin: false, setupLinkUsed: true,
      email: 'alice@example.com',
    });
    await EmailVerificationToken.create({ userId: user._id, tokenHash: 'stale', expiresAt: new Date(Date.now() + 60_000) });

    const res = await request(app)
      .post('/api/auth/resend-verification')
      .set('Authorization', `Bearer ${makeAuthToken('alice')}`);
    expect(res.status).toBe(200);

    const tokens = await EmailVerificationToken.find({ userId: user._id });
    expect(tokens).toHaveLength(1);
    expect(tokens[0].tokenHash).not.toBe('stale');
  });
});
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `npm test -- routes/auth.test.ts`
Expected: FAIL — none of the three routes exist yet (every new test gets a 404).

- [ ] **Step 7: Implement the routes**

In `splash-helper-backend/src/routes/auth.ts`, add to the imports at the top:

```ts
import { requireAuth } from '../middleware/auth';
import { EmailVerificationToken } from '../models/EmailVerificationToken';
import { generateToken, hashToken } from '../utils/secureToken';
import { sendVerificationEmail, sendEmailChangedNotice } from '../services/email';
```

Append this block to the file, after the setup route and before `generateSetupLink`:

```ts
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_VERIFICATION_EXPIRY_MS = 24 * 60 * 60 * 1000;

const emailChangeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyFn: (req) => req.user?.sub ?? req.ip ?? 'unknown',
});

/**
 * POST /auth/email
 * Body: { email: string; currentPassword: string }
 * Attaches or replaces the caller's own email. Requires their current password as a second
 * factor, so a stolen JWT alone can't plant a backdoor recovery address. Always resets
 * emailVerifiedAt — even re-submitting the same address has to be re-verified — and sends a
 * fresh verification link. If a different, already-verified email is being replaced, also
 * notifies the old address, so a hijacker with temporary access can't quietly redirect recovery
 * without the real owner noticing.
 */
router.post('/email', requireAuth, emailChangeLimiter, async (req: Request, res: Response): Promise<void> => {
  const { email, currentPassword } = req.body as { email?: string; currentPassword?: string };

  if (!email || !currentPassword) {
    res.status(400).json({ error: 'email and currentPassword are required' });
    return;
  }

  const normalizedEmail = email.trim().toLowerCase();
  if (!EMAIL_RE.test(normalizedEmail)) {
    res.status(400).json({ error: 'Invalid email address' });
    return;
  }

  const user = await User.findOne({ username: req.user!.sub });
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: 'Incorrect password' });
    return;
  }

  const previousVerifiedEmail = user.emailVerifiedAt ? user.email : undefined;

  user.email = normalizedEmail;
  user.emailVerifiedAt = undefined;
  try {
    await user.save();
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as { code?: number }).code === 11000) {
      res.status(409).json({ error: 'That email is already in use on another account' });
      return;
    }
    throw err;
  }

  await EmailVerificationToken.deleteMany({ userId: user._id });
  const { raw, hash } = generateToken();
  await EmailVerificationToken.create({
    userId: user._id,
    tokenHash: hash,
    expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_EXPIRY_MS),
  });

  await sendVerificationEmail(normalizedEmail, `${FRONTEND_URL}/verify-email?token=${raw}`);
  if (previousVerifiedEmail && previousVerifiedEmail !== normalizedEmail) {
    await sendEmailChangedNotice(previousVerifiedEmail);
  }

  res.json({ email: user.email, emailVerifiedAt: null, message: 'Verification email sent.' });
});

/**
 * GET /auth/verify-email/:token
 * Public — the token itself is the credential. Single use, 24h expiry.
 */
router.get('/verify-email/:token', async (req: Request, res: Response): Promise<void> => {
  const { token } = req.params;
  const record = await EmailVerificationToken.findOne({ tokenHash: hashToken(token), expiresAt: { $gt: new Date() } });
  if (!record) {
    res.status(400).json({ error: 'Invalid or expired link' });
    return;
  }

  const user = await User.findById(record.userId);
  if (!user) {
    res.status(400).json({ error: 'Invalid or expired link' });
    return;
  }

  user.emailVerifiedAt = new Date();
  await user.save();
  await EmailVerificationToken.deleteOne({ _id: record._id });

  res.json({ message: 'Email verified.' });
});

const resendVerificationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  keyFn: (req) => req.user?.sub ?? req.ip ?? 'unknown',
});

/**
 * POST /auth/resend-verification
 * Re-sends a verification link for the caller's already-attached, still-unverified email. No
 * currentPassword needed — nothing about the account changes, this only resends.
 */
router.post('/resend-verification', requireAuth, resendVerificationLimiter, async (req: Request, res: Response): Promise<void> => {
  const user = await User.findOne({ username: req.user!.sub });
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  if (!user.email) {
    res.status(400).json({ error: 'No email on file to verify' });
    return;
  }
  if (user.emailVerifiedAt) {
    res.status(400).json({ error: 'Email is already verified' });
    return;
  }

  await EmailVerificationToken.deleteMany({ userId: user._id });
  const { raw, hash } = generateToken();
  await EmailVerificationToken.create({
    userId: user._id,
    tokenHash: hash,
    expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_EXPIRY_MS),
  });

  await sendVerificationEmail(user.email, `${FRONTEND_URL}/verify-email?token=${raw}`);
  res.json({ message: 'Verification email sent.' });
});
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm test -- routes/auth.test.ts`
Expected: PASS (all `/auth/email`, `/auth/verify-email/:token`, `/auth/resend-verification` tests, plus every pre-existing test in the file)

- [ ] **Step 9: Commit**

```bash
git add src/middleware/rateLimit.ts src/routes/auth.ts src/__tests__/middleware/rateLimit.test.ts src/__tests__/routes/auth.test.ts
git commit -m "feat(auth): add self-service email add/verify/resend endpoints"
```

---

## Task 7: Self-service forgot-password / reset-password

**Files:**
- Modify: `splash-helper-backend/src/routes/auth.ts`
- Test: `splash-helper-backend/src/__tests__/routes/auth.test.ts` (append)

**Interfaces:**
- Consumes: `PasswordResetToken` (Task 2), `generateToken`/`hashToken` (Task 2), `sendPasswordResetEmail`/`sendPasswordChangedNotice` (Task 3), `rateLimit` with `keyFn` (Task 6).
- Produces: `POST /auth/forgot-password`, `POST /auth/reset-password/:token` — the self-service replacement for the route removed in Task 5.

- [ ] **Step 1: Write the failing tests**

Add this import to `splash-helper-backend/src/__tests__/routes/auth.test.ts`:

```ts
import { PasswordResetToken } from '../../models/PasswordResetToken';
```

Append at the end of the file:

```ts
describe('POST /api/auth/forgot-password', () => {
  it('returns the same generic message whether or not the email is registered', async () => {
    const res1 = await request(app).post('/api/auth/forgot-password').send({ email: 'nobody@example.com' });
    const res2 = await request(app).post('/api/auth/forgot-password').send({});
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(res1.body.message).toBe(res2.body.message);
  });

  it('creates a reset token only for a verified, matching email', async () => {
    const hash = await bcrypt.hash('password123', 12);
    const user = await User.create({
      username: 'alice', passwordHash: hash, token: 'tok1', isAdmin: false, setupLinkUsed: true,
      email: 'alice@example.com', emailVerifiedAt: new Date(),
    });

    await request(app).post('/api/auth/forgot-password').send({ email: 'alice@example.com' }).expect(200);

    const tokens = await PasswordResetToken.find({ userId: user._id });
    expect(tokens).toHaveLength(1);
    expect(tokens[0].requestedByAdmin).toBe(false);
  });

  it('does not create a token for an unverified email', async () => {
    const hash = await bcrypt.hash('password123', 12);
    const user = await User.create({
      username: 'alice', passwordHash: hash, token: 'tok1', isAdmin: false, setupLinkUsed: true,
      email: 'alice@example.com',
    });

    await request(app).post('/api/auth/forgot-password').send({ email: 'alice@example.com' }).expect(200);

    expect(await PasswordResetToken.countDocuments({ userId: user._id })).toBe(0);
  });
});

describe('POST /api/auth/reset-password/:token', () => {
  async function makeVerifiedUser() {
    const hash = await bcrypt.hash('old-pass', 12);
    return User.create({
      username: 'alice', passwordHash: hash, token: 'tok1', isAdmin: false, setupLinkUsed: true,
      email: 'alice@example.com', emailVerifiedAt: new Date(),
    });
  }

  it('returns 400 for a too-short newPassword', async () => {
    const res = await request(app).post('/api/auth/reset-password/whatever').send({ newPassword: 'short' });
    expect(res.status).toBe(400);
  });

  it('returns 400 for an unknown token', async () => {
    const res = await request(app).post('/api/auth/reset-password/not-a-real-token').send({ newPassword: 'validpass123' });
    expect(res.status).toBe(400);
  });

  it('returns 400 for an expired token', async () => {
    const user = await makeVerifiedUser();
    const { raw, hash: tokenHash } = generateToken();
    await PasswordResetToken.create({ userId: user._id, tokenHash, expiresAt: new Date(Date.now() - 1000) });

    const res = await request(app).post(`/api/auth/reset-password/${raw}`).send({ newPassword: 'validpass123' });
    expect(res.status).toBe(400);
  });

  it('resets the password, bumps tokenVersion, and consumes the token', async () => {
    const user = await makeVerifiedUser();
    const { raw, hash: tokenHash } = generateToken();
    await PasswordResetToken.create({ userId: user._id, tokenHash, expiresAt: new Date(Date.now() + 60_000) });

    const res = await request(app).post(`/api/auth/reset-password/${raw}`).send({ newPassword: 'new-valid-pass' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();

    const updated = await User.findOne({ username: 'alice' });
    expect(await bcrypt.compare('new-valid-pass', updated!.passwordHash)).toBe(true);
    expect(updated!.tokenVersion).toBe(1);
    expect(await PasswordResetToken.countDocuments({ userId: user._id })).toBe(0);
  });

  it('cannot be used twice', async () => {
    const user = await makeVerifiedUser();
    const { raw, hash: tokenHash } = generateToken();
    await PasswordResetToken.create({ userId: user._id, tokenHash, expiresAt: new Date(Date.now() + 60_000) });

    await request(app).post(`/api/auth/reset-password/${raw}`).send({ newPassword: 'first-new-pass' }).expect(200);
    const second = await request(app).post(`/api/auth/reset-password/${raw}`).send({ newPassword: 'second-new-pass' });
    expect(second.status).toBe(400);
  });

  it('invalidates a session token that was issued before the reset', async () => {
    const user = await makeVerifiedUser();
    const oldSessionToken = jwt.sign({ sub: user.username, isAdmin: false, tv: 0 }, JWT_SECRET, { expiresIn: '1h' });

    const { raw, hash: tokenHash } = generateToken();
    await PasswordResetToken.create({ userId: user._id, tokenHash, expiresAt: new Date(Date.now() + 60_000) });
    await request(app).post(`/api/auth/reset-password/${raw}`).send({ newPassword: 'new-valid-pass' }).expect(200);

    const res = await request(app).get('/api/splashers/alice').set('Authorization', `Bearer ${oldSessionToken}`);
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- routes/auth.test.ts`
Expected: FAIL — both routes 404 (they don't exist yet).

- [ ] **Step 3: Implement the routes**

Add to the imports at the top of `splash-helper-backend/src/routes/auth.ts`:

```ts
import { PasswordResetToken } from '../models/PasswordResetToken';
import { sendPasswordResetEmail, sendPasswordChangedNotice } from '../services/email';
```

Append this block after the email-management routes from Task 6, still before `generateSetupLink`:

```ts
const PASSWORD_RESET_EXPIRY_MS = 30 * 60 * 1000;

const forgotPasswordIpLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
const forgotPasswordEmailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyFn: (req) => ((req.body as { email?: string }).email ?? 'unknown').trim().toLowerCase(),
});

/**
 * POST /auth/forgot-password
 * Body: { email: string }
 * Always responds with the same generic message regardless of whether the address is
 * registered or verified, to prevent account enumeration.
 */
router.post(
  '/forgot-password',
  forgotPasswordIpLimiter,
  forgotPasswordEmailLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const { email } = req.body as { email?: string };
    const generic = { message: 'If that address is registered, a reset link has been sent.' };

    if (!email) {
      res.json(generic);
      return;
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail, emailVerifiedAt: { $ne: null } });
    if (user) {
      await PasswordResetToken.deleteMany({ userId: user._id });
      const { raw, hash } = generateToken();
      await PasswordResetToken.create({
        userId: user._id,
        tokenHash: hash,
        expiresAt: new Date(Date.now() + PASSWORD_RESET_EXPIRY_MS),
        requestedByAdmin: false,
      });
      await sendPasswordResetEmail(user.email!, `${FRONTEND_URL}/reset-password?token=${raw}`);
    }

    res.json(generic);
  },
);

const resetPasswordTokenLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

/**
 * POST /auth/reset-password/:token
 * Body: { newPassword: string }
 * The only way to reset a password now, aside from an admin-triggered email (see
 * POST /admin/users/:username/send-reset-link) — replaces the sync-token route removed
 * earlier on this branch. Bumps tokenVersion (invalidating every existing session) and clears
 * every other outstanding reset token for the user as defense in depth.
 */
router.post('/reset-password/:token', resetPasswordTokenLimiter, async (req: Request, res: Response): Promise<void> => {
  const { token } = req.params;
  const { newPassword } = req.body as { newPassword?: string };

  if (!newPassword || newPassword.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters' });
    return;
  }

  const record = await PasswordResetToken.findOne({ tokenHash: hashToken(token), expiresAt: { $gt: new Date() } });
  if (!record) {
    res.status(400).json({ error: 'Invalid or expired link' });
    return;
  }

  const user = await User.findById(record.userId);
  if (!user) {
    res.status(400).json({ error: 'Invalid or expired link' });
    return;
  }

  user.passwordHash = await bcrypt.hash(newPassword, 12);
  user.tokenVersion += 1;
  await user.save();
  await PasswordResetToken.deleteMany({ userId: user._id });

  if (user.email && user.emailVerifiedAt) {
    await sendPasswordChangedNotice(user.email);
  }

  const jwtPayload = { sub: user.username, isAdmin: user.isAdmin, communityEligible: user.communityEligible, tv: user.tokenVersion };
  const jwtToken = jwt.sign(jwtPayload, JWT_SECRET, { expiresIn: '7d' });
  res.json({
    message: 'Password reset successfully',
    token: jwtToken,
    username: user.username,
    isAdmin: user.isAdmin,
    communityEligible: user.communityEligible,
  });
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- routes/auth.test.ts`
Expected: PASS (every test in the file)

- [ ] **Step 5: Commit**

```bash
git add src/routes/auth.ts src/__tests__/routes/auth.test.ts
git commit -m "feat(auth): add email-based forgot-password / reset-password flow"
```

---

## Task 8: Expose email status on the self-lookup endpoint

**Files:**
- Modify: `splash-helper-backend/src/routes/splashers.ts:96-105`
- Test: `splash-helper-backend/src/__tests__/routes/splashers.test.ts` (append inside the existing `GET /api/splashers/:username` describe block)

**Interfaces:**
- Produces: `GET /api/splashers/:username` response gains `email?: string`, `emailVerifiedAt?: Date`, populated only when the requester is viewing their own data — consumed by frontend Tasks 10, 15, 17.

- [ ] **Step 1: Write the failing test**

In `splash-helper-backend/src/__tests__/routes/splashers.test.ts`, add this test inside the existing `describe('GET /api/splashers/:username', ...)` block (e.g. right after the `'returns own archived sessions when authenticated'` test):

```ts
  it('includes email/emailVerifiedAt for self but not for other viewers', async () => {
    const hash = await bcrypt.hash('pass', 12);
    await User.create({
      username: 'alice', passwordHash: hash, token: 't1', setupLinkUsed: true,
      email: 'alice@example.com', emailVerifiedAt: new Date(),
    });
    await User.create({ username: 'admin', passwordHash: hash, token: 't2', setupLinkUsed: true, isAdmin: true });

    const self = await request(app).get('/api/splashers/alice').set('Authorization', `Bearer ${makeToken('alice')}`);
    expect(self.status).toBe(200);
    expect(self.body.email).toBe('alice@example.com');
    expect(self.body.emailVerifiedAt).toBeDefined();

    const asAdmin = await request(app).get('/api/splashers/alice').set('Authorization', `Bearer ${makeToken('admin', true)}`);
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.email).toBeUndefined();
    expect(asAdmin.body.emailVerifiedAt).toBeUndefined();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- routes/splashers.test.ts -t "email/emailVerifiedAt"`
Expected: FAIL — `res.body.email` is `undefined` even for self (the route doesn't return it yet).

- [ ] **Step 3: Modify the route**

In `splash-helper-backend/src/routes/splashers.ts`, replace the response block (originally lines 96-105):

```ts
  const isSelf = requester.sub === username;
  res.json({
    username,
    sessions,
    discordActiveWebhookUrl: user.discordActiveWebhookUrl,
    discordHistoryWebhookUrl: user.discordHistoryWebhookUrl,
    // The plugin sync token and email are only ever included for the splasher viewing their own
    // data — never when a community owner is looking up one of their members through this same
    // route.
    token: isSelf ? user.token : undefined,
    email: isSelf ? user.email : undefined,
    emailVerifiedAt: isSelf ? user.emailVerifiedAt : undefined,
  });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- routes/splashers.test.ts`
Expected: PASS (whole file)

- [ ] **Step 5: Commit**

```bash
git add src/routes/splashers.ts src/__tests__/routes/splashers.test.ts
git commit -m "feat(auth): expose email status on self splasher lookup"
```

---

## Task 9: Admin-assisted recovery (verified-email-only)

**Files:**
- Modify: `splash-helper-backend/src/models/SecurityEvent.ts`
- Modify: `splash-helper-backend/src/routes/admin.ts`
- Test: `splash-helper-backend/src/__tests__/routes/admin.test.ts` (append)

**Interfaces:**
- Consumes: `PasswordResetToken`/`generateToken` (Task 2), `sendPasswordResetEmail` (Task 3).
- Produces: `POST /api/admin/users/:username/send-reset-link`; `SecurityEventType` gains `'admin-generated-reset-link'`.

- [ ] **Step 1: Write the failing tests**

Add this import to `splash-helper-backend/src/__tests__/routes/admin.test.ts`:

```ts
import { PasswordResetToken } from '../../models/PasswordResetToken';
import { SecurityEvent } from '../../models/SecurityEvent';
```

Append at the end of the file:

```ts
describe('POST /api/admin/users/:username/send-reset-link', () => {
  it('returns 401 without auth', async () => {
    await request(app).post('/api/admin/users/alice/send-reset-link').expect(401);
  });

  it('returns 403 for non-admin', async () => {
    await createUser('alice');
    const res = await request(app)
      .post('/api/admin/users/alice/send-reset-link')
      .set('Authorization', `Bearer ${makeToken('alice', false)}`);
    expect(res.status).toBe(403);
  });

  it('returns 404 for an unknown user', async () => {
    await createUser('admin', true);
    const res = await request(app)
      .post('/api/admin/users/nobody/send-reset-link')
      .set('Authorization', `Bearer ${makeToken('admin', true)}`);
    expect(res.status).toBe(404);
  });

  it('returns 400 when the target has no verified email', async () => {
    await createUser('alice');
    await createUser('admin', true);
    const res = await request(app)
      .post('/api/admin/users/alice/send-reset-link')
      .set('Authorization', `Bearer ${makeToken('admin', true)}`);
    expect(res.status).toBe(400);
  });

  it('sends a reset link, logs a SecurityEvent, and never returns a raw token', async () => {
    const alice = await createUser('alice');
    alice.email = 'alice@example.com';
    alice.emailVerifiedAt = new Date();
    await alice.save();
    await createUser('admin', true);

    const res = await request(app)
      .post('/api/admin/users/alice/send-reset-link')
      .set('Authorization', `Bearer ${makeToken('admin', true)}`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/[0-9a-f]{64}/); // no raw 32-byte hex token anywhere in the response

    const tokens = await PasswordResetToken.find({ userId: alice._id });
    expect(tokens).toHaveLength(1);
    expect(tokens[0].requestedByAdmin).toBe(true);

    const events = await SecurityEvent.find({ type: 'admin-generated-reset-link' });
    expect(events).toHaveLength(1);
    expect(events[0].adminUsername).toBe('admin');
    expect(events[0].targetUsername).toBe('alice');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- routes/admin.test.ts`
Expected: FAIL — the route 404s (doesn't exist yet).

- [ ] **Step 3: Extend `SecurityEvent`**

Replace the contents of `splash-helper-backend/src/models/SecurityEvent.ts`:

```ts
import mongoose, { Document, Schema, Types } from 'mongoose';

export type SecurityEventType = 'setup-unknown-community' | 'setup-token-mismatch' | 'admin-generated-reset-link';

/** Audit trail for security-sensitive actions worth a human review trail: suspicious
 *  `/community-bot/verify-setup` attempts, and now admin-initiated password-reset links (see
 *  routes/admin.ts). Deliberately never stores a raw secret/token. Discord-bot fields
 *  (guildId/discordUserId/attemptedName) are optional since the admin-reset event type doesn't
 *  have a Discord guild/user context — it has an admin + a target username instead. */
export interface ISecurityEvent extends Document {
  type: SecurityEventType;
  communityId?: Types.ObjectId;
  guildId?: string;
  discordUserId?: string;
  attemptedName?: string;
  /** Set only for type: 'admin-generated-reset-link' — the admin who triggered it. */
  adminUsername?: string;
  /** Set only for type: 'admin-generated-reset-link' — the account the link was sent for. */
  targetUsername?: string;
  createdAt: Date;
}

const SecurityEventSchema = new Schema<ISecurityEvent>(
  {
    type: { type: String, enum: ['setup-unknown-community', 'setup-token-mismatch', 'admin-generated-reset-link'], required: true },
    communityId: { type: Schema.Types.ObjectId, ref: 'Community' },
    guildId: { type: String },
    discordUserId: { type: String },
    attemptedName: { type: String },
    adminUsername: { type: String },
    targetUsername: { type: String },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } },
);

export const SecurityEvent = mongoose.model<ISecurityEvent>('SecurityEvent', SecurityEventSchema);
```

- [ ] **Step 4: Implement the route**

Add to the imports at the top of `splash-helper-backend/src/routes/admin.ts`:

```ts
import { PasswordResetToken } from '../models/PasswordResetToken';
import { generateToken } from '../utils/secureToken';
import { sendPasswordResetEmail } from '../services/email';
```

Add this constant near the top of the file, alongside `const ADMIN_SECRET = ...`:

```ts
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5173';
const PASSWORD_RESET_EXPIRY_MS = 30 * 60 * 1000;
```

Add this route, placed after the existing `GET /security-events` block:

```ts
/**
 * POST /api/admin/users/:username/send-reset-link
 * Emails a password-reset link directly to the target user's verified email — the admin never
 * sees or handles the raw link. Only works when the user has a verified email; there is
 * deliberately no fallback for one who doesn't. No third party, including an admin, should ever
 * hold a usable reset secret for someone else's account.
 */
router.post('/users/:username/send-reset-link', async (req: Request, res: Response): Promise<void> => {
  const { username } = req.params;

  const user = await User.findOne({ username });
  if (!user) {
    res.status(404).json({ error: `User "${username}" not found` });
    return;
  }

  if (!user.email || !user.emailVerifiedAt) {
    res.status(400).json({ error: 'User has no verified email to send a reset link to' });
    return;
  }

  await PasswordResetToken.deleteMany({ userId: user._id });
  const { raw, hash } = generateToken();
  await PasswordResetToken.create({
    userId: user._id,
    tokenHash: hash,
    expiresAt: new Date(Date.now() + PASSWORD_RESET_EXPIRY_MS),
    requestedByAdmin: true,
  });

  await sendPasswordResetEmail(user.email, `${FRONTEND_URL}/reset-password?token=${raw}`);

  await SecurityEvent.create({
    type: 'admin-generated-reset-link',
    adminUsername: req.user!.sub,
    targetUsername: user.username,
  });

  res.json({ message: `Reset link sent to ${user.username}'s verified email.` });
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- routes/admin.test.ts`
Expected: PASS (whole file)

- [ ] **Step 6: Run the full backend suite**

Run: `npm test`
Expected: PASS — this is the last backend task; the whole suite (all files from Tasks 1-9) should be green.

- [ ] **Step 7: Commit**

```bash
git add src/models/SecurityEvent.ts src/routes/admin.ts src/__tests__/routes/admin.test.ts
git commit -m "feat(auth): add admin-triggered password-reset email"
```

---

## Task 10: Frontend types + API client

**Files:**
- Modify: `splash-helper-frontend/src/types/index.ts` (`AdminUser`)
- Modify: `splash-helper-frontend/src/api/index.ts` (extend `getArchivedSessions`; add new functions — `resetPassword` stays for now, removed in Task 12 once its last caller is rewritten)

**Interfaces:**
- Produces: `requestPasswordReset(email)`, `confirmPasswordReset(resetToken, newPassword)`, `verifyEmailToken(verifyToken)`, `updateAccountEmail(email, currentPassword, token)`, `resendVerificationEmail(token)`, `adminSendResetLink(username, token)` — consumed by Tasks 12, 13, 14, 15, 16.

- [ ] **Step 1: Modify `AdminUser`**

In `splash-helper-frontend/src/types/index.ts`, replace the `AdminUser` interface:

```ts
export interface AdminUser {
  _id: string;
  username: string;
  token: string;
  isAdmin: boolean;
  setupLinkUsed: boolean;
  communityEligible: boolean;
  createdAt: string;
  email?: string;
  emailVerifiedAt?: string;
}
```

- [ ] **Step 2: Extend `getArchivedSessions` and add new API functions**

In `splash-helper-frontend/src/api/index.ts`, replace the `getArchivedSessions` function:

```ts
export async function getArchivedSessions(
  username: string,
  token: string,
): Promise<{ username: string; sessions: ArchivedSession[]; token?: string; email?: string; emailVerifiedAt?: string } & SplasherWebhooks> {
  const res = await fetch(`${BASE}/splashers/${encodeURIComponent(username)}`, {
    headers: authHeaders(token),
  });
  const data = (await res.json()) as {
    username?: string;
    sessions?: ArchivedSession[];
    discordActiveWebhookUrl?: string;
    discordHistoryWebhookUrl?: string;
    token?: string;
    email?: string;
    emailVerifiedAt?: string;
    error?: string;
  };
  if (!res.ok) throw new Error(data.error ?? `Failed to fetch sessions for "${username}"`);
  return data as { username: string; sessions: ArchivedSession[]; token?: string; email?: string; emailVerifiedAt?: string } & SplasherWebhooks;
}
```

Add these functions directly below the existing `setupAccount` function (i.e. before the still-present `resetPassword`, which Task 12 removes):

```ts
export async function requestPasswordReset(email: string): Promise<{ message: string }> {
  const res = await fetch(`${BASE}/auth/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const data = (await res.json()) as { message?: string; error?: string };
  if (!res.ok) throw new Error(data.error ?? 'Request failed');
  return { message: data.message ?? '' };
}

export async function confirmPasswordReset(
  resetToken: string,
  newPassword: string,
): Promise<{ token: string; username: string; message: string; isAdmin: boolean; communityEligible: boolean }> {
  const res = await fetch(`${BASE}/auth/reset-password/${encodeURIComponent(resetToken)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newPassword }),
  });
  const data = (await res.json()) as {
    token?: string;
    username?: string;
    message?: string;
    isAdmin?: boolean;
    communityEligible?: boolean;
    error?: string;
  };
  if (!res.ok) throw new Error(data.error ?? 'Password reset failed');
  return {
    token: data.token!,
    username: data.username!,
    message: data.message!,
    isAdmin: data.isAdmin ?? false,
    communityEligible: data.communityEligible ?? false,
  };
}

export async function verifyEmailToken(verifyToken: string): Promise<{ message: string }> {
  const res = await fetch(`${BASE}/auth/verify-email/${encodeURIComponent(verifyToken)}`);
  const data = (await res.json()) as { message?: string; error?: string };
  if (!res.ok) throw new Error(data.error ?? 'Verification failed');
  return { message: data.message ?? '' };
}

export async function updateAccountEmail(
  email: string,
  currentPassword: string,
  token: string,
): Promise<{ email: string; emailVerifiedAt: string | null; message: string }> {
  const res = await fetch(`${BASE}/auth/email`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, currentPassword }),
  });
  const data = (await res.json()) as { email?: string; emailVerifiedAt?: string | null; message?: string; error?: string };
  if (!res.ok) throw new Error(data.error ?? 'Failed to update email');
  return { email: data.email!, emailVerifiedAt: data.emailVerifiedAt ?? null, message: data.message ?? '' };
}

export async function resendVerificationEmail(token: string): Promise<{ message: string }> {
  const res = await fetch(`${BASE}/auth/resend-verification`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  const data = (await res.json()) as { message?: string; error?: string };
  if (!res.ok) throw new Error(data.error ?? 'Failed to resend verification email');
  return { message: data.message ?? '' };
}
```

Add this function in the `// ─── Admin ───` section, directly below `adminSetCommunityEligibility`:

```ts
export async function adminSendResetLink(username: string, token: string): Promise<{ message: string }> {
  const res = await fetch(`${BASE}/admin/users/${encodeURIComponent(username)}/send-reset-link`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  const data = (await res.json()) as { message?: string; error?: string };
  if (!res.ok) throw new Error(data.error ?? 'Failed to send reset link');
  return { message: data.message ?? '' };
}
```

- [ ] **Step 3: Verify the build**

Run: `npm run build` (from `splash-helper-frontend/`)
Expected: exits 0 — this task is purely additive (the old `resetPassword` function and its only caller, `ForgotPasswordView`, are both still present and unchanged).

- [ ] **Step 4: Commit**

```bash
git add src/types/index.ts src/api/index.ts
git commit -m "feat(auth): add frontend API client functions for email password reset"
```

---

## Task 11: `logSystemEvent` returns the posted message

**Files:**
- Modify: `splash-helper-frontend/src/utils/systemLog.ts`

**Interfaces:**
- Produces: `logSystemEvent(text: string): ChatMessage` (was `void`) — consumed by Task 17's `useEmailReminder`.

- [ ] **Step 1: Modify the function**

Replace the contents of `splash-helper-frontend/src/utils/systemLog.ts`:

```ts
import type { ChatMessage } from '../types/chatbox';
import { PRIVATE_KEY, appendStoredMessage, publishStoredMessage } from './chatStorage';

let seq = 0;

/** Appends one line to the Private tab's local action log — "should only be shown to the player
 *  and run locally in the frontend" (point 7.5). Call this from any frontend action worth
 *  surfacing there (account settings changes, community creation, chat-config saves, ...).
 *  Callers are expected to only invoke this from code paths already behind a logged-in check —
 *  there's no separate auth gate here since the log is purely local either way.
 *  Returns the message that was posted, for callers that need to react to it (e.g.
 *  useEmailReminder spotlighting its own reminder — see Chatbox.tsx). Most callers ignore it. */
export function logSystemEvent(text: string): ChatMessage {
  const message: ChatMessage = {
    id: `system-${Date.now()}-${seq++}`,
    timestamp: Date.now(),
    kind: 'private',
    message: text,
    icon: '/assets/chatbox/icons/info/info.png',
    prefix: { text: 'System' },
  };
  appendStoredMessage(PRIVATE_KEY, message);
  publishStoredMessage(PRIVATE_KEY, message);
  return message;
}
```

- [ ] **Step 2: Verify the build**

Run: `npm run build`
Expected: exits 0 — every existing call site (`AccountSettingsView.tsx`, `useAccountActivityEvents.ts`) discards the return value, which TypeScript allows without complaint.

- [ ] **Step 3: Commit**

```bash
git add src/utils/systemLog.ts
git commit -m "refactor(chatbox): logSystemEvent returns the posted ChatMessage"
```

---

## Task 12: Rewrite `ForgotPasswordView` for the email flow

**Files:**
- Modify: `splash-helper-frontend/src/views/ForgotPasswordView.tsx` (full rewrite)
- Modify: `splash-helper-frontend/src/api/index.ts` (remove the now-dead `resetPassword` function)

**Interfaces:**
- Consumes: `requestPasswordReset` (Task 10).

- [ ] **Step 1: Rewrite the view**

Replace the entire contents of `splash-helper-frontend/src/views/ForgotPasswordView.tsx`:

```tsx
import { useState } from 'react';
import { requestPasswordReset } from '../api';
import { colors, fontSerif, shadow } from '../theme';

const s = {
  wrapper: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: colors.bg },
  card: { background: colors.panel, border: `1px solid ${colors.border}`, borderRadius: 10, padding: '2rem', width: '100%', maxWidth: 400, boxShadow: shadow },
  heading: { fontFamily: fontSerif, fontSize: '1.4rem', fontWeight: 700, marginBottom: '0.5rem', color: colors.text },
  subheading: { fontSize: '0.875rem', color: colors.textFaint, marginBottom: '1.5rem', lineHeight: 1.5 },
  label: { display: 'block', fontWeight: 600, fontSize: '0.875rem', marginBottom: '0.35rem', color: colors.textMuted },
  input: {
    width: '100%', padding: '0.55rem 0.75rem', background: colors.inputBg, border: `1px solid ${colors.inputBorder}`,
    borderRadius: 6, color: colors.text, fontSize: '0.9rem', outline: 'none', boxSizing: 'border-box' as const, marginBottom: '1rem',
  },
  submitBtn: { width: '100%', padding: '0.65rem', background: colors.accent, color: '#fff', border: 'none', borderRadius: 6, fontWeight: 700, fontSize: '0.95rem', cursor: 'pointer' },
  submitBtnDisabled: { background: colors.borderStrong, color: colors.textDisabled, cursor: 'not-allowed' },
  backBtn: { width: '100%', marginTop: '0.75rem', background: 'none', border: 'none', color: colors.link, fontWeight: 600, fontSize: '0.85rem', cursor: 'pointer', padding: '0.4rem' },
  errorBox: { marginBottom: '1rem', padding: '0.65rem 0.85rem', background: colors.dangerSoft, border: `1px solid ${colors.danger}`, borderRadius: 6, color: colors.dangerText, fontSize: '0.875rem' },
  successBox: { marginBottom: '1rem', padding: '0.65rem 0.85rem', background: colors.successSoft, border: `1px solid ${colors.success}`, borderRadius: 6, color: colors.successText, fontSize: '0.875rem' },
} as const;

interface Props {
  onBack?: () => void;
}

export default function ForgotPasswordView({ onBack }: Props) {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  const canSubmit = email.trim().length > 0 && !loading;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setLoading(true);
    try {
      await requestPasswordReset(email.trim());
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={s.wrapper}>
      <div style={s.card}>
        <h1 style={s.heading}>Reset your password</h1>
        <p style={s.subheading}>
          Enter the email address on your account and, if it's registered and verified, we'll
          send you a link to reset your password.
        </p>
        {error && <div style={s.errorBox}>{error}</div>}
        {done ? (
          <div style={s.successBox}>
            If that address is registered, a reset link has been sent. Check your inbox.
          </div>
        ) : (
          <form onSubmit={handleSubmit} noValidate>
            <label style={s.label} htmlFor="forgot-email">Email</label>
            <input
              id="forgot-email"
              style={s.input}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <button type="submit" style={{ ...s.submitBtn, ...(!canSubmit ? s.submitBtnDisabled : {}) }} disabled={!canSubmit}>
              {loading ? 'Sending…' : 'Send reset link'}
            </button>
          </form>
        )}
        {onBack && (
          <button type="button" style={s.backBtn} onClick={onBack}>
            ← Back to sign in
          </button>
        )}
      </div>
    </div>
  );
}
```

Note: the `onSuccess` prop `App.tsx` passes to this view is no longer part of `Props` — this view no longer completes a reset itself (that's `ResetPasswordView`'s job, Task 13), it only requests one. TypeScript allows a caller to pass an extra prop a component's `Props` type doesn't declare only if that prop is optional-compatible; to keep `App.tsx` (Task 13) compiling either way, `Props` intentionally omits `onSuccess` here — Task 13 removes the now-meaningless `onSuccess={...}` from `App.tsx`'s `<ForgotPasswordView>` call as part of its own edit.

- [ ] **Step 2: Remove the dead `resetPassword` function**

In `splash-helper-frontend/src/api/index.ts`, delete the `resetPassword` function (originally lines 72-98) — `ForgotPasswordView` no longer calls it, and nothing else does either.

- [ ] **Step 3: Verify the build**

Run: `npm run build`
Expected: FAILS at this point — `App.tsx` still passes `onSuccess={...}` to `<ForgotPasswordView>`, which no longer accepts it, and `App.tsx` doesn't yet import `ResetPasswordView`/wire `/reset-password`. This is expected; Task 13 fixes both. If your workflow strictly requires a green build per task, merge Task 13's `App.tsx` edit into this task instead of leaving it dangling — see the note in Task 13.

- [ ] **Step 4: Commit**

```bash
git add src/views/ForgotPasswordView.tsx src/api/index.ts
git commit -m "feat(auth): rewrite ForgotPasswordView for the email flow"
```

---

## Task 13: `ResetPasswordView` + `App.tsx` wiring

**Files:**
- Create: `splash-helper-frontend/src/views/ResetPasswordView.tsx`
- Modify: `splash-helper-frontend/src/App.tsx`

**Interfaces:**
- Consumes: `confirmPasswordReset` (Task 10), `useAuth().setFromToken` (existing).

This task also fixes the build break Task 12 intentionally left behind (App.tsx no longer passing a stale `onSuccess` to `ForgotPasswordView`), so build-green is restored here.

- [ ] **Step 1: Create the view**

Create `splash-helper-frontend/src/views/ResetPasswordView.tsx`:

```tsx
import { useState } from 'react';
import { confirmPasswordReset } from '../api';
import { useAuth } from '../context/AuthContext';
import { colors, fontSerif, shadow } from '../theme';

const s = {
  wrapper: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: colors.bg },
  card: { background: colors.panel, border: `1px solid ${colors.border}`, borderRadius: 10, padding: '2rem', width: '100%', maxWidth: 380, boxShadow: shadow },
  heading: { fontFamily: fontSerif, fontSize: '1.4rem', fontWeight: 700, marginBottom: '1.5rem', color: colors.text },
  label: { display: 'block', fontWeight: 600, fontSize: '0.875rem', marginBottom: '0.35rem', color: colors.textMuted },
  input: {
    width: '100%', padding: '0.55rem 0.75rem', background: colors.inputBg, border: `1px solid ${colors.inputBorder}`,
    borderRadius: 6, color: colors.text, fontSize: '0.9rem', outline: 'none', boxSizing: 'border-box' as const, marginBottom: '1rem',
  },
  submitBtn: { width: '100%', padding: '0.65rem', background: colors.accent, color: '#fff', border: 'none', borderRadius: 6, fontWeight: 700, fontSize: '0.95rem', cursor: 'pointer' },
  submitBtnDisabled: { background: colors.borderStrong, color: colors.textDisabled, cursor: 'not-allowed' },
  errorBox: { marginBottom: '1rem', padding: '0.65rem 0.85rem', background: colors.dangerSoft, border: `1px solid ${colors.danger}`, borderRadius: 6, color: colors.dangerText, fontSize: '0.875rem' },
  successBox: { marginBottom: '1rem', padding: '0.65rem 0.85rem', background: colors.successSoft, border: `1px solid ${colors.success}`, borderRadius: 6, color: colors.successText, fontSize: '0.875rem' },
  hint: { fontSize: '0.78rem', color: colors.textFaint, marginTop: '-0.6rem', marginBottom: '1rem' },
} as const;

interface Props {
  resetToken: string;
  onSuccess?: () => void;
}

export default function ResetPasswordView({ resetToken, onSuccess }: Props) {
  const { setFromToken } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  const passwordsMatch = password === confirm;
  const canSubmit = password.length >= 8 && passwordsMatch && !loading;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setLoading(true);
    try {
      const result = await confirmPasswordReset(resetToken, password);
      setFromToken(result.token, result.username, result.isAdmin, result.communityEligible);
      setDone(true);
      setTimeout(() => onSuccess?.(), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Password reset failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={s.wrapper}>
      <div style={s.card}>
        <h1 style={s.heading}>Set a new password</h1>
        {error && <div style={s.errorBox}>{error}</div>}
        {done && <div style={s.successBox}>Password reset! Redirecting…</div>}
        {!done && (
          <form onSubmit={handleSubmit} noValidate>
            <label style={s.label} htmlFor="reset-password">New password</label>
            <input
              id="reset-password"
              style={s.input}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
            />
            <p style={s.hint}>Minimum 8 characters</p>
            <label style={s.label} htmlFor="reset-confirm">Confirm new password</label>
            <input
              id="reset-confirm"
              style={{ ...s.input, borderColor: confirm && !passwordsMatch ? colors.danger : colors.inputBorder }}
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
            {confirm && !passwordsMatch && (
              <p style={{ ...s.hint, color: colors.dangerText, marginTop: '-0.6rem' }}>Passwords do not match</p>
            )}
            <button type="submit" style={{ ...s.submitBtn, ...(!canSubmit ? s.submitBtnDisabled : {}) }} disabled={!canSubmit}>
              {loading ? 'Resetting…' : 'Reset password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire it into `App.tsx`**

In `splash-helper-frontend/src/App.tsx`, add the import alongside the others:

```tsx
import ResetPasswordView from './views/ResetPasswordView';
```

Add a new state + effect, directly below the existing `setupToken` block:

```tsx
  // Handle password-reset link: /reset-password?token=...
  const [resetToken, setResetToken] = useState<string | null>(null);
  useEffect(() => {
    if (window.location.pathname === '/reset-password') {
      const params = new URLSearchParams(window.location.search);
      const token = params.get('token');
      if (token) setResetToken(token);
    }
  }, []);
```

Update the `handlePopState` exemption so browser Back/Forward doesn't yank the user out of this token page either:

```tsx
  useEffect(() => {
    function handlePopState() {
      if (window.location.pathname === '/setup' || window.location.pathname === '/reset-password') return;
      setView(pathToView(window.location.pathname));
    }
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);
```

Add the render branch directly below the existing `if (setupToken) { ... }` block, before `if (view.name === 'login')`:

```tsx
  if (resetToken) {
    return (
      <ResetPasswordView
        resetToken={resetToken}
        onSuccess={() => {
          setResetToken(null);
          navigate({ name: 'active' });
        }}
      />
    );
  }
```

Finally, remove the now-invalid `onSuccess={() => navigate({ name: 'active' })}` prop from the existing `<ForgotPasswordView>` call (its `Props` no longer declares `onSuccess`, per Task 12):

```tsx
  if (view.name === 'forgot-password') {
    return (
      <ForgotPasswordView onBack={() => navigate({ name: 'login' })} />
    );
  }
```

- [ ] **Step 3: Verify the build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add src/views/ResetPasswordView.tsx src/App.tsx
git commit -m "feat(auth): add ResetPasswordView and wire /reset-password"
```

---

## Task 14: `VerifyEmailView` + `App.tsx` wiring

**Files:**
- Create: `splash-helper-frontend/src/views/VerifyEmailView.tsx`
- Modify: `splash-helper-frontend/src/App.tsx`

**Interfaces:**
- Consumes: `verifyEmailToken` (Task 10).

- [ ] **Step 1: Create the view**

Create `splash-helper-frontend/src/views/VerifyEmailView.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { verifyEmailToken } from '../api';
import { colors, fontSerif, shadow } from '../theme';

const s = {
  wrapper: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: colors.bg },
  card: { background: colors.panel, border: `1px solid ${colors.border}`, borderRadius: 10, padding: '2rem', width: '100%', maxWidth: 380, boxShadow: shadow, textAlign: 'center' as const },
  heading: { fontFamily: fontSerif, fontSize: '1.4rem', fontWeight: 700, marginBottom: '1rem', color: colors.text },
  errorBox: { padding: '0.65rem 0.85rem', background: colors.dangerSoft, border: `1px solid ${colors.danger}`, borderRadius: 6, color: colors.dangerText, fontSize: '0.875rem' },
  successBox: { padding: '0.65rem 0.85rem', background: colors.successSoft, border: `1px solid ${colors.success}`, borderRadius: 6, color: colors.successText, fontSize: '0.875rem' },
  link: { display: 'inline-block', marginTop: '1rem', background: 'none', border: 'none', color: colors.link, fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer', padding: 0 },
} as const;

interface Props {
  verifyToken: string;
  onDone: () => void;
}

export default function VerifyEmailView({ verifyToken, onDone }: Props) {
  const [status, setStatus] = useState<'pending' | 'success' | 'error'>('pending');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    verifyEmailToken(verifyToken)
      .then((result) => {
        if (cancelled) return;
        setStatus('success');
        setMessage(result.message);
      })
      .catch((err) => {
        if (cancelled) return;
        setStatus('error');
        setMessage(err instanceof Error ? err.message : 'Verification failed');
      });
    return () => {
      cancelled = true;
    };
  }, [verifyToken]);

  return (
    <div style={s.wrapper}>
      <div style={s.card}>
        <h1 style={s.heading}>Verify your email</h1>
        {status === 'pending' && <p>Verifying…</p>}
        {status === 'success' && <div style={s.successBox}>{message}</div>}
        {status === 'error' && <div style={s.errorBox}>{message}</div>}
        <button type="button" style={s.link} onClick={onDone}>← Back to Splash Helper</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire it into `App.tsx`**

Add the import:

```tsx
import VerifyEmailView from './views/VerifyEmailView';
```

Add state + effect, directly below the `resetToken` block added in Task 13:

```tsx
  // Handle email-verification link: /verify-email?token=...
  const [verifyEmailTokenValue, setVerifyEmailTokenValue] = useState<string | null>(null);
  useEffect(() => {
    if (window.location.pathname === '/verify-email') {
      const params = new URLSearchParams(window.location.search);
      const token = params.get('token');
      if (token) setVerifyEmailTokenValue(token);
    }
  }, []);
```

Extend the `handlePopState` exemption once more:

```tsx
      if (window.location.pathname === '/setup' || window.location.pathname === '/reset-password' || window.location.pathname === '/verify-email') return;
```

Add the render branch, directly below Task 13's `if (resetToken) { ... }` block:

```tsx
  if (verifyEmailTokenValue) {
    return (
      <VerifyEmailView
        verifyToken={verifyEmailTokenValue}
        onDone={() => {
          setVerifyEmailTokenValue(null);
          navigate({ name: user ? 'settings' : 'login' });
        }}
      />
    );
  }
```

- [ ] **Step 3: Verify the build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add src/views/VerifyEmailView.tsx src/App.tsx
git commit -m "feat(auth): add VerifyEmailView and wire /verify-email"
```

---

## Task 15: `EmailField` component + `AccountSettingsView` integration

**Files:**
- Create: `splash-helper-frontend/src/components/EmailField.tsx`
- Modify: `splash-helper-frontend/src/views/AccountSettingsView.tsx`

**Interfaces:**
- Consumes: `updateAccountEmail`, `resendVerificationEmail` (Task 10); `logSystemEvent` (Task 11, return value unused here).

- [ ] **Step 1: Create the component**

Create `splash-helper-frontend/src/components/EmailField.tsx`:

```tsx
import { useState } from 'react';
import { colors } from '../theme';

const s = {
  wrap: { display: 'flex', flexDirection: 'column' as const, gap: '0.6rem' },
  fieldLabel: { display: 'block', fontSize: '0.8rem', fontWeight: 600, color: colors.textMuted, marginBottom: '0.35rem' },
  badge: (verified: boolean) => ({
    display: 'inline-block',
    padding: '0.1rem 0.5rem',
    borderRadius: 4,
    fontSize: '0.72rem',
    fontWeight: 600,
    background: verified ? colors.successSoft : colors.warningSoft,
    color: verified ? colors.successText : colors.warningText,
    marginLeft: '0.5rem',
  }),
  row: { display: 'flex', gap: '0.5rem', flexWrap: 'wrap' as const },
  input: { padding: '0.5rem 0.7rem', background: colors.inputBg, border: `1px solid ${colors.inputBorder}`, borderRadius: 6, color: colors.text, fontSize: '0.875rem', flex: 1, minWidth: 160, outline: 'none' },
  btnSecondary: { padding: '0.5rem 0.9rem', background: colors.accentSoft, border: `1px solid ${colors.accent}`, borderRadius: 6, color: colors.accentText, cursor: 'pointer', fontSize: '0.85rem', fontWeight: 600, whiteSpace: 'nowrap' as const },
  btnSecondaryDisabled: { cursor: 'not-allowed', opacity: 0.6 },
  errorText: { color: colors.dangerText, fontSize: '0.78rem', marginTop: '0.3rem' },
  successText: { color: colors.successText, fontSize: '0.78rem', marginTop: '0.3rem' },
} as const;

interface Props {
  email?: string;
  emailVerifiedAt?: string;
  onSave: (email: string, currentPassword: string) => Promise<void>;
  onResendVerification: () => Promise<void>;
}

/** Add/change the account's recovery email (requires the current password as a second factor),
 *  and while unverified, resend the verification link. */
export default function EmailField({ email, emailVerifiedAt, onSave, onResendVerification }: Props) {
  const [value, setValue] = useState(email ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [resending, setResending] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'error' | 'success'; message: string } | null>(null);

  const verified = !!emailVerifiedAt;

  function flash(type: 'error' | 'success', message: string) {
    setFeedback({ type, message });
    setTimeout(() => setFeedback(null), 3000);
  }

  async function handleSave() {
    if (!value.trim() || !currentPassword) return;
    setSaving(true);
    try {
      await onSave(value.trim(), currentPassword);
      setCurrentPassword('');
      flash('success', 'Verification email sent — check your inbox.');
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  async function handleResend() {
    setResending(true);
    try {
      await onResendVerification();
      flash('success', 'Verification email sent.');
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Failed to resend');
    } finally {
      setResending(false);
    }
  }

  return (
    <div style={s.wrap}>
      <div>
        <label style={s.fieldLabel}>
          Email
          {email && <span style={s.badge(verified)}>{verified ? 'Verified' : 'Unverified'}</span>}
        </label>
        <div style={s.row}>
          <input
            style={s.input}
            type="email"
            placeholder="you@example.com"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={saving}
          />
          <input
            style={s.input}
            type="password"
            placeholder="Current password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            disabled={saving}
          />
          <button
            style={{ ...s.btnSecondary, ...(saving || !value.trim() || !currentPassword ? s.btnSecondaryDisabled : {}) }}
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || !value.trim() || !currentPassword}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
        {email && !verified && (
          <button
            style={{ ...s.btnSecondary, marginTop: '0.5rem', ...(resending ? s.btnSecondaryDisabled : {}) }}
            type="button"
            onClick={() => void handleResend()}
            disabled={resending}
          >
            {resending ? 'Resending…' : 'Resend verification email'}
          </button>
        )}
      </div>
      {feedback && <div style={feedback.type === 'error' ? s.errorText : s.successText}>{feedback.message}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Integrate into `AccountSettingsView`**

In `splash-helper-frontend/src/views/AccountSettingsView.tsx`, update the imports:

```tsx
import { getArchivedSessions, setSplasherWebhook, uploadJson, updateAccountEmail, resendVerificationEmail } from '../api';
import EmailField from '../components/EmailField';
```

Add state below the existing `const [webhooks, setWebhooks] = useState<SplasherWebhooks>({});`:

```tsx
  const [email, setEmail] = useState<string | undefined>(undefined);
  const [emailVerifiedAt, setEmailVerifiedAt] = useState<string | undefined>(undefined);
```

In the `useEffect`'s `.then((data) => { ... })` callback, add two lines alongside the existing `setPluginToken`/`setWebhooks` calls:

```tsx
        setEmail(data.email);
        setEmailVerifiedAt(data.emailVerifiedAt);
```

Add two new handlers, near `saveActiveWebhook`/`saveHistoryWebhook`:

```tsx
  async function handleSaveEmail(newEmail: string, currentPassword: string) {
    if (!token) return;
    const result = await updateAccountEmail(newEmail, currentPassword, token);
    setEmail(result.email);
    setEmailVerifiedAt(result.emailVerifiedAt ?? undefined);
    logSystemEvent('Updated account email');
  }

  async function handleResendVerification() {
    if (!token) return;
    await resendVerificationEmail(token);
  }
```

Add a new card in the JSX, directly after the "Your plugin token" card and before "Discord webhooks":

```tsx
          <div style={s.card}>
            <div style={s.cardTitle}>Account recovery</div>
            <EmailField
              email={email}
              emailVerifiedAt={emailVerifiedAt}
              onSave={handleSaveEmail}
              onResendVerification={handleResendVerification}
            />
            <p style={s.fieldHint}>
              Used to reset your password if you're ever locked out. Requires your current
              password to add or change.
            </p>
          </div>
```

- [ ] **Step 3: Verify the build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add src/components/EmailField.tsx src/views/AccountSettingsView.tsx
git commit -m "feat(auth): add account-recovery email field to settings"
```

---

## Task 16: Admin panel — email column + "Send reset link"

**Files:**
- Modify: `splash-helper-frontend/src/views/AdminView.tsx`

**Interfaces:**
- Consumes: `adminSendResetLink` (Task 10), `AdminUser.email`/`emailVerifiedAt` (Task 10).

- [ ] **Step 1: Wire the action**

In `splash-helper-frontend/src/views/AdminView.tsx`, add `adminSendResetLink` to the existing import from `'../api'`:

```tsx
import {
  adminGetUsers, adminGetSessions, adminPromoteUser, adminDeleteUser, adminDeleteSession,
  adminSetCommunityEligibility, adminGetCommunities, adminDeleteCommunity,
  adminAssignUsersToCommunity, adminRemoveUserFromCommunity, getCommunitySplashers,
  adminSendResetLink,
} from '../api';
```

Add a handler, near `handleToggleCommunityEligibility`:

```tsx
  async function handleSendResetLink(username: string) {
    if (!token) return;
    try {
      const result = await adminSendResetLink(username, token);
      showFeedback('success', result.message);
    } catch (err) {
      showFeedback('error', err instanceof Error ? err.message : 'Failed to send reset link');
    }
  }
```

Update `userActions` to add the new menu item, before the `Delete` entry:

```tsx
  function userActions(u: AdminUser): MenuItem[] {
    return [
      { label: u.isAdmin ? 'Demote' : 'Promote', onClick: () => handlePromote(u.username) },
      {
        label: u.communityEligible ? 'Revoke community' : 'Allow community',
        onClick: () => void handleToggleCommunityEligibility(u.username),
      },
      {
        label: 'Send reset link',
        onClick: () => void handleSendResetLink(u.username),
        disabled: !u.emailVerifiedAt,
        title: u.emailVerifiedAt ? undefined : 'User has no verified email',
      },
      { label: 'Delete', danger: true, onClick: () => void handleDeleteUser(u.username) },
    ];
  }
```

- [ ] **Step 2: Add the Email column to the users table**

Add a header cell after `<th style={s.th}>Token</th>`:

```tsx
                  <th style={s.th}>Email</th>
```

Add a body cell after the existing token `<td>` block (the one containing `s.tokenCell`), inside the same `<tr>`:

```tsx
                    <td style={s.td}>
                      {u.emailVerifiedAt ? (
                        <span style={s.badge(true)}>Verified</span>
                      ) : u.email ? (
                        <span style={s.badge(false)}>Unverified</span>
                      ) : (
                        <span style={{ color: colors.textFaint }}>—</span>
                      )}
                    </td>
```

- [ ] **Step 3: Verify the build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add src/views/AdminView.tsx
git commit -m "feat(auth): add email status and send-reset-link to admin panel"
```

---

## Task 17: `useEmailReminder` hook

**Files:**
- Create: `splash-helper-frontend/src/hooks/useEmailReminder.ts`

**Interfaces:**
- Consumes: `getArchivedSessions` (existing, extended in Task 8/10), `logSystemEvent` (Task 11).
- Produces: `useEmailReminder(): ChatMessage | null` — consumed by Task 18's `Chatbox.tsx`.

- [ ] **Step 1: Create the hook**

Create `splash-helper-frontend/src/hooks/useEmailReminder.ts`:

```ts
import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../types/chatbox';
import { useAuth } from '../context/AuthContext';
import { getArchivedSessions } from '../api';
import { logSystemEvent } from '../utils/systemLog';

/** Checks once per mount whether the logged-in user has a verified email on file, and if not,
 *  posts a one-shot reminder into the Private tab (see logSystemEvent) — either "add an email"
 *  or "verify the one you added", depending on state. Returns the message that fired (once, the
 *  first time it fires this mount) so Chatbox can react to it — switch to Private, spotlight it,
 *  flash the window (see Chatbox.tsx). A no-op while logged out, already verified, or if the
 *  check itself fails (a failed fetch just skips the reminder for this visit). */
export function useEmailReminder(): ChatMessage | null {
  const { user, token } = useAuth();
  const [reminder, setReminder] = useState<ChatMessage | null>(null);
  const firedRef = useRef(false);

  useEffect(() => {
    if (!user || !token || firedRef.current) return;
    let cancelled = false;

    getArchivedSessions(user.username, token)
      .then((data) => {
        if (cancelled || firedRef.current || data.emailVerifiedAt) return;
        firedRef.current = true;
        const text = data.email
          ? "Your email isn't verified yet — check your inbox to finish setup."
          : 'Add an email to your account for recovery access.';
        setReminder(logSystemEvent(text));
      })
      .catch(() => {
        // Transient fetch failure — just skip the reminder for this visit.
      });

    return () => {
      cancelled = true;
    };
  }, [user, token]);

  return reminder;
}
```

- [ ] **Step 2: Verify the build**

Run: `npm run build`
Expected: exits 0 — the hook isn't imported anywhere yet, so this is purely additive.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useEmailReminder.ts
git commit -m "feat(chatbox): add useEmailReminder hook"
```

---

## Task 18: Wire the reminder into `Chatbox` — spotlight + flash

**Files:**
- Modify: `splash-helper-frontend/src/components/chatbox/Chatbox.tsx`
- Modify: `splash-helper-frontend/src/components/chatbox/Chatbox.css`

**Interfaces:**
- Consumes: `useEmailReminder` (Task 17).

- [ ] **Step 1: Modify `Chatbox.tsx`**

Update the React import at the top to include `useEffect`:

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
```

Add the new hook import, alongside the other hook imports:

```tsx
import { useEmailReminder } from '../../hooks/useEmailReminder';
```

Inside the `Chatbox` component, directly below `const { timestamps: showTimestamps } = useChatSettings();`, add:

```tsx
  const emailReminder = useEmailReminder();
  const [spotlightMessageId, setSpotlightMessageId] = useState<string | null>(null);
  const [alertFlash, setAlertFlash] = useState(false);

  // A missing/unverified email fires this once per visit — jump to Private, show only the
  // reminder (not the whole log), and briefly flash the window to draw the eye. Picking any tab
  // manually (handleSelect) clears the spotlight, so All -> Private afterward shows everything.
  useEffect(() => {
    if (!emailReminder) return;
    setChannel('private');
    setWindowOpen(true);
    setSpotlightMessageId(emailReminder.id);
    setAlertFlash(true);
    const timeout = setTimeout(() => setAlertFlash(false), 1500);
    return () => clearTimeout(timeout);
  }, [emailReminder]);
```

Replace the `messages` computation:

```tsx
  const messages =
    messagesOverride ??
    (spotlightMessageId && channel === 'private'
      ? mergedMessages.filter((m) => m.id === spotlightMessageId)
      : visibleMessages(mergedMessages, channel, tabStates, { channel: fcSelected, clan: ccSelected }));
```

Replace `handleSelect` to clear the spotlight on any manual tab pick:

```tsx
  function handleSelect(tab: ChatChannel) {
    setSpotlightMessageId(null);
    if (tab === channel) {
      setWindowOpen((open) => !open);
    } else {
      setChannel(tab);
      setWindowOpen(true);
    }
  }
```

Update the root `<div>`'s `className` to include the alert class while flashing:

```tsx
    <div className={`chatbox ${alertFlash ? 'chatbox--alert' : ''} ${className ?? ''}`}>
```

- [ ] **Step 2: Add the flash animation**

Append to `splash-helper-frontend/src/components/chatbox/Chatbox.css`:

```css
/* Briefly pulses the whole chatbox yellow/orange to draw attention to a just-posted reminder
   (e.g. the missing/unverified-email nudge — see useEmailReminder + Chatbox.tsx). Purely
   decorative, cleared automatically ~1.5s after it starts. */
@keyframes chatbox-alert-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(217, 119, 6, 0); }
  25%, 75% { box-shadow: 0 0 0 4px rgba(217, 119, 6, 0.55); }
}

.chatbox--alert {
  animation: chatbox-alert-pulse 1.5s ease-in-out;
}
```

- [ ] **Step 3: Verify the build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 4: Manual smoke check**

This is the one piece of frontend behavior worth eyeballing live, since it's a cross-hook interaction with no automated coverage:

1. `npm run dev` (or use the preview tooling), log in as a user with no email/unverified email.
2. Load the home page — the chatbox should jump to the Private tab, show only the reminder line, and briefly pulse orange.
3. Click "All", then click "Private" again — the full Private log (not just the reminder) should now be visible.
4. Add and verify an email via Account Settings, reload — the reminder should no longer fire.

- [ ] **Step 5: Commit**

```bash
git add src/components/chatbox/Chatbox.tsx src/components/chatbox/Chatbox.css
git commit -m "feat(chatbox): spotlight and flash the email reminder on visit"
```

---

## Post-plan checklist

- [ ] Run the full backend suite once more from a clean state: `npm test` (from `splash-helper-backend/`) — expect all green.
- [ ] Run `npm run build` and `npm run lint` from `splash-helper-frontend/` — expect both clean.
- [ ] Confirm `RESEND_API_KEY`/`EMAIL_FROM_ADDRESS` are set in the real production `.env` before deploying (without them, the app silently falls back to console-logging emails instead of sending them — fine for dev, not for prod).
- [ ] Once satisfied, follow the finishing-a-development-branch skill to decide how `feature/email-password-reset` gets merged.
