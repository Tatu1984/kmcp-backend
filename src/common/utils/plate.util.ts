import { randomInt } from "node:crypto";

/**
 * Was nanoid's customAlphabet. nanoid 6 is ESM-only and this file is compiled
 * to CommonJS, which Vercel's function bundler cannot resolve — the same fault
 * that kept the whole API from booting. randomInt is drawn from the same CSPRNG
 * and is unbiased across the alphabet, which is all this was ever used for.
 */
const fromAlphabet = (alphabet: string, size: number) => (): string => {
  let out = "";
  for (let i = 0; i < size; i += 1) out += alphabet[randomInt(alphabet.length)];
  return out;
};

/** Plates are stored and compared normalised: uppercase alphanumeric, no spaces. */
export const normalisePlate = (plate: string): string =>
  plate.replace(/[^A-Za-z0-9]/g, "").toUpperCase();

/** Display form: WB02AB1234 → "WB 02 AB 1234". */
export function formatPlate(plate: string): string {
  const p = normalisePlate(plate);
  const m = p.match(/^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{1,4})$/);
  return m ? [m[1], m[2], m[3], m[4]].filter(Boolean).join(" ") : plate;
}

/**
 * Indian registration formats, including the BH series and older single-letter
 * state codes. Phase 1 relies on this because the attendant types the number by
 * hand — a typo caught here is a dispute that never happens.
 */
const PATTERNS = [
  /^[A-Z]{2}\d{1,2}[A-Z]{1,3}\d{1,4}$/, // WB02AB1234
  /^\d{2}BH\d{4}[A-Z]{1,2}$/, // 22BH1234AA — Bharat series
  /^[A-Z]{2}\d{1,2}\d{1,4}$/, // WB021234 — older format, no letter series
];

export const isValidPlate = (plate: string): boolean => {
  const p = normalisePlate(plate);
  return p.length >= 6 && p.length <= 12 && PATTERNS.some((re) => re.test(p));
};

const codeAlphabet = fromAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 6);

/** Human-quotable session code — no ambiguous 0/O or 1/I. */
export const generateSessionCode = (): string => `KMCP-${codeAlphabet()}`;

const passAlphabet = fromAlphabet("0123456789", 5);
export const generatePassCode = (): string => `PASS-${passAlphabet()}`;

export const generateReceiptNumber = (financialYear: string, sequence: number): string =>
  `RCPT/${financialYear}/${String(sequence).padStart(6, "0")}`;

/** Indian financial year label for the given date, e.g. "26-27". */
export function financialYear(date: Date): string {
  const year = date.getUTCFullYear();
  const startYear = date.getUTCMonth() >= 3 ? year : year - 1;
  return `${String(startYear).slice(2)}-${String(startYear + 1).slice(2)}`;
}
