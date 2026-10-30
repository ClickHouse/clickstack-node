// A namespace import: `isInternalThread` arrived in Node 22.14 and 23.7, and a named import of a
// missing builtin export fails to link the ES module build before init() can run.
import * as workerThreads from "node:worker_threads";
import { trace, type TracerProvider } from "@opentelemetry/api";
import {
  getNodeAutoInstrumentations,
  getResourceDetectors,
} from "@opentelemetry/auto-instrumentations-node";
import {
  getBooleanFromEnv,
  getStringFromEnv,
  getStringListFromEnv,
} from "@opentelemetry/core";
import { ConsoleInstrumentation } from "@opentelemetry/instrumentation-console";
import {
  defaultResource,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_TELEMETRY_DISTRO_NAME,
  ATTR_TELEMETRY_DISTRO_VERSION,
} from "@opentelemetry/semantic-conventions";
import { composeInstrumentationConfig } from "./compose.ts";
import { applyOptions, type ClickStackNodeOptions } from "./config.ts";
import { apiRegistry, report, warnOnce, withStartupLogger } from "./env.ts";
import { exceptionAttributes } from "./exception.ts";
import { installEsmHook } from "./hook.ts";
import { flush, installLifecycle } from "./lifecycle.ts";
import { getState } from "./state.ts";
import { VERSION } from "./version.ts";

/**
 * Starts the OpenTelemetry SDK with ClickStack defaults: traces, metrics and logs over OTLP,
 * `console` capture, and a flush on shutdown, termination signals and crashes.
 *
 * Options with an environment variable are written to `process.env` only when that variable is
 * unset, so a variable set by an operator always wins. A second call, or a call after another
 * OpenTelemetry SDK registered a tracer provider, logs a warning and does nothing. With
 * `OTEL_SDK_DISABLED=true` it does nothing at all. It never throws.
 *
 * Call it before the app loads the modules to instrument. In an ES module entry, static imports
 * run first, so start the process with the register entry instead:
 * `node --import @clickhouse/clickstack-node/register app.mjs` (it also works with `--require` and
 * in `NODE_OPTIONS`); that entry calls `init()` without options.
 *
 * @param options - Code options; each loses to its environment variable.
 * @example
 * At the top of a CommonJS entry, before anything else is required:
 * ```js
 * const { init } = require('@clickhouse/clickstack-node');
 *
 * init({ serviceName: 'checkout', endpoint: 'https://otel.example.com:4318', apiKey: process.env.KEY });
 *
 * const express = require('express');
 * ```
 * @public
 */
export function init(options: ClickStackNodeOptions = {}): void {
  try {
    start(options);
  } catch (err) {
    getState().unsubscribeUndici?.();
    report("error", "init() failed; the application is not instrumented", err);
  }
}

function start(options: ClickStackNodeOptions): void {
  // Node re-runs --require preloads in its module.register() hooks thread.
  if (workerThreads.isInternalThread) return;

  // Instrumentation constructors patch modules and the NodeSDK constructor installs diag, so
  // nothing may be constructed when the SDK is disabled.
  if (getBooleanFromEnv("OTEL_SDK_DISABLED")) return;

  const state = getState();
  const registry = apiRegistry();
  if (state.initialized === true || registry?.trace !== undefined) {
    report(
      "warn",
      "an OpenTelemetry SDK is already started; init() does nothing",
    );
    return;
  }
  state.initialized = true;

  applyOptions(options);
  try {
    state.esmHook = installEsmHook();
  } catch (err) {
    state.esmHook = "failed";
    warnOnce(
      "esm-hook",
      "ESM loader hook not installed; ES modules are not instrumented",
      err,
    );
  }

  const bodies = getBooleanFromEnv("CLICKSTACK_CAPTURE_HTTP_BODY");
  const { map, unsubscribe } = composeInstrumentationConfig(
    options.instrumentations,
    bodies,
  );

  if (unsubscribe !== undefined) state.unsubscribeUndici = unsubscribe;

  const runtimeNode = "@opentelemetry/instrumentation-runtime-node";
  const runtime = map[runtimeNode] ?? {};
  map[runtimeNode] = {
    captureUncaughtException: true,
    ...runtime,
    applyCustomExceptionAttributes: (error, eventType) => ({
      ...exceptionAttributes(error),
      ...runtime.applyCustomExceptionAttributes?.(error, eventType),
    }),
  };

  const disabled = getStringListFromEnv("OTEL_NODE_DISABLED_INSTRUMENTATIONS");
  const enabled = getStringListFromEnv("OTEL_NODE_ENABLED_INSTRUMENTATIONS");

  // Express 5 is built on the `router` package, which the express instrumentation already covers:
  // with both, every layer gets two spans and every route error three exception events. Express 4
  // has its own router. A set enabled list already decides, so only the default changes.
  const router = "@opentelemetry/instrumentation-router";
  if (enabled === undefined) map[router] = { enabled: false, ...map[router] };

  // Console capture follows the bundle's env lists, although `console` is not a bundle member.
  const consoleListed =
    disabled?.includes("console") !== true &&
    (enabled?.includes("console") ?? true);
  // The console exporters print with console.dir, and instrumentation-console records that output,
  // also during exports, so every printed span or record would come back as a log record.
  const consoleExporter = [
    "OTEL_TRACES_EXPORTER",
    "OTEL_METRICS_EXPORTER",
    "OTEL_LOGS_EXPORTER",
  ].find((name) => getStringListFromEnv(name)?.includes("console"));
  if (consoleListed && consoleExporter !== undefined) {
    warnOnce(
      "console-exporter",
      `console capture is off because ${consoleExporter} includes console`,
    );
  }
  const consoleCapture = consoleListed && consoleExporter === undefined;

  const instrumentations = [
    // Unknown names in the OTEL_NODE_*_INSTRUMENTATIONS lists are reported here.
    ...withStartupLogger(() => getNodeAutoInstrumentations(map)),
    ...(consoleCapture ? [new ConsoleInstrumentation()] : []),
    ...(options.additionalInstrumentations ?? []),
  ];

  const build = (): NodeSDK =>
    new NodeSDK({
      // Detected attributes are merged over this resource, so env values win per key.
      resource: defaultResource().merge(
        resourceFromAttributes({
          ...(options.environment
            ? { [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: options.environment }
            : {}),
          [ATTR_TELEMETRY_DISTRO_NAME]: "clickstack-node",
          [ATTR_TELEMETRY_DISTRO_VERSION]: VERSION,
        }),
      ),
      // No cloud detectors: they probe metadata endpoints at startup. `env` is last, so
      // OTEL_RESOURCE_ATTRIBUTES and OTEL_SERVICE_NAME win per key.
      resourceDetectors: withDefault(
        "OTEL_NODE_RESOURCE_DETECTORS",
        "container,host,os,process,serviceinstance,env",
        () => withStartupLogger(getResourceDetectors),
      ),
      instrumentations,
    });

  // Without OTEL_LOG_LEVEL, NodeSDK installs no diag logger and export errors are silent. Not when
  // the app has its own logger, which NodeSDK would replace with two warnings.
  const sdk =
    registry?.diag === undefined
      ? withDefault("OTEL_LOG_LEVEL", "warn", build)
      : build();
  sdk.start();
  state.sdk = sdk;

  if (consoleCapture) {
    // AWS Lambda's runtime replaces the console methods after preloads; withFlush compares
    // against this reference and installs console capture again.
    // eslint-disable-next-line no-console -- reads the patched method; nothing is printed
    state.consoleLog = console.log;
    state.repatchConsole = () => {
      new ConsoleInstrumentation();
    };
  }

  installLifecycle();

  // NodeSDK registers instrumentations before the tracer provider, so instrumentation-aws-lambda
  // bound its trace flusher to the no-op delegate and would never flush spans. It waits for that
  // flusher before each invocation returns, without a deadline, so it gets the bounded flush().
  const provider = trace.getTracerProvider();
  const bounded: TracerProvider & { forceFlush: () => Promise<void> } = {
    getTracer: (...args) => provider.getTracer(...args),
    forceFlush: () => flush(),
  };

  for (const instrumentation of instrumentations) {
    if (
      instrumentation.instrumentationName ===
      "@opentelemetry/instrumentation-aws-lambda"
    ) {
      instrumentation.setTracerProvider(bounded);
    }
  }
}

// A default for one call only, so child processes do not inherit it: plain NodeSDK in a child
// would reject the `container` detector name, and replace an app logger for OTEL_LOG_LEVEL.
function withDefault<T>(name: string, value: string, call: () => T): T {
  if (getStringFromEnv(name) !== undefined) return call();

  process.env[name] = value;

  try {
    return call();
  } finally {
    Reflect.deleteProperty(process.env, name);
  }
}
