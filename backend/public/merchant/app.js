// Fiasta Merchant Portal
const { api, t, store, toast, SAR, statusLabel, esc } = FIA;
const view = document.getElementById('view');
window.toggleLang = () => { store.lang = store.lang === 'ar' ? 'en' : 'ar'; location.reload(); };

(async function boot() {
  await FIA.ready;
  FIA.applyDir();
  document.getElementById('langBtn').textContent = store.lang === 'ar' ? 'EN' : 'ع';
  if (!store.token) return renderLogin();
  try {
    const me = await api('/me');
    if (!['merchant', 'admin', 'super_admin'].includes(me.user.role)) { store.token = ''; return renderLogin(); }
    return renderPortal(me.profile);
  } catch { store.token = ''; }
  renderLogin();
})();

function renderLogin() {
  view.innerHTML = `<div class="card" style="max-width:440px;margin:40px auto">
    <h3>🏬 Fiasta Merchant</h3>
    <label class="f">${t('phone')}</label><input id="ph" dir="ltr" placeholder="05XXXXXXXX">
    <div id="oa" style="display:none"><label class="f">${t('code')}</label>
      <input id="cd" dir="ltr" maxlength="6" style="text-align:center;font-size:22px;font-weight:800;letter-spacing:6px">
      <p class="small muted" id="hint"></p></div>
    <div style="height:12px"></div><button class="btn" id="go">${t('sendCode')}</button>
    <div class="divider"></div>
    <p class="small muted">Demo merchant: 0556200001 (Rawand Furniture) • 0556200002 (Aqua Jeddah water)</p>
    <div class="divider"></div>
    <button class="btn secondary sm" style="width:100%" onclick="registerMerchant()">تسجيل تاجر جديد / Register</button></div>`;
  let sent = false;
  document.getElementById('go').onclick = async () => {
    const phone = document.getElementById('ph').value.trim();
    if (!sent) {
      try {
        const code = await FIA.otpLogin(phone);
        sent = true;
        document.getElementById('oa').style.display = 'block';
        document.getElementById('hint').textContent = code ? `Demo code: ${code}` : 'SMS sent';
      } catch (e) { toast(e.message); }
    } else {
      try {
        const r = await api('/auth/otp/verify', { method: 'POST', body: { phone, code: document.getElementById('cd').value.trim() } });
        store.token = r.token; store.user = r.user;
        location.reload();
      } catch (e) { toast(e.message); }
    }
  };
  window.registerMerchant = async () => {
    const phone = document.getElementById('ph').value.trim();
    const name = prompt('Business name:'); if (!name) return;
    const code = await FIA.otpLogin(phone);
    const v = prompt(`SMS code ${code ? '(demo: ' + code + ')' : ''}:`); if (!v) return;
    try {
      const r = await api('/auth/merchant/register', { method: 'POST', body: { phone, code: v, businessName: name, categorySlug: 'retail' } });
      toast('✓ ' + r.message);
    } catch (e) { toast(e.message); }
  };
}

async function renderPortal(profile) {
  const [orders, m] = await Promise.all([api('/merchant/orders'), api('/merchant')]);
  const active = orders.filter((o) => !['delivered', 'cancelled', 'failed'].includes(o.status));
  view.innerHTML = `
  <div class="grid3" style="grid-template-columns:repeat(4,1fr)">
    <div class="kpi accent"><div class="v">${orders.length}</div><div class="l">Total orders</div></div>
    <div class="kpi"><div class="v">${active.length}</div><div class="l">Active</div></div>
    <div class="kpi"><div class="v">${profile?.status || '—'}</div><div class="l">Account status</div></div>
    <div class="kpi"><div class="v">${profile?.negotiated_discount_pct ?? 0}%</div><div class="l">Negotiated discount</div></div>
  </div>
  <div class="grid2" style="margin-top:14px;align-items:start">
    <div>
      <div class="card"><h3>🚀 Bulk order booking</h3>
        <button class="btn sm" style="width:100%" onclick="bulkForm()">➕ New bulk orders</button></div>
      <div class="card"><h3>📥 ${t('bulkImport')} (CSV)</h3>
        <p class="small muted">Columns: pickup_address,pickup_lat,pickup_lng,dropoff_address,dropoff_lat,dropoff_lng,item_name,qty,size_tier,contact_name,contact_phone</p>
        <textarea id="csv" rows="5" dir="ltr" style="font-family:monospace;font-size:11px"></textarea>
        <div style="height:8px"></div>
        <button class="btn sm" style="width:100%" onclick="importCsv()">Import</button>
        <div id="csvResult"></div></div>
      <div class="card"><h3>📑 ${t('invoices')}</h3><div id="invList">${t('loading')}</div></div>
    </div>
    <div>
      <div class="card"><h3>🗂️ ${t('orders')} (${orders.length})</h3><div style="max-height:420px;overflow:auto">
      ${orders.map((o) => `<div class="row between" style="padding:8px 0;border-bottom:1px solid var(--line)">
        <div><b class="small" dir="ltr">${esc(o.waybill)}</b> <span class="badge gray">${o.category_slug}</span>
        <div class="small muted">${esc(o.driver_name || '—')}</div></div>
        <div style="text-align:end"><span class="status-chip st-${o.status}">${statusLabel(o.status)}</span>
        <div class="money small">${SAR(o.total)}</div></div></div>`).join('') || `<p class="muted small">${t('empty')}</p>`}</div></div>
      <div class="card"><h3>📖 ${t('addressBook')}</h3><div id="abList"></div>
        <button class="btn secondary sm" style="width:100%;margin-top:8px" onclick="addAddr()">➕ ${t('addAddress')}</button></div>
      ${profile?.category_id === waterCatId() || m.category_slug === 'water' ? `
      <div class="card"><h3>💧 ${t('waterStock')}</h3><div id="waterList">${t('loading')}</div></div>` : ''}
    </div>
  </div>`;
  loadAddrBook();
  loadInvoices();
  if (m.category_slug === 'water') loadWater();
}

function waterCatId() { return -1; }

async function loadAddrBook() {
  const list = await api('/merchant/addresses').catch(() => []);
  document.getElementById('abList').innerHTML = list.length
    ? list.map((a) => `<div style="padding:7px 0;border-bottom:1px solid var(--line)"><b class="small">${esc(a.label)}</b>
      <div class="small muted">${esc(a.address)}</div></div>`).join('')
    : `<p class="muted small">${t('empty')}</p>`;
}
window.addAddr = async () => {
  const label = prompt('Label:'); if (!label) return;
  const address = prompt('Address:'); if (!address) return;
  await api('/merchant/addresses', { method: 'POST', body: { label, address, lat: 21.55, lng: 39.17 } });
  loadAddrBook();
};
window.bulkForm = async () => {
  const pickup = prompt('Pickup address:'); if (!pickup) return;
  const drop = prompt('Drop-off address:');
  const item = prompt('Item name:', 'Carton');
  const qty = Number(prompt('Quantity:', '1') || 1);
  try {
    const r = await api('/merchant/orders/bulk', { method: 'POST', body: { orders: [{
      categorySlug: 'retail',
      pickup: { address: pickup, lat: 21.618, lng: 39.208 },
      dropoffs: [{ address: drop || pickup, lat: 21.562, lng: 39.172 }],
      items: [{ name: item, qty, size_tier: 'standard' }],
    }] } });
    toast(`✓ ${r.created} created, ${r.failed} failed`);
    location.reload();
  } catch (e) { toast(e.message); }
};
window.importCsv = async () => {
  const csv = document.getElementById('csv').value.trim();
  if (!csv) return;
  try {
    const r = await api('/merchant/orders/csv', { method: 'POST', body: { csv } });
    document.getElementById('csvResult').innerHTML = `<div class="badge green">✓ ${r.imported} imported, ${r.failed} failed</div>`;
  } catch (e) { toast(e.message); }
};
async function loadInvoices() {
  const list = await api('/merchant/invoices').catch(() => []);
  document.getElementById('invList').innerHTML = list.length
    ? list.map((i) => `<div class="row between" style="padding:7px 0;border-bottom:1px solid var(--line)">
      <div><b class="small" dir="ltr">${esc(i.number)}</b><div class="small muted">${i.period}</div></div>
      <div style="text-align:end"><b class="small">${SAR(i.total)}</b><div class="small muted">${i.status}</div></div></div>`).join('')
    : `<p class="muted small">${t('empty')}</p>`;
}
async function loadWater() {
  const list = await api('/merchant/water/products').catch(() => []);
  document.getElementById('waterList').innerHTML = list.map((w) => `
    <div class="row between" style="padding:7px 0;border-bottom:1px solid var(--line)">
      <div><b class="small">${esc(w.brand_en)}</b> <span class="small muted">${esc(w.size_label)}</span></div>
      <div class="row"><input style="width:70px" type="number" value="${w.stock_qty}" onchange="updStock(${w.id}, this.value)">
      <span class="money small">${SAR(w.unit_price)}</span></div></div>`).join('');
}
window.updStock = async (id, qty) => {
  await api('/merchant/water/products/' + id, { method: 'PATCH', body: { stockQty: Number(qty) } });
  toast('✓');
};
