import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  BodyCapture,
  headerMap,
  MAX_BYTES,
  responseHasNoBody,
  type BodyMeta,
} from "./rules.ts";

const meta = (contentType: string, more: Partial<BodyMeta> = {}): BodyMeta => ({
  contentType,
  contentEncoding: undefined,
  contentLength: undefined,
  complete: true,
  ...more,
});

function content(body: string, contentType = "application/json"): unknown {
  const capture = new BodyCapture();
  capture.add(body);

  return capture.attributes("request", meta(contentType))[
    "http.request.body.content"
  ];
}

describe("BodyCapture size", () => {
  it("reports Content-Length for a complete transfer and the bytes seen for a cut one", () => {
    const capture = new BodyCapture();
    capture.add(Buffer.from("partial"));

    const length = { contentLength: "100" };

    expect(
      capture.attributes("response", meta("text/plain", length)),
    ).toMatchObject({
      "http.response.body.size": 100,
    });
    expect(
      capture.attributes(
        "response",
        meta("text/plain", { ...length, complete: false }),
      ),
    ).toMatchObject({
      "http.response.body.size": 7,
    });
  });

  it("writes nothing for an empty body", () => {
    expect(new BodyCapture().attributes("request", meta("text/plain"))).toEqual(
      {},
    );
  });
});

describe("BodyCapture content", () => {
  it("keeps the first MAX_BYTES bytes and counts the rest", () => {
    const capture = new BodyCapture();
    capture.add("a".repeat(MAX_BYTES + 10));

    const attributes = capture.attributes("request", meta("text/plain"));

    expect(attributes["http.request.body.size"]).toBe(MAX_BYTES + 10);
    expect(attributes["http.request.body.content"]).toBe("a".repeat(MAX_BYTES));
  });

  it("drops a multi-byte character cut by the cap, from strings and buffers alike", () => {
    const euro = String.fromCodePoint(0x20ac);
    const text = "a".repeat(MAX_BYTES - 1) + euro;

    for (const chunk of [text, Buffer.from(text)]) {
      const capture = new BodyCapture();
      capture.add(chunk);

      expect(
        capture.attributes("request", meta("text/plain"))[
          "http.request.body.content"
        ],
      ).toBe("a".repeat(MAX_BYTES - 1));
    }
  });

  it("assembles a body trickled in small chunks, up to the cap", () => {
    const text = "0123456789".repeat(MAX_BYTES / 5);
    const capture = new BodyCapture();

    for (let i = 0; i < text.length; i += 3) capture.add(text.slice(i, i + 3));
    capture.add(Buffer.from("more"));

    const attributes = capture.attributes("request", meta("text/plain"));

    expect(attributes["http.request.body.size"]).toBe(text.length + 4);
    expect(attributes["http.request.body.content"]).toBe(
      text.slice(0, MAX_BYTES),
    );
  });

  it("accepts strings in other encodings and ignores non-byte chunks", () => {
    const capture = new BodyCapture();
    capture.add("6869", "hex");
    capture.add(42);

    expect(capture.attributes("request", meta("text/plain"))).toEqual({
      "http.request.body.size": 2,
      "http.request.body.content": "hi",
    });
  });

  it.each([
    ["text/plain", true],
    ["application/json", true],
    ["application/vnd.api+json", true],
    ["application/xml", true],
    ["application/yaml", true],
    ["application/x-www-form-urlencoded", true],
    ["application/octet-stream; charset=utf-8", true],
    ["text/plain; charset=ISO-8859-1", false],
    ["multipart/form-data; boundary=x", false],
    ["application/octet-stream", false],
    ["", false],
  ])("records content for %j: %s", (contentType, recorded) => {
    expect(content('{"a":1}', contentType) !== undefined).toBe(recorded);
  });

  it("records only the size of a content-encoded body", () => {
    const capture = new BodyCapture();
    capture.add('{"a":1}');
    
    expect(
      capture.attributes(
        "request",
        meta("application/json", { contentEncoding: "gzip" }),
      ),
    ).toEqual({
      "http.request.body.size": 7,
    });
  });
});

describe("redaction", () => {
  it.each([
    ['{"user":"a","password":"x"}', '{"user":"a","password":"[REDACTED]"}'],
    ['{"Api-Key": 12, "ok": true}', '{"Api-Key": "[REDACTED]", "ok": true}'],
    [
      '{"session":{"id":"s","n":[1,2]},"x":1}',
      '{"session":"[REDACTED]","x":1}',
    ],
    [
      '{"pass\\u0077ord":"a\\"b","x":"y"}',
      '{"pass\\u0077ord":"[REDACTED]","x":"y"}',
    ],
    ['{"user_token":"cut by the cap', '{"user_token":"[REDACTED]"'],
    ['data: {"secret":"s"}', 'data: {"secret":"[REDACTED]"}'],
    ['{"\\q":1,"password":"x"}', '{"\\q":1,"password":"[REDACTED]"}'],
    [
      '{"Message":"{\\"token\\":\\"t\\",\\"user\\":\\"ada\\"}"}',
      '{"Message":"{\\"token\\":\\"[REDACTED]\\",\\"user\\":\\"ada\\"}"}',
    ],
    [
      '{"note":"password is not a key here"}',
      '{"note":"password is not a key here"}',
    ],
  ])("redacts JSON-looking text: %s", (body, expected) => {
    expect(content(body, "text/plain")).toBe(expected);
  });

  it("redacts form fields by decoded key", () => {
    expect(
      content(
        "user=a&pass%77ord=x&api+key=y&n=1",
        "application/x-www-form-urlencoded",
      ),
    ).toBe("user=a&pass%77ord=[REDACTED]&api+key=y&n=1");
  });

  it("keeps form keys with invalid percent-encoding", () => {
    expect(
      content("%=b&%zz=1&pass%77ord=x", "application/x-www-form-urlencoded"),
    ).toBe("%=b&%zz=1&pass%77ord=[REDACTED]");
  });
});

describe("helpers", () => {
  it("knows which responses have no body", () => {
    expect(responseHasNoBody("HEAD", 200)).toBe(true);
    expect([204, 304, 101].every((s) => responseHasNoBody("GET", s))).toBe(
      true,
    );
    expect(responseHasNoBody("GET", 200)).toBe(false);
  });

  it("collects flat header lists", () => {
    expect(
      headerMap(["Content-Type", "a", "X", Buffer.from("1"), "x", "2"]),
    ).toEqual(
      new Map([
        ["content-type", "a"],
        ["x", "1, 2"],
      ]),
    );
    expect(headerMap(undefined).size).toBe(0);
  });
});
