import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMMICH_URL, USERS, configFor, describeImmich, login, mediaFolder, newUser, photos } from "../../test/immich/harness.ts";
import type { Config } from "../config.ts";
import { listLibraries, scanLibrary, updateLibrary, waitForLibraryQueue } from "../immich/libraries.ts";
import { loginAccount } from "../immich/login.ts";
import { type OpenAccount, openAccounts } from "./accounts.ts";
import { type CheckReport, checkLibraries, formatReport } from "./check.ts";
import { joinClusterGroup } from "./cluster.ts";
import { upkeepLibraries } from "./libraries.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "media-triage-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describeImmich("the check, against Immich", () => {
  test("passes on a correct library, and fails loudly on what it can see and what's missing", async () => {
    const alex = await login(USERS.alex);
    const [boss, member] = [await newUser(alex.accessToken, "Boss", { admin: true }), await newUser(alex.accessToken, "Member")];
    const media = mediaFolder("check");
    photos(media.local, [
      "Pictures/2021.01.01 - Snow/a.jpg",
      "Pictures/2019.05.05 - Old/b.jpg",
      "Pictures/Staging/c.jpg",
      "Pictures/Misc/e.jpg",
      "Pictures/2020 Christmas/f.jpg",
      "Videos/loose.jpg",
      "Videos/Clips/2021.02.02 - Fun/d.jpg",
    ]);
    photos(media.local, ["Inbox/Phone/early.jpg"], "photo-2019.jpg");
    photos(media.local, ["Inbox/Phone/late.jpg"]);
    const { immich } = media;
    const config: Config = configFor(
      dir,
      [
        { name: "boss", user: boss },
        { name: "member", user: member },
      ],
      {
        paths: { inbox: join(media.local, "Inbox") },
        libraries: [
          { account: "boss", name: "Archive", folders: [`${immich}/Pictures`, `${immich}/Videos`] },
          {
            account: "member",
            name: "Shared archive",
            folders: [`${immich}/Pictures`, `${immich}/Videos`],
            exclude: [`${immich}/Pictures/Staging{,/**}`],
            dated: { since: "2020-06-15", levels: [`${immich}/Pictures`, `${immich}/Videos/*`] },
          },
          { account: "member", name: "Inbox", folders: [`${immich}/Inbox/Phone`] },
        ],
      },
    );
    await loginAccount(config, "boss", boss.password);
    await loginAccount(config, "member", member.password);
    const accounts = await openAccounts(config);
    const [admin] = accounts.open as [OpenAccount];
    const check = async (): Promise<CheckReport> => {
      expect(await waitForLibraryQueue(admin.client, 60_000, 250)).toBe(true);
      return checkLibraries(config, accounts.open, await listLibraries(admin.client));
    };

    // Before the library exists, it can't be checked, and that's a failure.
    const before = await checkLibraries(config, accounts.open, await listLibraries(admin.client));
    expect(before).toMatchObject({ ok: false, libraries: [{ library: "member/Shared archive", skipped: "it isn't in Immich yet" }] });

    const { inGroup } = await joinClusterGroup("boss", accounts.open, { dryRun: false });
    await upkeepLibraries(config, admin, inGroup, { dryRun: false });
    const good = await check();
    expect(good.ok).toBe(true);
    const [shared] = good.libraries;
    expect(shared).toMatchObject({ library: "member/Shared archive", forbidden: [], missing: [], tooNew: 0 });
    expect(shared!.undated).toEqual([
      { name: "2020 Christmas", why: "vague", files: 1 },
      { name: "loose.jpg", why: "loose", files: 1 },
      { name: "Misc", why: "undated", files: 1 },
    ]);
    expect(shared!.earlyInbox).toEqual([{ path: `${immich}/Inbox/Phone/early.jpg`, date: "2019-05-05" }]);
    expect(formatReport(good)[0]).toBe("OK      member/Shared archive");

    // Patterns that let everything in: every leaked asset is a failure, and stays one while it's in the trash.
    const sharedId = (await listLibraries(admin.client)).find((library) => library.ownerId === accounts.open[1]!.userId && library.name === "Shared archive")!.id;
    await updateLibrary(admin.client, sharedId, { exclusionPatterns: ["**/.*"] });
    await scanLibrary(admin.client, sharedId);
    const leaked = await check();
    expect(leaked.ok).toBe(false);
    expect(leaked.libraries[0]!.forbidden.map((item) => [item.path.slice(immich.length + 1), item.why, item.offline]).sort()).toEqual([
      ["Pictures/2019.05.05 - Old/b.jpg", "before: 2019.05.05 - Old", false],
      ["Pictures/2020 Christmas/f.jpg", "vague: 2020 Christmas", false],
      ["Pictures/Misc/e.jpg", "undated: Misc", false],
      ["Pictures/Staging/c.jpg", "undated: Staging", false],
      ["Videos/loose.jpg", "loose: loose.jpg", false],
    ]);
    expect(formatReport(leaked)).toContain("  5 asset(s) the date limit doesn't allow, which this account can see:");

    await upkeepLibraries(config, admin, inGroup, { dryRun: false });
    const trashed = await check();
    expect(trashed.ok).toBe(false);
    expect(trashed.libraries[0]!.forbidden.every((item) => item.offline)).toBe(true);
    expect(formatReport(trashed).join("\n")).toContain("(before: 2019.05.05 - Old; offline, in the trash)");

    // Patterns that leave out an allowed folder: its files are missing.
    await updateLibrary(admin.client, sharedId, { exclusionPatterns: ["**/.*", `${immich}/Pictures/2021*{,/**}`, `${immich}/Pictures/[^2]*{,/**}`, `${immich}/Pictures/2019*{,/**}`, `${immich}/Pictures/2020*{,/**}`, `${immich}/Videos/*.*`] });
    await scanLibrary(admin.client, sharedId);
    const short = await check();
    expect(short.libraries[0]!.missing).toEqual([`${immich}/Pictures/2021.01.01 - Snow/a.jpg`]);
  });

  test("folders that aren't here (a wrong path map) are a failure, not a pass", async () => {
    const alex = await login(USERS.alex);
    const [boss, member] = [await newUser(alex.accessToken, "Boss", { admin: true }), await newUser(alex.accessToken, "Member")];
    const media = mediaFolder("check-map");
    photos(media.local, ["Pictures/2021.01.01 - Snow/a.jpg"]);
    const accounts = [
      { name: "boss", user: boss },
      { name: "member", user: member },
    ];
    const libraries = [{ account: "member", name: "Shared", folders: [`${media.immich}/Pictures`], dated: { since: "2020-06-15", levels: [`${media.immich}/Pictures`] } }];
    const config = configFor(dir, accounts, { libraries });
    await loginAccount(config, "boss", boss.password);
    await loginAccount(config, "member", member.password);
    const { open } = await openAccounts(config);
    const { inGroup } = await joinClusterGroup("boss", open, { dryRun: false });
    await upkeepLibraries(config, open[0], inGroup, { dryRun: false });
    expect(await waitForLibraryQueue(open[0]!.client, 60_000, 250)).toBe(true);

    const wrong = { ...config, immich: { ...config.immich, pathMap: [{ immich: "/mnt/media/", local: `${dir}/` }] } };
    const report = await checkLibraries(wrong, open, await listLibraries(open[0]!.client));
    expect(report.ok).toBe(false);
    expect(report.libraries[0]!.skipped).toStartWith("no media files were found in its folders here, but Immich has 1");
  });

  test("an owner that isn't logged in can't be checked, and that's a failure", async () => {
    const config = configFor(dir, [{ name: "member", user: USERS.sam }], {
      libraries: [{ account: "member", name: "Shared", folders: ["/mnt/media/x"], dated: { since: "2020-06-15", levels: ["/mnt/media/x"] } }],
    });
    const report = await checkLibraries(config, [], []);
    expect(report.ok).toBe(false);
    expect(formatReport(report)).toEqual(["FAILED  member/Shared: not checked: member isn't logged in, and only its own session can list its assets"]);
  });
});

describeImmich("media-triage check", () => {
  async function run(...args: string[]) {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "..", "main.ts"), ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, JOURNAL_STREAM: "" },
    });
    const [status, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { status, out, err };
  }

  test("prints the report and exits 0 when nothing failed; needs the admin's session", async () => {
    const file = join(dir, "config.toml");
    const accounts = `[[immich.accounts]]\nname = "alex"\nemail = "${USERS.alex.email}"\nadmin = true\n`;
    const write = (body: string) => Bun.write(file, `[paths]\nstate = "${join(dir, "state")}"\n[immich]\nurl = "${IMMICH_URL}"\n${body}`);
    await write(accounts);
    expect(await run("check", "--config", file)).toMatchObject({ status: 1, err: expect.stringContaining("needs the admin account's session") });

    await loginAccount(configFor(join(dir, "state"), [{ name: "alex", user: USERS.alex }]), "alex", USERS.alex.password);
    expect(await run("check", "--config", file)).toMatchObject({ status: 0, out: "No library is limited by date: nothing to check.\n" });

    await write(`${accounts}[[immich.libraries]]\naccount = "alex"\nname = "Nowhere"\nfolders = ["/mnt/media/nowhere"]\ndated = { since = "2020-06-15", levels = ["/mnt/media/nowhere"] }\n`);
    expect(await run("check", "--config", file)).toMatchObject({ status: 1, out: "FAILED  alex/Nowhere: not checked: it isn't in Immich yet\n" });
  });
});
