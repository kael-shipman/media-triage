// Faces on an asset (`/api/faces`): read, and corrected by hand after filing (DESIGN.md, F10 and section 7).
//
// A person's ID in Immich 3.3's API is its person group's: the same ID in every account of a cluster group, where each
// account has its own record of the person (`mapPerson`, `id: person.personGroupId`).

import { type AssetFaceResponseDto, type PersonResponseDto, createFace as sdkCreateFace, deleteFace as sdkDeleteFace, getFaces as sdkGetFaces, reassignFacesById } from "@immich/sdk";
import type { ImmichClient } from "./client.ts";

export type Face = AssetFaceResponseDto;

/** A face to add by hand: a box in the image's pixels, as Immich measures the image. */
export interface NewFace {
  assetId: string;
  personId: string;
  imageWidth: number;
  imageHeight: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** An asset's visible faces, each with its person, if it has one (`GET /api/faces?id=<asset>`). Deleted faces aren't here. */
export function getFaces(client: ImmichClient, assetId: string): Promise<Face[]> {
  return client.call(`Reading the faces on asset ${assetId}`, (opts) => sdkGetFaces({ id: assetId }, opts));
}

/** Adds a face by hand (`POST /api/faces`). Immich doesn't return it: read the asset's faces to find it. */
export async function createFace(client: ImmichClient, face: NewFace): Promise<void> {
  await client.call(`Adding a face to asset ${face.assetId}`, (opts) => sdkCreateFace({ assetFaceCreateDto: face }, opts));
}

/**
 * Gives a face to another person. Mind the API's order: it's `PUT /api/faces/{person}`, with the face's ID in the body
 * (`person.service.ts`, `reassignFacesById`).
 */
export function reassignFace(client: ImmichClient, faceId: string, personId: string): Promise<PersonResponseDto> {
  return client.call(`Reassigning face ${faceId}`, (opts) => reassignFacesById({ id: personId, faceDto: { id: faceId } }, opts));
}

/**
 * Deletes a face (`DELETE /api/faces/{id}`). By default it's a soft delete, as in Immich's own interface: the face is
 * kept as deleted, so detection doesn't bring it back, and `AssetFacesV3` reports it with `deletedAt`.
 */
export async function deleteFace(client: ImmichClient, faceId: string, options: { force?: boolean } = {}): Promise<void> {
  await client.call(`Deleting face ${faceId}`, (opts) => sdkDeleteFace({ id: faceId, assetFaceDeleteDto: { force: options.force ?? false } }, opts));
}
