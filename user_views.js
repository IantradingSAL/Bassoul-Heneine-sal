// user_views.js — shared per-user saved-filter-views control,
// rendered as a horizontal row of chips. Each chip is a saved view;
// the active one is highlighted. "＋ Save view" stores the current
// filters as a new view; ⭐ makes a view the one that opens by default.
//
// Rows live in public.user_views (RLS: owner-only, user_id defaults to
// auth.uid()), so every user keeps their own views on every device.
// One page can mount several rows — one per independent list — by
// giving each a different `page` key (e.g. 'warranty:gcm').
//
// Example:
//   import { mountSavedViews } from './user_views.js?v=20261103a'
//   mountSavedViews({
//     sb, page: 'customer_feedback',
//     mountEl:     document.getElementById('savedViewsMount'),
//     filterIds:   ['typeFilter','statusFilter','assignedFilter','searchInput'],
//     applyFilter: () => applyFilter(),
//     ntf:         (m, t) => ntf(m, t),
//     currentUser,
//   })
//
// Mount it AFTER the first data load when a filter is a dropdown filled
// from the data — a view restoring `month = 2026-09` needs that option
// to exist already. Only list filters go in filterIds, never the fields
// of an entry form.

let _cssInjected = false
function _injectCssOnce() {
  if (_cssInjected) return
  _cssInjected = true
  const css = `
  .sv-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:6px 0}
  .sv-lbl{font-size:10px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:var(--mu,#64748b);margin-right:2px}
  .sv-chip{position:relative;display:inline-flex;align-items:center;gap:6px;padding:5px 11px;border:1.5px solid var(--bdr,#e2e8f0);border-radius:999px;background:var(--card,#fff);color:var(--mu,#64748b);font-family:inherit;font-size:11px;font-weight:600;cursor:pointer;transition:all .12s;line-height:1.4;white-space:nowrap;user-select:none}
  .sv-chip:hover{border-color:var(--blue,#3b5fe2);color:var(--blue,#3b5fe2);background:var(--b50,#eef2ff)}
  .sv-chip.active{background:var(--blue,#3b5fe2);border-color:var(--blue,#3b5fe2);color:#fff}
  .sv-chip.active:hover{background:#2e4fc7;border-color:#2e4fc7;color:#fff}
  .sv-chip.unsaved::after{content:'•';color:var(--red,#dc2626);font-size:14px;line-height:1;margin-left:2px}
  .sv-chip.active.unsaved::after{color:#fff}
  .sv-star{font-size:10px}
  .sv-chip-actions{display:none;margin-left:2px;gap:2px}
  .sv-chip:hover .sv-chip-actions,.sv-chip:focus-within .sv-chip-actions{display:inline-flex}
  .sv-act{border:none;background:transparent;padding:1px 3px;border-radius:4px;cursor:pointer;color:inherit;font-size:11px;opacity:.8}
  .sv-act:hover{background:rgba(255,255,255,.25);opacity:1}
  .sv-chip:not(.active) .sv-act:hover{background:rgba(59,95,226,.12)}
  .sv-chip.add{border-style:dashed;color:var(--mu,#64748b);background:transparent;font-weight:700}
  .sv-chip.add:hover{border-style:solid;color:var(--blue,#3b5fe2);background:var(--b50,#eef2ff)}
  `
  const tag = document.createElement('style')
  tag.textContent = css
  document.head.appendChild(tag)
}

function _esc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function _readEl(el) {
  if (!el) return ''
  if (el.type === 'checkbox' || el.type === 'radio') return el.checked ? '1' : ''
  if (el.tagName === 'SELECT' && el.multiple) return Array.from(el.selectedOptions).map(o => o.value).join('\u001f')
  return el.value
}
function _writeEl(el, v) {
  if (!el) return
  v = v == null ? '' : String(v)
  if (el.type === 'checkbox' || el.type === 'radio') { el.checked = v === '1' || v === 'true'; return }
  if (el.tagName === 'SELECT' && el.multiple) {
    const want = new Set(v ? v.split('\u001f') : [])
    Array.from(el.options).forEach(o => { o.selected = want.has(o.value) })
    return
  }
  if (el.tagName === 'SELECT' && v && !Array.from(el.options).some(o => o.value === v)) {
    // The option is not there (yet) — add it so the view still restores.
    const o = document.createElement('option'); o.value = v; o.textContent = v
    el.appendChild(o)
  }
  el.value = v
}

export async function mountSavedViews(opts) {
  const { sb, page, mountEl, filterIds, applyFilter, currentUser } = opts
  if (!sb || !page || !mountEl || !filterIds || !applyFilter) {
    console.warn('[user_views] missing required option'); return
  }
  const ntf = typeof opts.ntf === 'function' ? opts.ntf : ((m) => { try { console.info('[user_views]', m) } catch {} })
  const label = opts.label === undefined ? 'Views' : opts.label
  const currentViewKey = `cw_sv_current_${page}_${currentUser || 'anon'}`
  const legacyKey      = `cw_fb_views_${currentUser || 'anon'}`  // pre-module localStorage (customer_feedback only)
  let currentViewId    = ''
  try { currentViewId = localStorage.getItem(currentViewKey) || '' } catch {}
  let cache            = []
  let hasDefaultCol    = true

  _injectCssOnce()

  mountEl.innerHTML = `<div class="sv-chips"></div>`
  const row = mountEl.querySelector('.sv-chips')

  function remember(id) { try { localStorage.setItem(currentViewKey, id) } catch {} }

  function readFilters() {
    const out = {}
    for (const id of filterIds) out[id] = _readEl(document.getElementById(id))
    return out
  }
  function writeFilters(f) {
    f = f || {}
    for (const id of filterIds) _writeEl(document.getElementById(id), f[id])
    try { applyFilter() } catch (e) { console.warn('[user_views] applyFilter failed', e) }
  }
  function filtersEqual(a, b) {
    return filterIds.every(k => String(a?.[k] ?? '') === String(b?.[k] ?? ''))
  }

  async function loadFromDB() {
    let res = await sb.from('user_views')
      .select('id, name, filters, is_default')
      .eq('page', page)
      .order('created_at', { ascending: true })
    if (res.error && /is_default/.test(res.error.message || '')) {
      hasDefaultCol = false
      res = await sb.from('user_views').select('id, name, filters').eq('page', page).order('created_at', { ascending: true })
    }
    if (res.error) { console.warn('[user_views] load failed:', res.error.message); return }
    cache = (res.data || []).map(r => ({ id: r.id, name: r.name, filters: r.filters || {}, is_default: !!r.is_default }))
  }

  async function migrateLegacy() {
    if (page !== 'customer_feedback') return
    let legacy
    try { legacy = JSON.parse(localStorage.getItem(legacyKey) || '[]') } catch { legacy = [] }
    if (!Array.isArray(legacy) || !legacy.length) return
    if (cache.length) { try { localStorage.removeItem(legacyKey) } catch {} ; return }
    const rows = legacy.map(v => ({ page, name: v.name || 'Untitled view', filters: v.filters || {} }))
    const { error } = await sb.from('user_views').insert(rows)
    if (error) { console.warn('[user_views] legacy migration failed:', error.message); return }
    try { localStorage.removeItem(legacyKey) } catch {}
    await loadFromDB()
  }

  function render() {
    const active = cache.find(v => v.id === currentViewId)
    const unsaved = active ? !filtersEqual(readFilters(), active.filters) : false

    let html = label ? `<span class="sv-lbl">${_esc(label)}</span>` : ''
    html += `<span role="button" tabindex="0" class="sv-chip viewer-ok ${!active ? 'active' : ''}" data-action="apply" data-id="" title="No saved filters — show everything">All</span>`
    for (const v of cache) {
      const isOn = v.id === currentViewId
      html += `<span role="button" tabindex="0" class="sv-chip viewer-ok ${isOn ? 'active' : ''} ${isOn && unsaved ? 'unsaved' : ''}" data-action="apply" data-id="${v.id}" title="${v.is_default ? 'Opens by default' : 'Apply this view'}">
        ${v.is_default ? '<span class="sv-star">⭐</span>' : ''}<span>${_esc(v.name)}</span>
        <span class="sv-chip-actions">
          ${isOn && unsaved ? `<button type="button" class="sv-act viewer-ok" data-action="update" data-id="${v.id}" title="Save the current filters into this view">💾</button>` : ''}
          ${hasDefaultCol ? `<button type="button" class="sv-act viewer-ok" data-action="default" data-id="${v.id}" title="${v.is_default ? 'Stop opening this view by default' : 'Open this view by default'}">${v.is_default ? '☆' : '⭐'}</button>` : ''}
          <button type="button" class="sv-act viewer-ok" data-action="rename" data-id="${v.id}" title="Rename">✏️</button>
          <button type="button" class="sv-act viewer-ok" data-action="delete" data-id="${v.id}" title="Delete">🗑️</button>
        </span>
      </span>`
    }
    html += `<span role="button" tabindex="0" class="sv-chip add viewer-ok" data-action="save-new" title="Save the current filters as a new view">＋ Save view</span>`
    row.innerHTML = html
  }

  function apply(id) {
    currentViewId = id
    remember(id)
    if (!id) writeFilters({})
    else {
      const v = cache.find(x => x.id === id)
      if (v) writeFilters(v.filters)
    }
    render()
  }

  async function saveCurrentAsNew() {
    const name = prompt('Name for this view:')
    if (!name || !name.trim()) return
    const { data, error } = await sb.from('user_views')
      .insert({ page, name: name.trim(), filters: readFilters() })
      .select('id, name, filters').single()
    if (error) { ntf('Save failed: ' + error.message, 'err'); return }
    cache.push({ id: data.id, name: data.name, filters: data.filters || {}, is_default: false })
    currentViewId = data.id
    remember(data.id)
    render()
    ntf(`View "${data.name}" saved`, 'ok')
  }

  async function updateView(id) {
    const v = cache.find(x => x.id === id); if (!v) return
    const filters = readFilters()
    const { error } = await sb.from('user_views').update({ filters, updated_at: new Date().toISOString() }).eq('id', id)
    if (error) { ntf('Update failed: ' + error.message, 'err'); return }
    v.filters = filters
    render()
    ntf(`View "${v.name}" updated`, 'ok')
  }

  async function toggleDefault(id) {
    const v = cache.find(x => x.id === id); if (!v) return
    const makeDefault = !v.is_default
    if (makeDefault) {
      const { error: e1 } = await sb.from('user_views').update({ is_default: false }).eq('page', page).eq('is_default', true)
      if (e1) { ntf('Update failed: ' + e1.message, 'err'); return }
    }
    const { error } = await sb.from('user_views').update({ is_default: makeDefault }).eq('id', id)
    if (error) { ntf('Update failed: ' + error.message, 'err'); return }
    cache.forEach(x => { x.is_default = makeDefault && x.id === id })
    render()
    ntf(makeDefault ? `"${v.name}" now opens by default` : 'Default view cleared', 'ok')
  }

  async function renameView(id) {
    const v = cache.find(x => x.id === id); if (!v) return
    const newName = prompt('Rename view:', v.name)
    if (!newName || !newName.trim() || newName.trim() === v.name) return
    const { error } = await sb.from('user_views').update({ name: newName.trim() }).eq('id', id)
    if (error) { ntf('Rename failed: ' + error.message, 'err'); return }
    v.name = newName.trim()
    render()
  }

  async function deleteView(id) {
    const v = cache.find(x => x.id === id); if (!v) return
    if (!confirm(`Delete view "${v.name}"?`)) return
    const { error } = await sb.from('user_views').delete().eq('id', id)
    if (error) { ntf('Delete failed: ' + error.message, 'err'); return }
    cache = cache.filter(x => x.id !== id)
    if (currentViewId === id) { currentViewId = ''; remember('') }
    render()
  }

  function onAction(e) {
    const el = e.target.closest('[data-action]')
    if (!el || !row.contains(el)) return
    e.preventDefault()
    e.stopPropagation()
    const action = el.dataset.action
    const id     = el.dataset.id || ''
    if      (action === 'apply')    apply(id)
    else if (action === 'update')   updateView(id)
    else if (action === 'default')  toggleDefault(id)
    else if (action === 'rename')   renameView(id)
    else if (action === 'delete')   deleteView(id)
    else if (action === 'save-new') saveCurrentAsNew()
  }
  row.addEventListener('click', onAction)
  row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') onAction(e) })

  // Keep the "unsaved •" marker in sync when any filter changes
  for (const id of filterIds) {
    const el = document.getElementById(id); if (!el) continue
    el.addEventListener('change', render)
    el.addEventListener('input',  render)
  }

  // Initial: render placeholder, then fetch, migrate, restore, re-render.
  // Restore order: the view last used on this device, else the user's
  // ⭐ default view, else nothing (the page's own defaults stand).
  // opts.restore === false renders the chips without touching the filters
  // (e.g. when a deep link already set them).
  render()
  await loadFromDB()
  await migrateLegacy()
  let start = currentViewId ? cache.find(v => v.id === currentViewId) : null
  if (!start) {
    if (currentViewId) { currentViewId = ''; remember('') }
    start = cache.find(v => v.is_default) || null
    if (start) currentViewId = start.id
  }
  if (opts.restore === false) { currentViewId = ''; start = null }
  if (start) writeFilters(start.filters)
  render()

  return {
    refresh: async () => { await loadFromDB(); render() },
    current: () => cache.find(v => v.id === currentViewId) || null,
  }
}
