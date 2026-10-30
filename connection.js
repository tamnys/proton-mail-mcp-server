// How the server reaches the IMAP server, kept apart from server.js so the
// choice can be tested without starting the server.

// The yes/no environment variables (PROTON_BRIDGE_ALLOW_SEND and friends) all
// read the same way: 1, true or yes switches them on, anything else is off.
export function isEnabled(value) {
  return /^(1|true|yes)$/i.test(value || "");
}

export function isLoopbackHost(host) {
  const h = (host || "").toLowerCase();
  return h === "localhost" || h === "::1" || h.startsWith("127.");
}

// Proton Bridge (127.0.0.1:1143) and gmx (port 143) speak plain IMAP that
// ImapFlow upgrades with STARTTLS; Gmail only accepts implicit TLS on 993, so
// that is a separate switch rather than something derived from the port.
export function imapConnectionOptions({ host, imapPort, imapSecure }) {
  const secure = Boolean(imapSecure);
  return {
    host,
    port: imapPort,
    secure,
    // Left undefined, ImapFlow carries on unencrypted when a server does not
    // offer STARTTLS, password and all. Without implicit TLS the upgrade is
    // therefore required; with it, STARTTLS must stay off.
    doSTARTTLS: !secure,
    tls: {
      // Bridge uses a self-signed cert; only skip validation for local Bridge
      rejectUnauthorized: !isLoopbackHost(host)
    }
  };
}
