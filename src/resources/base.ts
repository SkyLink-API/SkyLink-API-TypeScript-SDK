/**
 * Base class every resource namespace extends.
 *
 * A resource owns no state beyond a reference to its client: it turns typed
 * arguments into a {@link RequestSpec} and hands it to `client.request()`, which
 * performs auth, retries, error mapping and body decoding.
 */

import type { SkyLink } from "../client.js";
import { SkyLinkError } from "../core/errors.js";
import type { QueryParams, RequestOptions, RequestSpec } from "../core/types.js";

/**
 * Escape a value for interpolation into a request path.
 *
 * Path segments such as ICAO codes, registrations and flight numbers come from
 * user input, so they are trimmed and percent-encoded. An empty segment would
 * silently change the endpoint being called, so it is rejected up front.
 *
 * @param value - Raw segment value.
 * @param name - Parameter name, used in the error message.
 * @throws {SkyLinkError} When the value is empty or whitespace only.
 */
export function encodePathParam(value: string | number, name = "path parameter"): string {
  const raw = typeof value === "number" ? String(value) : value.trim();
  if (raw === "") {
    throw new SkyLinkError(`Missing ${name}: expected a non-empty value.`);
  }
  return encodeURIComponent(raw);
}

/** Shared behaviour of the resource namespaces hanging off {@link SkyLink}. */
export abstract class APIResource {
  /** The client this resource issues its requests through. */
  protected readonly client: SkyLink;

  constructor(client: SkyLink) {
    this.client = client;
  }

  /**
   * Issue an arbitrary request through the owning client.
   *
   * Resolves to the decoded body; the transport envelope (raw `Response`, quota
   * headers) stays internal.
   */
  protected request<T>(spec: RequestSpec, options?: RequestOptions): Promise<T> {
    return this.client.request<T>(spec, options);
  }

  /**
   * Shorthand for the GET requests that make up nearly the whole API surface.
   *
   * `undefined`/`null` query entries are dropped during serialization, so optional
   * parameters can be forwarded unconditionally.
   */
  protected get<T>(path: string, query?: QueryParams, options?: RequestOptions): Promise<T> {
    return this.request<T>({ method: "GET", path, query }, options);
  }
}
