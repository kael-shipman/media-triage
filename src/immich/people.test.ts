import { expect, test } from "bun:test";
import { IMMICH_URL, USERS, describeImmich, indexedLibrary } from "../../test/immich/harness.ts";
import { ImmichError, login } from "./client.ts";
import { createFace } from "./faces.ts";
import { createPerson, listPeople, renamePeople, shareAllPeople } from "./people.ts";

describeImmich("people, against Immich", () => {
  test("people with faces are listed, and renamed in bulk; people without faces aren't listed", async () => {
    const admin = await login(IMMICH_URL, USERS.alex.email, USERS.alex.password);
    const sam = await login(IMMICH_URL, USERS.sam.email, USERS.sam.password);
    const library = await indexedLibrary("people", admin, sam, ["a.jpg"]);
    const [jordan, quinn, faceless] = [
      await createPerson(sam.client, "Jordan Example"),
      await createPerson(sam.client, "Quinn Example"),
      await createPerson(sam.client, "Faceless Example"),
    ];
    for (const [person, x] of [[jordan, 0], [quinn, 50]] as const) {
      await createFace(sam.client, { assetId: library.assets["a.jpg"]!.id, personId: person.id, imageWidth: 96, imageHeight: 64, x, y: 0, width: 40, height: 40 });
    }
    expect(await renamePeople(sam.client, [{ id: jordan.id, name: "Jordan B. Example" }, { id: quinn.id, name: "Quinn B. Example" }])).toEqual([]);
    const names = new Map((await listPeople(sam.client)).map((person) => [person.id, person.name]));
    expect(names.get(jordan.id)).toBe("Jordan B. Example");
    expect(names.get(quinn.id)).toBe("Quinn B. Example");
    expect(names.has(faceless.id)).toBe(false);
  });

  test("sharing people needs the accounts in one cluster group", async () => {
    const sam = await login(IMMICH_URL, USERS.sam.email, USERS.sam.password);
    const alex = await login(IMMICH_URL, USERS.alex.email, USERS.alex.password);
    const error = await shareAllPeople(sam.client, [alex.userId]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ImmichError);
    expect((error as ImmichError).message).toContain("All users must be in the same cluster group");
  });
});
