import { spawn } from "node:child_process";

import {
  chunkToString,
  hasMessageId,
  parseJsonObject,
  responseSessionId,
  sendJson,
  waitForExit,
} from "./smoke-helpers.mjs";

const cwd = process.cwd();

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
      const msg = parseJsonObject(line);
      if (msg === null) {
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
            prompt: [{ text: "/session", type: "text" }],
            sessionId,
          },
        });
      }

      if (hasMessageId(msg, 3)) {
        setTimeout(() => {
          child.kill("SIGTERM");
        }, 100);
      }
    }
  }
);

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
