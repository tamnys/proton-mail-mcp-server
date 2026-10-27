# Proton Mail MCP Server

An MCP server that exposes a Proton Mail account to MCP clients such as
Claude Desktop and Claude Code. It connects to a locally running
[Proton Mail Bridge](https://proton.me/mail/bridge) over IMAP and SMTP and
serves the MCP protocol over `stdio`. Within each server process it reuses
Bridge connections and idles them out automatically, so repeated tool calls
do not reconnect on every request.

## About this fork

This is a fork of
[tamlut-modnys/proton-mail-mcp-server](https://github.com/tamlut-modnys/proton-mail-mcp-server)
(as of upstream commit `a849adf`). Upstream ships only `server.mjs`, an
esbuild bundle of ~97,500 lines with all dependencies vendored in and no
separate source. This fork reconstructs readable source: the application code
was extracted verbatim from the tail of the upstream bundle into `server.js`,
the bundler shims were translated back to regular ESM imports, and the
dependencies are installed from npm with exact-pinned versions instead of
being vendored.

Upstream does not declare a license; attribution for the original code lies
with the original author (tamlut-modnys). Upstream `main` has not moved since
March 2026, so these changes are not offered back and live only here.

### Changes in this fork

Packaging:

- Readable source extracted from the upstream bundle into `server.js`, with
  the bundler shims rewritten as regular ESM imports
- Dependencies installed from npm at exact-pinned versions rather than vendored
- A test suite (`npm test`) running against fixed MIME fixtures, requiring no
  Bridge connection and no credentials

Security and safety:

- TLS certificates are validated for non-loopback hosts; validation is skipped
  only for a local Bridge with its self-signed certificate
- SMTP connection security is configurable (`PROTON_BRIDGE_SMTP_SECURE`)
  instead of being hard-wired, and the SMTP host can be set apart from the
  IMAP host (`PROTON_BRIDGE_SMTP_HOST`)
- Sending is off by default: the server creates drafts for review, and
  `send_email` and `reply_to_email` are exposed only with
  `PROTON_BRIDGE_ALLOW_SEND`
- Deleting moves a message to Trash rather than expunging it irreversibly

Correctness:

- `read_email` falls back to the HTML part when a message has no usable
  text/plain part, and reports which part it used (see below). Upstream
  returns an empty body for these messages
- `read_email` no longer expands inline images into base64 inside the returned
  HTML, which kept a message's body needlessly large
- `save_attachment` writes an attachment to a file on the host, within the
  same `PROTON_BRIDGE_ATTACHMENT_ROOT` limit, refusing to clobber or to follow
  a symlink
- A scanned PDF, which has no text to extract, is rendered to page images so
  it can be read at all; the caller chooses how many pages
- Replies quote the message they answer, in Proton's own markup, instead of
  leaving that to whoever calls the tool
- `read_email` inlines text attachments, parses calendar invites and extracts
  the text of PDF attachments, and `read_attachment` fetches images and other
  files, so the date of an appointment or the amount on an invoice are
  reachable instead of being hidden behind a filename (see
  [Attachments](#attachments))
- Reply-all no longer duplicates recipients, and no longer addresses the reply
  back to your own account
- Drafts keep their Bcc recipients. MailComposer drops the Bcc header by
  default, so a draft created with `bcc` used to arrive in Proton without it
- Messages can be referenced by `messageId` instead of `uid`, because UIDs in
  Bridge's All Mail folder are not stable across sessions (see
  [Referring to messages](#referring-to-messages))
- The server shuts down promptly when the MCP client disconnects, instead of
  leaving the process and its Bridge connections behind

## Features

- List mailbox folders
- List recent emails in a folder
- Read full email content
- Search emails by sender, subject, body, date, and unread status
- Create draft emails and reply drafts in the Drafts folder, with file
  attachments, for you to review and send yourself
- Update an existing draft in place of creating another one
- Optionally (off by default) send or reply directly via SMTP
- Move messages between folders
- Mark messages read, unread, flagged, or unflagged
- Delete emails (move to Trash)

## Prerequisites

- Node.js 22.13+ (pdf.js requires it)
- Proton Mail Bridge installed and logged in
- An MCP client (e.g. Claude Desktop or Claude Code)

## Installation

```bash
git clone <this repo>
cd proton-mail-mcp-server
npm ci
```

## Configure Proton Bridge credentials

The server reads credentials from environment variables or from:

`~/.proton-bridge-credentials`

Example:

```bash
PROTON_BRIDGE_USERNAME="your-email@proton.me"
PROTON_BRIDGE_PASSWORD="your-bridge-password"
PROTON_BRIDGE_HOST="127.0.0.1"
PROTON_BRIDGE_IMAP_PORT="1143"
PROTON_BRIDGE_SMTP_PORT="1025"
```

Only the username and password are required if you use Bridge's default local
ports. The password is the Bridge password shown in the Proton Mail Bridge
app, not your Proton account password.

By default the server connects to SMTP with STARTTLS (and requires the
upgrade to succeed), which matches Proton Bridge's default security setting.
If you switched Bridge's SMTP connection mode to SSL (implicit TLS), set
`PROTON_BRIDGE_SMTP_SECURE="true"` (in the environment or in the credentials
file).

## Sending is disabled by default

Out of the box this server cannot send email. The `send_email` and
`reply_to_email` tools are only registered when you explicitly set
`PROTON_BRIDGE_ALLOW_SEND="true"` (in the environment or in the credentials
file); without it, the MCP client does not even see them. Instead, the
`create_draft` and `create_reply_draft` tools save a message to your Drafts
folder over IMAP. Bridge syncs it to Proton, so it shows up in your regular
mail clients where you can review, edit, and send it yourself.

## Connect it to an MCP client

For Claude Desktop, add this entry to `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/`, Linux: `~/.config/Claude/`):

```json
{
  "mcpServers": {
    "proton-mail": {
      "command": "node",
      "args": [
        "/ABSOLUTE/PATH/TO/server.js"
      ]
    }
  }
}
```

If `node` is not on the client's PATH, use the absolute path from
`which node`. Then fully restart the client; it should discover the Proton
Mail tools on launch.

## Using another IMAP provider

Nothing here is Proton-specific beyond the defaults. The server talks plain
IMAP and SMTP through `imapflow` and `nodemailer`, folders come from whatever
the server advertises rather than from an assumed layout, and a provider that
offers IMAP on port 143 with STARTTLS -- gmx, for one -- needs no code change
at all. Point a second instance at it with `env`:

```json
{
  "mcpServers": {
    "proton-mail": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/server.js"]
    },
    "gmx-mail": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/server.js"],
      "env": {
        "PROTON_BRIDGE_USERNAME": "you@gmx.com",
        "PROTON_BRIDGE_PASSWORD": "your-gmx-password",
        "PROTON_BRIDGE_HOST": "imap.gmx.com",
        "PROTON_BRIDGE_IMAP_PORT": "143",
        "PROTON_BRIDGE_SMTP_HOST": "mail.gmx.com",
        "PROTON_BRIDGE_SMTP_PORT": "587"
      }
    }
  }
}
```

Credentials given in `env` take precedence over the credentials file, so the
two instances do not read each other's account. `PROTON_BRIDGE_SMTP_HOST` is
optional and falls back to `PROTON_BRIDGE_HOST`, which is what Bridge wants
since it serves both from `127.0.0.1`. STARTTLS is required on both ports and
certificates are validated for any non-loopback host, so neither session is
left in the clear. The variable names keep their `PROTON_BRIDGE_` prefix
whatever the provider; they are this server's own settings.

Both instances expose the same tool names, so give them distinct keys
(`proton-mail`, `gmx-mail`) -- that prefix is how the client tells them apart.
One process serves one account: host, ports and credentials are read once at
startup.

At gmx, IMAP is off until you switch it on: in the webmail, under
*Settings -> POP3 & IMAP*, enable IMAP access. Without that the login fails
with an authentication error even though the password is right. That same
page names the servers for your account -- `gmx.com` for an international
account, `gmx.net` for a German one -- so take the hostnames from there
rather than from this example.

Folder names are the provider's own. `Drafts` and `Trash` are located through
the IMAP SPECIAL-USE flags when the server advertises them, falling back to
those English names otherwise; if your provider uses localised names and
advertises no flags, pass the `folder` argument explicitly. `list_folders`
shows what is actually there.

## Available tools

- `list_folders()`
- `list_emails(folder="INBOX", limit=20)` — each message with `uid`, `messageId` and `hasAttachments`
- `read_email(uid | messageId, folder="INBOX")` — see [Reading message bodies](#reading-message-bodies)
- `read_attachment(uid | messageId, folder="INBOX", index, filename, pages)` — see [Attachments](#attachments)
- `save_attachment(uid | messageId, folder="INBOX", index, filename, path, overwrite=false)` — see [Attachments](#attachments)
- `search_emails(folder="INBOX", from, subject, body, since, before, unseen, limit=20)` — same fields as `list_emails`
- `create_draft(to, subject, body, html, cc, bcc, attachments)`
- `create_reply_draft(uid | messageId, folder="INBOX", body, html, replyAll=false, attachments, quote=true)`
- `update_draft(uid | messageId, folder="Drafts", to, cc, bcc, subject, body, html, attachments, keepAttachments=true)` — see [Updating a draft](#updating-a-draft)
- `send_email(to, subject, body, html, cc, bcc, attachments)` — only with `PROTON_BRIDGE_ALLOW_SEND`
- `reply_to_email(uid | messageId, folder="INBOX", body, html, replyAll=false, attachments, quote=true)` — only with `PROTON_BRIDGE_ALLOW_SEND`
- `move_email(uid | messageId, sourceFolder="INBOX", destinationFolder)`
- `mark_email(uid | messageId, folder="INBOX", action)`
- `delete_email(uid | messageId, folder="INBOX")`

`uid | messageId` means either one identifies the message; see
[Referring to messages](#referring-to-messages).

## Referring to messages

Every tool that acts on one message takes a `uid`, a `messageId`, or both.
`messageId` is the message's `Message-ID` header including the angle
brackets, as returned by `list_emails`, `search_emails` and `read_email`.

Prefer `messageId` in Bridge's `All Mail` folder. That folder is virtual, and
its UIDs are not stable across sessions: a UID remembered from an earlier
search can later point at a different message, and a reply draft then ends up
answering the wrong mail. A `messageId` is looked up in the given folder on
every call (an IMAP header search, confirmed against the exact value), so it
always reaches the same message. When both are given they must refer to the
same message, or the call is refused. When one `Message-ID` occurs more than
once in a folder, pass the `uid` as well to pick one.

## Attachments on drafts and outgoing mail

`create_draft`, `create_reply_draft`, `update_draft`, `send_email` and
`reply_to_email` take an optional `attachments` array:

```json
[
  { "path": "/home/me/Documents/invoice.pdf" },
  { "path": "~/export.csv", "filename": "transactions.csv", "contentType": "text/csv" }
]
```

- `path` is an absolute path on the machine running the server; `~` is
  expanded. `filename` defaults to the file's own name, `contentType` to the
  type matching its extension.
- Every path must be an existing regular file. If any one is not, the call
  fails with that path in the error and nothing is created.
- The total may not exceed 25 MB, about what Proton accepts per message. Above
  that the call fails and the error names the largest files. For
  `update_draft` the attachments the draft keeps count towards the total.
- Set `PROTON_BRIDGE_ATTACHMENT_ROOT` (in the environment or the credentials
  file) to only allow files below that directory. Symlinks are resolved before
  the check, so a link inside the root cannot reach a file outside it.
- The result lists what was attached as `attachments: [{ filename, size }]`.

Attaching to drafts always works; `send_email` and `reply_to_email`, and so
their attachments, exist only with `PROTON_BRIDGE_ALLOW_SEND`.

## Quoting the original in a reply

A reply carries the message it answers, quoted below it, the way any mail
client writes one. IMAP has no reply operation — a client appends a finished
message — so there is nothing to delegate this to: Thunderbird, Apple Mail and
the Proton web app each build their own quote, and so does this.

The markup copies what the Proton web app currently produces, down to the
`protonmail_quote` classes:

```html
<div class="protonmail_quote"><br><br>-------- Original Message --------<br>
On Friday, 10/16/26 at 19:18 Jan Jansen &lt;jan@example.org&gt; wrote:<br>
<blockquote class="protonmail_quote" type="cite">…the original…</blockquote></div>
```

Matching those classes is the point: Proton folds a quote it recognises behind
its "show quoted text" control, so a reply composed here collapses in the
mailbox like one typed in the web app. The plain-text part gets the same
quote with `>` prefixes.

The quoted HTML keeps the original's content and styles but loses its document
wrapper — `<html>`, `<head>`, `<title>`, `<meta>` and any `<script>` — since a
nested document inside a blockquote renders unpredictably, and scripts have no
business being passed along.

Pass `quote: false` for a short answer that does not need the original. A
message with no readable body is not quoted at all, rather than quoting the
placeholder that `read_email` would have reported.

## Updating a draft

`update_draft` changes a draft instead of leaving a stale copy next to a new
one. Only the fields passed change; pass an empty string to clear `to`, `cc`
or `bcc`. Existing attachments are kept unless `keepAttachments` is `false`,
and new ones are added. Inline images stay as long as the HTML still refers
to them.

The two body parts are kept in step, since Proton keeps only one of them (the
HTML when there is one): a new `html` without a new `body` also rewrites the
plain-text part from it, and a new `body` without a new `html` turns the draft
into plain text rather than leave the old HTML in place.

IMAP has no way to edit a message, so the draft is stored anew and the old one
is removed afterwards; the result reports `oldUid` and `newUid`. If storing the
new draft fails, the old one is untouched. If removing the old one fails, the
call still succeeds and says so in `warning`, so a retry does not create yet
another copy. Only messages carrying the `\Draft` flag are replaced; received
mail is refused. Work in `Drafts` (the default) rather than `All Mail`, where a
freshly stored draft may not be visible yet.

### Threading of reply drafts

`create_reply_draft` writes `In-Reply-To` and `References` into the draft, and
`update_draft` carries them over. Whether Proton links the draft to the
message it answers depends on Proton Bridge. A stock Bridge creates a draft in
Proton from the subject, body, recipients, attachments and `Message-ID` only:
the threading headers are gone when the draft is read back, and Proton does
not link the draft to the original message. Bridge's own SMTP path does resolve the parent message; the
IMAP draft path does not.
[proton-bridge PR #526](https://github.com/ProtonMail/proton-bridge/pull/526)
fixes this by resolving the parent for IMAP drafts too. With a Bridge built
from that change, reply drafts keep both headers and appear in the original
conversation.

## Reading message bodies

`read_email` returns the body as three fields:

| Field | Meaning |
| --- | --- |
| `text` | The body as plain text |
| `html` | The raw HTML body, or `null` if the message has none |
| `bodySource` | `"plain"`, `"html"` or `"none"` — where `text` came from |

`text` is taken from the message's `text/plain` part when it has one. When
that part is missing, or contains only whitespace and invisible padding
(bulk mail often fills it with combining grapheme joiners and soft hyphens to
blank out the preview line), the text is derived from the `text/html` part
instead and `bodySource` reports `"html"`.

This matters for any message whose HTML sits inside a `multipart/related` or
`multipart/mixed` wrapper — that is, any message with inline images or
attachments. `mailparser` performs no HTML-to-text conversion of its own in
that case, which is why such messages previously came back with an empty body.

`bodySource` names the part the text came from, not the converter that
produced it. A message whose root is `text/html` has no `text/plain` part at
all, so it reports `"html"` even though `mailparser` filled in `text` by
converting the HTML itself; only a message that genuinely carries a
`text/plain` part reports `"plain"`. The distinction is worth having because a
Proton mailbox is almost entirely HTML: measured over 400 recent messages in
one account, 98.5% had an HTML part and no plain-text part, 1.3% were
plain-text only, and a single message carried both. Deciding the source from
`mailparser`'s output alone would have labelled most of that mailbox `"plain"`.

All text derived from HTML goes through the same conversion, including the
case where `mailparser` already produced some of its own. Its conversion keeps
the source URL of every image and hard-wraps at about 80 columns; this one
keeps `alt` text, drops tracking pixels and filenames, and leaves lines
intact. Converting everything the same way also means a message reads the same
whether or not the sender happened to attach a logo. Measured over 83
HTML-rooted messages in one mailbox, 80 came out different from `mailparser`'s
version and in none of them was anything lost but image filenames and URL path
fragments.

If nothing readable can be found, `text` holds an explicit notice and
`bodySource` is `"none"`, so a genuinely empty message is distinguishable from
a parsing failure.

`html` is the raw HTML, for clients that prefer to render it themselves. It is
kept small enough to be worth reading:

- Inline images stay as `cid:` references instead of being expanded into base64
  `data:` URIs. `mailparser` inlines them by default, which turns a newsletter
  with a 40 kB logo into 55 kB of HTML that is almost entirely base64; passing
  `keepCidLinks` leaves the reference in place, and the `cid:` value matches an
  entry in the `attachments` list, so the image is still reachable.
- Base64 `data:` URIs that the sender embedded in the HTML source are replaced
  by a `[inline data removed: image/png, 40960 bytes]` marker once the payload
  exceeds 1 kB. Smaller ones, typically icons, are left alone. The surrounding
  markup is untouched.

Neither affects `text`, which is always derived from the full HTML.

Where `text` is derived from HTML, images contribute their `alt` text and
nothing else. `html-to-text` would otherwise print the image's source URL,
which in bulk mail means filenames and tracking pixels; skipping images
outright was worse, since it dropped alt text that carries real content (in one
mailbox, 20 of 21 messages with a substantive alt text lost it) and removed the
separation between whatever sat on either side, so a footer's two addresses
merged into `marketing@example.nlnieuwsbrief@example.com`. An `alt` that is
just the image's own filename is treated as absent.

## Attachments

Appointment confirmations and invoices routinely carry their real content in
an attachment while the body holds boilerplate: a meeting invite's date lives
in a `text/calendar` part, a scanned invoice is an inline JPEG. `mailparser`
files everything that is not the text or HTML body under `attachments`,
including calendar parts, which it lists without a filename.

`read_email` describes every attachment with `index`, `filename`,
`contentType`, `size`, `disposition` and `cid`. Three kinds carry more:

- Text attachments (`text/*` and `application/ics`) up to 64 kB include
  their decoded `content`, using the part's own charset. Larger ones list a
  `note` pointing at `read_attachment` instead.
- Calendar parts (`text/calendar`, `application/ics`) also include a parsed
  `calendar` object: the `method` (`REQUEST`, `CANCEL`, ...) and one entry
  per event with `summary`, `start`, `end`, `timezone`, `allDay`,
  `location`, `organizer`, `attendees`, `status`, `recurrence`,
  `description` and `uid`. Times are reported as written in the invite with
  their `TZID`, or with a trailing `Z` and timezone `UTC`; nothing is
  converted. Folded lines, escaped text and quoted parameters are handled;
  `VTIMEZONE` and `VALARM` are skipped.
- PDF attachments up to 8 MB include the text of their text layer in
  `content` (up to 64 kB, page by page, table rows kept on one line), plus
  `pages` and `pdfInfo` (title, author, producer, dates when present). A
  scanned PDF has no text layer; it is listed with a `note` saying so rather
  than with empty content. A PDF that cannot be parsed, or is password
  protected, likewise gets a `note` and never fails the whole call.

`read_attachment` fetches one attachment by `index` (as listed by
`read_email`) or `filename` (case-insensitive). What comes back depends on
the type:

| Type | Returned as | Limit |
| --- | --- | --- |
| `text/*`, `.ics` | decoded text, plus `calendar` for invites | 1 MB, truncated beyond that |
| `application/pdf` | the text layer, page by page, with `pages` and `pdfInfo`; a scan with no text layer comes back as page images | 8 MB file, 1 MB of text, first 50 pages; 20 rendered pages |
| `image/*` | an MCP image content block the model can look at | 4 MB |
| anything else | base64 in `contentBase64` | 1 MB |

Above the limit the response carries the metadata and a `note` instead. A
PDF's own bytes are never returned, since base64 of a PDF is of no use to a
model; the text layer is what it needs.

`save_attachment` writes an attachment's bytes to a file instead of returning
them. Use it when the file itself is the point -- collecting a year of invoice
PDFs, say -- since `read_attachment` gives a PDF's text layer rather than the
document, and hands other binaries back as base64 that a client cannot easily
turn into a file. The attachment is selected the same way, by `index` or
`filename`:

```
save_attachment(uid: 181, index: 0, path: "~/Facturen/hetzner-2026-07.pdf")
-> { "path": "/home/you/Facturen/hetzner-2026-07.pdf",
     "filename": "Hetzner_2026-07-04_089001030224.pdf",
     "size": 68663, "contentType": "application/pdf" }
```

`path` must be absolute (`~` is expanded) and its directory must already
exist; the server does not create directories. An existing file is refused
unless `overwrite: true` is passed, and the server never writes through a
symlink, so a link cannot redirect a write out of the directory that was
checked. When `PROTON_BRIDGE_ATTACHMENT_ROOT` is set, the destination must lie
below that root -- the same limit that applies to attaching files to a draft.
There is no size cap beyond what IMAP itself delivers.

### Scanned PDFs

A scanned PDF — anything from a flatbed, a phone camera or an `img2pdf`
pipeline — has no text layer, so there is no text to extract. `read_attachment`
renders its pages and returns them as images instead, which the model reads
directly.

```
read_attachment(uid: 188, index: 0)
-> note: "scanned PDF: page(s) 1, 2 of 5 rendered as images. The default is
          the first 2; pass pages (for example "3-5", or "all" for every page,
          up to 20) for the rest"
   + two image blocks
```

`pages` takes a number, a range like `2-5`, a comma-separated mix, or `all`.
Pages the document does not have are dropped rather than refused, and no more
than 20 are rendered in one call. The default of two keeps the common case —
most scanned mail is a page or two — from costing anything to ask about, while
leaving the decision about a long document to the caller: a page of something
that matters is worth the tokens, a dozen pages of something that does not is
not.

Rendering rather than OCR is deliberate. Tesseract does recover the characters
from a scan, but not reliably their arrangement: on a test letter it returned
the right digits attached to the wrong labels, `KvK nummer` and `btw-nummer`
each separated from their values and broken across lines. That failure is
invisible — the output reads as ordinary text — and on an invoice it is the
expensive kind. A rendered page keeps tables, stamps, signatures and
handwriting as what they are. OCR remains the better tool for building a
searchable archive, which is a different job from reading one document.

PDF text and rendering both come from [pdf.js](https://github.com/mozilla/pdf.js)
(`pdfjs-dist`), loaded on first use, with `@napi-rs/canvas` as the canvas it
draws on. That canvas ships its native binding as a per-platform optional
package, so `.npmrc` must not omit optional dependencies — without them
rendering fails at import. pdf.js 6 requires Node 22.13 or newer, which is why
`engines` says so.

## Local smoke test

You can sanity check that the server starts:

```bash
node server.js
```

It will wait for MCP messages on standard input. An MCP client is the normal
consumer, so this is mainly useful to catch obvious config or credential
errors.

## How it works

- Reads Bridge credentials from environment variables or `~/.proton-bridge-credentials`
- Uses IMAP via `imapflow` for listing, searching, reading, moving, flagging,
  and deleting mail
- Saves drafts over IMAP (composed with `nodemailer`'s MailComposer) so they
  sync to Proton via Bridge; updating a draft stores a new one and then
  removes the old one
- Uses SMTP via `nodemailer` for sending and replying (only when
  `PROTON_BRIDGE_ALLOW_SEND` is enabled)
- Reuses IMAP and SMTP connections inside each MCP process, with automatic idle
  cleanup and reconnect-once behavior for stale Bridge connections
- Uses `mailparser` when reading or replying so the client gets structured
  message content

## Troubleshooting

If your MCP client does not show the tools:

- Verify the `command` and `args` paths in the client's MCP configuration
- Restart the client completely
- Make sure Proton Mail Bridge is running
- Make sure your Bridge credentials file exists and contains the Bridge password,
  not your main Proton account password

If email actions fail:

- Confirm Bridge is listening on IMAP `1143` and SMTP `1025`, or update the
  port variables in `~/.proton-bridge-credentials`
- Re-open Proton Mail Bridge if it was recently restarted
- Optionally tune `PROTON_BRIDGE_IDLE_TIMEOUT_MS` and
  `PROTON_BRIDGE_SMTP_IDLE_TIMEOUT_MS` if you want shorter or longer connection
  reuse windows

## Security notes

Do not commit:

- `~/.proton-bridge-credentials`
- exported logs with email contents
- any screenshots or dumps containing message bodies
