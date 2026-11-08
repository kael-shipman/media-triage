import { describe, expect, test } from "bun:test";
import {
  type XmpFields,
  TAGS,
  darktableReads,
  dateFromImmich,
  hasDate,
  imageTags,
  immichReads,
  immichReadsImageTags,
  offsetFromImmich,
  parseImage,
  parseXmp,
  planWrite,
  sameDate,
} from "./xmp.ts";

/** What exiftool reads from a sidecar Darktable wrote, in the shape src/sidecars/ asks for (every value quoted). */
const darktableRaw = {
  [TAGS.toolkit]: "XMP Core 4.4.0-Exiv2",
  [TAGS.rating]: "3",
  [TAGS.title]: "1.50",
  [TAGS.description]: "A day out",
  [TAGS.creator]: ["Alex Example"],
  [TAGS.subject]: ["Lake", "Places", "darktable", "format", "jpg"],
  [TAGS.hierarchicalSubject]: ["Places|Lake", "darktable|format|jpg"],
  [TAGS.date]: "2020:06:15 10:30:00.000",
  [TAGS.latitude]: "12.5",
  [TAGS.longitude]: "-3.25",
};

/** …and from one Immich then rewrote: it adds `TagsList`, and copies of the description and date. */
const immichFields: XmpFields = {
  toolkit: "Image::ExifTool 13.25",
  rating: 4,
  description: "A day out",
  immichDescription: "A day out",
  creator: ["Alex Example"],
  subject: ["Lake", "Places", "darktable", "format", "jpg"],
  hierarchicalSubject: ["Places|Lake", "darktable|format|jpg"],
  tagsList: ["Places/Lake", "darktable/format/jpg"],
  date: "2020:06:15 10:30:00.000+02:00",
  immichDate: "2020:06:15 10:30:00.000+02:00",
};

describe("parseXmp", () => {
  test("reads each field, keeping text that looks like a number as it was", () => {
    expect(parseXmp(darktableRaw)).toEqual({
      toolkit: "XMP Core 4.4.0-Exiv2",
      rating: 3,
      title: "1.50",
      description: "A day out",
      creator: ["Alex Example"],
      subject: ["Lake", "Places", "darktable", "format", "jpg"],
      hierarchicalSubject: ["Places|Lake", "darktable|format|jpg"],
      date: "2020:06:15 10:30:00.000",
      latitude: 12.5,
      longitude: -3.25,
    });
  });

  test("a single list item can come as a plain value", () => {
    expect(parseXmp({ [TAGS.tagsList]: "007" }).tagsList).toEqual(["007"]);
  });

  test("reads the accounts' state, with defaults for what's left out", () => {
    const fields = parseXmp({
      [TAGS.accounts]: [
        { User: "u1", Favorite: "True", Visibility: "archive", Albums: [{ Id: "a1", Name: "Trip, 2020" }] },
        { User: "u2", Albums: { Id: "a2", Name: "Other" } },
        { Favorite: "True" },
      ],
    });
    expect(fields.accounts).toEqual([
      { user: "u1", favorite: true, visibility: "archive", albums: [{ id: "a1", name: "Trip, 2020" }] },
      { user: "u2", favorite: false, visibility: "timeline", albums: [{ id: "a2", name: "Other" }] },
    ]);
  });

  test("reads regions, keeping what they hold, and leaves out the area of one that isn't a rectangle", () => {
    const point = { Area: { X: "0.1", Y: "0.2", Unit: "normalized" }, Type: "Focus" };
    const face = { Area: { X: "0.25", Y: "0.5", W: "0.2", H: "0.3", Unit: "normalized" }, Type: "Face", Name: "Robin Example", Rotation: "0" };
    const fields = parseXmp({ [TAGS.regions]: { AppliedToDimensions: { W: "96", H: "64", Unit: "pixel" }, RegionList: [face, point] } });
    expect(fields.regions).toEqual({
      width: 96,
      height: 64,
      regions: [
        { area: { x: 0.25, y: 0.5, w: 0.2, h: 0.3 }, type: "Face", name: "Robin Example", raw: face },
        { type: "Focus", name: undefined, raw: point },
      ],
    });
  });
});

describe("what each tool reads", () => {
  test("Darktable: its hierarchical tags, without its own", () => {
    expect(darktableReads(parseXmp(darktableRaw))).toEqual({
      tags: ["Places/Lake"],
      rating: 3,
      title: "1.50",
      description: "A day out",
      date: "2020:06:15 10:30:00.000",
    });
  });

  test("Darktable falls back to dc:subject", () => {
    expect(darktableReads({ subject: ["Lake", "Sky"] }).tags).toEqual(["Lake", "Sky"]);
  });

  test("Darktable reads dates without their offsets, and falls back to Immich's", () => {
    expect(darktableReads(immichFields).date).toBe("2020:06:15 10:30:00.000");
    expect(darktableReads({ immichDate: "2020:06:15 10:30:00-05:00" }).date).toBe("2020:06:15 10:30:00");
  });

  test("Immich: TagsList first, its own copies of the description and date first, ratings 1 to 5 only", () => {
    const stale = { ...immichFields, description: "Changed in Darktable", date: "2021:01:01 09:00:00.000", rating: -1 };
    expect(immichReads(stale)).toEqual({ tags: ["Places/Lake"], description: "A day out", date: "2020:06:15 10:30:00.000+02:00" });
  });

  test("Immich reads Darktable's tags when there's no TagsList, and its own are left out", () => {
    expect(immichReads(parseXmp(darktableRaw)).tags).toEqual(["Places/Lake"]);
    expect(immichReads({ hierarchicalSubject: ["Music|AC/DC"] }).tags).toEqual(["Music/AC|DC"]);
  });
});

describe("the image file's own tags and date", () => {
  test("reads the tag fields, and keywords from any group, once each", () => {
    const image = parseImage({
      SourceFile: "a.jpg",
      "XMP-digiKam:TagsList": ["People/Family/Robin Example", ""],
      "XMP-lr:HierarchicalSubject": "Places|Lake",
      "IPTC:Keywords": ["Robin Example", "Lake"],
      "XMP-pdf:Keywords": "Lake",
    });
    expect(image).toEqual({ tagsList: ["People/Family/Robin Example", ""], hierarchicalSubject: ["Places|Lake"], keywords: ["Robin Example", "Lake"], hasDate: false });
    expect(imageTags(image).toSorted()).toEqual(["", "Lake", "People/Family/Robin Example", "Places/Lake", "Robin Example"]);
  });

  test("a capture time is a date with a time in one of the fields Immich takes one from", () => {
    expect(parseImage({ "ExifIFD:DateTimeOriginal": "2021:06:15 10:20:30" }).hasDate).toBe(true);
    expect(parseImage({ "QuickTime:MediaCreateDate": "2021:06:15 10:20:30" }).hasDate).toBe(true);
    expect(parseImage({ "Composite:DateTimeCreated": "2004:01:28 12:17:19+00:00" }).hasDate).toBe(true);
    // A date alone, zeros, and dates Immich doesn't take (the file's, a modify date) aren't.
    expect(parseImage({ "IPTC:DateCreated": "2004:01:28" }).hasDate).toBe(false);
    expect(parseImage({ "QuickTime:CreateDate": "0000:00:00 00:00:00" }).hasDate).toBe(false);
    expect(parseImage({ "System:FileModifyDate": "2013:11:20 20:45:23-06:00", "IFD0:ModifyDate": "2013:11:20 20:45:23" }).hasDate).toBe(false);
  });

  test("Immich shows the image's tags where the sidecar lacks the field it would take them from", () => {
    const darktable: XmpFields = { hierarchicalSubject: ["People|Robin Example"] };
    expect(immichReadsImageTags(darktable, { tagsList: ["People/Family/Robin Example"], hasDate: true })).toBe(true);
    // The sidecar's HierarchicalSubject comes before the image's, and before its keywords.
    expect(immichReadsImageTags(darktable, { hierarchicalSubject: ["People|Family|Robin Example"], keywords: ["Robin"], hasDate: true })).toBe(false);
    expect(immichReadsImageTags({}, { keywords: ["Robin"], hasDate: true })).toBe(true);
    expect(immichReadsImageTags({ ...darktable, tagsList: ["People/Robin Example"] }, { tagsList: ["Old"], hasDate: true })).toBe(false);
    expect(immichReadsImageTags(darktable, { hasDate: true })).toBe(false);
  });

  test("a sidecar's capture time is either tool's date field", () => {
    expect(hasDate({ date: "2021:06:15 10:20:30" })).toBe(true);
    expect(hasDate({ immichDate: "2021:06:15 10:20:30-05:00" })).toBe(true);
    expect(hasDate({ hierarchicalSubject: ["Places|Lake"] })).toBe(false);
    expect(hasDate(undefined)).toBe(false);
  });
});

describe("sameDate", () => {
  test.each([
    ["2020:06:15 10:30:00.000", "2020:06:15 10:30:00", true],
    ["2020:06:15 10:30:00.000+02:00", "2020:06:15 10:30:00.000", true],
    ["2020:06:15 10:30:00+02:00", "2020:06:15 10:30:00+05:00", false],
    ["2020:06:15 10:30:00", "2020:06:15 10:30:01", false],
    ["2020:06:15 10:30:00Z", "2020:06:15 10:30:00+00:00", false],
    ["2020", "2020", true],
    ["2020", "2021", false],
  ])("%p and %p: %p", (a, b, same) => {
    expect(sameDate(a, b)).toBe(same);
  });

  test("a missing date is the same only as another missing one", () => {
    expect(sameDate(undefined, undefined)).toBe(true);
    expect(sameDate("2020:06:15 10:30:00", undefined)).toBe(false);
  });
});

describe("planWrite", () => {
  test("nothing to write when everything already says what's wanted", () => {
    const fields = { ...parseXmp(darktableRaw), tagsList: ["Places/Lake", "Title/1.50"] };
    expect(
      planWrite(fields, {
        rating: 3,
        title: "1.50",
        description: "A day out",
        creator: "Alex Example",
        tags: ["Places/Lake"],
        date: "2020:06:15 10:30:00",
        gps: { latitude: 12.50000001, longitude: -3.25 },
        accounts: [{ user: "u1", favorite: false, visibility: "timeline", albums: [] }],
        regions: null,
      }),
    ).toEqual({});
  });

  test("only the fields given, and only those that change", () => {
    expect(planWrite(parseXmp(darktableRaw), { rating: -1, title: null })).toEqual({ [TAGS.rating]: -1, [TAGS.title]: null });
  });

  test("the description is also written to Immich's copy, where it has one", () => {
    expect(planWrite({ description: "Old" }, { description: "New" })).toEqual({ [TAGS.description]: "New" });
    expect(planWrite({ description: "Old", immichDescription: "Old" }, { description: "New" })).toEqual({
      [TAGS.description]: "New",
      [TAGS.immichDescription]: "New",
    });
    // Darktable changed its own field: only Immich's copy is out of step.
    expect(planWrite({ ...immichFields, description: "New" }, { description: "New" })).toEqual({ [TAGS.immichDescription]: "New" });
  });

  test("tags go to Darktable's fields, and to TagsList where it exists or there's a title; Darktable's own tags stay", () => {
    const { title: _, ...untitled } = parseXmp(darktableRaw);
    expect(planWrite(untitled, { tags: ["Places/Lake", "People/Robin Example"] })).toEqual({
      [TAGS.hierarchicalSubject]: ["darktable|format|jpg", "Places|Lake", "People|Robin Example"],
      [TAGS.subject]: ["darktable", "format", "jpg", "Places", "Lake", "People", "Robin Example"],
    });
    // With a title, Immich needs TagsList to see it as a tag.
    expect(planWrite(parseXmp(darktableRaw), { tags: ["Places/Lake"] })).toEqual({ [TAGS.tagsList]: ["Places/Lake", "Title/1.50"] });
    expect(planWrite(immichFields, { tags: ["Music/AC|DC"] })).toEqual({
      [TAGS.hierarchicalSubject]: ["darktable|format|jpg", "Music|AC/DC"],
      [TAGS.subject]: ["darktable", "format", "jpg", "Music", "AC/DC"],
      [TAGS.tagsList]: ["darktable/format/jpg", "Music/AC|DC"],
    });
  });

  test("TagsList is also written where Immich would otherwise show the image's tags", () => {
    const { title: _, ...untitled } = parseXmp(darktableRaw);
    expect(planWrite(untitled, { tags: ["Places/Lake"], tagsList: true })).toEqual({ [TAGS.tagsList]: ["Places/Lake"] });
  });

  test("removing every tag removes the fields that would be empty", () => {
    expect(planWrite({ hierarchicalSubject: ["Places|Lake"], subject: ["Places", "Lake"], tagsList: ["Places/Lake"] }, { tags: [] })).toEqual({
      [TAGS.hierarchicalSubject]: null,
      [TAGS.subject]: null,
      [TAGS.tagsList]: null,
    });
  });

  test("tags in another order are the same tags", () => {
    expect(planWrite({ hierarchicalSubject: ["B", "A"], subject: ["A", "B"] }, { tags: ["A", "B"] })).toEqual({});
  });

  describe("dates: both tools show the same capture time, and the offset is kept where Darktable keeps it", () => {
    test("Darktable moved the time: both fields get it, with the zone it had", () => {
      const moved = { ...immichFields, date: "2020:06:15 11:00:00.000" };
      expect(planWrite(moved, { date: "2020:06:15 11:00:00.000" })).toEqual({
        [TAGS.date]: "2020:06:15 11:00:00.000+02:00",
        [TAGS.immichDate]: "2020:06:15 11:00:00.000+02:00",
      });
    });

    test("Darktable only dropped the offset: nothing to write, since Immich reads its own field", () => {
      expect(planWrite({ ...immichFields, date: "2020:06:15 10:30:00.000" }, { date: "2020:06:15 10:30:00.000" })).toEqual({});
    });

    test("an offset known from elsewhere is kept in Immich's field, which Darktable doesn't drop", () => {
      expect(planWrite({ date: "2020:06:15 10:30:00.000" }, { date: "2020:06:15 10:30:00.000", offset: "-05:00" })).toEqual({
        [TAGS.date]: "2020:06:15 10:30:00.000-05:00",
        [TAGS.immichDate]: "2020:06:15 10:30:00.000-05:00",
      });
      // The sidecar's own offset comes first.
      expect(planWrite(immichFields, { date: "2020:06:15 10:30:00", offset: "-05:00" })).toEqual({});
    });

    test("without any offset, only Darktable's field", () => {
      expect(planWrite({ date: "2020:06:15 10:30:00" }, { date: "2020:06:15 11:00:00" })).toEqual({ [TAGS.date]: "2020:06:15 11:00:00" });
    });

    test("a new zone from Immich replaces the old one in both", () => {
      expect(planWrite(immichFields, { date: "2020:06:15 10:30:00.000-05:00" })).toEqual({
        [TAGS.date]: "2020:06:15 10:30:00.000-05:00",
        [TAGS.immichDate]: "2020:06:15 10:30:00.000-05:00",
      });
    });

    test("removing the date removes both", () => {
      expect(planWrite(immichFields, { date: null })).toEqual({ [TAGS.date]: null, [TAGS.immichDate]: null });
    });

    test("after any of these, both tools show the same wall time", () => {
      const cases: [XmpFields, string, string | undefined][] = [
        [{ ...immichFields, date: "2020:06:15 11:00:00.000" }, "2020:06:15 11:00:00.000", undefined],
        [{ date: "2020:06:15 10:30:00.000" }, "2020:06:15 10:30:00.000", "-05:00"],
        [immichFields, "2021:01:01 09:00:00", undefined],
      ];
      for (const [fields, date, offset] of cases) {
        const plan = planWrite(fields, { date, offset });
        const after: XmpFields = { ...fields };
        if (TAGS.date in plan) after.date = plan[TAGS.date] as string;
        if (TAGS.immichDate in plan) after.immichDate = plan[TAGS.immichDate] as string;
        expect(sameDate(darktableReads(after).date, immichReads(after).date)).toBe(true);
      }
    });
  });

  test("an Immich asset's offset, from its local and UTC times", () => {
    const asset = { localDateTime: "2021-06-15T10:20:30.000Z", fileCreatedAt: "2021-06-15T08:20:30.000Z", timeZone: "Europe/Paris" };
    expect(offsetFromImmich(asset)).toBe("+02:00");
    expect(offsetFromImmich({ ...asset, fileCreatedAt: "2021-06-15T15:50:30.000Z", timeZone: "UTC-5:30" })).toBe("-05:30");
    expect(offsetFromImmich({ ...asset, timeZone: null })).toBeUndefined();
    expect(dateFromImmich(asset)).toBe("2021:06:15 10:20:30.000+02:00");
    expect(dateFromImmich({ ...asset, timeZone: null })).toBe("2021:06:15 10:20:30.000");
  });

  test("GPS is written as a pair, and removed", () => {
    expect(planWrite({ latitude: 12.5, longitude: -3.25 }, { gps: { latitude: 12.5, longitude: -3.3 } })).toEqual({
      [TAGS.latitude]: 12.5,
      [TAGS.longitude]: -3.3,
    });
    expect(planWrite({ latitude: 12.5, longitude: -3.25 }, { gps: null })).toEqual({ [TAGS.latitude]: null, [TAGS.longitude]: null });
    expect(planWrite({}, { gps: null })).toEqual({});
  });

  test("accounts: only those with something to record, defaults left out, in a stable order", () => {
    const plan = planWrite(
      {},
      {
        accounts: [
          { user: "u2", favorite: false, visibility: "timeline", albums: [{ id: "b", name: "B" }, { id: "a", name: "A, too" }] },
          { user: "u3", favorite: false, visibility: "timeline", albums: [] },
          { user: "u1", favorite: true, visibility: "archive", albums: [] },
        ],
      },
    );
    expect(plan).toEqual({
      [TAGS.accounts]: [
        { User: "u1", Favorite: "True", Visibility: "archive" },
        { User: "u2", Albums: [{ Id: "a", Name: "A, too" }, { Id: "b", Name: "B" }] },
      ],
    });
    // Read back, it's the same state.
    const read = parseXmp({ [TAGS.accounts]: plan[TAGS.accounts] });
    expect(planWrite(read, { accounts: read.accounts! })).toEqual({});
  });

  test("accounts with nothing left to record remove the field", () => {
    const fields = parseXmp({ [TAGS.accounts]: [{ User: "u1", Favorite: "True" }] });
    expect(planWrite(fields, { accounts: [{ user: "u1", favorite: false, visibility: "timeline", albums: [] }] })).toEqual({ [TAGS.accounts]: null });
  });

  test("regions: unchanged as read, rewritten whole when one changes, keeping what each held", () => {
    const point = { Area: { X: "0.1", Y: "0.2", Unit: "normalized" }, Type: "Focus" };
    const face = { Area: { X: "0.25", Y: "0.5", W: "0.2", H: "0.3", Unit: "normalized" }, Type: "Face", Name: "Robin Example", Rotation: "0" };
    const fields = parseXmp({ [TAGS.regions]: { AppliedToDimensions: { W: "96", H: "64", Unit: "pixel" }, RegionList: [face, point] } });
    expect(planWrite(fields, { regions: fields.regions! })).toEqual({});

    const renamed = { ...fields.regions!, regions: [{ ...fields.regions!.regions[0]!, name: "Sam Example" }, fields.regions!.regions[1]!] };
    expect(planWrite(fields, { regions: renamed })).toEqual({
      [TAGS.regions]: {
        AppliedToDimensions: { W: 96, H: 64, Unit: "pixel" },
        RegionList: [
          { Area: { X: 0.25, Y: 0.5, W: 0.2, H: 0.3, Unit: "normalized" }, Type: "Face", Name: "Sam Example", Rotation: "0" },
          { Area: { X: "0.1", Y: "0.2", Unit: "normalized" }, Type: "Focus" },
        ],
      },
    });
    expect(planWrite(fields, { regions: null })).toEqual({ [TAGS.regions]: null });
    expect(planWrite({}, { regions: { width: 1, height: 1, regions: [] } })).toEqual({});
  });
});
