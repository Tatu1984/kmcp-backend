import { describe, expect, it, vi } from "vitest";

import {
  credentialFreeRtspUrl,
  credentialedRtspUrl,
  redactRtspUrl,
} from "../src/modules/cameras/streaming/rtsp-url";
import { StreamGatewayService } from "../src/modules/cameras/streaming/stream-gateway.service";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "../src/common/crypto/secret-box";
import { CamerasService } from "../src/modules/cameras/cameras.service";
import { AppException } from "../src/common/errors/app.exception";

/**
 * A camera's password is the only reversible secret this system stores, and the
 * address it belongs to is the one string here that must never be returned. So
 * these tests are mostly about what does *not* come out.
 */

const KEY = "test-encryption-key-at-least-32-characters-long";

describe("encoding credentials into an RTSP address", () => {
  it("percent-encodes a password containing @, which is the bug this exists for", () => {
    const url = credentialedRtspUrl({
      rtspUrl: "rtsp://10.20.0.4:554/Streaming/Channels/101",
      username: "admin",
      password: "admin@123",
    });

    // Without encoding this parses with a host of "123@10.20.0.4" and the
    // stream fails with an error about the network.
    expect(url).toBe("rtsp://admin:admin%40123@10.20.0.4:554/Streaming/Channels/101");
    expect(new URL(url).hostname).toBe("10.20.0.4");
    expect(new URL(url).password).toBe("admin%40123");
  });

  it("leaves an address that already carries credentials alone", () => {
    const given = "rtsp://someone:else@10.20.0.4:554/s1";
    expect(credentialedRtspUrl({ rtspUrl: given, username: "admin", password: "x" })).toBe(given);
  });

  it("hands back an unparseable address unchanged rather than repairing it", () => {
    expect(credentialedRtspUrl({ rtspUrl: "not a url", username: "a" })).toBe("not a url");
  });
});

describe("what may leave the server", () => {
  it("removes credentials from an address rather than masking them", () => {
    const stripped = credentialFreeRtspUrl("rtsp://admin:hunter2@10.20.0.4:554/s1");

    expect(stripped).toBe("rtsp://10.20.0.4:554/s1");
    // Not "***" — that still says there is an account called admin with a
    // password on it.
    expect(stripped).not.toContain("admin");
    expect(stripped).not.toContain("hunter2");
    expect(stripped).not.toContain("*");
  });

  it("still strips when the address will not parse", () => {
    expect(credentialFreeRtspUrl("rtsp:/admin:hunter2@10.20.0.4/s1")).not.toContain("hunter2");
  });

  it("redacts rather than removes for a log, where the shape is the useful part", () => {
    expect(redactRtspUrl("rtsp://admin:hunter2@10.20.0.4:554/s1")).toBe(
      "rtsp://***:***@10.20.0.4:554/s1",
    );
  });
});

describe("secrets at rest", () => {
  it("round-trips", () => {
    const stored = encryptSecret("admin@123", KEY);
    expect(decryptSecret(stored, KEY)).toBe("admin@123");
  });

  it("never stores the plaintext", () => {
    expect(encryptSecret("hunter2", KEY)).not.toContain("hunter2");
  });

  it("gives two different ciphertexts for the same password", () => {
    // Otherwise the column can be read for equality: every camera sharing the
    // installer's default password becomes visible as a group.
    expect(encryptSecret("same", KEY)).not.toBe(encryptSecret("same", KEY));
  });

  it("refuses a tampered ciphertext instead of returning something plausible", () => {
    const stored = encryptSecret("admin", KEY);
    const parts = stored.split(":");
    parts[4] = Buffer.from("nonsense").toString("base64");
    expect(() => decryptSecret(parts.join(":"), KEY)).toThrow();
  });

  it("refuses the wrong key", () => {
    const stored = encryptSecret("admin", KEY);
    expect(() => decryptSecret(stored, `${KEY}-different`)).toThrow();
  });

  it("says what is missing when no key is configured, rather than using a built-in one", () => {
    expect(() => encryptSecret("admin", undefined)).toThrow(AppException);
    expect(() => encryptSecret("admin", undefined)).toThrow(/ENCRYPTION_KEY/);
  });

  it("recognises its own output and nothing else", () => {
    expect(isEncryptedSecret(encryptSecret("x", KEY))).toBe(true);
    expect(isEncryptedSecret("plain-text-password")).toBe(false);
    expect(isEncryptedSecret(null)).toBe(false);
  });
});

/** A ConfigService stand-in: the real one only ever gets `.get(key)` here. */
function config(values: Record<string, unknown>) {
  return { get: (key: string) => values[key] } as never;
}

describe("the streaming gateway", () => {
  it("reports itself unconfigured when there is no control URL", () => {
    const gateway = new StreamGatewayService(config({}));
    expect(gateway.configured).toBe(false);
    expect(gateway.playbackUrls("cam-1")).toBeNull();
  });

  it("builds HLS and WHEP addresses from the public bases", () => {
    const gateway = new StreamGatewayService(
      config({
        MEDIAMTX_CONTROL_URL: "http://mediamtx:9997",
        MEDIAMTX_HLS_BASE: "https://video.kmcp.gov.in/",
        MEDIAMTX_WEBRTC_BASE: "https://webrtc.kmcp.gov.in",
      }),
    );

    expect(gateway.playbackUrls("cam-camac-01")).toEqual({
      hlsUrl: "https://video.kmcp.gov.in/cam-camac-01/index.m3u8",
      webrtcUrl: "https://webrtc.kmcp.gov.in/cam-camac-01/whep",
    });
  });

  it("does nothing at all when unconfigured, rather than failing a save", async () => {
    const gateway = new StreamGatewayService(config({}));
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await gateway.register("cam-1", { rtspUrl: "rtsp://10.20.0.4/s1" });
    await gateway.unregister("cam-1");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await gateway.health("cam-1")).toBeNull();
    fetchSpy.mockRestore();
  });
});

/**
 * The service's own guarantee, driven through a stub Prisma: whatever a camera
 * has stored, the shape that comes back carries neither credential.
 */
function makeService(camera: Record<string, unknown>) {
  const prisma = {
    camera: {
      findUnique: vi.fn().mockResolvedValue(camera),
      update: vi.fn().mockResolvedValue(camera),
    },
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const gateway = new StreamGatewayService(config({}));
  const service = new CamerasService(
    prisma as never,
    audit as never,
    gateway,
    config({ ENCRYPTION_KEY: KEY }),
  );
  return { service, prisma };
}

describe("the connection a manager is shown", () => {
  it("carries no username, no password and no userinfo", async () => {
    const { service } = makeService({
      id: "cam_1",
      code: "CAM-CAMAC-01",
      label: "North end",
      streetId: "str_camac",
      streamKey: null,
      rtspUrl: "rtsp://admin:hunter2@10.20.0.4:554/s1",
      onvifUrl: null,
      usernameEnc: encryptSecret("admin", KEY),
      passwordEnc: encryptSecret("hunter2", KEY),
      coverageSlots: 12,
      hasIR: true,
      hasPTZ: false,
      isActive: true,
      makeModel: "Hikvision",
      installedAt: null,
    });

    const connection = await service.connection("cam_1");
    const serialised = JSON.stringify(connection);

    expect(connection.rtspUrl).toBe("rtsp://10.20.0.4:554/s1");
    expect(connection.hasCredentials).toBe(true);
    expect(serialised).not.toContain("hunter2");
    expect(serialised).not.toContain("admin");
    expect(serialised).not.toContain("usernameEnc");
    expect(serialised).not.toContain("passwordEnc");
  });

  it("names the gateway path after the code when no stream key was given", async () => {
    const { service } = makeService({
      id: "cam_1",
      code: "CAM-CAMAC-01",
      streamKey: null,
      rtspUrl: null,
      onvifUrl: null,
      usernameEnc: null,
      passwordEnc: null,
      label: "x",
      streetId: "s",
      coverageSlots: null,
      hasIR: false,
      hasPTZ: false,
      isActive: true,
      makeModel: null,
      installedAt: null,
    });

    expect((await service.connection("cam_1")).path).toBe("cam-camac-01");
  });
});

describe("asking to watch", () => {
  const user = { id: "u1", role: "ADMIN", name: "A", zoneIds: [], sessionId: "s", isZoneScoped: false };

  it("says which piece is missing when the camera has no source", async () => {
    const { service, prisma } = makeService({
      id: "cam_1",
      code: "CAM-1",
      label: "x",
      streetId: "s",
      status: "ONLINE",
      street: { id: "s", name: "Camac Street", ward: null, zones: [] },
      streamKey: null,
      rtspUrl: null,
      isActive: true,
      usernameEnc: null,
      passwordEnc: null,
    });
    prisma.camera.findUnique.mockResolvedValue({
      id: "cam_1",
      code: "CAM-1",
      label: "x",
      streetId: "s",
      status: "ONLINE",
      street: { id: "s", name: "Camac Street", ward: null, zones: [] },
      streamKey: null,
      rtspUrl: null,
      isActive: true,
    });

    const answer = await service.playback("cam_1", user as never, {});
    expect(answer.available).toBe(false);
    expect(answer.reason).toBe("NO_SOURCE");
  });

  it("says so when there is a source but no gateway to serve it", async () => {
    const row = {
      id: "cam_1",
      code: "CAM-1",
      label: "x",
      streetId: "s",
      status: "ONLINE",
      street: { id: "s", name: "Camac Street", ward: null, zones: [] },
      streamKey: null,
      rtspUrl: "rtsp://10.20.0.4/s1",
      isActive: true,
    };
    const { service } = makeService(row);

    const answer = await service.playback("cam_1", user as never, {});
    expect(answer.available).toBe(false);
    expect(answer.reason).toBe("NO_GATEWAY");
    expect(answer.hlsUrl).toBeNull();
  });
});
