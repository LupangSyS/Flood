#!/usr/bin/env node
'use strict';
// Builds the GeoJSON the site draws: live depths from POPNIX Flood (BMA Drainage and Sewerage Dept
// road sensors) joined onto data/sensor-geometry.json, plus unverified user reports.
//
// Usage: node scripts/build-flood.js <out.geojson> [--roads roads.json] [--reports reports.json]
const fs = require('fs');
const path = require('path');
const { getJson } = require('./lib/http');

const BASE = 'https://flood.pop.in.th';
const arg = (k) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : null; };
const outFile = process.argv[2];
if (!outFile || outFile.startsWith('--')) { console.error('usage: build-flood.js <out.geojson>'); process.exit(2); }

// Same colour classes the site already used: R > 15 cm, r 10-15 cm, a 5-10 cm.
const levelOf = r => (r.level === 'slight' ? 'a' : r.level === 'flood' ? (r.depth > 15 ? 'R' : 'r') : null);
const reportLevel = d => (d >= 3 ? 'H' : d === 2 ? 'M' : d === 1 ? 'L' : null);

(async () => {
  const live = arg('--roads') ? JSON.parse(fs.readFileSync(arg('--roads'), 'utf8')) : await getJson(`${BASE}/api_roads.php`);
  if (!live || !live.summary || !Array.isArray(live.roads) || live.roads.length < 50) throw new Error('unexpected api_roads response; not publishing');

  let reports = null;
  try { reports = arg('--reports') ? JSON.parse(fs.readFileSync(arg('--reports'), 'utf8')) : await getJson(`${BASE}/api_reports.php`, { tries: 2 }); }
  catch (e) { console.error('reports unavailable:', e.message); }

  const geomPath = path.join(__dirname, '..', 'data', 'sensor-geometry.json');
  const geom = fs.existsSync(geomPath) ? JSON.parse(fs.readFileSync(geomPath, 'utf8')).sensors : {};

  const features = [];
  let flood = 0, slight = 0, noGeom = 0;
  for (const r of live.roads) {
    const level = levelOf(r);
    if (!level || r.depth == null || r.lat == null) continue; // dry, off or no reading: never treated as 0
    level === 'a' ? slight++ : flood++;
    const props = {
      src: 'sensor', code: r.code, name: r.name || r.road, road: r.road, level, depth_cm: r.depth,
      at_least: r.grp === 2 && r.depth >= 20, district: r.district, kind: r.kind,
      measured_at: r.measured_at, since: r.since,
    };
    const g = geom[r.code];
    if (g && g.lines && g.lines.length) {
      for (const line of g.lines) features.push({ type: 'Feature', properties: { ...props, geom: g.m }, geometry: { type: 'LineString', coordinates: line } });
    } else {
      noGeom++;
      features.push({ type: 'Feature', properties: { ...props, geom: 'point' }, geometry: { type: 'Point', coordinates: [r.lng, r.lat] } });
    }
  }

  let nReports = 0;
  if (reports && Array.isArray(reports.cells)) {
    for (const c of reports.cells) {
      const level = reportLevel(c.depth);
      if (!level || c.lat == null) continue;
      nReports++;
      features.push({ type: 'Feature', properties: { src: 'report', name: 'รายงานจากผู้ใช้ (ยังไม่ยืนยัน)', level, district: c.district, n: c.n, last: c.last, unconfirmed: !!c.unconfirmed }, geometry: { type: 'Point', coordinates: [c.lng, c.lat] } });
    }
  }

  const s = live.summary;
  const fc = {
    type: 'FeatureCollection',
    meta: {
      latest: s.latest, generated: new Date().toISOString(), api_generated: s.generated,
      stale: !!s.stale, scrape_failing: !!s.scrape_failing,
      total: s.total, flood: s.flood, slight: s.slight, dry: s.dry, off: s.off,
      drawn_flood: flood, drawn_slight: slight, without_road_geometry: noGeom, reports: nReports, reports_ok: !!reports,
    },
    features,
  };
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(fc) + '\n');
  console.log(`wrote ${features.length} features: ${flood} flood + ${slight} slight sensors (${noGeom} as points), ${nReports} reports, latest ${s.latest}${s.stale ? ' [STALE]' : ''}`);
})().catch(e => { console.error(e); process.exit(1); });
