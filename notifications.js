// ═════════════════════════════════════════════════════════════════
//  notifications.js — bell + panel + OS-level alerts
// ─────────────────────────────────────────────────────────────────
//  Behavior summary
//   • On EVERY page that has a `.topbar`, a 🔔 bell appears in the
//     top-right with a red badge showing UNREAD count.
//   • UNREAD = read_at IS NULL. "Skip" only sets dismissed_at —
//     the badge stays red until the user clicks the row to open
//     the case/chat (which marks it read).
//   • When a new notification arrives:
//       – tab focused      → in-app toast + chime sound
//       – tab unfocused    → OS notification via service worker
//                            (chime + popup)
//       – page completely
//         closed (no tab)  → at next login, the dashboard shows
//                            every still-unread item by auto-
//                            opening the panel
//   • The user is asked ONCE for browser notification permission.
//     If they decline, in-app toasts still work.
// ═════════════════════════════════════════════════════════════════
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { SUPABASE_CONFIG } from './config.js'

const sb = createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey)
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))

let notifications = []
let myEmployeeId  = null
let myName        = ''
let bellWrap      = null
let panel         = null
let realtimeChan  = null
let swReg         = null   // service worker registration (for OS notifications)

// ── tiny helpers ────────────────────────────────────────────────
function timeAgo(iso){
  const sec = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (sec < 60)        return sec + 's ago'
  if (sec < 3600)      return Math.floor(sec / 60) + 'm ago'
  if (sec < 86400)     return Math.floor(sec / 3600) + 'h ago'
  if (sec < 604800)    return Math.floor(sec / 86400) + 'd ago'
  return new Date(iso).toLocaleDateString()
}
function iconFor(type){
  return ({ dm_message:'💬', case_assigned:'📌', case_reply:'📨', chat_message:'📣' })[type] || '🔔'
}
function colorFor(type){
  return ({
    dm_message:    'var(--cw-notif-blue,#3b5fe2)',
    case_assigned: 'var(--cw-notif-amber,#d97706)',
    case_reply:    'var(--cw-notif-green,#16a34a)',
    chat_message:  'var(--cw-notif-purple,#7c3aed)'
  })[type] || '#64748b'
}
function isVisible(){
  return typeof document.visibilityState === 'undefined' || document.visibilityState === 'visible'
}

// ── chime — synthesized via WebAudio so we ship no audio file ──
let _audioCtx = null
function playChime(){
  try {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    const ctx  = _audioCtx
    const now  = ctx.currentTime
    // Two-tone "ding" — A5 then C#6
    ;[
      { f: 880,    t: now,        d: 0.18 },
      { f: 1108.7, t: now + 0.14, d: 0.22 }
    ].forEach(({ f, t, d }) => {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = 'sine'; o.frequency.setValueAtTime(f, t)
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, t + d)
      o.connect(g); g.connect(ctx.destination)
      o.start(t); o.stop(t + d + 0.02)
    })
  } catch {}
}

// ── styles, injected once ───────────────────────────────────────
function injectStyles(){
  if (document.getElementById('cw-notif-style')) return
  const s = document.createElement('style')
  s.id = 'cw-notif-style'
  s.textContent = `
.cw-bell-wrap{position:relative;display:inline-flex;align-items:center;flex-shrink:0;margin-left:auto}
.cw-bell{width:38px;height:38px;border-radius:10px;border:1px solid #e2e8f0;background:#fff;font-size:18px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;transition:background .12s,border-color .12s,transform .12s;font-family:inherit}
.cw-bell:hover{background:#f8fafc;border-color:#3b5fe2}
.cw-bell.shake{animation:cwBellShake .55s ease-in-out}
@keyframes cwBellShake{0%,100%{transform:rotate(0)}15%{transform:rotate(-18deg)}30%{transform:rotate(14deg)}45%{transform:rotate(-10deg)}60%{transform:rotate(7deg)}75%{transform:rotate(-3deg)}}
.cw-bell-badge{position:absolute;top:-4px;right:-4px;background:#dc2626;color:#fff;font-size:10px;font-weight:800;border-radius:999px;min-width:18px;height:18px;padding:0 5px;display:none;align-items:center;justify-content:center;border:2px solid #fff;line-height:1;animation:cwPulse 2s infinite}
.cw-bell-badge.on{display:inline-flex}
@keyframes cwPulse{0%,100%{box-shadow:0 0 0 0 rgba(220,38,38,.6)}50%{box-shadow:0 0 0 6px rgba(220,38,38,0)}}
.cw-panel{position:absolute;top:calc(100% + 10px);right:0;width:380px;max-width:calc(100vw - 24px);max-height:560px;background:#fff;border:1px solid #e2e8f0;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.18),0 0 0 1px rgba(0,0,0,.04);display:none;flex-direction:column;z-index:500;overflow:hidden;font-family:'DM Sans',sans-serif}
.cw-panel.on{display:flex;animation:cwPanelIn .18s ease-out}
@keyframes cwPanelIn{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}
.cw-panel-h{padding:14px 18px;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;gap:8px}
.cw-panel-t{font-size:14px;font-weight:800;letter-spacing:-.2px;color:#0f172a;display:flex;align-items:center;gap:8px}
.cw-panel-t .num{background:#dc2626;color:#fff;font-size:10px;font-weight:800;border-radius:999px;min-width:18px;height:18px;padding:0 5px;display:none;align-items:center;justify-content:center;line-height:1}
.cw-panel-t .num.on{display:inline-flex}
.cw-panel-act{font-size:11px;font-weight:600;color:#3b5fe2;background:transparent;border:none;cursor:pointer;font-family:inherit;padding:4px 8px;border-radius:6px;white-space:nowrap}
.cw-panel-act:hover{background:#eef2ff}
.cw-panel-act:disabled{color:#94a3b8;cursor:default;background:transparent}
.cw-panel-list{flex:1;overflow-y:auto;padding:6px}
.cw-perm-bar{margin:6px;padding:9px 11px;background:#fffbeb;border:1px solid #fde68a;border-radius:9px;font-size:11.5px;color:#78350f;display:flex;align-items:center;gap:8px;line-height:1.4}
.cw-perm-bar button{margin-left:auto;background:#d97706;color:#fff;border:none;padding:5px 10px;border-radius:7px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;flex-shrink:0}
.cw-perm-bar button:hover{background:#b45309}
.cw-notif{display:flex;gap:10px;padding:11px 12px;border-radius:10px;cursor:pointer;transition:background .1s;border:1px solid transparent;align-items:flex-start;margin-bottom:2px}
.cw-notif:hover{background:#f8fafc}
.cw-notif.unread{background:#eef2ff;border-color:#dbeafe}
.cw-notif.unread:hover{background:#e0e7ff}
.cw-notif.dismissed{opacity:.55}
.cw-n-icon{width:34px;height:34px;border-radius:10px;display:inline-flex;align-items:center;justify-content:center;font-size:15px;color:#fff;flex-shrink:0;margin-top:2px}
.cw-n-body{flex:1;min-width:0}
.cw-n-title{font-size:12.5px;font-weight:700;color:#0f172a;line-height:1.3;letter-spacing:-.1px}
.cw-n-text{font-size:11.5px;color:#64748b;margin-top:3px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.cw-n-foot{display:flex;align-items:center;justify-content:space-between;margin-top:6px;gap:8px}
.cw-n-time{font-size:10px;color:#94a3b8;font-variant-numeric:tabular-nums}
.cw-n-actions{display:flex;gap:5px}
.cw-n-btn{font-size:10px;font-weight:700;border-radius:6px;cursor:pointer;padding:3px 9px;font-family:inherit;transition:all .12s;border:1px solid transparent}
.cw-n-skip{color:#64748b;border-color:#e2e8f0;background:#fff}
.cw-n-skip:hover{color:#dc2626;border-color:#dc2626;background:#fef2f2}
.cw-n-open{color:#fff;background:#3b5fe2;border-color:#3b5fe2}
.cw-n-open:hover{background:#2e4fc7;border-color:#2e4fc7}
.cw-panel-empty{text-align:center;padding:40px 24px;color:#94a3b8;font-size:13px}
.cw-panel-empty .em{font-size:36px;margin-bottom:10px;opacity:.6}
.cw-panel-foot{padding:9px 18px;font-size:10.5px;color:#94a3b8;border-top:1px solid #e2e8f0;text-align:center;flex-shrink:0;line-height:1.4}
.cw-toast{position:fixed;bottom:20px;right:20px;width:340px;max-width:calc(100vw - 24px);background:#fff;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.18),0 0 0 1px rgba(0,0,0,.04);padding:14px 16px;z-index:600;display:flex;gap:10px;cursor:pointer;transform:translateX(120%);transition:transform .25s ease;font-family:'DM Sans',sans-serif}
.cw-toast.on{transform:translateX(0)}
.cw-toast-icon{width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:16px;flex-shrink:0}
.cw-toast-body{flex:1;min-width:0}
.cw-toast-t{font-size:13px;font-weight:800;color:#0f172a;letter-spacing:-.1px;line-height:1.3}
.cw-toast-x{font-size:11px;color:#64748b;margin-top:4px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
@media (max-width:600px){.cw-panel{position:fixed;top:auto;bottom:0;right:0;left:0;width:100%;max-width:100%;border-radius:14px 14px 0 0;max-height:70vh}}

/* ── WELCOME MODAL — appears on dashboard sign-in if there are unread items ── */
.cw-welcome-bg{position:fixed;inset:0;background:rgba(15,23,42,.55);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);z-index:700;display:flex;align-items:center;justify-content:center;padding:24px 16px;opacity:0;pointer-events:none;transition:opacity .25s ease}
.cw-welcome-bg.on{opacity:1;pointer-events:auto}
.cw-welcome{width:560px;max-width:100%;background:#fff;border-radius:18px;box-shadow:0 24px 64px rgba(0,0,0,.28),0 0 0 1px rgba(0,0,0,.04);overflow:hidden;display:flex;flex-direction:column;max-height:calc(100vh - 48px);transform:scale(.96) translateY(8px);transition:transform .28s cubic-bezier(.16,1,.3,1);font-family:'DM Sans',system-ui,sans-serif}
.cw-welcome-bg.on .cw-welcome{transform:scale(1) translateY(0)}
.cw-welcome-h{padding:22px 24px;border-bottom:1px solid #e2e8f0;display:flex;align-items:flex-start;gap:14px;flex-shrink:0}
.cw-welcome-h-icon{font-size:34px;line-height:1;flex-shrink:0;animation:cwBellShake 1.2s ease-in-out infinite;animation-delay:.4s}
.cw-welcome-h-text{flex:1;min-width:0}
.cw-welcome-t{font-size:18px;font-weight:800;color:#0f172a;letter-spacing:-.4px;line-height:1.25}
.cw-welcome-s{font-size:12.5px;color:#64748b;margin-top:5px;line-height:1.5}
.cw-welcome-list{flex:1;overflow-y:auto;padding:8px 16px}
.cw-welcome-section{margin:10px 0 4px}
.cw-welcome-section-h{font-size:10.5px;font-weight:800;color:#64748b;letter-spacing:.06em;text-transform:uppercase;padding:0 4px 6px;display:flex;align-items:center;gap:6px}
.cw-welcome-section-h .ct{background:#f1f5f9;color:#475569;font-size:10px;font-weight:700;padding:1px 7px;border-radius:999px}
.cw-welcome-item{display:flex;align-items:center;gap:14px;padding:14px;border-radius:12px;cursor:pointer;border:1px solid #e2e8f0;background:#fff;transition:all .12s;margin-bottom:6px;position:relative}
.cw-welcome-item:hover{border-color:#3b5fe2;background:#eef2ff;transform:translateY(-1px)}
.cw-welcome-item-bar{position:absolute;left:0;top:8px;bottom:8px;width:3px;border-radius:0 3px 3px 0;background:#3b5fe2}
.cw-welcome-item-icon{width:38px;height:38px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:17px;color:#fff;flex-shrink:0;margin-left:6px}
.cw-welcome-item-body{flex:1;min-width:0}
.cw-welcome-item-meta{font-size:10.5px;color:#94a3b8;font-weight:600;display:flex;gap:6px;align-items:center;line-height:1.4}
.cw-welcome-item-title{font-size:13.5px;font-weight:700;color:#0f172a;margin-top:2px;line-height:1.3;letter-spacing:-.1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cw-welcome-item-snippet{font-size:11.5px;color:#64748b;margin-top:3px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.cw-welcome-item-arrow{font-size:18px;color:#3b5fe2;opacity:.7;flex-shrink:0}
.cw-welcome-item:hover .cw-welcome-item-arrow{opacity:1;transform:translateX(2px);transition:all .12s}
.cw-welcome-foot{padding:14px 22px;border-top:1px solid #e2e8f0;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-shrink:0;background:#f8fafc;flex-wrap:wrap}
.cw-welcome-foot-info{font-size:10.5px;color:#94a3b8;font-weight:500;flex:1;min-width:140px}
.cw-welcome-foot-btns{display:flex;gap:8px;flex-shrink:0}
.cw-welcome-btn{font-size:12.5px;font-weight:700;padding:9px 18px;border-radius:10px;border:1px solid #e2e8f0;background:#fff;color:#475569;cursor:pointer;font-family:inherit;letter-spacing:-.1px;transition:all .12s}
.cw-welcome-btn:hover{border-color:#94a3b8;color:#0f172a;background:#fff}
.cw-welcome-btn.primary{background:#3b5fe2;color:#fff;border-color:#3b5fe2;box-shadow:0 4px 12px rgba(59,95,226,.28)}
.cw-welcome-btn.primary:hover{background:#2e4fc7;border-color:#2e4fc7;box-shadow:0 6px 16px rgba(59,95,226,.36)}

@media (max-width:600px){
  .cw-welcome-bg{padding:0;align-items:flex-end}
  .cw-welcome{max-width:100%;border-radius:18px 18px 0 0;max-height:90vh}
  .cw-welcome-h{padding:18px 18px 14px}
  .cw-welcome-t{font-size:16px}
  .cw-welcome-foot{padding:12px 16px}
  .cw-welcome-foot-info{font-size:10px;flex:1 1 100%;order:2;text-align:center}
  .cw-welcome-foot-btns{flex:1 1 100%;order:1}
  .cw-welcome-btn{flex:1;text-align:center}
}
`
  document.head.appendChild(s)
}

// ── derive counts ───────────────────────────────────────────────
function unreadCount(){ return notifications.filter(n => !n.read_at).length }
function visibleList(){
  // In the panel we show: all unread (incl. dismissed in muted style),
  // plus the most recent 25 already-read items for context.
  const unread = notifications.filter(n => !n.read_at)
  const read   = notifications.filter(n => n.read_at).slice(0, 25)
  return [...unread, ...read]
}

function updateBadge(){
  if (!bellWrap) return
  const b = bellWrap.querySelector('.cw-bell-badge')
  const n = unreadCount()
  b.textContent = n > 99 ? '99+' : String(n)
  b.classList.toggle('on', n > 0)
  // Browser tab title
  document.title = (n > 0 ? `(${n}) ` : '') + document.title.replace(/^\(\d+\)\s/, '')
}

function renderPanel(){
  if (!panel) return
  const list  = panel.querySelector('.cw-panel-list')
  const cnt   = panel.querySelector('.cw-panel-t .num')
  const u     = unreadCount()
  cnt.textContent = u
  cnt.classList.toggle('on', u > 0)
  panel.querySelector('.cw-panel-act').disabled = (u === 0)

  // Notification permission banner
  let permBar = ''
  if ('Notification' in window && Notification.permission === 'default') {
    permBar = `<div class="cw-perm-bar">
      🔔 Enable browser notifications so you hear a chime and see a popup even when this tab is in the background.
      <button id="cwNotifPermBtn">Enable</button>
    </div>`
  }

  const visible = visibleList()
  if (!visible.length) {
    list.innerHTML = permBar + `<div class="cw-panel-empty">
      <div class="em">📭</div>
      <div><strong>You're all caught up</strong></div>
      <div style="margin-top:6px;font-size:11px">DMs, case assignments, and replies will show here.</div>
    </div>`
  } else {
    list.innerHTML = permBar + visible.map(n => {
      const unread    = !n.read_at
      const dismissed = unread && n.dismissed_at
      return `<div class="cw-notif ${unread?'unread':''} ${dismissed?'dismissed':''}" data-id="${esc(n.id)}">
        <div class="cw-n-icon" style="background:${colorFor(n.type)}">${iconFor(n.type)}</div>
        <div class="cw-n-body">
          <div class="cw-n-title">${esc(n.title)}</div>
          ${n.body ? `<div class="cw-n-text">${esc(n.body)}</div>` : ''}
          <div class="cw-n-foot">
            <span class="cw-n-time">${esc(timeAgo(n.created_at))}${dismissed?' · skipped':''}</span>
            ${unread ? `<div class="cw-n-actions">
              ${dismissed ? '' : `<button class="cw-n-btn cw-n-skip" data-skip="${esc(n.id)}">Skip</button>`}
              <button class="cw-n-btn cw-n-open" data-open="${esc(n.id)}">Open ${n.type === 'dm_message' ? 'chat' : 'case'}</button>
            </div>` : ''}
          </div>
        </div>
      </div>`
    }).join('')
  }

  // wire row + button handlers
  list.querySelectorAll('.cw-notif').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('[data-skip]') || e.target.closest('[data-open]') || e.target.closest('#cwNotifPermBtn')) return
      const n = notifications.find(x => x.id === el.dataset.id)
      if (n && !n.read_at) openNotification(n)
      else if (n) openNotification(n)   // already-read row also navigates
    })
  })
  list.querySelectorAll('[data-skip]').forEach(b => {
    b.addEventListener('click', async e => { e.stopPropagation(); await skipNotification(b.dataset.skip) })
  })
  list.querySelectorAll('[data-open]').forEach(b => {
    b.addEventListener('click', async e => {
      e.stopPropagation()
      const n = notifications.find(x => x.id === b.dataset.open)
      if (n) openNotification(n)
    })
  })
  const permBtn = list.querySelector('#cwNotifPermBtn')
  if (permBtn) permBtn.addEventListener('click', async e => {
    e.stopPropagation()
    await requestNotificationPermission()
    renderPanel()
  })
}

// ── data load ───────────────────────────────────────────────────
async function loadNotifications(){
  const { data, error } = await sb.from('notifications')
    .select('id,recipient_id,actor_id,actor_name,type,title,body,link_url,read_at,dismissed_at,created_at')
    .order('created_at', { ascending: false })
    .limit(80)
  if (error) { console.warn('notifications load failed:', error.message); return }
  notifications = data || []
  updateBadge()
  renderPanel()
}

async function skipNotification(id){
  // Local state: mark dismissed in panel — but unread count is UNCHANGED
  const n = notifications.find(x => x.id === id); if (!n || n.read_at) return
  n.dismissed_at = new Date().toISOString()
  renderPanel()
  await sb.from('notifications').update({ dismissed_at: n.dismissed_at }).eq('id', id)
}

async function markRead(id){
  const n = notifications.find(x => x.id === id); if (!n || n.read_at) return
  n.read_at = new Date().toISOString()
  updateBadge(); renderPanel()
  await sb.from('notifications').update({ read_at: n.read_at }).eq('id', id)
}

async function markAllRead(){
  const unread = notifications.filter(n => !n.read_at)
  if (!unread.length) return
  const ids = unread.map(n => n.id)
  const now = new Date().toISOString()
  unread.forEach(n => n.read_at = now)
  updateBadge(); renderPanel()
  await sb.from('notifications').update({ read_at: now }).in('id', ids)
}

// ── click → navigate ────────────────────────────────────────────
async function openNotification(n){
  await markRead(n.id)
  if (n.link_url) location.href = n.link_url
  else closePanel()
}

// ── service worker + browser notifications ──────────────────────
async function registerServiceWorker(){
  if (!('serviceWorker' in navigator)) return null
  try {
    const reg = await navigator.serviceWorker.register('cw-sw.js')
    return reg.active ? reg : (await navigator.serviceWorker.ready)
  } catch (err) {
    console.warn('SW registration failed:', err); return null
  }
}

async function requestNotificationPermission(){
  if (!('Notification' in window)) return 'unsupported'
  if (Notification.permission === 'granted') return 'granted'
  if (Notification.permission === 'denied')  return 'denied'
  try {
    const r = await Notification.requestPermission()
    return r
  } catch { return 'default' }
}

function showOSNotification(n){
  if (!('Notification' in window) || Notification.permission !== 'granted') return false
  const payload = { id: n.id, title: n.title, body: n.body, link_url: n.link_url, type: n.type }
  // Prefer the SW path so click works even after page is closed
  if (swReg && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({ type: 'cw-show-notification', payload })
    return true
  }
  // Fallback — direct Notification (still works while page is alive)
  try {
    const notif = new Notification(n.title, { body: n.body || '', tag: 'cw-notif-' + n.id })
    notif.onclick = () => { window.focus(); if (n.link_url) location.href = n.link_url }
    return true
  } catch { return false }
}

// ── live realtime updates + toast ───────────────────────────────
function showToast(n){
  const t = document.createElement('div')
  t.className = 'cw-toast'
  t.innerHTML = `
    <div class="cw-toast-icon" style="background:${colorFor(n.type)}">${iconFor(n.type)}</div>
    <div class="cw-toast-body">
      <div class="cw-toast-t">${esc(n.title)}</div>
      ${n.body ? `<div class="cw-toast-x">${esc(n.body)}</div>` : ''}
    </div>`
  document.body.appendChild(t)
  setTimeout(() => t.classList.add('on'), 30)
  t.addEventListener('click', () => openNotification(n))
  setTimeout(() => { t.classList.remove('on'); setTimeout(() => t.remove(), 300) }, 6000)
}

function shakeBell(){
  if (!bellWrap) return
  const b = bellWrap.querySelector('.cw-bell')
  b.classList.remove('shake'); void b.offsetWidth; b.classList.add('shake')
}

function subscribe(){
  if (realtimeChan || !myEmployeeId) return
  realtimeChan = sb.channel('cw-notifications')
    .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${myEmployeeId}` },
        payload => {
          const n = payload.new; if (!n) return
          if (notifications.find(x => x.id === n.id)) return
          notifications.unshift(n)
          updateBadge(); renderPanel()
          // Always: ring chime + shake bell
          playChime()
          shakeBell()
          // If tab is hidden → show OS notification
          // If tab is visible → show in-app toast
          if (!isVisible() && Notification.permission === 'granted') {
            showOSNotification(n)
          } else {
            showToast(n)
          }
        })
    .subscribe()
}

// ── panel open/close ────────────────────────────────────────────
function openPanel(){ if (panel) panel.classList.add('on') }
function closePanel(){ if (panel) panel.classList.remove('on') }
function togglePanel(){ if (panel) panel.classList.toggle('on') }

// ── WELCOME MODAL ──────────────────────────────────────────────
// Single, friendly pop-up shown once on dashboard sign-in, aggregating
// every still-unread notification into grouped sections. Pressing
// "Later" (or the backdrop) just hides the modal — the bell + footer
// red badge stay until the user actually opens each item, so nothing
// gets lost. The bell continues to handle in-session new arrivals.
function showWelcomeModal(){
  // Only useful items (those with a link to act on)
  const unread = notifications.filter(n => !n.read_at)
  if (!unread.length) return

  // Group by type — gives a cleaner scan when many items
  const groups = {
    dm_message:    { label: 'Chat messages',    icon: '💬', items: [] },
    chat_message:  { label: 'Chat messages',    icon: '💬', items: [] },
    case_assigned: { label: 'New case assignments', icon: '📌', items: [] },
    case_reply:    { label: 'Case replies',     icon: '📨', items: [] },
    other:         { label: 'Other notifications', icon: '🔔', items: [] }
  }
  unread.forEach(n => {
    const key = groups[n.type] ? n.type : 'other'
    groups[key].items.push(n)
  })
  // Merge dm_message + chat_message into one "Chat messages" group
  if (groups.chat_message.items.length){
    groups.dm_message.items.push(...groups.chat_message.items)
    groups.chat_message.items = []
  }

  // Build the section blocks
  const order = ['dm_message','case_assigned','case_reply','other']
  let html = ''
  for (const key of order){
    const g = groups[key]; if (!g.items.length) continue
    html += `<div class="cw-welcome-section">
      <div class="cw-welcome-section-h">
        <span>${g.icon} ${esc(g.label)}</span>
        <span class="ct">${g.items.length}</span>
      </div>`
    g.items.forEach(n => {
      html += `<div class="cw-welcome-item" data-id="${esc(n.id)}">
        <div class="cw-welcome-item-bar" style="background:${colorFor(n.type)}"></div>
        <div class="cw-welcome-item-icon" style="background:${colorFor(n.type)}">${iconFor(n.type)}</div>
        <div class="cw-welcome-item-body">
          <div class="cw-welcome-item-meta">${esc(n.actor_name || 'System')} · ${esc(timeAgo(n.created_at))}</div>
          <div class="cw-welcome-item-title">${esc(n.title || '')}</div>
          ${n.body ? `<div class="cw-welcome-item-snippet">${esc(n.body)}</div>` : ''}
        </div>
        <div class="cw-welcome-item-arrow">›</div>
      </div>`
    })
    html += '</div>'
  }

  // Decide the headline — "messages waiting" reads naturally for chat-heavy,
  // "items waiting" works generically
  const total = unread.length
  const onlyChat = (groups.dm_message.items.length === total)
  const headline = onlyChat
    ? `You have ${total} message${total===1?'':'s'} waiting for you`
    : `You have ${total} item${total===1?'':'s'} waiting for you`

  const greeting = myName
    ? `Welcome back, ${esc(myName.split(/\s+/)[0])}.`
    : 'Welcome back.'

  // Build & show the modal
  let bg = document.querySelector('.cw-welcome-bg')
  if (bg) bg.remove()
  bg = document.createElement('div')
  bg.className = 'cw-welcome-bg'
  bg.innerHTML = `
    <div class="cw-welcome" role="dialog" aria-label="Welcome">
      <div class="cw-welcome-h">
        <div class="cw-welcome-h-icon">🔔</div>
        <div class="cw-welcome-h-text">
          <div class="cw-welcome-t">${esc(headline)}</div>
          <div class="cw-welcome-s">${greeting} Pick one to handle now, or skip and come back later — the red badge will stay on the bell until you open it.</div>
        </div>
      </div>
      <div class="cw-welcome-list">${html}</div>
      <div class="cw-welcome-foot">
        <div class="cw-welcome-foot-info">Skipping leaves them in your bell so you don't lose track.</div>
        <div class="cw-welcome-foot-btns">
          <button class="cw-welcome-btn" data-act="later">Later</button>
          <button class="cw-welcome-btn primary" data-act="viewall">View all my cases →</button>
        </div>
      </div>
    </div>`
  document.body.appendChild(bg)
  // Trigger the open animation on the next paint
  requestAnimationFrame(() => bg.classList.add('on'))

  function close(){ bg.classList.remove('on'); setTimeout(() => bg.remove(), 280) }

  // Wire interactions
  bg.querySelectorAll('.cw-welcome-item').forEach(el => {
    el.addEventListener('click', () => {
      const n = notifications.find(x => x.id === el.dataset.id)
      if (n) {
        close()
        openNotification(n)   // marks read + navigates
      }
    })
  })
  bg.querySelector('[data-act="later"]').addEventListener('click', close)
  bg.querySelector('[data-act="viewall"]').addEventListener('click', () => {
    close()
    // Open the bell panel so they see the full list
    openPanel()
  })
  // Tap-outside-to-close
  bg.addEventListener('click', e => { if (e.target === bg) close() })
  // Esc to close
  const onEsc = e => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc) } }
  document.addEventListener('keydown', onEsc)
}
document.addEventListener('click', e => {
  if (!panel || !panel.classList.contains('on')) return
  if (e.target.closest('.cw-bell-wrap')) return
  if (!e.target.closest('.cw-panel')) closePanel()
})

// ── auto-mount into the topbar ──────────────────────────────────
function mount(){
  injectStyles()
  const topbar = document.querySelector('.topbar')
  if (!topbar) return
  if (topbar.querySelector('.cw-bell-wrap')) return

  bellWrap = document.createElement('div')
  bellWrap.className = 'cw-bell-wrap'
  bellWrap.innerHTML = `
    <button class="cw-bell" type="button" title="Notifications" aria-label="Notifications">🔔</button>
    <span class="cw-bell-badge"></span>
    <div class="cw-panel" role="dialog" aria-label="Notifications">
      <div class="cw-panel-h">
        <div class="cw-panel-t">Notifications <span class="num">0</span></div>
        <button class="cw-panel-act" type="button">Mark all read</button>
      </div>
      <div class="cw-panel-list"></div>
      <div class="cw-panel-foot">Skip = stays unread (red badge keeps showing) · Open = mark read &amp; go</div>
    </div>`
  topbar.appendChild(bellWrap)
  panel = bellWrap.querySelector('.cw-panel')

  bellWrap.querySelector('.cw-bell').addEventListener('click', e => {
    e.stopPropagation()
    // First click is a perfect time to "warm up" the audio context
    // because of browsers' autoplay policy
    if (!_audioCtx) try { _audioCtx = new (window.AudioContext||window.webkitAudioContext)() } catch {}
    togglePanel()
  })
  bellWrap.querySelector('.cw-panel-act').addEventListener('click', markAllRead)
}

// ── boot ────────────────────────────────────────────────────────
async function boot(){
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return
  const { data: meRow } = await sb.from('employees')
    .select('id,name').eq('auth_user_id', user.id).maybeSingle()
  if (!meRow) return
  myEmployeeId = meRow.id
  myName       = meRow.name || ''

  mount()
  swReg = await registerServiceWorker()
  await loadNotifications()
  subscribe()

  // On the dashboard, show a friendly welcome modal that aggregates
  // every still-unread notification (chat DMs, case replies, case
  // assignments) into one tidy popup. The bell + footer badge stay
  // independently — pressing "Later" leaves the red badge in place
  // so the user can't lose track. Same design language as the
  // customer-feedback "complaints waiting" greeting.
  if (document.body.dataset.cwPage === 'dashboard' && unreadCount() > 0) {
    setTimeout(showWelcomeModal, 700)
  }

  // Refresh "X minutes ago" labels every 30 s while the panel is open
  setInterval(() => { if (panel?.classList.contains('on')) renderPanel() }, 30000)

  // Re-fetch list whenever the tab becomes visible — catches anything
  // that arrived while the SW was the only thing awake.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') loadNotifications()
  })
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot)
} else {
  boot()
}
