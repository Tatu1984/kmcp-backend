import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Observable, map } from "rxjs";
import type { Request } from "express";

export const RAW_RESPONSE = "raw_response";

/**
 * Returns the handler's value as-is, without the `{ success, data, meta }`
 * envelope.
 *
 * For file downloads only. A spreadsheet cannot open a CSV that has been
 * wrapped in JSON, and a caller that wanted the envelope would not be asking
 * for a file.
 */
export const RawResponse = () => SetMetadata(RAW_RESPONSE, true);

export interface ApiMeta {
  requestId: string;
  page?: number;
  pageSize?: number;
  total?: number;
  totalPages?: number;
  idempotentReplay?: boolean;
}

/** A service returns this when the payload is a page rather than a single item. */
export class Paginated<T> {
  constructor(
    public readonly items: T[],
    public readonly page: number,
    public readonly pageSize: number,
    public readonly total: number,
  ) {}
}

/**
 * Wraps every successful response in the envelope the clients expect:
 * `{ success: true, data, meta }`. Paginated results have their page counters
 * lifted into `meta` so `data` stays a plain array.
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, unknown> {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request & { requestId?: string }>();
    const requestId = request.requestId ?? "unknown";

    const raw = this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (raw) return next.handle();

    return next.handle().pipe(
      map((payload) => {
        if (payload instanceof Paginated) {
          return {
            success: true,
            data: payload.items,
            meta: {
              requestId,
              page: payload.page,
              pageSize: payload.pageSize,
              total: payload.total,
              totalPages: Math.max(1, Math.ceil(payload.total / payload.pageSize)),
            } satisfies ApiMeta,
          };
        }
        return { success: true, data: payload ?? null, meta: { requestId } satisfies ApiMeta };
      }),
    );
  }
}
