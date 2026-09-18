import { spawn } from "node:child_process";

import {
  chunkToString,
  hasMessageId,
  isObject,
  parseJsonObject,
  responseSessionId,
  sendJson,
  waitForExit,
} from "./smoke-helpers.mjs";

const cwd = process.cwd();

// Build first so source-style invocation (node dist/index.js) works.
const build = spawn("npm", ["run", "build"], { cwd, stdio: "inherit" });
const buildExitCode = await waitForExit(build);
if (buildExitCode !== 0) {
  throw new Error(`build failed: ${buildExitCode}`);
}

const child = spawn("node", ["dist/index.js"], {
  cwd,
  env: process.env,
  stdio: ["pipe", "pipe", "inherit"],
});

child.stdout.setEncoding("utf-8");
child.stdout.on(
  "data",
  /** @param {unknown} chunk - Subprocess output chunk. */
  (chunk) => {
    process.stdout.write(chunkToString(chunk));
  }
);

/** @param {unknown} object - JSON-compatible request. */
const send = (object) => {
  sendJson(child.stdin, object);
};

// Standard ACP handshake, prompt, fork, and load. Simulate a generic client by
// stripping every private metadata field before processing agent messages.
/**
 * @param {unknown} value - Value to remove private metadata from.
 * @returns {unknown} A recursively copied value without `_meta` properties.
 */
const withoutMeta = (value) => {
  if (Array.isArray(value)) {
    return value.map(
      /** @param {unknown} item - Array item. */
      (item) => withoutMeta(item)
    );
  }
  if (!isObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "_meta")
      .map(([key, item]) => [key, withoutMeta(item)])
  );
};
send({
  id: 1,
  jsonrpc: "2.0",
  method: "initialize",
  params: { protocolVersion: 1 },
});
send({
  id: 2,
  jsonrpc: "2.0",
  method: "session/new",
  params: { cwd, mcpServers: [] },
});

// We'll send prompt a moment later; sessionId is in response to id=2.
/** @type {string | null} */
let sessionId = null;
let buffer = "";
child.stdout.on(
  "data",
  /** @param {unknown} chunk - Subprocess output chunk. */
  (chunk) => {
    buffer += chunkToString(chunk);
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      const parsed = parseJsonObject(line);
      const msg = parsed === null ? null : withoutMeta(parsed);
      if (!isObject(msg)) {
        continue;
      }

      const newSessionId = hasMessageId(msg, 2) ? responseSessionId(msg) : null;
      if (newSessionId !== null && sessionId === null) {
        sessionId = newSessionId;
        send({
          id: 3,
          jsonrpc: "2.0",
          method: "session/prompt",
          params: {
            prompt: [
              { text: "Say hello in one short sentence.", type: "text" },
            ],
            sessionId,
          },
        });
      }

      if (hasMessageId(msg, 3)) {
        send({
          id: 4,
          jsonrpc: "2.0",
          method: "session/fork",
          params: { cwd, mcpServers: [], sessionId },
        });
      }

      const forkSessionId = hasMessageId(msg, 4)
        ? responseSessionId(msg)
        : null;
      if (forkSessionId !== null) {
        send({
          id: 5,
          jsonrpc: "2.0",
          method: "session/load",
          params: { cwd, mcpServers: [], sessionId: forkSessionId },
        });
      }

      if (hasMessageId(msg, 5)) {
        setTimeout(() => {
          child.kill("SIGTERM");
        }, 50);
      }
    }
  }
);
