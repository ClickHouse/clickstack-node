import { Buffer } from "node:buffer";
import { channel } from "node:diagnostics_channel";
import { diag, type Attributes, type Span } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createUndiciBodyCapture,
  hasBodyChannels,
  type UndiciBodyCapture,
} from "./undici.ts";

type Hooks = UndiciBodyCapture;
type Request = Parameters<Hooks["requestHook"]>[1];
type Response = Parameters<Hooks["responseHook"]>[1]["response"];

const sent = channel("undici:request:bodyChunkSent");
const received = channel("undici:request:bodyChunkReceived");
const trailers = channel("undici:request:trailers");
const error = channel("undici:request:error");

function fakeSpan(): Span & { attributes: Attributes } {
  const attributes: Attributes = {};
  return {
    attributes,
    isRecording: () => true,
    setAttributes(a: Attributes) {
      Object.assign(attributes, a);
      return this;
    },
  } as unknown as Span & { attributes: Attributes };
}

const response = (
  headers: Record<string, string>,
  statusCode = 200,
): Response => ({
  statusCode,
  statusText: "",
  headers: Object.entries(headers).flatMap(([k, v]) => [
    Buffer.from(k),
    Buffer.from(v),
  ]),
});

let capture: Hooks | undefined;
afterEach(() => {
  capture?.unsubscribe();
  capture = undefined;
});

function exchange(responseHeaders: Record<string, string>) {
  capture = createUndiciBodyCapture();
  if (capture === undefined)
    throw new Error("this Node has no undici body channels");

  const span = fakeSpan();
  const request = {
    method: "POST",
    headers: ["content-type", "text/plain"],
    contentLength: null,
  } as unknown as Request;

  capture.requestHook(span, request);
  sent.publish({ request, chunk: Buffer.from('{"token":"t"}') });

  capture.responseHook(span, { request, response: response(responseHeaders) });
  received.publish({ request, chunk: Buffer.from("partial") });

  return { span, request };
}

const supported = hasBodyChannels();

describe.runIf(supported)("fetch bodies", () => {
  it("writes both bodies when the exchange ends", () => {
    const { span, request } = exchange({
      "content-type": "text/plain",
      "content-length": "7",
    });

    expect(span.attributes).toEqual({});

    trailers.publish({ request, trailers: [] });

    expect(span.attributes).toEqual({
      "http.request.body.size": 13,
      "http.request.body.content": '{"token":"[REDACTED]"}',
      "http.response.body.size": 7,
      "http.response.body.content": "partial",
    });
  });

  it("reports the bytes seen when the transfer is cut", () => {
    const { span, request } = exchange({
      "content-type": "text/plain",
      "content-length": "100",
    });

    error.publish({ request, error: new Error("terminated") });

    expect(span.attributes["http.response.body.size"]).toBe(7);
  });

  it("survives a malformed channel message", () => {
    exchange({ "content-type": "text/plain" });
    expect(() => {
      sent.publish(null);
    }).not.toThrow();
  });

  it("stops listening after unsubscribe", () => {
    const { span, request } = exchange({ "content-type": "text/plain" });
    capture?.unsubscribe();

    trailers.publish({ request, trailers: [] });

    expect(span.attributes).toEqual({});
  });
});

describe.runIf(!supported)("fetch bodies on Node before 24.4", () => {
  it("captures nothing and warns", () => {
    const warn = vi.spyOn(diag, "warn").mockImplementation(() => undefined);
    
    expect(createUndiciBodyCapture()).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("fetch bodies"));
  });
});
