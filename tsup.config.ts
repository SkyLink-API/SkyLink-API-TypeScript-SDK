import { defineConfig } from "tsup";

export default defineConfig({
  // The root barrel plus one entry per helper module, so `skylink-api/units` and
  // friends resolve to their own tree-shakeable bundle instead of the whole SDK.
  // The map form (not an array) keeps the helper bundles at `dist/units.js`
  // rather than `dist/helpers/units.js`, matching the `exports` map.
  entry: {
    index: "src/index.ts",
    units: "src/helpers/units.ts",
    spatial: "src/helpers/spatial.ts",
    idents: "src/helpers/idents.ts",
    weather: "src/helpers/weather.ts",
    geojson: "src/helpers/geojson.ts",
    sentinels: "src/helpers/sentinels.ts",
    batch: "src/helpers/batch.ts",
    cache: "src/helpers/cache.ts",
    csv: "src/helpers/csv.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node18",
  treeshake: true,
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".js" };
  },
});
