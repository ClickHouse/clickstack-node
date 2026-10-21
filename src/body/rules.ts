import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";
import { diag, type Attributes } from "@opentelemetry/api";
import { warnOnce } from "../env.ts";
import {
  ATTR_HTTP_REQUEST_BODY_CONTENT,
  ATTR_HTTP_REQUEST_BODY_SIZE,
  ATTR_HTTP_RESPONSE_BODY_CONTENT,
  ATTR_HTTP_RESPONSE_BODY_SIZE,
} from "../semconv.ts";

/** Bytes kept per body and direction. */
export const MAX_BYTES = 8192;

/** Key substrings whose values are redacted, matched case-insensitively. */
export const REDACT_KEYS: readonly string[] = [
  "password",
  "passwd",
  "secret",
  "token",
  "api_key",
  "apikey",
  "api-key",
  "authorization",
  "cookie",
  "session",
];

const REDACTED = "[REDACTED]";
const FORM = "application/x-www-form-urlencoded";

/** The side of an exchange that a body belongs to. */
export type Direction = "request" | "response";

/** Headers and transfer state of one body. */
export interface BodyMeta {
  readonly contentType: unknown;
  readonly contentEncoding: unknown;
  readonly contentLength: unknown;
  /** `false` when the transfer was cut, so Content-Length overstates what was sent. */
  readonly complete: boolean;
}

/**
 * Reports a failure inside capture code: one warning per thread, then debug lines.
 *
 * @param err - The caught error.
 */
export function reportFailure(err: unknown): void {
  warnOnce("capture-failed", "HTTP body capture failed and was skipped", err);
  diag.debug("clickstack-node: HTTP body capture failed", err);
}

/**
 * Tells whether a response carries no body on the wire, whatever its headers say.
 *
 * @param method - Request method.
 * @param status - Response status code.
 * @returns `true` for HEAD requests and 1xx, 204 and 304 responses.
 */
export function responseHasNoBody(
  method: string | undefined,
  status: number | undefined,
): boolean {
  return (
    method?.toUpperCase() === "HEAD" ||
    status === 204 ||
    status === 304 ||
    (status ?? 200) < 200
  );
}

/**
 * Collects a flat `[name, value, name, value]` header list (undici, or `writeHead` arguments).
 *
 * @param headers - The list; anything else gives an empty map.
 * @returns Lowercased names mapped to their values, repeated names joined with `, `.
 */
export function headerMap(headers: unknown): Map<string, string> {
  const map = new Map<string, string>();
  const list: unknown[] = Array.isArray(headers) ? headers : [];

  for (let i = 0; i + 1 < list.length; i += 2) {
    const name = String(list[i]).toLowerCase();
    const value = String(list[i + 1]);
    const previous = map.get(name);

    map.set(name, previous === undefined ? value : `${previous}, ${value}`);
  }

  return map;
}

function headerString(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ");

  return typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
}

// The semconv heuristic for textual bodies. Only UTF-8 is decoded; other charsets get the size.
function isTextualUtf8(contentType: unknown): boolean {
  const [essence = "", ...params] = headerString(contentType)
    .toLowerCase()
    .split(";");
  const type = essence.trim();
  const charset = params
    .map((p) => p.trim())
    .find((p) => p.startsWith("charset="));

  if (type === "" || type.startsWith("multipart/")) return false;

  if (charset !== undefined) return /^charset="?utf-?8"?$/.test(charset);

  return (
    type.startsWith("text/") ||
    /[/+](json|xml|yaml)$/.test(type) ||
    type === FORM
  );
}

function isSensitive(key: string): boolean {
  const lower = key.toLowerCase();

  return REDACT_KEYS.some((k) => lower.includes(k));
}

function skipSpace(text: string, from: number): number {
  let i = from;
  while (i < text.length && /\s/.test(text.charAt(i))) i++;

  return i;
}

/** Index just past the string token that starts at `from`, or -1 when the cap cut it. */
function endOfString(text: string, from: number): number {
  for (let i = from + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === '"') return i + 1;
  }

  return -1;
}

/** Index just past the JSON value that starts at `from`; the text length when the cap cut it. */
function endOfValue(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text.charAt(i);

    if (c === '"') {
      const end = endOfString(text, i);

      if (end === -1) return text.length;
      if (depth === 0) return end;

      i = end - 1;
    } else if (c === "{" || c === "[") {
      depth++;
    } else if (c === "}" || c === "]") {
      if (depth === 0) return i;
      if (--depth === 0) return i + 1;
    } else if (depth === 0 && (c === "," || /\s/.test(c))) {
      return i;
    }
  }

  return text.length;
}

const ESCAPES: Readonly<Record<string, string>> = {
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

// Decodes a complete string token without JSON.parse or decodeURIComponent below: one thrown
// error per malformed key let a crafted 8 KiB body cost about 50 times the CPU of a normal one.
function unescapeJson(token: string): string {
  return token
    .slice(1, -1)
    .replace(
      /\\(?:u([0-9a-fA-F]{4})|([^]))/g,
      (_match, hex: string | undefined, char: string | undefined) =>
        hex !== undefined
          ? String.fromCharCode(parseInt(hex, 16))
          : (ESCAPES[char ?? ""] ?? char ?? ""),
    );
}

// A linear scan instead of JSON.parse: the text may be cut by the cap or not be JSON at all
// (fetch labels string bodies text/plain, axios labels them form-urlencoded), and a sensitive
// value cut by the cap must still be replaced. It only rewrites `"key": value`, so it is safe on
// any text.
function redactJson(text: string, nested = false): string {
  let out = "";
  let copied = 0;
  let i = 0;

  while (i < text.length) {
    if (text[i] !== '"') {
      i++;
      continue;
    }

    const end = endOfString(text, i);

    if (end === -1) break;

    const token = text.slice(i, end);
    const colon = skipSpace(text, end);

    if (text[colon] !== ":") {
      // Queue and webhook envelopes carry JSON escaped inside a string value; one level of it is
      // redacted and encoded again.
      if (!nested && token.includes('\\"')) {
        const inner = unescapeJson(token);
        const redacted = redactJson(inner, true);

        if (redacted !== inner) {
          out += text.slice(copied, i) + JSON.stringify(redacted);
          copied = end;
        }
      }

      i = end;
      continue;
    }

    const start = skipSpace(text, colon + 1);

    if (start === text.length || !isSensitive(unescapeJson(token))) {
      i = end;

      continue;
    }

    out += `${text.slice(copied, start)}"${REDACTED}"`;
    i = copied = endOfValue(text, start);
  }

  return out + text.slice(copied);
}

// Each %XX becomes one character, which is enough for the check: the key words are ASCII, so the
// bytes of a multi-byte character cannot spell one.
function formKey(raw: string): string {
  return raw
    .replaceAll("+", " ")
    .replace(/%([0-9a-fA-F]{2})/g, (_match, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
}

function redactForm(text: string): string {
  return text
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq === -1) return pair;

      const key = pair.slice(0, eq);

      return isSensitive(formKey(key)) ? `${key}=${REDACTED}` : pair;
    })
    .join("&");
}

/** Copies the first {@link MAX_BYTES} bytes of one body and counts every byte seen. */
export class BodyCapture {
  /** Bytes seen, including those past the cap. */
  seen = 0;
  #kept = 0;
  // One buffer per body that doubles up to the cap: a buffer per chunk would cost about a hundred
  // times the cap for a body trickled in one-byte chunks, and a full-size buffer would hold 8 KiB
  // for every small body on every open connection.
  #buffer: Buffer | undefined;

  /**
   * Adds one chunk; values other than strings and byte arrays are ignored.
   *
   * @param chunk - `Buffer`, `Uint8Array` or `string`.
   * @param encoding - Encoding of a string chunk; anything else means UTF-8.
   */
  add(chunk: unknown, encoding?: unknown): void {
    if (typeof chunk === "string") {
      const enc =
        typeof encoding === "string" && Buffer.isEncoding(encoding)
          ? encoding
          : "utf8";

      this.seen += Buffer.byteLength(chunk, enc);
      if (this.#kept >= MAX_BYTES) return;

      // Encoding a large string whole would allocate a full copy to keep a few kilobytes. In the
      // text encodings room + 1 code units always make more than room bytes; hex and base64
      // decoders skip characters, so those strings are encoded whole.
      const head = /^(hex|base64(url)?)$/i.test(enc)
        ? chunk
        : chunk.slice(0, MAX_BYTES - this.#kept + 1);

      this.#copy(Buffer.from(head, enc));
    } else if (chunk instanceof Uint8Array) {
      this.seen += chunk.byteLength;
      this.#copy(chunk);
    }
  }

  #copy(bytes: Uint8Array): void {
    const n = Math.min(MAX_BYTES - this.#kept, bytes.byteLength);
    if (n <= 0) return;

    const need = this.#kept + n;

    if (this.#buffer === undefined || this.#buffer.length < need) {
      const size = Math.max(need, 2 * (this.#buffer?.length ?? 0));
      const grown = Buffer.alloc(Math.min(size, MAX_BYTES));

      this.#buffer?.copy(grown, 0, 0, this.#kept);
      this.#buffer = grown;
    }

    // A real copy: undici parser chunks and pooled writes reuse their memory.
    this.#buffer.set(bytes.subarray(0, n), this.#kept);
    this.#kept = need;
  }

  /**
   * Builds the size and content attributes for this body.
   *
   * @param direction - Which side of the exchange the body belongs to.
   * @param meta - The body's headers and transfer state.
   * @returns The attributes; empty for an empty body.
   */
  attributes(direction: Direction, meta: BodyMeta): Attributes {
    const length = headerString(meta.contentLength);
    // Content-Length is the wire size, but overstates a cut transfer once bytes were seen.
    const useLength =
      /^\d+$/.test(length) && (meta.complete || this.seen === 0);
    const size = useLength ? Number(length) : this.seen;
    if (size === 0) return {};
    const request = direction === "request";
    const attributes: Attributes = {
      [request ? ATTR_HTTP_REQUEST_BODY_SIZE : ATTR_HTTP_RESPONSE_BODY_SIZE]:
        size,
    };
    const coding = headerString(meta.contentEncoding).toLowerCase();

    if (this.#buffer === undefined || (coding !== "" && coding !== "identity"))
      return attributes;

    if (!isTextualUtf8(meta.contentType)) return attributes;

    // `stream: true` drops a character cut by the cap instead of emitting U+FFFD.
    let text = new TextDecoder().decode(this.#buffer.subarray(0, this.#kept), {
      stream: this.seen > this.#kept,
    });

    if (headerString(meta.contentType).toLowerCase().startsWith(FORM))
      text = redactForm(text);
    attributes[
      request ? ATTR_HTTP_REQUEST_BODY_CONTENT : ATTR_HTTP_RESPONSE_BODY_CONTENT
    ] = redactJson(text);

    return attributes;
  }
}
