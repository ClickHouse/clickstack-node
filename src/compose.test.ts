import type { IncomingMessage, ServerResponse } from "node:http";
import { diag, type Span } from "@opentelemetry/api";
import { describe, expect, it, vi } from "vitest";
import { composeInstrumentationConfig } from "./compose.ts";
import { getState } from "./state.ts";

const HTTP = "@opentelemetry/instrumentation-http";
const UNDICI = "@opentelemetry/instrumentation-undici";
const span = {
  isRecording: () => true,
  setAttributes: () => span,
} as unknown as Span;

describe("header lists", () => {
  it("reads the standard env lists, lowercases them and merges code lists", () => {
    vi.stubEnv(
      "OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_SERVER_REQUEST",
      " X-Trace , Accept",
    );
    vi.stubEnv(
      "OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_CLIENT_RESPONSE",
      "etag",
    );

    const { map } = composeInstrumentationConfig(
      {
        [HTTP]: {
          headersToSpanAttributes: { server: { requestHeaders: ["X-Code"] } },
        },
      },
      false,
    );

    expect(map[HTTP]?.headersToSpanAttributes).toEqual({
      server: {
        requestHeaders: ["x-trace", "accept", "x-code"],
        responseHeaders: [],
      },
      client: { requestHeaders: [], responseHeaders: ["etag"] },
    });
    expect(map[UNDICI]?.headersToSpanAttributes).toEqual({
      responseHeaders: ["etag"],
    });
  });

  it("sets no undici header lists when none are configured", () => {
    const { map } = composeInstrumentationConfig(undefined, false);

    expect(map[UNDICI]?.headersToSpanAttributes).toEqual({});
  });

  it("leaves names on the sanitize list out, with a warning", () => {
    vi.stubEnv(
      "OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_SERVER_REQUEST",
      "authorization,cookie,x-ok",
    );

    const warn = vi.spyOn(diag, "warn").mockImplementation(() => undefined);
    const { map } = composeInstrumentationConfig(undefined, false);

    expect(map[HTTP]?.headersToSpanAttributes?.server?.requestHeaders).toEqual([
      "x-ok",
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('"authorization"'),
    );

    vi.stubEnv(
      "OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_SANITIZE_FIELDS",
      "x-ok",
    );

    const custom = composeInstrumentationConfig(undefined, false).map;

    expect(
      custom[HTTP]?.headersToSpanAttributes?.server?.requestHeaders,
    ).toEqual(["authorization", "cookie"]);
  });
});

describe("body hooks", () => {
  it("passes the user entry through unchanged when body capture is off", () => {
    const requestHook = vi.fn();
    const { map, unsubscribe } = composeInstrumentationConfig(
      { [HTTP]: { requestHook, enabled: true } },
      false,
    );

    expect(map[HTTP]?.requestHook).toBe(requestHook);
    expect(map[HTTP]?.enabled).toBe(true);
    expect(unsubscribe).toBeUndefined();
  });

  it("runs the user hooks after ours, even when ours throws", () => {
    const userRequest = vi.fn();
    const userApply = vi.fn();
    const { map, unsubscribe } = composeInstrumentationConfig(
      {
        [HTTP]: {
          requestHook: userRequest,
          applyCustomAttributesOnSpan: userApply,
        },
      },
      true,
    );

    const broken = {} as IncomingMessage;
    map[HTTP]?.requestHook?.(span, broken);
    map[HTTP]?.applyCustomAttributesOnSpan?.(
      span,
      broken,
      {} as ServerResponse,
    );

    expect(userRequest).toHaveBeenCalledWith(span, broken);
    expect(userApply).toHaveBeenCalledOnce();

    unsubscribe?.();
  });
});

describe("AWS Lambda hook", () => {
  it("records the invocation deadline, then runs the user's hook", () => {
    const user = vi.fn();
    const { map } = composeInstrumentationConfig(
      { "@opentelemetry/instrumentation-aws-lambda": { requestHook: user } },
      false,
    );
    const context = { getRemainingTimeInMillis: () => 3000 };
    const info = { event: {}, context } as unknown as Parameters<
      NonNullable<
        NonNullable<
          (typeof map)["@opentelemetry/instrumentation-aws-lambda"]
        >["requestHook"]
      >
    >[1];

    const before = Date.now();
    map["@opentelemetry/instrumentation-aws-lambda"]?.requestHook?.(span, info);

    expect(getState().invocationDeadline).toBeGreaterThanOrEqual(before + 2500);
    expect(user).toHaveBeenCalledWith(span, info);
  });
});
