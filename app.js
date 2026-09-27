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
  const statusEl = $('status'), navEl = $('nav'), followEl = $('follow');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let segs = [], here = null, dest = null, follow = true, lastWarn = '', dataStamp = '';

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
    let lines = [], me = null, acc = null, destMarker = null;
    return {
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

  function updateNav() {
    if (!dest) return;
    navEl.hidden = false;
    navEl.href = 'https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=' + dest.join(',') +
      (here ? '&origin=' + here.join(',') : '');
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
        checkNearby(); updateNav();
      }, err => { statusEl.className = 'card'; statusEl.textContent = 'เปิด GPS ไม่ได้: ' + err.message + ' (อนุญาตการเข้าถึงตำแหน่งในเบราว์เซอร์)'; },
      { enableHighAccuracy: true, maximumAge: 3000 });
      if (navigator.wakeLock) navigator.wakeLock.request('screen').catch(() => {});
    });

    const setFollow = on => { follow = on; followEl.textContent = 'ตามตำแหน่ง: ' + (on ? 'เปิด' : 'ปิด'); followEl.setAttribute('aria-pressed', on); };
    followEl.addEventListener('click', () => { setFollow(!follow); if (follow && here) map.pan(here); });
    map.onUserDrag(() => { if (follow) setFollow(false); });
    map.onLongPress(ll => { dest = ll; map.setDest(ll); updateNav(); });
  }).catch(() => { statusEl.textContent = 'โหลดแผนที่ไม่ได้ ตรวจสอบอินเทอร์เน็ตแล้วรีเฟรช'; });
})();
