import { beforeAll, expect, test } from "bun:test";
import { IMMICH_URL, type IndexedLibrary, USERS, describeImmich, indexedLibrary } from "../../test/immich/harness.ts";
import { type ImmichClient, login } from "./client.ts";
import { createFace, deleteFace, getFaces, reassignFace } from "./faces.ts";
import { createPerson } from "./people.ts";

describeImmich("faces, against Immich", () => {
  let client: ImmichClient;
  let library: IndexedLibrary;
  beforeAll(async () => {
    const admin = await login(IMMICH_URL, USERS.alex.email, USERS.alex.password);
    const sam = await login(IMMICH_URL, USERS.sam.email, USERS.sam.password);
    client = sam.client;
    library = await indexedLibrary("faces", admin, sam, ["a.jpg"]);
  });

  test("a face is added by hand, reassigned, and deleted", async () => {
    const assetId = library.assets["a.jpg"]!.id;
    const [robin, casey] = [await createPerson(client, "Robin Example"), await createPerson(client, "Casey Example")];
    await createFace(client, { assetId, personId: robin.id, imageWidth: 96, imageHeight: 64, x: 10, y: 8, width: 30, height: 20 });

    const [face] = await getFaces(client, assetId);
    expect(face).toMatchObject({ boundingBoxX1: 10, boundingBoxY1: 8, boundingBoxX2: 40, boundingBoxY2: 28, sourceType: "manual" });
    expect(face!.person?.id).toBe(robin.id);

    expect((await reassignFace(client, face!.id, casey.id)).id).toBe(casey.id);
    expect((await getFaces(client, assetId)).map((found) => found.person?.name)).toEqual(["Casey Example"]);

    await deleteFace(client, face!.id);
    expect(await getFaces(client, assetId)).toEqual([]);
  });
});
