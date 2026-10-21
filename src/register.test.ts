import { expect, it, vi } from "vitest";

const init = vi.hoisted(() => vi.fn());
vi.mock("./init.ts", () => ({ init }));

it("starts the SDK with no options on the main thread", async () => {
  await import("./register.ts");
  expect(init).toHaveBeenCalledExactlyOnceWith();
});
