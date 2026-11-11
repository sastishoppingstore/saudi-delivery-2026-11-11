// Fiasta Driver App (PWA)
const { api, t, store, toast, SAR, statusLabel, esc, renderMap } = FIA;
const view = document.getElementById('view');
let socket = null, me = null, gpsTimer = null;

(async function boot() {
  await FIA.ready;
  FIA.applyDir();
  if (store.token) {
    try {
      const r = await api('/me');
      if (r.user.role !== 'driver') { store.token = ''; return renderLogin(); }
      me = r;
      return renderHome();
    } catch { store.token = ''; }
  }
  renderLogin();
})();

function connectSocket() {
  if (socket) socket.disconnect();
  socket = io({ auth: { token: store.token } });
  socket.on('order:offer', (d) => { toast('🔔 طلب جديد! ' + (d.waybill || '')); renderHome(); });
  socket.on('order:updated', (d) => { if (state.activeId && d.orderId === state.activeId) renderJob(true); });
}

const state = { activeId: null, tab: 'available' };

// ---------- login ----------
function renderLogin() {
  view.innerHTML = `
  <div class="hero"><h1>Fiasta Driver</h1><p>بوابة السائقين — Jeddah fleet</p></div>
  <div class="page"><div class="card fade-in">
    <h3>${t('login')}</h3>
    <label class="f">${t('phone')}</label>
    <input id="phone" inputmode="tel" placeholder="05XXXXXXXX" dir="ltr">
    <div id="otpArea" style="display:none">
      <label class="f">${t('code')}</label>
      <input id="code" inputmode="numeric" maxlength="6" dir="ltr" style="text-align:center;font-size:22px;font-weight:800;letter-spacing:6px">
      <p class="small muted" id="hint" style="margin-top:6px"></p>
    </div>
    <div style="height:14px"></div>
    <button class="btn" id="go">${t('sendCode')}</button>
    <div class="divider"></div>
    <button class="btn secondary sm" style="width:100%" onclick="regMode()">تسجيل سائق جديد / Register as driver</button>
  </div></div>`;
  let sent = false, registering = false;
  const go = document.getElementById('go');
  go.onclick = async () => {
    const phone = document.getElementById('phone').value.trim();
    if (!/^05\d{8}$/.test(phone)) return toast('رقم غير صحيح');
    if (!sent) {
      try {
        const code = await FIA.otpLogin(phone);
        sent = true;
        document.getElementById('otpArea').style.display = 'block';
        document.getElementById('hint').textContent = code ? `Demo code: ${code}` : 'SMS sent';
        go.textContent = t('verify');
      } catch (e) { toast(e.message); }
    } else {
      try {
        const r = await api('/auth/otp/verify', { method: 'POST', body: { phone, code: document.getElementById('code').value.trim() } });
        store.token = r.token; store.user = r.user;
        if (r.user.role !== 'driver') { toast('هذا الحساب ليس سائقاً / not a driver account'); store.token = ''; return; }
        const m = await api('/me'); me = m;
        connectSocket(); renderHome();
      } catch (e) { toast(e.message); }
    }
  };
  window.regMode = () => {
    registering = !registering;
    document.getElementById('go').textContent = registering ? 'تسجيل / Register' : t('sendCode');
    if (registering) {
      document.getElementById('phone').insertAdjacentHTML('afterend', `
        <label class="f">الاسم / Name</label><input id="dName" placeholder="Mohammed">
        <label class="f">رخصة القيادة / License no</label><input id="dLic" dir="ltr" placeholder="DL-400098">
        <label class="f">الهوية / National ID</label><input id="dNid" dir="ltr" placeholder="10xxxxxx8">`);
    }
    go.onclick = async () => {
      const phone = document.getElementById('phone').value.trim();
      if (!registering) return go.onclick;
      if (!sent) {
        const code = await FIA.otpLogin(phone);
        sent = true;
        document.getElementById('otpArea').style.display = 'block';
        document.getElementById('hint').textContent = code ? `Demo code: ${code}` : 'SMS sent';
      } else {
        try {
          await api('/auth/driver/register', { method: 'POST', body: {
            phone, code: document.getElementById('code').value.trim(),
            name: document.getElementById('dName')?.value || '', licenseNo: document.getElementById('dLic')?.value || '',
            nationalId: document.getElementById('dNid')?.value || '',
          } });
          toast('✓ تم التسجيل — بانتظار موافقة الإدارة');
          go.onclick = null; sent = false; registering = false; renderLogin();
        } catch (e) { toast(e.message); }
      }
    };
  };
}

// ---------- home ----------
async function renderHome() {
  connectSocket();
  const r = await api('/me');
  me = r;
  const p = r.profile || {};
  view.innerHTML = `
  <div class="topbar"><div class="logo">F</div><h1>Fiasta Driver</h1>
    <div class="row" style="gap:8px"><span class="small">${p.availability === 'online' ? '🟢' : '⚪'}</span>
    <div class="switch ${p.availability !== 'offline' ? 'on' : ''}" id="availSw" onclick="toggleAvail()"></div></div></div>
  <div class="page">
    ${!p.approved ? `<div class="card" style="border:2px solid var(--amber)"><b>⏳ بانتظار موافقة الإدارة</b><div class="small muted">Admin approval required before going online.</div></div>` : ''}
    <div class="card"><div class="row between">
      <div><b>${esc(r.user.name || '—')}</b><div class="small muted" dir="ltr">${esc(r.user.phone)}</div>
      <div class="small muted">⭐ ${p.rating?.toFixed?.(1) || '5.0'} • ${p.total_jobs || 0} jobs</div></div>
      <div style="text-align:end"><div class="small muted">المركبة / Vehicle</div>
      <b class="small">${esc(p.model || '—')}</b><div class="small muted" dir="ltr">${esc(p.plate || '')}</div>
      ${p.lpg_approved ? '<span class="badge amber">LPG approved</span>' : ''}</div>
    </div></div>
    <div class="pill-tabs">
      <button class="${state.tab === 'available' ? 'active' : ''}" onclick="tabSet('available')">${t('available')}</button>
      <button class="${state.tab === 'active' ? 'active' : ''}" onclick="tabSet('active')">🚚 ${t('liveTracking')}</button>
      <button class="${state.tab === 'earnings' ? 'active' : ''}" onclick="tabSet('earnings')">💰 ${t('earnings')}</button>
    </div>
    <div id="tabBody">${t('loading')}</div>
  </div>`;
  loadTab();
}
window.tabSet = (x) => { state.tab = x; renderHome(); };
window.toggleAvail = async () => {
  const next = me.profile.availability === 'online' ? 'offline' : 'online';
  try { await api('/driver/availability', { method: 'POST', body: { status: next } }); renderHome(); }
  catch (e) { toast(e.message); }
};

async function loadTab() {
  const el = document.getElementById('tabBody');
  if (state.tab === 'available') {
    const jobs = await api('/driver/jobs/available').catch(() => []);
    el.innerHTML = jobs.length ? jobs.map((j) => `
      <div class="card offer-card fade-in">
        <div class="row between"><b>${j.waybill}</b><span class="km">📍 ${j.distanceToPickupKm} km</span></div>
        <div class="small muted">${esc(j.category_en || j.category_ar)} ${j.priority === 'priority' ? '• ⚡ priority' : ''} ${j.is_scheduled ? '• 📅 ' + esc(j.scheduled_for || '') : ''}</div>
        <div class="small muted">💵 ${SAR(j.delivery_fee)} (your share ~${SAR(j.delivery_fee * 0.7)})</div>
        <div class="row" style="margin-top:10px;gap:8px">
          <button class="btn sm" style="flex:1" onclick="acceptJob(${j.id})">✓ ${t('accept')}</button>
        </div>
      </div>`).join('') : `<div class="empty"><div class="ic">🚚</div>${t('empty')}</div>`;
  } else if (state.tab === 'active') {
    const act = await api('/driver/jobs/active').catch(() => []);
    el.innerHTML = act.length ? act.map((a) => `
      <div class="card fade-in" style="cursor:pointer" onclick="openJob(${a.orderId})">
        <div class="row between"><b>طلب #${a.orderId}</b><span style="font-size:22px">🚚</span></div>
        <div class="small muted">${t('liveTracking')} →</div></div>`).join('')
      : `<div class="empty"><div class="ic">🛻</div>${t('empty')}</div>`;
  } else {
    const e = await api('/driver/earnings');
    el.innerHTML = `<div class="grid3">
      <div class="kpi"><div class="v">${SAR(e.today.gross)}</div><div class="l">${t('today')}</div></div>
      <div class="kpi"><div class="v">${SAR(e.week.gross)}</div><div class="l">${t('week')}</div></div>
      <div class="kpi accent"><div class="v">${SAR(e.month.gross)}</div><div class="l">${t('month')}</div></div></div>
      <div class="card"><h3>${t('settlements')}</h3>
      ${e.settlements.length ? e.settlements.map((s) => `<div class="row between" style="padding:7px 0;border-bottom:1px solid var(--line)">
        <span class="small">${s.period} • ${s.jobs} jobs</span><b class="small">${SAR(s.payout)} <span class="badge ${s.status === 'paid' ? 'green' : 'amber'}">${s.status}</span></b></div>`).join('')
      : `<p class="muted small">${t('empty')}</p>`}</div>`;
  }
}

window.acceptJob = async (id) => {
  try {
    await api('/driver/jobs/' + id + '/accept', { method: 'POST' });
    state.activeId = id; state.tab = 'active';
    startGps(id);
    renderHome(); openJob(id);
  } catch (e) { toast(e.message); }
};

function startGps(orderId) {
  if (gpsTimer) clearInterval(gpsTimer);
  gpsTimer = setInterval(() => {
    // demo GPS: Jeddah centre jitter (real app uses FusedLocationProvider)
    const lat = 21.55 + (Math.random() - 0.5) * 0.02;
    const lng = 39.17 + (Math.random() - 0.5) * 0.02;
    api('/driver/location', { method: 'POST', body: { lat, lng, orderId } }).catch(() => {});
  }, 8000);
}

// ---------- active job screen ----------
async function openJob(id) { location.hash = 'job/' + id; }
window.addEventListener('hashchange', drvRoute);
function drvRoute() {
  const h = location.hash.replace('#', '');
  if (h.startsWith('job/')) renderJob(h.split('/')[1]);
  else if (h === 'home') renderHome();
}
async function renderJob(id, silent) {
  let o;
  try { o = await api('/orders/' + id); } catch { return toast('not found'); }
  state.activeId = o.id;
  const pickup = o.stops.find((s) => s.kind === 'pickup');
  const drops = o.stops.filter((s) => s.kind === 'dropoff');
  const nextActions = {
    assigned: [['accepted', '✓ قبول الطلب']],
    accepted: [['en_route_pickup', '🚚 في الطريق للاستلام']],
    en_route_pickup: [['at_pickup', '📍 وصلت للاستلام']],
    at_pickup: [['loading', '📦 بدء التحميل']],
    loading: [['in_transit', '🛣️ انطلاق للتسليم']],
    in_transit: [['at_dropoff', '📍 وصلت للتسليم']],
    at_dropoff: [],
  }[o.status] || [];
  view.innerHTML = topbar(o.waybill) + `<div class="page">
    <div class="card fade-in">
      <div class="row between"><span class="status-chip st-${o.status}">${statusLabel(o.status)}</span>
      ${o.priority === 'priority' ? '<span class="badge amber">⚡ priority</span>' : ''}</div>
      <div class="jmap" id="map" style="height:200px;margin-top:10px"></div>
      <a class="btn sm" style="width:100%;margin-top:10px" target="_blank"
         href="https://www.google.com/maps/dir/?api=1&destination=${o.status === 'accepted' || o.status === 'en_route_pickup' ? pickup.lat + ',' + pickup.lng : drops[0].lat + ',' + drops[0].lng}">🧭 Google Maps navigation</a>
    </div>
    <div class="card"><h3>📍 ${t('pickup')}</h3><div class="small">${esc(pickup.address)}</div>
      <div class="small muted">${esc(pickup.contact_name || '')} <a dir="ltr" href="tel:${esc(pickup.contact_phone || '')}">${esc(pickup.contact_phone || '')}</a></div>
      ${pickup.notes ? `<div class="small muted">📝 ${esc(pickup.notes)}</div>` : ''}</div>
    ${drops.map((s, i) => `<div class="card"><h3>🎯 ${t('dropoff')} ${i + 1}</h3><div class="small">${esc(s.address)}</div>
      <div class="small muted">${esc(s.contact_name || '')} <a dir="ltr" href="tel:${esc(s.contact_phone || '')}">${esc(s.contact_phone || '')}</a></div></div>`).join('')}
    <div class="card"><h3>📋 ${t('items')} — checklist</h3>
      ${o.items.map((it, i) => `<label class="check-row"><input type="checkbox" class="chk" data-i="${i}" ${o.status !== 'accepted' && o.status !== 'assigned' ? 'checked' : ''}>
        <span class="small">${esc(it.name)} × ${it.qty} <span class="badge gray">${it.size_tier}</span></span></label>`).join('')}
      <div style="height:10px"></div>
      <div class="photo-drop" onclick="document.getElementById('picInp').click()">📷 صور الاستلام / Pickup photos</div>
      <input type="file" id="picInp" accept="image/*" multiple style="display:none" onchange="pickPhotos(this)">
      <div id="picPrev" class="row" style="margin-top:8px;flex-wrap:wrap"></div>
    </div>
    ${nextActions.map(([st, label]) => `<button class="btn" onclick="setState(${o.id},'${st}')">${label}</button>`).join('')}
    ${o.status === 'at_dropoff' ? podForm(o) : ''}
    ${['assigned', 'accepted', 'en_route_pickup'].includes(o.status) ? `<button class="btn danger" onclick="rejectJob(${o.id})">✕ ${t('reject')}</button>` : ''}
    <button class="btn secondary" onclick="reportIncident(${o.id})">⚠️ ${t('claims')} / incident</button>
    <div style="height:20px"></div>
  </div>`;
  drawMap(o);
  if (!silent) location.hash = 'job/' + id;
}
function topbar(title) {
  return `<div class="topbar"><button onclick="location.hash='home'">‹</button><h1>${esc(title)}</h1>
    <button onclick="toggleLang()">${store.lang === 'ar' ? 'EN' : 'ع'}</button></div>`;
}
window.toggleLang = () => { store.lang = store.lang === 'ar' ? 'en' : 'ar'; location.reload(); };
function drawMap(o) {
  const pickup = o.stops.find((s) => s.kind === 'pickup');
  const drop = o.stops.find((s) => s.kind === 'dropoff');
  renderMap(document.getElementById('map'), [
    { lat: pickup?.lat, lng: pickup?.lng, icon: '🏭' }, { lat: drop?.lat, lng: drop?.lng, icon: '🏠' },
  ], { lat: 21.55, lng: 39.17 }, 0.12);
}
window.setState = async (id, st) => {
  try {
    await api('/orders/' + id + '/state', { method: 'POST', body: { status: st } });
    if (st === 'in_transit') toast('✓ في الطريق');
    renderJob(id, true);
  } catch (e) { toast(e.message); }
};
window.rejectJob = async (id) => {
  if (!confirm(t('reject') + '?')) return;
  try { await api('/driver/jobs/' + id + '/reject', { method: 'POST' }); state.activeId = null; location.hash = 'home'; }
  catch (e) { toast(e.message); }
};
window.pickPhotos = async (inp) => {
  for (const f of inp.files) {
    const dataUrl = await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(f); });
    try {
      const res = await api('/upload', { method: 'POST', body: { dataUrl, kind: 'pod' } });
      (state.photos = state.photos || []).push(res.path);
      document.getElementById('picPrev').insertAdjacentHTML('beforeend', `<img src="${res.path}" style="width:56px;height:56px;object-fit:cover;border-radius:10px">`);
    } catch (e) { toast(e.message); }
  }
};
function podForm(o) {
  return `<div class="card fade-in"><h3>✅ ${t('podComplete')}</h3>
    <div class="pill-tabs">
      <button class="active" id="mOtp" onclick="podMode('otp')">🔐 ${t('deliveryOtp')}</button>
      <button id="mSig" onclick="podMode('sig')">✍️ ${t('podComplete')}</button></div>
    <div id="podOtp"><label class="f">${t('deliveryOtp')}</label>
      <input id="podOtpInp" inputmode="numeric" maxlength="4" dir="ltr" style="text-align:center;font-size:24px;font-weight:800;letter-spacing:8px"></div>
    <div id="podSig" style="display:none">
      <label class="f">اسم المستلم / Receiver name</label><input id="podName">
      <label class="f">التوقيع / Signature</label>
      <canvas id="sigPad" class="sig-pad" width="360" height="140"></canvas></div>
    <div style="height:12px"></div>
    <button class="btn success" onclick="submitPod(${o.id})">✓ تأكيد التسليم / Complete delivery</button></div>`;
}
window.podMode = (m) => {
  document.getElementById('mOtp').classList.toggle('active', m === 'otp');
  document.getElementById('mSig').classList.toggle('active', m === 'sig');
  document.getElementById('podOtp').style.display = m === 'otp' ? 'block' : 'none';
  document.getElementById('podSig').style.display = m === 'sig' ? 'block' : 'none';
  if (m === 'sig') initSig();
};
let sigDrawn = false;
function initSig() {
  if (sigDrawn) return; sigDrawn = true;
  const cv = document.getElementById('sigPad');
  const ctx = cv.getContext('2d');
  ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.strokeStyle = '#0B1F3A';
  let down = false;
  const pos = (e) => {
    const r = cv.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return [(t.clientX - r.left) * (cv.width / r.width), (t.clientY - r.top) * (cv.height / r.height)];
  };
  cv.onpointerdown = (e) => { down = true; const [x, y] = pos(e); ctx.beginPath(); ctx.moveTo(x, y); };
  cv.onpointermove = (e) => { if (down) { const [x, y] = pos(e); ctx.lineTo(x, y); ctx.stroke(); } };
  cv.onpointerup = () => { down = false; };
}
window.submitPod = async (id) => {
  const sigMode = document.getElementById('mSig').classList.contains('active');
  const body = { method: sigMode ? 'signature' : 'otp', lat: 21.56, lng: 39.17, photos: state.photos || [] };
  if (sigMode) {
    body.receiverName = document.getElementById('podName').value.trim();
    if (!body.receiverName) return toast('اسم المستلم مطلوب');
    body.signaturePath = null; // signature submitted as data URL via upload
    const dataUrl = document.getElementById('sigPad').toDataURL('image/png');
    try { const up = await api('/upload', { method: 'POST', body: { dataUrl, kind: 'signature' } }); body.signaturePath = up.path; }
    catch (e) { return toast(e.message); }
  } else {
    body.otp = document.getElementById('podOtpInp').value.trim();
    if (!body.otp) return toast('OTP مطلوب');
  }
  try { await api('/orders/' + id + '/pod', { method: 'POST', body }); toast('✅ تم التسليم!'); state.activeId = null; location.hash = 'home'; }
  catch (e) { toast(e.message); }
};
window.reportIncident = async (id) => {
  const description = prompt('وصف الحادث / Describe the incident:');
  if (!description) return;
  try { await api('/driver/incidents', { method: 'POST', body: { orderId: id, kind: 'damage', description } }); toast('✓ تم الإبلاغ'); }
  catch (e) { toast(e.message); }
};

drvRoute();
