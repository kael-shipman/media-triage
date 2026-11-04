// Starts and stops the development Immich that the integration tests use (compose.yml beside this file).
//
//   bun test/immich/dev.ts up      start it, and create its users (safe to repeat)
//   bun test/immich/dev.ts down    stop it, and delete its data
//
// It listens on 127.0.0.1:2284 (MEDIA_TRIAGE_IMMICH_PORT), and keeps its files in test/immich/.data
// (MEDIA_TRIAGE_DATA). IMMICH_VERSION picks the server image's tag.
import { $ } from "bun";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, IMMICH_URL, PORT, USERS, api, login } from "./harness.ts";

const compose = ["docker", "compose", "--file", join(import.meta.dir, "compose.yml")];
const env = {
  ...process.env,
  MEDIA_TRIAGE_UID: String(process.getuid?.() ?? 1000),
  MEDIA_TRIAGE_GID: String(process.getgid?.() ?? 1000),
  MEDIA_TRIAGE_DATA: DATA_DIR,
  MEDIA_TRIAGE_IMMICH_PORT: String(PORT),
};

async function waitForServer(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const { res } = await api<{ res: string }>("GET", "/server/ping");
      if (res === "pong") return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`Immich didn't answer at ${IMMICH_URL} within ${timeoutMs / 1000}s`);
    await Bun.sleep(1000);
  }
}

async function setUp(): Promise<void> {
  const [admin, ...others] = Object.values(USERS);
  const { isInitialized } = await api<{ isInitialized: boolean }>("GET", "/server/config");
  if (!isInitialized) {
    await api("POST", "/auth/admin-sign-up", { body: { email: admin!.email, password: admin!.password, name: admin!.name } });
  }
  const { accessToken: token } = await login(admin!);

  const existing = await api<{ email: string }[]>("GET", "/admin/users", { token });
  for (const user of others) {
    if (existing.some((candidate) => candidate.email === user.email)) continue;
    await api("POST", "/admin/users", { token, body: { email: user.email, password: user.password, name: user.name } });
  }
  for (const user of others) await login(user);

  // No machine-learning container runs, and the version check would call GitHub.
  const config = await api<Record<string, { enabled: boolean }>>("GET", "/system-config", { token });
  config.machineLearning!.enabled = false;
  config.newVersionCheck!.enabled = false;
  await api("PUT", "/system-config", { token, body: config });
}

const command = process.argv[2];
switch (command) {
  case "up": {
    mkdirSync(join(DATA_DIR, "upload"), { recursive: true });
    mkdirSync(join(DATA_DIR, "media"), { recursive: true });
    await $`${compose} up --detach --wait --wait-timeout 300`.env(env);
    await waitForServer(120_000);
    await setUp();
    console.log(`Immich is up at ${IMMICH_URL}, with ${Object.values(USERS).map((user) => user.email).join(" and ")}.`);
    console.log("Run the integration tests with: MEDIA_TRIAGE_IMMICH_TESTS=1 bun test");
    break;
  }
  case "down":
    await $`${compose} down --volumes --remove-orphans`.env(env);
    rmSync(DATA_DIR, { recursive: true, force: true });
    break;
  default:
    console.error("Usage: bun test/immich/dev.ts up|down");
    process.exit(2);
}
