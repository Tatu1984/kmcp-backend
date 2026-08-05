import { z } from "zod";
import { API } from "@/config/app.constants";

export const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(API.maxPageSize).default(API.defaultPageSize),
  /** Comma-separated fields; a `-` prefix means descending. */
  sort: z.string().optional(),
  q: z.string().trim().max(200).optional(),
});

export type PaginationQuery = z.infer<typeof PaginationSchema>;

export const DateRangeSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export type DateRangeQuery = z.infer<typeof DateRangeSchema>;

export function skipTake(query: PaginationQuery): { skip: number; take: number } {
  return { skip: (query.page - 1) * query.pageSize, take: query.pageSize };
}

/**
 * Turns `-startAt,plateNumber` into a Prisma orderBy array, ignoring any field
 * not on the allow-list so a caller cannot sort by an unindexed column.
 */
export function orderBy(
  sort: string | undefined,
  allowed: readonly string[],
  fallback: Record<string, "asc" | "desc">,
): Record<string, "asc" | "desc">[] {
  if (!sort) return [fallback];
  const parsed = sort
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const desc = s.startsWith("-");
      const field = desc ? s.slice(1) : s;
      return allowed.includes(field) ? { [field]: desc ? "desc" : "asc" } : null;
    })
    .filter((x): x is Record<string, "asc" | "desc"> => x !== null);
  return parsed.length > 0 ? parsed : [fallback];
}
