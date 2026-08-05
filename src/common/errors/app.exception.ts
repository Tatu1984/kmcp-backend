import { HttpException } from "@nestjs/common";
import { ERROR_CODES, type ErrorCode } from "./error-codes";

export interface ErrorDetail {
  field: string;
  issue: string;
}

/**
 * The only exception type services should throw. It carries a stable machine
 * code, the HTTP status that belongs to it, and optional field-level detail.
 */
export class AppException extends HttpException {
  constructor(
    public readonly code: ErrorCode,
    public readonly details?: ErrorDetail[],
    message?: string,
  ) {
    const spec = ERROR_CODES[code];
    super({ code, message: message ?? spec.message, details }, spec.status);
  }

  static notFound(what = "resource"): AppException {
    return new AppException("NOT_FOUND", undefined, `We could not find that ${what}.`);
  }

  static forbidden(reason?: string): AppException {
    return new AppException("FORBIDDEN", undefined, reason);
  }
}
