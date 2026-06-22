import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const serverPath = join(repoRoot, "server.mjs");
const MCP_PROTOCOL_VERSION = "2025-06-18";
const EXIT_TIMEOUT_MS = 2e3;
const REQUEST_TIMEOUT_MS = 5e3;

class McpChild {
  constructor({ debug = false } = {}) {
    this.nextId = 1;
    this.pending = /* @__PURE__ */ new Map();
    this.stdoutBuffer = "";
    this.stderr = "";
    this.exitResult = null;
    this.child = spawn(process.execPath, [serverPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PROTON_BRIDGE_USERNAME: "test@example.com",
        PROTON_BRIDGE_PASSWORD: "dummy-test-password",
        PROTON_BRIDGE_HOST: "127.0.0.1",
        PROTON_BRIDGE_IMAP_PORT: "1143",
        PROTON_BRIDGE_SMTP_PORT: "1025",
        PROTON_MCP_DEBUG: debug ? "1" : "0"
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child.stdout.on("data", (chunk) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString("utf8");
    });
    this.child.once("exit", (code, signal) => {
      this.exitResult = { code, signal };
      for (const { reject, timeout } of this.pending.values()) {
        clearTimeout(timeout);
        reject(new Error(`child exited before response: code=${code} signal=${signal}`));
      }
      this.pending.clear();
    });
  }

  get pid() {
    return this.child.pid;
  }

  onStdout(chunk) {
    this.stdoutBuffer += chunk.toString("utf8");
    let newlineIndex;
    while ((newlineIndex = this.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        throw new Error(`invalid JSON-RPC output: ${line}`);
      }
      if (message.id !== void 0 && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(pending.timeout);
        if (message.error) {
          pending.reject(new Error(`JSON-RPC error for id ${message.id}: ${JSON.stringify(message.error)}`));
        } else {
          pending.resolve(message.result);
        }
      }
    }
  }

  request(method, params = {}) {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out waiting for ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeout });
    });
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    return response;
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: "proton-mcp-lifecycle-test",
        version: "0.0.0"
      }
    });
    assert.equal(result.protocolVersion, MCP_PROTOCOL_VERSION);
    this.notify("notifications/initialized");
  }

  async listTools() {
    const result = await this.request("tools/list");
    assert.ok(Array.isArray(result.tools), "tools/list should return a tools array");
    assert.ok(result.tools.some((tool) => tool.name === "list_emails"), "tools/list should expose list_emails");
    return result;
  }

  waitForExit(timeoutMs = EXIT_TIMEOUT_MS) {
    if (this.exitResult) {
      return Promise.resolve(this.exitResult);
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`child ${this.pid} did not exit within ${timeoutMs}ms`));
      }, timeoutMs);
      this.child.once("exit", (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal });
      });
    });
  }

  closeStdin() {
    this.child.stdin.end();
  }

  kill(signal) {
    this.child.kill(signal);
  }
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function matchingServerPids(spawnedPids) {
  const result = spawnSync("pgrep", ["-f", serverPath], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) {
    return [];
  }
  return result.stdout.trim().split(/\s+/).map((value) => Number(value)).filter((pid) => spawnedPids.has(pid));
}

function sampleRssBytes(pid) {
  const result = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
  if (result.status !== 0) {
    return null;
  }
  const rssKb = Number(result.stdout.trim());
  return Number.isFinite(rssKb) ? rssKb * 1024 : null;
}

async function runLifecycle({ debug = false } = {}) {
  const child = new McpChild({ debug });
  await child.initialize();
  await child.listTools();
  child.closeStdin();
  const exit = await child.waitForExit();
  assert.equal(exit.code, 0, `stdin-close lifecycle should exit 0, stderr:\n${child.stderr}`);
  assert.equal(exit.signal, null);
  return child;
}

async function lifecycleTest() {
  await runLifecycle({ debug: true });
}

async function repeatLifecycleTest() {
  const spawnedPids = /* @__PURE__ */ new Set();
  for (let i = 0; i < 50; i++) {
    const child = await runLifecycle();
    spawnedPids.add(child.pid);
  }
  const lingeringPids = matchingServerPids(spawnedPids).filter(isPidAlive);
  assert.deepEqual(lingeringPids, [], `spawned server processes still running: ${lingeringPids.join(", ")}`);
}

async function sigtermTest() {
  const child = new McpChild();
  await child.initialize();
  await child.listTools();
  child.kill("SIGTERM");
  const exit = await child.waitForExit();
  assert.equal(exit.code, 0, `SIGTERM lifecycle should exit 0, stderr:\n${child.stderr}`);
  assert.equal(exit.signal, null);
}

async function memorySmokeTest() {
  const child = new McpChild({ debug: true });
  await child.initialize();
  await child.listTools();
  const rssStart = sampleRssBytes(child.pid);
  for (let i = 0; i < 50; i++) {
    await child.listTools();
  }
  const rssEnd = sampleRssBytes(child.pid);
  child.closeStdin();
  const exit = await child.waitForExit();
  assert.equal(exit.code, 0, `memory smoke lifecycle should exit 0, stderr:\n${child.stderr}`);
  assert.match(child.stderr, /\[proton-mcp\]/, "debug mode should emit diagnostic events");
  assert.equal(child.stderr.includes("dummy-test-password"), false, "debug output must not include the test password");
  assert.equal(child.stderr.includes("test@example.com"), false, "debug output must not include the test username");
  if (rssStart !== null && rssEnd !== null) {
    const growth = rssEnd - rssStart;
    assert.ok(growth < 32 * 1024 * 1024, `RSS grew too much across tools/list cycles: ${growth} bytes`);
  }
}

const tests = [
  ["lifecycle closes on stdin EOF", lifecycleTest],
  ["50 repeated lifecycles leave no spawned child running", repeatLifecycleTest],
  ["SIGTERM exits cleanly", sigtermTest],
  ["tools/list memory smoke stays bounded", memorySmokeTest]
];

for (const [name, test] of tests) {
  await test();
  console.log(`ok - ${name}`);
}
