import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { TestProject } from "vitest/node";

const run = promisify(execFile);
const repo = fileURLToPath(new URL("..", import.meta.url));

const COLLECTOR_IMAGE =
  "otel/opentelemetry-collector-contrib:0.163.2@sha256:7f22d2a6748110ffb6a59bc0df448bccbf501cdb667d610ede4c61d3863d5849";
const API_KEY = "e2e-ingestion-key";

declare module "vitest" {
  export interface ProvidedContext {
    collectorEndpoint: string;
    collectorOutput: string;
    apiKey: string;
  }
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/**
 * Starts the collector in Docker and gives the tests its endpoint, its output directory and the
 * ingestion key it accepts.
 *
 * @param project - The Vitest project that runs the end-to-end tests.
 * @returns A function that stops the collector.
 */
export default async function globalSetup(
  project: TestProject,
): Promise<() => Promise<void>> {
  const endpoint = `http://127.0.0.1:${String(await freePort())}`;
  const output = await mkdtemp(join(tmpdir(), "clickstack-node-e2e-"));
  // The collector image runs as a non-root user, so it writes the output as the host user.
  const user = process.getuid ? ["--user", String(process.getuid())] : [];
  const { stdout } = await run("docker", [
    "run",
    "--detach",
    "--rm",
    ...user,
    "--publish",
    `127.0.0.1:${new URL(endpoint).port}:4318`,
    "--volume",
    `${join(repo, "e2e", "collector", "config.yaml")}:/etc/collector.yaml:ro`,
    "--volume",
    `${output}:/output`,
    "--env",
    `E2E_API_KEY=${API_KEY}`,
    COLLECTOR_IMAGE,
    "--config",
    "/etc/collector.yaml",
  ]);
  const container = stdout.trim();

  const stop = async (): Promise<void> => {
    await run("docker", ["stop", container]).catch(() => undefined);
  };

  try {
    const deadline = Date.now() + 60_000;

    for (;;) {
      try {
        await fetch(`${endpoint}/v1/logs`, {
          signal: AbortSignal.timeout(2000),
        });

        break;
      } catch (error) {
        if (Date.now() > deadline) throw error;

        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  } catch (error) {
    await stop();

    throw new Error(`the collector did not start on ${endpoint}`, {
      cause: error,
    });
  }

  project.provide("collectorEndpoint", endpoint);
  project.provide("collectorOutput", output);
  project.provide("apiKey", API_KEY);

  return stop;
}
