import { describe, expect, inject, it } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { telemetry, uniqueService, waitFor } from "./collector.ts";
import { exportTo, run } from "./run.ts";

describe("export to a collector", () => {
  it("sends the expected keys with the ingestion key, over OpenTelemetry's default protocol", async () => {
    const service = uniqueService();
    const result = await run("app.cjs", {
      nodeArgs: ["--import", "@clickhouse/clickstack-node/register"],
      env: {
        ...exportTo(service),
        CLICKSTACK_CAPTURE_HTTP_BODY: "true",
        OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_SERVER_RESPONSE:
          "content-type",
      },
    });

    expect(result.code).toBe(0);

    const t = await waitFor(
      service,
      (x) => x.spans.length >= 2 && x.metrics.length > 0,
    );

    const span = t.spans.find((s) => s.kind === 2);

    expect(span?.resource).toMatchObject({
      "service.name": service,
      "telemetry.distro.name": "clickstack-node",
      "telemetry.distro.version": pkg.version,
      "telemetry.sdk.language": "nodejs",
    });
    expect(Object.keys(span?.attributes ?? {})).toEqual(
      expect.arrayContaining([
        "http.request.method",
        "http.response.status_code",
        "url.path",
        "http.response.header.content-type",
        "http.response.body.size",
        "http.response.body.content",
      ]),
    );

    const log = t.logs.find((l) => l.body === "handled GET /hello");

    expect(log?.severityNumber).toBe(9);
    expect(log?.traceId).toBe(span?.traceId);
    expect(t.metrics.map((m) => m.name)).toContain(
      "http.server.request.duration",
    );

    const keys = [...t.spans, ...t.logs, ...t.metrics].flatMap((i) => [
      ...Object.keys(i.attributes),
      ...Object.keys(i.resource),
    ]);

    expect(keys.filter((k) => k.startsWith("clickstack."))).toEqual([]);
  });

  it("sends with the init() options, and an operator's variables win over them", async () => {
    const start = (service: string, env: Record<string, string>) =>
      run("app.cjs", {
        args: ["--init"],
        env: {
          ...env,
          FIXTURE_OPTIONS: JSON.stringify({
            serviceName: service,
            endpoint: inject("collectorEndpoint"),
            apiKey: inject("apiKey"),
            environment: "staging",
          }),
        },
      });

    const resource = async (service: string) =>
      (await waitFor(service, (x) => x.spans.length > 0)).spans[0]?.resource;

    const fromCode = uniqueService();

    expect((await start(fromCode, {})).code).toBe(0);
    expect(await resource(fromCode)).toMatchObject({
      "service.name": fromCode,
      "deployment.environment.name": "staging",
    });

    const fromEnv = uniqueService();
    const overridden = await start(uniqueService(), {
      OTEL_SERVICE_NAME: fromEnv,
      OTEL_RESOURCE_ATTRIBUTES: "deployment.environment.name=production",
    });

    expect(overridden.code).toBe(0);
    expect(await resource(fromEnv)).toMatchObject({
      "service.name": fromEnv,
      "deployment.environment.name": "production",
    });
  });

  it("reports a rejected ingestion key on stderr, and nothing reaches the collector", async () => {
    const service = uniqueService();
    const result = await run("app.cjs", {
      nodeArgs: ["--import", "@clickhouse/clickstack-node/register"],
      env: {
        ...exportTo(service),
        OTEL_EXPORTER_OTLP_HEADERS: "authorization=wrong-key",
      },
    });

    expect(result.stderr).toMatch(/Unauthorized|401/);
    expect(await telemetry(service)).toEqual({
      spans: [],
      logs: [],
      metrics: [],
    });
  });
});
