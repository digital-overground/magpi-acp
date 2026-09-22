import { spawn } from "node:child_process";

import {
  chunkToString,
  hasMessageId,
  objectProperty,
  parseJsonObject,
  responseSessionId,
  sendJson,
} from "./smoke-helpers.mjs";

const p = spawn("node", ["dist/index.js"], {
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
/** @type {string | null} */
let sid = null;
let gotIntro = false;

p.stdout.on(
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
      if (msg === null) {
        throw new Error("Agent emitted an invalid JSON object");
      }

      if (hasMessageId(msg, 2)) {
        sid = responseSessionId(msg);
        const result = objectProperty(msg, "result");
        console.log(
          "session/new response uses standard fields only:",
          result !== null && !("_meta" in result)
        );
      }

      if (msg.method === "session/update") {
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
          if (text.startsWith("MagPi v") && /\npi v/u.test(text)) {
            gotIntro = true;
            console.log("OK: got intro via session/update (before any prompt)");
            p.kill("SIGTERM");
            process.exit(0);
          }
        }
      }
    }
  }
);

/** @param {unknown} object - JSON-compatible request. */
const send = (object) => {
  sendJson(p.stdin, object);
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

setTimeout(() => {
  if (!gotIntro) {
    console.error("Did not receive intro before prompt. sessionId=", sid);
    p.kill("SIGTERM");
    process.exit(1);
  }
}, 1500);
