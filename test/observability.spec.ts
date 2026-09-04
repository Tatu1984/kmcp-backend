import { describe, expect, it } from "vitest";
import type { Breadcrumb, ErrorEvent } from "@sentry/nestjs";

import {
  REDACTED,
  redact,
  redactQueryString,
  redactUrl,
  scrubBreadcrumb,
  scrubEvent,
} from "../src/observability/scrub";

/**
 * The promise that lets this API report its failures at all.
 *
 * Error reporting sends a copy of a request to a third party, and the requests
 * this API handles carry registration numbers, citizen phone numbers and
 * metre-accurate positions. Stripping those is not a debugging convenience; it
 * is the condition on which the authority can permit any reporting.
 *
 * It is also the kind of rule that fails silently. A field added to a DTO ships
 * to Sentry and nothing anywhere goes red — the events keep arriving, they just
 * quietly contain more than they should. These tests are the only thing that
 * would notice, so they are written against the field names the schema actually
 * uses rather than against invented ones.
 *
 * The mirror of this file lives in the portal repository. A field added to one
 * scrub list and not the other leaks from whichever side was forgotten.
 */

describe("redacting a payload", () => {
  it("removes a registration number, a phone number and a position", () => {
    const cleaned = redact({
      id: "sess-1",
      plateNumber: "KA01AB1234",
      phone: "9000000000",
      startLat: 12.9716,
      startLng: 77.5946,
      status: "ACTIVE",
    }) as Record<string, unknown>;

    expect(cleaned).toEqual({
      id: "sess-1",
      plateNumber: REDACTED,
      phone: REDACTED,
      startLat: REDACTED,
      startLng: REDACTED,
      // Ids and states are what triage reads, and identify nobody.
      status: "ACTIVE",
    });
  });

  it("matches a field name however it is spelled", () => {
    // Prisma columns, Zod DTOs and hand-written query parameters disagree about
    // casing and underscores. A rule that caught only one spelling would leak.
    const cleaned = redact({
      plate_number: "KA01AB1234",
      PhoneNumber: "9000000000",
      "contact-phone": "9000000001",
      centerLat: 12.97,
    }) as Record<string, string>;

    expect(Object.values(cleaned)).toEqual([REDACTED, REDACTED, REDACTED, REDACTED]);
  });

  it("removes the credentials and vendor identifiers too", () => {
    const cleaned = redact({
      password: "hunter2",
      refreshToken: "rt_live_x",
      otp: "123456",
      bankAccountNo: "0001234567",
      gstin: "29ABCDE1234F1Z5",
      vendorId: "ven-1",
    }) as Record<string, string>;

    expect(cleaned.vendorId).toBe("ven-1");
    expect(Object.entries(cleaned).filter(([key]) => key !== "vendorId").map(([, v]) => v)).toEqual([
      REDACTED,
      REDACTED,
      REDACTED,
      REDACTED,
      REDACTED,
    ]);
  });

  it("reaches into nested objects and arrays", () => {
    // A settlement detail is lines inside a settlement; a session page is rows.
    // Redacting only the top level would cover almost nothing this API returns.
    const cleaned = redact({
      items: [{ session: { plateNumber: "KA01AB1234", code: "S-1" } }],
    }) as { items: { session: Record<string, string> }[] };

    expect(cleaned.items[0].session).toEqual({ plateNumber: REDACTED, code: "S-1" });
  });

  it("gives up rather than recursing forever on a cyclic structure", () => {
    const cyclic: Record<string, unknown> = { plateNumber: "KA01AB1234" };
    cyclic.self = cyclic;

    // The depth cap is what makes this safe. An event is not worth a stack
    // overflow inside the error handler.
    expect(() => redact(cyclic)).not.toThrow();
  });
});

describe("redacting a query string", () => {
  it("handles each of the three shapes Sentry reports one in", () => {
    expect(redactQueryString("?plate=KA01AB1234&page=2")).toBe(
      `?plate=${encodeURIComponent(REDACTED)}&page=2`,
    );
    expect(redactQueryString([["phone", "9000000000"], ["page", "2"]])).toEqual([
      ["phone", REDACTED],
      ["page", "2"],
    ]);
    expect(redactQueryString({ lat: "12.97", page: "2" })).toEqual({ lat: REDACTED, page: "2" });
  });

  it("leaves a URL without a query alone", () => {
    expect(redactUrl("/api/v1/zones/zone-1")).toBe("/api/v1/zones/zone-1");
  });

  it("cleans the parameters out of a URL that carries them inline", () => {
    // `GET /sessions?plate=…` is the plate lookup an attendant's handset makes,
    // and the single most likely place for one to reach a report.
    expect(redactUrl("/api/v1/sessions?plate=KA01AB1234&status=ACTIVE")).toBe(
      `/api/v1/sessions?plate=${encodeURIComponent(REDACTED)}&status=ACTIVE`,
    );
  });
});

describe("scrubbing a whole event", () => {
  it("cleans the body, the query, the URL, the headers and the cookies", () => {
    const event = scrubEvent({
      request: {
        url: "https://api.kmcp.test/api/v1/sessions?plate=KA01AB1234",
        query_string: "plate=KA01AB1234",
        data: { plateNumber: "KA01AB1234", zoneId: "zone-1" },
        headers: {
          authorization: "Bearer live-token",
          "x-cron-secret": "s3cret",
          "x-request-id": "req-42",
          "content-type": "application/json",
        },
        cookies: { session: "value" },
      },
      user: { id: "user-1", email: "officer@example.gov.in", ip_address: "203.0.113.9" },
    } as unknown as ErrorEvent);

    expect(event.request?.data).toEqual({ plateNumber: REDACTED, zoneId: "zone-1" });
    expect(event.request?.query_string).toBe(`plate=${encodeURIComponent(REDACTED)}`);
    expect(event.request?.url).toContain(encodeURIComponent(REDACTED));
    // Live credentials, and neither aids debugging.
    expect(event.request?.headers).not.toHaveProperty("authorization");
    expect(event.request?.headers).not.toHaveProperty("x-cron-secret");
    expect(event.request?.cookies).toBeUndefined();
    /**
     * The one header that must survive. It is the id RequestIdMiddleware
     * assigned, the id in the response envelope's `meta.requestId`, and the id
     * on every audit row the request wrote — the whole reason for reporting to
     * be wired at all.
     */
    expect(event.request?.headers?.["x-request-id"]).toBe("req-42");
    // Which account hit this is most of triage; who they are is not.
    expect(event.user).toEqual({ id: "user-1" });
  });

  it("drops a console breadcrumb rather than pretending to clean it", () => {
    // Every Nest log line becomes one, including the request logging that
    // prints a full URL. A flattened log message has no field names to match
    // on, and a trail that looks scrubbed and is not is worse than none.
    expect(scrubBreadcrumb({ category: "console", message: "GET /sessions?plate=KA01AB1234" })).toBeNull();
  });

  it("cleans the URL out of an outbound-request breadcrumb", () => {
    const crumb = scrubBreadcrumb({
      category: "http",
      data: { method: "GET", url: "https://sms.example/send?phone=9000000000", status_code: 500 },
    } as Breadcrumb);

    expect(crumb?.data?.url).toBe(`https://sms.example/send?phone=${encodeURIComponent(REDACTED)}`);
    expect(crumb?.data?.status_code).toBe(500);
  });
});
