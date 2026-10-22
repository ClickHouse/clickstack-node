import {
  diag,
  logs,
  metrics,
  trace,
  type LoggerProvider,
  type MeterProvider,
  type TracerProvider,
} from "@opentelemetry/api";
import type { NodeSDK } from "@opentelemetry/sdk-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flush, installLifecycle, shutdown, withFlush } from "./lifecycle.ts";
import { getState } from "./state.ts";

type ForceFlush = () => Promise<void>;

function providers(impl: ForceFlush = () => Promise.resolve()) {
  const tracer = vi.fn(impl);
  const meter = vi.fn(impl);
  const logger = vi.fn(impl);

  trace.setGlobalTracerProvider({
    forceFlush: tracer,
  } as unknown as TracerProvider);
  metrics.setGlobalMeterProvider({
    forceFlush: meter,
  } as unknown as MeterProvider);
  logs.setGlobalLoggerProvider({
    forceFlush: logger,
  } as unknown as LoggerProvider);

  return { tracer, meter, logger };
}

function sdk(impl: () => Promise<void> = () => Promise.resolve()) {
  const sdkShutdown = vi.fn(impl);

  getState().sdk = { shutdown: sdkShutdown } as unknown as NodeSDK;

  return sdkShutdown;
}

beforeEach(() => {
  const state = getState();
  for (const key of Object.keys(state)) Reflect.deleteProperty(state, key);
});

afterEach(() => {
  trace.disable();
  metrics.disable();
  logs.disable();
});

describe("flush", () => {
  it("resolves at once before init", async () => {
    const { tracer } = providers();

    await flush();

    expect(tracer).not.toHaveBeenCalled();
  });

  it("flushes the tracer behind the API proxy, the meter and the logger provider", async () => {
    sdk();
    const { tracer, meter, logger } = providers();

    await flush(1000);

    for (const p of [tracer, meter, logger])
      expect(p).toHaveBeenCalledWith({ timeoutMillis: 1000 });
  });

  it("never rejects, and gives up at the bound", async () => {
    sdk();
    providers(() => Promise.reject(new Error("export failed")));

    await expect(flush()).resolves.toBeUndefined();

    providers(() => new Promise(() => undefined));

    const started = Date.now();
    await flush(50);

    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("shutdown", () => {
  it("shuts the SDK down once, after the flush in flight, and never rejects", async () => {
    const order: string[] = [];

    const sdkShutdown = sdk(() => {
      order.push("shutdown");
      return Promise.reject(new Error("export failed"));
    });

    let release: () => void = () => undefined;
    const flushed = new Promise<void>((resolve) => {
      release = () => {
        order.push("flushed");

        resolve();
      };
    });

    providers(() => flushed);

    const flushing = flush();
    const first = shutdown();
    await Promise.resolve();

    release();
    await Promise.all([flushing, first, shutdown()]);

    expect(sdkShutdown).toHaveBeenCalledOnce();
    expect(order).toEqual(["flushed", "shutdown"]);
  });

  it("waits for every flush in flight, not only the latest", async () => {
    const sdkShutdown = sdk();
    const releases: (() => void)[] = [];
    const gates = [0, 1].map(
      (i) =>
        new Promise<void>((resolve) => {
          releases[i] = resolve;
        }),
    );

    let calls = 0;

    // Three providers per flush: the first flush waits on gate 0, the second on gate 1.
    providers(() => gates[Math.floor(calls++ / 3)] ?? Promise.resolve());

    const flushes = [flush(), flush()];
    const done = shutdown();
    releases[1]?.();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sdkShutdown).not.toHaveBeenCalled();

    releases[0]?.();
    await Promise.all([...flushes, done]);

    expect(sdkShutdown).toHaveBeenCalledOnce();
  });
});

describe("flush after shutdown", () => {
  it("waits for the shutdown instead of flushing providers that are shut down", async () => {
    sdk();
    const { tracer } = providers();

    await shutdown();
    await flush();

    expect(tracer).not.toHaveBeenCalled();
  });
});

describe("withFlush", () => {
  it("flushes after the handler resolves or throws, and passes the outcome through", async () => {
    sdk();
    const { logger } = providers();

    await expect(
      withFlush((n: number) => Promise.resolve(n * 2))(2, {}),
    ).resolves.toBe(4);

    await expect(
      withFlush(() => Promise.reject(new Error("boom")))(1, {}),
    ).rejects.toThrow("boom");

    expect(logger).toHaveBeenCalledTimes(2);
  });

  it("installs console capture again once when the runtime replaced console, across wrappers", async () => {
    const repatch = vi.fn();
    getState().repatchConsole = repatch;
    getState().consoleLog = () => undefined;

    const handler = withFlush(() => Promise.resolve());
    await handler(1, 2);
    await handler(1, 2);
    await withFlush(() => Promise.resolve())(1, 2);

    expect(repatch).toHaveBeenCalledOnce();
  });

  it("ends flushes before the invocation's deadline", async () => {
    sdk();
    const { logger } = providers();
    const context = { getRemainingTimeInMillis: () => 700 };

    await withFlush(() => Promise.resolve())(1, context);
    const [{ timeoutMillis }] = logger.mock.calls[0] as unknown as [
      { timeoutMillis: number },
    ];

    expect(timeoutMillis).toBeGreaterThan(0);
    expect(timeoutMillis).toBeLessThanOrEqual(200);
  });

  it("still runs the handler when console capture cannot be installed again", async () => {
    getState().repatchConsole = () => {
      throw new Error("patch failed");
    };

    getState().consoleLog = () => undefined;
    await expect(withFlush(() => Promise.resolve("ok"))(1, 2)).resolves.toBe(
      "ok",
    );
  });
});

type Handler = (arg?: unknown) => void;
const handlers = new Map<string, Handler>();
let listeners: Record<string, Handler[]> = {};
let remove: ReturnType<typeof vi.spyOn>;

function captureHandlers(): void {
  handlers.clear();
  listeners = {};

  vi.stubEnv("AWS_LAMBDA_FUNCTION_NAME", undefined);
  const record = (event: string | symbol, fn: Handler) => {
    handlers.set(String(event), fn);
    return process;
  };

  vi.spyOn(process, "prependListener").mockImplementation(
    record as typeof process.prependListener,
  );

  vi.spyOn(process, "once").mockImplementation(record as typeof process.once);
  remove = vi
    .spyOn(process, "removeListener")
    .mockImplementation(() => process);

  vi.spyOn(process, "listeners").mockImplementation(((event: string) => [
    handlers.get(event),
    ...(listeners[event] ?? []),
  ]) as typeof process.listeners);

  vi.spyOn(process, "getBuiltinModule").mockReturnValue({ writeSync: vi.fn() });
}

// Longer than any simulated shutdown, so its exit runs while process.exit is still mocked.
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

describe("installLifecycle", () => {
  beforeEach(captureHandlers);

  describe("signal handler", () => {
    it("shuts down, re-raises, and exits 128 + n when the re-raise is ignored", async () => {
      const shutdown = sdk();
      const kill = vi.spyOn(process, "kill").mockReturnValue(true);
      const exit = vi
        .spyOn(process, "exit")
        .mockReturnValue(undefined as never);

      installLifecycle();
      handlers.get("SIGTERM")?.("SIGTERM");
      handlers.get("SIGTERM")?.("SIGTERM");
      await settle();

      expect(shutdown).toHaveBeenCalledOnce();
      expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM");
      expect(exit).toHaveBeenCalledWith(143);
    });

    it("exits at once on a repeated signal more than a second later", async () => {
      sdk(() => new Promise((resolve) => setTimeout(resolve, 5)));
      vi.spyOn(process, "kill").mockReturnValue(true);
      const exit = vi
        .spyOn(process, "exit")
        .mockReturnValue(undefined as never);
      const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
      installLifecycle();

      handlers.get("SIGINT")?.("SIGINT");
      now.mockReturnValue(10_500);
      handlers.get("SIGINT")?.("SIGINT");

      expect(exit).not.toHaveBeenCalled();
      now.mockReturnValue(11_500);
      handlers.get("SIGINT")?.("SIGINT");

      expect(exit).toHaveBeenCalledWith(130);
      await settle();
    });

    it("does not count signal-exit's listeners as the app's", async () => {
      const shutdown = sdk();
      const kill = vi.spyOn(process, "kill").mockReturnValue(true);

      vi.spyOn(process, "exit").mockReturnValue(undefined as never);
      const key = Symbol.for("signal-exit emitter");
      Object.defineProperty(globalThis, key, {
        value: { count: 1 },
        configurable: true,
      });

      try {
        listeners["SIGTERM"] = [() => undefined];
        installLifecycle();
        handlers.get("SIGTERM")?.("SIGTERM");
        await settle();

        expect(shutdown).toHaveBeenCalledOnce();
        expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM");
      } finally {
        Reflect.deleteProperty(globalThis, key);
      }
    });

    it("only flushes when the app also listens", async () => {
      const shutdown = sdk();
      const kill = vi.spyOn(process, "kill").mockReturnValue(true);

      listeners["SIGINT"] = [() => undefined];
      installLifecycle();
      handlers.get("SIGINT")?.("SIGINT");
      await settle();

      expect(remove).toHaveBeenCalledWith("SIGINT", handlers.get("SIGINT"));
      expect(shutdown).not.toHaveBeenCalled();
      expect(kill).not.toHaveBeenCalled();
    });
  });

  describe("crash handler", () => {
    it("writes the error, shuts down and exits 1, ignoring Node's domain listener", async () => {
      const shutdown = sdk();
      const exit = vi
        .spyOn(process, "exit")
        .mockReturnValue(undefined as never);
      listeners["uncaughtException"] = [
        Object.defineProperty(() => undefined, "name", {
          value: "domainUncaughtExceptionClear",
        }),
      ];

      installLifecycle();
      handlers.get("uncaughtException")?.(new Error("boom"));
      await settle();

      expect(shutdown).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledWith(1);
      expect(process.exitCode).toBe(1);

      process.exitCode = 0;
    });

    it("gives Sentry's tagged listener 2 s to send its event before exiting", async () => {
      vi.useFakeTimers();
      try {
        sdk();
        const exit = vi
          .spyOn(process, "exit")
          .mockReturnValue(undefined as never);
        listeners["uncaughtException"] = [
          Object.assign(() => undefined, { _errorHandler: true }),
        ];

        installLifecycle();
        handlers.get("uncaughtException")?.(new Error("boom"));
        await vi.advanceTimersByTimeAsync(1900);

        expect(exit).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(100);

        expect(exit).toHaveBeenCalledWith(1);
      } finally {
        vi.useRealTimers();
        process.exitCode = 0;
      }
    });

    it("prints only the first error while it shuts down", async () => {
      sdk(() => new Promise((resolve) => setTimeout(resolve, 5)));
      vi.spyOn(process, "exit").mockReturnValue(undefined as never);
      const writeSync = vi.fn();
      vi.spyOn(process, "getBuiltinModule").mockReturnValue({ writeSync });

      installLifecycle();

      handlers.get("uncaughtException")?.(new Error("first"));
      handlers.get("uncaughtException")?.(new Error("second"));
      await settle();

      expect(writeSync).toHaveBeenCalledOnce();

      process.exitCode = 0;
    });

    it("leaves the crash to an app listener", async () => {
      const shutdown = sdk();

      listeners["uncaughtException"] = [() => undefined];
      installLifecycle();
      handlers.get("uncaughtException")?.(new Error("boom"));
      await settle();

      expect(shutdown).not.toHaveBeenCalled();
    });
  });

  describe("beforeExit", () => {
    it("shuts down once the event loop empties, but not on AWS Lambda", async () => {
      const shutdown = sdk();

      installLifecycle();
      handlers.get("beforeExit")?.();
      await settle();

      expect(shutdown).toHaveBeenCalledOnce();

      handlers.clear();
      vi.stubEnv("AWS_LAMBDA_FUNCTION_NAME", "fn");
      installLifecycle();

      expect(handlers.has("beforeExit")).toBe(false);
    });

    it("exits, keeping process.exitCode, when the shutdown outlasts its bound", async () => {
      vi.useFakeTimers();
      try {
        sdk(() => new Promise(() => undefined));
        vi.spyOn(diag, "warn").mockImplementation(() => undefined);
        const exit = vi
          .spyOn(process, "exit")
          .mockReturnValue(undefined as never);

        installLifecycle();

        handlers.get("beforeExit")?.();
        await vi.advanceTimersByTimeAsync(5000);

        expect(exit).toHaveBeenCalledWith();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
