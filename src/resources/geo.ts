/**
 * `sky.geo` — the ISO country and region reference data behind `iso_country`
 * and `iso_region`.
 *
 * ```ts
 * const { regions } = await sky.geo.regions({ country: "US" });
 * const california = await sky.geo.region("US-CA");
 * ```
 */

import type { RequestOptions } from "../core/types.js";
import type {
  CountriesParams,
  CountriesResponse,
  CountryDetail,
  RegionDetail,
  RegionsParams,
  RegionsResponse,
} from "../models/geo.js";
import { APIResource, encodePathParam } from "./base.js";

/** Country and region endpoints. */
export class Geo extends APIResource {
  /**
   * Every ISO country in the reference dataset, optionally narrowed to one continent.
   *
   * `GET /countries?continent`
   */
  countries(params: CountriesParams = {}, options?: RequestOptions): Promise<CountriesResponse> {
    return this.get("/countries", { continent: params.continent }, options);
  }

  /**
   * A single country by ISO 3166-1 alpha-2 code.
   *
   * The record comes back flat, not wrapped in a `country` key.
   *
   * `GET /countries/{code}`
   *
   * @param code - Two-letter country code, e.g. `"US"`.
   * @throws {NotFoundError} When the code is not in the dataset.
   */
  country(code: string, options?: RequestOptions): Promise<CountryDetail> {
    return this.get(`/countries/${encodePathParam(code, "code")}`, undefined, options);
  }

  /**
   * ISO regions (states, provinces, territories), optionally narrowed by country
   * and/or continent. Unfiltered it returns roughly 3 900 records.
   *
   * `GET /regions?country&continent`
   */
  regions(params: RegionsParams = {}, options?: RequestOptions): Promise<RegionsResponse> {
    return this.get(
      "/regions",
      {
        country: params.country,
        continent: params.continent,
      },
      options,
    );
  }

  /**
   * A single region by ISO 3166-2 code.
   *
   * The record comes back flat, not wrapped in a `region` key.
   *
   * `GET /regions/{code}`
   *
   * @param code - Region code, e.g. `"US-CA"` or `"GB-ENG"`.
   * @throws {NotFoundError} When the code is not in the dataset.
   */
  region(code: string, options?: RequestOptions): Promise<RegionDetail> {
    return this.get(`/regions/${encodePathParam(code, "code")}`, undefined, options);
  }
}
