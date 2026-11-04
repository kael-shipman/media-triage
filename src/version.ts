// Set at build time by scripts/build.ts (`--define`). Running from source, it's undefined.
declare const MEDIA_TRIAGE_VERSION: string;

/** This build's version: a release's, or "0.0.0-dev" when running from source. */
export const VERSION: string = typeof MEDIA_TRIAGE_VERSION !== "undefined" ? MEDIA_TRIAGE_VERSION : "0.0.0-dev";

/** True in an executable made by `bun build --compile`, whose entry point lives in Bun's embedded file system. */
export const IS_COMPILED: boolean = Bun.main.startsWith("/$bunfs/");
