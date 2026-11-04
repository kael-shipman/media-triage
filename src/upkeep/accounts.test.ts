import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USERS, configFor, describeImmich, login, newUser } from "../../test/immich/harness.ts";
import { ImmichClient } from "../immich/client.ts";
import { loginAccount } from "../immich/login.ts";
import { loadSession, sessionFile } from "../immich/sessions.ts";
import { openAccounts } from "./accounts.ts";
import { joinClusterGroup } from "./cluster.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "media-triage-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describeImmich("opening accounts, against Immich", () => {
  test("working sessions open; missing, unreadable and revoked ones are problems that say what to do", async () => {
    const admin = await login(USERS.alex);
    const [one, two, three, four] = await Promise.all(["One", "Two", "Three", "Four"].map((label) => newUser(admin.accessToken, label)));
    const config = configFor(dir, [
      { name: "one", user: one! },
      { name: "two", user: two! },
      { name: "three", user: three! },
      { name: "four", user: four! },
    ]);
    await loginAccount(config, "one", one!.password);
    await loginAccount(config, "three", three!.password);
    await loginAccount(config, "four", four!.password);
    chmodSync(sessionFile(dir, "three"), 0o644);
    await new ImmichClient(config.immich.url!, loadSession(dir, "four")!.token).logout();

    const accounts = await openAccounts(config);
    expect(accounts.open.map((open) => [open.account.name, open.email])).toEqual([["one", one!.email]]);
    expect(accounts.open[0]!.clusterGroupId).toBeString();
    expect(accounts.problems.map(({ account, problem }) => [account.name, problem])).toEqual([
      ["two", "not logged in: run `media-triage login two`"],
      ["three", expect.stringContaining("can be read by others")],
      ["four", "its session was revoked or has expired: log in again with `media-triage login four`"],
    ]);
  });
});

describeImmich("the cluster group, against Immich", () => {
  test("every account joins the first account's group; a dry run changes nothing; a second pass has nothing to do", async () => {
    const admin = await login(USERS.alex);
    const [first, second, third] = await Promise.all(["First", "Second", "Third"].map((label) => newUser(admin.accessToken, label)));
    const config = configFor(dir, [
      { name: "first", user: first! },
      { name: "second", user: second! },
      { name: "third", user: third! },
    ]);
    for (const [name, user] of [["first", first!], ["second", second!], ["third", third!]] as const) await loginAccount(config, name, user.password);

    const before = await openAccounts(config);
    const groups = () => Promise.all(before.open.map((open) => open.client.me().then((me) => me.clusterGroupId)));
    const [groupOne, groupTwo, groupThree] = await groups();
    expect(new Set([groupOne, groupTwo, groupThree]).size).toBe(3);

    const dry = await joinClusterGroup("first", before.open, { dryRun: true });
    expect([...dry.inGroup].sort()).toEqual(["first", "second", "third"]);
    expect(dry.joined).toEqual(["second", "third"]);
    expect(await groups()).toEqual([groupOne!, groupTwo!, groupThree!]);

    const live = await joinClusterGroup("first", before.open, { dryRun: false });
    expect(live).toEqual({ inGroup: new Set(["first", "second", "third"]), joined: ["second", "third"], problems: [] });
    expect(await groups()).toEqual([groupOne!, groupOne!, groupOne!]);

    const again = await joinClusterGroup("first", (await openAccounts(config)).open, { dryRun: false });
    expect(again.joined).toEqual([]);
    expect(again.inGroup.size).toBe(3);
  });

  test("without the first account, nobody joins, and each says why", async () => {
    const admin = await login(USERS.alex);
    const other = await newUser(admin.accessToken, "Other");
    const config = configFor(dir, [{ name: "other", user: other }]);
    await loginAccount(config, "other", other.password);
    const outcome = await joinClusterGroup("first", (await openAccounts(config)).open, { dryRun: false });
    expect(outcome.inGroup.size).toBe(0);
    expect(outcome.problems[0]!.problem).toBe(`can't join the first account's cluster group: "first" isn't logged in`);
  });
});
