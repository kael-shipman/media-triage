import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USERS, api, configFor, describeImmich, indexedLibrary, login, newUser } from "../../test/immich/harness.ts";
import { PathMap } from "../core/path-map.ts";
import { loginAccount } from "../immich/login.ts";
import { State } from "../state.ts";
import { type OpenAccount, openAccounts } from "../upkeep/accounts.ts";
import { consumeStream } from "./stream.ts";
import { SyncStore } from "./store.ts";

let dir: string;
let state: State;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "media-triage-"));
  state = State.open(join(dir, "state"));
});
afterEach(() => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

describeImmich("the sync stream, consumed", () => {
  async function setUp(names: string[]) {
    const alex = await login(USERS.alex);
    const user = await newUser(alex.accessToken, "Streamer");
    const config = configFor(join(dir, "state"), [{ name: "streamer", user }]);
    await loginAccount(config, "streamer", user.password);
    const account = (await openAccounts(config)).open[0] as OpenAccount;
    const session = await login(user);
    const library = await indexedLibrary("stream", { token: alex.accessToken }, { token: session.accessToken, userId: session.userId }, names);
    return { config, account, library, token: session.accessToken, store: new SyncStore(state.db), map: new PathMap(config.immich.pathMap) };
  }

  /** Reads the stream to its end, collecting the units each batch hands on. */
  async function consume(context: Awaited<ReturnType<typeof setUp>>, bulkLookup?: number) {
    const units: string[] = [];
    const outcome = await consumeStream(context.account, context.store, context.map, { act: async (batch) => void units.push(...batch), bulkLookup });
    return { outcome, units: [...new Set(units)].sort() };
  }

  test.each([1, 50])("a first read learns every asset with its path (bulk past %p), and a second finds nothing new", async (bulkLookup) => {
    const context = await setUp(["a.jpg", "b.jpg"]);
    const local = (name: string) => join(context.library.folder.local, name);
    const first = await consume(context, bulkLookup);
    expect(first.outcome.reset).toBe(false);
    expect(first.units).toEqual([local("a.jpg"), local("b.jpg")]);
    expect(context.store.assetsAt(local("a.jpg"))).toEqual([
      expect.objectContaining({ id: context.library.assets["a.jpg"]!.id, account: "streamer", path: context.library.assets["a.jpg"]!.originalPath, trashed: false }),
    ]);
    expect((await consume(context)).units).toEqual([]);
  });

  test("a rating and a trash come through as their unit", async () => {
    const context = await setUp(["a.jpg", "b.jpg"]);
    await consume(context);
    const a = context.library.assets["a.jpg"]!.id;
    const b = context.library.assets["b.jpg"]!.id;
    await api("PUT", `/assets/${a}`, { token: context.token, body: { rating: 3 } });
    await api("DELETE", "/assets", { token: context.token, body: { ids: [b], force: false } });
    const next = await consume(context);
    expect(next.units).toEqual([join(context.library.folder.local, "a.jpg"), join(context.library.folder.local, "b.jpg")]);
    expect(context.store.asset(b)?.trashed).toBe(true);
    expect(context.store.asset(a)?.trashed).toBe(false);
  });
});
