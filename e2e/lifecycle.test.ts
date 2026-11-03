import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { uniqueService, waitFor } from "./collector.ts";
import { exportTo, run } from "./run.ts";

const REGISTER = ["--import", "@clickhouse/clickstack-node/register"];
// Long batch delays prove the export comes from the shutdown, not from a timer.
const BUFFERED = {
  OTEL_BSP_SCHEDULE_DELAY: "600000",
  OTEL_BLRP_SCHEDULE_DELAY: "600000",
};
const env = (service: string) => ({ ...exportTo(service), ...BUFFERED });

describe("lifecycle", () => {
  it.each([
    ["SIGTERM", 143],
    ["SIGINT", 130],
  ] as const)(
    "%s without an app handler flushes, then dies by the signal",
    async (signal, code) => {
      const service = uniqueService();
      const result = await run("app.cjs", {
        nodeArgs: REGISTER,
        args: ["--serve"],
        env: env(service),
        signal,
      });

      expect(result.signal === signal || result.code === code).toBe(true);

      await waitFor(service, (t) => t.spans.length > 0 && t.logs.length > 0);
    },
  );

  it("exits 128 + n when the re-raised signal is ignored, as for PID 1 in a container", async () => {
    const service = uniqueService();
    const stub = fileURLToPath(
      new URL("fixtures/stub-kill.cjs", import.meta.url),
    );

    const result = await run("app.cjs", {
      nodeArgs: ["--require", stub, ...REGISTER],
      args: ["--serve"],
      env: env(service),
      signal: "SIGTERM",
    });

    expect(result.code).toBe(143);

    await waitFor(service, (t) => t.spans.length > 0);
  });

  it("only flushes when the app handles the signal, and leaves the exit to the app", async () => {
    const service = uniqueService();
    const result = await run("app.cjs", {
      nodeArgs: REGISTER,
      args: ["--own-signal"],
      env: env(service),
      signal: "SIGTERM",
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("app got SIGTERM");

    await waitFor(service, (t) => t.spans.length > 0);
  });

  it.each(["--crash", "--reject"])(
    "%s writes the error, exports the FATAL record and exits 1",
    async (arg) => {
      const service = uniqueService();
      const result = await run("app.cjs", {
        nodeArgs: REGISTER,
        args: [arg],
        env: env(service),
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(
        /fixture (crash|rejection)[\s\S]*Node\.js v/,
      );

      const { logs } = await waitFor(service, (t) =>
        t.logs.some((l) => l.severityNumber === 21),
      );
      const fatal = logs.find((l) => l.severityNumber === 21);

      expect(fatal?.body).toBe("exception");
      expect(fatal?.attributes["exception.message"]).toMatch(
        /fixture (crash|rejection)/,
      );
      if (arg === "--crash") {
        expect(fatal?.attributes["exception.stacktrace"]).toMatch(
          /^Error: fixture crash\n[\s\S]*\nCaused by: TypeError: fixture cause\n {4}at /,
        );
      }
    },
  );

  it("records a thrown value that is not an error as JSON text", async () => {
    const service = uniqueService();
    const result = await run("app.cjs", {
      nodeArgs: REGISTER,
      args: ["--throw-value"],
      env: env(service),
    });

    expect(result.code).toBe(1);

    const { logs } = await waitFor(service, (t) =>
      t.logs.some((l) => l.severityNumber === 21),
    );
    const fatal = logs.find((l) => l.severityNumber === 21);

    expect(fatal?.attributes["exception.message"]).toBe('{"code":1}');
  });

  it("flushes on a natural exit through beforeExit", async () => {
    const service = uniqueService();

    expect(
      (await run("app.cjs", { nodeArgs: REGISTER, env: env(service) })).code,
    ).toBe(0);

    await waitFor(service, (t) => t.spans.length === 2);
  });
});
