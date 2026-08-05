import { Injectable, PipeTransform } from "@nestjs/common";
import { ZodError, type ZodType } from "zod";
import { AppException } from "../errors/app.exception";

/**
 * Validates a request payload against a Zod schema. Every route that takes
 * input uses one of these — no unvalidated body ever reaches a service.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    try {
      return this.schema.parse(value);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new AppException(
          "VALIDATION_FAILED",
          error.issues.map((i) => ({
            field: i.path.join(".") || "body",
            issue: i.message,
          })),
        );
      }
      throw error;
    }
  }
}

/** Convenience factory so routes read `@Body(zodPipe(CreateZoneSchema))`. */
export const zodPipe = <T>(schema: ZodType<T>) => new ZodValidationPipe(schema);
