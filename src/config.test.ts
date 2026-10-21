import { diag } from "@opentelemetry/api";
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { applyOptions } from "./config.ts";
import { getState } from "./state.ts";

let warn: MockInstance<typeof diag.warn>;
const warnings = (): unknown[] => warn.mock.calls.map(([m]) => m);

beforeEach(() => {
  for (const name of [
    "OTEL_SERVICE_NAME",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_HEADERS",
    "CLICKSTACK_CAPTURE_HTTP_BODY",
    "OTEL_RESOURCE_ATTRIBUTES",
  ]) {
    vi.stubEnv(name, undefined);
  }

  getState().warned?.clear();
  warn = vi.spyOn(diag, "warn").mockImplementation(() => undefined);
});

describe("applyOptions", () => {
  it("writes options to their env vars when unset", () => {
    applyOptions({
      serviceName: "svc",
      endpoint: "http://c:4318",
      httpBodyCapture: true,
    });
    expect(process.env["OTEL_SERVICE_NAME"]).toBe("svc");
    expect(process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]).toBe("http://c:4318");
    expect(process.env["CLICKSTACK_CAPTURE_HTTP_BODY"]).toBe("true");
  });

  it.each([
    ["OTEL_SERVICE_NAME", { serviceName: "code" }],
    ["OTEL_EXPORTER_OTLP_ENDPOINT", { endpoint: "code" }],
    ["CLICKSTACK_CAPTURE_HTTP_BODY", { httpBodyCapture: true }],
  ])("leaves an operator-set %s alone", (name, options) => {
    vi.stubEnv(name, "env");
    applyOptions(options);

    expect(process.env[name]).toBe("env");
  });

  it("leaves service.name to OTEL_RESOURCE_ATTRIBUTES when it sets one", () => {
    vi.stubEnv(
      "OTEL_RESOURCE_ATTRIBUTES",
      "deployment.environment.name=prod, service.name = operator",
    );
    applyOptions({ serviceName: "code" });

    expect(process.env["OTEL_SERVICE_NAME"]).toBeUndefined();
  });

  it("trims and percent-encodes the apiKey into the authorization header", () => {
    applyOptions({ apiKey: " a,b;c\n", endpoint: "http://c:4318" });

    expect(process.env["OTEL_EXPORTER_OTLP_HEADERS"]).toBe(
      "authorization=a%2Cb%3Bc",
    );
    expect(warnings()).toEqual([]);
  });

  it("warns once when OTEL_EXPORTER_OTLP_HEADERS already holds something else", () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_HEADERS", "x=y");
    applyOptions({ apiKey: "k", endpoint: "e" });
    applyOptions({ apiKey: "k", endpoint: "e" });

    expect(process.env["OTEL_EXPORTER_OTLP_HEADERS"]).toBe("x=y");
    expect(warnings()).toEqual([
      "clickstack-node: OTEL_EXPORTER_OTLP_HEADERS is set, so the apiKey option is ignored",
    ]);
  });

  it("accepts the header a parent process wrote for the same key, and warns about a missing endpoint", () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_HEADERS", "authorization=k");
    applyOptions({ apiKey: "k" });
    
    expect(warnings()).toEqual([
      "clickstack-node: apiKey is set but OTEL_EXPORTER_OTLP_ENDPOINT is not",
    ]);
  });
});
