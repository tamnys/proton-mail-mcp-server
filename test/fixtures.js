// Fixed MIME fixtures. These never touch a live mailbox: every test parses
// these strings directly. Addresses and content are synthetic.
const CRLF = "\r\n";
const join = (lines) => lines.join(CRLF);

// Written as escapes on purpose: as literal characters these are invisible in
// a diff and an editor stripping them would silently gut the test.
export const PREHEADER_PADDING =
  "\u034F\u034F\u034F \u00AD\u00AD \u200B \uFEFF  ";

const ONE_PX_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// A well-behaved newsletter: both a plain and an HTML alternative.
export const MULTIPART_ALTERNATIVE = join([
  "From: Afzender <afzender@example.org>",
  "To: Ontvanger <ontvanger@example.net>",
  "Subject: Bestelbevestiging",
  "MIME-Version: 1.0",
  'Content-Type: multipart/alternative; boundary="ALT"',
  "",
  "--ALT",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Je bestelling is bevestigd.",
  "",
  "--ALT",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<html><body><p>Je bestelling is <b>bevestigd</b>.</p></body></html>",
  "",
  "--ALT--",
  ""
]);

// Plain text only, no HTML alternative at all.
export const PLAIN_ONLY = join([
  "From: Afzender <afzender@example.org>",
  "Subject: Korte notitie",
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Alleen platte tekst.",
  ""
]);

// A single text/html part as the message root, no attachments.
export const HTML_ONLY = join([
  "From: Afzender <afzender@example.org>",
  "Subject: Alleen HTML",
  "MIME-Version: 1.0",
  "Content-Type: text/html; charset=utf-8",
  "",
  '<html><body><p>Hallo <b>wereld</b></p><a href="https://example.org">meer lezen</a></body></html>',
  ""
]);

// HTML plus an inline logo. This is the shape that regressed: mailparser
// leaves `text` undefined once the HTML sits inside a multipart wrapper.
export const HTML_WITH_INLINE_IMAGE = join([
  "From: Afzender <afzender@example.org>",
  "Subject: Afspraakbevestiging",
  "MIME-Version: 1.0",
  'Content-Type: multipart/related; boundary="REL"',
  "",
  "--REL",
  "Content-Type: text/html; charset=utf-8",
  "",
  '<html><body><p>Je afspraak staat gepland op dinsdag.</p><img src="cid:logo"></body></html>',
  "",
  "--REL",
  "Content-Type: image/png",
  "Content-Transfer-Encoding: base64",
  "Content-ID: <logo>",
  'Content-Disposition: inline; filename="logo.png"',
  "",
  ONE_PX_PNG,
  "",
  "--REL--",
  ""
]);

// HTML plus a PDF attachment -- the invoice case.
export const HTML_WITH_PDF_ATTACHMENT = join([
  "From: Boekhouder <boekhouder@example.org>",
  "Subject: Factuur",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="MIX"',
  "",
  "--MIX",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<html><body><p>Bijgaand de factuur van deze maand.</p></body></html>",
  "",
  "--MIX",
  "Content-Type: application/pdf",
  "Content-Transfer-Encoding: base64",
  'Content-Disposition: attachment; filename="factuur.pdf"',
  "",
  "JVBERi0xLjQK",
  "",
  "--MIX--",
  ""
]);

// A text/plain part holding only preheader padding: combining grapheme
// joiners, soft hyphens, a zero-width space and a BOM. Visually empty.
export const PADDED_PLAIN_PART = join([
  "From: Marketing <marketing@example.org>",
  "Subject: Nieuwsbrief",
  "MIME-Version: 1.0",
  'Content-Type: multipart/alternative; boundary="ALT"',
  "",
  "--ALT",
  "Content-Type: text/plain; charset=utf-8",
  "",
  PREHEADER_PADDING,
  "",
  "--ALT",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<html><body><p>De echte inhoud staat alleen in de HTML.</p></body></html>",
  "",
  "--ALT--",
  ""
]);

// HTML that carries no text at all -- an image-only mail wrapped in
// multipart/related, so mailparser performs no conversion of its own.
export const HTML_WITHOUT_TEXT = join([
  "From: Afzender <afzender@example.org>",
  "Subject: Alleen een plaatje",
  "MIME-Version: 1.0",
  'Content-Type: multipart/related; boundary="REL"',
  "",
  "--REL",
  "Content-Type: text/html; charset=utf-8",
  "",
  '<html><body><img src="cid:banner"></body></html>',
  "",
  "--REL",
  "Content-Type: image/png",
  "Content-Transfer-Encoding: base64",
  "Content-ID: <banner>",
  'Content-Disposition: inline; filename="banner.png"',
  "",
  ONE_PX_PNG,
  "",
  "--REL--",
  ""
]);

// A logo of realistic size, referenced with cid:. Parsed without
// keepCidLinks this whole payload ends up inside the HTML body.
const LARGE_PNG = "A".repeat(40 * 1024);

export const LARGE_INLINE_LOGO = join([
  "From: Nieuwsbrief <nieuws@example.org>",
  "Subject: Nieuwsbrief met logo",
  "MIME-Version: 1.0",
  'Content-Type: multipart/related; boundary="REL"',
  "",
  "--REL",
  "Content-Type: text/html; charset=utf-8",
  "",
  '<html><body><img src="cid:logo"><p>Nieuws van deze maand.</p></body></html>',
  "",
  "--REL",
  "Content-Type: image/png",
  "Content-Transfer-Encoding: base64",
  "Content-ID: <logo>",
  'Content-Disposition: inline; filename="logo.png"',
  "",
  LARGE_PNG,
  "",
  "--REL--",
  ""
]);

// A sender that pasted the image straight into the HTML as a data URI, plus a
// tiny one that is not worth rewriting. keepCidLinks does not help here.
export const HTML_WITH_EMBEDDED_DATA_URI = join([
  "From: Afzender <afzender@example.org>",
  "Subject: Ingesloten afbeelding",
  "MIME-Version: 1.0",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<html><body><p>Bekijk de bijgevoegde grafiek.</p>" +
    '<img src="data:image/png;base64,' + "B".repeat(8 * 1024) + '">' +
    '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">' +
    "</body></html>",
  ""
]);

// No body parts whatsoever.
// A message carrying nothing but an attachment: the text/plain part exists but
// holds only a newline. Taken from real sent mail -- scans and forms sent
// without a covering note. There is no HTML to fall back to, so this must be
// reported as empty rather than silently blank.
export const ATTACHMENT_ONLY_EMPTY_BODY = join([
  "From: Afzender <afzender@example.org>",
  "Subject: Scan rijbewijs",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="MIX"',
  "",
  "--MIX",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "",
  "--MIX",
  "Content-Type: application/pdf",
  "Content-Transfer-Encoding: base64",
  'Content-Disposition: attachment; filename="scan.pdf"',
  "",
  "JVBERi0xLjQK",
  "",
  "--MIX--",
  ""
]);

export const NO_BODY_AT_ALL = join([
  "From: Afzender <afzender@example.org>",
  "Subject: Leeg",
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=utf-8",
  "",
  ""
]);

// Meeting invite as Google Calendar and Outlook send it: the plain part is
// boilerplate, and the date, place and attendees live only in a text/calendar
// alternative. Lines are folded, the description is escaped, one attendee's
// CN contains a colon, and there is a VTIMEZONE and a VALARM to skip.
const ICS_INVITE = join([
  "BEGIN:VCALENDAR",
  "PRODID:-//Example//Agenda//NL",
  "VERSION:2.0",
  "METHOD:REQUEST",
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Amsterdam",
  "BEGIN:STANDARD",
  "DTSTART:19701025T030000",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "END:STANDARD",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "UID:afspraak-42@example.org",
  "DTSTART;TZID=Europe/Amsterdam:20260915T100000",
  "DTEND;TZID=Europe/Amsterdam:20260915T113000",
  "SUMMARY:Kwartaaloverleg Q3",
  "LOCATION:Vergaderzaal 2\\, Hoofdkantoor",
  "DESCRIPTION:Agenda:\\n1. Cijfers\\n2. Planning\\; een lange regel die door de",
  "  afzender is gevouwen omdat hij te lang was",
  'ORGANIZER;CN="Planning: Team":mailto:planning@example.org',
  "ATTENDEE;CN=Ontvanger;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:ontvanger@exam",
  " ple.net",
  "ATTENDEE;CN=Collega:mailto:collega@example.org",
  "STATUS:CONFIRMED",
  "BEGIN:VALARM",
  "TRIGGER:-PT15M",
  "ACTION:DISPLAY",
  "DESCRIPTION:Herinnering",
  "END:VALARM",
  "END:VEVENT",
  "END:VCALENDAR",
  ""
]);

export const CALENDAR_INVITE = join([
  "From: Planning <planning@example.org>",
  "To: Ontvanger <ontvanger@example.net>",
  "Subject: Uitnodiging: Kwartaaloverleg Q3",
  "MIME-Version: 1.0",
  'Content-Type: multipart/alternative; boundary="ALT"',
  "",
  "--ALT",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Je bent uitgenodigd voor een afspraak. Open de bijlage voor details.",
  "",
  "--ALT",
  "Content-Type: text/calendar; charset=utf-8; method=REQUEST",
  "Content-Transfer-Encoding: base64",
  "",
  Buffer.from(ICS_INVITE).toString("base64"),
  "",
  "--ALT--",
  ""
]);

// The same invite shipped as a named .ics file attachment, with a UTC time
// and an all-day follow-up event. No METHOD line in the file itself.
const ICS_FILE = join([
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:bezoek-7@example.org",
  "DTSTART:20261001T080000Z",
  "DTEND:20261001T090000Z",
  "SUMMARY:Bezoek monteur",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:vrij-8@example.org",
  "DTSTART;VALUE=DATE:20261002",
  "DTEND;VALUE=DATE:20261003",
  "SUMMARY:Hele dag vrij",
  "END:VEVENT",
  "END:VCALENDAR",
  ""
]);

export const CALENDAR_ICS_ATTACHMENT = join([
  "From: Installateur <service@example.org>",
  "Subject: Bevestiging bezoek",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="MIX"',
  "",
  "--MIX",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<html><body><p>Uw afspraak is ingepland, zie de bijgevoegde agenda-afspraak.</p></body></html>",
  "",
  "--MIX",
  'Content-Type: application/ics; name="afspraak.ics"',
  "Content-Transfer-Encoding: base64",
  'Content-Disposition: attachment; filename="afspraak.ics"',
  "",
  Buffer.from(ICS_FILE).toString("base64"),
  "",
  "--MIX--",
  ""
]);

// A CSV export in Latin-1, the shape of a bank or webshop statement.
export const CSV_ATTACHMENT = join([
  "From: Bank <info@example.org>",
  "Subject: Afschrift",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="MIX"',
  "",
  "--MIX",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Bijgaand uw afschrift.",
  "",
  "--MIX",
  'Content-Type: text/csv; charset=iso-8859-1; name="afschrift.csv"',
  "Content-Transfer-Encoding: base64",
  'Content-Disposition: attachment; filename="afschrift.csv"',
  "",
  Buffer.from("datum;omschrijving;bedrag\r\n2026-09-01;Caf\xe9;12,50\r\n", "latin1").toString("base64"),
  "",
  "--MIX--",
  ""
]);

// An invoice whose only content is a scan, sent as an inline JPEG.
const TINY_JPEG =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

export const INLINE_IMAGE_INVOICE = join([
  "From: Klusser <klus@example.org>",
  "Subject: Factuur september",
  "MIME-Version: 1.0",
  'Content-Type: multipart/related; boundary="REL"',
  "",
  "--REL",
  "Content-Type: text/html; charset=utf-8",
  "",
  '<html><body><p>Hierbij de factuur.</p><img src="cid:scan"></body></html>',
  "",
  "--REL",
  "Content-Type: image/jpeg",
  "Content-Transfer-Encoding: base64",
  "Content-ID: <scan>",
  'Content-Disposition: inline; filename="factuur-scan.jpg"',
  "",
  TINY_JPEG,
  "",
  "--REL--",
  ""
]);

// A text-layer PDF invoice with a table, the way accounting software emits
// one, plus a second page. Built by hand so no converter is needed.
import { makePdf } from "./pdf-fixture.js";

export const INVOICE_PDF_BYTES = makePdf([
  [
    "Factuur 2026-0917",
    "Klusbedrijf Jansen",
    "Factuurdatum: 9 september 2026",
    "Vervaldatum: 30 september 2026",
    "",
    [[50, "Omschrijving"], [250, "Aantal"], [330, "Prijs"], [420, "Bedrag"]],
    [[50, "Arbeid"], [250, "4"], [330, "EUR 55,00"], [420, "EUR 220,00"]],
    [[50, "Materiaal"], [250, "1"], [330, "EUR 80,00"], [420, "EUR 80,00"]],
    [[50, "Totaal incl. btw"], [420, "EUR 363,00"]],
    "Gelieve te betalen op NL00BANK0123456789 o.v.v. 2026-0917."
  ],
  ["Algemene voorwaarden", "Betaling binnen 21 dagen."]
], { title: "Factuur 2026-0917" });

export const PDF_INVOICE = join([
  "From: Klusbedrijf Jansen <factuur@example.org>",
  "Subject: Factuur 2026-0917",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="MIX"',
  "",
  "--MIX",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Beste klant, bijgaand uw factuur. Met vriendelijke groet.",
  "",
  "--MIX",
  'Content-Type: application/pdf; name="factuur-2026-0917.pdf"',
  "Content-Transfer-Encoding: base64",
  'Content-Disposition: attachment; filename="factuur-2026-0917.pdf"',
  "",
  INVOICE_PDF_BYTES.toString("base64"),
  "",
  "--MIX--",
  ""
]);

// A PDF with no text layer at all, as a scanner produces, sent with the
// generic octet-stream type some mail clients use.
export const SCANNED_PDF_BYTES = makePdf([[]]);

export const SCANNED_PDF = join([
  "From: Scanner <scan@example.org>",
  "Subject: Scan",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="MIX"',
  "",
  "--MIX",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Zie bijlage.",
  "",
  "--MIX",
  'Content-Type: application/octet-stream; name="scan.pdf"',
  "Content-Transfer-Encoding: base64",
  'Content-Disposition: attachment; filename="scan.pdf"',
  "",
  SCANNED_PDF_BYTES.toString("base64"),
  "",
  "--MIX--",
  ""
]);
