import { BulkIdErrorReason } from "@immich/sdk";
import { expect, test } from "bun:test";
import { failures } from "./bulk.ts";

test("failures lists what failed, except the reasons that mean it was already so", () => {
  const results = [
    { id: "a", success: true },
    { id: "b", success: false, error: BulkIdErrorReason.Duplicate },
    { id: "c", success: false, error: BulkIdErrorReason.NoPermission },
    { id: "d", success: false, error: BulkIdErrorReason.Validation, errorMessage: "bad" },
  ];
  expect(failures(results, [BulkIdErrorReason.Duplicate])).toEqual([
    { id: "c", reason: "no_permission" },
    { id: "d", reason: "bad" },
  ]);
  expect(failures(results).map((failure) => failure.id)).toEqual(["b", "c", "d"]);
});
