/**
 * The complete error vocabulary. Clients branch on `code` — never on `message`,
 * which is safe to show to an end user and may be reworded at any time.
 */
export const ERROR_CODES = {
  VALIDATION_FAILED: { status: 400, message: "Some fields need attention." },
  IDEMPOTENCY_KEY_REQUIRED: { status: 400, message: "Missing idempotency key." },
  SYNC_BATCH_TOO_LARGE: { status: 400, message: "Too many events in one sync batch." },
  PAYMENT_SIGNATURE_INVALID: { status: 400, message: "Payment could not be verified." },

  UNAUTHENTICATED: { status: 401, message: "Please sign in again." },
  TOKEN_REUSED: { status: 401, message: "Session revoked for security reasons." },
  INVALID_CREDENTIALS: { status: 401, message: "Those sign-in details are not correct." },
  OTP_INVALID: { status: 401, message: "That code is not correct or has expired." },
  TWO_FACTOR_REQUIRED: { status: 401, message: "Enter the code from your authenticator app." },

  FORBIDDEN: { status: 403, message: "You do not have permission to do that." },
  DEVICE_NOT_BOUND: { status: 403, message: "This device is not registered to your account." },
  ACCOUNT_SUSPENDED: { status: 403, message: "This account is suspended." },

  NOT_FOUND: { status: 404, message: "We could not find that." },

  SESSION_ALREADY_ACTIVE: { status: 409, message: "This vehicle already has an active parking session." },
  SESSION_NOT_ACTIVE: { status: 409, message: "This session has already ended." },
  SHIFT_ALREADY_OPEN: { status: 409, message: "You already have an open shift." },
  SHIFT_ALREADY_CLOSED: { status: 409, message: "This shift is closed." },
  SETTLEMENT_ALREADY_APPROVED: { status: 409, message: "This settlement is locked after approval." },
  TARIFF_ALREADY_PUBLISHED: { status: 409, message: "A published tariff cannot be edited." },
  DUPLICATE_RESOURCE: { status: 409, message: "That already exists." },

  OUTSIDE_GEOFENCE: { status: 422, message: "You are outside every zone assigned to you." },
  ZONE_CLOSED: { status: 422, message: "This zone is closed right now." },
  ZONE_AT_CAPACITY: { status: 422, message: "No slots available for this vehicle type." },
  VEHICLE_TYPE_NOT_ALLOWED: { status: 422, message: "This zone does not accept that vehicle type." },
  NO_APPLICABLE_TARIFF: { status: 422, message: "No published tariff covers this zone and vehicle type." },
  PASS_INVALID: { status: 422, message: "This pass is not valid here." },
  PAYMENT_NOT_CONFIRMED: { status: 422, message: "Payment has not been confirmed yet." },
  KYC_INCOMPLETE: { status: 422, message: "Verify the vendor's KYC documents first." },
  LEDGER_UNBALANCED: { status: 422, message: "The settlement ledger does not balance." },

  CLIENT_UPGRADE_REQUIRED: { status: 426, message: "Please update the app to continue." },
  RATE_LIMITED: { status: 429, message: "Too many requests. Please wait a moment." },
  INTERNAL_ERROR: { status: 500, message: "Something went wrong on our side." },
  SERVICE_UNAVAILABLE: { status: 503, message: "A dependency is unavailable. Please retry." },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;
