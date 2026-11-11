// Fiasta Customer App (PWA) — vanilla JS SPA
const { api, t, store, toast, SAR, statusLabel, esc, renderMap, h } = FIA;
const view = document.getElementById('view');
let socket = null;

const state = { categories: [], addresses: [], draft: null, activeOrder: null };

// ---------- boot ----------
(async function boot() {
  await FIA.ready;
  FIA.applyDir();
  if (store.token) {
    try {
      const me = await api('/me');
      store.user = me.user;
      return renderHome();
    } catch { store.token = ''; }
  }
  renderLogin();
})();

function connectSocket() {
  if (socket) socket.disconnect();
  socket = io({ auth: { token: store.token } });
  socket.on('order:updated', (d) => {
    toast(`${t('status')}: ${statusLabel(d.status)}`);
    if (state.activeOrder && String(d.orderId) === String(state.activeOrder)) renderOrderDetail(state.activeOrder, true);
  });
  socket.on('driver:location', () => { if (state.activeOrder) refreshMapOnly(); });
  socket.on('order:chat', (msg) => { if (state.activeOrder) addChatLine(msg); });
}

// ---------- login ----------
function renderLogin() {
  view.innerHTML = `
  <div class="hero">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:18px">
      <div class="logo" style="width:44px;height:44px;border-radius:12px;background:linear-gradient(135deg,#2E6BFF,#5B8BFF);display:grid;place-items:center;font-weight:800;font-size:18px">F</div>
      <div><div style="font-weight:800;font-size:20px">Fiasta | فيستا</div><div style="font-size:12px;opacity:.8">${t('tagline')}</div></div>
    </div>
    <h1>${t('appName')} — ${t('tagline')}</h1>
    <p>الأثاث • الأجهزة • التجارة الإلكترونية • المياه • الأعمال</p>
  </div>
  <div class="page">
    <div class="card fade-in">
      <h3>${t('login')}</h3>
      <label class="f">${t('phone')}</label>
      <input id="phone" inputmode="tel" placeholder="05XXXXXXXX" dir="ltr" style="text-align:start">
      <div id="otpArea" style="display:none">
        <label class="f">${t('code')}</label>
        <div class="otp-row" id="otpRow"></div>
        <p class="small muted" id="otpHint" style="margin-top:8px"></p>
      </div>
      <div style="height:14px"></div>
      <button class="btn" id="goBtn">${t('sendCode')}</button>
      <div class="divider"></div>
      <div class="row between">
        <button class="btn secondary sm" id="langBtn">English</button>
        <a class="small muted" href="/track" id="trackLink" style="text-decoration:none">تتبع بوليصة / Track waybill</a>
      </div>
    </div>
    <p class="small muted" style="text-align:center">Demo OTP is shown on screen (SMS gateway integration pending).</p>
  </div>`;

  const phoneEl = document.getElementById('phone');
  const otpArea = document.getElementById('otpArea');
  const otpRow = document.getElementById('otpRow');
  const goBtn = document.getElementById('goBtn');
  let sent = false;

  document.getElementById('langBtn').onclick = () => {
    store.lang = store.lang === 'ar' ? 'en' : 'ar';
    location.reload();
  };

  function buildOtpInputs() {
    otpRow.innerHTML = '';
    for (let i = 0; i < 6; i++) {
      const inp = document.createElement('input');
      inp.maxLength = 1; inp.inputMode = 'numeric';
      inp.oninput = () => { if (inp.value && i < 5) otpRow.children[i + 1].focus(); };
      otpRow.appendChild(inp);
    }
    otpRow.children[0].focus();
  }

  goBtn.onclick = async () => {
    if (!sent) {
      const phone = phoneEl.value.trim();
      if (!/^05\d{8}$/.test(phone)) return toast('رقم جوال سعودي غير صحيح / Invalid Saudi mobile');
      try {
        const code = await FIA.otpLogin(phone);
        sent = true;
        otpArea.style.display = 'block';
        buildOtpInputs();
        document.getElementById('otpHint').textContent = code ? `Demo code: ${code}` : 'SMS sent';
        goBtn.textContent = t('verify');
      } catch (e) { toast(e.message); }
    } else {
      const code = [...otpRow.children].map((i) => i.value).join('');
      try {
        const r = await api('/auth/otp/verify', { method: 'POST', body: { phone: phoneEl.value.trim(), code } });
        store.token = r.token; store.user = r.user;
        connectSocket();
        renderHome();
      } catch (e) { toast(e.message); }
    }
  };
}

// ---------- home ----------
async function renderHome() {
  connectSocket();
  view.innerHTML = topbar(t('home')) + `<div class="page" id="page">${t('loading')}</div>` + bottomNav('home');
  const [cats, active] = await Promise.all([api('/categories?lang=' + store.lang), api('/orders')]);
  state.categories = cats;
  state.addresses = await api('/addresses').catch(() => []);
  const live = active.find((o) => !['delivered', 'cancelled', 'failed'].includes(o.status));
  const icons = { furniture: '🛋️', appliances: '🧊', retail: '📦', business: '🏢', events: '🎪', water: '💧', lpg: '🔥' };
  document.getElementById('page').innerHTML = `
    ${live ? `<div class="card accent-card fade-in" style="background:linear-gradient(135deg,#0B1F3A,#1B4079);color:#fff;cursor:pointer" onclick="location.hash='order/${live.id}'">
      <div class="row between"><div><div class="small" style="opacity:.8">${t('liveTracking')}</div>
      <div style="font-weight:800">${live.waybill} • ${statusLabel(live.status)}</div></div>
      <div style="font-size:26px">🚚</div></div></div>` : ''}
    <h3 style="margin:4px 0 10px">${t('categories')}</h3>
    <div class="cat-grid">
      ${cats.map((c) => `
        <div class="cat-tile ${c.state !== 'active' ? 'locked' : ''}" onclick="window.catPick('${c.slug}')">
          <div class="ic">${icons[c.slug] || '📦'}</div>
          <div class="nm">${esc(typeof c.name === 'string' ? c.name : c.name[store.lang])}</div>
          ${c.state !== 'active' ? `<div class="lock">${c.state === 'disabled' ? '🔒' : '🤝'}</div>` : ''}
        </div>`).join('')}
    </div>
    <div class="divider"></div>
    <h3 style="margin-bottom:10px">${t('history')}</h3>
    ${active.length ? active.slice(0, 5).map(orderRow).join('') : `<div class="empty"><div class="ic">🗂️</div>${t('empty')}</div>`}`;
}

window.catPick = (slug) => {
  const c = state.categories.find((x) => x.slug === slug);
  if (c.state === 'disabled') return toast(t('disabledCategory'));
  if (c.state !== 'active' && slug === 'lpg') return toast(t('partnerOnly'));
  location.hash = `new/${slug}`;
};

function orderRow(o) {
  return `<div class="card" style="padding:13px;cursor:pointer" onclick="location.hash='order/${o.id}'">
    <div class="row between">
      <div><b>${o.waybill}</b><div class="small muted">${esc(o.category_en || o.category_ar || '')}</div></div>
      <div style="text-align:end"><span class="status-chip st-${o.status}">${statusLabel(o.status)}</span>
      <div class="money small">${SAR(o.total)}</div></div>
    </div></div>`;
}

function topbar(title, back = true) {
  return `<div class="topbar">
    ${back ? `<button onclick="history.back()">‹</button>` : `<div class="logo">F</div>`}
    <h1>${esc(title)}</h1>
    <button onclick="toggleLang()" title="AR/EN">${store.lang === 'ar' ? 'EN' : 'ع'}</button>
  </div>`;
}
window.toggleLang = () => { store.lang = store.lang === 'ar' ? 'en' : 'ar'; location.reload(); };

function bottomNav(active) {
  return `<div class="bottom-nav">
    <a href="#home" class="${active === 'home' ? 'active' : ''}"><span class="ic">🏠</span>${t('home')}</a>
    <a href="#orders" class="${active === 'orders' ? 'active' : ''}"><span class="ic">🗂️</span>${t('orders')}</a>
    <a href="#new" class="${active === 'new' ? 'active' : ''}"><span class="ic">➕</span>${t('newOrder')}</a>
    <a href="#account" class="${active === 'account' ? 'active' : ''}"><span class="ic">👤</span>${t('account')}</a>
  </div>`;
}

// ---------- router ----------
window.addEventListener('hashchange', route);
function route() {
  if (!store.token) return renderLogin();
  const hash = location.hash.replace('#', '') || 'home';
  if (hash.startsWith('new/')) return renderBooking(hash.split('/')[1]);
  if (hash.startsWith('order/')) return renderOrderDetail(hash.split('/')[1]);
  if (hash === 'orders') return renderOrders();
  if (hash === 'account') return renderAccount();
  if (hash === 'new') return renderCategoryPicker();
  if (hash === 'home') return renderHome();
}

function renderCategoryPicker() {
  renderHome();
}

// ---------- orders list ----------
async function renderOrders() {
  view.innerHTML = topbar(t('orders')) + `<div class="page" id="page">${t('loading')}</div>` + bottomNav('orders');
  const orders = await api('/orders');
  document.getElementById('page').innerHTML = orders.length
    ? orders.map(orderRow).join('')
    : `<div class="empty"><div class="ic">🗂️</div>${t('empty')}</div>`;
}

// ---------- account ----------
function renderAccount() {
  const u = store.user || {};
  view.innerHTML = topbar(t('account')) + `<div class="page">
    <div class="card fade-in">
      <div class="row"><div class="logo" style="width:52px;height:52px;border-radius:14px;background:linear-gradient(135deg,#2E6BFF,#5B8BFF);display:grid;place-items:center;color:#fff;font-weight:800;font-size:20px">${esc((u.name || 'U')[0])}</div>
      <div><b>${esc(u.name || '—')}</b><div class="small muted" dir="ltr">${esc(u.phone)}</div></div></div>
    </div>
    <div class="card"><h3>${t('myAddresses')}</h3><div id="addrList"></div>
      <button class="btn secondary sm" style="width:100%;margin-top:8px" onclick="addAddress()">${t('addAddress')}</button></div>
    <div class="card"><h3>${t('support')}</h3>
      <textarea id="tkBody" rows="3" placeholder="..."></textarea>
      <div style="height:10px"></div><button class="btn sm" style="width:100%" onclick="sendTicket()">${t('save')}</button></div>
    <button class="btn danger" onclick="logout()">${t('logout')}</button>
    <p class="small muted" style="margin-top:12px">Fiasta demo • payments & SMS are integration stubs</p>
  </div>` + bottomNav('account');
  loadAddresses();
}
window.logout = () => { store.token = ''; store.user = ''; location.reload(); };

async function loadAddresses() {
  const list = await api('/addresses').catch(() => []);
  state.addresses = list;
  document.getElementById('addrList').innerHTML = list.length
    ? list.map((a) => `<div class="row between" style="padding:8px 0;border-bottom:1px solid var(--line)">
        <div><b class="small">${esc(a.label || '—')}</b><div class="small muted">${esc(a.address)}</div></div>
        <button class="btn danger sm" onclick="delAddr(${a.id})">✕</button></div>`).join('')
    : `<p class="muted small">${t('empty')}</p>`;
}
window.delAddr = async (id) => { await api('/addresses/' + id, { method: 'DELETE' }); loadAddresses(); };
window.addAddress = async () => {
  const label = prompt('Label / الاسم:'); if (!label) return;
  const address = prompt('Address / العنوان:'); if (!address) return;
  await api('/addresses', { method: 'POST', body: { label, address, lat: 21.55 + Math.random() * 0.08, lng: 39.15 + Math.random() * 0.1 } });
  loadAddresses();
};
window.sendTicket = async () => {
  const body = document.getElementById('tkBody').value.trim();
  if (!body) return;
  await api('/support/tickets', { method: 'POST', body: { subject: 'App support', body } });
  toast('✓'); document.getElementById('tkBody').value = '';
};

// ---------- booking wizard ----------
async function renderBooking(slug) {
  const cats = state.categories.length ? state.categories : await api('/categories?lang=' + store.lang);
  const cat = cats.find((c) => c.slug === slug) || cats[0];
  if (!cat) return renderHome();
  state.draft = {
    slug: cat.slug, cat, items: [], waterLines: [], dropoffs: [{}],
    helpers: 0, floorPickup: 0, elevatorPickup: false, floorDropoff: 0, elevatorDropoff: false,
    priority: false, step: 1,
  };
  if (cat.slug === 'water') state.draft.waterProducts = await api('/water/products?lang=' + store.lang);
  if (['furniture', 'appliances', 'retail', 'business', 'events', 'lpg'].includes(cat.slug)) {
    state.draft.catalog = await api(`/categories/${cat.slug}/items?lang=` + store.lang);
  }
  drawStep();
}

function drawStep() {
  const d = state.draft;
  const steps = ['📍', '🎯', '📦', '⚙️', '💳'];
  view.innerHTML = topbar(`${t('newOrder')} — ${esc(typeof d.cat.name === 'string' ? d.cat.name : d.cat.name[store.lang])}`)
    + `<div class="page"><div class="step-dots">${steps.map((s, i) => `<i class="${d.step === i + 1 ? 'on' : ''}"></i>`).join('')}</div>
    <div id="stepBody"></div></div>`;
  const body = document.getElementById('stepBody');
  if (d.step === 1) stepPickup(body);
  else if (d.step === 2) stepDropoff(body);
  else if (d.step === 3) stepItems(body);
  else if (d.step === 4) stepOptions(body);
  else stepCheckout(body);
}

function pointForm(prefix, p = {}) {
  return `
    <label class="f">العنوان / Address</label>
    <input id="${prefix}_address" value="${esc(p.address || '')}" placeholder="الحي، الشارع، رقم المبنى">
    <div class="grid2">
      <div><label class="f">Lat</label><input id="${prefix}_lat" dir="ltr" value="${p.lat ?? ''}" placeholder="21.5620"></div>
      <div><label class="f">Lng</label><input id="${prefix}_lng" dir="ltr" value="${p.lng ?? ''}" placeholder="39.1720"></div>
    </div>
    <button class="btn secondary sm" style="width:100%;margin-top:8px" onclick="pickDistrict('${prefix}')">🗺️ اختر حي من جدة / Pick a Jeddah district</button>`;
}

window.pickDistrict = async (prefix) => {
  const zones = await api('/zones?lang=' + store.lang);
  const names = zones.map((z, i) => `${i + 1}. ${typeof z.name === 'string' ? z.name : z.name[store.lang]}${z.surcharge ? ` (+${z.surcharge})` : ''}`);
  const pick = prompt(names.join('\n') + '\n\nرقم الحي / district no:');
  const z = zones[Number(pick) - 1];
  if (!z) return;
  document.getElementById(prefix + '_address').value = typeof z.name === 'string' ? z.name : z.name[store.lang];
  document.getElementById(prefix + '_lat').value = z.lat;
  document.getElementById(prefix + '_lng').value = z.lng;
};

function stepPickup(body) {
  const saved = state.addresses;
  body.innerHTML = `<div class="card fade-in"><h3>📍 ${t('pickup')}</h3>
    ${saved.length ? `<label class="f">${t('myAddresses')}</label>` : ''}
    ${saved.map((a, i) => `<div class="addr-opt" onclick="useSaved(${i})"><b class="small">${esc(a.label)}</b><div class="small muted">${esc(a.address)}</div></div>`).join('')}
    ${pointForm('pu')}
    <div style="height:12px"></div>
    <button class="btn" onclick="stepNext(1)">${t('save')} ›</button></div>`;
}
window.useSaved = (i) => {
  const a = state.addresses[i];
  document.getElementById('pu_address').value = a.address;
  document.getElementById('pu_lat').value = a.lat;
  document.getElementById('pu_lng').value = a.lng;
};

function stepDropoff(body) {
  const d = state.draft;
  body.innerHTML = `<div class="card fade-in"><h3>🎯 ${t('dropoff')}</h3>
    ${d.dropoffs.map((_, i) => `
      <div style="border:1px solid var(--line);border-radius:12px;padding:10px;margin-bottom:10px">
        <div class="row between"><b class="small">${t('dropoff')} ${i + 1}</b>
        ${i > 0 ? `<button class="btn danger sm" onclick="rmStop(${i})">✕</button>` : ''}</div>
        ${pointForm('do' + i, d.dropoffs[i])}
        <div class="grid2"><div><label class="f">${t('floor')}</label><input id="do${i}_floor" type="number" min="0" max="60" value="${d.dropoffs[i].floor ?? 0}"></div>
        <div><label class="f">${t('elevator')}</label><select id="do${i}_elev"><option value="0">—</option><option value="1" ${d.dropoffs[i].elevator ? 'selected' : ''}>✓</option></select></div></div>
      </div>`).join('')}
    <button class="btn secondary sm" style="width:100%" onclick="addStop()">＋ ${t('addStop')} (SAR 15–25)</button>
    <div style="height:12px"></div>
    <button class="btn" onclick="stepNext(2)">›</button></div>`;
}
window.addStop = () => { state.draft.dropoffs.push({}); drawStep(); };
window.rmStop = (i) => { state.draft.dropoffs.splice(i, 1); drawStep(); };

function stepItems(body) {
  const d = state.draft;
  if (d.slug === 'water') return stepWater(body);
  const cat = d.catalog || [];
  body.innerHTML = `<div class="card fade-in"><h3>📦 ${t('items')}</h3>
    ${cat.map((it, i) => {
      const q = (d.items.find((x) => x.id === it.id) || {}).qty || 0;
      return `<div class="item-row">
        <div style="flex:1"><b class="small">${esc(typeof it.name === 'string' ? it.name : it.name[store.lang])}</b>
        <div class="small muted">${it.sizeTier === 'extra_bulky' ? '🔴 extra bulky' : it.sizeTier === 'bulky' ? '🟠 bulky' : '🟢 standard'} • ~${it.estWeightKg}kg</div></div>
        <button class="qty-btn" onclick="qty(${it.id},-1)">−</button><b>${q}</b>
        <button class="qty-btn" onclick="qty(${it.id},1)">＋</button></div>`;
    }).join('')}
    <label class="f">أخرى / Custom item</label>
    <div class="row"><input id="customName" placeholder="اسم الغرض">
      <select id="customTier" style="width:130px"><option value="standard">standard</option><option value="bulky">bulky</option><option value="extra_bulky">extra bulky</option></select>
      <button class="btn sm" onclick="addCustom()">＋</button></div>
    <div style="height:12px"></div>
    <div class="photo-drop" onclick="document.getElementById('photoInp').click()">📷 ارفع صورة الغرض / Upload item photo</div>
    <input type="file" id="photoInp" accept="image/*" style="display:none" onchange="uploadPhoto(this)">
    <div id="photoPrev" class="row" style="margin-top:8px;flex-wrap:wrap"></div>
    <div style="height:12px"></div>
    <button class="btn" onclick="stepNext(3)" ${d.items.length ? '' : 'disabled'}>›</button></div>`;
  d.photos = d.photos || [];
  drawPhotoPrev();
}
window.qty = (id, delta) => {
  const d = state.draft;
  const it = d.catalog.find((x) => x.id === id);
  let row = d.items.find((x) => x.id === id);
  if (!row) { row = { id, name: it.name, size_tier: it.sizeTier, est_weight_kg: it.estWeightKg, est_volume_m3: it.estVolumeM3, qty: 0 }; d.items.push(row); }
  row.qty = Math.max(0, row.qty + delta);
  if (!row.qty) d.items = d.items.filter((x) => x.id !== id);
  drawStep();
};
window.addCustom = () => {
  const name = document.getElementById('customName').value.trim();
  if (!name) return;
  state.draft.items.push({ id: 'c' + Date.now(), name, size_tier: document.getElementById('customTier').value, qty: 1, est_weight_kg: 10, est_volume_m3: 0.1 });
  drawStep();
};
window.uploadPhoto = async (inp) => {
  const f = inp.files[0]; if (!f) return;
  const dataUrl = await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(f); });
  try {
    const r = await api('/upload', { method: 'POST', body: { dataUrl, kind: 'item' } });
    state.draft.photos.push(r.path);
    drawPhotoPrev();
  } catch (e) { toast(e.message); }
};
function drawPhotoPrev() {
  const el = document.getElementById('photoPrev');
  if (el) el.innerHTML = (state.draft.photos || []).map((p) => `<img src="${p}" style="width:56px;height:56px;object-fit:cover;border-radius:10px">`).join('');
}

function stepWater(body) {
  const d = state.draft;
  body.innerHTML = `<div class="card fade-in"><h3>💧 ${t('categories')} — ${t('quantity')}</h3>
    ${d.waterProducts.map((w) => {
      const line = d.waterLines.find((x) => x.productId === w.id) || { qty: 0 };
      const name = typeof w.brand === 'string' ? w.brand : w.brand[store.lang];
      return `<div class="item-row">
        <div style="flex:1"><b class="small">${esc(name)}</b><div class="small muted">${esc(w.sizeLabel)} • ${SAR(w.unitPrice)} • ${t('stock')}: ${w.stockQty}</div></div>
        <button class="qty-btn" onclick="wqty(${w.id},-1)">−</button><b>${line.qty}</b>
        <button class="qty-btn" onclick="wqty(${w.id},1)">＋</button></div>`;
    }).join('')}
    <div class="divider"></div>
    <label class="f">🔁 ${t('repeatOrder')}</label>
    <select id="repeatSel"><option value="">—</option><option value="weekly">أسبوعي / Weekly</option><option value="biweekly">كل أسبوعين / Bi-weekly</option></select>
    <div style="height:12px"></div>
    <button class="btn" onclick="stepNext(3)" ${d.waterLines.length ? '' : 'disabled'}>›</button></div>`;
}
window.wqty = (id, delta) => {
  const d = state.draft;
  const w = d.waterProducts.find((x) => x.id === id);
  let line = d.waterLines.find((x) => x.productId === id);
  if (!line) { line = { productId: id, qty: 0 }; d.waterLines.push(line); }
  line.qty = Math.max(0, Math.min(w.stockQty, line.qty + delta));
  if (!line.qty) d.waterLines = d.waterLines.filter((x) => x.productId !== id);
  drawStep();
};

function stepOptions(body) {
  const d = state.draft;
  body.innerHTML = `<div class="card fade-in"><h3>⚙️ ${t('newOrder')}</h3>
    <label class="f">${t('helpers')} (SAR 25–50 each)</label>
    <select id="helpers">${[0, 1, 2, 3].map((n) => `<option value="${n}" ${d.helpers === n ? 'selected' : ''}>${n}</option>`).join('')}</select>
    <label class="f">${t('floor')} — ${t('pickup')}</label>
    <input id="fpu" type="number" min="0" max="60" value="${d.floorPickup}">
    <label class="f">${t('elevator')} — ${t('pickup')}</label>
    <select id="epu"><option value="0">—</option><option value="1" ${d.elevatorPickup ? 'selected' : ''}>✓</option></select>
    <label class="f">${t('floor')} — ${t('dropoff')}</label>
    <input id="fdo" type="number" min="0" max="60" value="${d.floorDropoff}">
    <label class="f">${t('elevator')} — ${t('dropoff')}</label>
    <select id="edo"><option value="0">—</option><option value="1" ${d.elevatorDropoff ? 'selected' : ''}>✓</option></select>
    <div class="divider"></div>
    <div class="row between"><div><b class="small">⚡ ${t('priority')}</b><div class="small muted">+30% surcharge</div></div>
      <div class="switch ${d.priority ? 'on' : ''}" id="prioSw" onclick="this.classList.toggle('on')"></div></div>
    <div class="divider"></div>
    <label class="f">${t('schedule')}</label>
    <div class="pill-tabs"><button class="active" id="tabNow" onclick="schedMode('now')">${t('now')}</button>
      <button id="tabSched" onclick="schedMode('sched')">📅 ${t('scheduled')}</button></div>
    <input id="schedAt" type="datetime-local" style="display:none">
    <div style="height:14px"></div>
    <button class="btn" onclick="stepNext(4)">›</button></div>`;
}
window.schedMode = (m) => {
  document.getElementById('tabNow').classList.toggle('active', m === 'now');
  document.getElementById('tabSched').classList.toggle('active', m === 'sched');
  document.getElementById('schedAt').style.display = m === 'sched' ? 'block' : 'none';
};

async function stepCheckout(body) {
  const d = state.draft;
  body.innerHTML = `<div class="card fade-in"><h3>💳 ${t('quote')}</h3><div id="quoteBox">${t('loading')}</div></div>
    <div class="card"><h3>${t('cash')} / ${t('card')}</h3>
      <div class="pill-tabs"><button class="active" id="pmCash" onclick="pmPick('cash')">💵 ${t('cash')}</button>
      <button id="pmCard" onclick="pmPick('card')">💳 ${t('card')} <span class="badge amber">demo</span></button></div>
      <label class="f">Promo code</label>
      <input id="promo" placeholder="JEDDAH10">
    </div>
    <button class="btn" id="bookBtn" onclick="book()">${t('confirm')}</button>`;
  await refreshQuote();
}
window.pmPick = (m) => {
  document.getElementById('pmCash').classList.toggle('active', m === 'cash');
  document.getElementById('pmCard').classList.toggle('active', m === 'card');
  state.draft.paymentMethod = m;
};
async function refreshQuote() {
  const d = state.draft;
  const pu = readPoint('pu');
  const dos = d.dropoffs.map((_, i) => readPoint('do' + i)).filter(Boolean);
  const body = {
    pickup: pu, dropoffs: dos, items: d.items.map(({ name, ...rest }) => rest),
    helpers: d.helpers, floorPickup: d.floorPickup, floorDropoff: d.floorDropoff,
    elevatorPickup: d.elevatorPickup, elevatorDropoff: d.elevatorDropoff,
    priority: d.priority, waterLines: d.waterLines,
  };
  try {
    const q = await api('/quote', { method: 'POST', body });
    d.lastQuote = q;
    document.getElementById('quoteBox').innerHTML = `
      ${q.lines.map((l) => `<div class="row between" style="padding:4px 0"><span class="small ${l.amount < 0 ? '' : 'muted'}">${esc(l.label)}</span><b class="small">${l.amount < 0 ? '−' : ''}${SAR(Math.abs(l.amount))}</b></div>`).join('')}
      <div class="divider"></div>
      <div class="row between"><span class="small muted">${t('vat')}</span><b class="small">${SAR(q.vat)}</b></div>
      <div class="row between"><span><b>${t('total')}</b></span><span class="money" style="font-size:20px">${SAR(q.total)}</span></div>
      ${q.customQuote ? `<p class="badge amber">20+ km — custom quotation</p>` : ''}`;
  } catch (e) { document.getElementById('quoteBox').innerHTML = `<p class="badge red">${esc(e.message)}</p>`; }
}
function readPoint(prefix) {
  const address = document.getElementById(prefix + '_address')?.value?.trim();
  const lat = parseFloat(document.getElementById(prefix + '_lat')?.value);
  const lng = parseFloat(document.getElementById(prefix + '_lng')?.value);
  if (!address || !Number.isFinite(lat)) return null;
  return { address, lat, lng };
}
window.stepNext = (from) => {
  const d = state.draft;
  if (from === 1) {
    const pu = readPoint('pu');
    if (!pu) return toast('pickup مطلوب');
    d.pickup = pu;
  }
  if (from === 2) {
    const dos = d.dropoffs.map((_, i) => {
      const p = readPoint('do' + i);
      if (!p) return null;
      p.floor = Number(document.getElementById('do' + i + '_floor')?.value) || 0;
      p.elevator = document.getElementById('do' + i + '_elev')?.value === '1';
      return p;
    });
    if (dos.some((x) => !x)) return toast('dropoff مطلوب');
    d.dropoffs = dos;
    d.floorDropoff = dos[0].floor; d.elevatorDropoff = dos[0].elevator;
  }
  if (from === 4) {
    d.helpers = Number(document.getElementById('helpers').value);
    d.floorPickup = Number(document.getElementById('fpu').value) || 0;
    d.elevatorPickup = document.getElementById('epu').value === '1';
    d.floorDropoff = Number(document.getElementById('fdo').value) || 0;
    d.elevatorDropoff = document.getElementById('edo').value === '1';
    d.priority = document.getElementById('prioSw').classList.contains('on');
    const sched = document.getElementById('tabSched').classList.contains('active');
    d.scheduledFor = sched ? document.getElementById('schedAt').value || null : null;
  }
  d.step = from + 1;
  drawStep();
};
window.book = async () => {
  const d = state.draft;
  const btn = document.getElementById('bookBtn');
  btn.disabled = true;
  try {
    const body = {
      categorySlug: d.slug, pickup: d.pickup, dropoffs: d.dropoffs,
      items: d.items.map((i) => ({ name: typeof i.name === 'string' ? i.name : i.name.en, qty: i.qty, size_tier: i.size_tier, est_weight_kg: i.est_weight_kg || 0, est_volume_m3: i.est_volume_m3 || 0 })),
      waterLines: d.waterLines, helpers: d.helpers, floorPickup: d.floorPickup, floorDropoff: d.floorDropoff,
      elevatorPickup: d.elevatorPickup, elevatorDropoff: d.elevatorDropoff, priority: d.priority,
      scheduledFor: d.scheduledFor, paymentMethod: d.paymentMethod || 'cash',
      promoCode: document.getElementById('promo')?.value?.trim() || undefined,
      autoDispatch: true,
    };
    const o = await api('/orders', { method: 'POST', body });
    toast('✓ ' + o.waybill);
    location.hash = 'order/' + o.id;
  } catch (e) { toast(e.message); btn.disabled = false; }
};

// ---------- order detail + live tracking ----------
async function renderOrderDetail(id, silent) {
  let o;
  try { o = await api('/orders/' + id); } catch { return toast('order not found'); }
  state.activeOrder = o.id;
  const pickup = o.stops.find((s) => s.kind === 'pickup');
  const drops = o.stops.filter((s) => s.kind === 'dropoff');
  const isLive = !['delivered', 'cancelled', 'failed'].includes(o.status);
  view.innerHTML = topbar(o.waybill) + `<div class="page">
    <div class="card fade-in">
      <div class="row between"><span class="status-chip st-${o.status}">${statusLabel(o.status)}</span>
        <span class="money">${SAR(o.total)}</span></div>
      <div class="jmap" id="map" style="margin-top:12px;height:240px"></div>
      ${o.driver_name ? `<div class="row between" style="margin-top:12px">
        <div><b class="small">🚚 ${esc(o.driver_name)}</b><div class="small muted">${esc(o.vehicle_model || '')} • ${esc(o.vehicle_plate || '')}</div></div>
        <a class="btn sm" href="tel:${esc(o.driver_phone)}">📞 ${t('callDriver')}</a></div>` : `<p class="small muted" style="margin-top:10px">⏳ ${t('pending')} — dispatch…</p>`}
    </div>
    <div class="card"><h3>${t('track')}</h3><div class="timeline">
      ${o.events.map((e) => `<div class="ev ${e === o.events[o.events.length - 1] ? '' : 'dim'}">
        <b class="small">${statusLabel(e.status)}</b> <span class="small muted">${new Date(e.at + 'Z').toLocaleString(store.lang === 'ar' ? 'ar-SA' : 'en-GB')}</span>
        ${e.note ? `<div class="small muted">${esc(e.note)}</div>` : ''}</div>`).join('')}
    </div></div>
    <div class="card"><h3>${t('items')}</h3>
      ${o.items.map((i) => `<div class="row between" style="padding:5px 0"><span class="small">${esc(i.name)} × ${i.qty}</span><span class="badge gray">${i.size_tier}</span></div>`).join('')}
      <div class="divider"></div>
      <div class="small muted">📍 ${esc(pickup?.address || '')}</div>
      ${drops.map((s) => `<div class="small muted">🎯 ${esc(s.address)}</div>`).join('')}
    </div>
    ${o.price_breakdown?.length ? `<div class="card"><h3>${t('quote')}</h3>
      ${o.price_breakdown.map((l) => `<div class="row between"><span class="small muted">${esc(l.label)}</span><b class="small">${l.amount < 0 ? '−' : ''}${SAR(Math.abs(l.amount))}</b></div>`).join('')}
      <div class="divider"></div><div class="row between"><b>${t('total')}</b><span class="money">${SAR(o.total)}</span></div></div>` : ''}
    ${isLive ? `<div class="card"><h3>${t('chat')}</h3><div class="chat-box" id="chatBox">
        ${(o.chat || []).map((m) => chatLine(m)).join('')}</div>
      <div class="row" style="margin-top:8px"><input id="chatInp" placeholder="..."><button class="btn sm" onclick="sendChat(${o.id})">➤</button></div></div>` : ''}
    ${o.status === 'in_transit' || o.status === 'at_dropoff' ? `
      <div class="card" style="text-align:center"><h3>${t('deliveryOtp')}</h3>
        <button class="btn" onclick="getOtp(${o.id})">🔐 ${t('deliveryOtp')}</button>
        <div id="otpShow" style="font-size:34px;font-weight:800;letter-spacing:8px;direction:ltr;margin-top:8px"></div></div>` : ''}
    ${o.status === 'delivered' && !o.rating ? `
      <div class="card"><h3>${t('rateOrder')}</h3>
        <div class="row" style="justify-content:center;gap:6px;font-size:30px" id="stars">
          ${[1,2,3,4,5].map((s) => `<span style="cursor:pointer" onclick="rate(${o.id},${s})">⭐</span>`).join('')}</div></div>` : ''}
    ${o.status === 'delivered' && o.rating ? `<div class="card"><h3>${t('rating')}: ${'⭐'.repeat(o.rating)}</h3>
      <div class="small muted">${esc(o.rating_comment || '')}</div>
      ${o.pod ? `<div class="divider"></div><div class="small muted">✅ ${t('podComplete')}: ${o.pod.method} • ${esc(o.pod.receiver_name || '')}</div>` : ''}</div>` : ''}
    ${isLive ? `<button class="btn danger" onclick="cancelOrder(${o.id})">${t('cancel')}</button>` : ''}
    <div style="height:20px"></div>
  </div>` + bottomNav('');
  drawOrderMap(o);
  if (!silent) location.hash = 'order/' + id;
}
function chatLine(m) {
  const me = m.senderId === store.user?.id || m.sender === store.user?.name;
  return `<div class="chat-msg ${me ? 'me' : 'them'}">${esc(m.body)}</div>`;
}
window.addChatLine = (msg) => {
  const box = document.getElementById('chatBox');
  if (box) { box.insertAdjacentHTML('beforeend', chatLine(msg)); box.scrollTop = box.scrollHeight; }
};
window.sendChat = async (id) => {
  const inp = document.getElementById('chatInp');
  const body = inp.value.trim(); if (!body) return;
  socket.emit('order:chat', { orderId: id, body });
  inp.value = '';
};
function drawOrderMap(o) {
  const pickup = o.stops.find((s) => s.kind === 'pickup');
  const drop = o.stops.find((s) => s.kind === 'dropoff');
  const pins = [
    { lat: pickup?.lat, lng: pickup?.lng, icon: '🏭', label: t('pickup') },
    { lat: drop?.lat, lng: drop?.lng, icon: '🏠', label: t('dropoff') },
  ];
  if (o.driver_name && o.status !== 'pending') pins.push({ lat: (pickup.lat + drop.lat) / 2 + 0.004, lng: (pickup.lng + drop.lng) / 2, icon: '🚚', me: true });
  renderMap(document.getElementById('map'), pins.filter((p) => Number.isFinite(p.lat)),
    { lat: (pickup.lat + drop.lat) / 2, lng: (pickup.lng + drop.lng) / 2 }, 0.08);
}
async function refreshMapOnly() {
  const o = await api('/orders/' + state.activeOrder).catch(() => null);
  if (o) drawOrderMap(o);
}
window.getOtp = async (id) => {
  try {
    const r = await api('/orders/' + id + '/delivery-otp');
    document.getElementById('otpShow').textContent = r.otp;
  } catch (e) { toast(e.message); }
};
window.cancelOrder = async (id) => {
  if (!confirm(t('cancel') + '?')) return;
  try { await api('/orders/' + id + '/cancel', { method: 'POST', body: { reason: 'customer cancel' } }); toast('✓'); renderOrderDetail(id, true); }
  catch (e) { toast(e.message); }
};
window.rate = async (id, stars) => {
  const comment = prompt(t('rating') + ' (اختياري):') || '';
  try { await api('/orders/' + id + '/rate', { method: 'POST', body: { rating: stars, comment } }); renderOrderDetail(id, true); }
  catch (e) { toast(e.message); }
};

// boot route
route();
