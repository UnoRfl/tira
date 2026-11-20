// Drains public.notifications and emails each one (booking confirmed / cancelled / moved).
// Woken every minute by pg_cron (migration 000006) with the private notify key in the body.
// Holds no database key: it calls claim/finish_notification with the public publishable key,
// and those refuse to work without the notify key. Gmail SMTP over 465 (25/587 are blocked on Edge).
// Secrets (set by hand in the dashboard): GMAIL_USER, GMAIL_APP_PASSWORD.
import nodemailer from 'npm:nodemailer@6.9.16';

const URL_ = Deno.env.get('SUPABASE_URL') ?? 'https://bloavrswkwhfrotpsswq.supabase.co';
const PUBLIC_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? 'sb_publishable_e-ywTqlKIjKu6f8xx8cZHQ_AHfPIdO2';
const SITE = 'https://unorfl.github.io/tira/';
const GMAIL_USER = Deno.env.get('GMAIL_USER');
const GMAIL_PASS = Deno.env.get('GMAIL_APP_PASSWORD');

type Note = {
  id: number; kind: string; email: string; name: string | null; club: string; timezone: string;
  payload: { ref_code: string; court_name: string; start: string; end: string; price_cents: number; currency: string; from?: { start: string } };
};

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const r = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: PUBLIC_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`${fn} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function when(n: Note, iso: string) {
  const d = new Date(iso);
  const day = d.toLocaleDateString('en-PH', { timeZone: n.timezone, weekday: 'long', month: 'long', day: 'numeric' });
  const t = (x: Date) => x.toLocaleTimeString('en-PH', { timeZone: n.timezone, hour: 'numeric', minute: '2-digit' });
  return { day, time: t(d), end: n.payload.end ? t(new Date(n.payload.end)) : '' };
}

function compose(n: Note) {
  const p = n.payload;
  const w = when(n, p.start);
  const price = p.price_cents ? `₱${(p.price_cents / 100).toLocaleString('en-PH')}` : '';
  const copy: Record<string, { tag: string; subject: string; title: string; line: string; pill: string }> = {
    booking_confirmed: { tag: 'Booked', subject: `Booked: ${p.court_name}, ${w.day} ${w.time}`, title: 'Your court is booked', line: 'Show this code at the desk when you arrive. Pay at the club.', pill: '#c8f169' },
    cancelled: { tag: 'Cancelled', subject: `Cancelled: ${p.court_name}, ${w.day} ${w.time}`, title: 'Your booking is cancelled', line: 'The court is free for someone else now. Book again any time.', pill: '#ece6dc' },
    cancelled_by_club: { tag: 'Cancelled by the club', subject: `The club cancelled your booking (${w.day})`, title: 'The club cancelled your booking', line: 'Sorry about this. Book another time or ask at the desk.', pill: '#ffd7c9' },
    moved_by_club: { tag: 'Moved', subject: `Your booking moved: ${p.court_name}, ${w.day} ${w.time}`, title: 'The club moved your booking', line: p.from?.start ? `It was ${when(n, p.from.start).day}, ${when(n, p.from.start).time}. Here is the new time.` : 'Here is the new time.', pill: '#c8f169' },
  };
  const c = copy[n.kind];
  if (!c) return null;
  const hi = n.name ? `Hi ${esc(n.name.split(' ')[0])},` : 'Hi,';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light only"><title>${esc(c.subject)}</title></head>
<body style="margin:0;padding:0;background:#f3eee6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3eee6;"><tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:460px;">
<tr><td style="padding:0 4px 20px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="vertical-align:middle;"><img src="${SITE}brand/logo-mark.png" width="36" height="36" alt="" style="display:block;border:0;border-radius:10px;"></td>
<td style="vertical-align:middle;padding-left:10px;"><div style="font-family:'Arial Narrow','Roboto Condensed','Helvetica Neue',Arial,sans-serif;font-stretch:condensed;font-size:27px;line-height:1;font-weight:900;letter-spacing:1px;color:#23212b;">TIRA<span style="display:inline-block;width:8px;height:8px;border-radius:8px;background:#c8f169;vertical-align:top;margin:-2px 0 0 3px;"></span></div>
<div style="font-family:'Segoe UI',Helvetica,Arial,sans-serif;font-size:8px;line-height:1;font-weight:800;letter-spacing:2.6px;color:#9893a2;margin-top:4px;">PICKLEBALL</div></td></tr></table></td></tr>
<tr><td style="background:#fbf8f3;border-radius:24px;padding:36px 32px 32px;box-shadow:0 18px 36px -16px rgba(84,62,32,0.28);font-family:'Segoe UI',Helvetica,Arial,sans-serif;color:#23212b;">
<p style="margin:0 0 6px;font-size:12px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:#605b6b;">${esc(c.tag)}</p>
<h1 style="margin:0 0 8px;font-size:24px;line-height:1.25;font-weight:800;letter-spacing:-0.5px;">${esc(c.title)}</h1>
<p style="margin:0 0 22px;font-size:15px;line-height:1.55;color:#605b6b;">${hi}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:${c.pill};border-radius:18px;padding:20px 22px;">
<div style="font-size:20px;font-weight:800;line-height:1.3;">${esc(w.day)}</div>
<div style="font-size:16px;font-weight:700;line-height:1.5;">${esc(w.time)}${w.end ? ' – ' + esc(w.end) : ''} · ${esc(p.court_name)}</div>
<div style="font-size:13px;font-weight:800;letter-spacing:3px;margin-top:10px;">${esc(p.ref_code)}${price ? `<span style="letter-spacing:0;font-weight:600;"> · ${price}</span>` : ''}</div>
</td></tr></table>
<p style="margin:22px 0 0;font-size:15px;line-height:1.55;color:#605b6b;">${esc(c.line)}</p>
<p style="margin:22px 0 0;"><a href="${SITE}#/me" style="display:inline-block;background:#23212b;color:#fbf8f3;text-decoration:none;font-weight:800;font-size:14px;padding:12px 20px;border-radius:14px;">My bookings</a></p>
</td></tr>
<tr><td align="center" style="padding:22px 8px 0;font-family:'Segoe UI',Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;color:#9893a2;">Tira · 2 pickleball courts · ₱500 per hour</td></tr>
</table></td></tr></table></body></html>`;
  const text = `${c.title}\n\n${w.day}, ${w.time}${w.end ? '–' + w.end : ''} · ${p.court_name}\nCode: ${p.ref_code}${price ? ' · ' + price : ''}\n\n${c.line}\n\nMy bookings: ${SITE}#/me`;
  return { subject: c.subject, html, text };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  const { key } = await req.json().catch(() => ({ key: null }));
  if (typeof key !== 'string' || key.length < 32) return new Response('bad_key', { status: 403 });
  // Without SMTP secrets, leave the outbox untouched so nothing burns its 5 tries.
  if (!GMAIL_USER || !GMAIL_PASS) return Response.json({ sent: 0, skipped: 'smtp_not_configured' });

  let notes: Note[];
  try { notes = await rpc<Note[]>('claim_notifications', { p_key: key, p_limit: 20 }); }
  catch (e) { return new Response(String(e), { status: 403 }); }
  if (!notes.length) return Response.json({ sent: 0 });

  const mail = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: GMAIL_USER, pass: GMAIL_PASS } });
  let sent = 0, failed = 0;
  for (const n of notes) {
    const m = compose(n);
    try {
      if (m) await mail.sendMail({ from: { name: n.club || 'Tira', address: GMAIL_USER }, to: n.email, subject: m.subject, html: m.html, text: m.text });
      await rpc('finish_notification', { p_key: key, p_id: n.id, p_error: null });
      sent++;
    } catch (e) {
      failed++;
      await rpc('finish_notification', { p_key: key, p_id: n.id, p_error: String(e) }).catch(() => {});
    }
  }
  return Response.json({ sent, failed });
});
