import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  telemetry,
  uniqueService,
  waitFor,
  type Telemetry,
} from "./collector.ts";
import { exportTo, NODE, run } from "./run.ts";

const REGISTER = "@clickhouse/clickstack-node/register";
const methods = (t: Telemetry) =>
  t.spans.map((s) => s.attributes["http.request.method"]);
// One server span, one client span and the console record.
const delivered = (t: Telemetry) =>
  t.spans.length >= 2 && t.logs.some((l) => l.body === "handled GET /hello");

describe("register entry", () => {
  it.each([
    ["app.cjs", "--import"],
    ["app.cjs", "--require"],
    ["app.mjs", "--import"],
    ["app.mjs", "--require"],
  ])(
    "%s with %s exports server and client spans and the console log",
    async (app, flag) => {
      const service = uniqueService();
      const result = await run(app, {
        nodeArgs: [flag, REGISTER],
        env: exportTo(service),
      });

      expect(result.code).toBe(0);
      expect(result.stderr).not.toMatch(/DEP0205|import-in-the-middle/);

      if (app === "app.mjs") expect(result.stdout).toMatch(/hook=(sync|async)/);

      // The client span of app.mjs comes from a named ESM import of node:http.
      expect(methods(await waitFor(service, delivered))).toEqual([
        "GET",
        "GET",
      ]);
    },
  );

  it("falls back to the asynchronous loader hook where require(esm) is disabled, as on Lambda", async () => {
    const service = uniqueService();
    const result = await run("app.mjs", {
      nodeArgs: ["--no-experimental-require-module", "--import", REGISTER],
      env: exportTo(service),
    });

    expect(result.stdout).toContain("hook=async");

    await waitFor(service, delivered);
  });

  it("works from NODE_OPTIONS and from in-code init", async () => {
    const preload = uniqueService();
    const env = { ...exportTo(preload), NODE_OPTIONS: `--import ${REGISTER}` };

    expect((await run("app.mjs", { env })).code).toBe(0);

    await waitFor(preload, delivered);

    const inCode = uniqueService();

    expect(
      (await run("app.cjs", { args: ["--init"], env: exportTo(inCode) })).code,
    ).toBe(0);

    await waitFor(inCode, delivered);
  });

  it("keeps node -p working with the preload in NODE_OPTIONS", () => {
    for (const flag of ["--import", "--require"]) {
      const result = spawnSync(NODE, ["-p", 'require("node:os").EOL.length'], {
        env: {
          ...process.env,
          NODE_OPTIONS: `${flag} ${REGISTER}`,
          OTEL_TRACES_EXPORTER: "none",
          OTEL_METRICS_EXPORTER: "none",
          OTEL_LOGS_EXPORTER: "none",
        },
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("1");
    }
  });

  it("prints unknown names in the env lists, but not console", async () => {
    const service = uniqueService();
    const result = await run("app.cjs", {
      nodeArgs: ["--import", REGISTER],
      env: {
        ...exportTo(service),
        OTEL_NODE_ENABLED_INSTRUMENTATIONS: "http,console,nonexistent",
        OTEL_NODE_RESOURCE_DETECTORS: "env, host",
      },
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain(
      'Provided instrumentation name "@opentelemetry/instrumentation-nonexistent" not found',
    );
    expect(result.stderr).toContain('Invalid resource detector " host"');
    expect(result.stderr).not.toContain("instrumentation-console");

    await waitFor(service, delivered);
  });

  it("does nothing with OTEL_SDK_DISABLED=true", async () => {
    const service = uniqueService();
    const result = await run("app.cjs", {
      nodeArgs: ["--import", REGISTER],
      env: { ...exportTo(service), OTEL_SDK_DISABLED: "true" },
    });

    expect(result.code).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(await telemetry(service)).toEqual({
      spans: [],
      logs: [],
      metrics: [],
    });
  });

  it("warns and leaves the SDK alone when init() runs a second time", async () => {
    const service = uniqueService();
    const result = await run("app.cjs", {
      nodeArgs: ["--import", REGISTER],
      args: ["--init"],
      env: exportTo(service),
    });
    
    expect(result.stderr).toContain("an OpenTelemetry SDK is already started");
    expect(methods(await waitFor(service, delivered))).toEqual(["GET", "GET"]);
  });
});
