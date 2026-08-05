/**
 * Every amount in KMCP is an integer number of paise. These helpers exist so no
 * other file has a reason to do money arithmetic with floats.
 */

export type Paise = number;

export const addPaise = (...amounts: Paise[]): Paise =>
  amounts.reduce((sum, a) => sum + Math.round(a), 0);

export const applyPercent = (amount: Paise, percent: number): Paise =>
  Math.round((amount * percent) / 100);

/** Splits gross into commission and vendor share; the two always sum back exactly. */
export function splitCommission(
  gross: Paise,
  commissionPct: number,
): { commission: Paise; vendorShare: Paise } {
  const commission = applyPercent(gross, commissionPct);
  return { commission, vendorShare: gross - commission };
}

export const taxOn = (base: Paise, taxPercent: number): Paise => applyPercent(base, taxPercent);

export const clampToCap = (amount: Paise, cap?: Paise | null): Paise =>
  cap === undefined || cap === null ? amount : Math.min(amount, cap);

export function assertBalanced(debits: Paise[], credits: Paise[]): void {
  const d = addPaise(...debits);
  const c = addPaise(...credits);
  if (d !== c) {
    throw new Error(`Ledger does not balance: debit ${d} vs credit ${c}`);
  }
}

export const formatPaise = (paise: Paise): string => `₹${(paise / 100).toFixed(2)}`;
