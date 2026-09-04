import { SetMetadata, createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import { HEADERS } from "@/config/app.constants";
import { AppException } from "../errors/app.exception";
import type { Permission, RoleCode } from "../rbac/permissions";

export const IS_PUBLIC_KEY = "kmcp:isPublic";
export const ROLES_KEY = "kmcp:roles";
export const PERMISSIONS_KEY = "kmcp:permissions";
export const SKIP_DEVICE_BINDING_KEY = "kmcp:skipDeviceBinding";

/** No token required. Used by auth, webhooks, health and the public surface. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Restrict a route to specific roles. */
export const Roles = (...roles: RoleCode[]) => SetMetadata(ROLES_KEY, roles);

/** Restrict a route by permission — preferred over Roles, since RBAC is editable. */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/** Allow an attendant to call this route from an unbound device (binding itself). */
export const SkipDeviceBinding = () => SetMetadata(SKIP_DEVICE_BINDING_KEY, true);

export interface AuthenticatedUser {
  id: string;
  role: RoleCode;
  /** Resolved from the role at authentication, so services need no lookup. */
  isZoneScoped: boolean;
  name: string;
  email?: string | null;
  phone?: string | null;
  /** Present when the user is a vendor or an attendant employed by one. */
  vendorId?: string | null;
  attendantId?: string | null;
  /** Zone ids this user may operate in; empty means unrestricted. */
  zoneIds: string[];
  deviceId?: string;
  sessionId: string;
}

/** Injects the authenticated principal resolved by JwtAuthGuard. */
export const CurrentUser = createParamDecorator(
  (field: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const user = request.user;
    return field && user ? user[field] : user;
  },
);

/** Injects the correlation id so services can stamp it onto audit rows. */
export const RequestId = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest<Request & { requestId?: string }>();
  return request.requestId ?? "unknown";
});

/**
 * Injects the client's `Idempotency-Key`, if it sent one.
 *
 * Optional throughout: a caller that sends no key gets exactly the behaviour it
 * has today. A caller that sends one is making a deliberate promise — "this is
 * the same request as before" — so a malformed key is refused rather than
 * quietly ignored, since silently dropping it would leave the client believing
 * it was protected when it was not.
 */
export const IdempotencyKey = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest<Request>();
  const key = request.header(HEADERS.idempotencyKey)?.trim();
  if (!key) return undefined;

  if (key.length < 8 || key.length > 128) {
    throw new AppException("VALIDATION_FAILED", [
      { field: HEADERS.idempotencyKey, issue: "must be between 8 and 128 characters" },
    ]);
  }
  return key;
});

/** Injects the client IP and user agent for the audit trail. */
export const ClientInfo = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest<Request>();
  return {
    ip: request.ip ?? request.socket.remoteAddress ?? undefined,
    userAgent: request.header("user-agent") ?? undefined,
  };
});
