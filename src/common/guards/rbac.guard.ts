import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import type { UserRole } from "@prisma/client";
import { AppException } from "../errors/app.exception";
import { can, type Permission } from "../rbac/permissions";
import {
  IS_PUBLIC_KEY,
  PERMISSIONS_KEY,
  ROLES_KEY,
  type AuthenticatedUser,
} from "../decorators/auth.decorators";

/**
 * Pre-checks role and permission metadata. Services still re-assert scope on
 * the data they touch — this guard answers "may you call this?", not "may you
 * see this row?".
 */
@Injectable()
export class RbacGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const roles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const permissions = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!roles?.length && !permissions?.length) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const user = request.user;
    if (!user) throw new AppException("UNAUTHENTICATED");

    if (roles?.length && !roles.includes(user.role)) {
      throw AppException.forbidden("Your role does not permit that action.");
    }

    if (permissions?.length && !permissions.every((p) => can(user.role, p))) {
      throw AppException.forbidden("Your role does not permit that action.");
    }

    return true;
  }
}
