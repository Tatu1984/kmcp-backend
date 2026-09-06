import { z } from "zod";
import { CameraStatus } from "@prisma/client";
import { PaginationSchema } from "@/common/dto/pagination.dto";

/**
 * An RTSP address, checked for the two things that actually go wrong: the wrong
 * scheme pasted from a browser tab, and a host that is not a host.
 *
 * Deliberately permissive about everything else. Camera paths are vendor
 * gibberish — `/Streaming/Channels/101`, `/cam/realmonitor?channel=1&subtype=0`
 * — and a validator with opinions about them would refuse working cameras.
 */
const RtspUrl = z
  .string()
  .trim()
  .max(500)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === "rtsp:" || url.protocol === "rtsps:") && Boolean(url.hostname);
    } catch {
      return false;
    }
  }, "Must be an rtsp:// or rtsps:// address, e.g. rtsp://10.20.0.4:554/Streaming/Channels/101");

const OnvifUrl = z
  .string()
  .trim()
  .max(500)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }, "Must be an http:// or https:// address, e.g. http://10.20.0.4/onvif/device_service");

/**
 * The connection half of a camera, which every write shares.
 *
 * `username` and `password` go in and never come back: they are encrypted on
 * arrival and the API has no shape that returns them. On an edit, leaving them
 * out keeps what is stored — which is why they are optional here and why
 * `clearCredentials` exists to say the other thing deliberately.
 */
const ConnectionFields = {
  rtspUrl: RtspUrl.optional(),
  onvifUrl: OnvifUrl.optional(),
  username: z.string().trim().max(120).optional(),
  password: z.string().max(200).optional(),
  coverageSlots: z.coerce.number().int().min(0).max(500).optional(),
  hasIR: z.coerce.boolean().optional(),
  hasPTZ: z.coerce.boolean().optional(),
  isActive: z.coerce.boolean().optional(),
};

export const CreateCameraSchema = z.object({
  streetId: z.string().min(1, "A camera is bolted to a road"),
  code: z
    .string()
    .trim()
    .min(2)
    .max(24)
    .toUpperCase()
    .regex(/^[A-Z0-9-]+$/, "Use letters, digits and hyphens only"),
  /** Where it points, in words an engineer standing on the pavement would use. */
  label: z.string().trim().min(3).max(120),
  makeModel: z.string().trim().max(80).optional(),
  /**
   * Names this camera's stream on the gateway.
   *
   * Deliberately not a URL and deliberately not credentials: the gateway holds
   * the connection to the camera, and a client is never handed anything it
   * could reconnect with on its own. Left out, it is derived from the code,
   * which is what anybody would have typed anyway.
   */
  streamKey: z
    .string()
    .trim()
    .max(120)
    .regex(/^[A-Za-z0-9_-]+$/, "Use letters, digits, hyphens and underscores only")
    .optional(),
  installedAt: z.coerce.date().optional(),
  ...ConnectionFields,
});
export type CreateCameraDto = z.infer<typeof CreateCameraSchema>;

export const UpdateCameraSchema = CreateCameraSchema.partial()
  .omit({ streetId: true })
  .extend({
    status: z.nativeEnum(CameraStatus).optional(),
    /**
     * Removes the stored username and password.
     *
     * Needed because "leave the fields blank" already means "keep what is
     * there" — without this there would be no way to say that a camera which
     * used to need credentials no longer does.
     */
    clearCredentials: z.coerce.boolean().optional(),
  });
export type UpdateCameraDto = z.infer<typeof UpdateCameraSchema>;

export const CameraQuerySchema = PaginationSchema.extend({
  streetId: z.string().optional(),
  zoneId: z.string().optional(),
  status: z.nativeEnum(CameraStatus).optional(),
  /** Omitted shows every camera; the list screen defaults to those in service. */
  isActive: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  q: z.string().trim().max(80).optional(),
});
export type CameraQueryDto = z.infer<typeof CameraQuerySchema>;
