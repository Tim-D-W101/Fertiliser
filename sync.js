/*
 * Fertiliser sync — the same design as Tikita's.
 *
 * Every device shares the company code. That code is the only secret: the
 * database exposes no tables, just three functions that check the code
 * first, so the publishable key below is safe to ship in the page. It is the
 * same Supabase project as Tikita, but fertiliser has its own company code.
 *
 * Offline-first. Every change is written to this device first and remembered
 * in a "pending" list; a sync pushes that list, then pulls whatever other
 * devices changed. Nothing is lost by being out of signal.
 */
(function (global) {
  'use strict';

  var API_URL = 'https://kgjmjzhovyclakppmnmf.supabase.co';
  var API_KEY = 'sb_publishable_B1Zr6gMynR5BP74kicH22w_WDndA_Kx';

  /*
   * Ask for slightly more history than strictly needed. A row can be stamped
   * just before a pull yet commit just after it, which would otherwise fall
   * into the gap between two syncs and never be seen again.
   */
  var OVERLAP_MS = 120000;
  var DEBOUNCE_MS = 2000;
  var POLL_MS = 60000;

  var KINDS = ['products', 'centres', 'moves', 'prices'];

  var ctx = null;
  var running = false;
  var queued = false;
  var debounce = null;
  var listeners = [];

  // ── plumbing ───────────────────────────────────────────

  function rpc(fn, body) {
    return fetch(API_URL + '/rest/v1/rpc/' + fn, {
      method: 'POST',
      headers: {
        'apikey': API_KEY,
        'Authorization': 'Bearer ' + API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (err) { /* not json */ }
        if (!res.ok) {
          var error = new Error((data && (data.message || data.hint)) || ('HTTP ' + res.status));
          error.status = res.status;
          error.pgcode = data && data.code;
          throw error;
        }
        return data;
      });
    });
  }

  function describe(err) {
    if (err && (err.pgcode === '28000' || /invalid_code/.test(err.message || ''))) {
      return 'That company code was not recognised.';
    }
    if (err && err.status) return 'Server said no (' + err.status + ').';
    return 'No connection.';
  }

  function state() { return ctx.getState(); }

  function shape(s) {
    if (!s.sync) s.sync = { code: '', name: '', lastNow: null, lastSyncedAt: null, lastError: '' };
    if (!s.pending) s.pending = {};
    KINDS.forEach(function (k) { if (!s.pending[k]) s.pending[k] = {}; });
    return s;
  }

  function emit() {
    listeners.forEach(function (fn) { try { fn(status()); } catch (err) { /* ignore */ } });
  }

  // ── what this device still owes the server ─────────────

  function touch(kind, id) {
    shape(state()).pending[kind][id] = 1;
  }

  function pendingCount() {
    var p = shape(state()).pending;
    return KINDS.reduce(function (n, k) { return n + Object.keys(p[k]).length; }, 0);
  }

  function indexById(list) {
    var map = {};
    list.forEach(function (x, i) { map[x.id] = i; });
    return map;
  }

  function payload() {
    var s = state();
    var products = indexById(s.products);
    var moves = indexById(s.moves);
    var prices = indexById(s.prices);
    var centres = indexById(s.centres);
    return {
      products: Object.keys(s.pending.products).map(function (id) {
        var p = s.products[products[id]];
        return p ? { id: id, name: p.name, kg: p.kg, cost: p.cost, reorder: p.reorder || 0,
                     active: p.active !== false, deleted: false }
                 : { id: id, deleted: true };
      }),
      centres: Object.keys(s.pending.centres).map(function (id) {
        var c = s.centres[centres[id]];
        return c ? { id: id, name: c.name, active: c.active !== false, deleted: false }
                 : { id: id, deleted: true };
      }),
      moves: Object.keys(s.pending.moves).map(function (id) {
        return s.moves[moves[id]];
      }).filter(Boolean),
      prices: Object.keys(s.pending.prices).map(function (id) {
        return s.prices[prices[id]];
      }).filter(Boolean)
    };
  }

  // ── merging what other devices changed ─────────────────

  function num(v) { return Number(v) || 0; }

  function applyRemote(data) {
    var s = state();
    var changed = false;

    var products = indexById(s.products);
    (data.products || []).forEach(function (row) {
      if (s.pending.products[row.id]) return;   // unsent local edit wins for now
      var i = products[row.id];
      if (row.deleted) {
        if (i !== undefined) { s.products.splice(i, 1); products = indexById(s.products); changed = true; }
        return;
      }
      var next = { id: row.id, name: row.name, kg: num(row.kg), cost: num(row.cost),
                   reorder: num(row.reorder), active: row.active !== false };
      if (i === undefined) {
        s.products.push(next);
        products[row.id] = s.products.length - 1;
        changed = true;
      } else if (JSON.stringify(s.products[i]) !== JSON.stringify(next)) {
        s.products[i] = next;
        changed = true;
      }
    });

    var centres = indexById(s.centres);
    (data.centres || []).forEach(function (row) {
      if (s.pending.centres[row.id]) return;
      var i = centres[row.id];
      if (row.deleted) {
        if (i !== undefined) { s.centres.splice(i, 1); centres = indexById(s.centres); changed = true; }
        return;
      }
      var next = { id: row.id, name: row.name, active: row.active !== false };
      if (i === undefined) {
        s.centres.push(next);
        centres[row.id] = s.centres.length - 1;
        changed = true;
      } else if (JSON.stringify(s.centres[i]) !== JSON.stringify(next)) {
        s.centres[i] = next;
        changed = true;
      }
    });

    var moves = indexById(s.moves);
    (data.moves || []).forEach(function (row) {
      if (s.pending.moves[row.id]) return;
      var next = { id: row.id, pid: row.pid, kind: row.kind, bags: num(row.bags), kg: num(row.kg),
                   cost: num(row.cost), by: row.by || '', note: row.note || '',
                   centre: row.centre || null,
                   at: new Date(row.at).toISOString(),
                   voidAt: row.voidAt ? new Date(row.voidAt).toISOString() : null,
                   voidBy: row.voidBy || null, voidReason: row.voidReason || null };
      var i = moves[row.id];
      if (i === undefined) {
        s.moves.push(next);
        moves[row.id] = s.moves.length - 1;
        changed = true;
      } else if (JSON.stringify(s.moves[i]) !== JSON.stringify(next)) {
        s.moves[i] = next;
        changed = true;
      }
    });

    var prices = indexById(s.prices);
    (data.prices || []).forEach(function (row) {
      if (prices[row.id] !== undefined) return;   // price records never change
      s.prices.push({ id: row.id, pid: row.pid, cost: num(row.cost),
                      at: new Date(row.at).toISOString(), by: row.by || '' });
      prices[row.id] = s.prices.length - 1;
      changed = true;
    });

    return changed;
  }

  // ── the sync itself ────────────────────────────────────

  function snapshot(pending) {
    var out = {};
    KINDS.forEach(function (k) { out[k] = Object.keys(pending[k]); });
    return out;
  }

  /* Clear only what we actually sent — a change made during the request stays pending. */
  function settle(sent) {
    var p = state().pending;
    KINDS.forEach(function (k) { sent[k].forEach(function (id) { delete p[k][id]; }); });
  }

  function run(manual) {
    var s = shape(state());
    if (!s.sync.code) return Promise.resolve('not-connected');
    if (running) { queued = true; return Promise.resolve('busy'); }
    if (!manual && global.navigator && navigator.onLine === false) {
      return Promise.resolve('offline');
    }

    running = true;
    emit();

    var body = payload();
    var sent = snapshot(s.pending);
    var hasWork = body.products.length || body.centres.length || body.moves.length || body.prices.length;

    var push = hasWork
      ? rpc('fert_push', { p_code: s.sync.code, p_payload: body })
      : Promise.resolve(null);

    return push.then(function () {
      settle(sent);
      var since = s.sync.lastNow
        ? new Date(new Date(s.sync.lastNow).getTime() - OVERLAP_MS).toISOString()
        : null;
      return rpc('fert_pull', { p_code: s.sync.code, p_since: since });
    }).then(function (data) {
      var changed = applyRemote(data);
      s.sync.lastNow = data.now;
      s.sync.lastSyncedAt = new Date().toISOString();
      s.sync.lastError = '';
      ctx.save();
      running = false;
      if (changed && ctx.onRemoteChange) ctx.onRemoteChange();
      emit();
      if (queued) { queued = false; setTimeout(function () { run(false); }, 400); }
      return 'ok';
    }).catch(function (err) {
      running = false;
      s.sync.lastError = describe(err);
      ctx.save();
      emit();
      return 'error';
    });
  }

  function schedule() {
    if (!shape(state()).sync.code) return;
    clearTimeout(debounce);
    debounce = setTimeout(function () { run(false); }, DEBOUNCE_MS);
    emit();
  }

  // ── joining and leaving ────────────────────────────────

  function connect(code) {
    var clean = String(code || '').trim().toUpperCase();
    if (!clean) return Promise.reject(new Error('Enter your company code.'));

    return rpc('fert_join', { p_code: clean }).then(function (info) {
      var s = shape(state());
      s.sync.code = clean;
      s.sync.name = info.name;
      s.sync.lastNow = null;          // force a full pull
      s.sync.lastError = '';

      // Whatever is already on this device should reach the others.
      s.products.forEach(function (x) { s.pending.products[x.id] = 1; });
      (s.centres || []).forEach(function (x) { s.pending.centres[x.id] = 1; });
      s.moves.forEach(function (x) { s.pending.moves[x.id] = 1; });
      s.prices.forEach(function (x) { s.pending.prices[x.id] = 1; });

      ctx.save();
      emit();
      return run(true).then(function (result) {
        if (result === 'error') throw new Error(s.sync.lastError || 'Sync failed.');
        return info.name;
      });
    }).catch(function (err) {
      throw new Error(describe(err) === 'No connection.' && err.message && !err.status
        ? err.message : describe(err));
    });
  }

  function disconnect() {
    var s = shape(state());
    s.sync = { code: '', name: '', lastNow: null, lastSyncedAt: null, lastError: '' };
    s.pending = {};
    shape(s);
    ctx.save();
    emit();
  }

  function status() {
    var s = shape(state());
    return {
      connected: !!s.sync.code,
      company: s.sync.name,
      pending: pendingCount(),
      syncing: running,
      lastSyncedAt: s.sync.lastSyncedAt,
      error: s.sync.lastError,
      online: !global.navigator || navigator.onLine !== false
    };
  }

  function init(options) {
    ctx = options;
    shape(state());

    global.addEventListener('online', function () { run(false); });
    global.addEventListener('focus', function () { run(false); });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) run(false);
    });

    // A tablet or PC left open on the stock screen should still show what
    // other devices recorded, so pull on a timer while it is on screen.
    setInterval(function () {
      if (document.hidden) return;
      run(false);
    }, POLL_MS);

    if (shape(state()).sync.code) setTimeout(function () { run(false); }, 600);
  }

  global.FertSync = {
    init: init,
    connect: connect,
    disconnect: disconnect,
    sync: function () { return run(true); },
    schedule: schedule,
    touch: touch,
    status: status,
    onStatus: function (fn) { listeners.push(fn); }
  };
})(window);
