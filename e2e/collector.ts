import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { inject } from "vitest";

/** An attribute map decoded from OTLP/JSON. */
export type Attributes = Record<string, unknown>;

/** One exported span, log record or metric, with the resource it came from. */
export interface Item {
  readonly resource: Attributes;
  readonly scope: string;
  readonly name: string;
  /** OTLP span kind: 2 is server, 3 is client. */
  readonly kind?: number | undefined;
  readonly attributes: Attributes;
  readonly body?: unknown;
  readonly severityNumber?: number | undefined;
  readonly traceId?: string | undefined;
}

/** What the collector received from one service. */
export interface Telemetry {
  readonly spans: Item[];
  readonly logs: Item[];
  readonly metrics: Item[];
}

interface Kv {
  key: string;
  value: Record<string, unknown>;
}

type Scoped = { scope?: { name?: string } } & Record<
  string,
  Record<string, unknown>[]
>;
type Resourced = { resource?: { attributes?: Kv[] } } & Record<
  string,
  Scoped[]
>;

function value(v: Record<string, unknown> | undefined): unknown {
  if (v === undefined) return undefined;
  if ("arrayValue" in v) {
    const { values = [] } = v["arrayValue"] as {
      values?: Record<string, unknown>[];
    };

    return values.map(value);
  }

  const [first] = Object.values(v);

  // OTLP/JSON writes 64-bit integers as strings.
  return "intValue" in v ? Number(first) : first;
}

function attributes(list: Kv[] | undefined): Attributes {
  return Object.fromEntries(
    (list ?? []).map((kv) => [kv.key, value(kv.value)]),
  );
}

function collect(
  line: Record<string, Resourced[]>,
  outer: string,
  scoped: string,
  items: string,
) {
  const out: Item[] = [];
  for (const r of line[outer] ?? []) {
    const resource = attributes(r.resource?.attributes);
    for (const s of r[scoped] ?? []) {
      for (const i of s[items] ?? []) {
        out.push({
          resource,
          scope: s.scope?.name ?? "",
          name: typeof i["name"] === "string" ? i["name"] : "",
          kind: i["kind"] as number | undefined,
          attributes: attributes(i["attributes"] as Kv[] | undefined),
          body: value(i["body"] as Record<string, unknown> | undefined),
          severityNumber: i["severityNumber"] as number | undefined,
          traceId: i["traceId"] as string | undefined,
        });
      }
    }
  }

  return out;
}

/**
 * Returns a service name no other test uses, so each test reads only its own telemetry.
 *
 * @returns The service name.
 */
export function uniqueService(): string {
  return `e2e-${randomUUID().slice(0, 8)}`;
}

/**
 * Reads what the collector has written so far for one service.
 *
 * @param service - The `service.name` to keep.
 * @returns The service's spans, log records and metrics.
 */
export async function telemetry(service: string): Promise<Telemetry> {
  const file = join(inject("collectorOutput"), "telemetry.jsonl");
  const text = await readFile(file, "utf8").catch(() => "");
  // The collector may be writing the last line right now, so only complete lines are read.
  const lines = text
    .split("\n")
    .slice(0, -1)
    .map((l) => JSON.parse(l) as Record<string, Resourced[]>);
  const mine = (i: Item) => i.resource["service.name"] === service;

  return {
    spans: lines
      .flatMap((l) => collect(l, "resourceSpans", "scopeSpans", "spans"))
      .filter(mine),
    logs: lines
      .flatMap((l) => collect(l, "resourceLogs", "scopeLogs", "logRecords"))
      .filter(mine),
    metrics: lines
      .flatMap((l) => collect(l, "resourceMetrics", "scopeMetrics", "metrics"))
      .filter(mine),
  };
}

/**
 * Polls the collector output until a condition holds for one service.
 *
 * @param service - The `service.name` to read.
 * @param predicate - The condition.
 * @param timeoutMs - How long to wait.
 * @returns The telemetry that satisfied the condition.
 * @throws If the condition does not hold in time.
 */
export async function waitFor(
  service: string,
  predicate: (t: Telemetry) => boolean,
  timeoutMs = 15_000,
): Promise<Telemetry> {
  const end = Date.now() + timeoutMs;

  for (;;) {
    const t = await telemetry(service);
    if (predicate(t)) return t;

    if (Date.now() > end)
      throw new Error(`collector: condition not met for ${service}`);
    
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
