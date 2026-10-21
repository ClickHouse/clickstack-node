import {
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  type DiagLogger,
} from "@opentelemetry/api";
import { diagLogLevelFromString, getStringFromEnv } from "@opentelemetry/core";
import { getState } from "./state.ts";

// The cross-copy registry of @opentelemetry/api 1.x, so registrations by another api copy count.
const API_REGISTRY: unique symbol = Symbol.for("opentelemetry.js.api.1");

/**
 * Returns the global registry of `@opentelemetry/api`, shared by every copy of the api.
 *
 * @returns The registered APIs, such as `diag` and `trace`, or `undefined` when none is.
 */
export function apiRegistry(): { diag?: unknown; trace?: unknown } | undefined {
  return (
    globalThis as { [API_REGISTRY]?: { diag?: unknown; trace?: unknown } }
  )[API_REGISTRY];
}

/**
 * Writes `value` to `process.env[name]` only when the variable is unset or blank, so an
 * operator-set value always wins over a code option.
 *
 * @param name - Environment variable name.
 * @param value - Value to write; `undefined` writes nothing.
 */
export function setDefault(name: string, value: string | undefined): void {
  if (value !== undefined && getStringFromEnv(name) === undefined)
    process.env[name] = value;
}

/**
 * Runs `call` so that what it reports through `diag` is printed. Until NodeSDK starts there is no
 * diag logger unless the app installed one, and `diag` would drop everything, so a console logger
 * at `OTEL_LOG_LEVEL` (default warn) is registered for the call and removed, as upstream's own
 * register entry does around the auto-instrumentations bundle.
 *
 * @param call - The work to run.
 * @returns What `call` returns.
 */
export function withStartupLogger<T>(call: () => T): T {
  if (apiRegistry()?.diag !== undefined) return call();

  const sink = new DiagConsoleLogger();
  const logger: DiagLogger = {
    // The bundle does not know `console`, which this package reads from the same env lists.
    error: (message, ...args) => {
      if (!message.includes('"@opentelemetry/instrumentation-console"'))
        sink.error(message, ...args);
    },
    warn: sink.warn,
    info: sink.info,
    debug: sink.debug,
    verbose: sink.verbose,
  };

  diag.setLogger(logger, {
    logLevel:
      diagLogLevelFromString(getStringFromEnv("OTEL_LOG_LEVEL")) ??
      DiagLogLevel.WARN,
    suppressOverrideMessage: true,
  });

  try {
    return call();
  } finally {
    diag.disable();
  }
}

/**
 * Writes a message, prefixed with `clickstack-node:`, through `diag`, also before NodeSDK starts.
 * Never throws.
 *
 * @param level - Diag level.
 * @param message - Message without the prefix.
 * @param args - Extra values passed to the logger.
 */
export function report(
  level: "warn" | "error",
  message: string,
  ...args: unknown[]
): void {
  try {
    withStartupLogger(() => {
      diag[level](`clickstack-node: ${message}`, ...args);
    });
  } catch {
    // A failing logger must not turn into an error in the app.
  }
}

/**
 * Reports a warning through {@link report}, once per key per thread.
 *
 * @param key - Deduplication key.
 * @param message - Message without the prefix.
 * @param args - Extra values passed to the logger.
 */
export function warnOnce(
  key: string,
  message: string,
  ...args: unknown[]
): void {
  const state = getState();
  state.warned ??= new Set();

  if (state.warned.has(key)) return;

  state.warned.add(key);

  report("warn", message, ...args);
}
