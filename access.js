// access.js — page-level access control.
// Loaded as a regular script (NOT a module) by every authenticated
// page so it can run before any page-specific code.
//
// What it does:
//   1. Resolves the current user's "effective permission" for the
//      page (identified by <meta name="cw-page" content="...">).
//      Levels: 'none' | 'view' | 'edit'.
//   2. If 'none'  → shows a "no access" notice and a back-to-dashboard link.
//   3. If 'view'  → disables every editor control on the page,
//                   hides anything tagged class="editor-only".
//   4. If 'edit'  → leaves the page alone (default behaviour).
//
// The lookup uses the public.effective_page_permission(uid, page)
// SQL function so the rule is the same client- and server-side.
// THIS IS UX ENFORCEMENT, NOT SECURITY. Real security comes from
// Supabase Row Level Security on the tables.

(function () {
  // ─── 0. Surface the user name for legacy code ────────────────
  try {
    var name = sessionStorage.getItem('cw_current_emp')
            || localStorage.getItem('cw_current_emp')
            || ''
    window.CW_USER = name
  } catch (e) {}

  // Defensive: kill stale help button injected by older builds
  function killHelp () {
    var b = document.getElementById('cw-help-btn');  if (b) b.remove()
    var r = document.getElementById('cw-help-root'); if (r) r.remove()
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', killHelp)
  } else {
    killHelp()
  }

  // ─── 1. Identify which page we're on ─────────────────────────
  function currentPageId () {
    var m = document.querySelector('meta[name="cw-page"]')
    if (m && m.content) return m.content
    // Fallback: derive from filename, e.g. "settings.html" → "settings"
    var f = (location.pathname.split('/').pop() || '').replace(/\.html?$/i, '')
    if (!f || f === 'index') return 'dashboard'
    return f
  }

  // ─── 2. Resolve user's permission level via the RPC ──────────
  // window.__SUPA__ is set by config.js (a small bridge so this
  // classic script can read the ESM module's exports). If it's not
  // set we fail open — preserving legacy behaviour.
  async function fetchPermissionLevel (page) {
    var url, anon
    try {
      if (window.__SUPA__) { url = window.__SUPA__.url; anon = window.__SUPA__.anonKey }
    } catch (e) {}
    if (!url) return 'edit'

    // Find the auth token (sb-<ref>-auth-token).
    var ref = new URL(url).hostname.split('.')[0]
    var raw = localStorage.getItem('sb-' + ref + '-auth-token')
    if (!raw) return 'none'
    var jwt
    try { jwt = JSON.parse(raw).access_token } catch (e) { return 'none' }
    if (!jwt) return 'none'

    // Decode user id from the JWT (middle segment, base64url).
    var uid
    try {
      var p = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
      var pad = p.length % 4; if (pad) p += '='.repeat(4 - pad)
      uid = JSON.parse(atob(p)).sub
    } catch (e) { return 'none' }

    // Call the RPC.
    try {
      var r = await fetch(url + '/rest/v1/rpc/effective_page_permission', {
        method:  'POST',
        headers: {
          'apikey':        anon,
          'authorization': 'Bearer ' + jwt,
          'content-type':  'application/json'
        },
        body: JSON.stringify({ p_uid: uid, p_page: page })
      })
      if (!r.ok) return 'edit'
      var lvl = await r.json()
      if (lvl === 'edit' || lvl === 'view' || lvl === 'none') return lvl
      return 'edit'
    } catch (e) {
      return 'edit'
    }
  }

  // ─── 3. Apply view-only mode ─────────────────────────────────
  function applyViewOnly (root) {
    root = root || document
    root.querySelectorAll('input, textarea, select, button').forEach(function (el) {
      if (el.classList.contains('viewer-ok')) return
      if (el.id === 'signOutBtn')             return
      if (el.id === 'menuBtn')                return
      // Filter / search controls stay enabled (they're not edits).
      var isFilter = el.id && /Filter|search|view$|searchInput/i.test(el.id)
      if (isFilter && el.tagName !== 'BUTTON') return
      try { el.disabled = true } catch (e) {}
      el.setAttribute('aria-disabled', 'true')
    })
    root.querySelectorAll('.editor-only').forEach(function (el) {
      el.style.display = 'none'
    })
    if (!document.getElementById('cw-viewonly-banner')) {
      var b = document.createElement('div')
      b.id = 'cw-viewonly-banner'
      b.textContent = '👁  View-only — your role does not have edit access on this page.'
      b.style.cssText = 'background:#fffbeb;border-bottom:1px solid #fde68a;color:#92400e;font-size:12px;font-weight:600;text-align:center;padding:6px 12px;font-family:var(--f,DM Sans,sans-serif);position:sticky;top:0;z-index:120'
      document.body.insertBefore(b, document.body.firstChild)
    }
  }

  function blockNoAccess (page) {
    document.body.innerHTML =
      '<div style="font-family:DM Sans,sans-serif;max-width:480px;margin:80px auto;padding:32px;text-align:center;background:#fff;border-radius:18px;box-shadow:0 6px 24px rgba(0,0,0,.09)">' +
        '<div style="font-size:54px;margin-bottom:8px">🚫</div>' +
        '<div style="font-size:20px;font-weight:800;margin-bottom:6px">No access</div>' +
        '<div style="font-size:13px;color:#64748b;margin-bottom:20px">Your role does not allow you to view <strong>' + page.replace(/_/g, ' ') + '</strong>. Ask a manager to grant access.</div>' +
        '<a href="index.html" style="display:inline-block;background:#3b5fe2;color:#fff;padding:11px 20px;border-radius:10px;font-weight:700;text-decoration:none;font-size:13px">← Back to dashboard</a>' +
      '</div>'
  }

  // ─── Auto-register the page if missing ───────────────────────
  // This makes Settings → Roles & Access "self-discovering": just
  // create a new HTML file with <meta name="cw-page" content="…">,
  // visit it once, and it appears in the role matrix automatically.
  // Errors are swallowed — never blocks page load.
  async function registerPage (page) {
    var url, anon
    try { if (window.__SUPA__) { url = window.__SUPA__.url; anon = window.__SUPA__.anonKey } } catch (e) {}
    if (!url) return
    var ref = new URL(url).hostname.split('.')[0]
    var raw = localStorage.getItem('sb-' + ref + '-auth-token')
    if (!raw) return
    var jwt; try { jwt = JSON.parse(raw).access_token } catch (e) { return }
    if (!jwt) return
    // Derive a friendly default label from the page id ("warranty_claims" → "Warranty Claims")
    var defaultLabel = page.replace(/_/g, ' ').replace(/\b\w/g, function(c){ return c.toUpperCase() })
    try {
      await fetch(url + '/rest/v1/rpc/register_page_if_missing', {
        method:  'POST',
        headers: {
          'apikey':        anon,
          'authorization': 'Bearer ' + jwt,
          'content-type':  'application/json'
        },
        body: JSON.stringify({ p_id: page, p_label: defaultLabel })
      })
    } catch (e) { /* swallow */ }
  }

  // ─── 4. Run after parse ──────────────────────────────────────
  async function run () {
    var page = currentPageId()
    // Give config.js (a module) a moment to set window.__SUPA__.
    await new Promise(function (r) { setTimeout(r, 50) })
    // Fire-and-forget auto-registration on every page (incl. dashboard)
    registerPage(page)
    if (page === 'dashboard') return    // dashboard is always reachable
    var level = await fetchPermissionLevel(page)
    window.CW_PERMISSION = level
    if (level === 'none') { blockNoAccess(page); return }
    if (level === 'view') {
      setTimeout(applyViewOnly, 700)            // give page JS time to render
      document.addEventListener('click', function () {
        setTimeout(applyViewOnly, 60)            // re-disable after modals open
      }, { capture: true })
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run)
  } else {
    run()
  }
})()
