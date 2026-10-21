import type { NodeSDK } from "@opentelemetry/sdk-node";

/** How the ESM loader hook was installed in this thread. */
export type EsmHookMode = "sync" | "async" | "failed";

/**
 * State shared by every copy of the package in one thread. `--import` loads `dist/*.mjs` and a
 * later `require()` loads `dist/*.cjs`, so module-level variables would diverge. Fields are only
 * ever added, because two versions of the package may share the slot.
 */
export interface ClickStackState {
  /** Set once `init()` gets past its guards, before anything is constructed. */
  initialized?: boolean;
  sdk?: NodeSDK;
  esmHook?: EsmHookMode;
  warned?: Set<string>;
  /** Every `flush()` still running, which a shutdown waits for. */
  flushInFlight?: Promise<unknown>;
  /** When the current AWS Lambda invocation must return, as recorded by `withFlush`. */
  invocationDeadline?: number;
  shutdownPromise?: Promise<void>;
  /** `console.log` right after console capture was installed (Lambda re-patch check). */
  consoleLog?: unknown;
  /** Installs console capture again when a runtime replaced the console methods. */
  repatchConsole?: () => void;
  /** Stops the fetch body capture subscribers. */
  unsubscribeUndici?: () => void;
}

const KEY: unique symbol = Symbol.for("@clickhouse/clickstack-node");

/**
 * Returns the per-thread shared state, creating it on first use.
 *
 * @returns The state stored on `globalThis`.
 */
export function getState(): ClickStackState {
  const slot = globalThis as { [KEY]?: ClickStackState | undefined };
  return (slot[KEY] ??= {});
}
