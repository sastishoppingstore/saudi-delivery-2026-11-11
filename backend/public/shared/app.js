// Fiasta shared client helpers: API, i18n, UI widgets
window.FIA = (() => {
  const store = {
    get token() { return localStorage.getItem('fia_token') || ''; },
    set token(v) { v ? localStorage.setItem('fia_token', v) : localStorage.removeItem('fia_token'); },
    get user() { try { return JSON.parse(localStorage.getItem('fia_user')) || null; } catch { return null; } },
    set user(v) { v ? localStorage.setItem('fia_user', JSON.stringify(v)) : localStorage.removeItem('fia_user'); },
    get lang() { return localStorage.getItem('fia_lang') || 'ar'; },
    set lang(v) { localStorage.setItem('fia_lang', v); },
  };

  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (store.token) headers.Authorization = `Bearer ${store.token}`;
    const res = await fetch(`/api${path}`, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      const err = new Error(data?.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ---------- i18n: dictionaries live in /i18n/{en,ar}.json (served by the backend) ----------
  const I18N = { en: {}, ar: {} };
  // Frontends await FIA.ready before first render so t() has the strings.
  const ready = Promise.all(['en', 'ar'].map(async (lang) => {
    try {
      const res = await fetch(`/i18n/${lang}.json`, { cache: 'no-cache' });
      if (res.ok) I18N[lang] = await res.json();
    } catch { /* offline: t() falls back to the key */ }
  }));

  function t(key) {
    const lang = store.lang;
    return I18N[lang]?.[key] ?? I18N.en[key] ?? key;
  }

  function applyDir() {
    const lang = store.lang;
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  }

  // ---------- UI widgets ----------
  function toast(msg, ms = 2600) {
    document.querySelectorAll('.toast').forEach((n) => n.remove());
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  const SAR = (n) => `${Number(n || 0).toFixed(2)} SAR`;

  const STATUS_AR = {
    pending: 'قيد الانتظار', assigned: 'تم الإسناد', accepted: 'مقبول', en_route_pickup: 'في الطريق للاستلام',
    at_pickup: 'في موقع الاستلام', loading: 'جارِ التحميل', in_transit: 'في الطريق', at_dropoff: 'في موقع التسليم',
    delivered: 'تم التسليم', cancelled: 'ملغي', failed: 'فاشل',
  };
  const STATUS_EN = {
    pending: 'Pending', assigned: 'Assigned', accepted: 'Accepted', en_route_pickup: 'En route to pickup',
    at_pickup: 'At pickup', loading: 'Loading', in_transit: 'In transit', at_dropoff: 'At drop-off',
    delivered: 'Delivered', cancelled: 'Cancelled', failed: 'Failed',
  };
  function statusLabel(s) { return store.lang === 'ar' ? (STATUS_AR[s] || s) : (STATUS_EN[s] || s); }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Offline Jeddah map renderer (Google Maps integration stub — swap with real SDK when key is set)
  const JEDDAH_DISTRICTS = [
    ['Al Balad', 21.486, 39.180], ['Al Shati', 21.601, 39.133], ['Al Rawdah', 21.562, 39.172],
    ['Al Salamah', 21.587, 39.148], ['Al Zahra', 21.606, 39.181], ['Al Safa', 21.548, 39.199],
    ['Al Aziziyah', 21.530, 39.213], ['Al Andalus', 21.618, 39.208], ['Obhur', 21.680, 39.090],
    ['Al Marwah', 21.529, 39.245],
  ];
  function renderMap(el, pins, center = { lat: 21.55, lng: 39.17 }, span = 0.14) {
    const W = el.clientWidth || 360, H = el.clientHeight || 320;
    const toXY = (lat, lng) => ({
      x: ((lng - (center.lng - span)) / (2 * span)) * W,
      y: H - ((lat - (center.lat - span * 1.5)) / (3 * span)) * H,
    });
    let html = `<div class="sea" style="inset-inline-end:0;top:0;width:${W * 0.22}px;height:${H}px"></div>`;
    // main roads
    const roads = [[21.486, 39.18, 21.68, 39.09], [21.49, 39.25, 21.66, 39.12]];
    for (const [la1, lo1, la2, lo2] of roads) {
      const a = toXY(la1, lo1), b = toXY(la2, lo2);
      html += `<div class="road" style="left:${Math.min(a.x, b.x)}px;top:${Math.min(a.y, b.y)}px;width:${Math.hypot(b.x - a.x, b.y - a.y)}px;height:6px;transform-origin:0 50%;transform:rotate(${Math.atan2(b.y - a.y, b.x - a.x)}rad)"></div>`;
    }
    for (const [name, lat, lng] of JEDDAH_DISTRICTS) {
      const p = toXY(lat, lng);
      html += `<div class="lbl" style="left:${p.x}px;top:${p.y}px">${esc(name)}</div>`;
    }
    for (const pin of pins) {
      const p = toXY(pin.lat, pin.lng);
      html += `<div class="pin ${pin.me ? 'me' : ''}" style="left:${p.x}px;top:${p.y}px" title="${esc(pin.label || '')}">${pin.icon || '📍'}</div>`;
    }
    el.innerHTML = html;
  }

  function h(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html.trim();
    return tpl.content.firstChild;
  }

  async function otpLogin(phone, name) {
    const r = await api('/auth/otp/request', { method: 'POST', body: { phone } });
    return r.debugCode || null; // demo mode; production sends SMS
  }

  return { store, api, t, applyDir, toast, SAR, statusLabel, esc, renderMap, h, otpLogin, I18N, ready };
})();
