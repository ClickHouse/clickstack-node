import { execFile, spawn } from "node:child_process";
import { access, cp, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uniqueService, waitFor } from "./collector.ts";
import { childEnv, exportTo, NODE } from "./run.ts";

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = fileURLToPath(new URL("fixtures/nextjs", import.meta.url));

const temps: string[] = [];

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "clickstack-node-nextjs-"));
  temps.push(dir);

  return dir;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));

  return port;
}

async function npm(cwd: string, ...args: string[]): Promise<void> {
  await exec(
    "npm",
    [...args, "--ignore-scripts", "--no-audit", "--no-fund", "--silent"],
    { cwd },
  );
}

// Standalone output copies only the files that Next.js's tracer finds, and running it from a
// directory with no node_modules above it, as in a slim image, shows what the tracer missed.
describe("Next.js standalone output", () => {
  let app: string;

  beforeAll(async () => {
    app = await temp();
    await cp(FIXTURE, app, { recursive: true });

    const { stdout } = await exec(
      "npm",
      ["pack", "--pack-destination", app, "--silent"],
      { cwd: ROOT },
    );

    await npm(app, "ci");
    await npm(app, "install", "--no-save", join(app, stdout.trim()));
  }, 300_000);

  afterAll(async () => {
    await Promise.all(
      temps.map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it.each([
    ["webpack", ["--webpack"]],
    ["Turbopack", []],
  ])(
    "built with %s, keeps the loader hook and instruments node:http",
    async (_bundler, flags) => {
      await rm(join(app, ".next"), { recursive: true, force: true });
      await exec(
        process.execPath,
        [
          join(app, "node_modules", "next", "dist", "bin", "next"),
          "build",
        ].concat(flags),
        { cwd: app, env: { ...childEnv(), NEXT_TELEMETRY_DISABLED: "1" } },
      );

      const server = await temp();
      await cp(join(app, ".next", "standalone"), server, { recursive: true });

      for (const file of [
        "@opentelemetry/instrumentation/hook.mjs",
        "import-in-the-middle/register-hooks.mjs",
      ]) {
        await expect(
          access(join(server, "node_modules", file)),
        ).resolves.toBeUndefined();
      }

      const service = uniqueService();
      const port = String(await freePort());
      const child = spawn(NODE, ["server.js"], {
        cwd: server,
        env: {
          ...childEnv(),
          ...exportTo(service),
          PORT: port,
          HOSTNAME: "127.0.0.1",
          // Next.js loads node:http before register(), and the first export loads it again (the
          // OTLP exporter imports it), which patches it. With only traces, at the default batch
          // delay, the request comes first, as it always does with an https endpoint.
          OTEL_METRICS_EXPORTER: "none",
          OTEL_LOGS_EXPORTER: "none",
        },
      });

      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

      try {
        const deadline = Date.now() + 30_000;
        for (;;) {
          const response = await fetch(`http://127.0.0.1:${port}/`).catch(
            () => undefined,
          );
          if (response?.ok === true) break;
          if (Date.now() > deadline) throw new Error(stderr);

          await new Promise((resolve) => setTimeout(resolve, 250));
        }

        await waitFor(service, (t) =>
          t.spans.some(
            (s) =>
              s.scope === "@opentelemetry/instrumentation-http" && s.kind === 2,
          ),
        );

        expect(stderr).not.toContain("ESM loader hook not installed");
      } finally {
        child.kill("SIGKILL");
      }
    },
    300_000,
  );
});
