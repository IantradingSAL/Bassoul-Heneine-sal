// table_sort.js — adds click-to-sort to any <table> whose <th>
// elements declare data-sort="text"|"num"|"date". Loaded as a
// regular (non-module) script so it can be dropped onto any page
// without ceremony.
//
// Usage in HTML:
//   <th data-sort="text">Name</th>
//   <th data-sort="num">Amount</th>
//   <th data-sort="date">Received</th>
//
// First click sorts ascending, second descending, third clears.
// Sorts only the rows currently in the <tbody>; it does NOT
// re-render. Pages that re-render their tbody on filter change
// will lose the sort state — that's intentional.

(function () {
  function parseDate (s) {
    if (!s) return -Infinity
    var d = new Date(s)
    return isNaN(d.getTime()) ? -Infinity : d.getTime()
  }
  function parseNum (s) {
    if (s == null) return -Infinity
    var n = parseFloat(String(s).replace(/[^\d.\-]/g, ''))
    return isNaN(n) ? -Infinity : n
  }

  function sortTable (table, colIndex, type, dir) {
    var tbody = table.tBodies[0]; if (!tbody) return
    var rows = Array.prototype.slice.call(tbody.rows)
    rows.sort(function (a, b) {
      var av = (a.cells[colIndex] || {}).innerText || ''
      var bv = (b.cells[colIndex] || {}).innerText || ''
      var cmp
      if      (type === 'num')  cmp = parseNum(av)  - parseNum(bv)
      else if (type === 'date') cmp = parseDate(av) - parseDate(bv)
      else                      cmp = av.localeCompare(bv, undefined, { sensitivity: 'base' })
      return dir === 'desc' ? -cmp : cmp
    })
    rows.forEach(function (r) { tbody.appendChild(r) })
  }

  function attach (table) {
    var ths = table.tHead ? table.tHead.rows[0].cells : []
    Array.prototype.forEach.call(ths, function (th, i) {
      var type = th.getAttribute('data-sort')
      if (!type) return
      th.style.cursor = 'pointer'
      th.style.userSelect = 'none'
      th.addEventListener('click', function () {
        var dir = th.getAttribute('data-sort-dir')
        // cycle: none → asc → desc → none
        var next = dir === 'asc' ? 'desc' : dir === 'desc' ? '' : 'asc'
        // clear siblings
        Array.prototype.forEach.call(ths, function (other) {
          other.removeAttribute('data-sort-dir')
          var arrow = other.querySelector('.ts-arrow')
          if (arrow) arrow.remove()
        })
        if (next) {
          th.setAttribute('data-sort-dir', next)
          sortTable(table, i, type, next)
          var span = document.createElement('span')
          span.className = 'ts-arrow'
          span.textContent = next === 'asc' ? '  ▲' : '  ▼'
          span.style.fontSize = '9px'
          span.style.opacity = '.6'
          th.appendChild(span)
        }
      })
    })
  }

  function init () {
    document.querySelectorAll('table').forEach(function (t) {
      if (t.hasAttribute('data-ts-bound')) return
      t.setAttribute('data-ts-bound', '1')
      attach(t)
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
  // Re-bind whenever the page might have added new tables.
  window.cwTableSort = { rebind: init }
})()
