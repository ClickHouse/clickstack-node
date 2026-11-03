import { describe, expect, it } from "vitest";
import { exceptionAttributes } from "./exception.ts";

const STACK = "exception.stacktrace";
const MESSAGE = "exception.message";

describe("exceptionAttributes", () => {
  it("adds nothing for an error without a cause or a thrown string", () => {
    expect(exceptionAttributes(new Error("plain"))).toEqual({});
    expect(exceptionAttributes("text")).toEqual({});
  });

  it("appends the cause chain to the raw stack, Java style", () => {
    const root = new TypeError("root cause");
    const error = new Error("outer", { cause: root });
    const stack = exceptionAttributes(error)[STACK] as string;

    expect(stack.startsWith(error.stack ?? "")).toBe(true);
    expect(stack).toContain(`\nCaused by: ${root.stack ?? ""}`);
  });

  it("stops after five causes and on a loop", () => {
    let error = new Error("cause 7");
    for (let i = 6; i >= 1; i--)
      error = new Error(`cause ${String(i)}`, { cause: error });
    const deep = exceptionAttributes(error)[STACK] as string;

    expect(deep.match(/\nCaused by: /g)).toHaveLength(5);

    const a = new Error("a");
    const b = new Error("b", { cause: a });
    a.cause = b;
    const looped = exceptionAttributes(a)[STACK] as string;

    expect(looped.match(/\nCaused by: /g)).toHaveLength(1);
  });

  it("writes a cause that is not an error as JSON text", () => {
    const stack = exceptionAttributes(
      new Error("outer", { cause: { code: 1 } }),
    )[STACK];

    expect(stack).toContain('\nCaused by: {"code":1}');
  });

  it("records thrown values that are not errors as JSON text", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;

    expect(exceptionAttributes(42)).toEqual({ [MESSAGE]: "42" });
    expect(exceptionAttributes({ code: 1 })).toEqual({
      [MESSAGE]: '{"code":1}',
    });
    expect(exceptionAttributes(null)).toEqual({ [MESSAGE]: "null" });
    expect(exceptionAttributes(undefined)).toEqual({ [MESSAGE]: "undefined" });
    expect(exceptionAttributes(10n)).toEqual({ [MESSAGE]: "10" });
    expect(exceptionAttributes(circular)).toEqual({
      [MESSAGE]: "[object Object]",
    });
  });

  it("never throws, and leaves the SDK's attributes for errors it cannot read", () => {
    const hostile = new Proxy(new Error("x", { cause: 1 }), {
      get() {
        throw new Error("no access");
      },
    });

    expect(exceptionAttributes(hostile)).toEqual({});
  });
});
