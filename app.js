'use strict';
// Flood-avoidance map: draws data/flood.geojson on Google Maps (when a key is set in config.js)
// or on Leaflet + OpenStreetMap, follows the viewer's GPS and warns near flooded roads.
(function () {
  const CFG = Object.assign({ GOOGLE_MAPS_API_KEY: '', WARN_METERS: 300, REFRESH_MINUTES: 5 }, window.FLOOD_CONFIG);
  const COLOR = { R: '#7a0010', r: '#e0201b', a: '#f29100', H: '#6a1b9a', M: '#8e44ad', L: '#b88ad1' };
  const LEVEL_TEXT = { R: 'น้ำท่วมสูง >15 ซม.', r: 'น้ำท่วม 10–15 ซม.', a: 'น้ำท่วม 5–10 ซม.',
    H: 'รายงาน: น้ำท่วมสูง', M: 'รายงาน: ปานกลาง', L: 'รายงาน: เล็กน้อย' };
  const CENTER = [13.78, 100.6];

  const $ = id => document.getElementById(id);
  const statusEl = $('status'), extEl = $('ext'), goEl = $('go'), stopEl = $('stop'), followEl = $('follow');
  const routeEl = $('route'), stepEl = $('step'), routeInfoEl = $('routeInfo');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let segs = [], here = null, dest = null, follow = true, lastWarn = '', dataStamp = '';
  let nav = null; // active navigation: { route, stepOfPoint, lastStep, lastReroute }
  const FLOOD_BUFFER_M = 40, OFF_ROUTE_M = 80, ARRIVED_M = 30;
  const toLL = p => [typeof p.lat === 'function' ? p.lat() : p.lat, typeof p.lng === 'function' ? p.lng() : p.lng];
  const stripHtml = h => new DOMParser().parseFromString(h || '', 'text/html').body.textContent.trim();

  function popupHtml(p) {
    if (p.src !== 'sensor') return `<div class="pop"><b>${esc(p.name)}</b>${esc(LEVEL_TEXT[p.level] || '')}</div>`;
    const sensors = (p.sensors || []).map(s => `${esc(s.id)} ${esc(s.at)} · ${esc(s.depth_cm)} ซม.`).join('<br>');
    return `<div class="pop"><b>${esc(p.name)}</b>${esc(LEVEL_TEXT[p.level] || '')} · สูงสุด ${esc(p.depth_cm)} ซม.<br>` +
      `เขต${esc(p.district)} · ${esc(p.span)}${sensors ? '<br><small>' + sensors + '</small>' : ''}</div>`;
  }

  // Distance in metres from point a=[lat,lng] to a polyline of [lat,lng] (flat-earth, fine at city scale).
  function distance(a, ll) {
    const k = 111320, cx = Math.cos(a[0] * Math.PI / 180);
    const xy = p => [(p[1] - a[1]) * k * cx, (p[0] - a[0]) * k];
    if (ll.length === 1) return Math.hypot(...xy(ll[0]));
    let best = Infinity;
    for (let i = 0; i < ll.length - 1; i++) {
      const [x1, y1] = xy(ll[i]), [x2, y2] = xy(ll[i + 1]);
      const dx = x2 - x1, dy = y2 - y1;
      const t = Math.max(0, Math.min(1, -(x1 * dx + y1 * dy) / ((dx * dx + dy * dy) || 1)));
      best = Math.min(best, Math.hypot(x1 + t * dx, y1 + t * dy));
    }
    return best;
  }

  // ---- map adapters: same small interface for Google Maps and Leaflet ----
  function googleAdapter() {
    const g = google.maps;
    const map = new g.Map($('map'), { center: { lat: CENTER[0], lng: CENTER[1] }, zoom: 12,
      disableDefaultUI: true, zoomControl: true, gestureHandling: 'greedy', clickableIcons: false });
    new g.TrafficLayer().setMap(map);
    const info = new g.InfoWindow();
    let lines = [], me = null, acc = null, destMarker = null, routeLines = [];

    // Normalise Google's route objects to { path, meters, seconds, steps:[{ text, start, path }] }.
    function fromDirections(r) {
      const leg = r.legs[0];
      return { path: r.overview_path.map(toLL), meters: leg.distance.value, seconds: leg.duration.value,
        steps: leg.steps.map(st => ({ text: stripHtml(st.instructions), start: toLL(st.start_location), path: (st.path || []).map(toLL) })) };
    }
    function fromRoutesApi(r) {
      const steps = (r.legs || []).flatMap(l => l.steps || []);
      return { path: (r.path || []).map(toLL), meters: r.distanceMeters, seconds: Math.round((r.durationMillis || 0) / 1000),
        steps: steps.map(st => ({ text: stripHtml(st.instructions || (st.navigationInstruction && st.navigationInstruction.instructions)),
          start: toLL(st.startLocation), path: (st.path || []).map(toLL) })) };
    }
    async function viaDirections(o, d) {
      const res = await new g.DirectionsService().route({ origin: { lat: o[0], lng: o[1] }, destination: { lat: d[0], lng: d[1] },
        travelMode: g.TravelMode.DRIVING, provideRouteAlternatives: true, region: 'th' });
      return res.routes.map(fromDirections);
    }
    async function viaRoutesApi(o, d) {
      const { Route } = await g.importLibrary('routes');
      const { routes } = await Route.computeRoutes({ origin: { lat: o[0], lng: o[1] }, destination: { lat: d[0], lng: d[1] },
        travelMode: 'DRIVING', computeAlternativeRoutes: true, language: 'th', region: 'th',
        fields: ['path', 'legs', 'distanceMeters', 'durationMillis'] });
      return routes.map(fromRoutesApi);
    }
    return {
      async routes(o, d) {
        try { return await viaDirections(o, d); }
        catch (e) { console.warn('DirectionsService failed, trying Routes API', e); return viaRoutesApi(o, d); }
      },
      showRoutes(list, best) {
        routeLines.forEach(l => l.setMap(null));
        routeLines = list.map((r, i) => new g.Polyline({ map, path: r.path.map(([lat, lng]) => ({ lat, lng })),
          strokeColor: i === best ? '#1a73e8' : '#7d8b94', strokeOpacity: i === best ? 0.9 : 0.55,
          strokeWeight: i === best ? 7 : 5, zIndex: i === best ? 5 : 1 }));
        const b = new g.LatLngBounds(); list[best].path.forEach(([lat, lng]) => b.extend({ lat, lng }));
        map.fitBounds(b, 60);
      },
      clearRoutes() { routeLines.forEach(l => l.setMap(null)); routeLines = []; },
      zoomTo(ll, z) { map.setCenter({ lat: ll[0], lng: ll[1] }); map.setZoom(z); },
      draw(features) {
        lines.forEach(l => l.setMap(null));
        lines = features.map(f => {
          const p = f.properties, report = p.src === 'report';
          const line = new g.Polyline({ map, path: f.geometry.coordinates.map(c => ({ lat: c[1], lng: c[0] })),
            strokeColor: COLOR[p.level] || '#555', strokeWeight: report ? 0 : 8, strokeOpacity: 0.85,
            icons: report ? [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, strokeWeight: 6, scale: 3 }, offset: '0', repeat: '14px' }] : null });
          line.addListener('click', e => { info.setContent(popupHtml(p)); info.setPosition(e.latLng); info.open(map); });
          return line;
        });
      },
      setMe(ll, accuracy) {
        const pos = { lat: ll[0], lng: ll[1] };
        if (!me) {
          acc = new g.Circle({ map, center: pos, radius: accuracy, strokeWeight: 1, strokeColor: '#0b5cad', fillColor: '#0b5cad', fillOpacity: 0.1 });
          me = new g.Marker({ map, position: pos, zIndex: 999,
            icon: { path: g.SymbolPath.CIRCLE, scale: 9, fillColor: '#0b5cad', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 3 } });
          map.setCenter(pos); map.setZoom(16);
        } else { me.setPosition(pos); acc.setCenter(pos); acc.setRadius(accuracy); if (follow) map.panTo(pos); }
      },
      setDest(ll) {
        const pos = { lat: ll[0], lng: ll[1] };
        if (destMarker) destMarker.setPosition(pos); else destMarker = new g.Marker({ map, position: pos, title: 'ปลายทาง' });
      },
      pan(ll) { map.panTo({ lat: ll[0], lng: ll[1] }); },
      onLongPress(cb) {
        // Google Maps has no long-press event on touch; time a press ourselves.
        let timer = null;
        map.addListener('mousedown', e => { timer = setTimeout(() => cb([e.latLng.lat(), e.latLng.lng()]), 600); });
        ['mouseup', 'dragstart', 'zoom_changed'].forEach(ev => map.addListener(ev, () => clearTimeout(timer)));
        map.addListener('rightclick', e => cb([e.latLng.lat(), e.latLng.lng()]));
      },
      onUserDrag(cb) { map.addListener('dragstart', cb); },
    };
  }

  function leafletAdapter() {
    const map = L.map('map', { zoomControl: false }).setView(CENTER, 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
    const layer = L.layerGroup().addTo(map);
    let me = null, acc = null, destMarker = null;
    return {
      draw(features) {
        layer.clearLayers();
        for (const f of features) {
          const p = f.properties, report = p.src === 'report';
          L.polyline(f.geometry.coordinates.map(c => [c[1], c[0]]), { color: COLOR[p.level] || '#555',
            weight: report ? 6 : 8, opacity: 0.85, dashArray: report ? '8 6' : null }).bindPopup(popupHtml(p)).addTo(layer);
        }
      },
      setMe(ll, accuracy) {
        if (!me) {
          acc = L.circle(ll, { radius: accuracy, weight: 1, fillOpacity: 0.1 }).addTo(map);
          me = L.circleMarker(ll, { radius: 9, color: '#fff', weight: 3, fillColor: '#0b5cad', fillOpacity: 1 }).addTo(map);
          map.setView(ll, 16);
        } else { me.setLatLng(ll); acc.setLatLng(ll).setRadius(accuracy); if (follow) map.panTo(ll); }
      },
      setDest(ll) { if (destMarker) destMarker.setLatLng(ll); else destMarker = L.marker(ll, { title: 'ปลายทาง' }).addTo(map); },
      pan(ll) { map.panTo(ll); },
      routes: null, // in-page routing needs Google Maps; the "open in app" link is used instead
      onLongPress(cb) { map.on('contextmenu', e => cb([e.latlng.lat, e.latlng.lng])); },
      onUserDrag(cb) { map.on('dragstart', cb); },
    };
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script'); s.src = src; s.async = true;
      s.onload = resolve; s.onerror = () => reject(new Error('load failed: ' + src));
      document.head.appendChild(s);
    });
  }
  function loadCss(href) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; document.head.appendChild(l); }

  async function createMap() {
    if (CFG.GOOGLE_MAPS_API_KEY) {
      try {
        await loadScript('https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(CFG.GOOGLE_MAPS_API_KEY) + '&language=th&region=TH');
        return googleAdapter();
      } catch (e) { console.warn('Google Maps failed, falling back to OpenStreetMap', e); }
    }
    loadCss('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css');
    await loadScript('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js');
    return leafletAdapter();
  }

  // ---- data ----
  async function loadData(map) {
    try {
      const res = await fetch('data/flood.geojson?t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const fc = await res.json();
      const stamp = fc.meta && fc.meta.updated_at;
      if (stamp && stamp === dataStamp) return;
      dataStamp = stamp;
      segs = fc.features.map(f => ({ p: f.properties, ll: f.geometry.coordinates.map(c => [c[1], c[0]]) }));
      map.draw(fc.features);
      const m = fc.meta || {};
      const upd = stamp ? new Date(stamp).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }) : '';
      $('stamp').textContent = `เซ็นเซอร์ ${m.sensor_time || '–'} น. · รายงาน ${m.report_time || '–'} น.` + (upd ? ` · อัปเดต ${upd}` : '');
      if (here) checkNearby();
    } catch (e) {
      $('stamp').textContent = 'โหลดข้อมูลน้ำท่วมไม่ได้ จะลองใหม่อัตโนมัติ';
    }
  }

  // ---- GPS ----
  function checkNearby() {
    let near = null, nd = Infinity;
    for (const s of segs) { const d = distance(here, s.ll); if (d < nd) { nd = d; near = s; } }
    if (!near) return;
    if (nd < CFG.WARN_METERS) {
      statusEl.className = 'card warn';
      statusEl.textContent = `⚠ ใกล้น้ำท่วม ${Math.round(nd)} ม. — ${near.p.name}` + (near.p.depth_cm ? ` (${near.p.depth_cm} ซม.)` : '');
      if (lastWarn !== near.p.name) { lastWarn = near.p.name; if (navigator.vibrate) navigator.vibrate([300, 150, 300]); }
    } else {
      statusEl.className = 'card';
      statusEl.textContent = `จุดน้ำท่วมใกล้สุด ${(nd / 1000).toFixed(1)} กม. — ${near.p.name}`;
      lastWarn = '';
    }
  }

  function updateNav(map) {
    if (!dest) return;
    extEl.hidden = false;
    extEl.href = 'https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=' + dest.join(',') +
      (here ? '&origin=' + here.join(',') : '');
    goEl.hidden = !map.routes || !!nav;
  }

  // Metres of the route that run within FLOOD_BUFFER_M of a flooded segment.
  function floodedMeters(path) {
    let total = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const mid = [(path[i][0] + path[i + 1][0]) / 2, (path[i][1] + path[i + 1][1]) / 2];
      if (segs.some(s => distance(mid, s.ll) < FLOOD_BUFFER_M)) total += distance(path[i], [path[i + 1]]);
    }
    return total;
  }

  function say(text) {
    try {
      if (!window.speechSynthesis) return;
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text); u.lang = 'th-TH'; speechSynthesis.speak(u);
    } catch (e) { /* voice is optional */ }
  }

  const fmtKm = m => m >= 1000 ? (m / 1000).toFixed(1) + ' กม.' : Math.round(m / 10) * 10 + ' ม.';

  async function planRoute(map, announce) {
    routeEl.hidden = false;
    stepEl.textContent = 'กำลังหาเส้นทางเลี่ยงน้ำท่วม…'; routeInfoEl.textContent = ''; routeInfoEl.className = 'rinfo';
    let list;
    try { list = await map.routes(here, dest); }
    catch (e) {
      stepEl.textContent = 'หาเส้นทางไม่ได้';
      routeInfoEl.textContent = 'คีย์ Google Maps ต้องเปิดใช้ Directions API หรือ Routes API — ใช้ปุ่ม “เปิดในแอป Google Maps” แทนได้';
      return false;
    }
    if (!list.length) { stepEl.textContent = 'ไม่พบเส้นทาง'; return false; }
    list.forEach(r => { r.flooded = floodedMeters(r.path); });
    const best = list.reduce((b, r, i) => (r.flooded < list[b].flooded - 50 ||
      (Math.abs(r.flooded - list[b].flooded) <= 50 && r.seconds < list[b].seconds)) ? i : b, 0);
    const r = list[best];
    map.showRoutes(list, best);
    // Guidance path: every vertex of every step, tagged with its step index.
    const gpath = [], stepOfPoint = [];
    r.steps.forEach((st, k) => (st.path.length ? st.path : [st.start]).forEach(p => { gpath.push(p); stepOfPoint.push(k); }));
    nav = { route: r, gpath, stepOfPoint, lastStep: -1, lastReroute: Date.now() };
    const others = list.length > 1 ? ` · เลือกจาก ${list.length} เส้นทาง` : '';
    routeInfoEl.textContent = `${fmtKm(r.meters)} · ${Math.round(r.seconds / 60)} นาที · ` +
      (r.flooded < 20 ? 'ไม่ผ่านจุดน้ำท่วม' : `ผ่านน้ำท่วมประมาณ ${fmtKm(r.flooded)} (น้อยที่สุดที่มี)`) + others;
    if (r.flooded >= 20) routeInfoEl.className = 'rinfo bad';
    if (announce) say(r.flooded < 20 ? 'เริ่มนำทาง เส้นทางนี้ไม่ผ่านจุดน้ำท่วม' : 'เริ่มนำทาง เส้นทางนี้ยังผ่านจุดน้ำท่วมบางช่วง');
    guide(map);
    return true;
  }

  // Called on every GPS fix while navigating.
  function guide(map) {
    if (!nav || !here) return;
    const r = nav.route;
    if (distance(here, [dest]) < ARRIVED_M) { stepEl.textContent = 'ถึงปลายทางแล้ว'; say('ถึงปลายทางแล้ว'); stopNav(map, true); return; }
    let ni = 0, nd = Infinity;
    nav.gpath.forEach((p, i) => { const d = distance(here, [p]); if (d < nd) { nd = d; ni = i; } });
    if (distance(here, nav.gpath) > OFF_ROUTE_M && Date.now() - nav.lastReroute > 20000) {
      nav.lastReroute = Date.now(); say('ออกนอกเส้นทาง กำลังหาเส้นทางใหม่'); planRoute(map, false); return;
    }
    const next = nav.stepOfPoint[ni] + 1;
    if (next < r.steps.length) {
      const st = r.steps[next], d = distance(here, [st.start]);
      stepEl.textContent = `อีก ${fmtKm(d)} · ${st.text}`;
      if (next !== nav.lastStep) { nav.lastStep = next; say(`อีก ${fmtKm(d)} ${st.text}`); }
      else if (d < 150 && !nav.near) { nav.near = true; say(st.text); }
      if (d >= 150) nav.near = false;
    } else {
      stepEl.textContent = `ตรงไปอีก ${fmtKm(distance(here, [dest]))} ถึงปลายทาง`;
    }
  }

  function stopNav(map, keepCard) {
    nav = null; map.clearRoutes(); stopEl.hidden = true;
    if (!keepCard) routeEl.hidden = true;
    updateNav(map);
  }

  createMap().then(map => {
    loadData(map);
    setInterval(() => loadData(map), CFG.REFRESH_MINUTES * 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) loadData(map); });

    $('gps').addEventListener('click', () => {
      if (!navigator.geolocation) { statusEl.textContent = 'เบราว์เซอร์นี้ไม่รองรับ GPS'; return; }
      statusEl.textContent = 'กำลังหาตำแหน่ง…';
      navigator.geolocation.watchPosition(pos => {
        here = [pos.coords.latitude, pos.coords.longitude];
        map.setMe(here, pos.coords.accuracy);
        checkNearby(); updateNav(map); guide(map);
      }, err => { statusEl.className = 'card'; statusEl.textContent = 'เปิด GPS ไม่ได้: ' + err.message + ' (อนุญาตการเข้าถึงตำแหน่งในเบราว์เซอร์)'; },
      { enableHighAccuracy: true, maximumAge: 3000 });
      if (navigator.wakeLock) navigator.wakeLock.request('screen').catch(() => {});
    });

    const setFollow = on => { follow = on; followEl.textContent = 'ตามตำแหน่ง: ' + (on ? 'เปิด' : 'ปิด'); followEl.setAttribute('aria-pressed', on); };
    followEl.addEventListener('click', () => { setFollow(!follow); if (follow && here) map.pan(here); });
    map.onUserDrag(() => { if (follow) setFollow(false); });
    map.onLongPress(ll => { dest = ll; map.setDest(ll); if (nav) stopNav(map); updateNav(map); });

    goEl.addEventListener('click', async () => {
      if (!here) { $('gps').click(); statusEl.textContent = 'รอตำแหน่ง GPS ก่อน แล้วกด “นำทางเลี่ยงน้ำท่วม” อีกครั้ง'; return; }
      goEl.hidden = true;
      if (await planRoute(map, true)) { stopEl.hidden = false; setFollow(true); map.zoomTo(here, 17); }
      else goEl.hidden = false;
    });
    stopEl.addEventListener('click', () => { if (window.speechSynthesis) speechSynthesis.cancel(); stopNav(map); });
  }).catch(() => { statusEl.textContent = 'โหลดแผนที่ไม่ได้ ตรวจสอบอินเทอร์เน็ตแล้วรีเฟรช'; });
})();
