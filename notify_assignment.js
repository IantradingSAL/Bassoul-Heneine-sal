// notify_assignment.js — shared "you were assigned something"
// notifier. Used from any register where a record's owner column
// changes (customer_feedback.assigned_to, non_conformity_reports
// .assigned_to, internal_audits.auditor …).
//
// Resolves the assignee (direct name OR "role:xxx") to one or
// more active employees from public.employees, then notifies
// each via:
//   - email    via CW_Notify.sendEmail    (Brevo SMTP API)
//   - WhatsApp via CW_Notify.sendWhatsApp (Brevo WhatsApp API)
// Skips whichever channel is missing a contact point (no email /
// synthetic @cedarwings.local address / no phone). Silent-skips
// entirely if Brevo isn't configured in Settings. Every send
// is recorded in public.notification_log by brevo.js.
//
// Usage:
//   import { notifyAssignees } from './notify_assignment.js'
//   await notifyAssignees(sb, assignee, {
//     type:       'nc_assignment',       // notification_log.type
//     subjectPrefix: '[Cedarwings] NC',  // email subject prefix
//     title:      'NC-2026-008 assigned to you',
//     headline:   'A non-conformity report has been assigned to you',
//     iso:        'ISO 13485 §8.3',
//     severity:   'HIGH',                // uppercase
//     severityColor: '#f97316',          // hex
//     facts: [                           // rendered as a small list
//       ['Customer', 'Dr. Martin'],
//       ['Case #',  '5234'],
//     ],
//     body:       'Free-text body preview (first 200 chars).',
//     link:       'https://…/non_conformity.html?open=<id>',
//   })

import { CW_Notify } from './brevo.js'

function esc(s) {
  return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
}

async function _resolvePeople(sb, assignee) {
  if (!assignee) return []
  if (String(assignee).startsWith('role:')) {
    const role = String(assignee).slice(5)
    const { data } = await sb.from('employees')
      .select('name, email, phone, whatsapp_phone, notification_prefs, role, custom_role, extra_roles, is_active')
      .eq('is_active', true)
    return (data || []).filter(e =>
      e.role === role || e.custom_role === role ||
      (Array.isArray(e.extra_roles) && e.extra_roles.includes(role)) ||
      (typeof e.extra_roles === 'string' && e.extra_roles.includes(role))
    )
  }
  const { data: emp } = await sb.from('employees')
    .select('name, email, phone, whatsapp_phone, notification_prefs').ilike('name', assignee).maybeSingle()
  return emp ? [emp] : []
}

// Missing / legacy pref defaults to "enabled" — preserves
// existing behaviour for users who never set preferences.
function _channelEnabled(prefs, channel) {
  if (!prefs || typeof prefs !== 'object') return true
  return prefs[channel] !== false
}

function _buildEmailHtml(ctx) {
  const factRows = (ctx.facts || [])
    .filter(f => f && f[1])
    .map(f => `<div style="font-size:13px;color:#0f172a;margin-bottom:4px"><strong>${esc(f[0])}:</strong> ${esc(f[1])}</div>`)
    .join('')
  return `
    <div style="font-family:Arial,sans-serif;max-width:560px;color:#0f172a">
      <h2 style="margin:0 0 8px;font-size:17px">${esc(ctx.headline || 'A record has been assigned to you')}</h2>
      <p style="margin:6px 0;color:#64748b;font-size:13px">Cedarwings SAS${ctx.iso ? ' · ' + esc(ctx.iso) : ''}</p>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;margin:14px 0">
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
          ${ctx.severity ? `<span style="background:${ctx.severityColor||'#64748b'};color:#fff;padding:2px 10px;border-radius:999px;font-size:10px;font-weight:700">${esc(ctx.severity)}</span>` : ''}
          <strong style="font-size:14px">${esc(ctx.title || '')}</strong>
        </div>
        ${factRows}
        ${ctx.body ? `<div style="font-size:13px;color:#334155;margin-top:8px;padding-top:8px;border-top:1px solid #e2e8f0">${esc(ctx.body)}</div>` : ''}
      </div>
      ${ctx.link ? `<a href="${esc(ctx.link)}" style="display:inline-block;background:#3b5fe2;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px">Open the record →</a>` : ''}
      <p style="font-size:11px;color:#94a3b8;margin-top:18px">You received this because you were assigned to this record in the Cedarwings operations platform. If you weren't expecting this, please contact your manager.</p>
    </div>`
}

function _buildWhatsApp(ctx) {
  const lines = []
  lines.push(`🔔 *Cedarwings* — ${ctx.title || 'Assignment'}`)
  for (const [k, v] of (ctx.facts || [])) {
    if (v) lines.push(`${k}: ${v}`)
  }
  if (ctx.severity) lines.push(`Severity: ${ctx.severity}`)
  if (ctx.body) lines.push('', ctx.body)
  if (ctx.link) lines.push('', `Open: ${ctx.link}`)
  return lines.join('\n')
}

export async function notifyAssignees(sb, assignee, ctx) {
  const people = await _resolvePeople(sb, assignee)
  if (!people.length) return

  const subjectPrefix = ctx.subjectPrefix || '[Cedarwings]'
  const type          = ctx.type || 'assignment'
  const html          = _buildEmailHtml(ctx)
  const wa            = _buildWhatsApp(ctx)
  const subject       = `${subjectPrefix} ${ctx.title || 'assigned to you'}`

  for (const p of people) {
    const prefs = p.notification_prefs
    const validEmail = p.email && p.email.includes('@') && !p.email.endsWith('@cedarwings.local')
    if (validEmail && _channelEnabled(prefs, 'email')) {
      await CW_Notify.sendEmail(p.email, p.name || assignee, subject, html, type)
    }
    // Phone numbers are tried against WhatsApp (Brevo) AND SMS
    // (Twilio). Each channel skips silently if it isn't
    // configured in Settings OR the user has opted out.
    const raw = (p.whatsapp_phone || p.phone || '').toString().replace(/[^\d+]/g, '')
    if (raw && raw.length >= 8) {
      const waNum  = raw.replace(/^\+/, '')                 // Brevo WhatsApp wants digits only
      const smsNum = raw.startsWith('+') ? raw : ('+' + raw) // Twilio wants E.164
      if (_channelEnabled(prefs, 'whatsapp')) await CW_Notify.sendWhatsApp(waNum, wa, type)
      if (_channelEnabled(prefs, 'sms'))      await CW_Notify.sendSms(smsNum, wa, type)
    }
  }
}
