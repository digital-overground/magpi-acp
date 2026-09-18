import assert from "node:assert/strict";
import test from "node:test";

import { getAuthMethods, PI_SETUP_METHOD_ID } from "../../src/acp/auth.js";

interface TerminalAuthMethod {
  id: string;
  _meta?: {
    "terminal-auth"?: {
      args?: unknown;
      command?: unknown;
      label?: unknown;
    };
  };
}

test("getAuthMethods: includes integrated terminal-auth metadata when enabled", () => {
  const methods = getAuthMethods({ supportsTerminalAuthMeta: true });
  assert.equal(methods.length, 1);
  const m = methods[0] as TerminalAuthMethod;

  assert.equal(m.id, PI_SETUP_METHOD_ID);
  assert.ok(m._meta);
  assert.ok(m._meta["terminal-auth"]);
  assert.ok(typeof m._meta["terminal-auth"].command === "string");
  assert.deepEqual(m._meta["terminal-auth"].args, ["--terminal-login"]);
  assert.equal(m._meta["terminal-auth"].label, "Launch pi");
});

test("getAuthMethods: omits integrated terminal-auth metadata when disabled", () => {
  const methods = getAuthMethods({ supportsTerminalAuthMeta: false });
  const m = methods[0] as TerminalAuthMethod;
  assert.ok(!m._meta || !m._meta["terminal-auth"]);
});
