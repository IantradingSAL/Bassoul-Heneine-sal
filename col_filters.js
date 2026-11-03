// col_filters.js — Excel-style filters on every column of a table.
//
// Each header gets a ▾ button. It opens a list of the column's values with
// their counts; tick any number of them (search narrows the list). Dates are
// grouped by month. The state lives as JSON in a hidden <input> so the
// saved-views control (user_views.js) can save and restore it like any other
// filter: give that input's id in filterIds.
//
//   import { attachColumnFilters } from './col_filters.js?v=20261103a'
//   const cf = attachColumnFilters({
//     table:      document.querySelector('table.t'),
//     stateInput: document.getElementById('f_cols'),
//     columns: [ { key:'adv', get: r => r.service_advisor }, { key:'od', get: r => r.order_date, kind:'month' }, null, … ],
//     rows:       () => rowsInScope,          // the rows the lists are built from
//     onChange:   () => render(),
//   })
//   rows.filter(cf.match)                     // in the page's own filter step
//
// columns[i] belongs to the i-th <th>; null leaves that column without a filter.
// kind: 'text' (default) | 'month' (a date, grouped by month).
// empty: the label for an empty cell (default "(Empty)").

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const EMPTY = '\u0000'
let cssDone = false

function css(){
  if (cssDone) return; cssDone = true
  const s = document.createElement('style')
  s.textContent = `
  .cf-btn{border:none;background:transparent;cursor:pointer;color:var(--faint,#94a3b8);font-size:10px;padding:1px 3px;margin-left:3px;border-radius:4px;vertical-align:middle;line-height:1}
  .cf-btn:hover{background:rgba(28,105,212,.1);color:var(--bmw,#1C69D4)}
  .cf-btn.on{background:var(--bmw,#1C69D4);color:#fff}
  .cf-pop{position:fixed;z-index:400;width:270px;max-width:calc(100vw - 16px);background:#fff;border:1px solid var(--line,#e2e8f0);border-radius:12px;box-shadow:0 12px 32px rgba(15,23,42,.18);padding:10px;font-size:12px;color:var(--txt,#0f172a);text-transform:none;letter-spacing:0;font-weight:500}
  .cf-pop .cf-h{font-weight:800;font-size:11px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center}
  .cf-pop input[type=search]{width:100%;padding:7px 9px;border:1.5px solid var(--line,#e2e8f0);border-radius:8px;font:inherit;margin-bottom:6px}
  .cf-pop .cf-list{max-height:260px;overflow:auto;border:1px solid #f1f5f9;border-radius:8px;padding:4px}
  .cf-pop label{display:flex;align-items:center;gap:7px;padding:4px 5px;border-radius:6px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cf-pop label:hover{background:#f1f5f9}
  .cf-pop label .n{margin-left:auto;color:var(--faint,#94a3b8);font-size:10.5px;font-variant-numeric:tabular-nums}
  .cf-pop label.all{font-weight:700;border-bottom:1px solid #f1f5f9;border-radius:0;margin-bottom:2px}
  .cf-pop input[type=checkbox]{accent-color:var(--bmw,#1C69D4);width:14px;height:14px;flex-shrink:0}
  .cf-pop .cf-more{color:var(--faint,#94a3b8);font-size:10.5px;padding:4px 5px}
  .cf-pop .cf-f{display:flex;gap:6px;justify-content:flex-end;margin-top:8px}
  .cf-pop .cf-f button{padding:6px 11px;border-radius:8px;border:1.5px solid var(--line,#e2e8f0);background:#fff;font:inherit;font-weight:700;cursor:pointer}
  .cf-pop .cf-f button.ok{background:var(--bmw,#1C69D4);border-color:var(--bmw,#1C69D4);color:#fff}
  `
  document.head.appendChild(s)
}

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]))

export function attachColumnFilters(opts){
  const { table, stateInput, columns, rows, onChange } = opts
  css()
  const ths = [...table.tHead.rows[0].cells]
  const cols = columns.map((c, i) => c && { kind:'text', empty:'(Empty)', ...c, th: ths[i] }).filter(Boolean)
  let state = {}           // key → array of chosen keys (EMPTY for empty)
  let pop = null

  function readState(){
    try { state = JSON.parse(stateInput.value || '{}') || {} } catch { state = {} }
    for (const k of Object.keys(state)) if (!Array.isArray(state[k]) || !state[k].length) delete state[k]
  }
  function writeState(){
    stateInput.value = Object.keys(state).length ? JSON.stringify(state) : ''
    stateInput.dispatchEvent(new Event('input', { bubbles:true }))
    stateInput.dispatchEvent(new Event('change', { bubbles:true }))
  }

  // A cell's filter key and its label.
  function keyOf(c, r){
    const v = c.get(r)
    if (v == null || String(v).trim() === '') return EMPTY
    if (c.kind === 'month') return String(v).slice(0, 7)
    return String(v).trim()
  }
  function labelOf(c, k){
    if (k === EMPTY) return c.empty
    if (c.kind === 'month' && /^\d{4}-\d{2}$/.test(k)) return MONTHS[+k.slice(5) - 1] + ' ' + k.slice(0, 4)
    return k
  }

  function paintButtons(){
    for (const c of cols) {
      const b = c.th.querySelector('.cf-btn')
      const on = !!state[c.key]
      b.classList.toggle('on', on)
      b.textContent = on ? `▾ ${state[c.key].length}` : '▾'
      b.title = on ? `Filtered: ${state[c.key].map(k => labelOf(c, k)).join(', ')}` : 'Filter this column'
    }
  }

  for (const c of cols) {
    const b = document.createElement('button')
    b.type = 'button'; b.className = 'cf-btn viewer-ok'; b.textContent = '▾'
    b.setAttribute('aria-label', 'Filter ' + c.th.textContent.trim())
    b.addEventListener('click', e => { e.stopPropagation(); open(c, b) })
    c.th.appendChild(b)
  }

  function close(){ if (pop) { pop.remove(); pop = null } }
  document.addEventListener('click', e => { if (pop && !pop.contains(e.target)) close() })
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close() })
  window.addEventListener('resize', close)

  // Values are counted among the rows the OTHER column filters keep (as in Excel).
  function open(c, anchor){
    close()
    readState()
    const others = rows().filter(r => matchExcept(r, c.key))
    const counts = new Map()
    for (const r of others) { const k = keyOf(c, r); counts.set(k, (counts.get(k) || 0) + 1) }
    let keys = [...counts.keys()].sort((a, b) => {
      if (a === EMPTY) return 1; if (b === EMPTY) return -1
      if (c.kind === 'month') return b.localeCompare(a)        // newest month first
      return a.localeCompare(b, undefined, { numeric:true })
    })
    const chosen = new Set(state[c.key] || keys)              // nothing chosen = everything
    const title = c.th.childNodes[0]?.textContent?.trim() || c.key

    pop = document.createElement('div')
    pop.className = 'cf-pop'
    pop.innerHTML = `<div class="cf-h"><span>${esc(title)}</span><span style="color:var(--faint,#94a3b8);font-weight:600">${keys.length} value${keys.length === 1 ? '' : 's'}</span></div>
      <input type="search" placeholder="Search…" aria-label="Search values">
      <div class="cf-list"></div>
      <div class="cf-f"><button type="button" class="clr">Clear</button><button type="button" class="ok">OK</button></div>`
    document.body.appendChild(pop)
    const list = pop.querySelector('.cf-list'), q = pop.querySelector('input[type=search]')
    const LIMIT = 400
    function draw(){
      const term = q.value.trim().toLowerCase()
      const vis = term ? keys.filter(k => labelOf(c, k).toLowerCase().includes(term)) : keys
      const allOn = vis.length && vis.every(k => chosen.has(k))
      list.innerHTML = `<label class="all"><input type="checkbox" data-all ${allOn ? 'checked' : ''}> ${term ? 'Select all shown' : 'Select all'}</label>`
        + vis.slice(0, LIMIT).map(k => `<label><input type="checkbox" data-k="${esc(k)}" ${chosen.has(k) ? 'checked' : ''}><span>${esc(labelOf(c, k))}</span><span class="n">${counts.get(k)}</span></label>`).join('')
        + (vis.length > LIMIT ? `<div class="cf-more">+${vis.length - LIMIT} more — type to narrow</div>` : '')
        + (!vis.length ? `<div class="cf-more">No match</div>` : '')
      list._vis = vis
    }
    draw()
    q.addEventListener('input', draw)
    list.addEventListener('change', e => {
      const cb = e.target
      if (cb.dataset.all !== undefined) { list._vis.forEach(k => cb.checked ? chosen.add(k) : chosen.delete(k)); draw(); return }
      cb.checked ? chosen.add(cb.dataset.k) : chosen.delete(cb.dataset.k)
      const all = list.querySelector('[data-all]'); if (all) all.checked = list._vis.every(k => chosen.has(k))
    })
    pop.querySelector('.clr').addEventListener('click', () => { delete state[c.key]; writeState(); paintButtons(); close(); onChange() })
    pop.querySelector('.ok').addEventListener('click', () => {
      const sel = keys.filter(k => chosen.has(k))
      // A search narrows the choice to what was found and ticked.
      const term = q.value.trim().toLowerCase()
      const pick = term ? sel.filter(k => labelOf(c, k).toLowerCase().includes(term)) : sel
      if (!pick.length || pick.length === keys.length) delete state[c.key]
      else state[c.key] = pick
      writeState(); paintButtons(); close(); onChange()
    })
    q.addEventListener('keydown', e => { if (e.key === 'Enter') pop.querySelector('.ok').click() })

    // Place it under the button, inside the window.
    const r = anchor.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight
    let left = Math.min(r.left, window.innerWidth - w - 8); left = Math.max(8, left)
    let top = r.bottom + 4; if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4)
    pop.style.left = left + 'px'; pop.style.top = top + 'px'
    q.focus()
  }

  function matchExcept(r, skip){
    for (const c of cols) {
      if (c.key === skip) continue
      const want = state[c.key]; if (!want) continue
      if (!want.includes(keyOf(c, r))) return false
    }
    return true
  }

  readState(); paintButtons()
  return {
    // Call before filtering a render: the hidden input may have been restored by a saved view.
    refresh(){ readState(); paintButtons() },
    match: r => matchExcept(r, null),
    clear(){ state = {}; writeState(); paintButtons() },
    // e.g. "Service advisor: Nicolas Sawaya, Abdo Doueiry"
    describe(){
      return cols.filter(c => state[c.key]).map(c => `${c.th.childNodes[0]?.textContent?.trim() || c.key}: ${state[c.key].map(k => labelOf(c, k)).join(', ')}`)
    },
    open(key, anchor){ const c = cols.find(x => x.key === key); if (c) open(c, anchor || c.th.querySelector('.cf-btn')) },
    label(key){ const c = cols.find(x => x.key === key); return c && state[key] ? state[key].map(k => labelOf(c, k)) : null },
  }
}
