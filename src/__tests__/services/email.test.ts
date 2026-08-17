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
