import { errorMonitor } from "node:events";
import type {
  ClientRequest,
  IncomingMessage,
  OutgoingMessage,
  ServerResponse,
} from "node:http";
import type { Span } from "@opentelemetry/api";
import {
  BodyCapture,
  headerMap,
  reportFailure,
  responseHasNoBody,
  type BodyMeta,
} from "./rules.ts";

interface Side {
  readonly capture: BodyCapture;
  readonly meta: () => BodyMeta;
}

interface Exchange {
  readonly method: string | undefined;
  readonly request: Side;
  response?: Side;
  status?: () => number | undefined;
}

/** Body hooks for `instrumentation-http`, chained with the user's hooks. */
export interface HttpBodyHooks {
  /** Server: observes the request stream. Client: wraps `write`/`end` of the request. */
  readonly requestHook: (
    span: Span,
    request: ClientRequest | IncomingMessage,
  ) => void;
  /** Server: wraps `write`/`end` of the response. Client: observes the response stream. */
  readonly responseHook: (
    span: Span,
    response: IncomingMessage | ServerResponse,
  ) => void;
  /** Writes the body attributes once per span, while it is still recording. */
  readonly finalize: (span: Span) => void;
}

// No value import of node:http: in the ESM build it would create the module's ES facade before
// instrumentation is on, and the app's named imports (`import { request } from 'node:http'`)
// would stay unpatched.
function isIncoming(
  message: IncomingMessage | OutgoingMessage,
): message is IncomingMessage {
  return !("getHeader" in message);
}

function observe(message: IncomingMessage | OutgoingMessage): Side {
  const capture = new BodyCapture();
  const copy = (chunk: unknown, encoding: unknown): void => {
    try {
      capture.add(chunk, encoding);
    } catch (err) {
      reportFailure(err);
    }
  };

  if (isIncoming(message)) {
    // Copied now: axios deletes content-encoding from the shared message before it ends.
    const { headers } = message;
    const meta = {
      contentType: headers["content-type"],
      contentEncoding: headers["content-encoding"],
      contentLength: headers["content-length"],
    };

    // Observing emit sees flowing, read() and async-iterator consumers alike, and never reads,
    // pauses or resumes the stream.
    const emit = message.emit.bind(message);
    message.emit = (event: string | symbol, ...args: unknown[]): boolean => {
      if (event === "data") copy(args[0], message.readableEncoding);

      return emit(event, ...args);
    };

    return { capture, meta: () => ({ ...meta, complete: message.complete }) };
  }

  // The original runs first with the caller's arguments, so a rejected write is never counted
  // and our code never throws before the app's call has happened.
  const wrap =
    (original: (...args: never[]) => unknown) =>
    (...args: unknown[]): unknown => {
      const ended = message.writableEnded;
      const result: unknown = Reflect.apply(original, message, args);
      if (!ended && typeof args[0] !== "function") copy(args[0], args[1]);
      return result;
    };

  message.write = wrap(message.write.bind(message)) as OutgoingMessage["write"];
  message.end = wrap(message.end.bind(message)) as OutgoingMessage["end"];

  // Headers given to writeHead() directly (Fastify does this) are sent without being stored, so
  // getHeader() cannot see them later.
  let written = new Map<string, string>();

  if ("writeHead" in message) {
    const response = message as ServerResponse;
    const writeHead = response.writeHead.bind(response) as (
      ...args: unknown[]
    ) => unknown;

    response.writeHead = ((...args: unknown[]): unknown => {
      const result = writeHead(...args);

      try {
        const raw: unknown = args
          .slice(1)
          .find((a) => typeof a === "object" && a !== null);

        const list = Array.isArray(raw)
          ? raw.flat()
          : Object.entries(raw ?? {}).flat();

        if (list.length > 0) written = headerMap(list);
      } catch (err) {
        reportFailure(err);
      }

      return result;
    }) as ServerResponse["writeHead"];
  }

  const header = (name: string): unknown =>
    message.getHeader(name) ?? written.get(name);

  // Read when the span ends: the app sets outgoing headers after the hook ran.
  return {
    capture,
    meta: () => ({
      contentType: header("content-type"),
      contentEncoding: header("content-encoding"),
      contentLength: header("content-length"),
      complete: message.writableEnded,
    }),
  };
}

/**
 * Creates the `node:http` body hooks.
 *
 * @returns Hooks for `instrumentation-http`.
 */
export function createHttpBodyHooks(): HttpBodyHooks {
  const exchanges = new WeakMap<Span, Exchange>();
  const finalize = (span: Span): void => {
    try {
      const ex = exchanges.get(span);
      exchanges.delete(span);

      // Upstream calls applyCustomAttributesOnSpan on an ended span when the handler threw.
      if (ex === undefined || !span.isRecording()) return;

      span.setAttributes(
        ex.request.capture.attributes("request", ex.request.meta()),
      );

      if (
        ex.response !== undefined &&
        !responseHasNoBody(ex.method, ex.status?.())
      ) {
        span.setAttributes(
          ex.response.capture.attributes("response", ex.response.meta()),
        );
      }
    } catch (err) {
      reportFailure(err);
    }
  };

  return {
    requestHook(span, request) {
      if (!span.isRecording()) return;

      exchanges.set(span, {
        method: request.method,
        request: observe(request),
      });

      if (!isIncoming(request)) {
        // Upstream skips applyCustomAttributesOnSpan on client errors, aborts and cut responses.
        // Listeners added here run before upstream's, while the span is still open; errorMonitor
        // observes errors without changing whether they throw.
        const done = (): void => {
          finalize(span);
        };
        request.on(errorMonitor, done).on("close", done);
      }
    },
    responseHook(span, response) {
      const ex = exchanges.get(span);
      if (ex === undefined) return;

      ex.response = observe(response);
      ex.status = () => response.statusCode;
      
      // Upstream ends the span on a server response error without applyCustomAttributesOnSpan.
      if (!isIncoming(response)) {
        response.on(errorMonitor, () => {
          finalize(span);
        });
      }
    },
    finalize,
  };
}
