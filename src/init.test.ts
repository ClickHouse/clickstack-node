import {
  diag,
  DiagLogLevel,
  trace,
  type TracerProvider,
} from "@opentelemetry/api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getState } from "./state.ts";

const calls = vi.hoisted(() => ({
  config: [] as Record<string, unknown>[],
  logLevels: [] as (string | undefined)[],
  map: [] as Record<string, unknown>[],
  consoles: 0,
  flushes: 0,
  started: 0,
  detectorsEnv: [] as (string | undefined)[],
  hookFails: false,
  sdkFails: false,
  bundle: [] as unknown[],
  loggerDuringBundle: [] as boolean[],
}));

vi.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: class {
    constructor(config: Record<string, unknown>) {
      if (calls.sdkFails) throw new Error("bad config");
      calls.config.push(config);
      calls.logLevels.push(process.env["OTEL_LOG_LEVEL"]);
    }

    start(): void {
      calls.started += 1;
    }
  },
}));
vi.mock("@opentelemetry/auto-instrumentations-node", () => {
  const registry = () =>
    (globalThis as Record<symbol, { diag?: unknown } | undefined>)[
      Symbol.for("opentelemetry.js.api.1")
    ];

  return {
    getNodeAutoInstrumentations: (map: Record<string, unknown>) => {
      calls.map.push(map);
      calls.loggerDuringBundle.push(registry()?.diag !== undefined);
      return calls.bundle;
    },
    getResourceDetectors: () => {
      calls.detectorsEnv.push(process.env["OTEL_NODE_RESOURCE_DETECTORS"]);
      return [];
    },
  };
});
vi.mock("@opentelemetry/instrumentation-console", () => ({
  ConsoleInstrumentation: vi.fn(function ConsoleInstrumentation() {
    calls.consoles += 1;
  }),
}));
vi.mock("./hook.ts", () => ({
  installEsmHook: () => {
    if (calls.hookFails) throw new Error("no hook");
    return "sync";
  },
}));
vi.mock("./lifecycle.ts", () => ({
  installLifecycle: () => undefined,
  flush: () => {
    calls.flushes += 1;
    return Promise.resolve();
  },
}));

const { init } = await import("./init.ts");

beforeEach(() => {
  const state = getState();
  for (const key of Object.keys(state)) Reflect.deleteProperty(state, key);

  Object.assign(calls, {
    config: [],
    logLevels: [],
    map: [],
    consoles: 0,
    flushes: 0,
    started: 0,
    detectorsEnv: [],
    hookFails: false,
    sdkFails: false,
    bundle: [],
    loggerDuringBundle: [],
  });

  for (const name of [
    "OTEL_SDK_DISABLED",
    "OTEL_LOG_LEVEL",
    "OTEL_NODE_RESOURCE_DETECTORS",
    "OTEL_NODE_DISABLED_INSTRUMENTATIONS",
    "OTEL_NODE_ENABLED_INSTRUMENTATIONS",
    "OTEL_TRACES_EXPORTER",
    "OTEL_METRICS_EXPORTER",
    "OTEL_LOGS_EXPORTER",
  ]) {
    vi.stubEnv(name, undefined);
  }

  diag.disable();
});

describe("init", () => {
  it("starts NodeSDK with the distro resource and crash capture on", () => {
    init();
    expect(calls.started).toBe(1);

    const resource = calls.config[0]?.["resource"] as {
      attributes: Record<string, unknown>;
    };

    expect(resource.attributes["telemetry.distro.name"]).toBe(
      "clickstack-node",
    );

    expect(
      calls.map[0]?.["@opentelemetry/instrumentation-runtime-node"],
    ).toEqual({
      captureUncaughtException: true,
    });

    expect(calls.consoles).toBe(1);
  });

  it("adds deployment.environment.name from the environment option", () => {
    init({ environment: "staging" });
    const resource = calls.config[0]?.["resource"] as {
      attributes: Record<string, unknown>;
    };

    expect(resource.attributes["deployment.environment.name"]).toBe("staging");
  });

  it("re-binds the aws-lambda instrumentation to a bounded flush of the started providers", async () => {
    const setTracerProvider = vi.fn();
    calls.bundle = [
      {
        instrumentationName: "@opentelemetry/instrumentation-aws-lambda",
        setTracerProvider,
      },
      {
        instrumentationName: "@opentelemetry/instrumentation-http",
        setTracerProvider: vi.fn(),
      },
    ];

    init();

    expect(setTracerProvider).toHaveBeenCalledOnce();

    const [provider] = setTracerProvider.mock.calls[0] as [
      { forceFlush: () => Promise<void> },
    ];

    await provider.forceFlush();

    expect(calls.flushes).toBe(1);
  });

  it("does nothing when another SDK registered a tracer provider", () => {
    const warn = vi.spyOn(diag, "warn").mockImplementation(() => undefined);
    trace.setGlobalTracerProvider({} as TracerProvider);

    try {
      init();

      expect(calls.started).toBe(0);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("already started"),
      );
    } finally {
      trace.disable();
    }
  });

  it("can install console capture again, for runtimes that replace console", () => {
    init();

    getState().repatchConsole?.();

    expect(calls.consoles).toBe(2);
  });

  it("starts once, and reports a second init() to the app's diag logger", () => {
    const warn = vi.fn();
    const noop = (): void => undefined;
    diag.setLogger(
      { error: noop, warn, info: noop, debug: noop, verbose: noop },
      DiagLogLevel.WARN,
    );

    init();
    init();

    expect(calls.started).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      "clickstack-node: an OpenTelemetry SDK is already started; init() does nothing",
    );
  });

  it("lets user config turn crash capture off", () => {
    init({
      instrumentations: {
        "@opentelemetry/instrumentation-runtime-node": {
          captureUncaughtException: false,
        },
      },
    });

    expect(
      calls.map[0]?.["@opentelemetry/instrumentation-runtime-node"],
    ).toEqual({
      captureUncaughtException: false,
    });
  });

  it("constructs nothing with OTEL_SDK_DISABLED=true", () => {
    vi.stubEnv("OTEL_SDK_DISABLED", "true");
    init();

    expect(calls.config).toEqual([]);
    expect(calls.consoles).toBe(0);
  });

  it("starts without the ESM hook when it cannot be installed, and warns", () => {
    calls.hookFails = true;
    init();

    expect(getState().esmHook).toBe("failed");
    expect(calls.started).toBe(1);
  });

  it("never throws into the app", () => {
    calls.sdkFails = true;

    expect(() => {
      init();
    }).not.toThrow();
    expect(calls.started).toBe(0);
  });

  it("sets OTEL_LOG_LEVEL=warn for NodeSDK only, and not when the app has a diag logger", () => {
    init();

    expect(calls.logLevels).toEqual(["warn"]);
    expect(process.env["OTEL_LOG_LEVEL"]).toBeUndefined();

    Reflect.deleteProperty(getState(), "initialized");
    const noop = (): void => undefined;
    diag.setLogger(
      { error: noop, warn: noop, info: noop, debug: noop, verbose: noop },
      DiagLogLevel.ERROR,
    );

    init();

    expect(calls.logLevels).toEqual(["warn", undefined]);
  });

  it("applies the resource detector default during detection only, and keeps a user value", () => {
    init();

    expect(calls.detectorsEnv).toEqual([
      "container,host,os,process,serviceinstance,env",
    ]);
    expect(process.env["OTEL_NODE_RESOURCE_DETECTORS"]).toBeUndefined();

    Reflect.deleteProperty(getState(), "initialized");
    vi.stubEnv("OTEL_NODE_RESOURCE_DETECTORS", "env,host");
    init();

    expect(calls.detectorsEnv[1]).toBe("env,host");
  });

  it("installs a console logger while the bundle reads the env lists, and removes it", () => {
    init();

    expect(calls.loggerDuringBundle).toEqual([true]);
    expect(
      (globalThis as Record<symbol, { diag?: unknown } | undefined>)[
        Symbol.for("opentelemetry.js.api.1")
      ]?.diag,
    ).toBeUndefined();
  });

  it.each([
    [{}, {}, { enabled: false }],
    [
      {},
      { "@opentelemetry/instrumentation-router": { enabled: true } },
      { enabled: true },
    ],
    [{ OTEL_NODE_ENABLED_INSTRUMENTATIONS: "express,router" }, {}, undefined],
  ])(
    "turns the router instrumentation off unless code or the enabled list asks for it: %j %j",
    (env, instrumentations, router) => {
      for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);

      init({ instrumentations });

      expect(calls.map[0]?.["@opentelemetry/instrumentation-router"]).toEqual(
        router,
      );
    },
  );

  it.each([
    [{ OTEL_NODE_DISABLED_INSTRUMENTATIONS: "console" }, 0],
    [{ OTEL_NODE_ENABLED_INSTRUMENTATIONS: "http" }, 0],
    [{ OTEL_NODE_ENABLED_INSTRUMENTATIONS: "http, console" }, 1],
    [{ OTEL_LOGS_EXPORTER: "console" }, 0],
    [{ OTEL_TRACES_EXPORTER: "otlp,console" }, 0],
    [{ OTEL_LOGS_EXPORTER: "otlp" }, 1],
  ])(
    "follows the bundle env lists and the console exporters for console capture: %j",
    (env, consoles) => {
      for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
      vi.spyOn(diag, "warn").mockImplementation(() => undefined);

      init();

      expect(calls.consoles).toBe(consoles);
    },
  );

  it("says why console capture is off when a console exporter is set", () => {
    vi.stubEnv("OTEL_LOGS_EXPORTER", "console");
    const warn = vi.spyOn(diag, "warn").mockImplementation(() => undefined);
    
    init();

    expect(warn).toHaveBeenCalledWith(
      "clickstack-node: console capture is off because OTEL_LOGS_EXPORTER includes console",
    );
  });
});
