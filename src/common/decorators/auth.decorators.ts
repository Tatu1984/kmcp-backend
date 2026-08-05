import { SetMetadata, createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import type { UserRole } from "@prisma/client";
import type { Permission } from "../rbac/permissions";

export const IS_PUBLIC_KEY = "kmcp:isPublic";
export const ROLES_KEY = "kmcp:roles";
export const PERMISSIONS_KEY = "kmcp:permissions";
export const SKIP_DEVICE_BINDING_KEY = "kmcp:skipDeviceBinding";

/** No token required. Used by auth, webhooks, health and the public surface. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Restrict a route to specific roles. */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

/** Restrict a route by permission — preferred over Roles, since RBAC is editable. */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/** Allow an attendant to call this route from an unbound device (binding itself). */
export const SkipDeviceBinding = () => SetMetadata(SKIP_DEVICE_BINDING_KEY, true);

export interface AuthenticatedUser {
  id: string;
  role: UserRole;
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

/** Injects the client IP and user agent for the audit trail. */
export const ClientInfo = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest<Request>();
  return {
    ip: request.ip ?? request.socket.remoteAddress ?? undefined,
    userAgent: request.header("user-agent") ?? undefined,
  };
});
