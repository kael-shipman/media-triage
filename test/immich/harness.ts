// What the integration tests share with test/immich/dev.ts: where the development Immich is, and its users.
//
// Tests that need it are skipped unless MEDIA_TRIAGE_IMMICH_TESTS=1:
//
//   bun test/immich/dev.ts up
//   MEDIA_TRIAGE_IMMICH_TESTS=1 bun test
//   bun test/immich/dev.ts down

import { describe } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { join, relative } from "node:path";
import { type Config, parseConfig } from "../../src/config.ts";

export const IMMICH_TESTS = process.env.MEDIA_TRIAGE_IMMICH_TESTS === "1";

/** `describe`, skipped unless the development Immich's tests are on. */
export const describeImmich = describe.skipIf(!IMMICH_TESTS);

export const PORT = Number(process.env.MEDIA_TRIAGE_IMMICH_PORT || 2284);
export const IMMICH_URL = `http://127.0.0.1:${PORT}`;

/** The folder holding the server's uploads and the media folder. */
export const DATA_DIR = process.env.MEDIA_TRIAGE_DATA || join(import.meta.dir, ".data");
/** The media folder, as this machine sees it… */
export const MEDIA_DIR = join(DATA_DIR, "media");
/** …and as Immich sees it. */
export const IMMICH_MEDIA = "/mnt/media";

export interface TestUser {
  name: string;
  email: string;
  password: string;
  admin: boolean;
}

/** Made-up users. The first is the admin. */
export const USERS = {
  alex: { name: "Alex Example", email: "alex@example.com", password: "alex-test-password", admin: true },
  sam: { name: "Sam Example", email: "sam@example.com", password: "sam-test-password", admin: false },
} as const satisfies Record<string, TestUser>;

/**
 * A fresh folder inside the media folder, for one test file's libraries. Returns it as this machine sees it and as
 * Immich does.
 */
export function mediaFolder(prefix: string): { local: string; immich: string } {
  mkdirSync(MEDIA_DIR, { recursive: true });
  const local = mkdtempSync(join(MEDIA_DIR, `${prefix}-`));
  return { local, immich: `${IMMICH_MEDIA}/${relative(MEDIA_DIR, local)}` };
}

/** A request to the development Immich's API, without the SDK, for setting things up in tests. */
export async function api<T>(method: string, path: string, options: { token?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${IMMICH_URL}/api${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

export const login = (user: TestUser) =>
  api<{ accessToken: string; userId: string }>("POST", "/auth/login", { body: { email: user.email, password: user.password } });

/** Polls `check` until it returns something other than undefined, or fails after `timeoutMs`. */
export async function waitFor<T>(what: string, check: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result !== undefined) return result;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(250);
  }
}

/** The fixtures folder: small media files with made-up metadata. */
export const FIXTURES = join(import.meta.dir, "..", "fixtures");

/** A configuration for the development Immich, with both users as accounts, and the given state folder. */
export function testConfig(stateDir: string): Config {
  return parseConfig(
    {
      paths: { state: stateDir },
      immich: {
        url: IMMICH_URL,
        path_map: [{ immich: `${IMMICH_MEDIA}/`, local: `${MEDIA_DIR}/` }],
        accounts: Object.entries(USERS).map(([name, user]) => ({ name, email: user.email, admin: user.admin })),
      },
    },
    null,
  );
}

export interface IndexedLibrary {
  libraryId: string;
  folder: { local: string; immich: string };
  /** The library's assets by file name. */
  assets: Record<string, { id: string; originalPath: string }>;
}

/**
 * A new library owned by `owner`, over a fresh media folder holding a copy of the fixture photo under each name,
 * scanned and indexed. Libraries are made with the admin's session; only the owner's session sees the assets.
 */
export async function indexedLibrary(
  prefix: string,
  admin: { token: string },
  owner: { token: string; userId: string },
  names: string[],
): Promise<IndexedLibrary> {
  const folder = mediaFolder(prefix);
  for (const name of names) copyFileSync(join(FIXTURES, "photo.jpg"), join(folder.local, name));
  const { id: libraryId } = await api<{ id: string }>("POST", "/libraries", {
    token: admin.token,
    body: { ownerId: owner.userId, name: prefix, importPaths: [folder.immich], exclusionPatterns: [] },
  });
  await api("POST", `/libraries/${libraryId}/scan`, { token: admin.token });
  type Found = { id: string; originalPath: string; originalFileName: string; exifInfo?: { dateTimeOriginal?: string } };
  const assets = await waitFor(`the scan of ${prefix}`, async () => {
    const { assets } = await api<{ assets: { items: Found[] } }>("POST", "/search/metadata", {
      token: owner.token,
      body: { filter: { libraryId: { eq: libraryId } }, withExif: true, size: 1000 },
    });
    const indexed = assets.items.length === names.length && assets.items.every((asset) => asset.exifInfo?.dateTimeOriginal);
    return indexed ? assets.items : undefined;
  });
  return { libraryId, folder, assets: Object.fromEntries(assets.map((asset) => [asset.originalFileName, { id: asset.id, originalPath: asset.originalPath }])) };
}

/**
 * A new user, made by the admin with a unique made-up email, for tests that change an account for good (such as
 * joining a cluster group), so that no other test depends on the order they run in.
 */
export async function newUser(adminToken: string, label: string): Promise<TestUser> {
  const unique = `${label}-${crypto.randomUUID().slice(0, 8)}`;
  const user: TestUser = { name: `${label} Example`, email: `${unique}@example.com`, password: `${unique}-password`, admin: false };
  await api("POST", "/admin/users", { token: adminToken, body: { email: user.email, password: user.password, name: user.name } });
  return user;
}
