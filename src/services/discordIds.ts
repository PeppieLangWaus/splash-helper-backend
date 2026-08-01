const SNOWFLAKE_PATTERN = /^\d{17,20}$/;

/** Validates that a string looks like a real Discord snowflake id (channel, role, etc). */
export function isValidSnowflake(id: string): boolean {
  return SNOWFLAKE_PATTERN.test(id);
}

export type IdFieldUpdate =
  | { action: 'set'; value: string }
  | { action: 'clear' }
  | { action: 'skip' }
  | { action: 'invalid' };

/**
 * Interprets one channel/role id field of a PUT .../discord-config request body: field
 * absent leaves the current value alone ('skip'), present-but-empty clears it ('clear'), a
 * valid snowflake sets it ('set'), anything else is rejected ('invalid').
 */
export function resolveIdField(raw: unknown): IdFieldUpdate {
  if (raw === undefined) return { action: 'skip' };
  if (typeof raw !== 'string') return { action: 'invalid' };

  const trimmed = raw.trim();
  if (!trimmed) return { action: 'clear' };
  if (!isValidSnowflake(trimmed)) return { action: 'invalid' };
  return { action: 'set', value: trimmed };
}

export type IdListFieldUpdate =
  | { action: 'set'; value: string[] }
  | { action: 'skip' }
  | { action: 'invalid' };

/** Same resolution as `resolveIdField`, for a comma-separated list of role ids. An absent
 *  field is left unchanged; an empty array clears the list. */
export function resolveIdListField(raw: unknown): IdListFieldUpdate {
  if (raw === undefined) return { action: 'skip' };
  if (!Array.isArray(raw)) return { action: 'invalid' };

  const trimmed = raw.map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean);
  if (trimmed.some((id) => !isValidSnowflake(id))) return { action: 'invalid' };
  return { action: 'set', value: trimmed };
}
