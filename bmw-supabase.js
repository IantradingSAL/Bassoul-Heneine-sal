/* =====================================================================
 * assets/bmw-supabase.js
 * ---------------------------------------------------------------------
 * Upsert + RPC orchestration layer for the BMW warranty page.
 *
 *   - Idempotent batch upserts (chunked at 500 rows by default).
 *   - Calls recompute_bmw_claim_chains() and relink_bmw_bsi_credits()
 *     in the correct order after each batch — so chains stay coherent
 *     even when the user only uploads one of the three files.
 *   - Progress callback for UI ("rows N of M…") with per-table phase.
 *   - Per-row error capture; failed rows are returned in a flat array
 *     so the page can offer a CSV download for manual review.
 *   - No DOM access. Pure data layer. Pairs with bmw-parser.js.
 *
 * Public API (window.BMWSupabase):
 *
 *   importParsed(supabase, parsed, opts) -> Promise<ImportResult>
 *
 *     parsed: the object returned by BMWParser.parseFiles(files)
 *     opts:
 *       chunkSize:  rows per upsert call (default 500)
 *       onProgress: ({phase, table, done, total, message}) => void
 *
 *     ImportResult:
 *       { invoices:  { submitted, succeeded, failed }
 *       , claims:    { submitted, succeeded, failed }
 *       , credit_items: { submitted, succeeded, failed }
 *       , chains_recomputed: bool
 *       , bsi_linked:  number  (count from relink_bmw_bsi_credits())
 *       , errors:      [{ table, chunkStart, message, rowSample }]
 *       , durationMs:  number
 *       }
 *
 *   exportErrorsAsCsv(errors) -> string
 *
 *   queryChainRoots(supabase, opts) -> Promise<rows[]>
 *   queryChainIterations(supabase, docNo, claimGroup) -> Promise<rows[]>
 *   queryCreditItemsForClaim(supabase, claimNo) -> Promise<rows[]>
 *   queryBsiCredits(supabase, opts) -> Promise<rows[]>
 *   queryBsiItemsFor(supabase, dealerClaimNumber) -> Promise<rows[]>
 *
 * ================================================================== */

(function (global) {
    'use strict';

    // -----------------------------------------------------------------
    // Config
    // -----------------------------------------------------------------
    const DEFAULT_CHUNK_SIZE = 500;

    // Conflict targets MUST match the unique constraints in
    // 13_bmw_warranty.sql.
    const CONFLICT_TARGETS = {
        bmw_invoices:     'doc_no',
        bmw_claims:       'claim_no',
        bmw_credit_items: 'credit_note_number,dealer_claim_number,claim_item_number,claim_item_position'
    };


    // -----------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------
    function _chunk(arr, size) {
        const out = [];
        for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
        return out;
    }

    function _safeRowSample(row) {
        // For error reporting: capture just the row's identifying keys,
        // not the whole payload (avoids dumping huge objects to the UI).
        if (!row) return null;
        const keys = ['doc_no', 'claim_no', 'credit_note_number',
                      'dealer_claim_number', 'claim_item_number',
                      'claim_item_position'];
        const out = {};
        for (const k of keys) if (row[k] != null) out[k] = row[k];
        return out;
    }

    function _csvEscape(v) {
        if (v == null) return '';
        const s = String(v);
        if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
        return s;
    }

    // Deduplicate rows by the conflict-target columns. Postgres rejects
    // INSERT ... ON CONFLICT DO UPDATE when two rows in the SAME statement
    // share the conflict key ("cannot affect row a second time"). The
    // source SAP exports occasionally contain such duplicates; we keep
    // the LAST occurrence (which mirrors what DO UPDATE would yield if
    // Postgres allowed it).
    function _dedupByConflict(records, conflictTarget) {
        if (!records || records.length < 2) return { rows: records || [], dropped: 0 };
        const cols = String(conflictTarget).split(',').map(s => s.trim());
        const seen = new Map();
        for (const r of records) {
            const key = cols.map(c => r[c] == null ? '' : String(r[c])).join('\u0001');
            seen.set(key, r);   // last write wins
        }
        const out = Array.from(seen.values());
        return { rows: out, dropped: records.length - out.length };
    }


    // -----------------------------------------------------------------
    // Chunked upsert with per-chunk error capture
    // -----------------------------------------------------------------
    async function _upsertChunked(supabase, table, records, opts) {
        const chunkSize  = opts.chunkSize  || DEFAULT_CHUNK_SIZE;
        const onProgress = opts.onProgress || (() => {});
        const conflict   = CONFLICT_TARGETS[table];
        if (!conflict) throw new Error('No conflict target configured for ' + table);

        // Drop intra-batch duplicates first (last-wins). See _dedupByConflict
        // doc-comment for why this is required for ON CONFLICT DO UPDATE.
        const deduped = _dedupByConflict(records, conflict);
        records = deduped.rows;

        const total = records.length;
        const errors = [];
        let succeeded = 0;

        if (total === 0) {
            onProgress({ phase: 'upsert', table, done: 0, total: 0,
                         message: 'no rows to upsert' });
            return { submitted: 0, succeeded: 0, failed: 0,
                     deduped: deduped.dropped, errors };
        }

        const chunks = _chunk(records, chunkSize);
        let processed = 0;

        for (let ci = 0; ci < chunks.length; ci++) {
            const chunk = chunks[ci];
            const chunkStart = ci * chunkSize;

            try {
                const { error } = await supabase
                    .from(table)
                    .upsert(chunk, {
                        onConflict: conflict,
                        ignoreDuplicates: false   // re-importing should refresh
                    });

                if (error) {
                    errors.push({
                        table:       table,
                        chunkStart:  chunkStart,
                        chunkSize:   chunk.length,
                        message:     error.message || String(error),
                        rowSample:   _safeRowSample(chunk[0])
                    });
                } else {
                    succeeded += chunk.length;
                }
            } catch (e) {
                errors.push({
                    table:       table,
                    chunkStart:  chunkStart,
                    chunkSize:   chunk.length,
                    message:     e && e.message ? e.message : String(e),
                    rowSample:   _safeRowSample(chunk[0])
                });
            }

            processed += chunk.length;
            onProgress({
                phase:   'upsert',
                table:   table,
                done:    processed,
                total:   total,
                message: table + ': ' + processed + ' / ' + total
            });
        }

        return {
            submitted: total,
            succeeded: succeeded,
            failed:    total - succeeded,
            deduped:   deduped.dropped,
            errors:    errors
        };
    }


    // -----------------------------------------------------------------
    // RPC helpers
    // -----------------------------------------------------------------
    async function _callRecomputeChains(supabase, onProgress) {
        onProgress({ phase: 'rpc', table: null, done: 0, total: 1,
                     message: 'recomputing chain roots…' });
        const { error } = await supabase.rpc('recompute_bmw_claim_chains');
        if (error) throw new Error('recompute_bmw_claim_chains failed: ' + error.message);
        onProgress({ phase: 'rpc', table: null, done: 1, total: 1,
                     message: 'chain roots recomputed' });
    }

    async function _callRelinkBsi(supabase, onProgress) {
        onProgress({ phase: 'rpc', table: null, done: 0, total: 1,
                     message: 'linking BSI credits to invoices…' });
        const { data, error } = await supabase.rpc('relink_bmw_bsi_credits');
        if (error) throw new Error('relink_bmw_bsi_credits failed: ' + error.message);
        // Postgres function returns an integer scalar — supabase-js wraps it
        // as the data field (could be number or { result: number } depending
        // on supabase-js version). Coerce defensively.
        let n = 0;
        if (typeof data === 'number') n = data;
        else if (data && typeof data === 'object') {
            if (typeof data.result === 'number') n = data.result;
            else {
                const v = Object.values(data)[0];
                if (typeof v === 'number') n = v;
            }
        }
        onProgress({ phase: 'rpc', table: null, done: 1, total: 1,
                     message: 'linked ' + n + ' BSI items' });
        return n;
    }


    // -----------------------------------------------------------------
    // Top-level: import a parsed bundle into Supabase
    // -----------------------------------------------------------------
    // Order is important:
    //   1. invoices first (so credit_items.doc_no lookups have something to
    //      match later via relink_bmw_bsi_credits).
    //   2. claims next (so warranty-credit-item rows reference real claim_no's).
    //   3. credit_items last.
    //   4. recompute_bmw_claim_chains() — only meaningful if claims were
    //      touched, but cheap and idempotent so we always run it when any
    //      table changed.
    //   5. relink_bmw_bsi_credits() — only meaningful if credit_items
    //      OR invoices were touched. Same reasoning: always run when any
    //      table changed; cost is one indexed UPDATE.
    //
    // The user can drop only one file (e.g. just credit_notes for a
    // mid-month update); we handle that gracefully — empty record arrays
    // are skipped, RPCs still run.
    // -----------------------------------------------------------------
    async function importParsed(supabase, parsed, opts) {
        if (!supabase || typeof supabase.from !== 'function') {
            throw new Error('importParsed: supabase client is required');
        }
        opts = opts || {};
        const onProgress = opts.onProgress || (() => {});
        const t0 = Date.now();

        // Use the parser's mappers if not pre-mapped (parsed.rows is the
        // raw form; parsed.records is the mapped form). Accept either.
        const BMWParser = global.BMWParser;
        if (!BMWParser) {
            throw new Error('importParsed: BMWParser is not loaded; load assets/bmw-parser.js first');
        }

        function mapKind(slot, mapper) {
            if (!slot) return [];
            if (Array.isArray(slot.records)) return slot.records;
            if (Array.isArray(slot.rows))    return slot.rows.map(mapper).filter(Boolean);
            return [];
        }

        const invoiceRecords = mapKind(parsed.incadea,      BMWParser.mapInvoiceRow);
        const claimRecords   = mapKind(parsed.submission,   BMWParser.mapClaimRow);
        const creditRecords  = mapKind(parsed.credit_notes, r => BMWParser.mapCreditItemRow(r, null));

        const result = {
            invoices:     { submitted: 0, succeeded: 0, failed: 0, deduped: 0 },
            claims:       { submitted: 0, succeeded: 0, failed: 0, deduped: 0 },
            credit_items: { submitted: 0, succeeded: 0, failed: 0, deduped: 0 },
            chains_recomputed: false,
            bsi_linked:        0,
            errors:            [],
            durationMs:        0
        };

        // ---- 1. invoices ----
        if (invoiceRecords.length) {
            onProgress({ phase: 'start', table: 'bmw_invoices',
                         done: 0, total: invoiceRecords.length,
                         message: 'uploading invoices…' });
            const r = await _upsertChunked(supabase, 'bmw_invoices', invoiceRecords, opts);
            result.invoices = { submitted: r.submitted, succeeded: r.succeeded,
                                failed: r.failed, deduped: r.deduped };
            result.errors.push(...r.errors);
        }

        // ---- 2. claims ----
        if (claimRecords.length) {
            onProgress({ phase: 'start', table: 'bmw_claims',
                         done: 0, total: claimRecords.length,
                         message: 'uploading claims…' });
            const r = await _upsertChunked(supabase, 'bmw_claims', claimRecords, opts);
            result.claims = { submitted: r.submitted, succeeded: r.succeeded,
                              failed: r.failed, deduped: r.deduped };
            result.errors.push(...r.errors);
        }

        // ---- 3. credit items ----
        if (creditRecords.length) {
            onProgress({ phase: 'start', table: 'bmw_credit_items',
                         done: 0, total: creditRecords.length,
                         message: 'uploading credit items…' });
            const r = await _upsertChunked(supabase, 'bmw_credit_items', creditRecords, opts);
            result.credit_items = { submitted: r.submitted, succeeded: r.succeeded,
                                    failed: r.failed, deduped: r.deduped };
            result.errors.push(...r.errors);
        }

        const anythingChanged = invoiceRecords.length || claimRecords.length || creditRecords.length;

        // ---- 4. chains: only meaningful if claims changed, but harmless otherwise
        if (claimRecords.length) {
            try {
                await _callRecomputeChains(supabase, onProgress);
                result.chains_recomputed = true;
            } catch (e) {
                result.errors.push({ table: '_rpc',
                                     message: e.message || String(e) });
            }
        }

        // ---- 5. BSI relink: meaningful if invoices OR credit items changed
        if (invoiceRecords.length || creditRecords.length) {
            try {
                result.bsi_linked = await _callRelinkBsi(supabase, onProgress);
            } catch (e) {
                result.errors.push({ table: '_rpc',
                                     message: e.message || String(e) });
            }
        }

        if (!anythingChanged) {
            onProgress({ phase: 'done', table: null, done: 0, total: 0,
                         message: 'nothing to import' });
        } else {
            onProgress({ phase: 'done', table: null, done: 1, total: 1,
                         message: 'import complete' });
        }
        result.durationMs = Date.now() - t0;
        return result;
    }


    // -----------------------------------------------------------------
    // Error CSV export (for the "download error report" button)
    // -----------------------------------------------------------------
    function exportErrorsAsCsv(errors) {
        if (!errors || !errors.length) return 'table,chunkStart,chunkSize,message,rowSample\n';
        const header = ['table', 'chunkStart', 'chunkSize', 'message', 'rowSample'];
        const lines  = [header.join(',')];
        for (const e of errors) {
            lines.push([
                _csvEscape(e.table),
                _csvEscape(e.chunkStart),
                _csvEscape(e.chunkSize),
                _csvEscape(e.message),
                _csvEscape(e.rowSample ? JSON.stringify(e.rowSample) : '')
            ].join(','));
        }
        return lines.join('\n') + '\n';
    }


    // -----------------------------------------------------------------
    // Read-side queries for the UI
    // -----------------------------------------------------------------
    // Wrappers around the views and tables so the page doesn't have to
    // know the column names. Each respects opts.limit and opts.range
    // for paginated UIs.
    // -----------------------------------------------------------------

    // Chain-root rows for the main warranty list.
    // opts: { make, status, dateFrom, dateTo, search, limit, offset, orderBy }
    async function queryChainRoots(supabase, opts) {
        opts = opts || {};
        let q = supabase
            .from('bmw_warranty_chain_roots_view')
            .select('*');

        if (opts.make)   q = q.eq('make_code', opts.make);
        if (opts.status) q = q.eq('chain_latest_status', opts.status);
        if (opts.dateFrom) q = q.gte('submission_date', opts.dateFrom);
        if (opts.dateTo)   q = q.lte('submission_date', opts.dateTo);
        if (opts.search) {
            const s = String(opts.search).trim();
            if (s) {
                // OR across the most-likely fields
                q = q.or([
                    'doc_no.ilike.%' + s + '%',
                    'vin.ilike.%' + s + '%',
                    'model.ilike.%' + s + '%',
                    'customer_name.ilike.%' + s + '%',
                    'service_order_no.ilike.%' + s + '%',
                    'claim_no.ilike.%' + s + '%'
                ].join(','));
            }
        }

        const orderBy = opts.orderBy || 'submission_date';
        q = q.order(orderBy, { ascending: opts.ascending === true });

        const limit  = Number.isFinite(opts.limit)  ? opts.limit  : 200;
        const offset = Number.isFinite(opts.offset) ? opts.offset : 0;
        q = q.range(offset, offset + limit - 1);

        const { data, error } = await q;
        if (error) throw new Error('queryChainRoots: ' + error.message);
        return data || [];
    }

    // All iterations within a single chain (drilldown from chain root row).
    async function queryChainIterations(supabase, docNo, claimGroup) {
        if (!docNo) return [];
        let q = supabase
            .from('bmw_claims')
            .select('*')
            .eq('doc_no', docNo)
            .order('submission_date', { ascending: true });
        if (claimGroup) q = q.eq('claim_group', claimGroup);
        const { data, error } = await q;
        if (error) throw new Error('queryChainIterations: ' + error.message);
        return data || [];
    }

    // All credit-note line items for a single warranty claim iteration.
    async function queryCreditItemsForClaim(supabase, claimNo) {
        if (!claimNo) return [];
        const { data, error } = await supabase
            .from('bmw_credit_items')
            .select('*')
            .eq('credit_type', 'warranty')
            .eq('claim_no', claimNo)
            .order('claim_item_position', { ascending: true });
        if (error) throw new Error('queryCreditItemsForClaim: ' + error.message);
        return data || [];
    }

    // BSI section main list.
    // opts: { brand, dateFrom, dateTo, search, limit, offset }
    async function queryBsiCredits(supabase, opts) {
        opts = opts || {};
        let q = supabase
            .from('bmw_bsi_credits_view')
            .select('*');

        if (opts.brand)   q = q.eq('brand', opts.brand);
        if (opts.dateFrom) q = q.gte('credit_note_date', opts.dateFrom);
        if (opts.dateTo)   q = q.lte('credit_note_date', opts.dateTo);
        if (opts.search) {
            const s = String(opts.search).trim();
            if (s) {
                q = q.or([
                    'dealer_claim_number.ilike.%' + s + '%',
                    'vin.ilike.%' + s + '%',
                    'doc_no.ilike.%' + s + '%',
                    'model.ilike.%' + s + '%',
                    'credit_note_number.ilike.%' + s + '%',
                    'customer_name.ilike.%' + s + '%'
                ].join(','));
            }
        }

        q = q.order(opts.orderBy || 'credit_note_date',
                    { ascending: opts.ascending === true });

        const limit  = Number.isFinite(opts.limit)  ? opts.limit  : 200;
        const offset = Number.isFinite(opts.offset) ? opts.offset : 0;
        q = q.range(offset, offset + limit - 1);

        const { data, error } = await q;
        if (error) throw new Error('queryBsiCredits: ' + error.message);
        return data || [];
    }

    // All line items for a BSI claim (drilldown).
    async function queryBsiItemsFor(supabase, dealerClaimNumber) {
        if (!dealerClaimNumber) return [];
        const { data, error } = await supabase
            .from('bmw_credit_items')
            .select('*')
            .eq('credit_type', 'bsi')
            .eq('dealer_claim_number', dealerClaimNumber)
            .order('claim_item_position', { ascending: true });
        if (error) throw new Error('queryBsiItemsFor: ' + error.message);
        return data || [];
    }


    // -----------------------------------------------------------------
    // KPI helper for the dashboard strip
    // -----------------------------------------------------------------
    // Returns a single object summarizing counts/totals across both
    // sections. Filters: { make, dateFrom, dateTo }.
    // -----------------------------------------------------------------
    async function queryKpis(supabase, filters) {
        filters = filters || {};

        // Two parallel queries against the two views; aggregate locally.
        // (We could push these to SQL views/functions later for speed
        // when the dataset gets bigger.)

        let qWar = supabase.from('bmw_warranty_chain_roots_view')
            .select('chain_iteration_count,chain_latest_status,chain_total_recovered,' +
                    'amount,make_code,submission_date');
        if (filters.make)     qWar = qWar.eq('make_code', filters.make);
        if (filters.dateFrom) qWar = qWar.gte('submission_date', filters.dateFrom);
        if (filters.dateTo)   qWar = qWar.lte('submission_date', filters.dateTo);

        let qBsi = supabase.from('bmw_bsi_credits_view')
            .select('total_recovered,credit_note_date,brand');
        if (filters.dateFrom) qBsi = qBsi.gte('credit_note_date', filters.dateFrom);
        if (filters.dateTo)   qBsi = qBsi.lte('credit_note_date', filters.dateTo);

        const [warRes, bsiRes] = await Promise.all([qWar, qBsi]);
        if (warRes.error) throw new Error('queryKpis (warranty): ' + warRes.error.message);
        if (bsiRes.error) throw new Error('queryKpis (bsi): ' + bsiRes.error.message);

        const wars = warRes.data || [];
        const bsis = bsiRes.data || [];

        let totalClaimed = 0, totalRecovered = 0;
        let nRecovered = 0, nRejected = 0, nAwaiting = 0, nResubmitted = 0;
        for (const w of wars) {
            totalClaimed   += +(w.amount || 0);
            totalRecovered += +(w.chain_total_recovered || 0);
            switch (w.chain_latest_status) {
                case 'Cr. Memo Received': nRecovered++; break;
                case 'Refused':           nRejected++; break;
                case 'Sent':              nAwaiting++; break;
                case 'Submitted Again':   nResubmitted++; break;
                default: break;
            }
        }
        const recoveryRate = totalClaimed > 0
            ? (totalRecovered / totalClaimed) : null;

        let bsiTotal = 0;
        for (const b of bsis) bsiTotal += +(b.total_recovered || 0);

        return {
            warranty: {
                chains:        wars.length,
                claimed:       totalClaimed,
                recovered:     totalRecovered,
                recovery_rate: recoveryRate,
                by_status: {
                    recovered:    nRecovered,
                    rejected:     nRejected,
                    awaiting:     nAwaiting,
                    resubmitted:  nResubmitted
                }
            },
            bsi: {
                claims:    bsis.length,
                recovered: bsiTotal
            }
        };
    }


    // -----------------------------------------------------------------
    // Status -> badge mapping (matches the spec we agreed on)
    // -----------------------------------------------------------------
    function statusToBadge(latestStatus, claimedAmount, totalRecovered) {
        if (latestStatus === 'Sent')             return 'Awaiting';
        if (latestStatus === 'Refused')          return 'Rejected';
        if (latestStatus === 'Submitted Again')  return 'Resubmitted';
        if (latestStatus === 'Completed') {
            return (+claimedAmount === 0) ? 'Closed' : 'Recovered';
        }
        if (latestStatus === 'Cr. Memo Received') {
            const claimed   = +claimedAmount   || 0;
            const recovered = +totalRecovered  || 0;
            if (claimed > 0 && recovered < claimed * 0.99) {
                return 'Partially Recovered';
            }
            return 'Recovered';
        }
        return latestStatus || 'Unknown';
    }


    // -----------------------------------------------------------------
    // Public namespace
    // -----------------------------------------------------------------
    global.BMWSupabase = {
        // Write
        importParsed:           importParsed,
        exportErrorsAsCsv:      exportErrorsAsCsv,

        // Read
        queryChainRoots:        queryChainRoots,
        queryChainIterations:   queryChainIterations,
        queryCreditItemsForClaim: queryCreditItemsForClaim,
        queryBsiCredits:        queryBsiCredits,
        queryBsiItemsFor:       queryBsiItemsFor,
        queryKpis:              queryKpis,

        // UI helper
        statusToBadge:          statusToBadge,

        // Internal (exposed for tests)
        _CONFLICT_TARGETS:      CONFLICT_TARGETS,
        _DEFAULT_CHUNK_SIZE:    DEFAULT_CHUNK_SIZE,
        _chunk:                 _chunk
    };

})(typeof window !== 'undefined' ? window : globalThis);
