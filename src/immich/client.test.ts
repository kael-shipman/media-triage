import { expect, test } from "bun:test";
import { hostname } from "node:os";
import { IMMICH_URL, USERS, api, describeImmich } from "../../test/immich/harness.ts";
import { ImmichError, login } from "./client.ts";

test("an unreachable server is an ImmichError with status 0", async () => {
  const error = await login("http://127.0.0.1:9", "alex@example.com", "x").catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ImmichError);
  expect((error as ImmichError).status).toBe(0);
  expect((error as ImmichError).message).toContain("couldn't reach Immich at http://127.0.0.1:9");
});

describeImmich("login and sessions", () => {
  test("logs in, and the session reads its own account", async () => {
    const session = await login(IMMICH_URL, USERS.alex.email, USERS.alex.password);
    expect(session).toMatchObject({ email: USERS.alex.email, name: USERS.alex.name, isAdmin: true });
    expect((await session.client.me()).id).toBe(session.userId);
  });

  test("the session shows as media-triage on this host in Authorized devices", async () => {
    const session = await login(IMMICH_URL, USERS.sam.email, USERS.sam.password);
    const sessions = await api<{ current: boolean; deviceType: string; deviceOS: string }[]>("GET", "/sessions", { token: session.token });
    expect(sessions.find((candidate) => candidate.current)).toMatchObject({ deviceType: "media-triage", deviceOS: hostname() });
  });

  test("a wrong password says so", async () => {
    const error = await login(IMMICH_URL, USERS.alex.email, "wrong").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ImmichError);
    expect(error).toMatchObject({ status: 401, message: `Logging in as ${USERS.alex.email}: wrong email or password` });
  });

  test("logging out ends the session", async () => {
    const session = await login(IMMICH_URL, USERS.sam.email, USERS.sam.password);
    await session.client.logout();
    const error = await session.client.me().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ImmichError);
    expect((error as ImmichError).status).toBe(401);
    expect((error as ImmichError).message).toStartWith("Reading the account: Immich answered 401");
  });
});
