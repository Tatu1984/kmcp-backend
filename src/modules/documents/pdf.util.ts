import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb, type RGB } from "pdf-lib";

/**
 * A very small typographic layer over pdf-lib.
 *
 * ## Why pdf-lib and not a headless browser
 *
 * This API deploys to Vercel, where each request runs in a short-lived Node
 * function with a read-only filesystem, a cold start budget measured in
 * hundreds of milliseconds, and a bundle size limit. Puppeteer or Playwright
 * would bring a ~150 MB Chromium with them; the usual workaround
 * (`@sparticuz/chromium`) still costs several seconds of cold start and needs
 * a writable `/tmp` to unpack into. For a receipt a citizen is waiting on at a
 * kerb, that is the wrong shape of dependency entirely — and it would make
 * "can we print a receipt" depend on whether a browser binary unpacked.
 *
 * `pdf-lib` is pure JavaScript with no native bindings and no filesystem
 * access. It writes the PDF byte structure directly, runs identically on a
 * laptop and in a serverless function, and adds about 400 KB to the bundle.
 * The cost is that there is no HTML or CSS: everything below is absolute
 * positioning, which is why this file exists rather than being spread across
 * the four document builders.
 *
 * ## Why there is no ₹ sign
 *
 * The fourteen standard PDF fonts are WinAnsi-encoded, and the rupee sign
 * (U+20B9) is not in WinAnsi — `drawText` throws on it rather than dropping it.
 * The alternative is embedding a Unicode TTF, which means shipping a font
 * binary in a serverless bundle and hoping the file tracer picks it up. For a
 * document that is already headed "Amounts in INR", "Rs." is the honest and
 * far more robust choice. `sanitise` below handles the same problem for the
 * Bengali and Devanagari that can legitimately appear in a vendor's registered
 * name: an unrepresentable character is transliterated where there is an
 * obvious equivalent and otherwise dropped, because a document that fails to
 * render is worse than one that renders a name in Latin script only.
 */

export const A4 = { width: 595.28, height: 841.89 } as const;

const MARGIN = 48;
const INK = rgb(0.09, 0.11, 0.15);
const MUTED = rgb(0.42, 0.45, 0.5);
const HAIRLINE = rgb(0.82, 0.84, 0.87);
const WASH = rgb(0.96, 0.97, 0.98);

/** Paise to a grouped decimal string. Never a float, never a currency glyph. */
export function rupees(paise: number): string {
  const negative = paise < 0;
  const whole = Math.floor(Math.abs(paise) / 100);
  const fraction = String(Math.abs(paise) % 100).padStart(2, "0");
  // Indian digit grouping: 12,34,567.89 rather than 1,234,567.89.
  const digits = String(whole);
  const head = digits.slice(0, -3);
  const tail = digits.slice(-3);
  const grouped = head ? `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${tail}` : tail;
  return `${negative ? "-" : ""}${grouped}.${fraction}`;
}

/** "Rs. 1,234.50" — the form every amount on every document takes. */
export const money = (paise: number): string => `Rs. ${rupees(paise)}`;

const SUBSTITUTIONS: Record<string, string> = {
  "₹": "Rs.",
  "–": "-",
  "—": "-",
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  "•": "-",
  "…": "...",
  " ": " ",
};

/**
 * Reduces a string to what a WinAnsi-encoded standard font can actually draw.
 *
 * Anything outside Latin-1 is dropped rather than substituted with a box,
 * because a run of boxes reads as a corrupted document while a name rendered
 * in its Latin transliteration reads as a name. Callers that need the original
 * — the audit export's content digest, for instance — hash the data before it
 * reaches here.
 */
export function sanitise(value: string): string {
  let out = "";
  for (const character of value) {
    const replacement = SUBSTITUTIONS[character];
    if (replacement !== undefined) {
      out += replacement;
      continue;
    }
    const code = character.codePointAt(0) ?? 0;
    // Printable ASCII and the Latin-1 supplement, which is what WinAnsi covers
    // without surprises. The C1 block (0x80–0x9F) is deliberately excluded.
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) out += character;
  }
  return out;
}

export interface TextOptions {
  size?: number;
  bold?: boolean;
  color?: RGB;
  /** Absolute x. Defaults to the left margin. */
  x?: number;
  /** Right-align inside a box that starts at `x` and is this wide. */
  width?: number;
  align?: "left" | "right" | "center";
  /**
   * Trim to `width` rather than overflowing into the next column.
   *
   * Table cells set this. Without it a long action name runs straight under the
   * column beside it, and two overlapping strings on an audit export are the
   * kind of thing that gets a document handed back.
   */
  clip?: boolean;
}

export interface Column {
  label: string;
  /** Share of the content width. Shares are normalised, so any scale works. */
  flex: number;
  align?: "left" | "right";
}

/**
 * A document being written top-down.
 *
 * The cursor only ever moves down. Every method that draws also advances it,
 * and anything that would run off the bottom starts a new page first — so a
 * settlement with four hundred lines paginates without any caller thinking
 * about it.
 */
export class Sheet {
  private readonly pages: PDFPage[] = [];
  private page!: PDFPage;
  private y = 0;

  private constructor(
    private readonly doc: PDFDocument,
    private readonly regular: PDFFont,
    private readonly bold: PDFFont,
  ) {}

  static async create(title: string, subject: string): Promise<Sheet> {
    const doc = await PDFDocument.create();
    doc.setTitle(sanitise(title));
    doc.setSubject(sanitise(subject));
    doc.setProducer("KMCP");
    doc.setCreator("KMCP Smart Street Parking Management System");

    const sheet = new Sheet(
      doc,
      await doc.embedFont(StandardFonts.Helvetica),
      await doc.embedFont(StandardFonts.HelveticaBold),
    );
    sheet.addPage();
    return sheet;
  }

  get contentWidth(): number {
    return A4.width - MARGIN * 2;
  }

  get cursor(): number {
    return this.y;
  }

  get pageCount(): number {
    return this.pages.length;
  }

  private addPage(): void {
    this.page = this.doc.addPage([A4.width, A4.height]);
    this.pages.push(this.page);
    this.y = A4.height - MARGIN;
  }

  /** Starts a new page when `height` more points would not fit above the footer. */
  ensure(height: number): void {
    if (this.y - height < MARGIN + 28) this.addPage();
  }

  /** Starts a new page unless the cursor is already above `floor`. */
  reserveBelow(floor: number): void {
    if (this.y < floor) this.addPage();
  }

  gap(points: number): this {
    this.y -= points;
    return this;
  }

  private font(bold?: boolean): PDFFont {
    return bold ? this.bold : this.regular;
  }

  /** The longest prefix that fits, with an ellipsis when anything was dropped. */
  private clip(text: string, font: PDFFont, size: number, width: number): string {
    if (font.widthOfTextAtSize(text, size) <= width) return text;
    let kept = text;
    while (kept.length > 1 && font.widthOfTextAtSize(`${kept}...`, size) > width) {
      kept = kept.slice(0, -1);
    }
    return `${kept.trimEnd()}...`;
  }

  private place(value: string, options: TextOptions, baseline: number): void {
    const size = options.size ?? 9.5;
    const font = this.font(options.bold);
    const sanitised = sanitise(value);
    const text =
      options.clip && options.width ? this.clip(sanitised, font, size, options.width) : sanitised;
    const left = options.x ?? MARGIN;

    let x = left;
    if (options.width && options.align && options.align !== "left") {
      const measured = font.widthOfTextAtSize(text, size);
      x =
        options.align === "right"
          ? left + options.width - measured
          : left + (options.width - measured) / 2;
    }

    this.page.drawText(text, { x, y: baseline, size, font, color: options.color ?? INK });
  }

  /** One line of text, advancing the cursor by its leading. */
  line(value: string, options: TextOptions = {}): this {
    const size = options.size ?? 9.5;
    const leading = size * 1.45;
    this.ensure(leading);
    this.y -= leading;
    this.place(value, options, this.y + leading * 0.22);
    return this;
  }

  /** Several pieces on one line, without advancing between them. */
  row(pieces: { value: string; options?: TextOptions }[], leading = 14): this {
    this.ensure(leading);
    this.y -= leading;
    for (const piece of pieces) {
      this.place(piece.value, piece.options ?? {}, this.y + leading * 0.25);
    }
    return this;
  }

  /** Wraps to the content width, or to `options.width` when one is given. */
  paragraph(value: string, options: TextOptions = {}): this {
    const size = options.size ?? 9;
    const font = this.font(options.bold);
    const limit = options.width ?? this.contentWidth;
    const words = sanitise(value).split(/\s+/).filter(Boolean);

    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) > limit && current) {
        this.line(current, options);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) this.line(current, options);
    return this;
  }

  rule(color: RGB = HAIRLINE): this {
    this.ensure(9);
    this.y -= 6;
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: A4.width - MARGIN, y: this.y },
      thickness: 0.6,
      color,
    });
    this.y -= 3;
    return this;
  }

  /**
   * The masthead every document carries.
   *
   * Deliberately identical across all four so that a citizen holding a receipt
   * and an officer holding a settlement statement can see at a glance that both
   * came from the same authority.
   */
  masthead(title: string, subtitle: string, reference?: string): this {
    this.line("KOLKATA MUNICIPAL CORPORATION", { size: 8, bold: true, color: MUTED });
    this.line("Smart Street Parking Management System", { size: 8, color: MUTED });
    this.gap(6);
    this.row([
      { value: title, options: { size: 17, bold: true } },
      ...(reference
        ? [
            {
              value: reference,
              options: {
                size: 10,
                bold: true,
                x: MARGIN,
                width: this.contentWidth,
                align: "right" as const,
              },
            },
          ]
        : []),
    ], 22);
    this.line(subtitle, { size: 9, color: MUTED });
    this.rule();
    return this;
  }

  /** A two-column label/value block — the particulars panel on every document. */
  particulars(pairs: [string, string][], columns = 2): this {
    const columnWidth = this.contentWidth / columns;
    for (let index = 0; index < pairs.length; index += columns) {
      const slice = pairs.slice(index, index + columns);
      this.ensure(24);
      this.y -= 12;
      slice.forEach(([label], column) => {
        this.place(
          label,
          { size: 7.5, bold: true, color: MUTED, x: MARGIN + column * columnWidth },
          this.y + 2,
        );
      });
      this.y -= 12;
      slice.forEach(([, value], column) => {
        this.place(value, { size: 10, x: MARGIN + column * columnWidth }, this.y + 2);
      });
    }
    this.gap(4);
    return this;
  }

  /**
   * A table that repeats its header on every page it spills onto.
   *
   * A statement whose second page is a wall of unlabelled numbers is not a
   * statement anybody can check.
   */
  table(columns: Column[], rows: string[][], options: { zebra?: boolean } = {}): this {
    const total = columns.reduce((sum, column) => sum + column.flex, 0);
    const widths = columns.map((column) => (column.flex / total) * this.contentWidth);
    const offsets = widths.map((_, index) => MARGIN + widths.slice(0, index).reduce((a, b) => a + b, 0));

    const header = (): void => {
      this.ensure(20);
      this.y -= 15;
      this.page.drawRectangle({
        x: MARGIN,
        y: this.y - 3,
        width: this.contentWidth,
        height: 16,
        color: WASH,
      });
      columns.forEach((column, index) => {
        this.place(
          column.label.toUpperCase(),
          {
            size: 7,
            bold: true,
            color: MUTED,
            x: offsets[index] + 4,
            width: widths[index] - 8,
            align: column.align ?? "left",
          },
          this.y + 2,
        );
      });
      this.y -= 4;
    };

    header();

    let printed = 0;
    for (const row of rows) {
      const before = this.pageCount;
      this.ensure(15);
      if (this.pageCount !== before) {
        // Spilled onto a new page: re-print the header before continuing.
        header();
        printed = 0;
      }
      this.y -= 14;
      if (options.zebra && printed % 2 === 1) {
        this.page.drawRectangle({
          x: MARGIN,
          y: this.y - 3.5,
          width: this.contentWidth,
          height: 14,
          color: WASH,
        });
      }
      row.forEach((cell, index) => {
        const column = columns[index];
        if (!column) return;
        this.place(
          cell,
          {
            size: 8.5,
            x: offsets[index] + 4,
            width: widths[index] - 8,
            align: column.align ?? "left",
            clip: true,
          },
          this.y,
        );
      });
      printed += 1;
    }

    this.gap(4);
    return this;
  }

  /** A right-aligned money summary: the block a reader's eye goes to first. */
  totals(entries: { label: string; amount: number; emphasis?: boolean }[]): this {
    const boxWidth = 240;
    const left = A4.width - MARGIN - boxWidth;

    for (const entry of entries) {
      this.ensure(16);
      this.y -= entry.emphasis ? 18 : 14;
      if (entry.emphasis) {
        this.page.drawRectangle({
          x: left,
          y: this.y - 4,
          width: boxWidth,
          height: 18,
          color: WASH,
        });
      }
      this.place(
        entry.label,
        { size: entry.emphasis ? 10 : 9, bold: entry.emphasis, x: left + 6 },
        this.y,
      );
      this.place(
        money(entry.amount),
        {
          size: entry.emphasis ? 11 : 9,
          bold: true,
          x: left,
          width: boxWidth - 6,
          align: "right",
        },
        this.y,
      );
    }
    this.gap(4);
    return this;
  }

  /**
   * Draws a QR code from the module matrix produced by `qrcode`.
   *
   * The matrix is drawn as filled rectangles rather than embedded as a raster
   * image: it keeps the code sharp at any print size, avoids a PNG encoder in
   * the bundle, and a tariff board is going to be enlarged and stuck on a pole.
   */
  qr(matrix: { size: number; data: Uint8Array | number[] }, x: number, y: number, side: number): this {
    const cell = side / matrix.size;
    this.page.drawRectangle({ x, y, width: side, height: side, color: rgb(1, 1, 1) });
    for (let row = 0; row < matrix.size; row += 1) {
      for (let column = 0; column < matrix.size; column += 1) {
        if (!matrix.data[row * matrix.size + column]) continue;
        this.page.drawRectangle({
          x: x + column * cell,
          // The matrix counts rows from the top; PDF counts y from the bottom.
          y: y + side - (row + 1) * cell,
          width: cell + 0.3,
          height: cell + 0.3,
          color: rgb(0, 0, 0),
        });
      }
    }
    return this;
  }

  box(x: number, y: number, width: number, height: number, color: RGB = WASH): this {
    this.page.drawRectangle({ x, y, width, height, color });
    return this;
  }

  /** A rule somewhere the cursor is not — a signature line, a panel divider. */
  hairline(x: number, y: number, width: number, color: RGB = HAIRLINE): this {
    this.page.drawLine({
      start: { x, y },
      end: { x: x + width, y },
      thickness: 0.6,
      color,
    });
    return this;
  }

  /** The muted grey the rest of this file uses for secondary text. */
  static readonly muted = MUTED;

  /** Absolute placement, for the few layouts the cursor cannot express. */
  at(value: string, x: number, y: number, options: TextOptions = {}): this {
    this.place(value, { ...options, x }, y);
    return this;
  }

  /**
   * Stamps the same footer onto every page, after the body is laid out.
   *
   * Written last because the page count is not known until then, and "Page 1 of
   * 3" on a document whose third page is missing is precisely the kind of thing
   * an auditor notices.
   */
  footer(lines: string[]): this {
    this.pages.forEach((page, index) => {
      let y = MARGIN - 8;
      page.drawLine({
        start: { x: MARGIN, y: MARGIN + 8 },
        end: { x: A4.width - MARGIN, y: MARGIN + 8 },
        thickness: 0.6,
        color: HAIRLINE,
      });
      for (const raw of [...lines].reverse()) {
        const text = sanitise(raw);
        page.drawText(text, { x: MARGIN, y, size: 6.5, font: this.regular, color: MUTED });
        y += 9;
      }
      const label = `Page ${index + 1} of ${this.pages.length}`;
      page.drawText(label, {
        x: A4.width - MARGIN - this.regular.widthOfTextAtSize(label, 6.5),
        y: MARGIN - 8,
        size: 6.5,
        font: this.regular,
        color: MUTED,
      });
    });
    return this;
  }

  save(): Promise<Uint8Array> {
    return this.doc.save();
  }
}

/** "04 Sep 2026", in the timezone the authority works in. */
export function formatDate(value: Date | null | undefined): string {
  if (!value) return "—".replace("—", "-");
  return value.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
}

/** "04 Sep 2026, 14:32" IST. Every document states its timezone in the footer. */
export function formatDateTime(value: Date | null | undefined): string {
  if (!value) return "-";
  return value.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Kolkata",
  });
}

/**
 * "2026-08-31 16:33" IST — for a table of hundreds of rows.
 *
 * Deliberately not the friendly form used elsewhere. In a dense column it has
 * to be narrow enough not to be truncated and it has to sort by eye, and an
 * auditor scanning a page for "when did this stop happening" is doing exactly
 * that.
 */
export function formatStamp(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Kolkata",
  }).formatToParts(value);
  const at = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${at("year")}-${at("month")}-${at("day")} ${at("hour")}:${at("minute")}`;
}

/** "2 h 15 min" — how a stay reads on a receipt someone is checking. */
export function formatDuration(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return "-";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}
