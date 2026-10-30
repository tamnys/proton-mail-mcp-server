import test from "node:test";
import assert from "node:assert/strict";

import { isEnabled, imapConnectionOptions } from "../connection.js";

test("isEnabled accepts 1, true and yes in any case", () => {
  for (const value of ["1", "true", "TRUE", "yes", "Yes"]) assert.equal(isEnabled(value), true, value);
  for (const value of [undefined, "", "0", "false", "no", "on"]) assert.equal(isEnabled(value), false, value);
});

test("Proton Bridge keeps STARTTLS and skips validation of its self-signed cert", () => {
  const options = imapConnectionOptions({ host: "127.0.0.1", imapPort: 1143, imapSecure: isEnabled(undefined) });
  assert.equal(options.secure, false);
  assert.equal(options.doSTARTTLS, true);
  assert.equal(options.port, 1143);
  assert.equal(options.tls.rejectUnauthorized, false);
});

test("gmx requires STARTTLS on 143 and validates the certificate", () => {
  const options = imapConnectionOptions({ host: "imap.gmx.com", imapPort: 143, imapSecure: isEnabled(undefined) });
  assert.equal(options.secure, false);
  assert.equal(options.doSTARTTLS, true);
  assert.equal(options.tls.rejectUnauthorized, true);
});

test("Gmail gets implicit TLS on 993 and validates the certificate", () => {
  const options = imapConnectionOptions({ host: "imap.gmail.com", imapPort: 993, imapSecure: isEnabled("true") });
  assert.equal(options.secure, true);
  assert.equal(options.doSTARTTLS, false);
  assert.equal(options.host, "imap.gmail.com");
  assert.equal(options.port, 993);
  assert.equal(options.tls.rejectUnauthorized, true);
});
