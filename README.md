# เลี่ยงน้ำท่วม กทม. (Bangkok flood-avoidance map)

แผนที่ถนนน้ำท่วมกรุงเทพฯ บน Google Maps พร้อมตำแหน่ง GPS แบบเรียลไทม์ แจ้งเตือนเมื่อเข้าใกล้ถนนน้ำท่วม
และส่งต่อการนำทางไปยัง Google Maps

A static site: `index.html` + `app.js` draw `data/flood.geojson` over Google Maps (with its traffic layer)
or, when no API key is set, over OpenStreetMap.

## Data

Live road-flood readings come from the Bangkok Drainage and Sewerage Department's road sensors, through the
open API of [POPNIX Flood](https://flood.pop.in.th/api/) (free, no key; see its terms of use). They are not an
official warning.

- `.github/workflows/update-flood.yml` runs every 10 minutes: `scripts/build-flood.js` reads `api_roads.php`
  and `api_reports.php`, joins the depths onto `data/sensor-geometry.json`, and force-pushes the result as the
  single commit of the `data` branch. The site reads `flood.geojson` from there (`DATA_URL` in `config.js`).
  Visitors' phones do not call POPNIX; only this job does, as its terms ask.
- `.github/workflows/snap-geometry.yml` (run once, and when sensors are added) uses `scripts/snap-geometry.js` to
  find the OpenStreetMap road each sensor sits on and keep about 200 m either side of it. The coloured stretch is
  therefore an approximation. A sensor with no matching road is drawn as a 150 m circle.
- `data/flood.geojson` is an old copy kept as a fallback. The page warns when the newest reading is older than
  45 minutes (`STALE_MINUTES`).

Credit shown on the page: Drainage and Sewerage Department, BMA, via POPNIX Flood; road lines (c) OpenStreetMap
contributors (ODbL).

Tests: `node test/geo.test.js`.

## Google Maps key

Put a Google Maps JavaScript API key in `config.js` (`GOOGLE_MAPS_API_KEY`) and restrict it to this
site's domain in Google Cloud Console. Without a key the site uses OpenStreetMap.

## Hosting

GitHub Pages: Settings → Pages → Build and deployment → Deploy from a branch → the default branch, `/ (root)`.
GPS only works over `https`, which Pages provides.

## Limits

The data is only as fresh as the source artifact. Sensors cover the points where they are installed;
a road missing from the map is not proof that it is dry.
