/* ============================================================================
 * si-cloud.js — Cross-device sync for service_inclusive.html
 *
 * Bolts Supabase persistence onto the existing localStorage-only page without
 * modifying its inline <script>. Loads after the page's own init(), pulls
 * cloud data, merges into state, then subscribes to realtime changes.
 *
 * How it works:
 *   1. Loads supabase-js from a CDN-fallback chain
 *   2. Pulls all 6 tables on startup, merges into the existing global `state`
 *   3. Monkey-patches the global save() function to also push diffs to cloud
 *   4. Subscribes to realtime changes — other devices' edits land within ~2s
 *
 * Deployment:
 *   1. Run 17_service_inclusive_schema.sql in Supabase SQL editor
 *   2. Drop this file next to service_inclusive.html
 *   3. Paste your anon key in SUPABASE_ANON below
 *      (same key your other pages use — safe to expose, by Supabase design)
 *   4. Add to service_inclusive.html, just before </body>:
 *        <script src="si-cloud.js" defer></script>
 * ============================================================================ */
(function () {
  'use strict';

  // ─── CONFIG ────────────────────────────────────────────────────────────────
  const SUPABASE_URL  = 'https://egcbbfiqzaccsquaytvz.supabase.co';

  // PASTE YOUR ANON KEY BELOW (same one used in warranty.html / config.js).
  // It IS safe to commit to a public repo — Supabase anon keys are designed
  // for browser exposure; RLS policies enforce access.
  const SUPABASE_ANON =
    (typeof window !== 'undefined' && (window.SUPABASE_ANON_KEY || window.SB_ANON_KEY)) ||
    /* PASTE_HERE → */ 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVnY2JiZmlxemFjY3NxdWF5dHZ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxMDE1MzgsImV4cCI6MjA5MjY3NzUzOH0.2qLR3uLTE8C2tKSQUEV-9q2DF8Hrfad08UQoLv5Q72c';

  if (!SUPABASE_ANON) {
    console.warn('[si-cloud] No anon key — set window.SUPABASE_ANON_KEY or paste into si-cloud.js. Cloud sync disabled.');
    return;
  }

  // CDN fallback chain. Matches the pattern used elsewhere on this site.
  const CDN_URLS = [
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js',
    'https://unpkg.com/@supabase/supabase-js@2/dist/umd/supabase.min.js',
    'https://cdn.skypack.dev/@supabase/supabase-js@2',
  ];

  // ─── SUPABASE JS LOADER ────────────────────────────────────────────────────
  function loadSupabaseJs() {
    return new Promise((resolve, reject) => {
      if (window.supabase?.createClient) return resolve(window.supabase);
      let idx = 0;
      const tryNext = () => {
        if (idx >= CDN_URLS.length) return reject(new Error('All CDNs failed'));
        const url = CDN_URLS[idx++];
        const s = document.createElement('script');
        let done = false;
        // Per-CDN timeout: a CDN blocked/throttled by the ISP can HANG instead of
        // firing onerror — without this, boot waits forever on the first URL.
        const t = setTimeout(() => { if (!done) { done = true; s.remove(); tryNext(); } }, 6000);
        s.src = url;
        s.onload = () => {
          if (done) return; done = true; clearTimeout(t);
          window.supabase?.createClient ? resolve(window.supabase) : tryNext();
        };
        s.onerror = () => { if (done) return; done = true; clearTimeout(t); tryNext(); };
        document.head.appendChild(s);
      };
      tryNext();
    });
  }

  // ─── FIELD-NAME MAPPERS (camelCase ↔ snake_case) ───────────────────────────
  // The browser state uses camelCase; Postgres uses snake_case. These small
  // converters keep both sides clean — no need to touch the existing page code.

  const M = {
    vehicles: {
      table: 'si_vehicles',
      stateKey: 'vehicles',
      toDb: v => ({
        id: v.id, vin: v.vin || null, plate: v.plate || null, year: v.year || null,
        make: v.make || null, model: v.model || null,
        customer_name: v.customerName || null, customer_phone: v.customerPhone || null,
        customer_email: v.customerEmail || null, current_mileage: v.currentMileage || 0,
        created_at: v.createdAt || null,
      }),
      fromDb: r => ({
        id: r.id, vin: r.vin || '', plate: r.plate || '', year: r.year || null,
        make: r.make || '', model: r.model || '',
        customerName: r.customer_name || '', customerPhone: r.customer_phone || '',
        customerEmail: r.customer_email || '', currentMileage: r.current_mileage || 0,
        createdAt: r.created_at || null,
      }),
    },
    packages: {
      table: 'si_packages',
      stateKey: 'packages',
      toDb: p => ({
        id: p.id, vehicle_id: p.vehicleId || null, package_type: p.packageType || null,
        invoiced_amount: p.invoicedAmount || 0,
        start_date: toIsoDate(p.startDate), end_date: toIsoDate(p.endDate),
        start_mileage: p.startMileage || 0, mileage_cap: p.mileageCap || 0,
        notes: p.notes || null, created_at: p.createdAt || null,
      }),
      fromDb: r => ({
        id: r.id, vehicleId: r.vehicle_id || '', packageType: r.package_type || '',
        invoicedAmount: Number(r.invoiced_amount) || 0,
        startDate: r.start_date || '', endDate: r.end_date || '',
        startMileage: r.start_mileage || 0, mileageCap: r.mileage_cap || 0,
        notes: r.notes || '', createdAt: r.created_at || null,
      }),
    },
    services: {
      table: 'si_services',
      stateKey: 'services',
      toDb: s => ({
        id: s.id, vehicle_id: s.vehicleId || null, package_id: s.packageId || null,
        service_date: toIsoDate(s.serviceDate), mileage: s.mileage || 0,
        service_type: s.serviceType || null, amount: s.amount || 0,
        invoice_number: s.invoiceNumber || null, technician: s.technician || null,
        description: s.description || null, created_at: s.createdAt || null,
      }),
      fromDb: r => ({
        id: r.id, vehicleId: r.vehicle_id || '', packageId: r.package_id || '',
        serviceDate: r.service_date || '', mileage: r.mileage || 0,
        serviceType: r.service_type || '', amount: Number(r.amount) || 0,
        invoiceNumber: r.invoice_number || '', technician: r.technician || '',
        description: r.description || '', createdAt: r.created_at || null,
      }),
    },
    followUps: {
      table: 'si_followups',
      stateKey: 'followUps',
      toDb: f => ({
        id: f.id, package_id: f.packageId || null, vehicle_id: f.vehicleId || null,
        call_date: toIsoDate(f.callDate), agent_name: f.agentName || null,
        status: f.status || null, outcome: f.outcome || null,
        next_follow_up_date: toIsoDate(f.nextFollowUpDate),
        call_duration: f.callDuration || null, notes: f.notes || null,
        created_at: f.createdAt || null,
      }),
      fromDb: r => ({
        id: r.id, packageId: r.package_id || '', vehicleId: r.vehicle_id || '',
        callDate: r.call_date || '', agentName: r.agent_name || '',
        status: r.status || '', outcome: r.outcome || 'pending',
        nextFollowUpDate: r.next_follow_up_date || null,
        callDuration: r.call_duration || null, notes: r.notes || '',
        createdAt: r.created_at || null,
        updatedAt: r.updated_at || null,
      }),
    },
    emailReminders: {
      table: 'si_email_reminders',
      stateKey: 'emailReminders',
      toDb: r => ({
        id: r.id, package_id: r.packageId || null, vehicle_id: r.vehicleId || null,
        reminder_type: r.reminderType || null,
        sent_date: toIsoDate(r.sentDate),
        sent_timestamp: r.sentTimestamp || null,
        recipient_email: r.recipientEmail || null,
        status: r.status || null, sent_by: r.sentBy || null,
      }),
      fromDb: r => ({
        id: r.id, packageId: r.package_id || '', vehicleId: r.vehicle_id || '',
        reminderType: r.reminder_type || '', sentDate: r.sent_date || '',
        sentTimestamp: r.sent_timestamp || null,
        recipientEmail: r.recipient_email || '', status: r.status || '',
        sentBy: r.sent_by || '',
      }),
    },
  };

  // Date sanitizer — the existing app stores ISO dates already, but this
  // protects against any "Wed Jan 21"-style strings that bypassed the form.
  // Matches the _toIsoDate() pattern used on warranty.html.
  function toIsoDate(v) {
    if (!v) return null;
    if (typeof v === 'string') {
      // Already YYYY-MM-DD?
      if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
      const d = new Date(v);
      if (!isNaN(d)) return d.toISOString().slice(0, 10);
      return null;
    }
    if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
    return null;
  }

  // ─── CLOUD CLIENT ──────────────────────────────────────────────────────────
  let sb = null;            // Supabase client
  let cloudReady = false;
  let suppressPush = false; // Set true while applying a realtime change
  let lastSnapshot = null;  // { vehicles: Set<id>, packages: Set<id>, ... } — for diff/delete detection

  function snapshotState() {
    const snap = {};
    for (const k of Object.keys(M)) {
      snap[k] = new Set((state[M[k].stateKey] || []).map(x => x.id));
    }
    snap.settingsHash = JSON.stringify(state.settings || {});
    return snap;
  }

  // ─── INCREMENTAL SYNC STATE ───────────────────────────────────────────────
  // After the first full pull we store the newest created_at per table; later
  // loads fetch only rows newer than that, instead of re-downloading everything.
  const SYNC_KEY = 'si_sync_v1';
  const STALE_MS = 6 * 60 * 60 * 1000;                       // force a full pull every 6h
  const TS_KEYS = ['vehicles', 'packages', 'services', 'followUps']; // tables that have created_at

  function loadSync() { try { return JSON.parse(localStorage.getItem(SYNC_KEY)) || null; } catch (e) { return null; } }
  function saveSync(s) { try { localStorage.setItem(SYNC_KEY, JSON.stringify(s)); } catch (e) {} }
  function persistLocal() { try { localStorage.setItem('drivetrain.v1', JSON.stringify(state)); } catch (e) {} }
  function computeWatermarks() {
    const perTable = {};
    for (const k of TS_KEYS) {
      let max = '';
      for (const r of (state[M[k].stateKey] || [])) { if (r.createdAt && r.createdAt > max) max = r.createdAt; }
      if (max) perTable[k] = max;
    }
    return perTable;
  }

  // Pull one table (paginated). With `since`, only fetch rows created after it.
  async function pullTable(k, since) {
    const m = M[k];
    let all = [], from = 0, page = 1000;
    for (;;) {
      let q = sb.from(m.table).select('*').range(from, from + page - 1);
      if (since && k !== 'emailReminders') q = q.gt('created_at', since);
      const { data, error } = await q;
      if (error) { console.warn(`[si-cloud] pull ${m.table} failed:`, error.message); return { k, rows: null, error }; }
      all = all.concat(data || []);
      if (!data || data.length < page) break;
      from += page;
    }
    console.log(`[si-cloud] pulled ${all.length} from ${m.table}${since ? ' (incremental)' : ''}`);
    return { k, rows: all.map(m.fromDb) };
  }

  // All 6 tables + settings IN PARALLEL (was strictly sequential — the main
  // cause of the multi-minute load against a distant/cold region).
  async function pullAll(sync) {
    const out = {};
    const results = await Promise.all(Object.keys(M).map(k =>
      pullTable(k, sync && sync.perTable ? sync.perTable[k] : null)));
    let anyError = false, anyOk = false;
    for (const r of results) {
      out[r.k] = r.rows;
      if (r.error) anyError = true; else anyOk = true;
    }
    const { data: setData, error: setErr } = await sb.from('si_settings').select('*').eq('id', 1).maybeSingle();
    if (!setErr && setData?.data) out.settings = setData.data;
    // Flag so boot() knows whether the cloud actually answered.
    out.__ok = anyOk;
    out.__error = anyError;
    return out;
  }


  function mergeIntoState(cloud) {
    let changed = false;

    // Per-entity merge: cloud wins for conflicts (by id); local-only items remain
    // (they get pushed up on next save). This handles the "new device joins" case
    // and the "first sync from device that already had localStorage data" case.
    for (const k of Object.keys(M)) {
      const cloudRows = cloud[k];
      if (!cloudRows) continue;
      const m = M[k];
      const localRows = state[m.stateKey] || [];
      const cloudIds = new Set(cloudRows.map(r => r.id));
      const localOnly = localRows.filter(r => !cloudIds.has(r.id));
      const merged = [...cloudRows, ...localOnly];
      if (JSON.stringify(merged) !== JSON.stringify(localRows)) {
        state[m.stateKey] = merged;
        changed = true;
      }
    }

    // Settings: cloud overrides if newer-looking
    if (cloud.settings && typeof cloud.settings === 'object') {
      const merged = { ...state.settings, ...cloud.settings };
      if (JSON.stringify(merged) !== JSON.stringify(state.settings)) {
        state.settings = merged;
        changed = true;
      }
    }
    return changed;
  }

  // Push items that exist locally but weren't in the snapshot from cloud
  // (i.e. local-only items on first connect). Idempotent — upsert.
  async function pushLocalOnly(cloud) {
    for (const k of Object.keys(M)) {
      const m = M[k];
      const localRows = state[m.stateKey] || [];
      if (!localRows.length) continue;
      const cloudIds = new Set((cloud && cloud[k] ? cloud[k] : []).map(r => r.id));
      const missing = localRows.filter(r => !cloudIds.has(r.id));
      if (!missing.length) continue;     // cloud already has everything → upload nothing
      const { error } = await sb.from(m.table).upsert(missing.map(m.toDb), { onConflict: 'id' });
      if (error) console.warn(`[si-cloud] push ${m.table} failed:`, error.message);
      else console.log(`[si-cloud] pushed ${missing.length} local-only to ${m.table}`);
    }
    await pushSettings();
  }

  async function pushSettings() {
    const { error } = await sb.from('si_settings').upsert(
      { id: 1, data: state.settings, updated_at: new Date().toISOString() },
      { onConflict: 'id' }
    );
    if (error) console.warn('[si-cloud] settings push failed:', error.message);
  }

  // Compute diff vs lastSnapshot and push add/update/deletes to cloud.
  // Called from the monkey-patched save() on every state mutation.
  async function pushDiff() {
    if (!cloudReady || suppressPush) return;
    const prev = lastSnapshot;
    const curr = snapshotState();

    for (const k of Object.keys(M)) {
      const m = M[k];
      const rows = state[m.stateKey] || [];
      const currIds = curr[k];
      const prevIds = prev ? prev[k] : new Set();

      // Upsert everything currently in state (covers adds + updates).
      // We don't try to detect "no-op updates" — Supabase upsert is cheap.
      if (rows.length) {
        const payload = rows.map(m.toDb);
        const { error } = await sb.from(m.table).upsert(payload, { onConflict: 'id' });
        if (error) console.warn(`[si-cloud] upsert ${m.table} failed:`, error.message);
      }

      // Deletes DISABLED — safe mode. This sync NEVER removes rows from the
      // cloud, so a local "Reset all", a stale device, or an empty localStorage
      // can never wipe the seeded fleet. Removals are logged only.
      const removed = [];
      for (const id of prevIds) if (!currIds.has(id)) removed.push(id);
      if (removed.length) console.log(`[si-cloud] ${removed.length} local removals in ${m.table} — NOT pushed (safe mode)`);
    }

    // Settings: push if changed
    if (!prev || prev.settingsHash !== curr.settingsHash) {
      await pushSettings();
    }

    lastSnapshot = curr;
  }

  // ─── REALTIME ──────────────────────────────────────────────────────────────
  function subscribeAll() {
    for (const k of Object.keys(M)) {
      const m = M[k];
      sb.channel(`si-${m.table}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: m.table }, payload => {
          applyRealtime(k, m, payload);
        })
        .subscribe();
    }
    sb.channel('si-settings')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'si_settings' }, payload => {
        if (payload.new?.data) {
          suppressPush = true;
          state.settings = { ...state.settings, ...payload.new.data };
          if (typeof refreshBranding === 'function') refreshBranding();
          if (typeof navigate === 'function' && state.ui?.currentView) navigate(state.ui.currentView);
          suppressPush = false;
        }
      })
      .subscribe();
  }

  function applyRealtime(entityKey, m, payload) {
    suppressPush = true;
    try {
      const arr = state[m.stateKey] || (state[m.stateKey] = []);
      if (payload.eventType === 'DELETE') {
        const id = payload.old?.id;
        if (id) state[m.stateKey] = arr.filter(x => x.id !== id);
      } else {
        // INSERT or UPDATE
        const row = m.fromDb(payload.new);
        const idx = arr.findIndex(x => x.id === row.id);
        if (idx >= 0) arr[idx] = row;
        else arr.push(row);
      }
      // Save to localStorage (without triggering cloud push)
      try { localStorage.setItem('drivetrain.v1', JSON.stringify(state)); } catch (e) {}
      // Re-render current view if app helpers are available
      if (typeof refreshStorageInfo === 'function') refreshStorageInfo();
      if (typeof refreshBell === 'function') refreshBell();
      if (typeof navigate === 'function' && state.ui?.currentView) navigate(state.ui.currentView);
      // Update snapshot so we don't fight this change on the next save()
      lastSnapshot = snapshotState();
    } catch (e) {
      console.warn('[si-cloud] realtime apply error:', e);
    } finally {
      suppressPush = false;
    }
  }

  // ─── HOOK INTO EXISTING PAGE ───────────────────────────────────────────────
  function hookSave() {
    if (typeof window.save !== 'function') {
      console.warn('[si-cloud] global save() not found — page not initialised yet?');
      return;
    }
    const originalSave = window.save;
    window.save = function () {
      const r = originalSave.apply(this, arguments);
      // Push to cloud (async, fire-and-forget — UI doesn't wait)
      pushDiff().catch(e => console.warn('[si-cloud] push failed:', e));
      return r;
    };
  }

  // Wrap a promise with a hard timeout so a cold/blocked backend can never
  // leave the app hanging. Rejects after `ms` if not settled.
  function withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error((label || 'op') + ' timed out after ' + ms + 'ms')), ms)),
    ]);
  }

  // ─── BOOT ──────────────────────────────────────────────────────────────────
  async function boot() {
    try {
      // Wait for the page's own init() to finish populating state from localStorage.
      let attempts = 0;
      while ((typeof state === 'undefined' || typeof save !== 'function') && attempts < 50) {
        await new Promise(r => setTimeout(r, 50));
        attempts++;
      }
      if (typeof state === 'undefined') {
        console.warn('[si-cloud] state not found after 2.5s — aborting');
        return;
      }

      console.log('[si-cloud] loading Supabase JS…');
      await withTimeout(loadSupabaseJs(), 20000, 'supabase-js load');
      sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
        realtime: { params: { eventsPerSecond: 5 } },
      });

      // Full vs incremental: warm cache + a recent full pull → fetch only new rows.
      const sync = loadSync();
      const haveCache = ((state.vehicles && state.vehicles.length) || (state.packages && state.packages.length));
      let incremental = !!(sync && sync.fullAt && sync.perTable && haveCache &&
        (Date.now() - new Date(sync.fullAt).getTime() < STALE_MS));
      console.log('[si-cloud] ' + (incremental ? 'incremental' : 'full') + ' pull…');

      let cloud = await withTimeout(pullAll(incremental ? sync : null), 25000, 'cloud pull');
      if (!cloud.__ok && incremental) {            // incremental hiccup → one full retry
        console.warn('[si-cloud] incremental failed — full pull');
        incremental = false;
        cloud = await withTimeout(pullAll(null), 25000, 'cloud pull');
      }
      if (!cloud.__ok) {
        cloudReady = false;
        console.warn('[si-cloud] cloud pull returned no successful tables — local only');
        if (typeof toast === 'function') toast('Cloud unreachable — showing local data only', 'warning');
        return;
      }

      mergeIntoState(cloud);
      lastSnapshot = snapshotState();
      cloudReady = true;
      hookSave();

      // Only a FULL pull reconciles local-only rows upward (cheap diff, usually
      // nothing). Incremental skips the upload entirely; edits sync via save().
      if (!incremental) {
        try { await withTimeout(pushLocalOnly(cloud), 20000, 'initial push'); } catch (e) { console.warn('[si-cloud]', e.message); }
        lastSnapshot = snapshotState();
      }

      // Cache merged data + advance the watermark so the next load is incremental.
      persistLocal();
      saveSync({ perTable: computeWatermarks(), fullAt: (incremental && sync) ? sync.fullAt : new Date().toISOString() });

      const _vcount = (state.vehicles || []).length;
      if (typeof navigate === 'function' && state.ui?.currentView) navigate(state.ui.currentView);
      if (typeof toast === 'function') toast('\u2601 Cloud ' + (incremental ? 'updated' : 'synced') + ': ' + _vcount + ' vehicles');
      if (typeof refreshStorageInfo === 'function') refreshStorageInfo();
      if (typeof refreshBell === 'function') refreshBell();

      subscribeAll();
      console.log('[si-cloud] ready — sync ON (' + (incremental ? 'incremental' : 'full') + ')');
    } catch (e) {
      cloudReady = false;
      console.error('[si-cloud] boot failed:', e);
      if (typeof toast === 'function') toast('Cloud sync offline — local only', 'warning');
    }
  }

  // Manual full re-pull (e.g. after edits made on another device while this was closed).
  window.siCloudRefresh = async function () {
    if (!sb) { if (typeof toast === 'function') toast('Cloud not ready yet', 'warning'); return; }
    try { localStorage.removeItem(SYNC_KEY); } catch (e) {}
    if (typeof toast === 'function') toast('Refreshing from cloud\u2026');
    try {
      const cloud = await withTimeout(pullAll(null), 25000, 'refresh');
      if (!cloud.__ok) { if (typeof toast === 'function') toast('Refresh failed — cloud unreachable', 'warning'); return; }
      mergeIntoState(cloud); lastSnapshot = snapshotState();
      persistLocal(); saveSync({ perTable: computeWatermarks(), fullAt: new Date().toISOString() });
      if (typeof navigate === 'function' && state.ui?.currentView) navigate(state.ui.currentView);
      if (typeof toast === 'function') toast('\u2601 Full refresh: ' + (state.vehicles || []).length + ' vehicles', 'success');
    } catch (e) { if (typeof toast === 'function') toast('Refresh failed: ' + e.message, 'warning'); }
  };

  // Run after DOM + page script have done their thing
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(boot, 100);
  } else {
    window.addEventListener('DOMContentLoaded', () => setTimeout(boot, 100));
  }
})();
