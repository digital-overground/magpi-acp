import { spawn } from "node:child_process";

import {
  chunkToString,
  objectProperty,
  parseJsonObject,
  sendJson,
} from "./smoke-helpers.mjs";

const agent = spawn("node", ["dist/index.js"], {
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
agent.stdout.on(
  "data",
  /** @param {unknown} chunk - Subprocess output chunk. */
  (chunk) => {
    buf += chunkToString(chunk);
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) {
        continue;
      }
      const msg = parseJsonObject(line);
      if (msg?.method === "session/update") {
        const params = objectProperty(msg, "params");
        const update =
          params === null ? null : objectProperty(params, "update");
        const content =
          update === null ? null : objectProperty(update, "content");
        if (
          update?.sessionUpdate === "agent_message_chunk" &&
          content?.type === "text"
        ) {
          const text = String(content.text);
          if (
            text.includes("[Context]") &&
            text.includes("[Skills]") &&
            text.includes("[Extensions]")
          ) {
            console.log("OK: got startup info in agent_message_chunk");
            agent.kill("SIGTERM");
            process.exit(0);
          }
        }
      }
    }
  }
);

/** @param {unknown} object - JSON-compatible request. */
const send = (object) => {
  sendJson(agent.stdin, object);
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
  params: { cwd: process.cwd(), mcpServers: [] },
});

// Trigger first prompt so startup info flushes in the first turn
setTimeout(() => {
  send({
    id: 3,
    jsonrpc: "2.0",
    method: "session/prompt",
    params: { prompt: [{ text: "hi", type: "text" }], sessionId: "dummy" },
  });
}, 200);

// Replace dummy session id once we see session/new response
agent.stdout.on(
  "data",
  /** @param {unknown} chunk - Subprocess output chunk. */
  (chunk) => {
    const text = chunkToString(chunk);
    const match =
      /"id":2,[^\n]*"result":\{[^}]*"sessionId":"(?<sessionId>[^"]+)"/u.exec(
        text
      );
    const sid = match?.groups?.sessionId;
    if (sid !== undefined) {
      // resend prompt with real session id
      send({
        id: 4,
        jsonrpc: "2.0",
        method: "session/prompt",
        params: { prompt: [{ text: "hi", type: "text" }], sessionId: sid },
      });
    }
  }
);

setTimeout(() => {
  console.error("FAIL: did not observe startup info");
  agent.kill("SIGTERM");
  process.exit(1);
}, 5000);
