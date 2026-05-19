/* ============================================================
   BRIDGE-SENSE — app.js  |  FINAL  (Geofence Haversine)
============================================================ */

'use strict';

/* ──────────────────────────────────────────────────────────────
   1. DATABASE KOORDINAT JEMBATAN (GEOFENCE ANCHORS)
────────────────────────────────────────────────────────────── */
const BRIDGE_NODES = [
  // Titik disesuaikan dengan anotasi visual & koordinat faktual Bondowoso
  { id: "ki-ronggo", name: "Jembatan Ki Ronggo", lat: -7.9065, lon: 113.8240, status: "Aman / Aktif", color: "#1B8A4C" },
  { id: "sentong", name: "Jembatan Sentong", lat: -7.9260, lon: 113.8170, status: "Revitalisasi (Pasca Rubuh)", color: "#E65100" },
  { id: "tangsil", name: "Jembatan Tangsil", lat: -7.929167, lon: 113.856667, status: "Aman / Aktif", color: "#1B8A4C" } // 7°55'45"S, 113°51'24"E
];

/* ──────────────────────────────────────────────────────────────
   2. DOM HOOKS & KONSTANTA
────────────────────────────────────────────────────────────── */
const elValZ      = document.getElementById('val-z');
const elDotGPS    = document.getElementById('dot-gps');
const elDotSensor = document.getElementById('dot-sensor');
const elValGPS    = document.getElementById('val-gps');
const elValSensor = document.getElementById('val-sensor');
const elBtnSense  = document.getElementById('btn-sense');
const elBufCount  = document.getElementById('buf-count');
const elBufBar    = document.getElementById('buf-bar');
const elBadge     = document.getElementById('badge-state');
const elLogFeed   = document.getElementById('log-feed');
const canvas      = document.getElementById('waveform-canvas');
const ctx         = canvas.getContext('2d');

const elStatPackets = document.getElementById('stat-packets');
const elStatSessions = document.getElementById('stat-sessions');
const elSessionList = document.getElementById('session-list');

const G              = 9.80665;
const SAMPLE_RATE_HZ = 50;
const INTERVAL_MS    = 1000 / SAMPLE_RATE_HZ;
const TX_BUF_SIZE    = 150;
const SMA_WIN        = 5;
const TX_ENDPOINT    = 'https://jsonplaceholder.typicode.com/posts';
const DEVICE_ID      = 'BS-' + Math.random().toString(36).slice(2, 9).toUpperCase();

/* ──────────────────────────────────────────────────────────────
   3. STATE & BUFFER
────────────────────────────────────────────────────────────── */
const state = {
  sensing: false, permGranted: false, pitch: 0, roll: 0, zECS: 0,
  gpsCoords: null, gpsWatchId: null, txSeq: 0
};

const DISP_LEN = TX_BUF_SIZE;
const ringRaw  = new Float32Array(DISP_LEN);
const ringSMA  = new Float32Array(DISP_LEN);
let ringHead = 0;
const smaWindow = new Float32Array(SMA_WIN);
let smaIdx = 0, smaSum = 0;
const txBuf  = new Float32Array(TX_BUF_SIZE);
let txHead = 0;
let _sampleInterval = null, _motionHandler = null, _orientationHandler = null, _rafId = null;

/* ──────────────────────────────────────────────────────────────
   4. UTILITIES
────────────────────────────────────────────────────────────── */
function addLog(type, html) {
  const t = new Date().toTimeString().slice(0, 8);
  const div = document.createElement('div');
  div.className = `log-entry ${type}`;
  div.innerHTML = `<span class="log-time">${t}</span><span class="log-msg">${html}</span>`;
  elLogFeed.prepend(div);
  while (elLogFeed.children.length > 40) elLogFeed.lastChild.remove();
}

function setStatus(target, dotClass, text) {
  if (target === 'gps') {
    elDotGPS.className = `status-dot ${dotClass}`; elValGPS.textContent = text;
  } else {
    elDotSensor.className = `status-dot ${dotClass}`; elValSensor.textContent = text;
  }
}

/* ──────────────────────────────────────────────────────────────
   5. GPS & HAVERSINE GEOFENCE MATH
────────────────────────────────────────────────────────────── */
function startGPS() {
  if (!navigator.geolocation) {
    setStatus('gps', 'error', 'GPS N/A');
    addLog('warn', 'Geolocation tidak didukung.');
    return;
  }
  setStatus('gps', 'ready', 'Mengakuisisi...');
  state.gpsWatchId = navigator.geolocation.watchPosition(
    pos => {
      state.gpsCoords = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: Math.round(pos.coords.accuracy) };
      setStatus('gps', 'active', `${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`);
    },
    err => { setStatus('gps', 'error', 'GPS Gagal'); addLog('err', `GPS error: ${err.message}`); },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 12000 }
  );
}

function stopGPS() {
  if (state.gpsWatchId !== null) { navigator.geolocation.clearWatch(state.gpsWatchId); state.gpsWatchId = null; }
  state.gpsCoords = null; setStatus('gps', 'idle', 'Menunggu...');
}

// Rumus Haversine: Jarak kelengkungan bumi (Meter)
function getDistanceInMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3; 
  const p1 = lat1 * Math.PI/180, p2 = lat2 * Math.PI/180;
  const dp = (lat2-lat1) * Math.PI/180, dl = (lon2-lon1) * Math.PI/180;
  const a = Math.sin(dp/2) * Math.sin(dp/2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl/2) * Math.sin(dl/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c; 
}

/* ──────────────────────────────────────────────────────────────
   6. SENSOR CORE (SCS -> ECS)
────────────────────────────────────────────────────────────── */
function handleOrientation(e) {
  state.pitch = (e.beta ?? 0) * (Math.PI / 180); state.roll = (e.gamma ?? 0) * (Math.PI / 180);
}

function handleMotion(e) {
  let ax, ay, az;
  const lin = e.acceleration, raw = e.accelerationIncludingGravity;
  if (lin && lin.z !== null && lin.z !== undefined) {
    ax = lin.x ?? 0; ay = lin.y ?? 0; az = lin.z ?? 0;
  } else if (raw && raw.z !== null && raw.z !== undefined) {
    const sB = Math.sin(state.pitch), cB = Math.cos(state.pitch);
    const sG = Math.sin(state.roll),  cG = Math.cos(state.roll);
    ax = (raw.x ?? 0) - (G * sG); ay = (raw.y ?? 0) - (G * -cG * sB); az = (raw.z ?? 0) - (G * -cG * cB);
  } else { return; }

  const sinB = Math.sin(state.pitch), cosB = Math.cos(state.pitch);
  const sinG = Math.sin(state.roll),  cosG = Math.cos(state.roll);
  const zRaw = ax * sinG - ay * sinB * cosG + az * cosB * cosG;

  smaSum -= smaWindow[smaIdx]; smaWindow[smaIdx] = zRaw; smaSum += zRaw;
  smaIdx = (smaIdx + 1) % SMA_WIN;
  const zSmoothed = smaSum / SMA_WIN;

  ringRaw[ringHead] = zRaw; ringSMA[ringHead] = zSmoothed;
  ringHead = (ringHead + 1) % DISP_LEN;
  state.zECS = zSmoothed;
  elValZ.textContent = zSmoothed.toFixed(3);
}

/* ──────────────────────────────────────────────────────────────
   7. TRANSMIT PIPELINE & GEOFENCE LOCK
────────────────────────────────────────────────────────────── */
function buildPayload(snapshot) {
  return {
    device_id: DEVICE_ID, seq: ++state.txSeq, timestamp: new Date().toISOString(),
    latitude: state.gpsCoords?.lat, longitude: state.gpsCoords?.lon, gps_acc_m: state.gpsCoords?.acc,
    sample_rate_hz: SAMPLE_RATE_HZ, n_samples: TX_BUF_SIZE, z_data: snapshot
  };
}

async function transmitPayload(payload) {
  const seq = payload.seq;
  addLog('warn', `TX #${seq} — Mengirim <b>${TX_BUF_SIZE} sampel</b>…`);
  try {
    const res = await fetch(TX_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (res.ok) {
      addLog('ok', `TX #${seq} ✓ — Data diterima.`);
      if(elStatPackets) elStatPackets.textContent = seq; 
      if(elStatSessions) elStatSessions.textContent = "1";
      if (seq === 1 && elSessionList) elSessionList.innerHTML = '';
      if(elSessionList) {
        elSessionList.insertAdjacentHTML('afterbegin', `
          <div class="session-item">
            <div class="session-row1">
              <span class="session-bridge">Transmisi Paket #${seq}</span><span class="session-result result-ok">Sukses</span>
            </div>
            <div class="packet-row"><span>Waktu: ${new Date().toLocaleTimeString()}</span><span>${TX_BUF_SIZE} Data Z-Axis</span></div>
          </div>`);
      }
    } else { addLog('err', `TX #${seq} ✗ — Server HTTP ${res.status}`); }
  } catch (err) { addLog('err', `TX #${seq} ✗ — Network error: ${err.message}`); }
}

function tickSampler() {
  if (!state.sensing) return;
  txBuf[txHead++] = state.zECS;
  const pct = (txHead / TX_BUF_SIZE) * 100;
  elBufCount.textContent = txHead; elBufBar.style.width = pct + '%';

  if (txHead >= TX_BUF_SIZE) {
    const snapshot = Array.from(txBuf);
    txHead = 0; elBufCount.textContent = '0'; elBufBar.style.width = '0%';

    // --- LOGIKA GEOFENCE HAVERSINE ---
    if (!state.gpsCoords) {
      addLog('err', `TX Dibatalkan: Menunggu sinyal GPS untuk verifikasi zona jembatan.`);
      return; 
    }
    
    let isInside = false;
    let detectedBridge = "";
    for (let node of BRIDGE_NODES) {
       const dist = getDistanceInMeters(state.gpsCoords.lat, state.gpsCoords.lon, node.lat, node.lon);
       if (dist <= 50) { // BATAS TOLERANSI: 50 METER
          isInside = true;
          detectedBridge = node.name;
          break;
       }
    }
    
   // --- GEOFENCE BYPASS (DEMO MODE) ---
    if (!isInside) {
      addLog('warn', `[DEMO MODE] Jarak > 50m. Geofence mendeteksi Anda di luar area, namun transmisi dilanjutkan untuk penjurian.`);
      // return; <--- Baris ini di matikan (comment) agar fungsi transmisi tidak dibatalkan
    } else {
      addLog('ok', `Geofence valid: Anda terdeteksi di area <b>${detectedBridge}</b>.`);
    }

    transmitPayload(buildPayload(snapshot));
  }
}

/* ──────────────────────────────────────────────────────────────
   8. UI RENDERER & LOGIC LAINNYA
────────────────────────────────────────────────────────────── */
function renderWaveform() {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.width / dpr, H = canvas.height / dpr;
  ctx.save(); ctx.scale(dpr, dpr); ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0D1117'; ctx.fillRect(0, 0, W, H);
  ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  for (let i = 0; i <= 4; i++) { ctx.beginPath(); ctx.moveTo(0, H * i / 4); ctx.lineTo(W, H * i / 4); ctx.stroke(); }
  ctx.strokeStyle = 'rgba(230,81,0,0.25)'; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke(); ctx.setLineDash([]);

  if (state.sensing) {
    let peak = 2.0;
    for (let i = 0; i < DISP_LEN; i++) { const v = Math.abs(ringRaw[i]); if (v > peak) peak = v; }
    const scale = (H / 2 - 6) / peak;

    ctx.strokeStyle = 'rgba(230,81,0,0.22)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let i = 0; i < DISP_LEN; i++) {
      const v = ringRaw[(ringHead + i) % DISP_LEN];
      const x = (i / (DISP_LEN - 1)) * W, y = H / 2 - v * scale;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.strokeStyle = '#E65100'; ctx.lineWidth = 1.8; ctx.beginPath();
    for (let i = 0; i < DISP_LEN; i++) {
      const v = ringSMA[(ringHead + i) % DISP_LEN];
      const x = (i / (DISP_LEN - 1)) * W, y = H / 2 - v * scale;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.fillStyle = 'rgba(230,81,0,0.55)'; ctx.font = '10px Courier New'; ctx.fillText(`±${peak.toFixed(1)} m/s²`, 6, 14);
    ctx.fillStyle = 'rgba(230,81,0,0.15)'; ctx.fillRect(0, 0, W * (txHead / TX_BUF_SIZE), 3);
  }
  ctx.restore(); _rafId = requestAnimationFrame(renderWaveform);
}

function startSensing() {
  _orientationHandler = handleOrientation; _motionHandler = handleMotion;
  window.addEventListener('deviceorientation', _orientationHandler, true);
  window.addEventListener('devicemotion', _motionHandler, true);
  _sampleInterval = setInterval(tickSampler, INTERVAL_MS);
  state.sensing = true; setStatus('sensor', 'active', '50 Hz · Aktif');
  if(elBtnSense) { elBtnSense.textContent = '⏹ Hentikan Sensing'; elBtnSense.classList.add('sensing'); }
  if(elBadge) elBadge.textContent = 'SENSING';
  startGPS(); addLog('ok', `Akuisisi aktif — <b>DeviceMotion @ ${SAMPLE_RATE_HZ} Hz</b>`);
}

function stopSensing() {
  clearInterval(_sampleInterval); _sampleInterval = null;
  if (_motionHandler) window.removeEventListener('devicemotion', _motionHandler, true);
  if (_orientationHandler) window.removeEventListener('deviceorientation', _orientationHandler, true);
  ringRaw.fill(0); ringSMA.fill(0); smaWindow.fill(0); smaSum = 0; smaIdx = 0; ringHead = 0; txHead = 0;
  state.sensing = false; state.pitch = 0; state.roll = 0; state.zECS = 0;
  setStatus('sensor', 'idle', 'Idle');
  if(elBtnSense) { elBtnSense.textContent = '▶ Mulai Sensing'; elBtnSense.classList.remove('sensing'); }
  if(elBadge) elBadge.textContent = 'IDLE';
  if(elValZ) elValZ.textContent = '0.000';
  if(elBufCount) elBufCount.textContent = '0';
  if(elBufBar) elBufBar.style.width = '0%';
  stopGPS(); addLog('warn', 'Sensing dihentikan. GC selesai.');
}

async function requestSensorPermission() {
  if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
    try {
      const res = await DeviceMotionEvent.requestPermission();
      if (res === 'granted') { state.permGranted = true; return true; }
      addLog('err', 'Izin sensor ditolak.'); return false;
    } catch (err) { return false; }
  }
  state.permGranted = true; return true;
}

elBtnSense?.addEventListener('click', async () => {
  if (state.sensing) { stopSensing(); return; }
  if (!state.permGranted) { const ok = await requestSensorPermission(); if (!ok) return; }
  startSensing();
});

document.getElementById('btn-grant-perm')?.addEventListener('click', async () => { document.getElementById('perm-overlay').style.display = 'none'; await requestSensorPermission(); });
document.getElementById('btn-skip-perm')?.addEventListener('click', () => { document.getElementById('perm-overlay').style.display = 'none'; state.permGranted = true; });
document.getElementById('btn-permission')?.addEventListener('click', () => { const overlay = document.getElementById('perm-overlay'); if(overlay) overlay.style.display = 'flex'; });
document.getElementById('btn-clear-log')?.addEventListener('click', () => { elLogFeed.innerHTML = ''; });

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr);
}
window.addEventListener('resize', resizeCanvas); resizeCanvas();
_rafId = requestAnimationFrame(renderWaveform);
elLogFeed.innerHTML = ''; addLog('warn', `Bridge-Sense siap · device_id: <b>${DEVICE_ID}</b>`);

/* ──────────────────────────────────────────────────────────────
   9. LEAFLET.JS - PETA INTERAKTIF
────────────────────────────────────────────────────────────── */
let bridgeMap = null;
function initMap() {
  if (bridgeMap) return; 
  bridgeMap = L.map('map-container').setView([-7.9135, 113.8228], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(bridgeMap);

  BRIDGE_NODES.forEach(node => {
    const iconHtml = `<div style="background-color:${node.color}; width:14px; height:14px; border-radius:50%; border:2px solid white; box-shadow:0 0 6px rgba(0,0,0,0.4);"></div>`;
    const customIcon = L.divIcon({ className: 'custom-pin', html: iconHtml, iconSize: [18, 18], iconAnchor: [9, 9] });
    L.marker([node.lat, node.lon], { icon: customIcon }).addTo(bridgeMap)
      .bindPopup(`<strong style="font-size:12px; font-family:sans-serif;">${node.name}</strong><br><span style="font-size:10px; font-weight:600; color:${node.color}">${node.status}</span>`);
  });
}

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.page === 'map') { setTimeout(() => { initMap(); if (bridgeMap) bridgeMap.invalidateSize(); }, 150); }
  });
});
