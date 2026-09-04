import { beforeEach, describe, expect, it, vi } from "vitest";
import { MediaPurpose } from "@prisma/client";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { MediaService } from "../src/modules/media/media.service";
import { MediaAccessService } from "../src/modules/media/media-access.service";
import { RolesService } from "../src/common/rbac/roles.service";
import { AppException } from "../src/common/errors/app.exception";

/**
 * Who may be handed a read URL for a file.
 *
 * A signed URL is a bearer credential for the bytes behind it: once minted it
 * cannot be recalled, and the bucket holds vendor PAN cards, bank proofs and
 * timestamped photographs of private vehicles. Before this check existed, any
 * authenticated account — a citizen, an attendant at an unrelated vendor —
 * could mint one for any media id in the system simply by guessing or
 * enumerating it.
 *
 * These cases are the ones that would not show up in any screen: the portal
 * only ever asks for ids it already has, so the hole is invisible until
 * somebody calls the endpoint directly.
 */

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn().mockResolvedValue("https://storage.example/signed"),
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = vi.fn();
  },
  GetObjectCommand: class {
    constructor(public readonly input: unknown) {}
  },
  PutObjectCommand: class {
    constructor(public readonly input: unknown) {}
  },
  DeleteObjectCommand: class {
    constructor(public readonly input: unknown) {}
  },
}));

/** The roles exactly as they are seeded, because the grants are what decide this. */
const ROLES = [
  { code: "SUPER_ADMIN", label: "Super", description: null, permissions: [], isSystem: true, isZoneScoped: false, isSuperuser: true },
  {
    code: "ADMIN",
    label: "Admin",
    description: null,
    permissions: ["session.read", "vendor.read", "payment.read", "incident.manage", "report.generate"],
    isSystem: true,
    isZoneScoped: false,
    isSuperuser: false,
  },
  {
    code: "VENDOR",
    label: "Vendor",
    description: null,
    // A vendor genuinely holds these, for its own kerb. That is the grant the
    // old code let it point at anybody's files.
    permissions: ["zone.read", "session.read", "attendant.write", "payment.read", "settlement.read"],
    isSystem: true,
    isZoneScoped: true,
    isSuperuser: false,
  },
  {
    code: "ATTENDANT",
    label: "Attendant",
    description: null,
    permissions: ["zone.read", "session.read"],
    isSystem: true,
    isZoneScoped: true,
    isSuperuser: false,
  },
  { code: "CITIZEN", label: "Citizen", description: null, permissions: [], isSystem: true, isZoneScoped: false, isSuperuser: false },
];

const user = (over: Record<string, unknown>) => ({
  id: "usr_x",
  role: "CITIZEN",
  name: "Somebody",
  vendorId: null,
  attendantId: null,
  zoneIds: [] as string[],
  isZoneScoped: false,
  sessionId: "sess_1",
  ...over,
});

const SUPER = user({ id: "usr_super", role: "SUPER_ADMIN" });
const ADMIN = user({ id: "usr_admin", role: "ADMIN" });
const CITIZEN = user({ id: "usr_citizen", role: "CITIZEN" });
/** The citizen who has claimed WB02AB1234 in the app. */
const OWNER = user({ id: "usr_owner", role: "CITIZEN" });
const VENDOR_A = user({ id: "usr_ven_a", role: "VENDOR", vendorId: "ven_a", isZoneScoped: true, zoneIds: ["zn_1"] });
const VENDOR_B = user({ id: "usr_ven_b", role: "VENDOR", vendorId: "ven_b", isZoneScoped: true, zoneIds: ["zn_9"] });
const ATTENDANT_B = user({
  id: "usr_att_b",
  role: "ATTENDANT",
  vendorId: "ven_b",
  attendantId: "att_b",
  isZoneScoped: true,
  zoneIds: ["zn_9"],
});

const media = (id: string, purpose: MediaPurpose, uploadedById: string | null) => ({
  id,
  key: `${purpose.toLowerCase()}/2026/09/04/${id}.jpg`,
  bucket: "kmcp-media",
  mimeType: "image/jpeg",
  sizeBytes: 12_345,
  sha256: null,
  purpose,
  capturedAt: null,
  lat: null,
  lng: null,
  uploadedById,
  isImmutable: false,
  createdAt: new Date("2026-09-01T10:00:00Z"),
});

/** Vendor A's PAN card, filed by a back-office user rather than by the vendor. */
const KYC = media("med_kyc", MediaPurpose.KYC_DOCUMENT, "usr_admin");
/** The entry photograph on a session vendor A ran for the owner's car. */
const EVIDENCE = media("med_evidence", MediaPurpose.SESSION_EVIDENCE_START, "usr_att_a");
/** A profile photograph belonging to one citizen. */
const PROFILE = media("med_profile", MediaPurpose.PROFILE, "usr_citizen");

function makeService() {
  const rows = new Map([
    [KYC.id, KYC],
    [EVIDENCE.id, EVIDENCE],
    [PROFILE.id, PROFILE],
  ]);

  const prisma: any = {
    role: { findMany: vi.fn().mockResolvedValue(ROLES) },
    media: {
      findUnique: vi.fn().mockImplementation(({ where }: any) => rows.get(where.id) ?? null),
      findMany: vi
        .fn()
        .mockImplementation(({ where }: any) =>
          where.id.in.map((id: string) => rows.get(id)).filter(Boolean),
        ),
    },
    vendorDocument: {
      findMany: vi.fn().mockImplementation(({ where }: any) =>
        where.mediaId.in.includes(KYC.id) ? [{ mediaId: KYC.id, vendorId: "ven_a" }] : [],
      ),
    },
    parkingSession: {
      findMany: vi.fn().mockResolvedValue([
        {
          evidenceStartMediaId: EVIDENCE.id,
          evidenceEndMediaId: null,
          zoneId: "zn_1",
          vendorId: "ven_a",
          attendantId: "att_a",
          vehicle: { ownerUserId: OWNER.id },
        },
      ]),
    },
    incident: { findMany: vi.fn().mockResolvedValue([]) },
    receipt: { findMany: vi.fn().mockResolvedValue([]) },
    reportJob: { findMany: vi.fn().mockResolvedValue([]) },
  };

  const config: any = {
    get: vi.fn().mockImplementation((key: string) =>
      ({
        S3_ENDPOINT: "https://s3.example",
        S3_ACCESS_KEY_ID: "key",
        S3_SECRET_ACCESS_KEY: "secret",
        S3_REGION: "auto",
        S3_BUCKET: "kmcp-media",
        MEDIA_SIGNED_URL_TTL: 900,
      })[key],
    ),
  };

  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const access = new MediaAccessService(prisma, new RolesService(prisma));

  return { service: new MediaService(prisma, config, audit as any, access), prisma };
}

async function expectRefusal(promise: Promise<unknown>) {
  await expect(promise).rejects.toBeInstanceOf(AppException);
  await promise.catch((error: AppException) => expect(error.code).toBe("FORBIDDEN"));
}

beforeEach(() => {
  vi.mocked(getSignedUrl).mockClear();
});

describe("reading one file", () => {
  it("refuses a citizen a vendor's KYC document", async () => {
    const { service } = makeService();

    // The whole finding: nothing about this citizen relates to vendor A, and
    // the file is a PAN card and a bank proof.
    await expectRefusal(service.signedUrl(KYC.id, CITIZEN as any));
  });

  it("does not sign anything it is about to refuse", async () => {
    const { service } = makeService();
    await service.signedUrl(KYC.id, CITIZEN as any).catch(() => undefined);

    // A minted URL cannot be recalled, so the refusal has to come first rather
    // than be wrapped around a call that has already happened.
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it("allows the vendor the document is about", async () => {
    const { service } = makeService();

    // Filed by a back-office user, so this passes on the vendor match rather
    // than on "you uploaded it".
    const result = await service.signedUrl(KYC.id, VENDOR_A as any);
    expect(result.url).toBe("https://storage.example/signed");
  });

  it("refuses one vendor another vendor's document", async () => {
    const { service } = makeService();
    await expectRefusal(service.signedUrl(KYC.id, VENDOR_B as any));
  });

  it("allows a super admin anything", async () => {
    const { service } = makeService();

    // The break-glass account holds no permissions at all in the seed, so this
    // only works if the superuser bypass is consulted before the grants are.
    for (const id of [KYC.id, EVIDENCE.id, PROFILE.id]) {
      await expect(service.signedUrl(id, SUPER as any)).resolves.toMatchObject({ id });
    }
  });

  it("allows back-office staff who hold the covering permission", async () => {
    const { service } = makeService();
    await expect(service.signedUrl(KYC.id, ADMIN as any)).resolves.toMatchObject({ id: KYC.id });
  });
});

describe("parking evidence", () => {
  it("allows the citizen whose vehicle was photographed", async () => {
    const { service } = makeService();

    // A photograph of your own car, at a known place and time, is yours.
    await expect(service.signedUrl(EVIDENCE.id, OWNER as any)).resolves.toMatchObject({
      id: EVIDENCE.id,
    });
  });

  it("refuses a citizen whose vehicle it is not", async () => {
    const { service } = makeService();
    await expectRefusal(service.signedUrl(EVIDENCE.id, CITIZEN as any));
  });

  it("allows the vendor that ran the session", async () => {
    const { service } = makeService();
    await expect(service.signedUrl(EVIDENCE.id, VENDOR_A as any)).resolves.toMatchObject({
      id: EVIDENCE.id,
    });
  });

  it("refuses an attendant at another vendor despite their session.read", async () => {
    const { service } = makeService();

    // An attendant holds session.read so they can work their own kerb. That
    // grant must not become a licence to pull photographs of every vehicle in
    // the city — the vendor match is the whole of a field account's access.
    await expectRefusal(service.signedUrl(EVIDENCE.id, ATTENDANT_B as any));
  });
});

describe("profile photographs", () => {
  it("belongs to the person in it and to nobody else", async () => {
    const { service } = makeService();

    await expect(service.signedUrl(PROFILE.id, CITIZEN as any)).resolves.toMatchObject({
      id: PROFILE.id,
    });
    // No permission in the catalogue covers somebody else's profile picture.
    await expectRefusal(service.signedUrl(PROFILE.id, ADMIN as any));
  });
});

describe("the batch route", () => {
  it("signs a batch the caller may read", async () => {
    const { service } = makeService();
    const urls = await service.signedUrls([EVIDENCE.id, PROFILE.id], SUPER as any);
    expect(urls).toHaveLength(2);
  });

  it("refuses the whole batch when one id is forbidden", async () => {
    const { service } = makeService();

    // Vendor A may read its own KYC and its own session evidence, but not this
    // citizen's profile photograph. Signing the two it may read would make the
    // batch route the way around the single-item check.
    await expectRefusal(service.signedUrls([KYC.id, EVIDENCE.id, PROFILE.id], VENDOR_A as any));
  });

  it("signs nothing at all when it refuses a batch", async () => {
    const { service } = makeService();
    await service.signedUrls([KYC.id, PROFILE.id], VENDOR_A as any).catch(() => undefined);
    expect(getSignedUrl).not.toHaveBeenCalled();
  });
});
