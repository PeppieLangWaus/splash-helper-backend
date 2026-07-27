/** Reads a required environment variable, throwing at startup instead of silently
 *  falling back to an insecure default if it's missing. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
