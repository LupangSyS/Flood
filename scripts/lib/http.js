'use strict';
// fetch with a timeout and a few retries; throws on non-2xx.
async function getJson(url, { tries = 3, timeoutMs = 25000, init = {} } = {}) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: { 'user-agent': 'LupangSyS-Flood/1.0 (+https://github.com/LupangSyS/Flood)', accept: 'application/json', ...(init.headers || {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (e) {
      last = e;
      console.error(`attempt ${i}/${tries} failed: ${e.message}`);
      if (i < tries) await new Promise(r => setTimeout(r, 1500 * i));
    }
  }
  throw last;
}
module.exports = { getJson };
