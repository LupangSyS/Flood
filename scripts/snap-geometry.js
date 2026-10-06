#!/usr/bin/env node
'use strict';
// One-off (re-runnable) job: turn each BMA road sensor from POPNIX Flood into a stretch of real road
// taken from OpenStreetMap, and save it to data/sensor-geometry.json. The 10-minute job then only
// joins live depths onto this file and never needs OpenStreetMap.
//
// Usage: node scripts/snap-geometry.js [--roads roads.json] [--out file] [--all]
const fs = require('fs');
const path = require('path');
const { getJson } = require('./lib/http');
const { snapSensor } = require('./lib/geo');

const ROADS_URL = 'https://flood.pop.in.th/api_roads.php';
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const HALF_LEN_M = 200, BATCH = 40;
const HIGHWAYS = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const outFile = arg('--out', path.join(__dirname, '..', 'data', 'sensor-geometry.json'));
const redoAll = process.argv.includes('--all');

async function overpass(sensors) {
  const parts = sensors.map(s => `way(around:45,${s.lat},${s.lng})[highway~"^(${HIGHWAYS})$"];`).join('');
  const body = `[out:json][timeout:60];(${parts});out geom tags;`;
  let last;
  for (const url of OVERPASS) {
    try {
      const j = await getJson(url, { tries: 2, timeoutMs: 80000, init: { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(body) } });
      return j.elements.filter(e => e.type === 'way' && e.geometry).map(e => ({
        line: e.geometry.map(g => [g.lat, g.lon]),
        names: [e.tags && e.tags.name, e.tags && e.tags['name:th'], e.tags && e.tags.alt_name],
      }));
    } catch (e) { last = e; }
  }
  throw last;
}

(async () => {
  const roads = arg('--roads') ? JSON.parse(fs.readFileSync(arg('--roads'), 'utf8')) : await getJson(ROADS_URL);
  if (!roads || !Array.isArray(roads.roads) || roads.roads.length < 50) throw new Error('unexpected api_roads response');
  const prev = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : { sensors: {} };
  const result = { sensors: { ...prev.sensors } };
  const todo = roads.roads.filter(r => r.lat != null && r.lng != null && (redoAll || !prev.sensors[r.code] || prev.sensors[r.code].m === 'point'));
  console.log(`${roads.roads.length} sensors, ${todo.length} to snap`);

  let osm = 0, point = 0, failed = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    let ways;
    try { ways = await overpass(batch); } catch (e) { console.error('overpass batch failed:', e.message); failed += batch.length; continue; }
    for (const s of batch) {
      const snap = snapSensor(s, ways, { half: HALF_LEN_M });
      if (snap) {
        result.sensors[s.code] = { m: snap.method, lines: snap.lines.map(l => l.map(([la, ln]) => [+ln.toFixed(5), +la.toFixed(5)])) };
        osm++;
      } else { result.sensors[s.code] = { m: 'point' }; point++; }
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  result.generated = new Date().toISOString();
  result.half_len_m = HALF_LEN_M;
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(result) + '\n');
  console.log(`snapped to road: ${osm}, left as points: ${point}, overpass failures: ${failed}`);
  if (osm === 0 && todo.length) process.exit(1); // nothing worked: fail the job so it is noticed
})().catch(e => { console.error(e); process.exit(1); });
