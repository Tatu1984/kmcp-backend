export const APP = {
  name: "KMCP",
  fullName: "Smart Street Parking Management System",
  version: "1.0.0",
  /** Phase 1 captures the plate photo; the number is typed by the attendant. */
  phase: 1,
  anprEnabled: false,
  currency: "INR",
  timezone: "Asia/Kolkata",
} as const;

export const API = {
  maxPageSize: 100,
  defaultPageSize: 25,
  /** Offline replay batches are capped so one device cannot monopolise a worker. */
  maxSyncBatch: 50,
  idempotencyTtlSeconds: 60 * 60 * 24,
  webhookReplayWindowSeconds: 300,
} as const;

export const HEADERS = {
  deviceId: "x-device-id",
  clientVersion: "x-client-version",
  idempotencyKey: "idempotency-key",
  requestId: "x-request-id",
  /** Alternative to `Authorization: Bearer` for a scheduler that cannot set one. */
  cronSecret: "x-cron-secret",
} as const;

/** Accounts used by the double-entry settlement ledger. */
export const LEDGER_ACCOUNTS = {
  CASH_IN_HAND: "CASH_IN_HAND",
  GATEWAY_RECEIVABLE: "GATEWAY_RECEIVABLE",
  VENDOR_PAYABLE: "VENDOR_PAYABLE",
  GOVERNMENT_REVENUE: "GOVERNMENT_REVENUE",
  COMMISSION_INCOME: "COMMISSION_INCOME",
} as const;
