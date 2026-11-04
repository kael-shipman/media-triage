import { expect, test } from "bun:test";
import { Scheduler } from "./scheduler.ts";

test("runs jobs one at a time, in order of when they're due, until stopped", async () => {
  const scheduler = new Scheduler();
  const order: string[] = [];
  let running = 0;
  const job = (name: string) => async () => {
    running++;
    expect(running).toBe(1);
    order.push(name);
    await Bun.sleep(5);
    running--;
    if (order.length === 4) scheduler.stop();
  };
  scheduler.add("b", { intervalMs: 1_000, firstInMs: 10 }, job("b"));
  scheduler.add("a", { intervalMs: 15, firstInMs: 0 }, job("a"));
  await scheduler.loop();
  expect(order[0]).toBe("a");
  expect(order).toContain("b");
  expect(order).toHaveLength(4);
});

test("trigger makes a job due now, even one that's running", async () => {
  const scheduler = new Scheduler();
  let runs = 0;
  scheduler.add("job", { intervalMs: 60_000 }, async () => {
    runs++;
    if (runs === 1) scheduler.trigger("job");
    if (runs === 2) scheduler.stop();
  });
  const started = Date.now();
  await scheduler.loop();
  expect(runs).toBe(2);
  expect(Date.now() - started).toBeLessThan(1_000);
});

test("a job that throws runs again later", async () => {
  const scheduler = new Scheduler();
  let runs = 0;
  scheduler.add("flaky", { intervalMs: 1 }, async () => {
    runs++;
    if (runs === 3) scheduler.stop();
    throw new Error("boom");
  });
  await scheduler.loop();
  expect(runs).toBe(3);
});
