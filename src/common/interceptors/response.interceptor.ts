import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { Observable, map } from "rxjs";
import type { Request } from "express";

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
  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request & { requestId?: string }>();
    const requestId = request.requestId ?? "unknown";

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
