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
