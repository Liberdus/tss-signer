const DEFAULT_BRIDGEIN_RATE_LIMIT_PER_MIN = 120;
const MAX_BRIDGEIN_RATE_LIMIT_PER_MIN = 10_000;

export interface BridgeInRateLimitConfig {
  limit: number;
  isValid: boolean;
  raw: string | undefined;
}

export function resolveBridgeInRateLimitPerMin(rawValue: string | undefined): BridgeInRateLimitConfig {
  const raw = rawValue?.trim();
  const parsed = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  const isValid =
    Number.isFinite(parsed) &&
    parsed > 0 &&
    parsed <= MAX_BRIDGEIN_RATE_LIMIT_PER_MIN;

  return {
    limit: isValid ? parsed : DEFAULT_BRIDGEIN_RATE_LIMIT_PER_MIN,
    isValid,
    raw,
  };
}
