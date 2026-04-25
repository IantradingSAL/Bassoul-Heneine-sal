// user_views.js — shared per-user saved-filter-views control,
// rendered as a horizontal row of chip buttons. Each chip is a
// saved view; the active one is highlighted. A trailing "+"
// chip saves the current filters as a new view.
//
// Rows live in public.user_views (RLS: owner-only). Each page
// calls mountSavedViews(config) once, after its filter inputs
// and mount container exist in the DOM.
//
// Example:
//   import { mountSavedViews } from './user_views.js'
//   mountSavedViews({
//     sb, page: 'customer_feedback',
//     mountEl:     document.getElementById('savedViewsMount'),
//     filterIds:   ['typeFilter','statusFilter','assignedFilter','searchInput'],
//     applyFilter: () => applyFilter(),
//     ntf:         (m, t) => ntf(m, t),
//     currentUser,
//   })

let _cssInjected = false
function _injectCssOnce() {
  if (_cssInjected) return
  _cssInjected = true
  const css = `
  .sv-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:6px 0}
  .sv-chip{position:relative;display:inline-flex;align-items:center;gap:6px;padding:5px 11px;border:1.5px solid var(--bdr);border-radius:999px;background:var(--card);color:var(--mu);font-family:var(--f);font-size:11px;font-weight:600;cursor:pointer;transition:all .12s;line-height:1.4;white-space:nowrap}
  .sv-chip:hover{border-color:var(--blue,#3b5fe2);color:var(--blue,#3b5fe2);background:var(--b50,#eef2ff)}
  .sv-chip.active{background:var(--blue,#3b5fe2);border-color:var(--blue,#3b5fe2);color:#fff}
  .sv-chip.active:hover{background:#2e4fc7;border-color:#2e4fc7;color:#fff}
  .sv-chip.unsaved::after{content:'•';color:var(--red,#dc2626);font-size:14px;line-height:1;margin-left:2px}
  .sv-chip.active.unsaved::after{color:#fff}
  .sv-chip-actions{display:none;margin-left:2px;gap:2px}
  .sv-chip:hover .sv-chip-actions{display:inline-flex}
  .sv-act{border:none;background:transparent;padding:1px 3px;border-radius:4px;cursor:pointer;color:inherit;font-size:11px;opacity:.8}
  .sv-act:hover{background:rgba(255,255,255,.25);opacity:1}
  .sv-chip:not(.active) .sv-act:hover{background:rgba(59,95,226,.12)}
  .sv-chip.add{border-style:dashed;color:var(--mu);background:transparent;font-weight:700}
  .sv-chip.add:hover{border-style:solid;color:var(--blue,#3b5fe2);background:var(--b50,#eef2ff)}
  `
  const tag = document.createElement('style')
  tag.textContent = css
  document.head.appendChild(tag)
}

function _esc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

export async function mountSavedViews(opts) {
  const { sb, page, mountEl, filterIds, applyFilter, currentUser } = opts
  if (!sb || !page || !mountEl || !filterIds || !applyFilter) {
    console.warn('[user_views] missing required option'); return
  }
  const ntf = typeof opts.ntf === 'function' ? opts.ntf : (() => {})
  const currentViewKey = `cw_sv_current_${page}_${currentUser || 'anon'}`
  const legacyKey      = `cw_fb_views_${currentUser || 'anon'}`  // pre-module localStorage (customer_feedback only)
  let currentViewId    = localStorage.getItem(currentViewKey) || ''
  let cache            = []

  _injectCssOnce()

  mountEl.innerHTML = `<div class="sv-chips"></div>`
  const row = mountEl.querySelector('.sv-chips')

  function readFilters() {
    const out = {}
    for (const id of filterIds) {
      const el = document.getElementById(id)
      out[id] = el ? el.value : ''
    }
    return out
  }
  function writeFilters(f) {
    f = f || {}
    for (const id of filterIds) {
      const el = document.getElementById(id)
      if (el) el.value = f[id] || ''
    }
    applyFilter()
  }
  function filtersEqual(a, b) {
    return filterIds.every(k => (a?.[k] || '') === (b?.[k] || ''))
  }

  async function loadFromDB() {
    const { data, error } = await sb.from('user_views')
      .select('id, name, filters')
      .eq('page', page)
      .order('created_at', { ascending: true })
    if (error) { console.warn('[user_views] load failed:', error.message); return }
    cache = (data || []).map(r => ({ id: r.id, name: r.name, filters: r.filters || {} }))
  }

  async function migrateLegacy() {
    // Only the customer_feedback page ever used the old localStorage key.
    if (page !== 'customer_feedback') return
    let legacy
    try { legacy = JSON.parse(localStorage.getItem(legacyKey) || '[]') } catch { legacy = [] }
    if (!Array.isArray(legacy) || !legacy.length) return
    if (cache.length) { localStorage.removeItem(legacyKey); return }
    const rows = legacy.map(v => ({ page, name: v.name || 'Untitled view', filters: v.filters || {} }))
    const { error } = await sb.from('user_views').insert(rows)
    if (error) { console.warn('[user_views] legacy migration failed:', error.message); return }
    localStorage.removeItem(legacyKey)
    await loadFromDB()
    if (currentViewId && !cache.some(v => v.id === currentViewId)) {
      currentViewId = ''; localStorage.setItem(currentViewKey, '')
    }
  }

  function render() {
    const active = cache.find(v => v.id === currentViewId)
    const unsaved = active ? !filtersEqual(readFilters(), active.filters) : false

    let html = ''
    const isDefault = !active
    html += `<button type="button" class="sv-chip sv-default ${isDefault ? 'active' : ''}" data-action="apply" data-id="">Default</button>`
    for (const v of cache) {
      const isOn = v.id === currentViewId
      html += `<button type="button" class="sv-chip ${isOn ? 'active' : ''} ${isOn && unsaved ? 'unsaved' : ''}" data-action="apply" data-id="${v.id}">
        <span>${_esc(v.name)}</span>
        <span class="sv-chip-actions">
          <button type="button" class="sv-act" data-action="rename" data-id="${v.id}" title="Rename">✏️</button>
          <button type="button" class="sv-act" data-action="delete" data-id="${v.id}" title="Delete">🗑️</button>
        </span>
      </button>`
    }
    html += `<button type="button" class="sv-chip add" data-action="save-new" title="Save current filters as a new view">＋ Save current</button>`
    row.innerHTML = html
  }

  async function apply(id) {
    currentViewId = id
    localStorage.setItem(currentViewKey, id)
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
    cache.push({ id: data.id, name: data.name, filters: data.filters || {} })
    currentViewId = data.id
    localStorage.setItem(currentViewKey, data.id)
    render()
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
    if (currentViewId === id) { currentViewId = ''; localStorage.setItem(currentViewKey, '') }
    render()
  }

  // Delegated click handler for the whole chip row
  row.addEventListener('click', e => {
    const el = e.target.closest('[data-action]')
    if (!el) return
    e.stopPropagation()
    const action = el.dataset.action
    const id     = el.dataset.id || ''
    if      (action === 'apply')    apply(id)
    else if (action === 'rename')   renameView(id)
    else if (action === 'delete')   deleteView(id)
    else if (action === 'save-new') saveCurrentAsNew()
  })

  // Keep the "unsaved •" marker in sync when any filter changes
  for (const id of filterIds) {
    const el = document.getElementById(id); if (!el) continue
    el.addEventListener('change', render)
    el.addEventListener('input',  render)
  }

  // Initial: render placeholder, then fetch, migrate, restore, re-render
  render()
  await loadFromDB()
  await migrateLegacy()
  if (currentViewId) {
    const v = cache.find(x => x.id === currentViewId)
    if (v) writeFilters(v.filters)
    else { currentViewId = ''; localStorage.setItem(currentViewKey, '') }
  }
  render()

  return { refresh: async () => { await loadFromDB(); render() } }
}
