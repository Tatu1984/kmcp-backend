import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type { Env } from "@/config/env.config";
import { credentialedRtspUrl, redactRtspUrl, type RtspSource } from "./rtsp-url";

/**
 * The streaming gateway: the one thing in this codebase that knows a camera's
 * picture is turned into something playable by MediaMTX.
 *
 * A browser cannot open RTSP, and it must never be given the address or the
 * credentials to try. So a media server sits in the middle: it holds the
 * connection to the camera, and republishes the same picture as HLS and as
 * WebRTC on URLs that carry no secret and can be handed to anyone allowed to
 * watch. This service configures that server and reports what it says.
 *
 * Everything above it — the controller, the portal — deals in
 * `available`/`reason` and two URLs. Swapping MediaMTX for a cloud service, or
 * for one gateway per zone, is a change to this file.
 *
 * Unconfigured is a supported state, not a broken one. `MEDIAMTX_CONTROL_URL`
 * unset means every method here reports "no gateway" and nothing pretends
 * otherwise, which is how the demo deployment and every laptop run behave.
 */

export interface GatewayPathHealth {
  /** The gateway has a source connected and is serving it. */
  ready: boolean;
  /** How many clients are watching, where the gateway will say. */
  readers?: number;
  tracks?: string[];
  sourceType?: string;
}

export interface PlaybackUrls {
  hlsUrl: string;
  webrtcUrl: string;
}

@Injectable()
export class StreamGatewayService {
  private readonly logger = new Logger(StreamGatewayService.name);

  constructor(private readonly config: ConfigService<Env, true>) {}

  private get controlUrl(): string | undefined {
    return this.config.get("MEDIAMTX_CONTROL_URL", { infer: true });
  }

  /** True when this deployment has a media server to talk to. */
  get configured(): boolean {
    return Boolean(this.controlUrl);
  }

  /**
   * Where the browser will fetch the picture from.
   *
   * Falls back to the control URL's host only for the shape of the thing; a
   * deployment that means it sets both public bases, because the control API
   * lives on an internal network and the player does not.
   */
  playbackUrls(path: string): PlaybackUrls | null {
    const hls = this.config.get("MEDIAMTX_HLS_BASE", { infer: true });
    const webrtc = this.config.get("MEDIAMTX_WEBRTC_BASE", { infer: true });
    if (!hls || !webrtc) return null;

    const trim = (base: string) => base.replace(/\/+$/, "");
    return {
      hlsUrl: `${trim(hls)}/${path}/index.m3u8`,
      // WHEP is the standard WebRTC playback handshake; MediaMTX serves it at
      // <path>/whep on the WebRTC port.
      webrtcUrl: `${trim(webrtc)}/${path}/whep`,
    };
  }

  /**
   * Basic authentication for the control API, when it is exposed.
   *
   * Absent by default, and that is the better arrangement: a control API on a
   * private network needs no password because it cannot be reached. It has one
   * here because the API runs on Vercel, where a serverless function has no
   * fixed egress address to allow through a firewall, so the gateway's control
   * plane has to be published and defended rather than hidden.
   */
  private authHeader(): Record<string, string> {
    const user = this.config.get("MEDIAMTX_CONTROL_USER", { infer: true });
    const password = this.config.get("MEDIAMTX_CONTROL_PASSWORD", { infer: true });
    if (!user || !password) return {};
    return {
      authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`,
    };
  }

  private async call(method: string, path: string, body?: unknown): Promise<Response | null> {
    const base = this.controlUrl;
    if (!base) return null;

    const timeoutMs = this.config.get("MEDIAMTX_TIMEOUT_MS", { infer: true }) ?? 5000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(`${base.replace(/\/+$/, "")}${path}`, {
        method,
        headers: {
          ...(body ? { "content-type": "application/json" } : {}),
          ...this.authHeader(),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Point the gateway at a camera, creating the path or replacing what is
   * there. Idempotent, so it is safe to call on every edit and on playback.
   *
   * `sourceOnDemand` is deliberately on: the gateway opens the camera when
   * somebody asks to watch and drops it afterwards. Forty cameras pulled
   * continuously is forty streams of bandwidth to answer a question nobody is
   * asking, and most of these are on a municipal link.
   */
  async register(path: string, source: RtspSource): Promise<void> {
    if (!this.configured) return;

    const rtsp = credentialedRtspUrl(source);
    const payload = {
      source: rtsp,
      sourceOnDemand: true,
      // TCP, because RTSP over UDP through municipal NAT loses frames in a way
      // that looks like a broken camera.
      rtspTransport: "tcp",
    };

    // Add first; a path that already exists answers 400, and patch is then the
    // right verb. Doing it in this order keeps the common case to one call.
    const added = await this.call("POST", `/v3/config/paths/add/${encodeURIComponent(path)}`, payload);
    if (added?.ok) {
      this.logger.log(`Gateway path "${path}" registered → ${redactRtspUrl(rtsp)}`);
      return;
    }

    const patched = await this.call(
      "PATCH",
      `/v3/config/paths/patch/${encodeURIComponent(path)}`,
      payload,
    );
    if (patched?.ok) {
      this.logger.log(`Gateway path "${path}" updated → ${redactRtspUrl(rtsp)}`);
      return;
    }

    throw new Error(
      `Gateway refused path "${path}": ${patched?.status ?? added?.status ?? "unreachable"}`,
    );
  }

  /**
   * Best effort, and deliberately so: a camera being deleted or taken out of
   * service must not fail because the media server is down. A path left behind
   * points at a camera nobody is watching, and the next registration replaces
   * it.
   */
  async unregister(path: string): Promise<void> {
    if (!this.configured) return;
    try {
      await this.call("POST", `/v3/config/paths/delete/${encodeURIComponent(path)}`);
      this.logger.log(`Gateway path "${path}" removed`);
    } catch (error) {
      this.logger.warn(
        `Gateway path "${path}" could not be removed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** What the gateway currently makes of this path. Null when there is no gateway. */
  async health(path: string): Promise<GatewayPathHealth | null> {
    if (!this.configured) return null;

    try {
      const response = await this.call("GET", `/v3/paths/get/${encodeURIComponent(path)}`);
      if (!response?.ok) return { ready: false };

      const info = (await response.json()) as {
        ready?: boolean;
        tracks?: string[];
        readers?: unknown[];
        source?: { type?: string } | null;
      };

      return {
        ready: info.ready === true,
        readers: Array.isArray(info.readers) ? info.readers.length : undefined,
        tracks: info.tracks,
        sourceType: info.source?.type,
      };
    } catch {
      // A gateway that cannot be reached is not a camera fault, and saying
      // "not ready" is the honest answer to the only question asked here.
      return { ready: false };
    }
  }
}
