// csv_export.js — tiny utility for generating a CSV file from
// an in-memory array of rows and triggering a browser download.
// Used from the register pages (customer_feedback, non_conformity,
// audit_log, internal_audit, …) so auditors can pull a filtered
// snapshot straight off the register without ad-hoc SQL.
//
// Usage:
//   import { downloadCsv } from './csv_export.js'
//   downloadCsv('feedback_2026-04-24.csv', [
//     { header: 'Date',     get: r => r.received_date },
//     { header: 'Customer', get: r => r.customer_name },
//     { header: 'Type',     get: r => r.type },
//   ], filteredRows)
//
// Quoting: fields containing comma / double-quote / newline are
// wrapped in " and internal " become "". A UTF-8 BOM is prepended
// so Excel opens accents correctly.

function esc(v) {
  if (v === null || v === undefined) return ''
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
  return s
}

export function buildCsv(columns, rows) {
  const header = columns.map(c => esc(c.header)).join(',')
  const body = (rows || []).map(r =>
    columns.map(c => {
      try { return esc(c.get(r)) } catch { return '' }
    }).join(',')
  )
  return '﻿' + [header, ...body].join('\r\n')
}

export function downloadCsv(filename, columns, rows) {
  const csv = buildCsv(columns, rows)
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// Convenience: today's date as YYYY-MM-DD for filenames.
export function todayIso() {
  const d = new Date()
  return d.toISOString().slice(0, 10)
}
