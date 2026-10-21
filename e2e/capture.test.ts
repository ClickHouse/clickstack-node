import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  uniqueService,
  waitFor,
  type Item,
  type Telemetry,
} from "./collector.ts";
import { exportTo, NODE, run, type Result } from "./run.ts";

interface Run {
  readonly result: Result;
  readonly app: unknown;
  readonly telemetry: Telemetry;
}

// bodies.cjs makes four requests to itself: /json, /fetch, /upload and /sse, each with a server
// span, plus their client spans.
async function bodies(env: Record<string, string>): Promise<Run> {
  const service = uniqueService();
  const result = await run("bodies.cjs", {
    nodeArgs: ["--import", "@clickhouse/clickstack-node/register"],
    env: { ...exportTo(service), ...env },
  });
  const line = /RESULT (.*)/.exec(result.stdout)?.[1] ?? "null";
  const telemetry = await waitFor(
    service,
    (t) => t.spans.filter((s) => s.kind === 2).length >= 4,
  );

  return { result, app: JSON.parse(line) as unknown, telemetry };
}

const server = (t: Telemetry, path: string): Item | undefined =>
  t.spans.find((s) => s.attributes["url.path"] === path && s.kind === 2);

// The fixture's Node, which may differ from the one running Vitest.
const undiciChannels = (): boolean => {
  const version = execFileSync(NODE, ["-p", "process.versions.undici"], {
    encoding: "utf8",
  });
  const [major = 0, minor = 0] = version.trim().split(".").map(Number);

  return major > 7 || (major === 7 && minor >= 11);
};

describe("body capture", () => {
  it("leaves the bytes the app sees unchanged, with capture on or off", async () => {
    const off = await bodies({});
    const on = await bodies({ CLICKSTACK_CAPTURE_HTTP_BODY: "true" });

    expect(off.result.code).toBe(0);
    expect(on.result.code).toBe(0);
    expect(on.app).toEqual(off.app);
    expect(on.app).toMatchObject({ uploadOk: true });
    expect(
      off.telemetry.spans.some(
        (s) => "http.request.body.content" in s.attributes,
      ),
    ).toBe(false);
  });

  it("records capped, redacted bodies when enabled", async () => {
    const { telemetry } = await bodies({
      CLICKSTACK_CAPTURE_HTTP_BODY: "true",
    });
    const json = server(telemetry, "/json")?.attributes;

    expect(json?.["http.request.body.content"]).toBe(
      '{"user":"ada","password":"[REDACTED]"}',
    );
    expect(json?.["http.response.body.content"]).toBe(
      '{"echoed":35,"token":"[REDACTED]"}',
    );

    const upload = server(telemetry, "/upload")?.attributes;

    expect(upload?.["http.request.body.size"]).toBe(10 * 1024 * 1024);
    // No content type, so only the size.
    expect(upload?.["http.request.body.content"]).toBeUndefined();

    const sse = server(telemetry, "/sse")?.attributes;

    expect(
      String(sse?.["http.response.body.content"]).length,
    ).toBeLessThanOrEqual(8192);
  });

  it("records fetch bodies where Node bundles the undici body channels", async () => {
    const { result, telemetry } = await bodies({
      CLICKSTACK_CAPTURE_HTTP_BODY: "true",
    });
    const fetchSpan = telemetry.spans.find((s) => s.scope.includes("undici"));

    if (undiciChannels()) {
      // JSON labeled text/plain is redacted too.
      expect(fetchSpan?.attributes["http.request.body.content"]).toBe(
        '{"token":"[REDACTED]"}',
      );
    } else {
      expect(result.stderr).toContain(
        "fetch bodies are captured from Node.js 24.4",
      );
    }
  });
});

describe("header capture", () => {
  it("records the listed headers and leaves sanitized ones out", async () => {
    const { result, telemetry } = await bodies({
      OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_SERVER_REQUEST:
        "Content-Type, Authorization",
      OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_SERVER_RESPONSE: "x-request-id",
    });
    const json = server(telemetry, "/json")?.attributes;

    expect(json?.["http.request.header.content-type"]).toEqual([
      "application/json",
    ]);
    expect(json?.["http.response.header.x-request-id"]).toEqual(["r-1"]);
    expect(json).not.toHaveProperty("http.request.header.authorization");
    expect(result.stderr).toContain(
      'header "authorization" is on the sanitize list',
    );
  });
});
