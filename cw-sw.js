// ═════════════════════════════════════════════════════════════════
//  cw-sw.js — minimal service worker for Bassoul, Heneine Sal
// ─────────────────────────────────────────────────────────────────
//  Two responsibilities:
//   1) Receive messages posted from notifications.js (in-tab events)
//      and show them as OS-level Notifications when the tab is in
//      the background or other tabs are focused.
//   2) Handle clicks on those Notifications — focus an existing tab
//      with the matching link, or open a new one.
//
//  Note about "even if the system is closed":
//   Truly closed-browser delivery requires Web Push (VAPID + a
//   server pushing). That needs an Edge Function which our earlier
//   experiment showed is currently unreliable to deploy here, so
//   this SW is the maximum-coverage version that doesn't depend on
//   Edge Functions: notifications fire whenever the user has any
//   tab of the site open in the background — even minimised. For
//   fully-closed-browser delivery we can add Web Push later.
// ═════════════════════════════════════════════════════════════════

const CW_NOTIF_TAG_PREFIX = 'cw-notif-'

self.addEventListener('install', e => { self.skipWaiting() })
self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()) })

// Receive a "show this notification" command from any tab
self.addEventListener('message', event => {
  const data = event.data
  if (!data || data.type !== 'cw-show-notification') return
  const n = data.payload || {}
  const title = n.title || 'New notification'
  const opts  = {
    body:    n.body || '',
    tag:     CW_NOTIF_TAG_PREFIX + (n.id || Date.now()),
    icon:    n.icon || 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="%233b5fe2"/><text x="50%" y="58%" font-family="system-ui" font-size="34" font-weight="800" text-anchor="middle" fill="white">BH</text></svg>',
    badge:   n.icon || undefined,
    data:    { url: n.link_url || '/' },
    requireInteraction: false,
    silent:  false,
    renotify: true
  }
  event.waitUntil(self.registration.showNotification(title, opts))
})

// Click handler — focus or open the right page
self.addEventListener('notificationclick', event => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    // If a tab is already open on our origin, focus it and navigate
    for (const c of allClients) {
      if ('focus' in c && 'navigate' in c) {
        await c.focus()
        try { await c.navigate(url) } catch {}
        return
      }
    }
    // Otherwise open a new one
    if (self.clients.openWindow) await self.clients.openWindow(url)
  })())
})
