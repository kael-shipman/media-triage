import { expect, test } from "bun:test";
import { dirname } from "node:path";
import { parseConfig } from "../config.ts";
import { type Disk, planUnit } from "./plan.ts";

const config = parseConfig({ paths: { inbox: "/srv/Inbox", archive: "/srv", state: "/tmp/state" } }, null);
const inbox = "/srv/Inbox/Phone";

/** A disk holding these files, all on one filesystem unless `devices` says otherwise. */
function fakeDisk(files: string[], devices: Record<string, number> = {}): Disk {
  const set = new Set(files);
  return {
    exists: (path) => set.has(path),
    list: (folder) => files.filter((file) => dirname(file) === folder).map((file) => file.slice(folder.length + 1)),
    device: (path) => Object.entries(devices).find(([prefix]) => path.startsWith(prefix))?.[1] ?? 1,
  };
}

const input = { unit: `${inbox}/IMG_1.jpg`, title: "Lake day", creator: "Alex Example", date: "2021:06:15 10:20:30+02:00" };

test("a photo and its sidecar, named as the Archive RAW preset does, by the capture time's wall time", () => {
  const result = planUnit(config, input, new Set(), fakeDisk([`${inbox}/IMG_1.jpg`, `${inbox}/IMG_1.jpg.xmp`]));
  expect(result).toEqual({
    plan: {
      unit: `${inbox}/IMG_1.jpg`,
      destination: "/srv/Pictures/2021.06.15 - Lake day/2021.06.15-10.20.30 - Alex Example.jpg",
      moves: [
        { from: `${inbox}/IMG_1.jpg`, to: "/srv/Pictures/2021.06.15 - Lake day/2021.06.15-10.20.30 - Alex Example.jpg" },
        { from: `${inbox}/IMG_1.jpg.xmp`, to: "/srv/Pictures/2021.06.15 - Lake day/2021.06.15-10.20.30 - Alex Example.jpg.xmp" },
      ],
    },
  });
});

test("a video goes under Videos/Clips, dated by Immich when the sidecar has no date", () => {
  const result = planUnit(
    config,
    { ...input, unit: `${inbox}/VID_1.mp4`, date: null, immich: { localDateTime: "2021-06-15T08:00:05.000Z", fileCreatedAt: "2021-06-15T06:00:05.000Z", timeZone: "UTC+2" } },
    new Set(),
    fakeDisk([`${inbox}/VID_1.mp4`]),
  );
  expect(result).toMatchObject({ plan: { destination: "/srv/Videos/Clips/2021.06.15 - Lake day/2021.06.15-08.00.05 - Alex Example.mp4" } });
});

test("a Live Photo's video goes with its photo, into Pictures, under the same name and collision number", () => {
  const folder = "/srv/Pictures/2021.06.15 - Lake day";
  const files = [`${inbox}/IMG_1.HEIC`, `${inbox}/IMG_1.HEIC.xmp`, `${inbox}/IMG_1.MOV`, `${folder}/2021.06.15-10.20.30 - Alex Example.MOV`];
  const result = planUnit(config, { ...input, unit: `${inbox}/IMG_1.HEIC`, liveVideo: `${inbox}/IMG_1.MOV` }, new Set(), fakeDisk(files));
  expect(result).toMatchObject({
    plan: {
      moves: [
        { to: `${folder}/2021.06.15-10.20.30 - Alex Example_01.HEIC` },
        { to: `${folder}/2021.06.15-10.20.30 - Alex Example_01.HEIC.xmp` },
        { from: `${inbox}/IMG_1.MOV`, to: `${folder}/2021.06.15-10.20.30 - Alex Example_01.MOV` },
      ],
    },
  });
});

test("collisions with what's on disk, its sidecars, and the batch's earlier units", () => {
  const folder = "/srv/Pictures/2021.06.15 - Lake day";
  const taken = new Set<string>();
  const on = fakeDisk([`${inbox}/IMG_1.jpg`, `${inbox}/IMG_2.jpg`, `${inbox}/IMG_3.jpg`, `${folder}/2021.06.15-10.20.30 - Alex Example.jpg.xmp`]);
  const destinations = ["IMG_1.jpg", "IMG_2.jpg", "IMG_3.jpg"].map((name) => {
    const result = planUnit(config, { ...input, unit: `${inbox}/${name}` }, taken, on);
    return "plan" in result ? result.plan.destination.slice(folder.length + 1) : result.problem;
  });
  expect(destinations).toEqual(["2021.06.15-10.20.30 - Alex Example_01.jpg", "2021.06.15-10.20.30 - Alex Example_02.jpg", "2021.06.15-10.20.30 - Alex Example_03.jpg"]);
});

test.each<[string, Parameters<typeof planUnit>[1], Disk, string]>([
  ["no capture time", { ...input, date: null }, fakeDisk([input.unit]), "it has no capture time"],
  ["Darktable duplicates", input, fakeDisk([input.unit, `${inbox}/IMG_1_01.jpg.xmp`]), "it has Darktable duplicates, which filing doesn't move"],
  ["another filesystem", input, fakeDisk([input.unit], { "/srv/Pictures": 2 }), "the archive is on another filesystem than /srv/Inbox/Phone"],
])("not filed: %s", (_name, unit, on, problem) => {
  expect(planUnit(config, unit, new Set(), on)).toEqual({ problem });
});

test("no archive configured", () => {
  const without = parseConfig({ paths: { inbox: "/srv/Inbox", state: "/tmp/state" } }, null);
  expect(planUnit(without, input, new Set(), fakeDisk([input.unit]))).toEqual({ problem: "no archive is configured (paths.archive)" });
});
