import { createHash } from "node:crypto";

/**
 * The fingerprint of what a document says.
 *
 * Two things hang off this. It is the object-storage address a generated
 * document is stored at, which is how "regenerate" decides whether to render
 * again or hand back the file it already has: the same record produces the same
 * digest produces the same key, and a record that has since changed produces a
 * different one. And on the audit-trail export it is printed on the paper and
 * recorded in the audit log, which is what makes that document checkable.
 *
 * `JSON.stringify` alone cannot do this job. Its output depends on the order
 * the keys happened to be inserted in, so the same settlement selected by two
 * different queries would hash differently and every reader would render a
 * fresh copy of an identical document. Sorting is the whole point.
 */
function canonicalise(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalise);
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonicalise(source[key]);
    return out;
  }
  // Decimal columns arrive as objects with a toString; numbers and strings pass
  // through untouched so a paise amount hashes as the integer it is.
  return typeof value === "bigint" ? value.toString() : value;
}

/** A stable SHA-256 over the content, hex encoded. */
export function digestOf(content: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalise(content))).digest("hex");
}

/** The first sixteen characters, for printing where a full hash would not fit. */
export const shortDigest = (digest: string): string =>
  digest.slice(0, 16).replace(/(.{4})(?=.)/g, "$1 ");
