// Builds public/data/cities.json, the list the city picker searches (D46).
// Source: the city-timezones npm package (MIT; city data from simplemaps.com
// World Cities Basic, CC BY 4.0). Run: npm run build:cities
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const raw = JSON.parse(readFileSync(require.resolve("city-timezones/data/cityMap.json"), "utf8"));

const valid = (tz) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const zones = [];
const zoneIndex = new Map();
const seen = new Set();
const rows = [];
for (const c of [...raw].sort((a, b) => (b.pop ?? 0) - (a.pop ?? 0))) {
  if (!c.city || !c.timezone || !valid(c.timezone)) continue;
  const key = `${c.city}|${c.province}|${c.iso2}`.toLowerCase();
  if (seen.has(key)) continue;
  seen.add(key);
  if (!zoneIndex.has(c.timezone)) {
    zoneIndex.set(c.timezone, zones.length);
    zones.push(c.timezone);
  }
  // [name, ascii name (only when different), province, country, zone index]
  rows.push([c.city, c.city_ascii && c.city_ascii !== c.city ? c.city_ascii : "", c.province ?? "", c.country ?? "", zoneIndex.get(c.timezone)]);
}

mkdirSync("public/data", { recursive: true });
const out = JSON.stringify({ source: "city-timezones 1.3.4 (MIT); simplemaps.com World Cities Basic (CC BY 4.0)", zones, cities: rows });
writeFileSync("public/data/cities.json", out);
console.log(`${rows.length} cities, ${zones.length} time zones, ${(out.length / 1024).toFixed(0)} KB`);
