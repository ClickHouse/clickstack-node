import { constants } from "node:os";
import { inspect } from "node:util";
import { isMainThread } from "node:worker_threads";
import { metrics, trace } from "@opentelemetry/api";
// The only api-logs import in the package: OTel JS 3.x moves `logs` into @opentelemetry/api.
import { logs } from "@opentelemetry/api-logs";
import { getStringFromEnv } from "@opentelemetry/core";
import { report } from "./env.ts";
import { getState } from "./state.ts";

const DEFAULT_TIMEOUT_MILLIS = 5000;
// @sentry/node's default shutdownTimeout.
const SENTRY_SEND_MILLIS = 2000;
// Left for the Lambda runtime to return the response after the last flush.
const INVOCATION_MARGIN_MILLIS = 500;
const SIGNALS = ["SIGTERM", "SIGINT"] as const;

// Resolves true when `work` settles and false when the deadline passes first. Every caller's work
// catches its own errors, so this never rejects. Terminating paths keep the timer referenced, so
// they reach the exit even when the work hangs without holding a handle; elsewhere it must never
// delay the app's exit.
function bounded(
  work: () => Promise<unknown>,
  ms: number,
  keepAlive: boolean,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(resolve, ms, false);
    if (!keepAlive) timer.unref();
  });

  // Started in a microtask, so listeners after ours in the same emit still record telemetry first.
  const settled = Promise.resolve()
    .then(work)
    .then(() => true);

  return Promise.race([settled, deadline]).then((inTime) => {
    clearTimeout(timer);

    if (!inTime)
      report(
        "warn",
        `flush or shutdown did not finish within ${String(ms)} ms`,
      );

    return inTime;
  });
}

function timeoutOf(timeoutMillis: number | undefined): number {
  if (timeoutMillis !== undefined && timeoutMillis > 0)
    return Math.min(timeoutMillis, 2_147_483_647);

  // A collector outage must not turn every Lambda invocation into a timeout.
  const deadline = getState().invocationDeadline;

  return deadline === undefined
    ? DEFAULT_TIMEOUT_MILLIS
    : Math.max(1, Math.min(DEFAULT_TIMEOUT_MILLIS, deadline - Date.now()));
}

// Memoized: a second NodeSDK shutdown logs two warnings. BatchLogRecordProcessor drops batches
// that an in-flight forceFlush has not exported yet when shutdown starts in the middle of it.
function sdkShutdown(): Promise<void> {
  const state = getState();
  const sdk = state.sdk;

  if (sdk === undefined) return Promise.resolve();

  return (state.shutdownPromise ??= (async () => {
    await state.flushInFlight;

    try {
      await sdk.shutdown();
    } catch (error) {
      report("warn", "shutdown failed", error);
    }

    state.unsubscribeUndici?.();
  })());
}

/**
 * Records when the current AWS Lambda invocation must return, so flushes end in time.
 *
 * @param context - The invocation context; anything without `getRemainingTimeInMillis` is ignored.
 */
export function recordInvocationDeadline(context: unknown): void {
  const remaining = (
    context as { getRemainingTimeInMillis?: () => unknown } | null | undefined
  )?.getRemainingTimeInMillis?.();

  if (typeof remaining === "number")
    getState().invocationDeadline =
      Date.now() + remaining - INVOCATION_MARGIN_MILLIS;
}

/**
 * Exports the spans, metrics and log records the SDK has buffered, without stopping it.
 *
 * @remarks
 * Calls `forceFlush` on the global tracer, meter and logger providers. Before `init`, or with
 * `OTEL_SDK_DISABLED=true`, it resolves at once; after {@link shutdown} it waits for the shutdown.
 * Failures and timeouts are reported through the OpenTelemetry `diag` logger. Inside a
 * {@link withFlush} invocation the default bound also ends before the invocation's deadline.
 *
 * @param timeoutMillis - Upper bound in milliseconds, 5000 by default; zero, negative and NaN
 *   mean the default.
 * @returns A promise that resolves when every provider has flushed or the bound has passed. It
 *   never rejects.
 * @public
 */
export async function flush(timeoutMillis?: number): Promise<void> {
  const state = getState();
  if (state.sdk === undefined) return;

  const ms = timeoutOf(timeoutMillis);
  const pending = state.shutdownPromise;
  if (pending !== undefined) {
    await bounded(() => pending, ms, false);

    return;
  }

  // The global tracer provider is the API's proxy; forceFlush lives on its delegate.
  const tracer = trace.getTracerProvider() as { getDelegate?: () => unknown };
  const providers = [
    tracer.getDelegate?.() ?? tracer,
    metrics.getMeterProvider(),
    logs.getLoggerProvider(),
  ];

  const work = Promise.all(
    providers.map(async (provider) => {
      const p = provider as {
        forceFlush?: (o: { timeoutMillis: number }) => Promise<unknown>;
      };

      if (typeof p.forceFlush !== "function") return;

      try {
        await p.forceFlush({ timeoutMillis: ms });
      } catch (error) {
        report("warn", "flush failed", error);
      }
    }),
  );

  state.flushInFlight = Promise.all([state.flushInFlight, work]);

  await bounded(() => work, ms, false);
}

/**
 * Flushes and stops the SDK started by `init`; telemetry recorded afterwards is dropped.
 *
 * @remarks
 * Later calls, and the automatic shutdown on `beforeExit`, SIGTERM, SIGINT and uncaught
 * exceptions, share the first call's work. Scripts that end with `process.exit()`, and app signal
 * handlers that exit, should await it first, because `process.exit()` skips `beforeExit`.
 *
 * @param timeoutMillis - Upper bound in milliseconds, 5000 by default; zero, negative and NaN
 *   mean the default.
 * @returns A promise that resolves when the SDK has shut down or the bound has passed. It never
 *   rejects.
 * @example
 * ```ts
 * process.on('SIGTERM', async () => {
 *   await server.close();
 *   await shutdown();
 *   process.exit(0);
 * });
 * ```
 * @public
 */
export async function shutdown(timeoutMillis?: number): Promise<void> {
  if (getState().sdk === undefined) return;

  await bounded(sdkShutdown, timeoutOf(timeoutMillis), false);
}

/**
 * Wraps an async serverless handler so buffered telemetry is exported before each invocation
 * returns.
 *
 * @remarks
 * Awaits the handler, then {@link flush} in a `finally` block, so telemetry is also exported when
 * the handler throws. Flushes during the invocation end 500 ms before its deadline
 * (`context.getRemainingTimeInMillis()`). On its first call it installs console capture again if
 * the AWS Lambda runtime replaced the console methods after the preload ran. Callback-style
 * handlers are not supported.
 *
 * @typeParam E - The invocation event type.
 * @typeParam C - The runtime context type, for example the AWS Lambda `Context`.
 * @typeParam R - The value the handler's promise resolves to.
 * @param handler - The async handler to wrap.
 * @returns A handler with the same parameters and result.
 * @example
 * With `NODE_OPTIONS=--import @clickhouse/clickstack-node/register` set on the function:
 * ```ts
 * import { withFlush } from '@clickhouse/clickstack-node';
 *
 * export const handler = withFlush(async (event: { name?: string }) => {
 *   console.log('greeting', event.name);
 *   return { statusCode: 200, body: 'ok' };
 * });
 * ```
 * @public
 */
export function withFlush<E, C, R>(
  handler: (event: E, context: C) => Promise<R>,
): (event: E, context: C) => Promise<R> {
  let firstCall = true;

  return async function flushingHandler(event: E, context: C): Promise<R> {
    const state = getState();

    try {
      recordInvocationDeadline(context);

      if (firstCall) {
        firstCall = false;

        // eslint-disable-next-line no-console -- reads the method; nothing is printed
        const current = console.log;
        if (
          state.repatchConsole !== undefined &&
          current !== state.consoleLog
        ) {
          state.repatchConsole();

          // eslint-disable-next-line no-console -- reads the patched method; nothing is printed
          state.consoleLog = console.log;
        }
      }
    } catch (error) {
      report("warn", "could not prepare the invocation", error);
    }

    try {
      return await handler(event, context);
    } finally {
      await flush();
    }
  };
}

// What Node prints for a fatal exception: util.inspect keeps `cause`, extra properties and
// AggregateError members, which `err.stack` drops.
function writeFatal(error: unknown): void {
  try {
    const body =
      typeof error === "string"
        ? error
        : inspect(error, { customInspect: false, depth: 5 });

    // Synchronous, because the process exits soon. Loaded lazily: a value import in the ESM build
    // would keep the fs instrumentation from patching the app's named `node:fs` imports.
    process
      .getBuiltinModule("node:fs")
      .writeSync(2, `${body}\n\nNode.js ${process.version}\n`);
  } catch {
    // Nothing left to report to.
  }
}

// signal-exit (behind execa, write-file-atomic, proper-lockfile and others) re-raises the signal
// within the same emit once its own listeners are the only ones left, which would cut the flush.
// Its listeners are not the app's; v4 and v3 count them on these globals.
function signalExitListeners(): number {
  const v4 = (globalThis as Record<symbol, { count?: unknown } | undefined>)[
    Symbol.for("signal-exit emitter")
  ];

  const v3 = (process as { __signal_exit_emitter__?: { count?: unknown } })
    .__signal_exit_emitter__;

  return [v4?.count, v3?.count].reduce<number>(
    (sum, count) => sum + (typeof count === "number" ? count : 0),
    0,
  );
}

/**
 * Installs the `beforeExit`, SIGTERM, SIGINT and `uncaughtException` handlers, once per thread.
 * Signal and crash handlers go on the main thread only: workers never receive signals, and a
 * worker crash listener would hide the parent's `error` event.
 */
export function installLifecycle(): void {
  let terminating = false;
  let terminatingSince = 0;

  // The nodejs22.x Lambda runtime fires beforeExit after every callback-style invocation, so a
  // shutdown there would end telemetry after the first one; Lambda relies on the flush after each
  // invocation.
  if (getStringFromEnv("AWS_LAMBDA_FUNCTION_NAME") === undefined) {
    // `once`: the shutdown's own I/O makes the loop fire beforeExit again.
    process.once("beforeExit", () => {
      if (terminating) return;

      void bounded(sdkShutdown, DEFAULT_TIMEOUT_MILLIS, false).then(
        (inTime) => {
          // A pending export keeps the loop alive until the exporter's own timeout, so the bound is
          // enforced here. No argument keeps process.exitCode.
          if (!inTime) process.exit();
        },
      );
    });
  }

  if (!isMainThread) return;

  const onSignal = (signal: NodeJS.Signals): void => {
    if (terminating) {
      // npm and the terminal both deliver Ctrl-C, so a repeat within a second is the same press; a
      // later one means the user will not wait for the flush.
      if (Date.now() - terminatingSince > 1000)
        process.exit(128 + constants.signals[signal]);

      return;
    }

    const others = process
      .listeners(signal)
      .filter((listener) => listener !== onSignal).length;

    if (others > signalExitListeners()) {
      // The app owns exit. Removing ours lets count-based handlers such as signal-exit see
      // themselves as the last listener; otherwise both would defer and the process never exits.
      process.removeListener(signal, onSignal);
      void flush();

      return;
    }

    terminating = true;
    terminatingSince = Date.now();

    void bounded(sdkShutdown, DEFAULT_TIMEOUT_MILLIS, true).then(() => {
      for (const name of SIGNALS) process.removeListener(name, onSignal);

      try {
        // With no listener of the app left, the process normally dies by the signal here (exit
        // status 143 or 130), after signal-exit, if loaded, has run its handlers.
        process.kill(process.pid, signal);
      } catch {
        // The exit below still ends the process.
      }

      // Reached only when the re-raise was ignored, as for Node running as PID 1 in a container.
      process.exit(128 + constants.signals[signal]);
    });
  };

  // Prepended, so an app `once` listener added before init still counts as the app's.
  for (const signal of SIGNALS) process.prependListener(signal, onSignal);

  const onUncaughtException = (error: unknown): void => {
    try {
      const listeners = process.listeners("uncaughtException");

      // @sentry/node tags its handler, and leaves the exit to any untagged listener.
      const isSentry = (listener: (typeof listeners)[number]): boolean =>
        "_errorHandler" in listener && listener._errorHandler === true;
      const appOwned = listeners.some(
        (listener) =>
          listener !== onUncaughtException &&
          // Node adds this one whenever node:domain is loaded.
          listener.name !== "domainUncaughtExceptionClear" &&
          !isSentry(listener),
      );

      if (appOwned) return;

      process.exitCode = 1;
      // Node would have exited at the first error, so later ones during the flush are not printed.
      if (terminating) return;

      writeFatal(error);

      terminating = true;
      terminatingSince = Date.now();

      // Sentry captures the crash but sends it only after this listener returns, so an exit right
      // after our shutdown would drop its event.
      const sentry = listeners.some(isSentry)
        ? new Promise((resolve) => setTimeout(resolve, SENTRY_SEND_MILLIS))
        : undefined;
      void Promise.all([
        bounded(sdkShutdown, DEFAULT_TIMEOUT_MILLIS, true),
        sentry,
      ]).then(() => {
        process.exit(1);
      });
    } catch {
      // A throw from an uncaughtException listener makes Node exit with code 7.
      process.exit(1);
    }
  };

  process.prependListener("uncaughtException", onUncaughtException);
}
