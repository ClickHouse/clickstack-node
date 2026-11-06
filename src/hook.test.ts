import type { ResolveHookSync } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mod = vi.hoisted(() => ({
  syncHooks: undefined as
    { supportsSyncHooks: () => boolean; register: () => void } | undefined,
  registered: [] as unknown[],
  resolveHook: undefined as ResolveHookSync | undefined,
}));

vi.mock("node:module", () => ({
  createRequire: () => () => {
    if (mod.syncHooks === undefined)
      throw new Error("require(esm) is disabled");
    return mod.syncHooks;
  },
  register: (url: unknown) => mod.registered.push(url),
  registerHooks: (hooks: { resolve: ResolveHookSync }) => {
    mod.resolveHook = hooks.resolve;
  },
}));

const { installEsmHook } = await import("./hook.ts");

beforeEach(() => {
  mod.syncHooks = undefined;
  mod.registered = [];
  mod.resolveHook = undefined;
});

describe("installEsmHook", () => {
  it("uses import-in-the-middle's sync hooks where they are supported", () => {
    const register = vi.fn();
    mod.syncHooks = { supportsSyncHooks: () => true, register };

    expect(installEsmHook()).toBe("sync");
    expect(register).toHaveBeenCalledOnce();
    expect(mod.registered).toEqual([]);
  });

  it.each([
    ["unsupported", { supportsSyncHooks: () => false, register: vi.fn() }],
    ["not loadable", undefined],
  ])(
    "falls back to module.register when sync hooks are %s",
    (_name, syncHooks) => {
      mod.syncHooks = syncHooks;

      expect(installEsmHook()).toBe("async");
      expect(String(mod.registered[0])).toMatch(
        /^file:\/\/.*\/node_modules\/@opentelemetry\/instrumentation\/hook\.mjs$/,
      );
    },
  );
});

describe("the resolve repair", () => {
  const resolve = (url: string, format: string, parentURL?: string) => {
    mod.syncHooks = { supportsSyncHooks: () => true, register: vi.fn() };
    installEsmHook();

    const next = () => ({ url, format, shortCircuit: true });

    return mod.resolveHook?.(
      "x",
      { conditions: [], importAttributes: {}, parentURL },
      next,
    );
  };

  it("restores builtins that import-in-the-middle marks as CommonJS", () => {
    expect(resolve("node:os", "commonjs")?.format).toBe("builtin");
  });

  it("lets Node pick the format of an entry file without an extension", () => {
    expect(resolve("file:///app/bin/cli", "commonjs")?.format).toBeUndefined();
    expect(
      resolve("file:///app/bin/cli", "commonjs", "file:///app/x.js")?.format,
    ).toBe("commonjs");
    expect(resolve("file:///app/index.cjs", "commonjs")?.format).toBe(
      "commonjs",
    );
    expect(resolve("file:///app/index.mjs", "module")?.format).toBe("module");
  });
});
