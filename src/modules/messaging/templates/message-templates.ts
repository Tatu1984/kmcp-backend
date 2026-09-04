import { z } from "zod";

import { APP } from "@/config/app.constants";
import { AppException } from "@/common/errors/app.exception";
import { duration, money, onDate, renderAll, when, type MessageFacts, type RenderedMessage } from "./message-facts";

/**
 * The message catalogue.
 *
 * Wording lives here and nowhere else — not in the portal, not in a provider's
 * dashboard, not duplicated per channel. Two properties follow from that, and
 * both are the point of the design:
 *
 *  1. A template produces *facts*, once, and the renderers in `message-facts`
 *     turn that one value into SMS, WhatsApp, email and in-app text. An SMS and
 *     an email of the same event therefore cannot disagree about an amount, a
 *     plate or a time — there is no second place for the number to come from.
 *
 *  2. Every payload is validated by a schema before it renders. A delivery row
 *     stores `template` and `payload`, so a message can be re-rendered months
 *     later from the row alone; a payload that was never checked on the way in
 *     is a message that cannot be reproduced on the way out.
 *
 * Dates are coerced rather than required to be `Date` instances, because a
 * payload that has been through the Json column comes back as an ISO string and
 * must render identically to the one that has not.
 */

const Money = z.number().int();
const Plate = z.string().trim().min(1).max(16);

/** Optional throughout: a link is dropped rather than pointed at the wrong host. */
export interface LinkContext {
  /** `PUBLIC_APP_URL`, if the deployment has one. */
  appUrl?: string;
}

export interface MessageTemplate<TSchema extends z.ZodType = z.ZodType> {
  key: string;
  /** Shown in the delivery log and the API docs. */
  description: string;
  schema: TSchema;
  /** Declared as a method, so the catalogue can hold templates of every shape. */
  facts(payload: z.infer<TSchema>, links: LinkContext): MessageFacts;
}

function template<TSchema extends z.ZodType>(
  key: string,
  description: string,
  schema: TSchema,
  facts: (payload: z.infer<TSchema>, links: LinkContext) => MessageFacts,
): MessageTemplate<TSchema> {
  return { key, description, schema, facts };
}

/** Builds an action, or nothing at all when the deployment has no public app. */
function link(links: LinkContext, label: string, path: string): MessageFacts["action"] {
  if (!links.appUrl) return undefined;
  return { label, url: `${links.appUrl.replace(/\/+$/, "")}${path}` };
}

const HELPLINE = `Queries: ${APP.name} parking helpdesk.`;

// ---------------------------------------------------------------- the catalogue

const receiptIssued = template(
  "receipt.issued",
  "The receipt for a payment, sent or re-sent to the payer.",
  z.object({
    receiptNumber: z.string().trim().min(1),
    amount: Money,
    plateNumber: Plate,
    zoneName: z.string().trim().min(1),
    paidAt: z.coerce.date(),
    mode: z.string().trim().min(1),
    sessionCode: z.string().trim().optional(),
  }),
  (p, links) => ({
    headline: `Receipt ${p.receiptNumber} for ${p.plateNumber}`,
    details: [
      { label: "Amount", value: money(p.amount) },
      { label: "Zone", value: p.zoneName },
      { label: "Paid", value: when(p.paidAt) },
      { label: "Mode", value: p.mode },
      ...(p.sessionCode ? [{ label: "Session", value: p.sessionCode }] : []),
    ],
    action: link(links, "View receipt", `/receipts/${p.receiptNumber}`),
    footer: "Keep this for your records.",
  }),
);

const passIssued = template(
  "pass.issued",
  "A parking pass and its QR code, sent to the holder.",
  z.object({
    holderName: z.string().trim().min(1),
    planName: z.string().trim().min(1),
    plateNumber: Plate,
    validFrom: z.coerce.date(),
    validTo: z.coerce.date(),
    passCode: z.string().trim().min(1),
  }),
  (p, links) => ({
    headline: `Your ${p.planName} parking pass is active`,
    details: [
      { label: "Vehicle", value: p.plateNumber },
      { label: "Valid from", value: onDate(p.validFrom) },
      { label: "Valid to", value: onDate(p.validTo) },
      { label: "Pass code", value: p.passCode },
    ],
    // The QR image is not attached: an SMS cannot carry one and an emailed
    // image is routinely stripped. The code is the credential; the app renders
    // it as a QR at the kerb, where a scanner is actually present.
    action: link(links, "Show your pass", `/passes/${p.passCode}`),
    footer: "Show the pass code or its QR in the app to the attendant.",
  }),
);

const passRenewal = template(
  "pass.renewal",
  "A prompt to buy the next pass before this one lapses.",
  z.object({
    holderName: z.string().trim().min(1),
    planName: z.string().trim().min(1),
    plateNumber: Plate,
    validTo: z.coerce.date(),
    price: Money.optional(),
    daysLeft: z.number().int(),
  }),
  (p, links) => ({
    headline:
      p.daysLeft <= 0
        ? `Your ${p.planName} pass for ${p.plateNumber} has expired`
        : `Your ${p.planName} pass for ${p.plateNumber} expires in ${p.daysLeft} day${p.daysLeft === 1 ? "" : "s"}`,
    details: [
      { label: "Vehicle", value: p.plateNumber },
      { label: "Expires", value: onDate(p.validTo) },
      ...(p.price === undefined ? [] : [{ label: "Renewal", value: money(p.price) }]),
    ],
    // Renewing is a purchase, not a status change: the holder buys a fresh pass
    // in the app. All the portal can do is point them at it.
    action: link(links, "Renew now", `/passes/renew?plate=${encodeURIComponent(p.plateNumber)}`),
    footer: "Parking without a valid pass is charged at the standard tariff.",
  }),
);

const sessionStarted = template(
  "session.started",
  "Confirmation that a parking session has begun.",
  z.object({
    sessionCode: z.string().trim().min(1),
    plateNumber: Plate,
    zoneName: z.string().trim().min(1),
    slotLabel: z.string().trim().optional(),
    startAt: z.coerce.date(),
  }),
  (p, links) => ({
    headline: `Parking started for ${p.plateNumber}`,
    details: [
      { label: "Zone", value: p.zoneName },
      ...(p.slotLabel ? [{ label: "Slot", value: p.slotLabel }] : []),
      { label: "From", value: when(p.startAt) },
      { label: "Ref", value: p.sessionCode },
    ],
    action: link(links, "Track and pay", `/sessions/${p.sessionCode}`),
    footer: HELPLINE,
  }),
);

const sessionOverstay = template(
  "session.overstay",
  "A vehicle has been parked past the time it paid for.",
  z.object({
    sessionCode: z.string().trim().min(1),
    plateNumber: Plate,
    zoneName: z.string().trim().min(1),
    minutesOver: z.number().int().nonnegative(),
    payable: Money.optional(),
  }),
  (p, links) => ({
    headline: `${p.plateNumber} has overstayed in ${p.zoneName}`,
    details: [
      { label: "Over by", value: duration(p.minutesOver) },
      ...(p.payable === undefined ? [] : [{ label: "Now payable", value: money(p.payable) }]),
      { label: "Ref", value: p.sessionCode },
    ],
    action: link(links, "End and pay", `/sessions/${p.sessionCode}`),
    footer: "Continued overstay may attract a penalty.",
  }),
);

const shiftVariance = template(
  "shift.variance",
  "A closed shift's cash deposit did not match what was collected.",
  z.object({
    attendantName: z.string().trim().min(1),
    shiftRef: z.string().trim().min(1),
    closedAt: z.coerce.date(),
    expected: Money,
    deposited: Money,
    variance: Money,
  }),
  (p, links) => ({
    // Named as a discrepancy, not an accusation. A variance is a number that
    // has to be explained; it is not yet a finding, and the wording a person
    // receives should not decide that for them.
    headline: `Cash variance on ${p.attendantName}'s shift ${p.shiftRef}`,
    details: [
      { label: "Expected", value: money(p.expected) },
      { label: "Deposited", value: money(p.deposited) },
      { label: "Variance", value: money(p.variance) },
      { label: "Closed", value: when(p.closedAt) },
    ],
    action: link(links, "Review the shift", `/shifts/${p.shiftRef}`),
    footer: "Please reconcile with the supervisor before the next shift.",
  }),
);

const settlementPending = template(
  "settlement.pending",
  "A vendor settlement is waiting for approval.",
  z.object({
    vendorName: z.string().trim().min(1),
    settlementId: z.string().trim().min(1),
    periodStart: z.coerce.date(),
    periodEnd: z.coerce.date(),
    vendorShare: Money,
    governmentShare: Money,
  }),
  (p, links) => ({
    headline: `Settlement for ${p.vendorName} is awaiting approval`,
    details: [
      { label: "Period", value: `${onDate(p.periodStart)} – ${onDate(p.periodEnd)}` },
      { label: "Vendor share", value: money(p.vendorShare) },
      { label: "Government share", value: money(p.governmentShare) },
      { label: "Ref", value: p.settlementId },
    ],
    action: link(links, "Open the settlement", `/settlements/${p.settlementId}`),
  }),
);

/**
 * The last two are not events the platform raises on its own — they are the two
 * portal controls that send something a person has just typed or just run. They
 * still go through the same catalogue so the delivery log, the retry and the
 * per-channel rendering are identical to everything else.
 */

const citizenAnnouncement = template(
  "citizen.announcement",
  "A message an officer composed, sent to a selection of citizens.",
  z.object({
    title: z.string().trim().min(1).max(120),
    body: z.string().trim().min(1).max(600),
    url: z.string().trim().max(300).optional(),
  }),
  (p) => ({
    headline: p.title,
    details: [{ label: "Notice", value: p.body }],
    // The officer's own URL, not one we build: an announcement may point at a
    // road closure notice on the authority's site, which is not this app.
    action: p.url ? { label: "More", url: p.url } : undefined,
    footer: `Issued by ${APP.fullName}.`,
  }),
);

const reportReady = template(
  "report.ready",
  "A generated report, mailed to the officer who asked for it.",
  z.object({
    reportName: z.string().trim().min(1),
    format: z.string().trim().min(1),
    generatedAt: z.coerce.date(),
    rangeLabel: z.string().trim().optional(),
    rowCount: z.number().int().nonnegative().optional(),
    url: z.string().trim().max(600).optional(),
  }),
  (p) => ({
    headline: `${p.reportName} is ready`,
    details: [
      { label: "Format", value: p.format.toUpperCase() },
      ...(p.rangeLabel ? [{ label: "Period", value: p.rangeLabel }] : []),
      ...(p.rowCount === undefined ? [] : [{ label: "Rows", value: String(p.rowCount) }]),
      { label: "Generated", value: when(p.generatedAt) },
    ],
    // A signed download URL, when the export went to object storage. It expires;
    // saying so is kinder than a dead link with no explanation.
    action: p.url ? { label: "Download", url: p.url } : undefined,
    footer: p.url ? "The download link expires shortly for security." : undefined,
  }),
);

const CATALOGUE: Record<string, MessageTemplate> = Object.fromEntries(
  [
    receiptIssued,
    passIssued,
    passRenewal,
    sessionStarted,
    sessionOverstay,
    shiftVariance,
    settlementPending,
    citizenAnnouncement,
    reportReady,
  ].map((t) => [t.key, t]),
);

export const TEMPLATE_KEYS = Object.keys(CATALOGUE) as [string, ...string[]];

export function isTemplateKey(key: string): boolean {
  return key in CATALOGUE;
}

export function describeTemplates(): { key: string; description: string }[] {
  return Object.values(CATALOGUE).map((t) => ({ key: t.key, description: t.description }));
}

/**
 * Validates a payload against its template and renders every channel from it.
 *
 * Rendering all four at once is not waste — it is the guarantee. The facts are
 * computed exactly once and the renderers are pure, so there is no arrangement
 * of calls in which the SMS and the email are built from different values.
 */
export function render(key: string, payload: unknown, links: LinkContext = {}): RenderedMessage {
  const chosen = CATALOGUE[key];
  if (!chosen) {
    throw new AppException("VALIDATION_FAILED", [{ field: "template", issue: `unknown template "${key}"` }]);
  }

  const parsed = chosen.schema.safeParse(payload);
  if (!parsed.success) {
    throw new AppException(
      "VALIDATION_FAILED",
      parsed.error.issues.map((i) => ({
        field: `payload.${i.path.join(".") || "(root)"}`,
        issue: i.message,
      })),
      `The payload does not match the "${key}" template.`,
    );
  }

  return renderAll(chosen.facts(parsed.data, links));
}
