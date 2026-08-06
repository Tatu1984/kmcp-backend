import { z } from "zod";
import { MediaPurpose } from "@prisma/client";

/**
 * What may be uploaded, and how big.
 *
 * The allow-list is deliberate: a bucket that accepts arbitrary content types
 * is a file-hosting service someone else will find. Evidence is a photograph;
 * a KYC document is a photograph or a PDF.
 */
const IMAGE = ["image/jpeg", "image/png", "image/webp", "image/heic"] as const;
const DOCUMENT = ["application/pdf"] as const;

export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

export const RequestUploadSchema = z
  .object({
    purpose: z.nativeEnum(MediaPurpose),
    mimeType: z.enum([...IMAGE, ...DOCUMENT]),
    sizeBytes: z
      .number()
      .int()
      .min(1, "An empty file is not a file")
      .max(MAX_UPLOAD_BYTES, "Files are limited to 12 MB"),
    fileName: z.string().trim().max(200).optional(),
  })
  .refine(
    (d) =>
      // Only a document purpose may be a PDF; evidence has to be an image.
      !DOCUMENT.includes(d.mimeType as (typeof DOCUMENT)[number]) ||
      d.purpose === MediaPurpose.KYC_DOCUMENT ||
      d.purpose === MediaPurpose.AGREEMENT ||
      d.purpose === MediaPurpose.REPORT_EXPORT,
    { message: "A PDF can only be a KYC document, an agreement or a report", path: ["mimeType"] },
  );
export type RequestUploadDto = z.infer<typeof RequestUploadSchema>;

export const ConfirmUploadSchema = z.object({
  key: z.string().trim().min(8).max(300),
  purpose: z.nativeEnum(MediaPurpose),
  mimeType: z.enum([...IMAGE, ...DOCUMENT]),
  sizeBytes: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
  /** Lets the server detect a file that changed between upload and confirm. */
  sha256: z.string().trim().length(64).optional(),
  /** From the device, for evidence — when and where the photograph was taken. */
  capturedAt: z.coerce.date().optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});
export type ConfirmUploadDto = z.infer<typeof ConfirmUploadSchema>;

export const MediaQuerySchema = z.object({
  purpose: z.nativeEnum(MediaPurpose).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type MediaQueryDto = z.infer<typeof MediaQuerySchema>;

export const SignBatchSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(50),
});
export type SignBatchDto = z.infer<typeof SignBatchSchema>;
