function timestamp(): string {
  return `[${new Date().toLocaleTimeString()}] -`;
}

export function log(...args: unknown[]): void {
  console.log(timestamp(), ...args);
}

export function logError(...args: unknown[]): void {
  console.error(timestamp(), ...args);
}

export function logWarn(...args: unknown[]): void {
  console.warn(timestamp(), ...args);
}
