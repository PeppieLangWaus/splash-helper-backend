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
