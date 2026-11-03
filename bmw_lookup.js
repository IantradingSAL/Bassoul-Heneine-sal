// bmw_lookup.js — fill a BMW order from what the system already knows.
//
// • Order number → order date / VIN / customer from the Incadea invoice
//   uploads (bmw_order_lookup). The order date is Incadea's: entry forms show
//   it read-only, and the database sets it (trigger trg_bmw_orders_fill) —
//   when the invoice is not uploaded yet it stays empty and fills itself later.
// • VIN → advisors type only the last 7 characters; bmw_vin_lookup finds the
//   full VIN (orders, invoices, Service Inclusive vehicles) and its customer.
//   One match fills in by itself; several are offered in a short list.
//
//   import { lookupOrder, attachVinLookup } from './bmw_lookup.js?v=20261103a'

export async function lookupOrder(sb, orderNo){
  const n = String(orderNo || '').replace(/\D/g, '')
  if (!n) return null
  const { data, error } = await sb.rpc('bmw_order_lookup', { p_order: n })
  if (error) { console.warn('bmw_order_lookup', error.message); return null }
  const r = Array.isArray(data) ? data[0] : data
  return r && (r.order_date || r.vin || r.customer) ? r : null
}

let cssDone = false
function css(){
  if (cssDone) return; cssDone = true
  const s = document.createElement('style')
  s.textContent = `
  .vl-wrap{position:relative}
  .vl-list{position:absolute;left:0;right:0;top:100%;margin-top:4px;z-index:60;background:#fff;border:1px solid var(--line,#e2e8f0);border-radius:10px;box-shadow:0 10px 26px rgba(15,23,42,.16);overflow:hidden}
  .vl-item{display:block;width:100%;text-align:left;padding:8px 11px;border:none;border-bottom:1px solid #f1f5f9;background:#fff;font:inherit;font-size:12px;cursor:pointer;color:var(--txt,#0f172a)}
  .vl-item:last-child{border-bottom:none}
  .vl-item:hover,.vl-item:focus{background:var(--blue4,#eef2ff);outline:none}
  .vl-item b{font-family:var(--mono,monospace);letter-spacing:.3px}
  .vl-item span{display:block;color:var(--muted,#64748b);font-size:11px;margin-top:1px}
  .vl-hint{font-size:10.5px;font-weight:700;margin-top:3px;min-height:13px}
  .vl-hint.ok{color:#047857} .vl-hint.no{color:var(--muted,#64748b)} .vl-hint.many{color:#1C69D4}
  `
  document.head.appendChild(s)
}
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]))

// vinEl: the VIN input; custEl: the customer input (filled only when empty);
// hintEl (optional): where to say what was found. onPick(row) is called after
// a VIN is chosen. Returns { check() } to re-run the lookup on demand.
export function attachVinLookup(sb, vinEl, custEl, hintEl, onPick){
  css()
  const wrap = document.createElement('span')
  wrap.className = 'vl-wrap'; wrap.style.display = 'block'
  vinEl.parentNode.insertBefore(wrap, vinEl); wrap.appendChild(vinEl)
  const list = document.createElement('div'); list.className = 'vl-list'; list.hidden = true
  wrap.appendChild(list)
  let timer = null, seq = 0
  const hint = (cls, txt) => { if (hintEl) { hintEl.className = 'vl-hint ' + cls; hintEl.textContent = txt } }
  const close = () => { list.hidden = true; list.innerHTML = '' }
  function pick(r){
    vinEl.value = r.vin
    if (custEl && !custEl.value.trim() && r.customer) custEl.value = r.customer
    hint('ok', '✓ ' + [r.customer, r.model].filter(Boolean).join(' · '))
    close()
    vinEl.dispatchEvent(new Event('change', { bubbles:true }))
    if (onPick) onPick(r)
  }
  async function check(){
    const q = vinEl.value.trim().toUpperCase()
    if (q.length < 7 || q.length > 17) { close(); hint('', ''); return }
    const my = ++seq
    const { data, error } = await sb.rpc('bmw_vin_lookup', { p_q: q })
    if (my !== seq) return                       // a newer keystroke won
    if (error) { console.warn('bmw_vin_lookup', error.message); return }
    const rows = data || []
    if (!rows.length) { close(); hint('no', q.length < 17 ? 'Not in the system yet — type the full VIN' : 'New vehicle'); return }
    if (rows.length === 1) {
      if (q.length === 17 && rows[0].vin === q) { hint('ok', '✓ ' + [rows[0].customer, rows[0].model].filter(Boolean).join(' · ')); if (custEl && !custEl.value.trim() && rows[0].customer) custEl.value = rows[0].customer; return }
      pick(rows[0]); return
    }
    hint('many', rows.length + ' vehicles end like this — pick one')
    list.innerHTML = rows.map((r, i) => `<button type="button" class="vl-item viewer-ok" data-i="${i}"><b>${esc(r.vin)}</b><span>${esc([r.customer, r.model].filter(Boolean).join(' · ') || '—')}</span></button>`).join('')
    list.hidden = false
    list.querySelectorAll('.vl-item').forEach(b => b.addEventListener('mousedown', e => { e.preventDefault(); pick(rows[+b.dataset.i]) }))
  }
  vinEl.addEventListener('input', () => {
    vinEl.value = vinEl.value.toUpperCase().replace(/\s+/g, '')
    clearTimeout(timer); timer = setTimeout(check, 280)
  })
  vinEl.addEventListener('blur', () => setTimeout(close, 150))
  vinEl.addEventListener('keydown', e => {
    if (list.hidden) return
    if (e.key === 'Escape') close()
    if (e.key === 'ArrowDown') { e.preventDefault(); list.querySelector('.vl-item')?.focus() }
  })
  return { check, clear: () => { close(); hint('', '') } }
}
