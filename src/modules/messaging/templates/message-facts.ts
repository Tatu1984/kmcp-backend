import { APP } from "@/config/app.constants";

/**
 * What happened, stated once.
 *
 * This type is the whole reason an SMS and an email of the same event cannot
 * disagree. A template does not write four messages; it produces one set of
 * facts, and the four renderers below are pure functions of that set. There is
 * no path by which a channel can introduce a number the others do not have, or
 * round one differently, because no channel ever sees the payload.
 */
export interface MessageFacts {
  /** One line. The SMS opener, the email subject, the in-app title. */
  headline: string;
  /** The facts themselves, in the order a person would want to read them. */
  details: { label: string; value: string }[];
  /** Optional call to action. Omitted entirely when there is no public app URL. */
  action?: { label: string; url: string };
  /** A closing line — a helpline, a caveat. Never a fact. */
  footer?: string;
}

/** One event, rendered for every channel from one set of facts. */
export interface RenderedMessage {
  facts: MessageFacts;
  sms: string;
  whatsapp: string;
  email: { subject: string; body: string };
  inApp: { title: string; body: string; href?: string };
}

/**
 * Three GSM-7 segments.
 *
 * Transactional SMS in India is billed per 160-character segment, and a receipt
 * that runs to six of them is a cost the authority pays on every parking event.
 * Truncation is visible — an ellipsis — rather than a silent cut, because a
 * half-printed amount is worse than an obviously shortened message.
 */
const SMS_LIMIT = 459;

export function renderAll(facts: MessageFacts): RenderedMessage {
  return {
    facts,
    sms: renderSms(facts),
    whatsapp: renderWhatsApp(facts),
    email: { subject: facts.headline, body: renderEmail(facts) },
    inApp: {
      title: facts.headline,
      body: facts.details.map((d) => `${d.label}: ${d.value}`).join(" · "),
      href: facts.action?.url,
    },
  };
}

/**
 * Comma-separated on one run of text, because an SMS with a newline per fact
 * looks like four messages arrived. The sender name is prefixed so a citizen
 * with no contact saved knows who is writing before they read the amount.
 */
function renderSms(facts: MessageFacts): string {
  const parts = [
    `${APP.name}: ${facts.headline}.`,
    facts.details.map((d) => `${d.label} ${d.value}`).join(", "),
    facts.action?.url ?? "",
  ].filter(Boolean);

  const body = parts.join(" ");
  return body.length <= SMS_LIMIT ? body : `${body.slice(0, SMS_LIMIT - 1).trimEnd()}…`;
}

/**
 * WhatsApp renders a small amount of markup, and a bulleted list of labelled
 * values is genuinely easier to scan on a phone than the SMS run-on. The facts
 * are the same facts, in the same order — only the whitespace differs.
 */
function renderWhatsApp(facts: MessageFacts): string {
  const lines = [
    `*${facts.headline}*`,
    "",
    ...facts.details.map((d) => `• ${d.label}: *${d.value}*`),
  ];
  if (facts.action) lines.push("", `${facts.action.label}: ${facts.action.url}`);
  if (facts.footer) lines.push("", `_${facts.footer}_`);
  return lines.join("\n");
}

/** Plain text. The Resend adapter wraps this for clients that prefer HTML. */
function renderEmail(facts: MessageFacts): string {
  const lines = [
    facts.headline,
    "",
    ...facts.details.map((d) => `${d.label}: ${d.value}`),
  ];
  if (facts.action) lines.push("", `${facts.action.label}: ${facts.action.url}`);
  if (facts.footer) lines.push("", facts.footer);
  return lines.join("\n");
}

/**
 * Paise to rupees.
 *
 * The money path is integer paise end to end — there is no floating point
 * anywhere in it — so this is the single point where an amount becomes a string
 * a person reads, and it is exact by construction rather than by rounding.
 */
export function money(paise: number): string {
  const negative = paise < 0;
  const absolute = Math.abs(Math.trunc(paise));
  const rupees = Math.floor(absolute / 100);
  const remainder = String(absolute % 100).padStart(2, "0");
  return `${negative ? "-" : ""}₹${groupIndian(rupees)}.${remainder}`;
}

/** 12,34,567 — lakhs and crores, not thousands. A municipal report is read locally. */
function groupIndian(value: number): string {
  const digits = String(value);
  if (digits.length <= 3) return digits;
  const head = digits.slice(0, -3);
  const tail = digits.slice(-3);
  return `${head.replace(/\B(?=(\d\d)+(?!\d))/g, ",")},${tail}`;
}

/**
 * A date and time as it is spoken in Kolkata.
 *
 * Every timestamp in the database is UTC. A citizen reading "14:30" on a
 * receipt for parking they did at 20:00 would reasonably conclude the receipt
 * was for someone else's car, so the conversion happens here, once, for every
 * channel.
 */
export function when(value: Date): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: APP.timezone,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(value);
}

/** Date only, for validity windows and settlement periods. */
export function onDate(value: Date): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: APP.timezone,
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(value);
}

/** "2 h 15 min" — the unit a parking charge is actually argued about in. */
export function duration(minutes: number): string {
  const whole = Math.max(0, Math.round(minutes));
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  if (hours === 0) return `${rest} min`;
  if (rest === 0) return `${hours} h`;
  return `${hours} h ${rest} min`;
}
