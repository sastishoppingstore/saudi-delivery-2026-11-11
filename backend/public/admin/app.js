// Fiasta Admin & Super Admin Dashboard
const { api, t, store, toast, SAR, statusLabel, esc } = FIA;
const main = document.getElementById('main');
const NAV = [
  ['dash', '📊 ' + t('dashboard')],
  ['fleet', '🛰️ ' + t('fleet')],
  ['orders', '🗂️ ' + t('orders')],
  ['dispatch', '🚀 ' + t('dispatch')],
  ['drivers', '🚚 ' + t('drivers')],
  ['vehicles', '🛻 ' + t('vehicles')],
  ['categories', '🧩 ' + t('categories')],
  ['pricing', '💰 ' + t('pricing')],
  ['zones', '🗺️ ' + t('zones')],
  ['merchants', '🏬 ' + t('merchants')],
  ['water', '💧 ' + t('waterStock')],
  ['lpg', '🔥 ' + t('compliance')],
  ['promos', '🎁 ' + t('promos')],
  ['payments', '💳 ' + t('payments')],
  ['settlements', '🧾 ' + t('settlements')],
  ['invoices', '📑 ' + t('invoices')],
  ['claims', '⚠️ ' + t('claims')],
  ['support', '🎧 ' + t('support')],
  ['users', '👥 ' + t('users')],
  ['reports', '📈 ' + t('reports')],
  ['audit', '🔎 ' + t('audit')],
];
let current = 'dash';

(async function boot() {
  await FIA.ready;
  FIA.applyDir();
  if (!store.token) return renderLogin();
  try {
    const me = await api('/me');
    if (!['admin', 'super_admin'].includes(me.user.role)) {
      main.innerHTML = '<div class="empty"><div class="ic">🚫</div>Admin access only — هذا الحساب ليس إدارياً</div>';
      return;
    }
    store.user = me.user;
    drawNav(); go('dash');
    if (window.io) {
      const socket = io({ auth: { token: store.token } });
      socket.on('order:new', () => { if (current === 'dispatch') go('dispatch'); });
      socket.on('order:updated', () => { if (current === 'dispatch' || current === 'fleet') go(current); });
    }
  } catch { store.token = ''; renderLogin(); }
})();

function renderLogin() {
  main.innerHTML = `<div style="max-width:400px;margin:80px auto">
    <div class="card"><h3>Fiasta Admin</h3>
      <label class="f">${t('phone')}</label><input id="ph" dir="ltr" placeholder="05XXXXXXXX">
      <div id="oa" style="display:none"><label class="f">${t('code')}</label>
        <input id="cd" dir="ltr" maxlength="6" style="text-align:center;font-size:22px;font-weight:800;letter-spacing:6px">
        <p class="small muted" id="hint"></p></div>
      <div style="height:12px"></div><button class="btn" id="go">${t('sendCode')}</button>
      <p class="small muted" style="margin-top:10px">Demo admin: 0500000000</p></div></div>`;
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
        if (!['admin', 'super_admin'].includes(r.user.role)) return toast('ليس حساب إدارة');
        store.token = r.token; store.user = r.user;
        location.reload();
      } catch (e) { toast(e.message); }
    }
  };
}

function drawNav() {
  document.getElementById('nav').innerHTML = NAV.map(([k, label]) =>
    `<a href="#" class="${current === k ? 'active' : ''}" onclick="go('${k}');return false">${label}</a>`).join('');
}
window.go = async (k) => {
  current = k; drawNav();
  main.innerHTML = `<div class="muted">${t('loading')}</div>`;
  try { await VIEWS[k](); } catch (e) { main.innerHTML = `<div class="empty"><div class="ic">⚠️</div>${esc(e.message)}</div>`; }
};

const tbl = (head, rows) => `<div class="card" style="overflow-x:auto"><table class="tbl">
  <thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
  <tbody>${rows.join('') || `<tr><td colspan="${head.length}" class="muted">${t('empty')}</td></tr>`}</tbody></table></div>`;

const VIEWS = {
  // ---------- dashboard ----------
  async dash() {
    const s = await api('/admin/stats');
    const statusCount = (st) => s.byStatus.find((x) => x.status === st)?.n || 0;
    main.innerHTML = `
      <h2 style="margin-bottom:14px">${t('dashboard')}</h2>
      <div class="grid3" style="grid-template-columns:repeat(4,1fr)">
        <div class="kpi accent"><div class="v">${SAR(s.revenue)}</div><div class="l">Revenue (paid)</div></div>
        <div class="kpi"><div class="v">${s.today.n || 0}</div><div class="l">Orders today</div></div>
        <div class="kpi"><div class="v">${statusCount('pending')}</div><div class="l">${t('pending')} dispatch</div></div>
        <div class="kpi"><div class="v">${s.onlineDrivers}</div><div class="l">Drivers online</div></div>
      </div>
      <div class="grid2" style="margin-top:14px">
        <div class="card"><h3>Orders by status</h3>
          ${s.byStatus.map((x) => `<div class="row between" style="padding:5px 0"><span class="status-chip st-${x.status}">${statusLabel(x.status)}</span><b>${x.n}</b></div>`).join('')}</div>
        <div class="card"><h3>Top categories</h3>
          ${s.topCategories.map((c) => `<div class="row between" style="padding:5px 0"><span class="small">${esc(store.lang === 'ar' ? c.name_ar : c.name_en)}</span><b>${c.n}</b></div>`).join('') || '<p class="muted small">—</p>'}</div>
      </div>
      <div class="card"><h3>Fleet (5× HiAce + 1 box truck)</h3>${tbl(
        ['Plate', 'Model', 'Class', 'Payload', 'LPG', 'Driver', 'Status'],
        s.fleet.map((v) => `<tr><td dir="ltr"><b>${esc(v.plate)}</b></td><td>${esc(v.model)}</td><td><span class="badge gray">${v.class}</span></td>
          <td>${v.payload_kg} kg</td><td>${v.lpg_approved ? '✅' : '—'}</td><td>${esc(v.driver_name || '—')}</td>
          <td>${v.availability ? `<span class="badge ${v.availability === 'online' ? 'green' : 'gray'}">${v.availability}</span>` : '—'}</td></tr>`))}</div>`;
  },

  // ---------- live fleet ----------
  async fleet() {
    const drivers = await api('/admin/fleet');
    main.innerHTML = `<h2 style="margin-bottom:14px">${t('fleet')}</h2>
      <div class="jmap" id="fmap" style="height:420px"></div>
      <div style="height:14px"></div>
      ${tbl(['Driver', 'Phone', 'Vehicle', 'Availability', 'Active jobs', 'Rating', 'Last seen'],
        drivers.map((d) => `<tr><td><b>${esc(d.name)}</b></td><td dir="ltr">${esc(d.phone)}</td>
        <td>${esc(d.plate || '—')} <span class="badge gray">${d.class || ''}</span></td>
        <td><span class="badge ${d.availability === 'online' ? 'green' : d.availability === 'busy' ? 'amber' : 'gray'}">${d.availability}</span></td>
        <td>${d.active_jobs}</td><td>⭐ ${d.rating?.toFixed?.(1)}</td><td class="small muted">${d.location_at || '—'}</td></tr>`))}`;
    FIA.renderMap(document.getElementById('fmap'),
      drivers.filter((d) => d.lat).map((d) => ({ lat: d.lat, lng: d.lng, icon: d.availability === 'busy' ? '🔴' : '🚚', label: d.name })),
      { lat: 21.55, lng: 39.17 }, 0.16);
  },

  // ---------- orders ----------
  async orders() {
    const all = await api('/admin/orders');
    main.innerHTML = `<h2 style="margin-bottom:14px">${t('orders')} (${all.length})</h2>
      <div class="card" style="overflow-x:auto"><table class="tbl"><thead><tr>
      <th>Waybill</th><th>Category</th><th>Customer</th><th>Driver</th><th>${t('status')}</th><th>Payment</th><th>${t('total')}</th><th>Date</th><th></th></tr></thead>
      <tbody>${all.map((o) => `<tr><td dir="ltr"><b>${esc(o.waybill)}</b></td><td><span class="badge gray">${o.category_slug}</span></td>
        <td>${esc(o.customer_name || '—')}</td><td>${esc(o.driver_name || '—')}</td>
        <td><span class="status-chip st-${o.status}">${statusLabel(o.status)}</span></td>
        <td><span class="badge ${o.payment_status === 'paid' ? 'green' : 'amber'}">${o.payment_status}</span></td>
        <td><b>${SAR(o.total)}</b></td><td class="small muted">${o.created_at?.slice(0, 16)}</td>
        <td><button class="btn sm secondary" onclick="viewOrder(${o.id})">👁</button></td></tr>`).join('')}</tbody></table></div>`;
  },

  // ---------- dispatch ----------
  async dispatch() {
    const pending = await api('/admin/dispatch/pending');
    main.innerHTML = `<h2 style="margin-bottom:14px">${t('dispatch')} — ${t('pending')} (${pending.length})</h2>` +
      (pending.length ? pending.map((o) => `
      <div class="card fade-in"><div class="row between">
        <div><b dir="ltr">${esc(o.waybill)}</b> <span class="badge gray">${o.category_slug}</span>
        ${o.priority === 'priority' ? '<span class="badge amber">⚡</span>' : ''}
        <div class="small muted">📍 ${esc(o.pickup || '')}</div></div>
        <div class="money">${SAR(o.total)}</div></div>
        <div class="divider"></div>
        <div class="row" style="flex-wrap:wrap;gap:8px">
          ${o.eligibleDrivers.filter((d) => d.eligible).map((d) => `<button class="btn sm secondary" onclick="manualDispatch(${o.id},${d.id})">→ ${esc(d.name)}</button>`).join('') || '<span class="badge red">no eligible driver</span>'}
          <button class="btn sm" onclick="autoDispatch(${o.id})">⚡ auto-dispatch</button>
        </div></div>`).join('') : `<div class="empty"><div class="ic">✅</div>All orders dispatched</div>`);
  },

  // ---------- drivers ----------
  async drivers() {
    const list = await api('/admin/drivers');
    const vehicles = await api('/admin/vehicles');
    main.innerHTML = `<h2 style="margin-bottom:14px">${t('drivers')} (${list.length})</h2>` + tbl(
      ['Driver', 'Phone', 'Vehicle', 'LPG cert', 'Approved', 'Availability', 'Jobs', ''],
      list.map((d) => `<tr><td><b>${esc(d.name)}</b></td><td dir="ltr">${esc(d.phone)}</td>
        <td><select onchange="assignVehicle(${d.id},this.value)">
          ${vehicles.map((v) => `<option value="${v.id}" ${d.vehicle_id === v.id ? 'selected' : ''}>${esc(v.plate)} — ${esc(v.model)}</option>`).join('')}
        </select></td>
        <td>${d.lpg_certified ? '✅' : '—'}</td>
        <td><span class="badge ${d.approved ? 'green' : 'amber'}">${d.approved ? 'approved' : 'pending'}</span></td>
        <td><span class="badge ${d.availability === 'online' ? 'green' : 'gray'}">${d.availability}</span></td>
        <td>${d.total_jobs}</td>
        <td><button class="btn sm ${d.approved ? 'danger' : ''}" onclick="approveDriver(${d.id},${d.approved ? 'false' : 'true'})">${d.approved ? 'suspend' : 'approve'}</button></td></tr>`));
  },

  // ---------- vehicles ----------
  async vehicles() {
    const list = await api('/admin/vehicles');
    main.innerHTML = `<h2 style="margin-bottom:14px">${t('vehicles')}</h2>
      <div class="card"><h3>➕ Add vehicle</h3>
        <div class="grid2"><input id="vPlate" dir="ltr" placeholder="Plate ه ج ب 1234"><input id="vModel" placeholder="Toyota HiAce 2024"></div>
        <div class="grid2" style="margin-top:8px">
          <select id="vClass"><option value="hiace">HiAce</option><option value="hiace_high_roof">HiAce high roof</option><option value="box_truck">Box truck</option></select>
          <input id="vKg" type="number" placeholder="Payload kg" value="900"></div>
        <button class="btn sm" style="width:100%;margin-top:8px" onclick="addVehicle()">Save</button></div>` +
      tbl(['Plate', 'Model', 'Class', 'Payload', 'Volume', 'LPG approved', 'Active', ''],
        list.map((v) => `<tr><td dir="ltr"><b>${esc(v.plate)}</b></td><td>${esc(v.model)}</td><td><span class="badge gray">${v.class}</span></td>
        <td>${v.payload_kg} kg</td><td>${v.volume_m3} m³</td>
        <td><div class="switch ${v.lpg_approved ? 'on' : ''}" onclick="toggleVehicle(${v.id},'lpgApproved',${!v.lpg_approved})"></div></td>
        <td><div class="switch ${v.active ? 'on' : ''}" onclick="toggleVehicle(${v.id},'active',${!v.active})"></div></td>
        <td></td></tr>`));
  },

  // ---------- categories ----------
  async categories() {
    const cats = await api('/admin/categories');
    const STATE_BADGE = { active: 'green', disabled: 'red', partner_only: 'amber', compliance_approved: 'blue' };
    main.innerHTML = `<h2 style="margin-bottom:14px">${t('categories')}</h2>
      <p class="small muted" style="margin-bottom:10px">States: active • disabled • partner_only • compliance_approved — LPG stays locked until compliance is verified.</p>` +
      cats.map((c) => `<div class="card fade-in"><div class="row between">
        <div><b>${esc(c.icon)} ${esc(c.name_en)} — ${esc(c.name_ar)}</b>
          <div class="small muted">${esc(c.slug)} • ${c.state === 'active' ? '' : c.state.replace(/_/g, ' ')}</div></div>
        <select onchange="setCatState(${c.id},this.value)">
          ${['active', 'disabled', 'partner_only', 'compliance_approved'].map((s) => `<option value="${s}" ${c.state === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select></div>
        <div class="divider"></div>
        <div class="row" style="gap:6px;flex-wrap:wrap">
        <button class="btn sm secondary" onclick="addItem(${c.id},'${esc(c.slug)}')">➕ item</button>
        <span id="items-${c.id}" class="row" style="gap:6px;flex-wrap:wrap"></span></div></div>`).join('');
    for (const c of cats) loadItems(c.id);
  },

  // ---------- pricing ----------
  async pricing() {
    const p = await api('/admin/pricing');
    main.innerHTML = `<h2 style="margin-bottom:14px">${t('pricing')} engine</h2>
      <div class="card"><p class="small muted">Every value below is live — the quote API uses it instantly.</p></div>` +
      p.config.map((row) => `<div class="card" style="padding:12px"><div class="row between">
        <div><b class="small">${esc(row.label || row.key)}</b><div class="small muted" dir="ltr">${esc(row.key)}</div></div>
        <input style="width:180px" dir="ltr" value="${esc(typeof row.value === 'object' ? JSON.stringify(row.value) : row.value)}"
          onchange="savePricing('${esc(row.key)}', this.value)"></div></div>`).join('');
  },

  // ---------- zones ----------
  async zones() {
    const zones = await api('/admin/zones');
    main.innerHTML = `<h2 style="margin-bottom:14px">${t('zones')} — Jeddah</h2>` + tbl(
      ['District', 'Lat', 'Lng', 'Radius', 'Surcharge', 'Active'],
      zones.map((z) => `<tr><td><b>${esc(z.name_en)}</b> <span class="small muted">${esc(z.name_ar)}</span></td>
        <td dir="ltr">${z.lat}</td><td dir="ltr">${z.lng}</td>
        <td><input style="width:70px" type="number" step="0.5" value="${z.radius_km}" onchange="zoneUpd(${z.id},'radiusKm',this.value)"></td>
        <td><input style="width:80px" type="number" value="${z.surcharge}" onchange="zoneUpd(${z.id},'surcharge',this.value)"></td>
        <td><div class="switch ${z.active ? 'on' : ''}" onclick="zoneUpd(${z.id},'active',${z.active ? 'false' : 'true'})"></div></td></tr>`));
  },

  // ---------- merchants ----------
  async merchants() {
    const list = await api('/admin/merchants');
    main.innerHTML = `<h2 style="margin-bottom:14px">${t('merchants')}</h2>` + tbl(
      ['Business', 'CR', 'VAT', 'Category', 'Status', 'Discount %', ''],
      list.map((m) => `<tr><td><b>${esc(m.business_name)}</b><div class="small muted" dir="ltr">${esc(m.phone)}</div></td>
        <td dir="ltr">${esc(m.cr_number)}</td><td dir="ltr">${esc(m.vat_number)}</td><td>${esc(m.category_slug || '—')}</td>
        <td><span class="badge ${m.status === 'approved' ? 'green' : m.status === 'pending' ? 'amber' : 'red'}">${m.status}</span></td>
        <td><input style="width:70px" type="number" value="${m.negotiated_discount_pct}" onchange="merchantUpd(${m.id},this.value)"></td>
        <div></td>
        <td><button class="btn sm" onclick="merchantStatus(${m.id},'${m.status === 'approved' ? 'suspended' : 'approved'}')">${m.status === 'approved' ? 'suspend' : 'approve'}</button></td></tr>`));
  },

  // ---------- water ----------
  async water() {
    const products = await api('/admin/water/products');
    main.innerHTML = `<h2 style="margin-bottom:14px">${t('waterStock')}</h2>` + tbl(
      ['Supplier', 'Brand', 'Size', 'Price', 'Stock', 'Active'],
      products.map((w) => `<tr><td>${esc(w.business_name)}</td><td><b>${esc(w.brand_en)}</b> <span class="small muted">${esc(w.brand_ar)}</span></td>
        <td>${esc(w.size_label)}</td><td>${SAR(w.unit_price)}</td><td>${w.stock_qty}</td>
        <td>${w.active ? '✅' : '—'}</td></tr>`));
  },

  // ---------- LPG compliance ----------
  async lpg() {
    const rows = await api('/admin/lpg/compliance');
    const cat = (await api('/admin/categories')).find((c) => c.slug === 'lpg');
    const vehicles = await api('/admin/vehicles');
    const drivers = await api('/admin/drivers');
    main.innerHTML = `<h2 style="margin-bottom:10px">${t('compliance')}</h2>
      <div class="card" style="border:2px solid ${cat.state === 'active' ? 'var(--green)' : 'var(--red)'}">
        <div class="row between"><div><b>LPG category state</b><div class="small muted">Unlocks only when distributor licence + vehicle approval + driver certificate are all verified.</div></div>
        <span class="badge ${cat.state === 'active' ? 'green' : 'red'}" style="font-size:14px">${cat.state}</span></div></div>
      <div class="card"><h3>➕ Add document</h3>
        <div class="grid2">
          <select id="lpgDriver">${drivers.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select>
          <select id="lpgVehicle">${vehicles.map((v) => `<option value="${v.id}">${esc(v.plate)}</option>`).join('')}</select></div>
        <div class="grid2" style="margin-top:8px">
          <select id="lpgType"><option value="distributor_licence">distributor_licence</option><option value="vehicle_approval">vehicle_approval</option><option value="driver_cert">driver_cert</option><option value="insurance">insurance</option></select>
          <input id="lpgRef" dir="ltr" placeholder="Document reference"></div>
        <button class="btn sm" style="width:100%;margin-top:8px" onclick="addLpgDoc()">Add</button></div>` +
      tbl(['Driver', 'Vehicle', 'Document', 'Ref', 'Verified', ''],
        rows.map((r) => `<tr><td>${esc(r.driver_name)}</td><td dir="ltr">${esc(r.plate)}</td>
        <td><span class="badge gray">${r.doc_type}</span></td><td dir="ltr" class="small">${esc(r.doc_ref)}</td>
        <td>${r.verified ? `✅ <span class="small muted">${r.verified_at?.slice(0, 10)}</span>` : '⏳'}</td>
        <td><button class="btn sm ${r.verified ? 'danger' : ''}" onclick="verifyLpg(${r.id},${r.verified ? 'false' : 'true'})">${r.verified ? 'revoke' : 'verify'}</button></td></tr>`));
  },

  // ---------- promos ----------
  async promos() {
    const list = await api('/admin/promos');
    main.innerHTML = `<h2 style="margin-bottom:14px">${t('promos')}</h2>
      <div class="card"><div class="grid2">
        <input id="pCode" dir="ltr" placeholder="CODE">
        <select id="pKind"><option value="percent">percent %</option><option value="fixed">fixed SAR</option></select>
        <input id="pVal" type="number" placeholder="Value">
        <input id="pMin" type="number" placeholder="Min order SAR"></div>
        <button class="btn sm" style="width:100%;margin-top:8px" onclick="addPromo()">➕ Add promo</button></div>` +
      tbl(['Code', 'Kind', 'Value', 'Min order', 'Used', 'Active'],
        list.map((p) => `<tr><td dir="ltr"><b>${esc(p.code)}</b></td><td>${p.kind}</td><td>${p.value}</td>
        <td>${SAR(p.min_order)}</td><td>${p.used_count}${p.max_uses ? '/' + p.max_uses : ''}</td>
        <td>${p.active ? '✅' : '—'}</td></tr>`));
  },

  // ---------- payments ----------
  async payments() {
    const list = await api('/admin/payments');
    main.innerHTML = `<h2 style="margin-bottom:14px">${t('payments')} <span class="badge amber">mock gateway — integration pending</span></h2>` + tbl(
      ['Waybill', 'Provider', 'Amount', 'Status', 'When', ''],
      list.map((p) => `<tr><td dir="ltr"><b>${esc(p.waybill)}</b></td><td>${p.provider}</td><td>${SAR(p.amount)}</td>
      <td><span class="badge ${p.status === 'captured' ? 'green' : p.status === 'refunded' ? 'gray' : 'amber'}">${p.status}</span></td>
      <td class="small muted">${p.at?.slice(0, 16)}</td>
      <td><select onchange="reconcile(${p.id},this.value)">
        ${['captured', 'failed', 'refunded'].map((s) => `<option ${p.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></td></tr>`));
  },

  // ---------- settlements ----------
  async settlements() {
    const list = await api('/admin/settlements');
    main.innerHTML = `<h2 style="margin-bottom:14px">${t('settlements')}</h2>
      <div class="card"><div class="row"><input id="setPeriod" dir="ltr" placeholder="2025-11" style="width:140px">
      <button class="btn sm" onclick="genSettlements()">⚙️ Generate</button>
      <a class="btn sm secondary" href="/api/admin/reports/settlements.csv" download>⬇ CSV</a></div></div>` +
      tbl(['Driver', 'Period', 'Jobs', 'Gross', 'Payout (70%)', 'Status', ''],
        list.map((s) => `<tr><td>${esc(s.driver_name)}</td><td dir="ltr">${s.period}</td><td>${s.jobs}</td>
        <td>${SAR(s.gross)}</td><td><b>${SAR(s.payout)}</b></td>
        <td><span class="badge ${s.status === 'paid' ? 'green' : 'amber'}">${s.status}</span></td>
        <td>${s.status !== 'paid' ? `<button class="btn sm" onclick="paySettlement(${s.id})">✓ pay</button>` : ''}</td></tr>`));
  },

  // ---------- invoices ----------
  async invoices() {
    const list = await api('/admin/invoices');
    main.innerHTML = `<h2 style="margin-bottom:14px">${t('invoices')}</h2>
      <div class="card"><div class="row"><input id="invPeriod" dir="ltr" placeholder="2025-11" style="width:140px">
      <button class="btn sm" onclick="genInvoices()">⚙️ Generate monthly invoices</button></div></div>` +
      tbl(['Number', 'Merchant', 'Period', 'Subtotal', 'VAT', 'Total', 'Status'],
        list.map((i) => `<tr><td dir="ltr"><b>${esc(i.number)}</b></td><td>${esc(i.business_name || '—')}</td>
        <td dir="ltr">${i.period}</td><td>${SAR(i.subtotal)}</td><td>${SAR(i.vat)}</td><td><b>${SAR(i.total)}</b></td>
        <td><span class="badge ${i.status === 'paid' ? 'green' : 'amber'}">${i.status}</span></td></tr>`));
  },

  // ---------- claims ----------
  async claims() {
    const list = await api('/admin/claims');
    main.innerHTML = `<h2 style="margin-bottom:14px">${t('claims')}</h2>` + tbl(
      ['Order', 'Kind', 'By', 'Description', 'Status', ''],
      list.map((c) => `<tr><td dir="ltr"><b>${esc(c.waybill)}</b></td><td><span class="badge gray">${c.kind}</span></td>
      <td>${esc(c.opened_by_name)}</td><td class="small">${esc(c.description.slice(0, 80))}</td>
      <td><span class="badge ${c.status === 'resolved' ? 'green' : c.status === 'rejected' ? 'red' : 'amber'}">${c.status}</span></td>
      <td><button class="btn sm" onclick="resolveClaim(${c.id})">resolve</button></td></tr>`));
  },

  // ---------- support ----------
  async support() {
    const list = await api('/admin/support');
    main.innerHTML = `<h2 style="margin-bottom:14px">${t('support')}</h2>` + tbl(
      ['User', 'Subject', 'Body', 'Status', ''],
      list.map((tk) => `<tr><td>${esc(tk.user_name)}<div class="small muted" dir="ltr">${esc(tk.phone)}</div></td>
      <td><b class="small">${esc(tk.subject)}</b></td><td class="small">${esc(tk.body.slice(0, 60))}</td>
      <td><span class="badge ${tk.status === 'answered' ? 'green' : 'amber'}">${tk.status}</span></td>
      <td><button class="btn sm" onclick="replyTicket(${tk.id})">↩ reply</button></td></tr>`));
  },

  // ---------- users ----------
  async users() {
    const list = await api('/admin/users');
    main.innerHTML = `<h2 style="margin-bottom:14px">${t('users')} (${list.length})</h2>` + tbl(
      ['Name', 'Phone', 'Role', 'Active', 'Joined', ''],
      list.map((u) => `<tr><td><b>${esc(u.name || '—')}</b></td><td dir="ltr">${esc(u.phone)}</td>
      <td><span class="badge gray">${u.role}</span></td>
      <td><div class="switch ${u.active ? 'on' : ''}" onclick="toggleUser(${u.id},${u.active ? 'false' : 'true'})"></div></td>
      <td class="small muted">${u.created_at?.slice(0, 10)}</td><td></td></tr>`));
  },

  // ---------- reports ----------
  async reports() {
    main.innerHTML = `<h2 style="margin-bottom:14px">${t('reports')}</h2>
      <div class="grid2">
        <a class="card" href="/api/admin/reports/orders.csv" download style="text-decoration:none;color:inherit">
          <h3>⬇ Orders CSV</h3><p class="small muted">All orders with fees, VAT, payment status</p></a>
        <a class="card" href="/api/admin/reports/settlements.csv" download style="text-decoration:none;color:inherit">
          <h3>⬇ Settlements CSV</h3><p class="small muted">Driver payouts by period</p></a>
      </div>
      <div class="card"><h3>PDF export</h3><p class="small muted">Use browser Print → Save as PDF on any table view (invoices, POD).</p></div>`;
  },

  // ---------- audit ----------
  async audit() {
    const list = await api('/admin/audit');
    main.innerHTML = `<h2 style="margin-bottom:14px">${t('audit')} log</h2>` + tbl(
      ['When', 'Actor', 'Action', 'Entity', 'Detail'],
      list.map((a) => `<tr><td class="small muted">${a.at?.slice(0, 19)}</td><td>${esc(a.actor_name || 'system')}</td>
      <td><span class="badge blue">${esc(a.action)}</span></td><td class="small">${esc(a.entity)}${a.entity_id ? ' #' + a.entity_id : ''}</td>
      <td class="small muted" style="max-width:260px;overflow:hidden;text-overflow:ellipsis">${esc(a.detail)}</td></tr>`));
  },
};

// ---------- admin actions ----------
window.viewOrder = async (id) => {
  const o = await api('/admin/orders/' + id);
  main.innerHTML = `<div class="card fade-in"><div class="row between">
    <h2 dir="ltr">${esc(o.waybill)}</h2><span class="status-chip st-${o.status}">${statusLabel(o.status)}</span></div>
    <div class="divider"></div>
    <div class="grid2">
      <div><b class="small">${t('customer')}</b><div class="small">${esc(o.customer_name || '—')}</div></div>
      <div><b class="small">${t('driver')}</b><div class="small">${esc(o.driver_name || '—')} ${esc(o.vehicle_plate || '')}</div></div>
      <div><b class="small">${t('pickup')}</b><div class="small">${esc(o.stops.find((s) => s.kind === 'pickup')?.address || '')}</div></div>
      <div><b class="small">${t('dropoff')}</b><div class="small">${o.stops.filter((s) => s.kind === 'dropoff').map((s) => esc(s.address)).join(' → ')}</div></div>
    </div>
    <div class="divider"></div>
    ${o.items.map((i) => `<div class="row between"><span class="small">${esc(i.name)} × ${i.qty}</span><span class="badge gray">${i.size_tier}</span></div>`).join('')}
    <div class="divider"></div>
    ${o.price_breakdown.map((l) => `<div class="row between"><span class="small muted">${esc(l.label)}</span><b class="small">${SAR(l.amount)}</b></div>`).join('')}
    <div class="row between"><b>${t('total')}</b><span class="money">${SAR(o.total)}</span></div>
    ${o.pod ? `<div class="divider"></div><b class="small">✅ POD:</b> <span class="small muted">${o.pod.method} • ${esc(o.pod.receiver_name || '')}</span>` : ''}
    <div class="divider"></div><button class="btn secondary sm" onclick="go('orders')">← back</button></div>`;
};
window.manualDispatch = async (orderId, driverId) => {
  try { await api('/admin/dispatch/' + orderId, { method: 'POST', body: { driverId } }); toast('✓ assigned'); go('dispatch'); }
  catch (e) { toast(e.message); }
};
window.autoDispatch = async (orderId) => {
  try { await api('/admin/dispatch/' + orderId, { method: 'POST', body: {} }); toast('✓ auto-dispatched'); go('dispatch'); }
  catch (e) { toast(e.message); }
};
window.approveDriver = async (id, approved) => {
  await api('/admin/drivers/' + id + '/approve', { method: 'POST', body: { approved } });
  go('drivers');
};
window.assignVehicle = async (id, vehicleId) => {
  await api('/admin/drivers/' + id + '/assign-vehicle', { method: 'POST', body: { vehicleId: Number(vehicleId) } });
  toast('✓'); go('drivers');
};
window.addVehicle = async () => {
  try {
    await api('/admin/vehicles', { method: 'POST', body: {
      plate: document.getElementById('vPlate').value, model: document.getElementById('vModel').value,
      class: document.getElementById('vClass').value, payloadKg: Number(document.getElementById('vKg').value),
    } });
    toast('✓'); go('vehicles');
  } catch (e) { toast(e.message); }
};
window.toggleVehicle = async (id, field, val) => {
  await api('/admin/vehicles/' + id, { method: 'PATCH', body: { [field]: val } });
  go('vehicles');
};
window.setCatState = async (id, state) => {
  try { await api('/admin/categories/' + id, { method: 'PATCH', body: { state } }); toast('✓ ' + state); go('categories'); }
  catch (e) { toast(e.message); document.getElementById('main').querySelectorAll('select').forEach(() => go('categories')); }
};
window.addItem = async (catId, slug) => {
  const nameEn = prompt('Name (EN):'); if (!nameEn) return;
  const nameAr = prompt('الاسم (AR):') || nameEn;
  const sizeTier = prompt('size tier: standard / bulky / extra_bulky', 'standard') || 'standard';
  try {
    await api('/admin/categories/' + catId + '/items', { method: 'POST', body: { nameEn, nameAr, sizeTier } });
    toast('✓'); go('categories');
  } catch (e) { toast(e.message); }
};
window.loadItems = async (catId) => {
  const el = document.getElementById('items-' + catId);
  if (!el) return;
  const items = await api('/categories/' + catId + '/items?lang=en').catch(() => []);
  el.innerHTML = items.slice(0, 6).map((i) => `<span class="badge gray">${esc(typeof i.name === 'string' ? i.name : i.name.en)}</span>`).join('');
};
window.savePricing = async (key, raw) => {
  let value;
  try { value = JSON.parse(raw); } catch { value = raw; }
  try { await api('/admin/pricing/' + key, { method: 'PUT', body: { value } }); toast('✓ live'); }
  catch (e) { toast(e.message); }
};
window.zoneUpd = async (id, field, val) => {
  const body = { [field]: field === 'active' ? val : Number(val) };
  await api('/admin/zones/' + id, { method: 'PATCH', body });
  toast('✓');
};
window.merchantStatus = async (id, status) => {
  await api('/admin/merchants/' + id + '/status', { method: 'POST', body: { status } });
  go('merchants');
};
window.merchantUpd = async (id, pct) => {
  await api('/admin/merchants/' + id + '/status', { method: 'POST', body: { status: 'approved', discountPct: Number(pct) } });
};
window.addLpgDoc = async () => {
  try {
    await api('/admin/lpg/compliance', { method: 'POST', body: {
      driverId: Number(document.getElementById('lpgDriver').value),
      vehicleId: Number(document.getElementById('lpgVehicle').value),
      docType: document.getElementById('lpgType').value,
      docRef: document.getElementById('lpgRef').value,
    } });
    toast('✓'); go('lpg');
  } catch (e) { toast(e.message); }
};
window.verifyLpg = async (id, verified) => {
  try {
    const r = await api('/admin/lpg/compliance/' + id + '/verify', { method: 'POST', body: { verified } });
    toast(r.allVerified ? '✅ all verified — LPG unlocked' : '✓ saved');
    go('lpg');
  } catch (e) { toast(e.message); }
};
window.addPromo = async () => {
  try {
    await api('/admin/promos', { method: 'POST', body: {
      code: document.getElementById('pCode').value, kind: document.getElementById('pKind').value,
      value: Number(document.getElementById('pVal').value), minOrder: Number(document.getElementById('pMin').value || 0),
    } });
    toast('✓'); go('promos');
  } catch (e) { toast(e.message); }
};
window.reconcile = async (id, status) => {
  await api('/admin/payments/' + id + '/reconcile', { method: 'POST', body: { status } });
  toast('✓');
};
window.genSettlements = async () => {
  try {
    const r = await api('/admin/settlements/generate', { method: 'POST', body: { period: document.getElementById('setPeriod').value } });
    toast(`✓ ${r.settlements} settlements`); go('settlements');
  } catch (e) { toast(e.message); }
};
window.paySettlement = async (id) => {
  await api('/admin/settlements/' + id + '/pay', { method: 'POST' });
  go('settlements');
};
window.genInvoices = async () => {
  try {
    const r = await api('/admin/invoices/generate', { method: 'POST', body: { period: document.getElementById('invPeriod').value } });
    toast(`✓ ${r.created.length} invoices`); go('invoices');
  } catch (e) { toast(e.message); }
};
window.resolveClaim = async (id) => {
  const resolution = prompt('Resolution:'); if (!resolution) return;
  const amount = Number(prompt('Refund amount (0 = none):') || 0);
  await api('/admin/claims/' + id, { method: 'POST', body: { status: 'resolved', resolution, amount } });
  go('claims');
};
window.replyTicket = async (id) => {
  const reply = prompt('Reply:'); if (!reply) return;
  await api('/admin/support/' + id + '/reply', { method: 'POST', body: { reply } });
  go('support');
};
window.toggleUser = async (id, active) => {
  await api('/admin/users/' + id + '/active', { method: 'POST', body: { active } });
  go('users');
};
