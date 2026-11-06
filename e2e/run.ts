import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inject } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The Node binary that runs fixtures: `CLICKSTACK_TEST_NODE`, or the one running Vitest. */
export const NODE: string =
  process.env["CLICKSTACK_TEST_NODE"] ?? process.execPath;

/** Exit status and output of a child process. */
export interface Result {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Options for {@link run}. */
export interface RunOptions {
  /** Flags placed before the script, such as `--import`. */
  readonly nodeArgs?: readonly string[];
  /** Arguments after the script. */
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /** Sent to the child once it prints a line starting with `READY`. */
  readonly signal?: NodeJS.Signals;
}

/**
 * The environment of this process without inherited `OTEL_*`, `CLICKSTACK_*`, `NODE_OPTIONS` and
 * `AWS_LAMBDA_*`, for child processes.
 *
 * @returns The environment.
 */
export function childEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(OTEL_|CLICKSTACK_|NODE_OPTIONS$|AWS_LAMBDA_)/.test(key))
      Reflect.deleteProperty(env, key);
  }

  return env;
}

/**
 * Runs a fixture from `e2e/fixtures` with the repo root as working directory, so
 * `@clickhouse/clickstack-node` resolves to the built `dist` through the package self-reference.
 * The child gets {@link childEnv} and runs on {@link NODE}.
 *
 * @param fixture - File name under `e2e/fixtures`.
 * @param options - Flags, arguments, environment and an optional signal.
 * @returns The exit status and output; the child is killed after 30 s.
 */
export function run(
  fixture: string,
  options: RunOptions = {},
): Promise<Result> {
  const env = childEnv();
  const script = fileURLToPath(new URL(`fixtures/${fixture}`, import.meta.url));
  const child = spawn(
    NODE,
    [...(options.nodeArgs ?? []), script, ...(options.args ?? [])],
    {
      cwd: ROOT,
      env: { ...env, ...options.env },
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    const before = stdout;
    stdout += chunk.toString();

    if (
      options.signal !== undefined &&
      !before.includes("READY") &&
      stdout.includes("READY")
    ) {
      child.kill(options.signal);
    }
  });

  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);

  return new Promise((resolve) => {
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/**
 * The environment that sends a child's telemetry to the test collector, with the ingestion key, in
 * OpenTelemetry's default protocol (OTLP over HTTP with protobuf).
 *
 * @param service - The `service.name` the test reads back.
 * @returns Environment variables for {@link run}.
 */
export function exportTo(service: string): Record<string, string> {
  return {
    OTEL_EXPORTER_OTLP_ENDPOINT: inject("collectorEndpoint"),
    OTEL_EXPORTER_OTLP_HEADERS: `authorization=${inject("apiKey")}`,
    OTEL_SERVICE_NAME: service,
  };
}
