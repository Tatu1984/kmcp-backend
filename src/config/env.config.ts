import { z } from "zod";

/**
 * Every environment variable is validated at boot. A missing or malformed value
 * fails the process start — it never fails at 3 a.m. inside a request handler.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  API_PREFIX: z.string().default("api/v1"),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DIRECT_URL: z.string().optional(),

  JWT_ACCESS_SECRET: z.string().min(16, "JWT_ACCESS_SECRET must be at least 16 characters"),
  JWT_REFRESH_SECRET: z.string().min(16, "JWT_REFRESH_SECRET must be at least 16 characters"),
  ACCESS_TOKEN_TTL: z.string().default("15m"),
  REFRESH_TOKEN_TTL: z.string().default("30d"),
  OTP_TTL_SECONDS: z.coerce.number().default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().default(5),

  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: z.string().default("kmcp-media"),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  MEDIA_SIGNED_URL_TTL: z.coerce.number().default(900),

  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  RAZORPAYX_ACCOUNT_NUMBER: z.string().optional(),

  /**
   * Outbound messaging. Every one of these is optional, and that is load-bearing
   * rather than lax: with the credentials for a channel unset its adapter is a
   * no-op that records the intent as a failed delivery with the reason, so local
   * development, CI and the demo build need no live provider accounts and no
   * separate "fake provider" flag. Absent credentials *are* the signal.
   */
  MSG91_AUTH_KEY: z.string().optional(),
  MSG91_SENDER_ID: z.string().optional(),
  /**
   * The DLT-registered MSG91 flow. Indian networks register message content
   * with the regulator, so a transactional SMS names a registered template and
   * supplies its variables; unset, the adapter falls back to our own template
   * key, which will be refused by MSG91 in a way the delivery log reports.
   */
  MSG91_TEMPLATE_ID: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_TOKEN: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  /** Must be on a domain verified with Resend, e.g. `KMCP <no-reply@kmcp.gov.in>`. */
  RESEND_FROM_EMAIL: z.string().optional(),
  /**
   * Where a link in a message points — the citizen app, not this API. Unset,
   * messages simply carry no link rather than one to a host that is wrong.
   */
  PUBLIC_APP_URL: z.string().optional(),

  /** Optional. Adds PIN code, ASN and VPN/proxy detection to sign-in records. */
  IPINFO_TOKEN: z.string().optional(),

  /**
   * Encrypts the camera credentials at rest, and nothing else so far.
   *
   * Optional, and its absence is a refusal rather than a downgrade: with no key
   * set, registering a camera that carries a username and password is rejected
   * with a message naming this variable. The alternative — a built-in
   * development key — writes ciphertext anybody with the source can read into a
   * column whose whole purpose is that they cannot, and it looks identical to
   * the real thing in every screen and every backup.
   *
   * 32 characters minimum because it is stretched with scrypt into a 256-bit
   * key; longer is better and `openssl rand -base64 48` is the intended way to
   * produce one. Losing it means the stored credentials cannot be decrypted and
   * each camera has to be given its password again.
   */
  ENCRYPTION_KEY: z.string().min(32, "ENCRYPTION_KEY must be at least 32 characters").optional(),

  /**
   * The streaming gateway: a media server that pulls RTSP from the cameras and
   * republishes it as something a browser can play.
   *
   * MediaMTX is the implementation these three address (control API on 9997,
   * HLS on 8888, WebRTC/WHEP on 8889), reached through `StreamGatewayService`
   * so nothing above that file knows which product it is.
   *
   * The control URL is internal — it configures the server and must never be
   * reachable from a browser. The other two are what the browser itself opens,
   * so in a real deployment they are public hostnames rather than a service
   * name on a container network. All three unset means no gateway, which the
   * playback endpoint reports as such instead of handing out a dead player.
   */
  MEDIAMTX_CONTROL_URL: z.string().url().optional(),
  MEDIAMTX_HLS_BASE: z.string().url().optional(),
  MEDIAMTX_WEBRTC_BASE: z.string().url().optional(),
  MEDIAMTX_TIMEOUT_MS: z.coerce.number().default(5000),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  /**
   * Where 5xx failures are reported. Optional, and unset means no reporting at
   * all rather than a degraded one — a local run and the demo deployment need
   * no Sentry account.
   *
   * Read by `src/observability/sentry.ts` from `process.env` directly, because
   * the SDK has to start before Nest builds the config module. It is declared
   * here anyway so a typo fails the boot rather than silently disabling alerts.
   */
  SENTRY_DSN: z.string().optional(),
  /** Overrides the environment label. Defaults to VERCEL_ENV, then NODE_ENV. */
  SENTRY_ENVIRONMENT: z.string().optional(),

  /**
   * The shared secret the scheduler presents to POST /cron/overstay-sweep.
   *
   * Optional so a local run needs no ceremony, but an unset value refuses every
   * call rather than waving them through — see CronController.
   */
  CRON_SECRET: z.string().optional(),

  /**
   * Set by Vercel on every deployment, and by nothing else. Its presence is how
   * the app knows the container will be torn down between requests, and so that
   * an in-process timer will never fire.
   */
  VERCEL: z.string().optional(),

  SWAGGER_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
});

export type Env = z.infer<typeof schema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

/** Splits the comma-separated CORS_ORIGINS value into an allow-list. */
export const corsOrigins = (value: string): string[] =>
  value
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
