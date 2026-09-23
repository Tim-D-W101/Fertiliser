/*
 * Fertiliser Stock — deliveries in, bags used by the mixer, stock on hand.
 *
 * Built the same way as Tikita: data lives in this device's localStorage and,
 * once the company code is entered, is mirrored to every other device through
 * sync.js. Excel files are built in the browser (xlsx.js) and handed to the
 * share sheet on a tablet or phone, or downloaded on a PC.
 *
 * Stock is never stored as a number. It is the sum of every movement that has
 * not been cancelled: deliveries add bags, usage takes them away, a stock
 * count adds or removes the difference. The log is the single source of truth.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'fertiliser.v1';
  var DEVICE_KEY = 'fertiliser.device';
  var SCHEMA_VERSION = 1;
  var CURRENCY = 'R';

  var KIND_LABEL = { delivery: 'Delivery', usage: 'Used', adjustment: 'Stock count' };
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                     'August', 'September', 'October', 'November', 'December'];
  var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  /* Views only the manager sees once a PIN is set on this device. */
  var MANAGER_VIEWS = { delivery: 1, count: 1, report: 1, setup: 1 };
  var RELOCK_MS = 15 * 60 * 1000;

  var IS_DESKTOP = !!window.fertDesktop;
  var DEVICE = IS_DESKTOP ? 'PC' : 'device';

  // ── state ──────────────────────────────────────────────

  var state = {
    products: [],   // {id, name, kg, cost, reorder, active}
    moves: [],      // {id, pid, kind, bags (+in/-out), kg, cost, by, note, at, voidAt, voidBy, voidReason}
    prices: [],     // {id, pid, cost, at, by} — every price a fertiliser has had
    sync: null,     // see sync.js
    pending: null   // changes this device still owes the others
  };

  /* Settings for this device only: never synced, never in a backup. */
  var device = { name: '', pinHash: '' };
  var unlocked = false;
  var lastActivity = Date.now();

  var ui = {
    view: 'stock',
    month: monthKey(new Date()),
    logFrom: dateKey(addDays(new Date(), -30)),
    logTo: dateKey(new Date()),
    logPid: '',
    logKind: '',
    editPid: null,     // fertiliser being edited on Setup
    voidId: null,      // log entry whose cancel box is open
    draft: {}          // half-filled forms, so a re-render never loses typing
  };

  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        state.products = Array.isArray(parsed.products) ? parsed.products : [];
        state.moves = Array.isArray(parsed.moves) ? parsed.moves : [];
        state.prices = Array.isArray(parsed.prices) ? parsed.prices : [];
        if (parsed.sync) state.sync = parsed.sync;
        if (parsed.pending) state.pending = parsed.pending;
      }
      var dev = localStorage.getItem(DEVICE_KEY);
      if (dev) {
        var d = JSON.parse(dev);
        device.name = d.name || '';
        device.pinHash = d.pinHash || '';
      }
    } catch (err) {
      toast('Saved data could not be read, or this browser is blocking storage.');
    }
  }

  /*
   * Written synchronously on every change. A tablet can be locked or the app
   * swiped away a moment after a tap, so a deferred write could lose it.
   */
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: SCHEMA_VERSION,
        products: state.products,
        moves: state.moves,
        prices: state.prices,
        sync: state.sync,
        pending: state.pending
      }));
    } catch (err) {
      toast('Could not save — device storage may be full.');
    }
  }

  function saveDevice() {
    try { localStorage.setItem(DEVICE_KEY, JSON.stringify(device)); } catch (err) { /* ignore */ }
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // ── numbers and dates ──────────────────────────────────

  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

  function qty(n) {
    return round2(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  function money(n) {
    n = round2(n);
    var parts = Math.abs(n).toFixed(2).split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (n < 0 ? '-' : '') + CURRENCY + ' ' + parts.join('.');
  }

  function bagsWord(n) { return Math.abs(round2(n)) === 1 ? 'bag' : 'bags'; }

  /* '1,5' or ' 3 ' -> number, or NaN */
  function parseNum(value) {
    var text = String(value === undefined || value === null ? '' : value).trim().replace(',', '.');
    if (!text) return NaN;
    var n = Number(text);
    return isFinite(n) ? n : NaN;
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function addDays(d, days) { var x = new Date(d); x.setDate(x.getDate() + days); return x; }

  function dateKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

  function monthKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1); }

  function parseDateKey(key) {
    var p = key.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }

  function monthStart(key) {
    var p = key.split('-').map(Number);
    return new Date(p[0], p[1] - 1, 1);
  }

  function shiftMonth(key, n) {
    var d = monthStart(key);
    d.setMonth(d.getMonth() + n);
    return monthKey(d);
  }

  function monthLabel(key) {
    var d = monthStart(key);
    return MONTHS_FULL[d.getMonth()] + ' ' + d.getFullYear();
  }

  function whenText(iso) {
    var d = new Date(iso);
    return WEEKDAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()] +
      (d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : '') +
      ', ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /* For spreadsheets: 2026-09-23 08:54 in local time. */
  function stampText(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return dateKey(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function agoText(iso) {
    if (!iso) return '';
    var secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (secs < 60) return 'just now';
    var mins = Math.round(secs / 60);
    if (mins < 60) return mins + (mins === 1 ? ' minute ago' : ' minutes ago');
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + (hrs === 1 ? ' hour ago' : ' hours ago');
    return whenText(iso);
  }

  // ── lookups and sums ───────────────────────────────────

  function productById(id) {
    for (var i = 0; i < state.products.length; i++) if (state.products[i].id === id) return state.products[i];
    return null;
  }

  function productName(id) {
    var p = productById(id);
    return p ? p.name : '(removed fertiliser)';
  }

  function byName(a, b) { return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }); }

  function activeProducts() {
    return state.products.filter(function (p) { return p.active !== false; }).sort(byName);
  }

  function live(m) { return !m.voidAt; }

  /* Bags on hand, optionally as it stood just before `before` (a Date). */
  function stockOf(pid, before) {
    var t = before ? before.getTime() : Infinity;
    var sum = 0;
    state.moves.forEach(function (m) {
      if (m.pid === pid && live(m) && new Date(m.at).getTime() < t) sum += m.bags;
    });
    return round2(sum);
  }

  /* Price per bag that applied at `when` (a Date). */
  function priceAt(pid, when) {
    var t = when.getTime();
    var best = null;
    state.prices.forEach(function (x) {
      if (x.pid !== pid) return;
      var xt = new Date(x.at).getTime();
      if (xt <= t && (!best || xt >= new Date(best.at).getTime())) best = x;
    });
    if (best) return best.cost;
    var p = productById(pid);
    return p ? p.cost : 0;
  }

  function recentNames() {
    var seen = {};
    var out = [];
    state.moves.slice().sort(function (a, b) { return a.at < b.at ? 1 : -1; }).forEach(function (m) {
      var key = (m.by || '').trim().toLowerCase();
      if (key && !seen[key] && out.length < 15) { seen[key] = 1; out.push(m.by.trim()); }
    });
    return out;
  }

  // ── changes ────────────────────────────────────────────

  function changed(kind, id) {
    FertSync.touch(kind, id);
    save();
    FertSync.schedule();
  }

  function addPrice(pid, cost, by) {
    var rec = { id: uid(), pid: pid, cost: cost, at: new Date().toISOString(), by: by || '' };
    state.prices.push(rec);
    changed('prices', rec.id);
  }

  function addProduct(fields, by) {
    var p = { id: uid(), name: fields.name, kg: fields.kg, cost: fields.cost,
              reorder: fields.reorder, active: true };
    state.products.push(p);
    changed('products', p.id);
    addPrice(p.id, p.cost, by);
    return p;
  }

  function updateProduct(p, fields, by) {
    var priceChanged = round2(p.cost) !== round2(fields.cost);
    p.name = fields.name;
    p.kg = fields.kg;
    p.cost = fields.cost;
    p.reorder = fields.reorder;
    p.active = fields.active;
    changed('products', p.id);
    if (priceChanged) addPrice(p.id, p.cost, by);
  }

  function recordMove(pid, kind, bags, by, note, cost) {
    var p = productById(pid);
    var m = { id: uid(), pid: pid, kind: kind, bags: round2(bags), kg: p.kg,
              cost: cost === undefined ? p.cost : cost, by: by, note: note || '',
              at: new Date().toISOString(), voidAt: null, voidBy: null, voidReason: null };
    state.moves.push(m);
    changed('moves', m.id);
    return m;
  }

  function voidMove(id, by, reason) {
    for (var i = 0; i < state.moves.length; i++) {
      var m = state.moves[i];
      if (m.id === id && !m.voidAt) {
        m.voidAt = new Date().toISOString();
        m.voidBy = by || '';
        m.voidReason = reason;
        changed('moves', m.id);
        return true;
      }
    }
    return false;
  }

  // ── manager lock ───────────────────────────────────────

  /*
   * The PIN keeps the mixer's tablet on the screens the mixer needs. It is a
   * convenience lock on this device, not security: the company code is what
   * actually protects the records.
   */
  function hashPin(pin) {
    var h = 2166136261;
    var text = 'fertiliser:' + pin;
    for (var i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(16);
  }

  function isManager() { return !device.pinHash || unlocked; }

  function lock() {
    unlocked = false;
    if (MANAGER_VIEWS[ui.view]) ui.view = 'stock';
    render();
  }

  // ── helpers for markup ─────────────────────────────────

  function $(id) { return document.getElementById(id); }

  function esc(str) {
    return String(str === undefined || str === null ? '' : str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function draft(form) {
    if (!ui.draft[form]) ui.draft[form] = {};
    return ui.draft[form];
  }

  /* A form value: what was typed, otherwise the default. */
  function dv(form, name, fallback) {
    var d = draft(form);
    return d[name] !== undefined ? d[name] : (fallback === undefined ? '' : fallback);
  }

  var toastTimer = null;
  var toastFn = null;
  function toast(message, action) {
    var el = $('toast');
    $('toastText').textContent = message;
    var btn = $('toastAction');
    toastFn = action ? action.fn : null;
    btn.hidden = !action;
    if (action) btn.textContent = action.label;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; toastFn = null; },
      action ? 12000 : 3200);
  }

  function emptyState(title, body, action) {
    return '<div class="empty"><h3>' + esc(title) + '</h3><p>' + body + '</p>' + (action || '') + '</div>';
  }

  function picker(form, products, withStock) {
    var chosen = dv(form, 'pid');
    return '<fieldset class="pick"><legend>Fertiliser</legend>' +
      products.map(function (p) {
        var s = stockOf(p.id);
        return '<label class="pick-item' + (s < 0 ? ' neg' : '') + '">' +
          '<input type="radio" name="pid" value="' + esc(p.id) + '" required' +
          (chosen === p.id ? ' checked' : '') + '>' +
          '<span><b>' + esc(p.name) + '</b>' +
          (withStock !== false ? '<small>' + qty(s) + ' ' + bagsWord(s) + ' in stock</small>' : '') +
          '</span></label>';
      }).join('') + '</fieldset>';
  }

  function nameField(form) {
    return '<label class="field"><span>Your name</span>' +
      '<input name="by" required maxlength="60" autocomplete="off" list="names" value="' +
      esc(dv(form, 'by', device.name)) + '"></label>' +
      '<datalist id="names">' + recentNames().map(function (n) {
        return '<option value="' + esc(n) + '">';
      }).join('') + '</datalist>';
  }

  function syncNudge() {
    if (FertSync.status().connected) return '';
    return '<div class="sync-nudge"><p>This ' + DEVICE + ' is not sharing yet. Enter the company ' +
      'code so the other devices see the same stock.</p>' +
      '<button type="button" data-act="go" data-view="sync">Connect</button></div>';
  }

  // ── view: stock ────────────────────────────────────────

  function renderStock() {
    var products = activeProducts();
    var manager = isManager();
    var html = '<h2 class="view-title">Stock on hand</h2>' + syncNudge();

    if (!products.length) {
      html += manager
        ? emptyState('No fertilisers yet', 'Add each fertiliser with its kg per bag and cost per bag.',
            '<button type="button" class="primary-btn" data-act="go" data-view="setup">Add fertilisers</button>')
        : emptyState('No fertilisers yet', 'Ask the manager to set up the fertilisers.');
      $('view-stock').innerHTML = html;
      return;
    }

    var total = 0;
    html += '<div class="stock-grid">' + products.map(function (p) {
      var s = stockOf(p.id);
      var value = s * p.cost;
      total += value;
      var low = p.reorder > 0 && s <= p.reorder;
      var cls = s < 0 ? ' neg' : (low ? ' low' : '');
      return '<div class="stock-card' + cls + '">' +
        '<div class="stock-name">' + esc(p.name) + '</div>' +
        '<div class="stock-big">' + qty(s) + '<small> ' + bagsWord(s) + '</small></div>' +
        '<div class="stock-sub">' + qty(s * p.kg) + ' kg · ' + qty(p.kg) + ' kg per bag</div>' +
        (manager ? '<div class="stock-sub">' + money(value) + ' at ' + money(p.cost) + ' a bag</div>' : '') +
        (s < 0 ? '<div class="flag">Below zero — count the stock</div>'
               : low ? '<div class="flag">Re-order (at ' + qty(p.reorder) + ')</div>' : '') +
        (manager ? '<div class="stock-actions">' +
          '<button type="button" class="mini-btn" data-act="go" data-view="delivery" data-pid="' + esc(p.id) + '">+ Delivery</button>' +
          '<button type="button" class="mini-btn" data-act="go" data-view="count" data-pid="' + esc(p.id) + '">Count</button>' +
          '</div>' : '') +
        '</div>';
    }).join('') + '</div>';

    if (manager) html += '<p class="total-line">Total stock value <b>' + money(total) + '</b></p>';
    html += '<button type="button" class="primary-btn wide big" data-act="go" data-view="use">Record bags used</button>';
    if (manager) {
      html += '<div class="btn-row spaced">' +
        '<button type="button" class="ghost-btn" data-act="go" data-view="delivery">Book in a delivery</button>' +
        '<button type="button" class="ghost-btn" data-act="go" data-view="count">Stock count</button></div>';
    }
    $('view-stock').innerHTML = html;
  }

  // ── view: use (the mixer's screen) ─────────────────────

  function renderUse() {
    var products = activeProducts();
    var html = '<h2 class="view-title">Record bags used</h2>';
    if (!products.length) {
      $('view-use').innerHTML = html + emptyState('No fertilisers yet', 'Ask the manager to set up the fertilisers.');
      return;
    }
    html += '<form data-form="use" autocomplete="off">' + picker('use', products) +
      '<div class="card">' +
      '<label class="field"><span>Bags used</span></label>' +
      '<div class="stepper big">' +
      '<button type="button" data-act="step" data-step="-1" aria-label="One bag less">−</button>' +
      '<input type="number" name="bags" inputmode="decimal" min="0.25" step="0.25" required value="' +
      esc(dv('use', 'bags', '1')) + '" aria-label="Bags used">' +
      '<button type="button" data-act="step" data-step="1" aria-label="One bag more">+</button>' +
      '</div>' + nameField('use') +
      '<label class="field"><span>Note (optional)</span><input name="note" maxlength="200" ' +
      'placeholder="e.g. mix for tunnel 3" value="' + esc(dv('use', 'note')) + '"></label>' +
      '</div>' +
      '<button type="submit" class="primary-btn wide big">Save</button></form>';
    $('view-use').innerHTML = html;
  }

  function submitUse(data) {
    var p = productById(data.pid);
    var bags = parseNum(data.bags);
    var by = (data.by || '').trim();
    if (!p) return toast('Tap the fertiliser you took.');
    if (!(bags > 0)) return toast('Enter how many bags you used.');
    if (!by) return toast('Enter your name.');

    rememberName(by);
    var m = recordMove(p.id, 'usage', -bags, by, (data.note || '').trim());
    ui.draft.use = {};
    var left = stockOf(p.id);
    render();
    toast('Saved: ' + qty(bags) + ' ' + bagsWord(bags) + ' of ' + p.name + '. ' +
      qty(left) + ' left.' + (left < 0 ? ' Stock is below zero — tell the manager.' : ''),
      { label: 'Undo', fn: function () {
        if (voidMove(m.id, by, 'Undone straight after entry')) { render(); toast('Entry undone.'); }
      } });
  }

  function rememberName(by) {
    if (device.name !== by) { device.name = by; saveDevice(); }
  }

  // ── view: delivery ─────────────────────────────────────

  function renderDelivery() {
    var products = activeProducts();
    var html = '<h2 class="view-title">Book in a delivery</h2>';
    if (!products.length) {
      $('view-delivery').innerHTML = html + emptyState('No fertilisers yet', 'Add the fertiliser first.',
        '<button type="button" class="primary-btn" data-act="go" data-view="setup">Add fertilisers</button>');
      return;
    }
    var p = productById(dv('delivery', 'pid'));
    html += '<form data-form="delivery" autocomplete="off">' + picker('delivery', products) +
      '<div class="card">' +
      '<label class="field"><span>Bags delivered</span><input type="number" name="bags" inputmode="decimal" ' +
      'min="0.25" step="0.25" required value="' + esc(dv('delivery', 'bags')) + '"></label>' +
      '<label class="field"><span>Cost per bag (' + CURRENCY + ')</span><input type="number" name="cost" ' +
      'inputmode="decimal" min="0" step="0.01" required value="' +
      esc(dv('delivery', 'cost', p ? p.cost : '')) + '"></label>' +
      '<label class="check"><input type="checkbox" name="setPrice"' +
      (dv('delivery', 'setPrice', true) ? ' checked' : '') + '> Make this the price for this fertiliser from now on</label>' +
      nameField('delivery') +
      '<label class="field"><span>Note (optional)</span><input name="note" maxlength="200" ' +
      'placeholder="e.g. supplier, invoice number" value="' + esc(dv('delivery', 'note')) + '"></label>' +
      '</div>' +
      '<button type="submit" class="primary-btn wide">Save delivery</button></form>';
    $('view-delivery').innerHTML = html;
  }

  function submitDelivery(data) {
    var p = productById(data.pid);
    var bags = parseNum(data.bags);
    var cost = parseNum(data.cost);
    var by = (data.by || '').trim();
    if (!p) return toast('Choose the fertiliser that was delivered.');
    if (!(bags > 0)) return toast('Enter the number of bags delivered.');
    if (!(cost >= 0)) return toast('Enter the cost per bag.');
    if (!by) return toast('Enter your name.');

    rememberName(by);
    cost = round2(cost);
    if (data.setPrice && round2(p.cost) !== cost) {
      p.cost = cost;
      changed('products', p.id);
      addPrice(p.id, cost, by);
    }
    recordMove(p.id, 'delivery', bags, by, (data.note || '').trim(), cost);
    ui.draft.delivery = {};
    ui.view = 'stock';
    render();
    toast('Delivery saved: ' + qty(bags) + ' ' + bagsWord(bags) + ' of ' + p.name + '.');
  }

  // ── view: stock count (manual correction) ──────────────

  function renderCount() {
    var products = activeProducts();
    var html = '<h2 class="view-title">Stock count</h2>' +
      '<p class="lead">Enter the bags actually in the store. The difference is saved in the log ' +
      'as a stock count, with your reason.</p>';
    if (!products.length) {
      $('view-count').innerHTML = html + emptyState('No fertilisers yet', 'Add the fertiliser first.',
        '<button type="button" class="primary-btn" data-act="go" data-view="setup">Add fertilisers</button>');
      return;
    }
    var p = productById(dv('count', 'pid'));
    html += '<form data-form="count" autocomplete="off">' + picker('count', products) +
      '<div class="card">' +
      (p ? '<p class="card-note">The app shows <b>' + qty(stockOf(p.id)) + '</b> ' +
           bagsWord(stockOf(p.id)) + ' of ' + esc(p.name) + '.</p>' : '') +
      '<label class="field"><span>Bags counted in the store</span><input type="number" name="counted" ' +
      'inputmode="decimal" min="0" step="0.25" required value="' + esc(dv('count', 'counted')) + '"></label>' +
      '<label class="field"><span>Reason</span><input name="note" required maxlength="200" ' +
      'placeholder="e.g. month-end count, torn bag, opening stock" value="' + esc(dv('count', 'note')) + '"></label>' +
      nameField('count') +
      '</div>' +
      '<button type="submit" class="primary-btn wide">Save stock count</button></form>';
    $('view-count').innerHTML = html;
  }

  function submitCount(data) {
    var p = productById(data.pid);
    var counted = parseNum(data.counted);
    var reason = (data.note || '').trim();
    var by = (data.by || '').trim();
    if (!p) return toast('Choose the fertiliser you counted.');
    if (!(counted >= 0)) return toast('Enter the number of bags counted.');
    if (!reason) return toast('Enter a reason for the count.');
    if (!by) return toast('Enter your name.');

    rememberName(by);
    counted = round2(counted);
    var was = stockOf(p.id);
    var diff = round2(counted - was);
    ui.draft.count = {};
    ui.view = 'stock';
    if (diff === 0) {
      render();
      return toast(p.name + ' already shows ' + qty(counted) + ' ' + bagsWord(counted) + ' — nothing changed.');
    }
    recordMove(p.id, 'adjustment', diff, by, reason + ' (was ' + qty(was) + ', counted ' + qty(counted) + ')');
    render();
    toast(p.name + ' set to ' + qty(counted) + ' ' + bagsWord(counted) + ' (' + (diff > 0 ? '+' : '') + qty(diff) + ').');
  }

  // ── view: log ──────────────────────────────────────────

  function logMoves() {
    var from = parseDateKey(ui.logFrom).getTime();
    var to = addDays(parseDateKey(ui.logTo), 1).getTime();
    return state.moves.filter(function (m) {
      var t = new Date(m.at).getTime();
      return t >= from && t < to &&
        (!ui.logPid || m.pid === ui.logPid) &&
        (!ui.logKind || m.kind === ui.logKind);
    }).sort(function (a, b) { return a.at < b.at ? 1 : a.at > b.at ? -1 : 0; });
  }

  function renderLog() {
    var manager = isManager();
    var rows = logMoves();
    var products = state.products.slice().sort(byName);
    var used = 0;
    rows.forEach(function (m) { if (live(m) && m.kind === 'usage') used -= m.bags; });

    var html = '<h2 class="view-title">Stock log</h2>' +
      '<div class="card filters">' +
      '<div class="field-pair">' +
      '<label class="field"><span>From</span><input type="date" data-filter="logFrom" value="' + esc(ui.logFrom) + '"></label>' +
      '<label class="field"><span>To</span><input type="date" data-filter="logTo" value="' + esc(ui.logTo) + '"></label>' +
      '</div><div class="field-pair">' +
      '<label class="field"><span>Fertiliser</span><select data-filter="logPid"><option value="">All</option>' +
      products.map(function (p) {
        return '<option value="' + esc(p.id) + '"' + (ui.logPid === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>';
      }).join('') + '</select></label>' +
      '<label class="field"><span>Type</span><select data-filter="logKind"><option value="">All</option>' +
      Object.keys(KIND_LABEL).map(function (k) {
        return '<option value="' + k + '"' + (ui.logKind === k ? ' selected' : '') + '>' + KIND_LABEL[k] + '</option>';
      }).join('') + '</select></label>' +
      '</div>' +
      '<button type="button" class="ghost-btn full" data-act="export-log">Export Excel file</button>' +
      '</div>';

    html += '<p class="preview">' + rows.length + (rows.length === 1 ? ' entry' : ' entries') +
      (used ? ' · ' + qty(used) + ' ' + bagsWord(used) + ' used' : '') + '</p>';

    if (!rows.length) {
      html += emptyState('Nothing recorded', 'No entries for these dates and filters.');
    } else {
      html += '<div class="log">' + rows.map(function (m) {
        var voided = !!m.voidAt;
        var body = '<div class="move' + (voided ? ' void' : '') + ' kind-' + m.kind + '">' +
          '<div class="move-main">' +
          '<div class="move-title">' + esc(productName(m.pid)) + '</div>' +
          '<div class="move-meta">' + esc(whenText(m.at)) + ' · <span class="kind">' + KIND_LABEL[m.kind] +
          '</span> · ' + esc(m.by) + '</div>' +
          (m.note ? '<div class="move-note">' + esc(m.note) + '</div>' : '') +
          (voided ? '<div class="void-note">Cancelled ' + esc(whenText(m.voidAt)) + ' by ' + esc(m.voidBy) +
            ': ' + esc(m.voidReason) + '</div>' : '') +
          '</div>' +
          '<div class="move-qty">' + (m.bags > 0 ? '+' : '') + qty(m.bags) + '<small>' + bagsWord(m.bags) +
          (manager ? ' · ' + money(m.bags * m.cost) : '') + '</small>' +
          (manager && !voided && ui.voidId !== m.id
            ? '<button type="button" class="mini-btn danger" data-act="void-open" data-id="' + esc(m.id) + '">Cancel</button>' : '') +
          '</div></div>';
        if (manager && !voided && ui.voidId === m.id) {
          body += '<form class="void-form" data-form="void" autocomplete="off">' +
            '<input type="hidden" name="id" value="' + esc(m.id) + '">' +
            '<input name="reason" required maxlength="200" placeholder="Why is this entry wrong?" value="' +
            esc(dv('void', 'reason')) + '">' +
            '<button type="submit" class="ghost-btn danger">Cancel entry</button>' +
            '<button type="button" class="ghost-btn" data-act="void-close">Keep</button></form>';
        }
        return body;
      }).join('') + '</div>' +
      (manager ? '<p class="hint">A cancelled entry stays in the log, crossed out, and no longer counts towards stock.</p>' : '');
    }
    $('view-log').innerHTML = html;
  }

  function submitVoid(data) {
    var reason = (data.reason || '').trim();
    if (!reason) return toast('Give a reason for cancelling the entry.');
    voidMove(data.id, device.name || 'manager', reason);
    ui.voidId = null;
    ui.draft.void = {};
    render();
    toast('Entry cancelled.');
  }

  // ── monthly figures ────────────────────────────────────

  function monthSummary(key) {
    var start = monthStart(key);
    var end = monthStart(shiftMonth(key, 1));
    var st = start.getTime(), et = end.getTime();
    var lastMoment = new Date(et - 1);

    return state.products.slice().sort(byName).map(function (p) {
      var r = { id: p.id, name: p.name, kg: p.kg, opening: stockOf(p.id, start),
                received: 0, receivedCost: 0, used: 0, usedKg: 0, usedCost: 0, adjusted: 0 };
      state.moves.forEach(function (m) {
        if (m.pid !== p.id || !live(m)) return;
        var t = new Date(m.at).getTime();
        if (t < st || t >= et) return;
        if (m.kind === 'delivery') { r.received += m.bags; r.receivedCost += m.bags * m.cost; }
        else if (m.kind === 'usage') { r.used -= m.bags; r.usedKg -= m.bags * m.kg; r.usedCost -= m.bags * m.cost; }
        else r.adjusted += m.bags;
      });
      ['received', 'receivedCost', 'used', 'usedKg', 'usedCost', 'adjusted'].forEach(function (k) {
        r[k] = round2(r[k]);
      });
      r.closing = round2(r.opening + r.received - r.used + r.adjusted);
      r.closingKg = round2(r.closing * p.kg);
      r.price = priceAt(p.id, lastMoment);
      r.closingValue = round2(r.closing * r.price);
      r.show = p.active !== false || r.opening || r.received || r.used || r.adjusted;
      return r;
    }).filter(function (r) { return r.show; });
  }

  // ── view: report ───────────────────────────────────────

  function renderReport() {
    var rows = monthSummary(ui.month);
    var isThisMonth = ui.month === monthKey(new Date());
    var sum = function (k) { return rows.reduce(function (n, r) { return n + r[k]; }, 0); };

    var html = '<h2 class="view-title">Monthly report</h2>' +
      '<div class="datebar">' +
      '<button type="button" class="step-btn" data-act="month" data-step="-1" aria-label="Previous month">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></button>' +
      '<div class="datebar-center"><div class="month-text">' + monthLabel(ui.month) + '</div>' +
      (isThisMonth ? '<div class="sub">so far</div>'
                   : '<button type="button" class="link-btn" data-act="month" data-step="0">Jump to this month</button>') +
      '</div>' +
      '<button type="button" class="step-btn" data-act="month" data-step="1" aria-label="Next month">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg></button></div>';

    if (!rows.length) {
      html += emptyState('No fertilisers yet', 'Add fertilisers on the Setup screen.');
    } else {
      html += '<div class="summary">' +
        '<div class="summary-item"><b>' + qty(sum('used')) + '</b><span>bags used</span></div>' +
        '<div class="summary-item"><b>' + qty(sum('usedKg')) + '</b><span>kg used</span></div>' +
        '<div class="summary-item"><b>' + money(sum('usedCost')) + '</b><span>cost of fertiliser used</span></div>' +
        '<div class="summary-item"><b>' + money(sum('closingValue')) + '</b><span>stock value at month end</span></div>' +
        '</div>';
      html += '<div class="table-wrap"><table class="report">' +
        '<thead><tr><th>Fertiliser</th><th>Opening</th><th>Received</th><th>Used</th><th>Used kg</th>' +
        '<th>Cost used</th><th>Counts</th><th>Closing</th><th>Closing value</th></tr></thead><tbody>' +
        rows.map(function (r) {
          return '<tr><td>' + esc(r.name) + '</td><td>' + qty(r.opening) + '</td><td>' + qty(r.received) +
            '</td><td>' + qty(r.used) + '</td><td>' + qty(r.usedKg) + '</td><td>' + money(r.usedCost) +
            '</td><td>' + (r.adjusted > 0 ? '+' : '') + qty(r.adjusted) + '</td><td>' + qty(r.closing) +
            '</td><td>' + money(r.closingValue) + '</td></tr>';
        }).join('') +
        '</tbody><tfoot><tr><th>Total</th><td></td><td></td><td>' + qty(sum('used')) + '</td><td>' +
        qty(sum('usedKg')) + '</td><td>' + money(sum('usedCost')) + '</td><td></td><td></td><td>' +
        money(sum('closingValue')) + '</td></tr></tfoot></table></div>' +
        '<p class="hint">Bags, except where it says kg. Cancelled entries are left out.</p>';
    }

    html += '<button type="button" class="primary-btn wide" data-act="export-month">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true" class="btn-icon"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg>' +
      'Export Excel file</button>' +
      '<p class="hint" id="exportHint">Three sheets: the summary, every entry in the month, and the usage log.</p>';

    html += '<div class="card muted-card"><h3 class="card-title">Backup</h3>' +
      '<p class="card-note">' + (FertSync.status().connected
        ? 'Every connected device holds a full copy, so a lost tablet loses nothing. A backup file is extra insurance.'
        : 'Records are stored on this ' + DEVICE + ' only. If you lose it or clear the browser, they go with it. ' +
          'Save a backup now and then, and keep it somewhere safe.') + '</p>' +
      '<div class="btn-row"><button type="button" class="ghost-btn" data-act="backup">Save backup</button>' +
      '<button type="button" class="ghost-btn" data-act="restore">Restore backup</button>' +
      '<input type="file" id="restoreInput" accept="application/json,.json" hidden></div></div>';

    $('view-report').innerHTML = html;
  }

  // ── Excel ──────────────────────────────────────────────

  function movementSheet(name, moves) {
    var S = XlsxWriter.styles;
    var cur = ' (' + CURRENCY + ')';
    var rows = [[
      'Date / time', 'Fertiliser', 'Type', 'Bags (+ in / − out)', 'Kg', 'Cost per bag' + cur,
      'Value' + cur, 'Recorded by', 'Note', 'Cancelled at', 'Cancelled by', 'Reason cancelled'
    ].map(function (h) { return { v: h, s: S.HEAD }; })];
    rows[0].height = 32;

    moves.forEach(function (m) {
      var v = !!m.voidAt;
      var t = v ? S.VOID : S.TEXT, q = v ? S.VOID_QTY : S.QTY, c = v ? S.VOID_MONEY : S.MONEY;
      rows.push([
        { v: stampText(m.at), s: t }, { v: productName(m.pid), s: t }, { v: KIND_LABEL[m.kind], s: t },
        { v: round2(m.bags), s: q }, { v: round2(m.bags * m.kg), s: q }, { v: m.cost, s: c },
        { v: round2(m.bags * m.cost), s: c }, { v: m.by, s: t }, { v: m.note, s: t },
        { v: stampText(m.voidAt), s: t }, { v: m.voidBy || '', s: t }, { v: m.voidReason || '', s: t }
      ]);
    });
    return {
      name: name,
      rows: rows,
      cols: [17, 22, 13, 11, 9, 12, 12, 16, 32, 17, 14, 26].map(function (w) { return { width: w }; }),
      freeze: { row: 1 },
      filter: 'A1:L' + Math.max(2, rows.length)
    };
  }

  function monthWorkbook(key) {
    var S = XlsxWriter.styles;
    var col = XlsxWriter.colName;
    var summary = monthSummary(key);
    var cur = ' (' + CURRENCY + ')';
    var start = monthStart(key).getTime();
    var end = monthStart(shiftMonth(key, 1)).getTime();
    var moves = state.moves.filter(function (m) {
      var t = new Date(m.at).getTime();
      return t >= start && t < end;
    }).sort(function (a, b) { return a.at < b.at ? -1 : a.at > b.at ? 1 : 0; });

    var company = FertSync.status().company;
    var rows = [
      [{ v: 'Fertiliser report — ' + monthLabel(key), s: S.TITLE }],
      [{ v: (company ? company + ' · ' : '') + 'Exported ' + stampText(new Date().toISOString()) +
            '. Cancelled entries are left out of the totals. Closing stock is valued at the price in force at month end.',
         s: S.SUBTITLE }],
      []
    ];
    var head = ['Fertiliser', 'Kg per bag', 'Opening stock (bags)', 'Received (bags)', 'Received cost' + cur,
      'Used (bags)', 'Used (kg)', 'Cost of fertiliser used' + cur, 'Stock counts (bags)',
      'Closing stock (bags)', 'Closing stock (kg)', 'Price per bag' + cur, 'Closing stock value' + cur];
    rows.push(head.map(function (h) { return { v: h, s: S.HEAD }; }));
    rows[3].height = 45;

    var keys = ['name', 'kg', 'opening', 'received', 'receivedCost', 'used', 'usedKg', 'usedCost',
      'adjusted', 'closing', 'closingKg', 'price', 'closingValue'];
    var moneyCols = { receivedCost: 1, usedCost: 1, price: 1, closingValue: 1 };
    summary.forEach(function (r) {
      rows.push(keys.map(function (k, i) {
        if (i === 0) return { v: r[k], s: S.TEXT };
        return { v: r[k], s: moneyCols[k] ? S.MONEY : S.QTY };
      }));
    });

    var first = 5, last = 4 + summary.length;
    var totals = [{ v: 'TOTAL', s: S.TOTAL }];
    keys.slice(1).forEach(function (k, i) {
      var c = i + 1;
      var summed = { receivedCost: 1, usedKg: 1, usedCost: 1, closingValue: 1 };
      if (!summed[k] || !summary.length) { totals.push({ v: '', s: S.TOTAL }); return; }
      var cached = round2(summary.reduce(function (n, r) { return n + r[k]; }, 0));
      totals.push({ v: cached, f: 'SUM(' + col(c) + first + ':' + col(c) + last + ')',
                    s: moneyCols[k] ? S.TOTAL_MONEY : S.TOTAL_QTY });
    });
    rows.push(totals);

    return XlsxWriter.build({ sheets: [
      {
        name: 'Summary',
        rows: rows,
        cols: [24, 9, 11, 11, 13, 10, 10, 15, 11, 11, 11, 12, 15].map(function (w) { return { width: w }; }),
        freeze: { row: 4, col: 1 }
      },
      movementSheet('All entries', moves),
      movementSheet('Usage log', moves.filter(function (m) { return m.kind === 'usage'; }))
    ] });
  }

  function exportMonth() {
    var filename = 'fertiliser-report-' + ui.month + '.xlsx';
    deliverFile(monthWorkbook(ui.month), filename).then(function (how) {
      var hint = $('exportHint');
      if (!hint) return;
      if (how === 'shared') hint.textContent = 'Sent. Open it on your PC from wherever you shared it to.';
      else if (how === 'downloaded') hint.textContent = 'Saved as ' + filename;
    });
  }

  function exportLog() {
    var moves = logMoves().slice().reverse();
    var blob = XlsxWriter.build({ sheets: [movementSheet('Log', moves)] });
    deliverFile(blob, 'fertiliser-log-' + ui.logFrom + '-to-' + ui.logTo + '.xlsx');
  }

  /* Tablets and phones get the share sheet; a PC gets a plain download. */
  function deliverFile(blob, filename) {
    var touchFirst = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    if (touchFirst && navigator.canShare) {
      try {
        var file = new File([blob], filename, { type: blob.type });
        if (navigator.canShare({ files: [file] })) {
          return navigator.share({ files: [file], title: filename })
            .then(function () { return 'shared'; })
            .catch(function (err) {
              if (err && err.name === 'AbortError') return 'cancelled';
              return download(blob, filename);
            });
        }
      } catch (err) { /* fall through to download */ }
    }
    return Promise.resolve(download(blob, filename));
  }

  function download(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
    return 'downloaded';
  }

  // ── backup / restore ───────────────────────────────────

  function doBackup() {
    // deliberately without the sync settings — a backup file must not carry
    // the company code around in someone's WhatsApp
    var payload = JSON.stringify({
      app: 'fertiliser',
      version: SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      products: state.products,
      moves: state.moves,
      prices: state.prices
    }, null, 2);
    deliverFile(new Blob([payload], { type: 'application/json' }),
      'fertiliser-backup-' + dateKey(new Date()) + '.json');
  }

  function doRestore(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var data;
      try { data = JSON.parse(reader.result); } catch (err) { data = null; }
      if (!data || data.app !== 'fertiliser' || !Array.isArray(data.products)) {
        toast('That file is not a fertiliser backup.');
        return;
      }
      var ok = confirm('Restore this backup?\n\n' + data.products.length + ' fertiliser(s), ' +
        (data.moves || []).length + ' log entries.\n\nThis replaces everything currently on this ' + DEVICE + '.');
      if (!ok) return;
      state.products = data.products;
      state.moves = Array.isArray(data.moves) ? data.moves : [];
      state.prices = Array.isArray(data.prices) ? data.prices : [];
      state.products.forEach(function (x) { FertSync.touch('products', x.id); });
      state.moves.forEach(function (x) { FertSync.touch('moves', x.id); });
      state.prices.forEach(function (x) { FertSync.touch('prices', x.id); });
      save();
      FertSync.schedule();
      render();
      toast('Backup restored.');
    };
    reader.readAsText(file);
  }

  // ── view: setup ────────────────────────────────────────

  function productForm(form, p) {
    return '<label class="field"><span>Name</span><input name="name" required maxlength="60" value="' +
      esc(dv(form, 'name', p ? p.name : '')) + '"></label>' +
      '<div class="field-pair">' +
      '<label class="field"><span>Kg per bag</span><input type="number" name="kg" inputmode="decimal" ' +
      'min="0.01" step="0.01" required value="' + esc(dv(form, 'kg', p ? p.kg : 25)) + '"></label>' +
      '<label class="field"><span>Cost per bag (' + CURRENCY + ')</span><input type="number" name="cost" ' +
      'inputmode="decimal" min="0" step="0.01" required value="' + esc(dv(form, 'cost', p ? p.cost : '')) + '"></label>' +
      '</div>' +
      '<label class="field"><span>Re-order when stock is down to (bags, optional)</span><input type="number" ' +
      'name="reorder" inputmode="decimal" min="0" step="1" value="' +
      esc(dv(form, 'reorder', p && p.reorder ? p.reorder : '')) + '"></label>';
  }

  function readProduct(data) {
    var f = {
      name: (data.name || '').trim(),
      kg: parseNum(data.kg),
      cost: parseNum(data.cost),
      reorder: data.reorder === '' || data.reorder === undefined ? 0 : parseNum(data.reorder)
    };
    if (!f.name) return 'Enter the fertiliser name.';
    if (!(f.kg > 0)) return 'Enter the kg per bag.';
    if (!(f.cost >= 0)) return 'Enter the cost per bag.';
    if (!(f.reorder >= 0)) return 'The re-order level must be a number.';
    f.kg = round2(f.kg);
    f.cost = round2(f.cost);
    f.reorder = round2(f.reorder);
    return f;
  }

  function nameTaken(name, exceptId) {
    var n = name.trim().toLowerCase();
    return state.products.some(function (p) { return p.id !== exceptId && p.name.trim().toLowerCase() === n; });
  }

  function renderSetup() {
    var products = state.products.slice().sort(byName);
    var html = '<h2 class="view-title">Setup</h2>';

    html += '<div class="card"><h3 class="card-title">Fertilisers</h3>';
    if (!products.length) html += '<p class="card-note">None yet — add your first one below.</p>';
    html += '<div class="plist">' + products.map(function (p) {
      if (ui.editPid === p.id) {
        var history = state.prices.filter(function (x) { return x.pid === p.id; })
          .sort(function (a, b) { return a.at < b.at ? 1 : -1; }).slice(0, 6);
        return '<form class="pedit" data-form="edit" autocomplete="off">' +
          '<input type="hidden" name="id" value="' + esc(p.id) + '">' + productForm('edit', p) +
          '<label class="check"><input type="checkbox" name="active"' +
          (dv('edit', 'active', p.active !== false) ? ' checked' : '') +
          '> In use (untick to hide it from the lists — its history is kept)</label>' +
          (history.length ? '<p class="card-note">Price history: ' + history.map(function (x) {
            return money(x.cost) + ' from ' + esc(stampText(x.at));
          }).join(' · ') + '</p>' : '') +
          '<div class="btn-row"><button type="submit" class="primary-btn compact">Save</button>' +
          '<button type="button" class="ghost-btn" data-act="edit-close">Cancel</button></div></form>';
      }
      return '<div class="pline' + (p.active === false ? ' inactive' : '') + '">' +
        '<div><b>' + esc(p.name) + '</b><small>' + qty(p.kg) + ' kg a bag · ' + money(p.cost) + ' a bag' +
        (p.reorder ? ' · re-order at ' + qty(p.reorder) : '') + (p.active === false ? ' · not in use' : '') +
        '</small></div>' +
        '<button type="button" class="mini-btn" data-act="edit-open" data-id="' + esc(p.id) + '">Edit</button></div>';
    }).join('') + '</div></div>';

    html += '<form class="card" data-form="add" autocomplete="off"><h3 class="card-title">Add a fertiliser</h3>' +
      productForm('add', null) +
      '<button type="submit" class="primary-btn wide">Add fertiliser</button>' +
      '<p class="card-note gap">To load what is already in the store, add the fertiliser and then do a ' +
      '<a href="#" data-act="go" data-view="count">stock count</a>.</p></form>';

    html += '<div class="card"><h3 class="card-title">Mixer lock</h3>';
    if (!device.pinHash) {
      html += '<p class="card-note">Set a manager PIN to lock this ' + DEVICE + ' to the mixer\'s screens: ' +
        'stock, record bags used, and the log. Deliveries, stock counts, costs, reports and setup then need ' +
        'the PIN. It only affects this ' + DEVICE + '.</p>' +
        '<form data-form="pin" autocomplete="off" class="pin-form">' +
        '<input type="password" name="pin" inputmode="numeric" minlength="4" maxlength="12" required placeholder="New PIN" autocomplete="new-password">' +
        '<input type="password" name="pin2" inputmode="numeric" minlength="4" maxlength="12" required placeholder="PIN again" autocomplete="new-password">' +
        '<button type="submit" class="primary-btn compact">Set PIN</button></form>';
    } else {
      html += '<p class="card-note">A manager PIN is set on this ' + DEVICE + '. It locks itself when the app is ' +
        'reopened, or after 15 minutes without use.</p>' +
        '<div class="btn-row"><button type="button" class="ghost-btn" data-act="lock">Lock now</button>' +
        '<button type="button" class="ghost-btn danger" data-act="pin-remove">Remove PIN</button></div>';
    }
    html += '</div>';

    var st = FertSync.status();
    html += '<div class="card"><h3 class="card-title">Sharing</h3><p class="card-note">' +
      (st.connected ? 'Connected to ' + esc(st.company || 'your company') + '.'
                    : 'This ' + DEVICE + ' is not sharing with the others yet.') + '</p>' +
      '<button type="button" class="ghost-btn full" data-act="go" data-view="sync">' +
      (st.connected ? 'Sync settings' : 'Connect with the company code') + '</button></div>';

    $('view-setup').innerHTML = html;
  }

  function submitAdd(data) {
    var f = readProduct(data);
    if (typeof f === 'string') return toast(f);
    if (nameTaken(f.name)) return toast('There is already a fertiliser called ' + f.name + '.');
    addProduct(f, device.name);
    ui.draft.add = {};
    render();
    toast('Added ' + f.name + '.');
  }

  function submitEdit(data) {
    var p = productById(data.id);
    if (!p) return;
    var f = readProduct(data);
    if (typeof f === 'string') return toast(f);
    if (nameTaken(f.name, p.id)) return toast('There is already a fertiliser called ' + f.name + '.');
    f.active = !!data.active;
    updateProduct(p, f, device.name);
    ui.editPid = null;
    ui.draft.edit = {};
    render();
    toast('Saved ' + f.name + '.');
  }

  function submitPin(data) {
    var pin = String(data.pin || '').trim();
    if (!/^\d{4,12}$/.test(pin)) return toast('Use 4 to 12 digits for the PIN.');
    if (pin !== String(data.pin2 || '').trim()) return toast('The two PINs do not match.');
    device.pinHash = hashPin(pin);
    saveDevice();
    unlocked = true;
    lastActivity = Date.now();
    ui.draft.pin = {};
    render();
    toast('PIN set. Tap Lock when you hand the ' + DEVICE + ' to the mixer.');
  }

  // ── view: unlock ───────────────────────────────────────

  function renderUnlock() {
    $('view-unlock').innerHTML = '<h2 class="view-title">Manager</h2>' +
      '<form class="card" data-form="unlock" autocomplete="off">' +
      '<p class="card-note">Enter the manager PIN to book in deliveries, count stock, see costs and reports.</p>' +
      '<label class="field"><span>PIN</span><input type="password" name="pin" inputmode="numeric" ' +
      'maxlength="12" required autocomplete="current-password" class="pin-input"></label>' +
      '<button type="submit" class="primary-btn wide">Unlock</button></form>';
  }

  function submitUnlock(data) {
    if (hashPin(String(data.pin || '').trim()) !== device.pinHash) {
      ui.draft.unlock = {};
      render();
      return toast('Wrong PIN.');
    }
    unlocked = true;
    lastActivity = Date.now();
    ui.draft.unlock = {};
    ui.view = 'stock';
    render();
  }

  // ── view: sync ─────────────────────────────────────────

  function renderSync() {
    var st = FertSync.status();
    var line, sub;
    if (!st.connected) {
      line = 'This ' + DEVICE + ' only';
      sub = 'Records stay on this ' + DEVICE + '. The other devices will not see them, and you will not see theirs.';
    } else {
      line = st.syncing ? 'Syncing…' : st.error ? 'Could not sync'
        : st.pending ? st.pending + (st.pending === 1 ? ' change waiting' : ' changes waiting') : 'Up to date';
      var bits = ['Connected to ' + (st.company || 'your company') + '.'];
      if (st.error) bits.push(st.error);
      else if (!st.online) bits.push('No connection — changes will go up when it is back.');
      if (st.lastSyncedAt) bits.push('Last synced ' + agoText(st.lastSyncedAt) + '.');
      sub = bits.join(' ');
    }

    var html = '<h2 class="view-title">Share with other devices</h2>' +
      '<div class="card"><h3 class="card-title">Status</h3>' +
      '<p class="sync-line" id="syncLine">' + esc(line) + '</p><p class="sync-sub">' + esc(sub) + '</p>' +
      (st.connected ? '<div class="btn-row"><button type="button" class="ghost-btn" data-act="sync-now">Sync now</button>' +
        (isManager() ? '<button type="button" class="ghost-btn danger" data-act="disconnect">Disconnect</button>' : '') +
        '</div>' : '') + '</div>';

    if (!st.connected) {
      html += '<form class="card" data-form="connect" autocomplete="off">' +
        '<h3 class="card-title">Connect this ' + DEVICE + '</h3>' +
        '<p class="card-note">Type the fertiliser company code (not the Tikita one). Every tablet, ' +
        'phone and PC with the code shares one set of fertilisers, stock and log.</p>' +
        '<label class="field"><span class="sr-only">Company code</span><input name="code" id="codeInput" ' +
        'placeholder="XXXX-XXXX-XXXX-XXXX" autocapitalize="characters" autocorrect="off" spellcheck="false" ' +
        'maxlength="40" required value="' + esc(dv('connect', 'code')) + '"></label>' +
        '<button type="submit" class="primary-btn wide" id="connectBtn">Connect</button>' +
        '<p class="hint" id="connectHint"></p></form>';
    }

    html += '<div class="card muted-card"><h3 class="card-title">How it works</h3><p class="card-note">' +
      'Recording bags never needs signal. Entries are saved here straight away and go to the other ' +
      'devices the next time there is a connection, with the time they were actually made.</p></div>';
    $('view-sync').innerHTML = html;
  }

  function submitConnect(data) {
    var btn = $('connectBtn');
    var hint = $('connectHint');
    btn.disabled = true;
    hint.textContent = 'Connecting…';
    FertSync.connect(data.code).then(function (name) {
      ui.draft.connect = {};
      render();
      toast('Connected to ' + name + '.');
    }).catch(function (err) {
      btn.disabled = false;
      hint.textContent = err.message;
    });
  }

  function renderSyncChip(st) {
    var dot = $('syncDot');
    var text = $('syncChipText');
    dot.className = 'dot';
    if (!st.connected) { text.textContent = 'This ' + DEVICE + ' only'; return; }
    if (st.syncing) { dot.classList.add('busy'); text.textContent = 'Syncing…'; return; }
    if (st.error) { dot.classList.add('error'); text.textContent = 'Not synced'; return; }
    if (st.pending) { dot.classList.add('pending'); text.textContent = st.pending + ' waiting'; return; }
    dot.classList.add('ok');
    text.textContent = 'Synced';
  }

  // ── routing ────────────────────────────────────────────

  var TABS = {
    stock: ['Stock', '<path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 12l9 4 9-4M3 17l9 4 9-4"/>'],
    use: ['Use bags', '<path d="M12 5v14M5 12h14"/>'],
    log: ['Log', '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>'],
    report: ['Report', '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'],
    setup: ['Setup', '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/>'],
    unlock: ['Manager', '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/>']
  };

  /* Screens reached from a button rather than the tab bar light up their parent tab. */
  var PARENT = { delivery: 'stock', count: 'stock', sync: 'setup' };

  function renderTabs() {
    var tabs = isManager() ? ['stock', 'use', 'log', 'report', 'setup'] : ['stock', 'use', 'log', 'unlock'];
    var current = PARENT[ui.view] || ui.view;
    if (!isManager() && ui.view === 'sync') current = '';
    $('tabbar').innerHTML = tabs.map(function (t) {
      var on = t === current;
      return '<button type="button" class="tab' + (on ? ' is-active' : '') + '" role="tab" aria-selected="' + on +
        '" data-act="go" data-view="' + t + '"><svg viewBox="0 0 24 24" aria-hidden="true">' + TABS[t][1] +
        '</svg><span>' + TABS[t][0] + '</span></button>';
    }).join('');
    $('lockBtn').hidden = !(device.pinHash && unlocked);
  }

  function setView(name, pid) {
    if (MANAGER_VIEWS[name] && !isManager()) name = 'unlock';
    if (name === 'unlock' && isManager()) name = 'stock';
    ui.view = name;
    ui.voidId = null;
    if (pid && (name === 'delivery' || name === 'count')) {
      draft(name).pid = pid;
      if (name === 'delivery') delete draft(name).cost;
    }
    render();
    window.scrollTo(0, 0);
  }

  var heldRender = false;

  function render() {
    heldRender = false;
    if (MANAGER_VIEWS[ui.view] && !isManager()) ui.view = 'unlock';
    if (ui.view === 'unlock' && isManager()) ui.view = 'stock';
    document.querySelectorAll('.view').forEach(function (el) {
      el.hidden = el.id !== 'view-' + ui.view;
    });
    ({ stock: renderStock, use: renderUse, delivery: renderDelivery, count: renderCount, log: renderLog,
       report: renderReport, setup: renderSetup, sync: renderSync, unlock: renderUnlock })[ui.view]();
    renderTabs();
  }

  /*
   * Another device's change arrived. Typing is kept in ui.draft, but a
   * re-render would still steal the keyboard from a field being typed in,
   * so wait until the field is left.
   */
  function renderFromRemote() {
    var el = document.activeElement;
    if (el && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) && $('main').contains(el) &&
        el.type !== 'radio' && el.type !== 'checkbox') {
      heldRender = true;
      return;
    }
    render();
  }

  // ── events ─────────────────────────────────────────────

  function formData(form) {
    var data = {};
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name) return;
      if (el.type === 'radio') { if (el.checked) data[el.name] = el.value; }
      else if (el.type === 'checkbox') data[el.name] = el.checked;
      else data[el.name] = el.value;
    });
    return data;
  }

  var SUBMIT = {
    use: submitUse, delivery: submitDelivery, count: submitCount, void: submitVoid,
    add: submitAdd, edit: submitEdit, pin: submitPin, unlock: submitUnlock, connect: submitConnect
  };

  function wire() {
    document.addEventListener('click', function (e) {
      var el = e.target.closest('[data-act]');
      if (!el) return;
      var act = el.dataset.act;

      if (act === 'go') { e.preventDefault(); setView(el.dataset.view, el.dataset.pid); }
      else if (act === 'step') {
        var input = el.parentNode.querySelector('input');
        var v = parseNum(input.value) || 0;
        var next = Number(el.dataset.step) > 0 ? Math.floor(v) + 1 : (v > 1 ? Math.ceil(v) - 1 : 0.5);
        input.value = next;
        draft('use').bags = String(next);
      }
      else if (act === 'void-open') { ui.voidId = el.dataset.id; ui.draft.void = {}; render(); }
      else if (act === 'void-close') { ui.voidId = null; render(); }
      else if (act === 'edit-open') { ui.editPid = el.dataset.id; ui.draft.edit = {}; render(); }
      else if (act === 'edit-close') { ui.editPid = null; render(); }
      else if (act === 'month') {
        var step = Number(el.dataset.step);
        ui.month = step ? shiftMonth(ui.month, step) : monthKey(new Date());
        render();
      }
      else if (act === 'export-month') exportMonth();
      else if (act === 'export-log') exportLog();
      else if (act === 'backup') doBackup();
      else if (act === 'restore') $('restoreInput').click();
      else if (act === 'lock') lock();
      else if (act === 'pin-remove') {
        if (confirm('Remove the manager PIN? Everyone using this ' + DEVICE + ' will see every screen.')) {
          device.pinHash = '';
          saveDevice();
          render();
        }
      }
      else if (act === 'sync-now') FertSync.sync();
      else if (act === 'disconnect') {
        if (confirm('Disconnect this ' + DEVICE + '? Its records stay here, but it stops sharing. ' +
                    'Changes not yet sent will not reach the other devices.')) {
          FertSync.disconnect();
          render();
        }
      }
    });

    document.addEventListener('submit', function (e) {
      var form = e.target.closest('form[data-form]');
      if (!form) return;
      e.preventDefault();
      SUBMIT[form.dataset.form](formData(form));
    });

    // Keep every half-typed form in ui.draft so a re-render never loses it.
    function remember(e) {
      var el = e.target;
      var form = el.form && el.form.dataset.form;
      if (!form || !el.name) return;
      draft(form)[el.name] = el.type === 'checkbox' ? el.checked : el.value;
      if (el.type === 'radio' && e.type === 'change') {
        if (form === 'delivery') delete draft(form).cost;   // take the new fertiliser's price
        render();
      }
    }
    document.addEventListener('input', remember);
    document.addEventListener('change', function (e) {
      var el = e.target;
      if (el.dataset && el.dataset.filter) {
        if (el.value || !/^log(From|To)$/.test(el.dataset.filter)) ui[el.dataset.filter] = el.value;
        render();
        return;
      }
      if (el.id === 'restoreInput') {
        if (el.files && el.files[0]) doRestore(el.files[0]);
        el.value = '';
        return;
      }
      remember(e);
    });

    document.addEventListener('focusout', function () {
      if (!heldRender) return;
      setTimeout(function () {
        var el = document.activeElement;
        if (!el || !/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) render();
      }, 0);
    });

    $('syncChip').addEventListener('click', function () { setView('sync'); });
    $('lockBtn').addEventListener('click', lock);
    $('toastAction').addEventListener('click', function () {
      var fn = toastFn;
      toastFn = null;
      $('toast').hidden = true;
      if (fn) fn();
    });

    ['pointerdown', 'keydown'].forEach(function (type) {
      document.addEventListener(type, function () { lastActivity = Date.now(); }, true);
    });
    setInterval(function () {
      if (device.pinHash && unlocked && Date.now() - lastActivity > RELOCK_MS) lock();
    }, 30000);
  }

  // ── install prompt ─────────────────────────────────────

  var deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    $('installBtn').hidden = false;
  });
  window.addEventListener('appinstalled', function () {
    $('installBtn').hidden = true;
    deferredPrompt = null;
  });

  // ── boot ───────────────────────────────────────────────

  load();
  if (IS_DESKTOP) document.documentElement.classList.add('is-desktop');

  FertSync.init({
    getState: function () { return state; },
    save: save,
    onRemoteChange: renderFromRemote
  });
  FertSync.onStatus(function (st) {
    renderSyncChip(st);
    if (ui.view === 'sync') renderFromRemote();
  });

  wire();
  $('installBtn').addEventListener('click', function () {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    deferredPrompt = null;
    $('installBtn').hidden = true;
  });
  renderSyncChip(FertSync.status());
  render();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').catch(function () { /* offline support is optional */ });
    });
  }
})();
