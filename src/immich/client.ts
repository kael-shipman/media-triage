// One account's connection to Immich, through upstream's SDK (DESIGN.md, sections 4 and 10).
//
// The SDK keeps one global token, but the daemon talks as several accounts at once, so every call gets its own
// options from an ImmichClient instead.

import { getMyUser, isHttpError, login as sdkLogin, logout as sdkLogout, type UserAdminResponseDto } from "@immich/sdk";
import { hostname } from "node:os";
import { VERSION } from "../version.ts";

/** The SDK's per-call options. */
export type RequestOpts = NonNullable<Parameters<typeof getMyUser>[0]>;

/** A failed call to Immich. `status` is the HTTP status, or 0 when the server couldn't be reached. */
export class ImmichError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Sent with every request. Immich shows a session under the account's "Authorized devices" by these, and rewrites them
 * from each request's headers about once an hour (`auth.service.ts`, `validateSession`), so login alone isn't enough.
 */
function deviceHeaders(): Record<string, string> {
  return { "user-agent": `media-triage/${VERSION}`, devicemodel: "media-triage", devicetype: hostname() };
}

/** Turns what the SDK or fetch threw into an ImmichError that says what was being done. */
export function toImmichError(error: unknown, what: string, url: string): ImmichError {
  if (error instanceof ImmichError) return error;
  if (isHttpError(error)) {
    const detail = error.data?.message ?? error.message;
    return new ImmichError(`${what}: Immich answered ${error.status}: ${Array.isArray(detail) ? detail.join("; ") : detail}`, error.status);
  }
  return new ImmichError(`${what}: couldn't reach Immich at ${url}: ${(error as Error).message}`, 0);
}

/** One account's session on one Immich server. */
export class ImmichClient {
  /**
   * @param url the server, without `/api`
   * @param token a session token (DESIGN.md, section 4)
   */
  constructor(
    readonly url: string,
    private readonly token: string,
  ) {}

  /** The API's base URL. */
  get apiUrl(): string {
    return `${this.url}/api`;
  }

  /** Headers for a request made without the SDK (the sync stream). */
  headers(): Record<string, string> {
    return { ...deviceHeaders(), authorization: `Bearer ${this.token}` };
  }

  /** Options for an SDK call as this account. */
  opts(): RequestOpts {
    return { baseUrl: this.apiUrl, headers: this.headers() };
  }

  /** Runs an SDK call as this account. Its errors become ImmichErrors that start with `what`. */
  async call<T>(what: string, request: (opts: RequestOpts) => Promise<T>): Promise<T> {
    try {
      return await request(this.opts());
    } catch (error) {
      throw toImmichError(error, what, this.url);
    }
  }

  /** The account this session belongs to. */
  me(): Promise<UserAdminResponseDto> {
    return this.call("Reading the account", (opts) => getMyUser(opts));
  }

  /** Ends the session. It disappears from the account's "Authorized devices". */
  async logout(): Promise<void> {
    await this.call("Logging out", (opts) => sdkLogout(opts));
  }
}

export interface LoginResult {
  client: ImmichClient;
  token: string;
  userId: string;
  email: string;
  name: string;
  isAdmin: boolean;
}

/** Logs in with an email and password, and returns the new session (`POST /api/auth/login`). */
export async function login(url: string, email: string, password: string): Promise<LoginResult> {
  let response;
  try {
    response = await sdkLogin({ loginCredentialDto: { email, password } }, { baseUrl: `${url}/api`, headers: deviceHeaders() });
  } catch (error) {
    if (isHttpError(error) && error.status === 401) throw new ImmichError(`Logging in as ${email}: wrong email or password`, 401);
    throw toImmichError(error, `Logging in as ${email}`, url);
  }
  return {
    client: new ImmichClient(url, response.accessToken),
    token: response.accessToken,
    userId: response.userId,
    email: response.userEmail,
    name: response.name,
    isAdmin: response.isAdmin,
  };
}
