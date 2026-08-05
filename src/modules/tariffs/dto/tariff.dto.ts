import { z } from "zod";
import { DayType, SlotType, TariffRuleType } from "@prisma/client";
import { PaginationSchema } from "@/common/dto/pagination.dto";

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export const TariffRuleSchema = z
  .object({
    type: z.nativeEnum(TariffRuleType),
    dayType: z.nativeEnum(DayType).default(DayType.ALL),
    timeFrom: z.string().regex(TIME).optional(),
    timeTo: z.string().regex(TIME).optional(),
    multiplier: z.number().min(0).max(10).optional(),
    flatAmount: z.number().int().min(0).optional(),
    priority: z.number().int().min(0).max(100).default(0),
    isActive: z.boolean().default(true),
  })
  .refine((r) => r.multiplier !== undefined || r.flatAmount !== undefined, {
    message: "A rule needs either a multiplier or a flat amount",
    path: ["multiplier"],
  })
  .refine((r) => (r.timeFrom === undefined) === (r.timeTo === undefined), {
    message: "Give both a start and an end time, or neither",
    path: ["timeTo"],
  });
export type TariffRuleDto = z.infer<typeof TariffRuleSchema>;

export const CreateTariffSchema = z.object({
  name: z.string().trim().min(3).max(120),
  zoneId: z.string().optional(),
  vehicleType: z.nativeEnum(SlotType),
  /** All amounts are integer paise. */
  baseAmount: z.number().int().min(0),
  baseMinutes: z.number().int().min(1).max(1440),
  incrementAmount: z.number().int().min(0),
  incrementMinutes: z.number().int().min(1).max(1440),
  dailyCapAmount: z.number().int().min(0).optional(),
  gracePeriodMin: z.number().int().min(0).max(240).default(0),
  overstayPenalty: z.number().int().min(0).optional(),
  taxPercent: z.number().min(0).max(100).default(18),
  effectiveFrom: z.coerce.date(),
  effectiveTo: z.coerce.date().optional(),
  priority: z.number().int().min(0).max(100).default(0),
  rules: z.array(TariffRuleSchema).default([]),
});
export type CreateTariffDto = z.infer<typeof CreateTariffSchema>;

export const UpdateTariffSchema = CreateTariffSchema.partial();
export type UpdateTariffDto = z.infer<typeof UpdateTariffSchema>;

export const PublishTariffSchema = z.object({
  approvalReference: z
    .string()
    .trim()
    .min(4, "Record the board resolution or approval reference")
    .max(200),
});
export type PublishTariffDto = z.infer<typeof PublishTariffSchema>;

export const TariffQuerySchema = PaginationSchema.extend({
  zoneId: z.string().optional(),
  vehicleType: z.nativeEnum(SlotType).optional(),
  published: z.coerce.boolean().optional(),
});
export type TariffQueryDto = z.infer<typeof TariffQuerySchema>;

export const PreviewQuoteSchema = z.object({
  zoneId: z.string().min(1),
  vehicleType: z.nativeEnum(SlotType),
  /** Either give a duration, or an explicit start and end. */
  durationMinutes: z.number().int().min(1).max(10080).optional(),
  startAt: z.coerce.date().optional(),
  endAt: z.coerce.date().optional(),
  discountCode: z.string().max(40).optional(),
  vehicleId: z.string().optional(),
  overstayAfterMinutes: z.number().int().min(1).optional(),
}).refine((d) => d.durationMinutes !== undefined || (d.startAt && d.endAt), {
  message: "Give a durationMinutes, or both startAt and endAt",
  path: ["durationMinutes"],
});
export type PreviewQuoteDto = z.infer<typeof PreviewQuoteSchema>;

export const ApplicableTariffSchema = z.object({
  zoneId: z.string().min(1),
  vehicleType: z.nativeEnum(SlotType),
  at: z.coerce.date().optional(),
});
export type ApplicableTariffDto = z.infer<typeof ApplicableTariffSchema>;

export const CreateHolidaySchema = z.object({
  date: z.coerce.date(),
  name: z.string().trim().min(2).max(120),
  isEvent: z.boolean().default(false),
  zoneIds: z.array(z.string()).default([]),
  multiplier: z.number().min(0).max(10).optional(),
});
export type CreateHolidayDto = z.infer<typeof CreateHolidaySchema>;

export const CreateDiscountSchema = z.object({
  name: z.string().trim().min(2).max(120),
  code: z.string().trim().max(40).toUpperCase().optional(),
  zoneId: z.string().optional(),
  vehicleTypeId: z.nativeEnum(SlotType).optional(),
  percentOff: z.number().min(0).max(100).optional(),
  flatOff: z.number().int().min(0).optional(),
  validFrom: z.coerce.date(),
  validTo: z.coerce.date(),
  maxUses: z.number().int().min(1).optional(),
  isActive: z.boolean().default(true),
}).refine((d) => d.percentOff !== undefined || d.flatOff !== undefined, {
  message: "Give a percentage or a flat amount off",
  path: ["percentOff"],
});
export type CreateDiscountDto = z.infer<typeof CreateDiscountSchema>;
