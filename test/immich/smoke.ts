// A smoke test of the daemon filing a batch end to end, run as it would be, against the development Immich (milestone
// 8). The integration tests call the functions; this runs `media-triage run` itself, with its jobs and timers.
//
//   bun test/immich/smoke.ts     (with `bun run immich up` first; about 5 minutes)
//
// Two fresh accounts (the first an admin) index an archive and an inbox. In the inbox:
//   IMG_1, IMG_2: "Lake day", same capture time; Promote added on disk, as Darktable would (a name collision: _01).
//   IMG_3: no title; Promote added in Immich (account one): it gets Promote/Needs a title and stays, until account
//          two adds a Title/ tag in Immich, and then it's filed.
//   IMG_4: not promoted: stays.
// Before Promote: one favorites IMG_1 and archives IMG_2; two puts IMG_1 and IMG_2 in an album. After filing, the new
// copies must have them back; the old copies must be offline. Then the daemon is restarted: nothing more is filed.
// The daemon's logs and state are left in a temporary folder, printed at the end.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { FIXTURES, IMMICH_URL, MEDIA_DIR, USERS, api, login, mediaFolder, newUser, waitFor } from "./harness.ts";
import { Exiftool } from "../../src/sidecars/exiftool.ts";
import { createSidecar, readSidecar } from "../../src/sidecars/sidecar.ts";

const DIR = mkdtempSync(join(tmpdir(), "media-triage-smoke-"));
const MAIN = join(import.meta.dir, "..", "..", "src", "main.ts");
const CONFIG = join(DIR, "config.toml");
const results: { what: string; ok: boolean; detail?: unknown }[] = [];
const check = (what: string, ok: boolean, detail?: unknown) => {
  results.push({ what, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${ok || detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
};

// --- Setup ---
const admin = await login(USERS.alex);
const one = await newUser(admin.accessToken, "Smoke", { admin: true });
const two = await newUser(admin.accessToken, "Smoketwo");
const folder = mediaFolder("smoke");
const phone = join(folder.local, "Inbox", "Phone");
const pictures = join(folder.local, "Pictures");
mkdirSync(phone, { recursive: true });
mkdirSync(pictures, { recursive: true });
const unit = (n: number) => join(phone, `IMG_${n}.jpg`);
for (const n of [1, 2, 4]) {
  copyFileSync(join(FIXTURES, "photo.jpg"), unit(n));
  copyFileSync(join(FIXTURES, "darktable.xmp"), `${unit(n)}.xmp`);
}
// Immich keeps one asset per checksum in a library: make the copies differ, after the JPEG's end.
appendFileSync(unit(2), "smoke-2");
appendFileSync(unit(4), "smoke-4");
copyFileSync(join(FIXTURES, "photo-2019.jpg"), unit(3));
const exiftool = await Exiftool.start();
await createSidecar(exiftool, unit(3), "Alex Example");

const libraries = (account: string) => [
  `[[immich.libraries]]\naccount = "${account}"\nname = "Smoke archive"\nfolders = ["${folder.immich}/Pictures"]\n`,
  `[[immich.libraries]]\naccount = "${account}"\nname = "Smoke inbox"\nfolders = ["${folder.immich}/Inbox/Phone"]\n`,
];
writeFileSync(
  CONFIG,
  `[paths]
inbox = "${folder.local}/Inbox"
archive = "${folder.local}"
state = "${DIR}/state"

[[sources]]
folder = "Phone"
creator = "Alex Example"

[immich]
url = "${IMMICH_URL}"
path_map = [{ immich = "/mnt/media/", local = "${MEDIA_DIR}/" }]

[[immich.accounts]]
name = "one"
email = "${one.email}"
admin = true

[[immich.accounts]]
name = "two"
email = "${two.email}"

${[...libraries("one"), ...libraries("two")].join("\n")}
# Filing's window opens now, and lasts the hour the test takes at most.
[filing]
at = "${new Date().toTimeString().slice(0, 5)}"

[timing]
settle = "5s"

[upgrade]
enabled = false
`,
);
for (const [name, user] of [["one", one], ["two", two]] as const) {
  const run = Bun.spawn([process.execPath, MAIN, "login", name, "--config", CONFIG], { stdin: new Blob([`${user.password}\n`]), stdout: "pipe", stderr: "pipe" });
  check(`login ${name}`, (await run.exited) === 0, await new Response(run.stderr).text());
}

// --- The daemon ---
let log = "";
const start = (label: string) => {
  const daemon = Bun.spawn([process.execPath, MAIN, "run", "--config", CONFIG, "--log-level", "debug"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, JOURNAL_STREAM: "" },
  });
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) {
      const text = new TextDecoder().decode(chunk);
      log += text;
      appendFileSync(join(DIR, `daemon-${label}.log`), text);
    }
  };
  void pump(daemon.stdout);
  void pump(daemon.stderr);
  return daemon;
};
const stop = async (daemon: ReturnType<typeof start>) => {
  daemon.kill("SIGTERM");
  return daemon.exited;
};

const tokens = { one: (await login(one)).accessToken, two: (await login(two)).accessToken };
type Found = { id: string; originalPath: string; isFavorite: boolean; isOffline: boolean; isTrashed: boolean; visibility: string };
const at = async (account: "one" | "two", local: string) => {
  const immich = local.replace(MEDIA_DIR, "/mnt/media");
  const { assets } = await api<{ assets: { items: Found[] } }>("POST", "/search/metadata", {
    token: tokens[account],
    body: { filter: { originalPath: { in: [immich] } }, size: 100 },
  });
  return assets.items[0];
};
const full = (account: "one" | "two", id: string) =>
  api<{ tags?: { value: string }[]; isFavorite: boolean; visibility: string; isOffline: boolean; isTrashed: boolean }>("GET", `/assets/${id}`, { token: tokens[account] });
const tagsOf = async (account: "one" | "two", id: string) => ((await full(account, id)).tags ?? []).map((tag) => tag.value).sort();
const sidecar = async (path: string) => (await readSidecar(exiftool, `${path}.xmp`))?.fields;
const promoted = (fields: Awaited<ReturnType<typeof sidecar>>) => (fields?.hierarchicalSubject ?? []).some((tag) => tag.startsWith("Promote"));

let daemon = start("1");
// A failed wait throws: don't leave the daemon running.
process.on("exit", () => daemon.kill("SIGTERM"));
const t0 = Date.now();
const old: Record<string, Record<number, string>> = { one: {}, two: {} };
for (const account of ["one", "two"] as const) {
  for (const n of [1, 2, 3, 4]) {
    old[account]![n] = (await waitFor(`account ${account}'s IMG_${n}`, async () => (await at(account, unit(n)))?.id, 180_000))!;
  }
}
console.log(`both accounts indexed the inbox after ${Math.round((Date.now() - t0) / 1000)}s`);
await waitFor("the first reconcile of every unit", async () => ((log.match(/reconciled units=/g) ?? []).length >= 2 ? true : undefined), 120_000);
await waitFor("the title tag on every titled copy", async () => {
  for (const account of ["one", "two"] as const) for (const n of [1, 2, 4]) if (!(await tagsOf(account, old[account]![n]!)).includes("Title/Lake day")) return undefined;
  return true;
}, 120_000);
check("title tags reached both accounts' copies", true);

// Per-account state, before promoting.
await api("PUT", "/assets", { token: tokens.one, body: { ids: [old.one![1]], isFavorite: true } });
await api("PUT", "/assets", { token: tokens.one, body: { ids: [old.one![2]], visibility: "archive" } });
const album = await api<{ id: string }>("POST", "/albums", { token: tokens.two, body: { albumName: "Lake trip", assetIds: [old.two![1], old.two![2]] } });
await waitFor("the accounts' state in the sidecars", async () => {
  const [a, b] = [await sidecar(unit(1)), await sidecar(unit(2))];
  type Entry = NonNullable<NonNullable<typeof a>["accounts"]>[number];
  const has = (fields: typeof a, test: (entry: Entry) => boolean) => fields?.accounts?.some(test);
  const inAlbum = (entry: Entry) => entry.albums.some((held) => held.id === album.id);
  const recorded = has(a, (entry) => entry.favorite) && has(b, (entry) => entry.visibility === "archive") && has(a, inAlbum) && has(b, inAlbum);
  return recorded ? true : undefined;
}, 120_000);
check("favorite, archive and album recorded in the sidecars (F9)", true);

// Promote: on disk for IMG_1 and IMG_2, as Darktable writes it; in Immich for IMG_3.
for (const n of [1, 2]) {
  const fields = (await sidecar(unit(n)))!;
  await exiftool.write(`${unit(n)}.xmp`, {
    "XMP-lr:HierarchicalSubject": [...(fields.hierarchicalSubject ?? []), "Promote"],
    "XMP-dc:Subject": [...(fields.subject ?? []), "Promote"],
  });
}
const [promote] = await api<{ id: string }[]>("PUT", "/tags", { token: tokens.one, body: { tags: ["Promote"] } });
await api("PUT", `/tags/${promote!.id}/assets`, { token: tokens.one, body: { ids: [old.one![3]] } });
const promotedAt = Date.now();

// IMG_1 and IMG_2 are filed; IMG_3 waits for a title.
const lake = join(pictures, "2021.06.15 - Lake day");
const filed = [join(lake, "2021.06.15-10.20.30 - Alex Example.jpg"), join(lake, "2021.06.15-10.20.30 - Alex Example_01.jpg")];
await waitFor("IMG_1 and IMG_2 filed", async () => (filed.every((path) => existsSync(path) && existsSync(`${path}.xmp`)) ? true : undefined), 300_000);
console.log(`filed after ${Math.round((Date.now() - promotedAt) / 1000)}s`);
check("IMG_1 and IMG_2 gone from the inbox", [1, 2].every((n) => !existsSync(unit(n)) && !existsSync(`${unit(n)}.xmp`)));
const names = filed.flatMap((path) => [basename(path), `${basename(path)}.xmp`]).sort();
check("the folder holds exactly the two photos and their sidecars", readdirSync(lake).sort().join("|") === names.join("|"), readdirSync(lake));
for (const path of filed) {
  const fields = await sidecar(path);
  check(`${basename(path)}: no Promote, title kept`, !promoted(fields) && fields?.title === "Lake day", fields?.hierarchicalSubject);
}
await waitFor("IMG_3 marked Promote/Needs a title", async () => ((await sidecar(unit(3)))?.hierarchicalSubject?.includes("Promote|Needs a title") ? true : undefined), 120_000);
check("IMG_3 stays, with Promote/Needs a title", existsSync(unit(3)));
check("IMG_4 untouched", existsSync(unit(4)) && !promoted(await sidecar(unit(4))));

// Put back, on the new copies. Which filed file is which unit isn't fixed: find each new copy by the old one's state.
await waitFor("put back both", async () => ((log.match(/put back unit=/g) ?? []).length >= 2 ? true : undefined), 600_000);
const fresh = { one: await Promise.all(filed.map((path) => at("one", path))), two: await Promise.all(filed.map((path) => at("two", path))) };
check("every account has a new copy of each", [...fresh.one, ...fresh.two].every(Boolean));
const states = await Promise.all(fresh.one.map((asset) => full("one", asset!.id)));
const [favorites, archived] = [states.filter((s) => s.isFavorite), states.filter((s) => s.visibility === "archive")];
check(
  "account one: one new copy a favorite, the other archived",
  favorites.length === 1 && archived.length === 1 && favorites[0] !== archived[0],
  states.map((s) => [s.isFavorite, s.visibility]),
);
const albumsOf = await Promise.all(fresh.two.map((asset) => api<{ id: string }[]>("GET", `/albums?assetId=${asset!.id}`, { token: tokens.two })));
check("account two: both new copies in the album", albumsOf.every((albums) => albums.some((held) => held.id === album.id)), albumsOf);
for (const account of ["one", "two"] as const) {
  for (const n of [1, 2]) {
    const before = await full(account, old[account]![n]!).catch(() => undefined);
    check(`account ${account}'s old IMG_${n} offline or gone`, !before || before.isOffline, before && { offline: before.isOffline });
  }
  for (const asset of fresh[account]) {
    const tags = await tagsOf(account, asset!.id);
    check(`account ${account}'s new copy: title tag, no Promote`, tags.includes("Title/Lake day") && !tags.some((tag) => tag.startsWith("Promote")), tags);
  }
}

// IMG_3: account two adds a title in Immich; it's filed.
const [title] = await api<{ id: string }[]>("PUT", "/tags", { token: tokens.two, body: { tags: ["Title/Old town"] } });
await api("PUT", `/tags/${title!.id}/assets`, { token: tokens.two, body: { ids: [old.two![3]] } });
const town = join(pictures, "2019.05.05 - Old town", "2019.05.05-09.08.07 - Alex Example.jpg");
await waitFor("IMG_3 filed", async () => (existsSync(town) && existsSync(`${town}.xmp`) ? true : undefined), 300_000);
const townFields = await sidecar(town);
check("IMG_3 filed with its title, Promote and Needs a title gone", townFields?.title === "Old town" && !promoted(townFields) && !existsSync(unit(3)), townFields?.hierarchicalSubject);
await waitFor("put back IMG_3", async () => ((log.match(/put back unit=/g) ?? []).length >= 3 ? true : undefined), 600_000);

check("daemon stopped cleanly", (await stop(daemon)) === 0);

// Restart: finishing at start finds nothing, the full pass finds nothing changed, and the filing job, a minute later,
// files nothing more.
const before = log.length;
daemon = start("2");
await waitFor("the restarted daemon's full pass", async () => (log.slice(before).includes("full pass media=") ? true : undefined), 120_000);
check("restart: the full pass finds nothing changed", /full pass media=\d+ changed=0/.test(log.slice(before)));
await Bun.sleep(70_000);
const refiled = log.slice(before).split("\n").filter((line) => /(filed unit=|filed a batch)/.test(line));
check("restart: nothing filed again", refiled.length === 0, refiled);
check("restart: IMG_4 still in the inbox", existsSync(unit(4)));
check("daemon stopped cleanly again", (await stop(daemon)) === 0);
await exiftool.close();

const problems = log.split("\n").filter((line) => / (error|warn) /.test(line) && !/isn't configured; leaving it alone/.test(line));
console.log(`\nwarnings and errors (other than other tests' libraries): ${problems.length}`);
for (const line of problems) console.log("  ", line.replace(new RegExp(MEDIA_DIR, "g"), "<media>").slice(0, 300));
const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Logs and state: ${DIR}`);
process.exit(failed.length === 0 ? 0 : 1);
