import { Resend } from 'resend';

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM_ADDRESS = process.env.EMAIL_FROM_ADDRESS ?? 'Splash Helper <no-reply@example.com>';

// Resend's HTTP API rejects requests missing a User-Agent header — the SDK sets one (and every
// other required header) automatically, so it's used here instead of a raw fetch call.
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

/**
 * Sends one transactional email via the Resend SDK. Mirrors generateSetupLink's fallback style
 * in routes/auth.ts: without RESEND_API_KEY configured (local dev, tests), this just logs
 * instead of failing outright, so the rest of the app works without needing real mail
 * infrastructure set up.
 */
async function sendEmail(to: string, subject: string, text: string): Promise<void> {
  if (!resend) {
    console.log(`[email:dev] to=${to} subject="${subject}"\n${text}`);
    return;
  }

  const { error } = await resend.emails.send({ from: EMAIL_FROM_ADDRESS, to, subject, text });
  if (error) {
    throw new Error(`Resend error: ${error.message}`);
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
