/* =====================================================================
 * assets/bmw-parser.js
 * ---------------------------------------------------------------------
 * Pure-data layer for the BMW warranty page.
 *
 *   - Loads xlsx from a 4-CDN fallback chain (jsDelivr first, matches
 *     existing project convention; never esm.sh).
 *   - Multi-strategy xlsx parsing: array buffer -> binary string -> HTML
 *     -> CSV (same fallback ladder used in warranty.html for Renault).
 *   - File detection by sheet name + signature columns; user can drop
 *     incadea / submission / credit-notes in any order or all at once.
 *   - Date sanitization to YYYY-MM-DD (Postgres `date` type is strict;
 *     "Wed Jan 21" silently fails — same root cause that bit us before).
 *   - Row -> record mappers for the three target tables defined in
 *     13_bmw_warranty.sql.
 *
 * No DOM access. No Supabase calls. No globals beyond the IIFE-exported
 * `BMWParser` namespace. Easy to unit-test in isolation.
 *
 * Public API (window.BMWParser):
 *
 *   loadXlsxLib()                -> Promise<XLSX>
 *   readWorkbook(file)           -> Promise<Workbook>      // uses XLSX
 *   detectFileKind(workbook)     -> 'incadea' | 'submission' | 'credit_notes' | null
 *   parseFile(file)              -> Promise<{kind, rows, sheet, headerMap}>
 *   parseFiles(files)            -> Promise<{ incadea?, submission?, credit_notes?, errors[] }>
 *
 *   mapInvoiceRow(rawRow)        -> bmw_invoices record (or null)
 *   mapClaimRow(rawRow)          -> bmw_claims record   (or null)
 *   mapCreditItemRow(rawRow, knownClaimNos) -> bmw_credit_items record (or null)
 *
 *   toIsoDate(v)                 -> 'YYYY-MM-DD' or null
 *   toNumber(v)                  -> number or null
 *   toInt(v)                     -> integer or null
 *   toBool(v)                    -> true | false | null
 *
 * ================================================================== */

(function (global) {
    'use strict';

    // -----------------------------------------------------------------
    // 1. CDN loading — 4-stage fallback for the xlsx library
    // -----------------------------------------------------------------
    // Mirrors the supabase loader pattern already used elsewhere in the
    // project. esm.sh is intentionally absent (caused boot failures).
    // -----------------------------------------------------------------
    const XLSX_CDN_CHAIN = [
        'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
        'https://cdn.jsdelivr.net/npm/xlsx/dist/xlsx.full.min.js',
        'https://unpkg.com/xlsx@0.18.5/dist/xlsx.full.min.js',
        'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'
    ];

    let _xlsxPromise = null;

    function _loadScript(src) {
        return new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = src;
            s.async = true;
            s.onload = () => resolve(src);
            s.onerror = () => reject(new Error('failed to load ' + src));
            document.head.appendChild(s);
        });
    }

    async function loadXlsxLib() {
        if (typeof global.XLSX !== 'undefined') return global.XLSX;
        if (_xlsxPromise) return _xlsxPromise;

        _xlsxPromise = (async () => {
            let lastErr = null;
            for (const url of XLSX_CDN_CHAIN) {
                try {
                    await _loadScript(url);
                    if (typeof global.XLSX !== 'undefined') return global.XLSX;
                } catch (e) {
                    lastErr = e;
                    // try next CDN
                }
            }
            throw new Error('xlsx library could not be loaded from any CDN: ' +
                            (lastErr ? lastErr.message : 'unknown'));
        })();
        return _xlsxPromise;
    }


    // -----------------------------------------------------------------
    // 2. Multi-strategy file -> workbook parsing
    // -----------------------------------------------------------------
    // Real-world xlsx files exported from incadea / SAP can be subtly
    // malformed (extra HTML wrappers, BOM bytes, mislabeled mime). The
    // ladder below is the same one we use successfully on the Renault
    // page: try the most efficient path first, fall back as needed.
    // -----------------------------------------------------------------
    function _readAsArrayBuffer(file) {
        return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload  = () => resolve(r.result);
            r.onerror = () => reject(r.error || new Error('arraybuffer read failed'));
            r.readAsArrayBuffer(file);
        });
    }
    function _readAsBinaryString(file) {
        return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload  = () => resolve(r.result);
            r.onerror = () => reject(r.error || new Error('binary string read failed'));
            r.readAsBinaryString(file);
        });
    }
    function _readAsText(file) {
        return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload  = () => resolve(r.result);
            r.onerror = () => reject(r.error || new Error('text read failed'));
            r.readAsText(file);
        });
    }

    async function readWorkbook(file) {
        const XLSX = await loadXlsxLib();
        const errors = [];

        // Strategy 1: arraybuffer (preferred, fastest, handles modern xlsx)
        try {
            const buf = await _readAsArrayBuffer(file);
            return XLSX.read(buf, { type: 'array', cellDates: false, cellNF: false });
        } catch (e) { errors.push('arraybuffer: ' + e.message); }

        // Strategy 2: binary string (older browsers / .xls)
        try {
            const bs = await _readAsBinaryString(file);
            return XLSX.read(bs, { type: 'binary', cellDates: false, cellNF: false });
        } catch (e) { errors.push('binary: ' + e.message); }

        // Strategy 3: HTML-wrapped xlsx (some SAP exports do this)
        try {
            const txt = await _readAsText(file);
            if (/<table/i.test(txt)) {
                return XLSX.read(txt, { type: 'string' });
            }
        } catch (e) { errors.push('html: ' + e.message); }

        // Strategy 4: plain CSV / TSV
        try {
            const txt = await _readAsText(file);
            return XLSX.read(txt, { type: 'string' });
        } catch (e) { errors.push('csv: ' + e.message); }

        throw new Error('could not parse workbook. tried: ' + errors.join(' | '));
    }


    // -----------------------------------------------------------------
    // 3. File detection
    // -----------------------------------------------------------------
    // Detect by combining sheet-name and signature-column tests. Each
    // file gets a confidence score; the highest non-zero wins.
    // Returns { kind, sheetName, headerMap } or null.
    // -----------------------------------------------------------------
    const FILE_SIGNATURES = {
        incadea: {
            sheet: /^incadea$/i,
            mustHave: ['no.', 'make code', 'reference vin', 'service order no.'],
            niceToHave: ['user id', 'sell-to customer name', 'order date',
                         'item sales price group', 'posting date']
        },
        submission: {
            sheet: /warranty/i,
            mustHave: ['no.', 'claim no.', 'document no.', 'submission date'],
            niceToHave: ['status', 'amount', 'make code', 'service order no.']
        },
        credit_notes: {
            sheet: /sap document export|credit note/i,
            mustHave: ['credit note number', 'dealer claim number',
                       'accepted price w/o hc', 'claim item number'],
            niceToHave: ['vin', 'repair date', 'crediting item status', 'brand'],
            // SAP exports several column names twice. By default the FIRST
            // occurrence wins (it carries the data; later columns are empty).
            // For these specific headers the LATER occurrence is the one we
            // actually want — SAP mislabels them. Verified by inspection of
            // a real export: col "Claim Item Position" #1 contains the item
            // type description ("Labor Value", "Spare Part, Material") while
            // col #2 contains the actual numeric position.
            duplicateOverrides: {
                'claim item position': 'last'
            }
        }
    };

    function _normalizeHeader(h) {
        return String(h == null ? '' : h).trim().toLowerCase().replace(/\s+/g, ' ');
    }

    function _scoreSheet(sheet, sheetName, sig) {
        if (!sheet) return { score: 0, headerMap: {} };
        // Pull first row as headers
        const json = (global.XLSX || {}).utils
            ? global.XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true })
            : null;
        if (!json || !json.length) return { score: 0, headerMap: {} };

        // Header row = first row whose cells include any mustHave column.
        // Some files have a title row before the real header.
        let headerRow = null, headerRowIdx = -1;
        for (let i = 0; i < Math.min(json.length, 5); i++) {
            const row = json[i] || [];
            const norm = row.map(_normalizeHeader);
            const hits = sig.mustHave.filter(c => norm.includes(c)).length;
            if (hits >= Math.max(1, Math.floor(sig.mustHave.length / 2))) {
                headerRow = norm;
                headerRowIdx = i;
                break;
            }
        }
        if (!headerRow) return { score: 0, headerMap: {} };

        const must  = sig.mustHave.filter(c => headerRow.includes(c)).length;
        const nice  = (sig.niceToHave || []).filter(c => headerRow.includes(c)).length;
        const sheetMatch = sig.sheet.test(sheetName) ? 5 : 0;

        if (must < sig.mustHave.length) return { score: 0, headerMap: {} };

        // Build header map: FIRST occurrence wins by default. Some SAP
        // exports repeat column names; the first carries the data and
        // later ones are empty. Per-file overrides handle exceptions.
        const headerMap     = {};
        const headerMapAll  = {};   // norm -> [idx0, idx1, ...]
        const original = json[headerRowIdx] || [];
        original.forEach((cell, idx) => {
            const norm = _normalizeHeader(cell);
            if (!norm) return;
            if (!(norm in headerMap)) headerMap[norm] = idx;     // first wins
            (headerMapAll[norm] = headerMapAll[norm] || []).push(idx);
        });

        // Apply per-file overrides for known mislabeled duplicates
        if (sig.duplicateOverrides) {
            for (const [norm, prefer] of Object.entries(sig.duplicateOverrides)) {
                const all = headerMapAll[norm];
                if (!all || all.length < 2) continue;
                if (prefer === 'last')      headerMap[norm] = all[all.length - 1];
                else if (prefer === 'first') headerMap[norm] = all[0];
                else if (typeof prefer === 'number' && prefer >= 0 && prefer < all.length) {
                    headerMap[norm] = all[prefer];
                }
            }
        }

        return {
            score: must * 10 + nice + sheetMatch,
            headerMap,
            headerRowIdx
        };
    }

    function detectFileKind(workbook) {
        if (!workbook || !workbook.SheetNames || !workbook.SheetNames.length) return null;
        let best = null;

        for (const sheetName of workbook.SheetNames) {
            const sheet = workbook.Sheets[sheetName];
            for (const kind of Object.keys(FILE_SIGNATURES)) {
                const sig = FILE_SIGNATURES[kind];
                const r   = _scoreSheet(sheet, sheetName, sig);
                if (r.score > 0 && (!best || r.score > best.score)) {
                    best = { kind, sheetName, ...r };
                }
            }
        }
        return best;
    }


    // -----------------------------------------------------------------
    // 4. Sheet -> array of objects, keyed by normalized headers
    // -----------------------------------------------------------------
    function _sheetToRows(sheet, headerMap, headerRowIdx) {
        const XLSX = global.XLSX;
        const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true });
        const rows = [];
        for (let i = headerRowIdx + 1; i < grid.length; i++) {
            const row = grid[i] || [];
            // Skip fully-empty rows
            if (row.every(c => c == null || (typeof c === 'string' && c.trim() === ''))) continue;
            const obj = {};
            for (const [normHdr, idx] of Object.entries(headerMap)) {
                obj[normHdr] = row[idx] != null ? row[idx] : null;
            }
            rows.push(obj);
        }
        return rows;
    }

    async function parseFile(file) {
        const wb     = await readWorkbook(file);
        const det    = detectFileKind(wb);
        if (!det) {
            throw new Error('could not detect file kind for "' + file.name +
                '" — does the sheet contain the expected headers?');
        }
        const rows = _sheetToRows(wb.Sheets[det.sheetName], det.headerMap, det.headerRowIdx);
        return {
            kind: det.kind,
            sheetName: det.sheetName,
            headerMap: det.headerMap,
            rowCount: rows.length,
            rows: rows,
            fileName: file.name
        };
    }

    async function parseFiles(files) {
        const out = { incadea: null, submission: null, credit_notes: null, errors: [] };
        for (const f of files) {
            try {
                const parsed = await parseFile(f);
                if (out[parsed.kind]) {
                    // Duplicate of same kind — keep the one with more rows
                    if (parsed.rowCount > out[parsed.kind].rowCount) {
                        out[parsed.kind] = parsed;
                    } else {
                        out.errors.push({
                            fileName: f.name,
                            message: 'duplicate ' + parsed.kind + ' file (kept the larger one)'
                        });
                    }
                } else {
                    out[parsed.kind] = parsed;
                }
            } catch (e) {
                out.errors.push({ fileName: f.name, message: e.message });
            }
        }
        return out;
    }


    // -----------------------------------------------------------------
    // 5. Coercion helpers
    // -----------------------------------------------------------------
    // toIsoDate: handles Excel serial (number or numeric string), JS
    // Date, ISO strings, and human strings like "Wed Jan 21 2026" that
    // PostgreSQL `date` rejects silently.
    // -----------------------------------------------------------------
    const _excelEpoch = Date.UTC(1899, 11, 30); // 1899-12-30 anchor
    const _msPerDay   = 86400000;

    function toIsoDate(v) {
        if (v == null) return null;
        if (v instanceof Date) {
            if (isNaN(v.getTime())) return null;
            return v.toISOString().slice(0, 10);
        }
        // Excel serial (number, or numeric-looking string)
        if (typeof v === 'number' && isFinite(v) && v > 20000 && v < 80000) {
            const ms = _excelEpoch + Math.floor(v) * _msPerDay;
            return new Date(ms).toISOString().slice(0, 10);
        }
        const s = String(v).trim();
        if (!s || s.toLowerCase() === 'nan' || s === '0') return null;
        // Numeric string serial?
        if (/^\d+(\.\d+)?$/.test(s)) {
            const n = parseFloat(s);
            if (n > 20000 && n < 80000) {
                const ms = _excelEpoch + Math.floor(n) * _msPerDay;
                return new Date(ms).toISOString().slice(0, 10);
            }
        }
        // Already ISO?
        const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (m) return m[1] + '-' + m[2] + '-' + m[3];
        // dd/mm/yyyy or dd-mm-yyyy
        const m2 = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
        if (m2) {
            let [_, d, mo, y] = m2;
            if (y.length === 2) y = (parseInt(y, 10) > 70 ? '19' : '20') + y;
            d  = d.padStart(2, '0');
            mo = mo.padStart(2, '0');
            return y + '-' + mo + '-' + d;
        }
        // Fallback: let Date.parse try
        const t = Date.parse(s);
        if (!isNaN(t)) return new Date(t).toISOString().slice(0, 10);
        return null;
    }

    function toNumber(v) {
        if (v == null) return null;
        if (typeof v === 'number') return isFinite(v) ? v : null;
        const s = String(v).trim().replace(/,/g, '');
        if (!s || s.toLowerCase() === 'nan') return null;
        const n = parseFloat(s);
        return isFinite(n) ? n : null;
    }

    function toInt(v) {
        const n = toNumber(v);
        return n == null ? null : Math.trunc(n);
    }

    function toBool(v) {
        if (v == null) return null;
        if (typeof v === 'boolean') return v;
        const s = String(v).trim().toLowerCase();
        if (s === 'yes' || s === 'y' || s === 'true'  || s === '1') return true;
        if (s === 'no'  || s === 'n' || s === 'false' || s === '0') return false;
        return null;
    }

    function _str(v) {
        if (v == null) return null;
        const s = String(v).trim();
        return s === '' ? null : s;
    }


    // -----------------------------------------------------------------
    // 6. Row mappers
    // -----------------------------------------------------------------
    // Each mapper takes a normalized-header row object and returns an
    // object whose keys exactly match the Supabase column names. Any
    // row that lacks its primary key is dropped (return null).
    // -----------------------------------------------------------------

    function mapInvoiceRow(r) {
        const docNo = _str(r['no.']);
        if (!docNo) return null;
        return {
            doc_no:                     docNo,
            make_code:                  _str(r['make code']),
            user_id:                    _str(r['user id']),
            sell_to_customer_no:        _str(r['sell-to customer no.']),
            sell_to_customer_name:      _str(r['sell-to customer name']),
            bill_to_customer_no:        _str(r['bill-to customer no.']),
            bill_to_name:               _str(r['bill-to name']),
            reference_vin:              _str(r['reference vin']),
            reference_license_no:       _str(r['reference license no.']),
            location_code:              _str(r['location code']),
            salesperson_code:           _str(r['salesperson code']),
            sell_to_email:              _str(r['sell-to e-mail']),
            sell_to_mobile_phone_no:    _str(r['sell-to mobile phone no.']),
            sell_to_phone_no:           _str(r['sell-to phone no']),
            external_doc_no:            _str(r['external document no.']),
            item_sales_price_group:     _str(r['item sales price group']),
            order_date:                 toIsoDate(r['order date']),
            posting_date:               toIsoDate(r['posting date']),
            initial_registration:       toIsoDate(r['initial registration']),
            service_vin:                _str(r['service vin']),
            model:                      _str(r['model']),
            service_license_no:         _str(r['service license no.']),
            own_sale:                   toBool(r['own sale']),
            service_posting_group:      _str(r['service posting group']),
            service_posting_group_desc: _str(r['service posting group description']),
            total_labors:               toNumber(r['total labors']),
            total_parts:                toNumber(r['total parts']),
            total_ext_serv:             toNumber(r['total g/l and ext. serv.']),
            vehicle_mileage:            toInt(r['vehicle mileage']),
            service_mileage:            toInt(r['service mileage']),
            payment_method_code:        _str(r['payment method code']),
            insurance_claim_no:         _str(r['insurance claim no.']),
            exported_to_pims:           toBool(r['exported to pims']),
            service_order_no:           _str(r['service order no.'])
        };
    }

    function mapClaimRow(r) {
        const claimNo = _str(r['no.']);
        if (!claimNo) return null;
        return {
            claim_no:               claimNo,
            doc_no:                 _str(r['document no.']),
            claim_group:            _str(r['claim no.']),
            make_code:              _str(r['make code']),
            document_date:          toIsoDate(r['document date']),
            submission_date:        toIsoDate(r['submission date']),
            order_date:             toIsoDate(r['order date']),
            created_by_user_id:     _str(r['created by user id']),
            fair_deal:              toBool(r['fair deal']),
            area:                   _str(r['area']),
            status:                 _str(r['status']),
            bill_to_customer_no:    _str(r['bill-to customer no.']),
            submitted_to_customer:  _str(r['submitted to customer']),
            service_order_no:       _str(r['service order no.']),
            amount:                 toNumber(r['amount']),
            amount_inc_vat:         toNumber(r['amount including vat']),
            own_sale:               toBool(r['own sale'])
        };
    }

    /**
     * Map a credit-note line-item row.
     *
     * Classification rule for credit_type:
     *   The DCN format itself is the primary signal:
     *     - DCNs starting with '0' (e.g. "069504", "070081") are warranty
     *       claims; the leading zeros are SAP's left-padding to 6 digits.
     *       Stripping them yields the claim_no that matches submission.No.
     *     - DCNs that don't start with '0' (e.g. "512877", "513136") are
     *       BSI scheduled-service auto-credits — these never go through
     *       the manual submission flow.
     *
     *   This is preferred over membership-in-knownClaimNos because a
     *   credit for a warranty claim from a previous month may arrive
     *   before that claim's submission row is loaded; we still want to
     *   classify it correctly so the linkage materializes when the claim
     *   row eventually shows up.
     *
     * @param {object}  r              normalized-header row
     * @param {Set|null} knownClaimNos optional safety check; if provided
     *                                 AND the stripped DCN isn't in the
     *                                 set AND the DCN starts with '0',
     *                                 the row is still classified as
     *                                 warranty (for the reason above) but
     *                                 callers can use the set to flag it
     *                                 as an orphan in the UI if desired.
     */
    function mapCreditItemRow(r, knownClaimNos) {
        const dcn = _str(r['dealer claim number']);
        const cnn = _str(r['credit note number']);
        const itemNo  = _str(r['claim item number']);
        const itemPos = _str(r['claim item position']);
        if (!dcn || !cnn || !itemNo || !itemPos) return null;

        const stripped = dcn.replace(/^0+/, '');
        const isWarrantyDcn = /^0+\d/.test(dcn);   // DCN was zero-padded -> warranty

        let credit_type, claim_no;
        if (isWarrantyDcn) {
            credit_type = 'warranty';
            claim_no    = stripped || null;
        } else {
            credit_type = 'bsi';
            claim_no    = null;
        }
        // (knownClaimNos is intentionally unused for classification — see
        // doc-comment above. Callers that want to flag orphan warranty
        // items can compare claim_no against the set themselves.)
        void knownClaimNos;

        return {
            credit_type:                          credit_type,
            claim_no:                             claim_no,
            doc_no:                               null, // filled by relink_bmw_bsi_credits()
            claimant:                             _str(r['claimant']),
            credit_note_number:                   cnn,
            credit_note_date:                     toIsoDate(r['credit note date']),
            bmw_internal_claim:                   _str(r['claim']),
            dealer_claim_number:                  dcn,
            brand:                                _str(r['brand']),
            vin:                                  _str(r['vin']),
            repair_date:                          toIsoDate(r['repair date']),
            ws_indicator:                         _str(r['ws indicator']),
            defect_code:                          _str(r['defect code']),
            defect_text:                          _str(r['defect code text']),
            claim_item_number:                    itemNo,
            claim_item_position:                  itemPos,
            claim_item_description:               _str(r['claim item description']),
            claim_item_type:                      _str(r['claim item type']),
            accepted_price_excl_hc:               toNumber(r['accepted price w/o hc']),
            hc:                                   toNumber(r['hc']),
            tax:                                  toNumber(r['tax']),
            accepted_price_incl_hc_excl_tax:      toNumber(r['accepted price incl hc/excl tax']),
            accepted_price_incl_tax_hc:           toNumber(r['accepted price incl tax/hc']),
            claimed_pct:                          toNumber(r['claimed percent']),
            accepted_pct:                         toNumber(r['accepted %']),
            claimed_pct_initial:                  toNumber(r['claimed percent initial']),
            claimed_qty:                          toNumber(r['claimed quantity']),
            claimed_qty_initial:                  toNumber(r['claimed quantity initial']),
            accepted_qty:                         toNumber(r['accepted quantity']),
            claimed_price:                        toNumber(r['claimed price']),
            difference_claimed_accepted:          toNumber(r['difference claimed accepted']),
            crediting_item_status:                _str(r['crediting item status']),
            crediting_status:                     _str(r['crediting status']),
            item_crediting_status:                _str(r['item crediting status']),
            most_decisive_message:                _str(r['most decisive message item'])
                                                  || _str(r['most decisive mess.']),
            collective_claim_ref:                 _str(r['collective claim reference']),
            plant:                                _str(r['plant']),
            processing_status:                    _str(r['processing status']),
            unit_of_measure:                      _str(r['unit of measure']),
            version_currency:                     _str(r['version currency'])
        };
    }


    // -----------------------------------------------------------------
    // 7. Public namespace
    // -----------------------------------------------------------------
    global.BMWParser = {
        // CDN + parsing
        loadXlsxLib:     loadXlsxLib,
        readWorkbook:    readWorkbook,
        detectFileKind:  detectFileKind,
        parseFile:       parseFile,
        parseFiles:      parseFiles,

        // Coercion
        toIsoDate:       toIsoDate,
        toNumber:        toNumber,
        toInt:           toInt,
        toBool:          toBool,

        // Mappers
        mapInvoiceRow:    mapInvoiceRow,
        mapClaimRow:      mapClaimRow,
        mapCreditItemRow: mapCreditItemRow,

        // Internal (exposed for tests)
        _normalizeHeader: _normalizeHeader,
        _FILE_SIGNATURES: FILE_SIGNATURES,
        _XLSX_CDN_CHAIN:  XLSX_CDN_CHAIN
    };

})(typeof window !== 'undefined' ? window : globalThis);
