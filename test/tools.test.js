import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "url";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Starts the real server and asks it which tools it offers. No mail server is
// needed: the IMAP connection is only made when a tool is called.
const SERVER = fileURLToPath(new URL("../server.js", import.meta.url));

const READING = ["list_folders", "list_emails", "read_email", "read_attachment", "search_emails"];
const SAVING = ["save_attachment"];
const CHANGING = ["create_draft", "create_reply_draft", "update_draft", "move_email", "mark_email", "delete_email"];
const SENDING = ["send_email", "reply_to_email"];

async function toolNames(t, flags = {}, { home } = {}) {
  const env = {
    PATH: process.env.PATH,
    // A home without a credentials file, so nothing from the real one leaks in.
    HOME: home || fileURLToPath(new URL(".", import.meta.url)),
    ...(home ? {} : { PROTON_BRIDGE_USERNAME: "test@example.com", PROTON_BRIDGE_PASSWORD: "not-a-real-password" }),
    ...flags
  };
  const client = new Client({ name: "tools-test", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env, stderr: "ignore" }));
  t.after(() => client.close());
  const { tools } = await client.listTools();
  return tools.map((tool) => tool.name).sort();
}

test("by default every reading and changing tool is there, sending is not", async (t) => {
  const names = await toolNames(t);
  assert.deepEqual(names, [...READING, ...SAVING, ...CHANGING].sort());
});

test("PROTON_BRIDGE_ALLOW_SEND adds the sending tools", async (t) => {
  const names = await toolNames(t, { PROTON_BRIDGE_ALLOW_SEND: "true" });
  assert.deepEqual(names, [...READING, ...SAVING, ...CHANGING, ...SENDING].sort());
});

test("PROTON_BRIDGE_READ_ONLY registers none of the changing tools, nor save_attachment", async (t) => {
  const names = await toolNames(t, { PROTON_BRIDGE_READ_ONLY: "true" });
  assert.deepEqual(names, [...READING].sort());
  for (const name of [...CHANGING, ...SENDING]) assert.ok(!names.includes(name), `${name} must not exist`);
});

test("PROTON_BRIDGE_READ_ONLY wins over PROTON_BRIDGE_ALLOW_SEND", async (t) => {
  const names = await toolNames(t, { PROTON_BRIDGE_READ_ONLY: "yes", PROTON_BRIDGE_ALLOW_SEND: "true" });
  assert.deepEqual(names, [...READING].sort());
});

test("PROTON_BRIDGE_READ_ONLY keeps save_attachment when PROTON_BRIDGE_ATTACHMENT_ROOT fences it in", async (t) => {
  const names = await toolNames(t, { PROTON_BRIDGE_READ_ONLY: "true", PROTON_BRIDGE_ATTACHMENT_ROOT: "/tmp" });
  assert.deepEqual(names, [...READING, ...SAVING].sort());
});

async function homeWithCredentials(t, lines) {
  const home = await mkdtemp(join(tmpdir(), "proton-mcp-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, ".proton-bridge-credentials"), [
    "PROTON_BRIDGE_USERNAME=test@example.com",
    "PROTON_BRIDGE_PASSWORD=not-a-real-password",
    ...lines
  ].join("\n"));
  return home;
}

test("PROTON_BRIDGE_READ_ONLY in the credentials file is honoured", async (t) => {
  const home = await homeWithCredentials(t, ["PROTON_BRIDGE_READ_ONLY=true"]);
  assert.deepEqual(await toolNames(t, {}, { home }), [...READING].sort());
});

test("a credentials file cannot switch off PROTON_BRIDGE_READ_ONLY set in the environment", async (t) => {
  const home = await homeWithCredentials(t, ["PROTON_BRIDGE_READ_ONLY=false", "PROTON_BRIDGE_ALLOW_SEND=true"]);
  assert.deepEqual(await toolNames(t, { PROTON_BRIDGE_READ_ONLY: "true" }, { home }), [...READING].sort());
});

test("PROTON_BRIDGE_CREDENTIALS_FILE points a second account at its own credentials file", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "proton-mcp-creds-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "other-account");
  await writeFile(file, ["PROTON_BRIDGE_USERNAME=other@example.com", "PROTON_BRIDGE_PASSWORD=not-a-real-password", "PROTON_BRIDGE_ALLOW_SEND=true"].join("\n"));
  // The home has no credentials file, so the server only starts if it reads this one.
  const home = await mkdtemp(join(tmpdir(), "proton-mcp-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const names = await toolNames(t, { PROTON_BRIDGE_CREDENTIALS_FILE: file }, { home });
  assert.deepEqual(names, [...READING, ...SAVING, ...CHANGING, ...SENDING].sort());
});
