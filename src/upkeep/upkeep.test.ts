import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMMICH_URL, MEDIA_DIR, USERS, configFor, describeImmich, login, mediaFolder, newUser, photos, waitFor } from "../../test/immich/harness.ts";
import { parseConfig } from "../config.ts";
import { loginAccount } from "../immich/login.ts";
import { saveSession } from "../immich/sessions.ts";
import type { Config } from "../config.ts";
import { UNREACHABLE_RETRY_MS, checkIfIdle, checkJob, runUpkeep, upkeepJob } from "./upkeep.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "media-triage-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("when Immich can't be reached, the job asks to run again soon", async () => {
  const config = parseConfig(
    { paths: { state: dir }, immich: { url: "http://127.0.0.1:9", accounts: [{ name: "alex", email: "alex@example.com", admin: true }] } },
    null,
  );
  saveSession(dir, "alex", { token: "t", userId: "u", email: "alex@example.com", created: "" });
  expect(await upkeepJob(config, { dryRun: false })).toEqual({ nextInMs: UNREACHABLE_RETRY_MS });
  expect(await checkJob(config)).toEqual({ nextInMs: UNREACHABLE_RETRY_MS });
});

/** The check, once Immich's library queue is idle. */
async function checkWhenIdle(config: Config) {
  return waitFor("the check", async () => {
    const report = await checkIfIdle(config, { pollMs: 250 });
    return report === "busy" ? undefined : report;
  }, 60_000);
}

describeImmich("account upkeep, end to end, against Immich", () => {
  async function setUp() {
    const alex = await login(USERS.alex);
    const [boss, member] = [await newUser(alex.accessToken, "Boss", { admin: true }), await newUser(alex.accessToken, "Member")];
    const media = mediaFolder("upkeep-all");
    photos(media.local, ["Pictures/2021.01.01 - Snow/a.jpg", "Pictures/2019.05.05 - Old/b.jpg"]);
    const folders = [`${media.immich}/Pictures`];
    const libraries = [
      { account: "boss", name: "Archive", folders },
      { account: "member", name: "Shared archive", folders, dated: { since: "2020-06-15", levels: folders } },
    ];
    const accounts = [
      { name: "boss", user: boss },
      { name: "member", user: member },
    ];
    return { boss, member, accounts, libraries, media };
  }

  test("a dry run changes nothing; a live run sets everything up and checks it; a second has nothing to do", async () => {
    const { boss, member, accounts, libraries } = await setUp();
    const config = configFor(dir, accounts, { libraries });
    await loginAccount(config, "boss", boss.password);
    await loginAccount(config, "member", member.password);

    const dry = await runUpkeep(config, { dryRun: true });
    expect(dry).toMatchObject({ problems: [], joined: ["member"], libraries: { created: ["boss/Archive", "member/Shared archive"], scanned: [] } });
    const dryCheck = await checkWhenIdle(config);
    expect(dryCheck?.ok).toBe(false);
    expect(dryCheck?.libraries[0]?.skipped).toBe("it isn't in Immich yet");

    const live = await runUpkeep(config, { dryRun: false });
    expect(live).toMatchObject({ problems: [], joined: ["member"], libraries: { created: ["boss/Archive", "member/Shared archive"] } });
    expect(live.people.shared).toEqual(["boss", "member"]);
    expect(await checkWhenIdle(config)).toMatchObject({ ok: true, libraries: [{ library: "member/Shared archive", forbidden: [], missing: [] }] });

    const again = await runUpkeep(config, { dryRun: false });
    expect(again).toMatchObject({ joined: [], libraries: { created: [], updated: [], scanned: [], unchanged: ["boss/Archive", "member/Shared archive"] } });
    expect((await checkWhenIdle(config))?.ok).toBe(true);
  });

  test("the daemon runs upkeep at start (here a dry run), and stops cleanly", async () => {
    const { boss, member, accounts, libraries } = await setUp();
    const state = join(dir, "state");
    const config = configFor(state, accounts, { libraries });
    await loginAccount(config, "boss", boss.password);
    await loginAccount(config, "member", member.password);
    const toml = [
      `[paths]\ninbox = "${MEDIA_DIR}"\narchive = "${MEDIA_DIR}"\nstate = "${state}"`,
      `[immich]\nurl = "${IMMICH_URL}"\npath_map = [{ immich = "/mnt/media/", local = "${MEDIA_DIR}/" }]`,
      `[[immich.accounts]]\nname = "boss"\nemail = "${boss.email}"\nadmin = true`,
      `[[immich.accounts]]\nname = "member"\nemail = "${member.email}"`,
      ...libraries.map(
        (library) =>
          `[[immich.libraries]]\naccount = "${library.account}"\nname = "${library.name}"\nfolders = ${JSON.stringify(library.folders)}` +
          (library.dated ? `\ndated = { since = "${library.dated.since}", levels = ${JSON.stringify(library.dated.levels)} }` : ""),
      ),
      `[upgrade]\nenabled = false`,
    ].join("\n");
    writeFileSync(join(dir, "config.toml"), `${toml}\n`);

    const daemon = Bun.spawn([process.execPath, join(import.meta.dir, "..", "main.ts"), "run", "--dry-run", "--config", join(dir, "config.toml")], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, JOURNAL_STREAM: "" },
    });
    const reader = daemon.stdout.getReader();
    let out = "";
    while (!out.includes("account upkeep done")) {
      const { value, done } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
    daemon.kill("SIGTERM");
    expect(await daemon.exited).toBe(0);
    expect(out).toContain("would create library");
    expect(out).toContain("account upkeep done (dry run: nothing changed)");
    expect(out).toContain("sync started");
  });
});
