import { expect, test } from "bun:test";
import { PathMap } from "./path-map.ts";

const map = new PathMap([
  { immich: "/mnt/media/", local: "/srv/media/" },
  { immich: "/mnt/media/Inbox/", local: "/srv/inbox/" },
]);

test("maps both ways, and back again exactly", () => {
  for (const [immich, local] of [
    ["/mnt/media/Pictures/2021.06.15 - Trip/a.jpg", "/srv/media/Pictures/2021.06.15 - Trip/a.jpg"],
    ["/mnt/media/Inbox/Alex Phone/PXL_1.jpg", "/srv/inbox/Alex Phone/PXL_1.jpg"],
    ["/mnt/media", "/srv/media"],
    ["/mnt/media/", "/srv/media/"],
  ]) {
    expect(map.toLocal(immich!)).toBe(local);
    expect(map.toImmich(local!)).toBe(immich);
  }
});

test("the longest folder wins, whatever the order of the mappings", () => {
  const reversed = new PathMap([
    { immich: "/mnt/media/Inbox/", local: "/srv/inbox/" },
    { immich: "/mnt/media/", local: "/srv/media/" },
  ]);
  expect(reversed.toLocal("/mnt/media/Inbox/x.jpg")).toBe("/srv/inbox/x.jpg");
  expect(reversed.toLocal("/mnt/media/Other/x.jpg")).toBe("/srv/media/Other/x.jpg");
});

test("paths outside every mapping, relative ones, and ones that climb out aren't mapped", () => {
  expect(map.toLocal("/mnt/mediaX/a.jpg")).toBeUndefined();
  expect(map.toLocal("/elsewhere/a.jpg")).toBeUndefined();
  expect(map.toLocal("mnt/media/a.jpg")).toBeUndefined();
  expect(map.toLocal("/mnt/media/../etc/passwd")).toBeUndefined();
  expect(map.toImmich("/srv/media/Pictures/../../etc")).toBeUndefined();
  expect(map.toLocal("/mnt/media/Pictures/./a.jpg")).toBe("/srv/media/Pictures/a.jpg");
});

test("folders must end with a slash", () => {
  expect(() => new PathMap([{ immich: "/mnt/media", local: "/srv/media/" }])).toThrow("must end with /");
});
