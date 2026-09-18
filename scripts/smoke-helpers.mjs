import { once } from "node:events";

/** @typedef {Record<string, unknown>} JsonObject */

/**
 * @param {unknown} value - Value to inspect.
 * @returns {value is JsonObject} Whether the value is a plain object.
 */
export const isObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * @param {string} text - JSON text to parse.
 * @returns {JsonObject | null} The parsed object, or null for invalid input.
 */
export const parseJsonObject = (text) => {
  try {
    /** @type {unknown} */
    const value = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
};

/**
 * @param {JsonObject} object - Object containing the property.
 * @param {string} key - Property name.
 * @returns {JsonObject | null} The object property, or null if absent.
 */
export const objectProperty = (object, key) => {
  const value = object[key];
  return isObject(value) ? value : null;
};

/**
 * @param {JsonObject} message - JSON-RPC message.
 * @param {string | number} id - Expected message ID.
 */
export const hasMessageId = (message, id) => message.id === id;

/**
 * @param {JsonObject} message - JSON-RPC response.
 * @returns {string | null} The response's session ID, when present.
 */
export const responseSessionId = (message) => {
  const result = objectProperty(message, "result");
  const sessionId = result?.sessionId;
  return typeof sessionId === "string" && sessionId.length > 0
    ? sessionId
    : null;
};

/**
 * @param {import("node:stream").Writable} input - Agent input stream.
 * @param {unknown} value - JSON-compatible value to send.
 */
export const sendJson = (input, value) => {
  input.write(`${JSON.stringify(value)}\n`);
};

/**
 * @param {unknown} chunk - Subprocess output chunk.
 * @returns {string} The chunk decoded as UTF-8 text.
 */
export const chunkToString = (chunk) => {
  if (typeof chunk === "string") {
    return chunk;
  }
  if (Buffer.isBuffer(chunk)) {
    return chunk.toString("utf-8");
  }
  throw new TypeError("Expected subprocess output to be text or a Buffer");
};

/**
 * @param {import("node:child_process").ChildProcess} child - Child process.
 * @returns {Promise<number | null>} The numeric exit code, or null if signaled.
 */
export const waitForExit = async (child) => {
  /** @type {unknown[]} */
  const exit = await once(child, "exit");
  const [exitCode] = exit;
  return typeof exitCode === "number" ? exitCode : null;
};
