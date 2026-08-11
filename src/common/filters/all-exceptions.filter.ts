import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { AppException, type ErrorDetail } from "../errors/app.exception";
import { ERROR_CODES, type ErrorCode } from "../errors/error-codes";

interface ErrorBody {
  code: string;
  message: string;
  details?: ErrorDetail[];
}

/**
 * Every error leaves the API in the same envelope, with a stable code and a
 * message that is safe to show a citizen. Stack traces never cross the wire.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger("Exception");

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = (request as Request & { requestId?: string }).requestId ?? "unknown";

    const { status, body } = this.resolve(exception);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${request.url} → ${status} ${body.code} [${requestId}]`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else if (status >= HttpStatus.BAD_REQUEST) {
      this.logger.warn(`${request.method} ${request.url} → ${status} ${body.code} [${requestId}]`);
    }

    response.status(status).json({ success: false, error: body, meta: { requestId } });
  }

  private resolve(exception: unknown): { status: number; body: ErrorBody } {
    if (exception instanceof AppException) {
      const res = exception.getResponse() as ErrorBody;
      return { status: exception.getStatus(), body: res };
    }

    if (exception instanceof ZodError) {
      return {
        status: 400,
        body: {
          code: "VALIDATION_FAILED",
          message: ERROR_CODES.VALIDATION_FAILED.message,
          details: exception.issues.map((i) => ({
            field: i.path.join(".") || "body",
            issue: i.message,
          })),
        },
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.fromPrisma(exception);
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse();
      const message =
        typeof raw === "string"
          ? raw
          : ((raw as { message?: string | string[] }).message ?? exception.message);
      return {
        status,
        body: {
          code: this.codeForStatus(status),
          message: Array.isArray(message) ? message.join(", ") : message,
        },
      };
    }

    return {
      status: 500,
      body: { code: "INTERNAL_ERROR", message: ERROR_CODES.INTERNAL_ERROR.message },
    };
  }

  private fromPrisma(e: Prisma.PrismaClientKnownRequestError): { status: number; body: ErrorBody } {
    switch (e.code) {
      case "P2002": {
        const target = (e.meta?.target as string[] | undefined)?.join(", ") ?? "field";
        return {
          status: 409,
          body: {
            code: "DUPLICATE_RESOURCE",
            message: ERROR_CODES.DUPLICATE_RESOURCE.message,
            details: [{ field: target, issue: "must be unique" }],
          },
        };
      }
      case "P2025":
        return { status: 404, body: { code: "NOT_FOUND", message: ERROR_CODES.NOT_FOUND.message } };
      case "P2003": {
        // Prisma reports the constraint, not the field: "Zone_wardId_fkey
        // (index)". A caller cannot act on that, so the column is recovered
        // from it — an unexplained 422 on save is how a form ends up looking
        // broken when the real problem is one stale id in a dropdown.
        const constraint = String(e.meta?.field_name ?? "");
        const field = constraint.match(/_([A-Za-z0-9]+)_fkey/)?.[1] ?? (constraint || "reference");
        return {
          status: 422,
          body: {
            code: "VALIDATION_FAILED",
            message: `No ${field.replace(/Id$/, "")} exists with that id.`,
            details: [{ field, issue: "no record with that id" }],
          },
        };
      }
      default:
        return {
          status: 500,
          body: { code: "INTERNAL_ERROR", message: ERROR_CODES.INTERNAL_ERROR.message },
        };
    }
  }

  private codeForStatus(status: number): ErrorCode {
    const map: Partial<Record<number, ErrorCode>> = {
      400: "VALIDATION_FAILED",
      401: "UNAUTHENTICATED",
      403: "FORBIDDEN",
      404: "NOT_FOUND",
      409: "DUPLICATE_RESOURCE",
      422: "VALIDATION_FAILED",
      429: "RATE_LIMITED",
      503: "SERVICE_UNAVAILABLE",
    };
    return map[status] ?? "INTERNAL_ERROR";
  }
}
