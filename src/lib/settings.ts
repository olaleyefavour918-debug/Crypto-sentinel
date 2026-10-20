import type { Settings } from "./types";

export const DEFAULT_RECIPIENT = "olaleyevictor206@gmail.com";
export const STARTING_BALANCE_USDT = 65.5;

export const DEFAULT_SETTINGS: Settings = {
  positionAmountUsdt: 10,
  buyEmailEnabled: true,
  sellEmailEnabled: true,
  emailRecipient: DEFAULT_RECIPIENT,
  stopLossPct: 2,
  takeProfitPct: 4,
  trendExitEnabled: false,
  feeRatePct: 0.1,
  emaFast: 20,
  emaSlow: 50,
  rsiPeriod: 14,
  rsiMin: 50,
  rsiMax: 65,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  atrPeriod: 14,
  entryWindowMinutes: 30,
};

type NumRule = { min: number; max: number; int?: boolean };

const NUMBER_RULES: Record<string, NumRule> = {
  positionAmountUsdt: { min: 1, max: 100000 },
  stopLossPct: { min: 0.1, max: 50 },
  takeProfitPct: { min: 0.1, max: 200 },
  feeRatePct: { min: 0, max: 2 },
  emaFast: { min: 2, max: 100, int: true },
  emaSlow: { min: 3, max: 120, int: true },
  rsiPeriod: { min: 2, max: 50, int: true },
  rsiMin: { min: 0, max: 100 },
  rsiMax: { min: 0, max: 100 },
  macdFast: { min: 2, max: 60, int: true },
  macdSlow: { min: 3, max: 120, int: true },
  macdSignal: { min: 2, max: 60, int: true },
  atrPeriod: { min: 2, max: 50, int: true },
  entryWindowMinutes: { min: 1, max: 55, int: true },
};

const BOOLEAN_KEYS = ["buyEmailEnabled", "sellEmailEnabled", "trendExitEnabled"] as const;

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

export type ValidationResult =
  | { ok: true; value: Settings }
  | { ok: false; errors: string[] };

/**
 * Validates a partial settings update and merges it over `base`.
 * Unknown keys are rejected (never silently stored). Pure function.
 */
export function validateSettings(input: unknown, base: Settings): ValidationResult {
  const errors: string[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["Body must be a JSON object."] };
  }
  const known = new Set<string>([...Object.keys(NUMBER_RULES), ...BOOLEAN_KEYS, "emailRecipient"]);
  const next: Settings = { ...base };
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!known.has(key)) {
      errors.push(`Unknown setting "${key}".`);
      continue;
    }
    if (key in NUMBER_RULES) {
      const rule = NUMBER_RULES[key];
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        errors.push(`${key} must be a number.`);
        continue;
      }
      if (raw < rule.min || raw > rule.max) {
        errors.push(`${key} must be between ${rule.min} and ${rule.max}.`);
        continue;
      }
      if (rule.int && !Number.isInteger(raw)) {
        errors.push(`${key} must be a whole number.`);
        continue;
      }
      (next as unknown as Record<string, unknown>)[key] = raw;
    } else if ((BOOLEAN_KEYS as readonly string[]).includes(key)) {
      if (typeof raw !== "boolean") {
        errors.push(`${key} must be true or false.`);
        continue;
      }
      (next as unknown as Record<string, unknown>)[key] = raw;
    } else if (key === "emailRecipient") {
      if (typeof raw !== "string" || raw.length > 254 || !EMAIL_RE.test(raw.trim())) {
        errors.push("emailRecipient must be a valid email address.");
        continue;
      }
      next.emailRecipient = raw.trim();
    }
  }
  if (errors.length === 0) {
    if (next.emaFast >= next.emaSlow) errors.push("emaFast must be smaller than emaSlow.");
    if (next.macdFast >= next.macdSlow) errors.push("macdFast must be smaller than macdSlow.");
    if (next.rsiMin >= next.rsiMax) errors.push("rsiMin must be smaller than rsiMax.");
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: next };
}

/** Merges stored (possibly older / partial) settings with defaults, ignoring invalid stored values. */
export function normalizeStoredSettings(stored: unknown): Settings {
  if (typeof stored !== "object" || stored === null) return { ...DEFAULT_SETTINGS };
  const merged = validateSettings(stored, DEFAULT_SETTINGS);
  if (merged.ok) return merged.value;
  // Fall back key-by-key so one bad value does not discard everything.
  let current = { ...DEFAULT_SETTINGS };
  for (const [k, v] of Object.entries(stored as Record<string, unknown>)) {
    const r = validateSettings({ [k]: v }, current);
    if (r.ok) current = r.value;
  }
  return current;
}
