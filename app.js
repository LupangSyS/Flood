'use strict';
// Flood-avoidance map: draws data/flood.geojson on Google Maps (when a key is set in config.js)
// or on Leaflet + OpenStreetMap, follows the viewer's GPS and warns near flooded roads.
(function () {
  const CFG = Object.assign({ GOOGLE_MAPS_API_KEY: '', WARN_METERS: 300, REFRESH_MINUTES: 5, STALE_MINUTES: 45, POINT_RADIUS_M: 150,
    DATA_URL: 'data/flood.geojson', FALLBACK_URL: 'data/flood.geojson' }, window.FLOOD_CONFIG);
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
    if (p.src === 'report') {
      return `<div class="pop"><b>${esc(p.name)}</b>${esc(LEVEL_TEXT[p.level] || '')} · ${esc(p.n)} รายงาน` +
        `${p.last ? '<br><small>ล่าสุด ' + esc(p.last) + '</small>' : ''}<br><small>เป็นคำบอกเล่าของผู้ใช้ ไม่ใช่ค่าจากเครื่องวัด</small></div>`;
    }
    const where = p.geom === 'point' ? 'ตำแหน่งจุดวัด (ไม่พบเส้นถนน)' : 'ช่วงถนนโดยประมาณ ±200 ม. จากจุดวัด';
    return `<div class="pop"><b>${esc(p.name)}</b>${esc(LEVEL_TEXT[p.level] || '')} · ${p.at_least ? 'อย่างน้อย ' : ''}${esc(p.depth_cm)} ซม.<br>` +
      `เขต${esc(p.district)}<br><small>วัดเมื่อ ${esc(p.measured_at)}${p.since ? ' · ท่วมตั้งแต่ ' + esc(p.since) : ''}</small><br><small>${where}</small></div>`;
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
          if (f.geometry.type === 'Point') {
            const [lng, lat] = f.geometry.coordinates;
            const dot = new g.Circle({ map, center: { lat, lng }, radius: CFG.POINT_RADIUS_M, strokeColor: COLOR[p.level] || '#555',
              strokeWeight: report ? 2 : 3, strokeOpacity: 0.9, fillColor: COLOR[p.level] || '#555', fillOpacity: report ? 0.15 : 0.45 });
            dot.addListener('click', e => { info.setContent(popupHtml(p)); info.setPosition(e.latLng); info.open(map); });
            return dot;
          }
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
        // Google Maps has no touch long-press event, so time one from raw touches: exactly one
        // finger held still for 700 ms. A second finger (pinch), a move (pan) or lifting cancels it.
        const el = map.getDiv();
        const ov = new g.OverlayView(); ov.onAdd = ov.draw = ov.onRemove = () => {}; ov.setMap(map);
        // A gesture that ever had two fingers (a pinch) never becomes a long-press, even if the
        // fingers lift a few milliseconds apart and one is left on the screen.
        let timer = null, start = null, lastTouch = 0, fingers = 0, multi = false, zoomAtStart = null;
        const cancel = () => { clearTimeout(timer); timer = null; };
        const opts = { passive: true, capture: true };
        el.addEventListener('touchstart', e => {
          lastTouch = Date.now(); cancel();
          fingers = e.touches.length;
          if (fingers > 1) multi = true;
          if (fingers !== 1 || multi) return;
          const t = e.touches[0], rect = el.getBoundingClientRect();
          start = [t.clientX, t.clientY]; zoomAtStart = map.getZoom();
          const px = new g.Point(t.clientX - rect.left, t.clientY - rect.top);
          timer = setTimeout(() => {
            timer = null;
            if (fingers !== 1 || multi || map.getZoom() !== zoomAtStart) return;
            const proj = ov.getProjection(); if (!proj) return;
            const ll = proj.fromContainerPixelToLatLng(px);
            cb([ll.lat(), ll.lng()]);
          }, 700);
        }, opts);
        el.addEventListener('touchmove', e => {
          lastTouch = Date.now();
          fingers = e.touches.length; if (fingers > 1) multi = true;
          const t = e.touches[0];
          if (fingers !== 1 || !start || Math.hypot(t.clientX - start[0], t.clientY - start[1]) > 10) cancel();
        }, opts);
        ['touchend', 'touchcancel'].forEach(ev => el.addEventListener(ev, e => {
          lastTouch = Date.now(); cancel();
          fingers = e.touches.length;
          if (fingers === 0) multi = false; // gesture over
        }, opts));
        map.addListener('zoom_changed', cancel);
        // Desktop right-click only: on phones Chrome turns a held touch into a right-click too, so
        // ignore it whenever a finger is down or was lifted in the last 1.5 s.
        map.addListener('rightclick', e => {
          if (fingers > 0 || Date.now() - lastTouch < 1500) return;
          cb([e.latLng.lat(), e.latLng.lng()]);
        });
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
          if (f.geometry.type === 'Point') {
            const [lng, lat] = f.geometry.coordinates;
            L.circle([lat, lng], { radius: CFG.POINT_RADIUS_M, color: COLOR[p.level] || '#555', weight: report ? 2 : 3,
              fillOpacity: report ? 0.15 : 0.45, dashArray: report ? '6 5' : null }).bindPopup(popupHtml(p)).addTo(layer);
            continue;
          }
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
  // Read one data file; the main one is built every 10 minutes by a GitHub Action, the fallback ships with the site.
  async function fetchData(url) {
    const res = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const fc = await res.json();
    if (!fc || !Array.isArray(fc.features)) throw new Error('bad data');
    return fc;
  }

  // "2026-10-06 14:25:00" is Bangkok time (UTC+7).
  const thaiTime = s => (s ? new Date(String(s).replace(' ', 'T') + '+07:00') : null);
  const fmtTime = d => d.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  let meta = {};
  function renderStamp() {
    const latest = thaiTime(meta.latest);
    const ageMin = latest ? (Date.now() - latest.getTime()) / 60000 : Infinity;
    const old = !latest || ageMin > CFG.STALE_MINUTES || meta.stale || meta.scrape_failing;
    $('stamp').textContent = latest
      ? `ข้อมูลวัดล่าสุด ${fmtTime(latest)} น. · ถนนมีน้ำ ${(meta.drawn_flood || 0) + (meta.drawn_slight || 0)} จุด`
      : 'ข้อมูลน้ำท่วมจากไฟล์สำรอง';
    const banner = $('stale');
    banner.hidden = !old;
    if (old) {
      banner.textContent = latest
        ? `⚠ ข้อมูลอาจเก่า: วัดล่าสุด ${fmtTime(latest)} น. ถนนที่ไม่แสดงสีไม่ได้แปลว่าปลอดภัย`
        : '⚠ โหลดข้อมูลล่าสุดไม่ได้ กำลังแสดงข้อมูลสำรองที่อาจเก่า ถนนที่ไม่แสดงสีไม่ได้แปลว่าปลอดภัย';
    }
  }

  async function loadData(map) {
    let fc;
    try { fc = await fetchData(CFG.DATA_URL); }
    catch (e) {
      console.warn('live data failed, using fallback', e);
      try { fc = await fetchData(CFG.FALLBACK_URL); fc.meta = Object.assign({}, fc.meta, { latest: null }); }
      catch (e2) { $('stamp').textContent = 'โหลดข้อมูลน้ำท่วมไม่ได้ จะลองใหม่อัตโนมัติ'; return; }
    }
    meta = fc.meta || {};
    renderStamp();
    const stamp = (meta.generated || '') + '|' + (meta.latest || 'fallback');
    if (stamp === dataStamp) return;
    dataStamp = stamp;
    segs = fc.features.map(f => f.geometry.type === 'Point'
      ? { p: f.properties, ll: [[f.geometry.coordinates[1], f.geometry.coordinates[0]]], r: CFG.POINT_RADIUS_M }
      : { p: f.properties, ll: f.geometry.coordinates.map(c => [c[1], c[0]]), r: 0 });
    map.draw(fc.features);
    if (here) checkNearby();
  }

  // ---- GPS ----
  function checkNearby() {
    let near = null, nd = Infinity;
    for (const s of segs) { const d = Math.max(0, distance(here, s.ll) - s.r); if (d < nd) { nd = d; near = s; } }
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
      if (segs.some(s => distance(mid, s.ll) < FLOOD_BUFFER_M + s.r)) total += distance(path[i], [path[i + 1]]);
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
    setInterval(renderStamp, 60 * 1000);
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
    map.onLongPress(ll => {
      // While navigating the destination stays put; stop navigation first to pick a new one.
      if (nav) { statusEl.className = 'card'; statusEl.textContent = 'กำลังนำทางอยู่ — กด “หยุดนำทาง” ก่อนเปลี่ยนปลายทาง'; return; }
      dest = ll; map.setDest(ll); updateNav(map);
      if (navigator.vibrate) navigator.vibrate(40);
    });

    goEl.addEventListener('click', async () => {
      if (!here) { $('gps').click(); statusEl.textContent = 'รอตำแหน่ง GPS ก่อน แล้วกด “นำทางเลี่ยงน้ำท่วม” อีกครั้ง'; return; }
      goEl.hidden = true;
      if (await planRoute(map, true)) { stopEl.hidden = false; setFollow(true); map.zoomTo(here, 17); }
      else goEl.hidden = false;
    });
    stopEl.addEventListener('click', () => { if (window.speechSynthesis) speechSynthesis.cancel(); stopNav(map); });
  }).catch(() => { statusEl.textContent = 'โหลดแผนที่ไม่ได้ ตรวจสอบอินเทอร์เน็ตแล้วรีเฟรช'; });
})();
