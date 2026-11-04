import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMMICH_URL, USERS, describeImmich, testConfig } from "../../test/immich/harness.ts";
import { ConfigError } from "../config.ts";
import { ImmichClient, ImmichError } from "./client.ts";
import { findAccount, loginAccount } from "./login.ts";
import { loadSession, sessionFile } from "./sessions.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "media-triage-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("an unknown account lists the configured ones", () => {
  expect(() => findAccount(testConfig(dir), "jo")).toThrow(ConfigError);
  expect(() => findAccount(testConfig(dir), "jo")).toThrow('There\'s no account named "jo". The accounts are: alex, sam.');
});

/** Runs the command line from source, with `input` on stdin. */
async function run(input: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "..", "main.ts"), ...args], {
    stdin: new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, JOURNAL_STREAM: "" },
  });
  const [status, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { status, out, err };
}

describeImmich("media-triage login", () => {
  test("saves a working session, and a second login ends the first", async () => {
    const config = testConfig(dir);
    const first = await loginAccount(config, "sam", USERS.sam.password);
    expect(first).toMatchObject({ name: USERS.sam.name, replaced: false, file: sessionFile(dir, "sam") });
    const firstToken = loadSession(dir, "sam")!.token;
    expect((await new ImmichClient(IMMICH_URL, firstToken).me()).email).toBe(USERS.sam.email);

    expect((await loginAccount(config, "sam", USERS.sam.password)).replaced).toBe(true);
    const secondToken = loadSession(dir, "sam")!.token;
    expect(secondToken).not.toBe(firstToken);
    expect((await new ImmichClient(IMMICH_URL, secondToken).me()).email).toBe(USERS.sam.email);
    const ended = await new ImmichClient(IMMICH_URL, firstToken).me().catch((caught: unknown) => caught);
    expect((ended as ImmichError).status).toBe(401);
  });

  test("the command reads the password from stdin, and keeps only the session, privately", async () => {
    const file = join(dir, "config.toml");
    const state = join(dir, "state");
    writeFileSync(
      file,
      `[paths]\nstate = "${state}"\n[immich]\nurl = "${IMMICH_URL}"\n` +
        `[[immich.accounts]]\nname = "alex"\nemail = "${USERS.alex.email}"\nadmin = true\n`,
    );
    const ok = await run(`${USERS.alex.password}\n`, "login", "alex", "--config", file);
    expect(ok.err).toBe("");
    expect(ok.status).toBe(0);
    expect(ok.out).toContain(`Logged in as ${USERS.alex.name} (${USERS.alex.email})`);
    expect(statSync(sessionFile(state, "alex")).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(loadSession(state, "alex"))).not.toContain(USERS.alex.password);

    const wrong = await run("nope\n", "login", "alex", "--config", file);
    expect(wrong.status).toBe(1);
    expect(wrong.err).toContain("wrong email or password");

    expect((await run("", "login", "alex", "--config", file)).err).toContain("No password given");
    expect((await run("", "login", "--config", file)).status).toBe(2);
  });
});
