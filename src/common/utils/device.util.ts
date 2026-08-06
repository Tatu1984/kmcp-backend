import { createHash } from "node:crypto";

export interface DeviceInfo {
  browserName?: string;
  osName?: string;
  /** "mobile" | "tablet" | "desktop" */
  deviceType?: string;
  fingerprint: string;
}

/** Hints the client forwards on login to sharpen the fingerprint. */
export interface ClientHints {
  timezone?: string;
  screen?: string;
  language?: string;
  platform?: string;
}

function detectBrowser(ua: string): string | undefined {
  if (/edg\//i.test(ua)) return "Edge";
  if (/opr\/|opera/i.test(ua)) return "Opera";
  if (/chrome\//i.test(ua)) return "Chrome";
  if (/firefox\//i.test(ua)) return "Firefox";
  if (/safari\//i.test(ua) && !/chrome/i.test(ua)) return "Safari";
  if (/okhttp|dart|expo/i.test(ua)) return "Mobile app";
  return undefined;
}

function detectOs(ua: string): string | undefined {
  if (/windows nt/i.test(ua)) return "Windows";
  if (/android/i.test(ua)) return "Android";
  if (/iphone|ipad|ipod/i.test(ua)) return "iOS";
  if (/mac os x/i.test(ua)) return "macOS";
  if (/linux/i.test(ua)) return "Linux";
  return undefined;
}

function detectDeviceType(ua: string): string {
  if (/ipad|tablet/i.test(ua)) return "tablet";
  if (/mobile|iphone|android.*mobile/i.test(ua)) return "mobile";
  return "desktop";
}

/**
 * Parse a user agent, plus any client hints, into a device summary and a
 * fingerprint hash.
 *
 * The fingerprint is not cryptographically unique and is not meant to be. Its
 * value is that a *change* for a given user is a signal — a new handset or a
 * new browser — which the anomaly engine reads. For attendants this sits
 * alongside the hard device binding, which refuses the request outright.
 */
export function parseDevice(
  userAgent: string | null | undefined,
  hints?: ClientHints,
): DeviceInfo {
  const ua = userAgent ?? "";
  const source = [
    ua,
    hints?.platform ?? "",
    hints?.timezone ?? "",
    hints?.screen ?? "",
    hints?.language ?? "",
  ].join("|");

  return {
    browserName: detectBrowser(ua),
    osName: detectOs(ua),
    deviceType: detectDeviceType(ua),
    fingerprint: createHash("sha256").update(source).digest("hex").slice(0, 32),
  };
}
