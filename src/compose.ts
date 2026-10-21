import type { InstrumentationConfigMap } from "@opentelemetry/auto-instrumentations-node";
import { getStringListFromEnv } from "@opentelemetry/core";
import { createHttpBodyHooks } from "./body/http.ts";
import { reportFailure } from "./body/rules.ts";
import { createUndiciBodyCapture } from "./body/undici.ts";
import { warnOnce } from "./env.ts";
import { recordInvocationDeadline } from "./lifecycle.ts";

const HTTP = "@opentelemetry/instrumentation-http";
const UNDICI = "@opentelemetry/instrumentation-undici";
const LAMBDA = "@opentelemetry/instrumentation-aws-lambda";
const HEADERS_ENV = "OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_";
const SANITIZE_DEFAULT = [
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
];

// Ours runs first and is isolated, so it can neither reach the app nor skip the user's hook. The
// user's runs last and uncaught: its attributes win and upstream keeps its own error handling.
function chain<A extends unknown[]>(
  ours: (...args: A) => void,
  user: ((...args: A) => void) | undefined,
): (...args: A) => void {
  return function (this: unknown, ...args: A): void {
    try {
      ours(...args);
    } catch (err) {
      reportFailure(err);
    }

    user?.apply(this, args);
  };
}

/**
 * Returns a copy of the user's instrumentation config with the header lists from
 * `OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_*` and, when body capture is on, our body hooks
 * merged into the http and undici entries, and a hook that records each AWS Lambda invocation's
 * deadline. The bundle passes each entry to the instrumentation
 * constructor as is, so this is the only place to merge.
 *
 * @param user - The `instrumentations` option.
 * @param bodies - Whether body capture is on.
 * @returns The composed map and the fetch body unsubscribe function, if any.
 */
export function composeInstrumentationConfig(
  user: InstrumentationConfigMap | undefined,
  bodies: boolean,
): { map: InstrumentationConfigMap; unsubscribe: (() => void) | undefined } {
  const sanitize = new Set(
    (
      getStringListFromEnv(`${HEADERS_ENV}SANITIZE_FIELDS`) ?? SANITIZE_DEFAULT
    ).map((n) => n.toLowerCase()),
  );

  // Names are exact and case-insensitive. Sensitive names are left out entirely instead of
  // being captured and masked.
  const names = (
    list: string,
    code: readonly string[] | undefined,
  ): string[] => {
    const all = [
      ...(getStringListFromEnv(HEADERS_ENV + list) ?? []),
      ...(code ?? []),
    ];

    const kept = new Set<string>();
    for (const name of all.map((n) => n.toLowerCase())) {
      if (!sanitize.has(name)) kept.add(name);
      else
        warnOnce(
          `sanitized:${name}`,
          `header "${name}" is on the sanitize list and is not captured`,
        );
    }

    return [...kept];
  };

  const http = user?.[HTTP] ?? {};
  const hh = http.headersToSpanAttributes;
  const httpEntry: typeof http = {
    ...http,
    headersToSpanAttributes: {
      server: {
        requestHeaders: names("SERVER_REQUEST", hh?.server?.requestHeaders),
        responseHeaders: names("SERVER_RESPONSE", hh?.server?.responseHeaders),
      },
      client: {
        requestHeaders: names("CLIENT_REQUEST", hh?.client?.requestHeaders),
        responseHeaders: names("CLIENT_RESPONSE", hh?.client?.responseHeaders),
      },
    },
  };
  const undici = user?.[UNDICI] ?? {};
  const uh = undici.headersToSpanAttributes;
  const requestHeaders = names("CLIENT_REQUEST", uh?.requestHeaders);
  const responseHeaders = names("CLIENT_RESPONSE", uh?.responseHeaders);
  const undiciEntry: typeof undici = {
    ...undici,
    // instrumentation-undici parses the headers of every request when a list is set, even [].
    headersToSpanAttributes: {
      ...(requestHeaders.length > 0 ? { requestHeaders } : {}),
      ...(responseHeaders.length > 0 ? { responseHeaders } : {}),
    },
  };

  let unsubscribe: (() => void) | undefined;
  if (bodies) {
    const hooks = createHttpBodyHooks();

    httpEntry.requestHook = chain(hooks.requestHook, http.requestHook);
    httpEntry.responseHook = chain(hooks.responseHook, http.responseHook);
    httpEntry.applyCustomAttributesOnSpan = chain((span) => {
      hooks.finalize(span);
    }, http.applyCustomAttributesOnSpan);
    const fetchBodies = createUndiciBodyCapture();
    if (fetchBodies !== undefined) {
      undiciEntry.requestHook = chain(
        fetchBodies.requestHook,
        undici.requestHook,
      );

      undiciEntry.responseHook = chain(
        fetchBodies.responseHook,
        undici.responseHook,
      );

      unsubscribe = fetchBodies.unsubscribe;
    }
  }
  const lambda = user?.[LAMBDA] ?? {};
  const lambdaEntry: typeof lambda = {
    ...lambda,
    // instrumentation-aws-lambda flushes after every invocation, also without withFlush.
    requestHook: chain((_span, { context }) => {
      recordInvocationDeadline(context);
    }, lambda.requestHook),
  };

  return {
    map: {
      ...user,
      [HTTP]: httpEntry,
      [UNDICI]: undiciEntry,
      [LAMBDA]: lambdaEntry,
    },
    unsubscribe,
  };
}
