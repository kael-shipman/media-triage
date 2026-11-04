// Builds one executable per platform into dist/, with SHA256SUMS beside them.
//
//   bun scripts/build.ts [version]
//
// The version defaults to package.json's. A leading "v" is dropped, so a tag like v1.2.3 can be passed as it is.
// TARGETS=linux-x64 limits the platforms.
import { $ } from "bun";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseVersion } from "../src/semver.ts";

const root = join(import.meta.dir, "..");
const packageVersion = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
const version = parseVersion(process.argv[2] ?? packageVersion);
if (!version) throw new Error(`"${process.argv[2]}" isn't a version like 1.2.3 or v1.2.3-rc.1`);
const targets = process.env.TARGETS?.split(",") ?? ["linux-x64", "linux-arm64"];

const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);

const sums: string[] = [];
for (const target of targets) {
  const name = `media-triage-${target}`;
  const outfile = join(dist, name);
  console.log(`Building ${name} ${version.text}`);
  await $`${process.execPath} build ${join(root, "src/main.ts")} --compile --minify --target=bun-${target} --outfile ${outfile} --define ${`MEDIA_TRIAGE_VERSION=${JSON.stringify(version.text)}`}`.quiet();
  const hash = new Bun.CryptoHasher("sha256").update(await Bun.file(outfile).arrayBuffer()).digest("hex");
  sums.push(`${hash}  ${name}`);
}
writeFileSync(join(dist, "SHA256SUMS"), `${sums.join("\n")}\n`);
console.log(`Built ${targets.length} executable(s) into dist/`);
