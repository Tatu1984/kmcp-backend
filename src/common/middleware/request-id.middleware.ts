import { Injectable, NestMiddleware } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { HEADERS } from "@/config/app.constants";

declare module "express" {
  interface Request {
    requestId?: string;
  }
}

/**
 * Assigns a correlation id to every request and echoes it back. Support asks a
 * citizen for this id and finds the exact request in the logs and audit trail.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.header(HEADERS.requestId);
    const id = incoming && incoming.length <= 64 ? incoming : randomUUID();
    req.requestId = id;
    res.setHeader(HEADERS.requestId, id);
    next();
  }
}
