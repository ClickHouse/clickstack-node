import { subscribe, unsubscribe } from "node:diagnostics_channel";
import type { Span } from "@opentelemetry/api";
import type { InstrumentationConfigMap } from "@opentelemetry/auto-instrumentations-node";
import { warnOnce } from "../env.ts";
import {
  BodyCapture,
  headerMap,
  reportFailure,
  responseHasNoBody,
  type BodyMeta,
  type Direction,
} from "./rules.ts";

type UndiciConfig = NonNullable<
  InstrumentationConfigMap["@opentelemetry/instrumentation-undici"]
>;

interface Side {
  readonly capture: BodyCapture;
  readonly meta: Omit<BodyMeta, "complete">;
}

interface Exchange {
  readonly span: Span;
  readonly request: Side;
  response?: Side;
}

/** fetch body capture: hooks for `instrumentation-undici` plus the channel subscriptions. */
export interface UndiciBodyCapture {
  readonly requestHook: NonNullable<UndiciConfig["requestHook"]>;
  readonly responseHook: NonNullable<UndiciConfig["responseHook"]>;
  /** Removes the channel subscribers. */
  readonly unsubscribe: () => void;
}

const side = (headers: Map<string, string>, contentLength: unknown): Side => ({
  capture: new BodyCapture(),
  meta: {
    contentType: headers.get("content-type"),
    contentEncoding: headers.get("content-encoding"),
    contentLength,
  },
});

/**
 * Tells whether the undici that Node bundles publishes the body diagnostics channels.
 *
 * @returns `true` from undici 7.11, which Node bundles from 24.4.
 */
export function hasBodyChannels(): boolean {
  const [major = 0, minor = 0] = (process.versions["undici"] ?? "0")
    .split(".")
    .map(Number);

  return major > 7 || (major === 7 && minor >= 11);
}

/**
 * Creates the fetch body capture from the undici body diagnostics channels, which Node bundles
 * from 24.4 (undici 7.11). Call it before `instrumentation-undici` is constructed: that
 * instrumentation ends the span in its own trailers and error subscribers, and subscribers run
 * in subscription order, so ours must come first to write while the span is open.
 *
 * @returns The capture, or `undefined` (with one warning) when this Node has no body channels.
 */
export function createUndiciBodyCapture(): UndiciBodyCapture | undefined {
  if (!hasBodyChannels()) {
    warnOnce(
      "undici-bodies",
      `fetch bodies are captured from Node.js 24.4; ${process.version} has no undici body channels`,
    );

    return undefined;
  }
  // Keyed by the undici request object, which every channel and both hooks receive.
  const exchanges = new WeakMap<object, Exchange>();
  const listeners: [string, (message: unknown) => void][] = [];
  const listen = (
    name: string,
    handle: (request: object, message: { chunk?: unknown }) => void,
  ) => {
    // A throwing subscriber would become an uncaughtException.
    const listener = (message: unknown): void => {
      try {
        const { request } = message as { request: object };
        handle(request, message as { chunk?: unknown });
      } catch (err) {
        reportFailure(err);
      }
    };

    subscribe(name, listener);
    listeners.push([name, listener]);
  };
  const chunk =
    (direction: Direction) =>
    (request: object, message: { chunk?: unknown }) => {
      exchanges.get(request)?.[direction]?.capture.add(message.chunk);
    };

  const finish = (cut: boolean) => (request: object) => {
    const ex = exchanges.get(request);
    exchanges.delete(request);

    if (!ex?.span.isRecording()) return;

    for (const direction of ["request", "response"] as const) {
      const s = ex[direction];

      if (s !== undefined) {
        // A transfer that ends on the error channel was cut: report the bytes seen.
        ex.span.setAttributes(
          s.capture.attributes(direction, { ...s.meta, complete: !cut }),
        );
      }
    }
  };

  listen("undici:request:bodyChunkSent", chunk("request"));
  listen("undici:request:bodyChunkReceived", chunk("response"));
  listen("undici:request:trailers", finish(false));
  listen("undici:request:error", finish(true));

  return {
    requestHook(span, request) {
      if (!span.isRecording()) return;

      exchanges.set(request, {
        span,
        request: side(headerMap(request.headers), request.contentLength),
      });
    },
    responseHook(_span, { request, response }) {
      const ex = exchanges.get(request);

      if (
        ex === undefined ||
        responseHasNoBody(request.method, response.statusCode)
      )
        return;

      const headers = headerMap(response.headers);
      ex.response = side(headers, headers.get("content-length"));
    },
    unsubscribe() {
      for (const [name, listener] of listeners) unsubscribe(name, listener);
    },
  };
}
