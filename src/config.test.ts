import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigError, DEFAULT_REPO, loadConfig, parseConfig, requireRunnable } from "./config.ts";

const example = join(import.meta.dir, "..", "examples", "config.toml");
const parse = (toml: string) => parseConfig(Bun.TOML.parse(toml), "test.toml");

describe("the example configuration", () => {
  const config = loadConfig(example);

  test("reads every section", () => {
    expect(config.paths).toEqual({ inbox: "/srv/media/Inbox", archive: "/srv/media", state: expect.any(String) });
    expect(config.sources).toEqual([
      { folder: "Alex Phone", creator: "Alex Example" },
      { folder: "Sam Phone", creator: "Sam Example" },
    ]);
    expect(config.filing).toEqual({ photos: "Pictures", videos: "Videos/Clips" });
    expect(config.immich.url).toBe("http://127.0.0.1:2283");
    expect(config.immich.pathMap).toEqual([{ immich: "/mnt/media/", local: "/srv/media/" }]);
    expect(config.immich.accounts.map((account) => [account.name, account.admin])).toEqual([
      ["alex", true],
      ["sam", false],
    ]);
    expect(config.immich.libraries).toHaveLength(4);
    expect(config.immich.libraries[2]!.dated).toEqual({ since: "2020-06-15", levels: ["/mnt/media/Pictures", "/mnt/media/Videos/*"] });
    expect(config.timing).toEqual({ settleMs: 300_000, orphanGraceMs: 3_600_000, fullPassMs: 86_400_000 });
    expect(config.upgrade).toEqual({ enabled: true, repo: DEFAULT_REPO, intervalMs: 21_600_000, track: "minor", prerelease: false, restart: true });
    expect(config.log.level).toBe("info");
  });

  test("is runnable", () => {
    expect(() => requireRunnable(config)).not.toThrow();
  });
});

describe("defaults", () => {
  test("an empty file gives the defaults, which aren't runnable", () => {
    const config = parse("");
    expect(config.paths.state).toContain("media-triage");
    expect(config.upgrade.enabled).toBe(true);
    expect(config.upgrade.track).toBe("minor");
    expect(() => requireRunnable(config)).toThrow("needs paths.inbox, paths.archive, immich.url, at least one [[immich.accounts]]");
  });

  test("a missing file is an error, unless optional", () => {
    expect(() => loadConfig("/nonexistent/config.toml")).toThrow("media-triage init");
    expect(loadConfig("/nonexistent/config.toml", { optional: true }).file).toBeNull();
  });

  test("~ expands to the home folder", () => {
    expect(parse('[paths]\nstate = "~/state"').paths.state).toBe(join(homedir(), "state"));
  });

  test("path map entries get a trailing slash", () => {
    expect(parse('[immich]\npath_map = [{ immich = "/a", local = "/b" }]').immich.pathMap).toEqual([{ immich: "/a/", local: "/b/" }]);
  });
});

describe("mistakes it catches", () => {
  test.each([
    ['[paths]\ninbx = "/x"', "Unknown setting: paths.inbx"],
    ["typo = 1", "Unknown setting: typo"],
    ['[paths]\ninbox = "relative"', "paths.inbox must be an absolute path"],
    ['[[sources]]\nfolder = "a/b"\ncreator = "C"', "sources[0].folder must be the name of a folder"],
    ['[[sources]]\nfolder = "A"', "sources[0].creator is required"],
    ['[[sources]]\nfolder = "A"\ncreator = "C"\n[[sources]]\nfolder = "A"\ncreator = "D"', '"A" appears twice'],
    ['[filing]\nphotos = "../out"', "filing.photos must be a folder inside the archive"],
    ['[immich]\nurl = "ftp://x"', "immich.url must be an http or https URL"],
    ['[immich]\npath_map = [{ immich = "/a", local = "/b" }, { immich = "/a/", local = "/c" }]', 'immich.path_map: immich: "/a/" appears twice'],
    ['[[immich.accounts]]\nname = "Alex"\nemail = "a@b"', "immich.accounts[0].name must be lowercase"],
    ['[[immich.accounts]]\nname = "a"\nemail = "nope"', "isn't an email address"],
    ['[[immich.accounts]]\nname = "a"\nemail = "a@b"\nadmin = true\n[[immich.accounts]]\nname = "b"\nemail = "b@b"\nadmin = true', "only one account can be the admin"],
    ['[[immich.libraries]]\naccount = "x"\nname = "L"\nfolders = ["/a"]', '"x" isn\'t one of immich.accounts'],
    ['[[immich.accounts]]\nname = "a"\nemail = "a@b"\n[[immich.libraries]]\naccount = "a"\nname = "L"\nfolders = ["/a"]\ndated = { since = "2020-02-30", levels = ["/a"] }', "isn't a date written YYYY-MM-DD"],
    ['[timing]\nsettle = "soon"', "timing.settle"],
    ['[upgrade]\ninterval = "1m"', "upgrade.interval must be at least 10m"],
    ['[upgrade]\ntrack = "latest"', 'upgrade.track must be one of "patch", "minor", "major"'],
    ['[upgrade]\nenabled = "yes"', "upgrade.enabled must be true or false"],
    ['[log]\nlevel = "loud"', "log.level must be one of"],
  ])("%p", (toml, message) => {
    expect(() => parse(toml)).toThrow(ConfigError);
    expect(() => parse(toml)).toThrow(message);
  });
});

test("reads_new_sidecars defaults to false", () => {
  expect(parseConfig({}, null).immich.readsNewSidecars).toBe(false);
  expect(parseConfig({ immich: { reads_new_sidecars: true } }, null).immich.readsNewSidecars).toBe(true);
});
