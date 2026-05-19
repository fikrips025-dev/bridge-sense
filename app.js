/* ============================================================
   BRIDGE-SENSE — app.js  |  FINAL  (Tahap 2 + Tahap 3)
   Tahap 2 : Permission · Akuisisi · SCS→ECS · SMA · Waveform
   Tahap 3 : TX Buffer · JSON Payload · fetch POST · GC · UI sync
============================================================ */

'use strict';

/* ──────────────────────────────────────────────────────────────
   1. DOM HOOKS
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
const elStatPackets = document.getElementById('stat-packets');
const elStatSessions = document.getElementById('stat-sessions');
const elSessionList = document.getElementById('session-list');
const canvas      = document.getElementById('waveform-canvas');
const ctx         = canvas.getContext('2d');

/* ──────────────────────────────────────────────────────────────
   2. KONSTANTA SISTEM
────────────────────────────────────────────────────────────── */
const G              = 9.80665;           // gravitasi standar [m/s²]
const SAMPLE_RATE_HZ = 50;               // kontrak sampling
const INTERVAL_MS    = 1000 / SAMPLE_RATE_HZ; // 20 ms / sampel
const TX_BUF_SIZE    = 150;              // 150 titik = 3 detik
const SMA_WIN        = 5;               // window SMA (~100 ms)
const TX_ENDPOINT    = 'https://jsonplaceholder.typicode.com/posts';
const DEVICE_ID      = 'BS-' + Math.random().toString(36).slice(2, 9).toUpperCase();

/* ──────────────────────────────────────────────────────────────
   3. STATE SINGLETON
────────────────────────────────────────────────────────────── */
const state = {
  sensing:     false,
  permGranted: false,
  pitch:       0,       // β [rad]
  roll:        0,       // γ [rad]
  zECS:        0,       // output proyeksi vertikal ECS (post-SMA)
  gpsCoords:   null,    // { lat, lon, acc }
  gpsWatchId:  null,
  txSeq:       0,       // nomor urut paket transmisi
};

/* ──────────────────────────────────────────────────────────────
   4. BUFFER DEKLARASI

   Dua buffer dengan tanggung jawab berbeda — tidak pernah dicampur:

   ┌─ ringRaw / ringSMA ─────────────────────────────────────┐
   │  Circular display buffer (Float32Array — ukuran tetap)  │
   │  Hanya untuk render waveform pada canvas.               │
   │  Tidak pernah dikirim ke server.                        │
   └─────────────────────────────────────────────────────────┘

   ┌─ txBuf ─────────────────────────────────────────────────┐
   │  Transmit buffer (Float32Array — ukuran tetap TX_BUF).  │
   │  Diisi oleh setInterval 50 Hz.                          │
   │  Di-GC (txHead = 0) SEKETIKA setelah fetch() dipanggil. │
   └─────────────────────────────────────────────────────────┘
────────────────────────────────────────────────────────────── */
const DISP_LEN = TX_BUF_SIZE;
const ringRaw  = new Float32Array(DISP_LEN);
const ringSMA  = new Float32Array(DISP_LEN);
let   ringHead = 0;

const smaWindow = new Float32Array(SMA_WIN);
let   smaIdx    = 0;
let   smaSum    = 0;

/* Transmit buffer — indeks txHead adalah satu-satunya "length" counter.
   Float32Array panjangnya tetap; reset = set txHead ke 0.            */
const txBuf  = new Float32Array(TX_BUF_SIZE);
let   txHead = 0;

/* Handle interval 50 Hz */
let _sampleInterval    = null;
let _motionHandler     = null;
let _orientationHandler= null;
let _rafId             = null;

/* ──────────────────────────────────────────────────────────────
   5. UTILITY: LOG FEED
────────────────────────────────────────────────────────────── */
function addLog(type, html) {
  const t   = new Date().toTimeString().slice(0, 8);
  const div = document.createElement('div');
  div.className = `log-entry ${type}`;
  div.innerHTML = `<span class="log-time">${t}</span>`
                + `<span class="log-msg">${html}</span>`;
  elLogFeed.prepend(div);
  while (elLogFeed.children.length > 40) elLogFeed.lastChild.remove();
}

/* ──────────────────────────────────────────────────────────────
   6. UTILITY: STATUS CHIP
────────────────────────────────────────────────────────────── */
function setStatus(target, dotClass, text) {
  if (target === 'gps') {
    elDotGPS.className   = `status-dot ${dotClass}`;
    elValGPS.textContent  = text;
  } else {
    elDotSensor.className   = `status-dot ${dotClass}`;
    elValSensor.textContent  = text;
  }
}

/* ──────────────────────────────────────────────────────────────
   7. GPS WATCHER
────────────────────────────────────────────────────────────── */
function startGPS() {
  if (!navigator.geolocation) {
    setStatus('gps', 'error', 'GPS N/A');
    addLog('warn', 'Geolocation API tidak didukung perangkat ini.');
    return;
  }
  setStatus('gps', 'ready', 'Mengakuisisi...');
  state.gpsWatchId = navigator.geolocation.watchPosition(
    pos => {
      state.gpsCoords = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        acc: Math.round(pos.coords.accuracy),
      };
      setStatus(
        'gps', 'active',
        `${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`
      );
    },
    err => {
      setStatus('gps', 'error', 'GPS Gagal');
      addLog('err', `GPS error: ${err.message}`);
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 12000 }
  );
}

function stopGPS() {
  if (state.gpsWatchId !== null) {
    navigator.geolocation.clearWatch(state.gpsWatchId);
    state.gpsWatchId = null;
  }
  state.gpsCoords = null;
  setStatus('gps', 'idle', 'Menunggu...');
}

/* ──────────────────────────────────────────────────────────────
   8. DEVICEORIENTATION HANDLER  (Pitch & Roll → radian)
────────────────────────────────────────────────────────────── */
function handleOrientation(e) {
  state.pitch = (e.beta  ?? 0) * (Math.PI / 180);
  state.roll  = (e.gamma ?? 0) * (Math.PI / 180);
}

/* ──────────────────────────────────────────────────────────────
   9. DEVICEMOTION HANDLER  +  SCS → ECS TRANSFORMATION

   Hierarki sumber data:
     Tier-1 → event.acceleration           [linear, tanpa gravitasi]
     Tier-2 → event.accelerationIncludingGravity + subtraksi manual

   Subtraksi gravitasi manual (Tier-2):
     g_x =  G · sin(γ)
     g_y = -G · cos(γ) · sin(β)
     g_z = -G · cos(γ) · cos(β)

   Proyeksi vertikal SCS → ECS (2-axis, tanpa yaw):
     Z_ECS = Ax · sin(γ)
           - Ay · sin(β) · cos(γ)
           + Az · cos(β) · cos(γ)

   Output Z_ECS lalu difilter SMA → disimpan ke state.zECS.
   Nilai mentah (pre-SMA) dan smoothed keduanya masuk ring display.
────────────────────────────────────────────────────────────── */
function handleMotion(e) {
  let ax, ay, az;

  const lin = e.acceleration;
  const raw = e.accelerationIncludingGravity;

  if (lin && lin.z !== null && lin.z !== undefined) {
    ax = lin.x ?? 0;
    ay = lin.y ?? 0;
    az = lin.z ?? 0;
  } else if (raw && raw.z !== null && raw.z !== undefined) {
    const sB = Math.sin(state.pitch), cB = Math.cos(state.pitch);
    const sG = Math.sin(state.roll),  cG = Math.cos(state.roll);
    ax = (raw.x ?? 0) - (G *  sG);
    ay = (raw.y ?? 0) - (G * -cG * sB);
    az = (raw.z ?? 0) - (G * -cG * cB);
  } else {
    return;
  }

  /* SCS → ECS */
  const sinB = Math.sin(state.pitch), cosB = Math.cos(state.pitch);
  const sinG = Math.sin(state.roll),  cosG = Math.cos(state.roll);
  const zRaw = ax * sinG - ay * sinB * cosG + az * cosB * cosG;

  /* SMA */
  smaSum           -= smaWindow[smaIdx];
  smaWindow[smaIdx] = zRaw;
  smaSum           += zRaw;
  smaIdx            = (smaIdx + 1) % SMA_WIN;
  const zSmoothed   = smaSum / SMA_WIN;

  /* Display ring buffer */
  ringRaw[ringHead] = zRaw;
  ringSMA[ringHead] = zSmoothed;
  ringHead          = (ringHead + 1) % DISP_LEN;

  /* Expose untuk interval sampler */
  state.zECS = zSmoothed;

  /* DOM: nilai Z langsung dari sensor thread */
  elValZ.textContent = zSmoothed.toFixed(3);
}

/* ──────────────────────────────────────────────────────────────
   10. TAHAP 3 — TRANSMIT PIPELINE

   setInterval 50 Hz membaca state.zECS (hasil terbaru dari
   DeviceMotion handler) lalu mendorongnya ke txBuf.

   Pemisahan antara event-driven sensor (handleMotion) dan
   interval sampler ini penting: DeviceMotion tidak dijamin
   tiba tepat 50 Hz di semua platform. Interval bertindak
   sebagai "clock master" yang konsisten.

   Ketika txHead === TX_BUF_SIZE:
     1. Snapshot txBuf ke Array biasa  → payload JSON
     2. txHead = 0  (GARBAGE COLLECT — seketika, sync)
     3. fetch() dipanggil secara async — tidak memblokir GC
────────────────────────────────────────────────────────────── */
function buildPayload(snapshot) {
  const coords = state.gpsCoords;
  return {
    device_id:  DEVICE_ID,
    seq:        ++state.txSeq,
    timestamp:  new Date().toISOString(),
    latitude:   coords ? coords.lat : null,
    longitude:  coords ? coords.lon : null,
    gps_acc_m:  coords ? coords.acc : null,
    sample_rate_hz: SAMPLE_RATE_HZ,
    n_samples:  TX_BUF_SIZE,
    z_data:     snapshot,              // Array 150 × float [m/s²]
  };
}

async function transmitPayload(payload) {
  const seq   = payload.seq;
  const bytes = JSON.stringify(payload).length;
  addLog('warn', `TX #${seq} — Mengirim <b>${TX_BUF_SIZE} sampel</b> (${bytes} B)…`);

  try {
    const res = await fetch(TX_ENDPOINT, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    if (res.ok) {
      const json = await res.json();
      addLog(
        'ok',
        `TX #${seq} ✓ — HTTP ${res.status} · `
        + `lat=${payload.latitude?.toFixed(5) ?? 'N/A'} `
        + `lon=${payload.longitude?.toFixed(5) ?? 'N/A'} `
        + `· id_server=${json.id ?? '–'}`
      );
    } else {
      addLog('err', `TX #${seq} ✗ — Server HTTP ${res.status}`);
    }
  } catch (err) {
    addLog('err', `TX #${seq} ✗ — Network error: ${err.message}`);
  }
}

function tickSampler() {
  if (!state.sensing) return;

  /* ── Push sampel ke TX buffer ── */
  txBuf[txHead] = state.zECS;
  txHead++;

  /* ── Update progress UI ── */
  const pct = (txHead / TX_BUF_SIZE) * 100;
  elBufCount.textContent = txHead;
  elBufBar.style.width   = pct + '%';

  /* ── Buffer penuh → TRANSMIT ── */
  if (txHead >= TX_BUF_SIZE) {
    /* 1. Snapshot: salin ke plain Array SEBELUM GC */
    const snapshot = Array.from(txBuf);

    /* 2. GARBAGE COLLECT — sync, seketika, sebelum await apapun */
    txHead = 0;
    elBufCount.textContent = '0';
    elBufBar.style.width   = '0%';

    /* 3. Kirim secara async — tidak memblokir sampler berikutnya */
    transmitPayload(buildPayload(snapshot));
  }
}

/* ──────────────────────────────────────────────────────────────
   11. WAVEFORM RENDERER  (rAF loop)
────────────────────────────────────────────────────────────── */
function renderWaveform() {
  const dpr = window.devicePixelRatio || 1;
  const W   = canvas.width  / dpr;
  const H   = canvas.height / dpr;

  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  /* Background */
  ctx.fillStyle = '#0D1117';
  ctx.fillRect(0, 0, W, H);

  /* Grid */
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  for (let i = 0; i <= 4; i++) {
    ctx.beginPath();
    ctx.moveTo(0, H * i / 4);
    ctx.lineTo(W, H * i / 4);
    ctx.stroke();
  }

  /* Zero line */
  ctx.strokeStyle = 'rgba(230,81,0,0.25)';
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(0, H / 2);
  ctx.lineTo(W, H / 2);
  ctx.stroke();
  ctx.setLineDash([]);

  if (state.sensing) {
    /* Auto-scale Y */
    let peak = 2.0;
    for (let i = 0; i < DISP_LEN; i++) {
      const v = Math.abs(ringRaw[i]);
      if (v > peak) peak = v;
    }
    const scale = (H / 2 - 6) / peak;

    /* Raw trace */
    ctx.strokeStyle = 'rgba(230,81,0,0.22)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    for (let i = 0; i < DISP_LEN; i++) {
      const v = ringRaw[(ringHead + i) % DISP_LEN];
      const x = (i / (DISP_LEN - 1)) * W;
      const y = H / 2 - v * scale;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    /* SMA trace */
    ctx.strokeStyle = '#E65100';
    ctx.lineWidth   = 1.8;
    ctx.beginPath();
    for (let i = 0; i < DISP_LEN; i++) {
      const v = ringSMA[(ringHead + i) % DISP_LEN];
      const x = (i / (DISP_LEN - 1)) * W;
      const y = H / 2 - v * scale;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    /* Scale label */
    ctx.fillStyle = 'rgba(230,81,0,0.55)';
    ctx.font      = '10px Courier New';
    ctx.fillText(`±${peak.toFixed(1)} m/s²`, 6, 14);

    /* TX fill indicator (orange band di atas canvas) */
    const txPct = txHead / TX_BUF_SIZE;
    ctx.fillStyle = 'rgba(230,81,0,0.15)';
    ctx.fillRect(0, 0, W * txPct, 3);
  }

  ctx.restore();
  _rafId = requestAnimationFrame(renderWaveform);
}

/* ──────────────────────────────────────────────────────────────
   12. START / STOP SENSING
────────────────────────────────────────────────────────────── */
function startSensing() {
  _orientationHandler = handleOrientation;
  _motionHandler      = handleMotion;

  window.addEventListener('deviceorientation', _orientationHandler, true);
  window.addEventListener('devicemotion',      _motionHandler,      true);

  /* Interval sampler 50 Hz — master clock TX pipeline */
  _sampleInterval = setInterval(tickSampler, INTERVAL_MS);

  state.sensing = true;
  setStatus('sensor', 'active', '50 Hz · Aktif');
  elBtnSense.textContent = '⏹ Hentikan Sensing';
  elBtnSense.classList.add('sensing');
  elBadge.textContent    = 'SENSING';

  startGPS();
  addLog('ok',
    `Akuisisi aktif — <b>DeviceMotion @ ${SAMPLE_RATE_HZ} Hz</b> · `
    + `device_id: <b>${DEVICE_ID}</b> · TX tiap 3 s.`
  );
}

function stopSensing() {
  /* Hentikan sampler & sensor listeners */
  clearInterval(_sampleInterval); _sampleInterval = null;

  if (_motionHandler) {
    window.removeEventListener('devicemotion', _motionHandler, true);
    _motionHandler = null;
  }
  if (_orientationHandler) {
    window.removeEventListener('deviceorientation', _orientationHandler, true);
    _orientationHandler = null;
  }

  /* Reset semua buffer */
  ringRaw.fill(0); ringSMA.fill(0);
  smaWindow.fill(0); smaSum = 0; smaIdx = 0; ringHead = 0;
  txHead = 0;                                // GC transmit buffer

  state.sensing = false;
  state.pitch   = 0;
  state.roll    = 0;
  state.zECS    = 0;

  /* Reset UI */
  setStatus('sensor', 'idle', 'Idle');
  elBtnSense.textContent = '▶ Mulai Sensing';
  elBtnSense.classList.remove('sensing');
  elBadge.textContent    = 'IDLE';
  elValZ.textContent     = '0.000';
  elBufCount.textContent = '0';
  elBufBar.style.width   = '0%';

  stopGPS();
  addLog('warn', 'Sensing dihentikan. Semua buffer dikosongkan (GC selesai).');
}

/* ──────────────────────────────────────────────────────────────
   13. PERMISSION FLOW  (iOS 13+ DeviceMotionEvent.requestPermission)
────────────────────────────────────────────────────────────── */
async function requestSensorPermission() {
  if (
    typeof DeviceMotionEvent !== 'undefined' &&
    typeof DeviceMotionEvent.requestPermission === 'function'
  ) {
    try {
      const res = await DeviceMotionEvent.requestPermission();
      if (res === 'granted') {
        state.permGranted = true;
        addLog('ok', 'Izin <b>DeviceMotion</b> diberikan (iOS 13+).');
        return true;
      }
      addLog('err', 'Izin sensor <b>ditolak</b>. Sensing tidak dapat dimulai.');
      return false;
    } catch (err) {
      addLog('err', `Permission error: ${err.message}`);
      return false;
    }
  }
  state.permGranted = true;
  addLog('ok', 'DeviceMotion tersedia (izin implisit — non-iOS).');
  return true;
}

/* ──────────────────────────────────────────────────────────────
   14. BUTTON & OVERLAY WIRING (PATCHED)
────────────────────────────────────────────────────────────── */
// Gunakan ?. (Optional Chaining) agar tidak crash jika ID tidak ada di HTML
elBtnSense?.addEventListener('click', async () => {
  if (state.sensing) { stopSensing(); return; }
  if (!state.permGranted) {
    const ok = await requestSensorPermission();
    if (!ok) return;
  }
  startSensing();
});

document.getElementById('btn-grant-perm')?.addEventListener('click', async () => {
  document.getElementById('perm-overlay').style.display = 'none';
  await requestSensorPermission();
});

document.getElementById('btn-skip-perm')?.addEventListener('click', () => {
  document.getElementById('perm-overlay').style.display = 'none';
  state.permGranted = true;
  addLog('warn', 'Demo mode: izin sensor dilewati.');
});

document.getElementById('btn-permission')?.addEventListener('click', () => {
  const overlay = document.getElementById('perm-overlay');
  if(overlay) overlay.style.display = 'flex';
});

document.getElementById('btn-clear-log')?.addEventListener('click', () => {
  elLogFeed.innerHTML = '';
});

/* Filter chip (nav Map) */
document.querySelectorAll('.filter-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    chip.closest('.bridge-filter')
        ?.querySelectorAll('.filter-chip')
        .forEach(c => c.classList.toggle('active', c === chip));
  });
});

/* ──────────────────────────────────────────────────────────────
   15. CANVAS RESIZE
────────────────────────────────────────────────────────────── */
function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr  = window.devicePixelRatio || 1;
  canvas.width  = Math.round(rect.width  * dpr);
  canvas.height = Math.round(rect.height * dpr);
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

/* ──────────────────────────────────────────────────────────────
   16. INIT
────────────────────────────────────────────────────────────── */
_rafId = requestAnimationFrame(renderWaveform);
elLogFeed.innerHTML = '';
addLog('warn',
  `Bridge-Sense siap · device_id: <b>${DEVICE_ID}</b> · `
  + `Endpoint: <b>${TX_ENDPOINT}</b>`
);
