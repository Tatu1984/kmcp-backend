import { z } from "zod";
import { ReportStatus } from "@prisma/client";
import { PaginationSchema } from "@/common/dto/pagination.dto";
import { REPORT_KEYS } from "../report-types";

export const GenerateReportSchema = z
  .object({
    type: z.enum(REPORT_KEYS),
    from: z.coerce.date(),
    to: z.coerce.date(),
    zoneId: z.string().optional(),
    vendorId: z.string().optional(),
    /**
     * Only CSV is produced. Excel opens it directly; PDF would need a rendering
     * library this API does not carry, and emitting a CSV named `.pdf` would be
     * worse than refusing.
     */
    format: z.literal("csv").default("csv"),
  })
  .refine((dto) => dto.to >= dto.from, {
    message: "The period must end after it starts",
    path: ["to"],
  });
export type GenerateReportDto = z.infer<typeof GenerateReportSchema>;

export const ReportQuerySchema = PaginationSchema.extend({
  type: z.string().optional(),
  status: z.nativeEnum(ReportStatus).optional(),
  mine: z.coerce.boolean().optional(),
});
export type ReportQueryDto = z.infer<typeof ReportQuerySchema>;
