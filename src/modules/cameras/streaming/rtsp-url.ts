/**
 * Building an RTSP address the gateway can actually open, and one a person can
 * safely be shown.
 *
 * The bug this exists to prevent is small and expensive: a camera password of
 * `admin@123` pasted into `rtsp://user:pass@host` produces two `@` signs, and
 * the URL parses with the host as `123@10.20.0.4`. The stream fails, the error
 * says the host is unreachable, and somebody spends an afternoon checking a
 * cable. Percent-encoding the userinfo is the whole fix, and the WHATWG `URL`
 * setters do it correctly.
 */

export interface RtspSource {
  /** The address as registered. May already carry credentials. */
  rtspUrl: string;
  /** Decrypted, and only ever inside the process. */
  username?: string | null;
  password?: string | null;
}

/**
 * The address with credentials in it. Server-side only — this string is handed
 * to the streaming gateway and must never reach a response, a log or a browser.
 *
 * An address that already carries userinfo is returned untouched: whoever
 * registered it made that choice deliberately, and rewriting it would be a
 * guess about which of two credentials was meant.
 */
export function credentialedRtspUrl({ rtspUrl, username, password }: RtspSource): string {
  if (!rtspUrl) return rtspUrl;

  let url: URL;
  try {
    url = new URL(rtspUrl);
  } catch {
    // Not parseable. Hand it back and let the gateway produce the error, which
    // will name the address rather than a repair attempted on it.
    return rtspUrl;
  }

  if (url.username || url.password) return url.toString();
  if (!username) return url.toString();

  url.username = username;
  if (password) url.password = password;
  return url.toString();
}

/**
 * The same address with any credentials removed entirely, which is the only
 * form allowed out of the API.
 *
 * Not redacted to `***` — actually removed. `rtsp://admin:***@10.20.0.4/s1`
 * still says there is a password on an account called admin, and a screen
 * showing an operator where their own camera is does not need to say either.
 */
export function credentialFreeRtspUrl(rtspUrl: string | null | undefined): string | null {
  if (!rtspUrl) return null;

  let value = rtspUrl;
  try {
    const url = new URL(rtspUrl);
    url.username = "";
    url.password = "";
    value = url.toString();
  } catch {
    // Unparseable. The scrub below is the whole defence for this case.
  }

  return scrubUserinfo(value);
}

/**
 * Cuts out anything shaped like credentials between the scheme and the host.
 *
 * Belt to the parser's braces, and not a redundant one: `rtsp:` is not a
 * "special" scheme to the URL parser, so an address that is a slash short —
 * `rtsp:/admin:hunter2@10.20.0.4/s1`, which is what a mistyped paste looks
 * like — parses without throwing, as a scheme and an opaque path. Nothing is
 * in `url.username`, clearing it changes nothing, and the password comes
 * straight back out. A test caught exactly that.
 *
 * The match stops at the first `/`, so an `@` inside a path — which vendor
 * stream paths do contain — is left alone.
 */
function scrubUserinfo(value: string): string {
  return value.replace(/^([a-z][a-z0-9+.-]*:)(\/\/?)[^/@\s]*@/i, "$1$2");
}

/** For logs and error messages, where the address is useful and the secret is not. */
export function redactRtspUrl(rtspUrl: string): string {
  if (!rtspUrl) return rtspUrl;
  try {
    const url = new URL(rtspUrl);
    if (url.username || url.password) {
      url.username = "***";
      url.password = "***";
    }
    return url.toString();
  } catch {
    return rtspUrl.replace(/\/\/[^/@]+@/, "//***:***@");
  }
}
