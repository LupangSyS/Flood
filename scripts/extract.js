#!/usr/bin/env node
// Pulls the flood data out of the source artifact's saved HTML and writes data/flood.geojson.
// The artifact is third-party content: its data blocks are parsed as JSON, never executed.
// Usage: node scripts/extract.js <artifact.html> [out.geojson]
'use strict';
const fs = require('fs');
const path = require('path');

const SOURCE_URL = 'https://claude.ai/artifact/N6umcENfSgoY6GMkhVKwZs';

// Returns the literal that follows `const NAME =` up to the matching close bracket.
function literal(html, name) {
  const start = html.search(new RegExp('\\bconst ' + name + '\\s*=\\s*[\\[{]'));
  if (start < 0) throw new Error('block not found: ' + name);
  let i = html.indexOf('=', start) + 1;
  while (/\s/.test(html[i])) i++;
  let depth = 0, inStr = false, esc = false;
  for (let j = i; j < html.length; j++) {
    const c = html[j];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '/' && html[j + 1] === '/') { j = html.indexOf('\n', j) - 1; if (j < 0) break; }
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') { if (--depth === 0) return html.slice(i, j + 1); }
  }
  throw new Error('unterminated block: ' + name);
}

function parse(html, name) {
  const src = literal(html, name)
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    .replace(/,(\s*[\]}])/g, '$1');
  return JSON.parse(src);
}

function extract(html) {
  const roads = parse(html, 'ROADS');
  const geo = parse(html, 'GEO');
  const reports = parse(html, 'REPORTS');
  const stamp = (html.match(/class="stamp"[^]*?<b>\s*([0-9]{1,2}[:.][0-9]{2})/) || [])[1] || null;

  const toLngLat = seg => seg.map(([lat, lng]) => [lng, lat]);
  const features = [];
  for (const r of roads) {
    for (const seg of geo[r.n] || []) {
      features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: toLngLat(seg) }, properties: {
        src: 'sensor', name: r.n, level: r.l, depth_cm: r.m, district: r.d, zone: r.z, span: r.s,
        sensors: (r.k || []).map(k => ({ id: k[0], at: k[1], depth_cm: k[2] })),
      } });
    }
  }
  for (const it of reports.items || []) {
    for (const seg of it.g || []) {
      features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: toLngLat(seg) }, properties: {
        src: 'report', name: it.n, level: it.lv,
      } });
    }
  }
  if (!features.length) throw new Error('no flood segments found');
  return {
    type: 'FeatureCollection',
    meta: { source: SOURCE_URL, sensor_time: stamp, report_time: reports.time || null,
      roads: roads.length, reports: (reports.items || []).length },
    features,
  };
}

if (require.main === module) {
  const [inFile, outFile = path.join(__dirname, '..', 'data', 'flood.geojson')] = process.argv.slice(2);
  if (!inFile) { console.error('usage: extract.js <artifact.html> [out.geojson]'); process.exit(2); }
  const fc = extract(fs.readFileSync(inFile, 'utf8'));
  const prev = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : null;
  const same = prev && JSON.stringify({ ...prev, meta: { ...prev.meta, updated_at: 0 } }) ===
    JSON.stringify({ ...fc, meta: { ...fc.meta, updated_at: 0 } });
  if (same) { console.log('unchanged'); process.exit(0); }
  fc.meta.updated_at = new Date().toISOString();
  fs.writeFileSync(outFile, JSON.stringify(fc) + '\n');
  console.log(`updated: ${fc.meta.roads} roads, ${fc.meta.reports} reports, ${fc.features.length} segments, sensor time ${fc.meta.sensor_time}`);
}
module.exports = { extract };
