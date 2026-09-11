// ─────────────────────────────────────────────────────────────────
// BMW claim-date matcher — fills warranty_claim_date / service_claim_date
// on warranty_bmw_orders rows from the BMW submissions upload
// (bmw_rec_submissions, loaded on warranty_bmw.html), instead of manual
// entry. claim_kind 'warranty' → warranty claim, 'bsi' → service claim.
//
// Matching key: the digits of the order number / GOR service-order ref,
// with leading zeros stripped, so GOR0267779 / GOR267779 / 267779 all
// match. Submissions without a service_order_no are linked through their
// GAR invoice (bmw_rec_invoices.doc_no → service_order_no).
//
// The earliest submission date wins (dealer_claim_submitted_date,
// falling back to document_date). Newly found dates are written back to
// warranty_bmw_orders and into the passed row objects, so every page
// sees them afterwards.
// ─────────────────────────────────────────────────────────────────
export async function matchClaimDates(sb, orders){
  const missing = (orders || []).filter(r => r && r.id != null && (!r.warranty_claim_date || !r.service_claim_date))
  if (!missing.length) return { updated: 0 }

  const norm = v => { const d = String(v == null ? '' : v).replace(/\D/g, '').replace(/^0+/, ''); return d || null }
  const wanted = new Set(missing.map(r => norm(r.order_number)).filter(Boolean))
  if (!wanted.size) return { updated: 0 }

  const { data: subs, error } = await sb.from('bmw_rec_submissions')
    .select('claim_kind,service_order_no,doc_no,dealer_claim_submitted_date,document_date')
  if (error) return { updated: 0, error }
  if (!subs || !subs.length) return { updated: 0 }

  // submissions with no GOR can still be linked via their GAR invoice
  const orphanDocs = [...new Set(subs.filter(s => !s.service_order_no && s.doc_no).map(s => s.doc_no))]
  const doc2gor = {}
  for (let i = 0; i < orphanDocs.length; i += 200){
    const { data: invs } = await sb.from('bmw_rec_invoices')
      .select('doc_no,service_order_no').in('doc_no', orphanDocs.slice(i, i + 200))
    ;(invs || []).forEach(v => { if (v.service_order_no) doc2gor[v.doc_no] = v.service_order_no })
  }

  const best = {} // gor key -> { warranty: date, bsi: date }
  for (const s of subs){
    const key = norm(s.service_order_no || doc2gor[s.doc_no])
    if (!key || !wanted.has(key)) continue
    const date = s.dealer_claim_submitted_date || s.document_date
    if (!date) continue
    const kind = s.claim_kind === 'bsi' ? 'bsi' : 'warranty'
    const slot = best[key] || (best[key] = {})
    if (!slot[kind] || date < slot[kind]) slot[kind] = date
  }

  let updated = 0
  for (const r of missing){
    const m = best[norm(r.order_number)]
    if (!m) continue
    const upd = {}
    if (!r.warranty_claim_date && m.warranty) upd.warranty_claim_date = m.warranty
    if (!r.service_claim_date && m.bsi) upd.service_claim_date = m.bsi
    if (!Object.keys(upd).length) continue
    const { error: e2 } = await sb.from('warranty_bmw_orders').update(upd).eq('id', r.id)
    if (!e2){ Object.assign(r, upd); updated++ }
  }
  return { updated }
}
