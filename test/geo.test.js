'use strict';
const assert = require('assert');
const { nearestOnPolyline, clipAlong, snapSensor } = require('../scripts/lib/geo');

// A straight east-west road at lat 13.75, 2 km long, roughly 110 m per 0.001 deg lng at this latitude.
const road = [[13.75, 100.50], [13.75, 100.52]];
const sensor = { lat: 13.7501, lng: 100.51, road: 'ถนนสุวินทวงศ์', name: 'ถ.สุวินทวงศ์' };

const n = nearestOnPolyline([sensor.lat, sensor.lng], road);
assert(n.dist > 10 && n.dist < 13, 'distance to road about 11 m, got ' + n.dist);
assert(Math.abs(n.s - n.total / 2) < 5, 'sensor sits mid-way along the road');

const clip = clipAlong(road, n.lengths, n.s, 200);
const len = nearestOnPolyline(clip[0], clip).total;
assert(Math.abs(len - 400) < 5, 'clipped stretch is about 400 m, got ' + len);

// Name match wins over a nearer but differently named lane; both carriageways are kept.
const ways = [
  { line: [[13.75003, 100.50], [13.75003, 100.52]], names: ['ซอยอื่น'] },
  { line: [[13.7500, 100.50], [13.7500, 100.52]], names: ['ถนนสุวินทวงศ์'] },
  { line: [[13.7502, 100.52], [13.7502, 100.50]], names: ['ถนนสุวินทวงศ์'] },
  { line: [[13.76, 100.50], [13.76, 100.52]], names: ['ถนนสุวินทวงศ์'] }, // 1 km away, too far
];
const snapped = snapSensor(sensor, ways);
assert.strictEqual(snapped.method, 'osm');
assert.strictEqual(snapped.lines.length, 2, 'both carriageways');

// No name match: take the nearest way only when it is really close.
const loose = snapSensor({ ...sensor, road: 'ไม่ตรงกัน', name: 'ไม่ตรงกัน' }, [ways[0]]);
assert.strictEqual(loose.method, 'osm-nearest');
const far = snapSensor({ ...sensor, lat: 13.75034, road: 'ไม่ตรงกัน', name: 'ไม่ตรงกัน' }, [ways[1]]);
assert.strictEqual(far, null, 'unmatched way 38 m away is rejected');

// A road shorter than the window is returned whole.
const short = clipAlong([[13.75, 100.5], [13.75, 100.5009]], nearestOnPolyline([13.75, 100.5], [[13.75, 100.5], [13.75, 100.5009]]).lengths, 50, 200);
assert.strictEqual(short.length, 2);
console.log('geo tests passed');
