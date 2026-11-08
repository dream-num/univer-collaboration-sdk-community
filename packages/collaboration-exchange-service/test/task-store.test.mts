import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExchangeTaskStore, TERMINAL_TASK_RETENTION_MS } from "../src/task-store.js";

describe("ExchangeTaskStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps pending tasks indefinitely and terminal tasks for one hour", () => {
    const store = new ExchangeTaskStore();
    const pending = store.create("import", "alice");
    const done = store.create("export", "alice");
    const failed = store.create("export", "alice");
    store.completeExport(done, { fileID: "f" });
    store.fail(failed, new Error("broken"));

    vi.advanceTimersByTime(TERMINAL_TASK_RETENTION_MS - 1);
    expect(store.get(done, "alice")).toMatchObject({ status: "done", result: { fileID: "f" } });
    expect(store.get(failed, "alice")).toMatchObject({ status: "failed", kind: "export" });

    vi.advanceTimersByTime(1);
    expect(store.get(done, "alice")).toBeUndefined();
    expect(store.get(failed, "alice")).toBeUndefined();
    expect(store.get(pending, "alice")).toMatchObject({ status: "pending" });
  });

  it("returns a task only to its creator", () => {
    const store = new ExchangeTaskStore();
    const taskID = store.create("import", "alice");
    expect(store.get(taskID, "bob")).toBeUndefined();
  });

  it("settles a task once", () => {
    const store = new ExchangeTaskStore();
    const taskID = store.create("import", "alice");
    store.completeImport(taskID, { outputType: 1, unitID: "u" });
    store.fail(taskID, new Error("late"));
    expect(store.get(taskID, "alice")).toMatchObject({ status: "done" });
  });

  it("ignores results for tasks dropped by clear", () => {
    const store = new ExchangeTaskStore();
    const taskID = store.create("import", "alice");
    store.clear();
    store.completeImport(taskID, { outputType: 1, unitID: "u" });
    expect(store.get(taskID, "alice")).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
