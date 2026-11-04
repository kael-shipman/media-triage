// Cluster groups (Immich 3.2): accounts whose faces are clustered into the same people (DESIGN.md, section 8).
//
// Every account starts in a group of its own. Another group's member invites it, and it accepts with its own session.
// Joining keeps its people and their names (`cluster-group.service.ts`, `acceptRequest`). The group's "reset facial
// recognition" (`regenerate-people`) deletes every person and name in the group, so it isn't wrapped here.

import {
  type ClusterGroupRequestResponseDto,
  type UserResponseDto,
  acceptClusterGroupRequest,
  createClusterGroupRequest,
  getClusterGroupRequests,
  getClusterGroupUsers,
} from "@immich/sdk";
import type { ImmichClient } from "./client.ts";

export type ClusterGroupRequest = ClusterGroupRequestResponseDto;

/** The account's cluster group. */
export async function clusterGroupOf(client: ImmichClient): Promise<string> {
  return (await client.me()).clusterGroupId;
}

/** The group's members, as one of them sees it. */
export function clusterGroupMembers(client: ImmichClient, groupId: string): Promise<UserResponseDto[]> {
  return client.call("Listing the cluster group's members", (opts) => getClusterGroupUsers({ id: groupId }, opts));
}

/** Invites an account into the group, as one of its members. Inviting it again is fine: it's the same request. */
export function inviteToClusterGroup(client: ImmichClient, groupId: string, userId: string): Promise<ClusterGroupRequest> {
  return client.call("Inviting an account into the cluster group", (opts) =>
    createClusterGroupRequest({ id: groupId, clusterGroupRequestCreateDto: { userId } }, opts),
  );
}

/** The invitations waiting for this account. */
export function clusterGroupInvitations(client: ImmichClient): Promise<ClusterGroupRequest[]> {
  return client.call("Listing cluster group invitations", (opts) => getClusterGroupRequests(opts));
}

/** Accepts an invitation, with the invited account's own session. Its people move into the group, names and all. */
export async function acceptClusterGroupInvitation(client: ImmichClient, requestId: string): Promise<void> {
  await client.call("Joining the cluster group", (opts) => acceptClusterGroupRequest({ id: requestId }, opts));
}
