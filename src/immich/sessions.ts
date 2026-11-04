// Session files: one per account, `<state>/sessions/<account>`, readable only by their owner (DESIGN.md, section 4).

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Session {
  /** The session token. A credential: it never goes in logs. */
  token: string;
  /** The Immich user it belongs to. */
  userId: string;
  email: string;
  /** When it was made, as an ISO date. */
  created: string;
}

export class SessionError extends Error {}

export function sessionsDir(stateDir: string): string {
  return join(stateDir, "sessions");
}

export function sessionFile(stateDir: string, account: string): string {
  return join(sessionsDir(stateDir), account);
}

/** Writes an account's session, replacing any earlier one. The file is never readable by others, even briefly. */
export function saveSession(stateDir: string, account: string, session: Session): void {
  const dir = sessionsDir(stateDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = sessionFile(stateDir, account);
  const temporary = `${file}.new`;
  rmSync(temporary, { force: true });
  writeFileSync(temporary, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, file);
}

/** An account's session, or undefined if it has none. Refuses a file that others can read. */
export function loadSession(stateDir: string, account: string): Session | undefined {
  const file = sessionFile(stateDir, account);
  if (!existsSync(file)) return undefined;
  const mode = statSync(file).mode & 0o777;
  if (mode & 0o077) {
    throw new SessionError(`${file} can be read by others (mode ${mode.toString(8)}). It's a credential: run \`chmod 600 ${file}\`.`);
  }
  let session: Partial<Session>;
  try {
    session = JSON.parse(readFileSync(file, "utf8")) as Partial<Session>;
  } catch {
    throw new SessionError(`${file} isn't a session file. Log in again with \`media-triage login ${account}\`.`);
  }
  if (typeof session.token !== "string" || typeof session.userId !== "string" || typeof session.email !== "string") {
    throw new SessionError(`${file} isn't a session file. Log in again with \`media-triage login ${account}\`.`);
  }
  return { token: session.token, userId: session.userId, email: session.email, created: session.created ?? "" };
}

export function removeSession(stateDir: string, account: string): void {
  rmSync(sessionFile(stateDir, account), { force: true });
}
