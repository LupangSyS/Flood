'use strict';
// Small geometry helpers for turning a sensor point into a stretch of real road.
// All distances are metres on a flat local projection, which is accurate enough at city scale.

const M_PER_DEG = 111320;

function makeProjector(lat0, lng0) {
  const cx = Math.cos(lat0 * Math.PI / 180);
  return {
    toXY: ([lat, lng]) => [(lng - lng0) * M_PER_DEG * cx, (lat - lat0) * M_PER_DEG],
    toLL: ([x, y]) => [lat0 + y / M_PER_DEG, lng0 + x / (M_PER_DEG * cx)],
  };
}

// Nearest point on a polyline (array of [lat,lng]) to `pt`.
// Returns { dist, s, total, lengths } where s is the distance along the line to that point.
function nearestOnPolyline(pt, line) {
  const pr = makeProjector(pt[0], pt[1]);
  const xy = line.map(pr.toXY);
  const lengths = [0];
  let best = { dist: Infinity, s: 0 };
  for (let i = 0; i < xy.length - 1; i++) {
    const [x1, y1] = xy[i], [x2, y2] = xy[i + 1];
    const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
    const segLen = Math.sqrt(len2);
    const t = len2 ? Math.max(0, Math.min(1, -(x1 * dx + y1 * dy) / len2)) : 0;
    const d = Math.hypot(x1 + t * dx, y1 + t * dy);
    if (d < best.dist) best = { dist: d, s: lengths[i] + t * segLen };
    lengths.push(lengths[i] + segLen);
  }
  return { dist: best.dist, s: best.s, total: lengths[lengths.length - 1], lengths };
}

// The part of `line` within `half` metres (along the line) of position s.
function clipAlong(line, lengths, s, half) {
  const from = Math.max(0, s - half), to = Math.min(lengths[lengths.length - 1], s + half);
  const out = [];
  const at = d => {
    let i = 0;
    while (i < lengths.length - 2 && lengths[i + 1] < d) i++;
    const span = lengths[i + 1] - lengths[i] || 1;
    const t = (d - lengths[i]) / span;
    return [line[i][0] + (line[i + 1][0] - line[i][0]) * t, line[i][1] + (line[i + 1][1] - line[i][1]) * t];
  };
  out.push(at(from));
  for (let i = 0; i < line.length; i++) if (lengths[i] > from && lengths[i] < to) out.push(line[i]);
  out.push(at(to));
  return out;
}

// Reduce a Thai road name to its core so "ถนนสุวินทวงศ์" matches "ถ.สุวินทวงศ์ (ถ.หทัยราษฎร์)".
function nameCores(...names) {
  const cores = new Set();
  for (const n of names) {
    if (!n) continue;
    for (const part of String(n).split(/[()/,]/)) {
      const core = part.replace(/\s+/g, '').replace(/^(ถนน|ถ\.|ซอย|ซ\.|ทางหลวง|ทล\.)/, '');
      if (core.length >= 3) cores.add(core);
    }
  }
  return [...cores];
}

function nameMatches(sensorCores, osmNames) {
  const osm = nameCores(...osmNames);
  return sensorCores.some(a => osm.some(b => a.includes(b) || b.includes(a)));
}

// Pick the OSM ways that belong to a sensor and return clipped [lat,lng] lines.
// `ways` = [{ line: [[lat,lng]...], names: [...] }]
function snapSensor(sensor, ways, { half = 200, maxDist = 40, looseDist = 25 } = {}) {
  const pt = [sensor.lat, sensor.lng];
  const cores = nameCores(sensor.road, sensor.name);
  const cand = ways.map(w => {
    const n = nearestOnPolyline(pt, w.line);
    return { w, n, matched: nameMatches(cores, w.names) };
  }).filter(c => c.n.dist <= maxDist && c.w.line.length >= 2);
  if (!cand.length) return null;

  const matched = cand.filter(c => c.matched).sort((a, b) => a.n.dist - b.n.dist);
  let chosen, method;
  if (matched.length) {
    // Keep both carriageways of a divided road: other matched ways close to the nearest one.
    chosen = matched.filter(c => c.n.dist <= matched[0].n.dist + 30).slice(0, 3);
    method = 'osm';
  } else {
    const nearest = cand.sort((a, b) => a.n.dist - b.n.dist)[0];
    if (nearest.n.dist > looseDist) return null;
    chosen = [nearest];
    method = 'osm-nearest';
  }
  return { method, lines: chosen.map(c => clipAlong(c.w.line, c.n.lengths, c.n.s, half)) };
}

module.exports = { nearestOnPolyline, clipAlong, nameCores, nameMatches, snapSensor, makeProjector };
