# เลี่ยงน้ำท่วม กทม. (Bangkok flood-avoidance map)

แผนที่ถนนน้ำท่วมกรุงเทพฯ บน Google Maps พร้อมตำแหน่ง GPS แบบเรียลไทม์ แจ้งเตือนเมื่อเข้าใกล้ถนนน้ำท่วม
และส่งต่อการนำทางไปยัง Google Maps

A static site: `index.html` + `app.js` draw `data/flood.geojson` over Google Maps (with its traffic layer)
or, when no API key is set, over OpenStreetMap.

## Data

`data/flood.geojson` is extracted from a public Claude artifact that publishes Bangkok road-flood sensor
readings: https://claude.ai/artifact/N6umcENfSgoY6GMkhVKwZs

- Solid lines: roads where water-level sensors read flooding, colored by depth
  (dark red >15 cm, red 10–15 cm, orange 5–10 cm).
- Dashed purple lines: the list of roads reported as still flooded.

A scheduled Claude routine re-reads that artifact, runs the extractor, and commits `data/flood.geojson`
only when the data changed. Open pages re-check the file every 5 minutes.

To update by hand, save the artifact's HTML and run:

```bash
node scripts/extract.js artifact.html   # writes data/flood.geojson, prints "unchanged" if nothing changed
```

The extractor parses the artifact's `ROADS`, `GEO` and `REPORTS` blocks as JSON; it never executes the artifact's code.

## Google Maps key

Put a Google Maps JavaScript API key in `config.js` (`GOOGLE_MAPS_API_KEY`) and restrict it to this
site's domain in Google Cloud Console. Without a key the site uses OpenStreetMap.

## Hosting

GitHub Pages: Settings → Pages → Build and deployment → Deploy from a branch → the default branch, `/ (root)`.
GPS only works over `https`, which Pages provides.

## Limits

The data is only as fresh as the source artifact. Sensors cover the points where they are installed;
a road missing from the map is not proof that it is dry.
