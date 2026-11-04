import { expect, test } from "bun:test";
import { IMMICH_URL, USERS, describeImmich, indexedLibrary, newUser } from "../../test/immich/harness.ts";
import { login } from "./client.ts";
import { acceptClusterGroupInvitation, clusterGroupInvitations, clusterGroupMembers, clusterGroupOf, inviteToClusterGroup } from "./cluster-groups.ts";
import { createFace } from "./faces.ts";
import { createPerson, listPeople, listPeopleShares, shareAllPeople } from "./people.ts";

describeImmich("cluster groups and shared people, against Immich", () => {
  test("an invited account joins with its own session, keeps its named people, and can then share them", async () => {
    const admin = await login(IMMICH_URL, USERS.alex.email, USERS.alex.password);
    const [first, second] = await Promise.all([newUser(admin.token, "First"), newUser(admin.token, "Second")]);
    const one = await login(IMMICH_URL, first.email, first.password);
    const two = await login(IMMICH_URL, second.email, second.password);
    const [groupOne, groupTwo] = [await clusterGroupOf(one.client), await clusterGroupOf(two.client)];
    expect(groupOne).not.toBe(groupTwo);

    // The joining account already has a named person.
    const library = await indexedLibrary("cluster", admin, two, ["a.jpg"]);
    const robin = await createPerson(two.client, "Robin Example");
    await createFace(two.client, { assetId: library.assets["a.jpg"]!.id, personId: robin.id, imageWidth: 96, imageHeight: 64, x: 0, y: 0, width: 40, height: 40 });

    // Sharing before joining is refused.
    await expect(shareAllPeople(two.client, [one.userId])).rejects.toThrow("All users must be in the same cluster group");

    const request = await inviteToClusterGroup(one.client, groupOne, two.userId);
    expect((await inviteToClusterGroup(one.client, groupOne, two.userId)).id).toBe(request.id);
    expect(await clusterGroupInvitations(two.client)).toMatchObject([{ id: request.id, clusterGroupId: groupOne, userId: two.userId }]);

    await acceptClusterGroupInvitation(two.client, request.id);
    expect(await clusterGroupOf(two.client)).toBe(groupOne);
    expect((await clusterGroupMembers(one.client, groupOne)).map((user) => user.id).sort()).toEqual([one.userId, two.userId].sort());
    expect(await clusterGroupInvitations(two.client)).toEqual([]);
    expect((await listPeople(two.client)).find((person) => person.id === robin.id)?.name).toBe("Robin Example");

    await shareAllPeople(two.client, [one.userId]);
    expect(await listPeopleShares(two.client)).toContainEqual(
      expect.objectContaining({ personId: robin.id, sharedById: two.userId, sharedWithId: one.userId, role: "write" }),
    );
  });
});
