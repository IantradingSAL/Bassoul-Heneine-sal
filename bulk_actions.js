// bulk_actions.js — shared UI + action runner for register pages.
//
// Each register (customer_feedback, non_conformity, internal_audit)
// has the same interaction:
//   1. a checkbox in every row (class="bulk-cb", value="<id>")
//   2. a tri-state "select all" in the header
//   3. an action bar that appears when ≥1 row is ticked
//   4. buttons that run the chosen action across the selected ids
//
// Before this module, each page had ~80 lines of near-identical
// wiring. They now call mountBulkActions(config) once and declare
// the actions that make sense for their table.
//
// Example:
//   import { mountBulkActions } from './bulk_actions.js'
//   mountBulkActions({
//     table: 'customer_feedback',
//     sb,
//     ntf,                        // optional — for toasts
//     mountEl: document.getElementById('bulkBarMount'),
//     headerCb: document.getElementById('bulkAllCb'),
//     tableBody: document.getElementById('tBody'),
//     onComplete: () => load(),   // called after each action
//     actions: [
//       { label:'✅ Mark resolved', confirm: n => `Mark ${n} records as resolved?`,
//         patch: { status:'resolved', resolved_at: () => new Date().toISOString() } },
//       { label:'👤 Reassign…',      reassign: () => ({
//             options: [...document.getElementById('fAssigned').options]
//                        .map(o => ({ v: o.value, t: o.text })),
//             column: 'assigned_to',
//         }) },
//       { label:'🗑️ Delete',          danger: true,
//         confirm: n => `Delete ${n} records permanently?`, delete: true },
//     ],
//   })

function _esc(s) { return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])) }

let _cssInjected = false
function _injectCssOnce() {
  if (_cssInjected) return
  _cssInjected = true
  const css = `
  .ba-bar{display:none;align-items:center;gap:10px;padding:10px 14px;margin-bottom:10px;background:var(--b50,#eef2ff);border:1px solid var(--b100,#e0e7ff);border-radius:10px;font-size:13px;font-family:var(--f,"DM Sans",sans-serif)}
  .ba-bar.on{display:flex}
  .ba-count{font-weight:700;color:var(--blue,#3b5fe2)}
  .ba-spacer{flex:1}
  .ba-btn{padding:5px 12px;font-size:12px;font-weight:600;border:1px solid var(--bdr,#e2e8f0);background:var(--card,#fff);color:var(--mu,#64748b);border-radius:7px;cursor:pointer;font-family:inherit;transition:all .12s}
  .ba-btn:hover{color:var(--txt,#0f172a);border-color:var(--blue,#3b5fe2)}
  .ba-btn.danger{color:var(--red,#dc2626)}
  .ba-btn.danger:hover{background:var(--r50,#fef2f2);border-color:var(--red,#dc2626)}
  .ba-btn:disabled{opacity:.5;cursor:not-allowed}
  `
  const tag = document.createElement('style'); tag.textContent = css; document.head.appendChild(tag)
}

export function mountBulkActions(opts) {
  const { table, sb, mountEl, headerCb, tableBody, onComplete, actions } = opts
  if (!table || !sb || !mountEl || !actions || !actions.length) {
    console.warn('[bulk_actions] missing required option'); return
  }
  const ntf = typeof opts.ntf === 'function' ? opts.ntf : (m, t) => (t === 'err' ? console.warn(m) : console.log(m))
  const idColumn = opts.idColumn || 'id'

  _injectCssOnce()

  // Render the action bar.
  mountEl.innerHTML = `
    <div class="ba-bar" role="toolbar" aria-label="Bulk actions">
      <span class="ba-count">0 selected</span>
      <span class="ba-spacer"></span>
      ${actions.map((a, i) => `<button type="button" class="ba-btn ${a.danger?'danger':''}" data-i="${i}">${_esc(a.label)}</button>`).join('')}
      <button type="button" class="ba-btn" data-clear="1">✕ Clear</button>
    </div>
  `
  const bar     = mountEl.querySelector('.ba-bar')
  const countEl = mountEl.querySelector('.ba-count')

  function selectedIds() {
    return [...(tableBody || document).querySelectorAll('.bulk-cb:checked')].map(cb => cb.value)
  }
  function clearSelection() {
    ;(tableBody || document).querySelectorAll('.bulk-cb:checked').forEach(cb => cb.checked = false)
    if (headerCb) { headerCb.checked = false; headerCb.indeterminate = false }
    refresh()
  }
  function refresh() {
    const ids = selectedIds()
    countEl.textContent = `${ids.length} selected`
    bar.classList.toggle('on', ids.length > 0)
    if (headerCb) {
      const all = (tableBody || document).querySelectorAll('.bulk-cb')
      headerCb.checked = all.length && ids.length === all.length
      headerCb.indeterminate = ids.length > 0 && ids.length < all.length
    }
  }

  async function run(idx) {
    const a = actions[idx]; if (!a) return
    const ids = selectedIds(); if (!ids.length) return

    // Reassign flow: ask user to pick a new target from a list.
    let reassignChoice = null
    let reassignCfg    = null
    if (typeof a.reassign === 'function') {
      const cfg = a.reassign() || {}
      reassignCfg = cfg
      const options = cfg.options || []
      if (!options.length) { ntf('No targets available.', 'err'); return }
      const menu = options.map((o, i) => `${i}: ${o.t || '—'}`).join('\n')
      const pick = prompt(`Reassign ${ids.length} record${ids.length===1?'':'s'} to:\n\n${menu}\n\nEnter the number:`)
      if (pick == null) return
      const oi = parseInt(pick, 10)
      if (!Number.isFinite(oi) || oi < 0 || oi >= options.length) { ntf('Not a valid choice', 'err'); return }
      reassignChoice = { column: cfg.column || 'assigned_to', value: options[oi].v || null, label: options[oi].t || '' }
    }

    // Confirm dialog — skippable by setting confirm: false.
    if (a.confirm !== false) {
      const msg = typeof a.confirm === 'function' ? a.confirm(ids.length)
                : typeof a.confirm === 'string'   ? a.confirm
                : a.delete                          ? `Delete ${ids.length} record${ids.length===1?'':'s'} permanently? This cannot be undone.`
                :                                    `Apply "${a.label}" to ${ids.length} record${ids.length===1?'':'s'}?`
      if (!confirm(msg)) return
    }

    // Build the patch.
    let result
    if (a.delete) {
      result = await sb.from(table).delete().in(idColumn, ids)
    } else if (reassignChoice) {
      const patch = { [reassignChoice.column]: reassignChoice.value }
      result = await sb.from(table).update(patch).in(idColumn, ids)
    } else if (a.patch) {
      const raw = typeof a.patch === 'function' ? a.patch(ids) : a.patch
      if (!raw) return  // handler cancelled (null / undefined)
      const patch = {}
      for (const [k, v] of Object.entries(raw)) {
        patch[k] = typeof v === 'function' ? v() : v
      }
      result = await sb.from(table).update(patch).in(idColumn, ids)
    } else {
      console.warn('[bulk_actions] action has neither .delete, .patch nor .reassign'); return
    }

    if (result.error) { ntf('Bulk action failed: ' + result.error.message, 'err'); return }
    const verb = a.delete ? 'deleted' : reassignChoice ? `reassigned to ${reassignChoice.label}` : (a.pastTense || 'updated')
    ntf(`${ids.length} record${ids.length===1?'':'s'} ${verb}`, 'ok')
    // Optional afterValue hook — reassign flows use this to fire
    // post-update side effects (notification emails / WhatsApp).
    if (reassignChoice && reassignCfg && typeof reassignCfg.afterValue === 'function') {
      try { await reassignCfg.afterValue(reassignChoice.value, ids) } catch (e) { console.warn('[bulk_actions] afterValue threw:', e) }
    }
    clearSelection()
    if (typeof onComplete === 'function') await onComplete()
  }

  // Wire events
  bar.addEventListener('click', e => {
    const btn = e.target.closest('button'); if (!btn) return
    if (btn.dataset.clear) return clearSelection()
    const i = parseInt(btn.dataset.i, 10)
    if (Number.isFinite(i)) run(i)
  })
  if (headerCb) {
    headerCb.addEventListener('change', e => {
      ;(tableBody || document).querySelectorAll('.bulk-cb').forEach(cb => cb.checked = e.target.checked)
      refresh()
    })
  }
  // Delegated handler for individual checkboxes — pages re-render
  // their tbodies on filter change, so we listen on the container.
  ;(tableBody || document).addEventListener('change', e => {
    if (e.target && e.target.classList && e.target.classList.contains('bulk-cb')) refresh()
  })

  // Expose a small api so pages can force a refresh after re-render.
  return { refresh, clearSelection, selectedIds, run }
}
