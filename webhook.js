// api/webhook.js
// Stripe webhook — fires on payment_intent.succeeded
// This is the CORE of the automation: registers the member, sends welcome message,
// adds them to the daily pick delivery list.

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Raw body needed for Stripe signature verification
export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[Webhook] Signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    const { plan, buyer_name, buyer_phone } = pi.metadata;
    const email = pi.receipt_email;

    console.log(`[Webhook] Payment succeeded — ${plan} — ${email}`);

    try {
      // 1. Register member in Supabase
      const { error: dbError } = await supabase.from('members').insert({
        email,
        name: buyer_name,
        phone: buyer_phone,
        plan,
        stripe_payment_intent: pi.id,
        amount_paid: pi.amount,
        currency: pi.currency,
        active: true,
        joined_at: new Date().toISOString(),
        picks_until: new Date('2026-07-19').toISOString(), // World Cup final
      });

      if (dbError) console.error('[Webhook] DB insert error:', dbError.message);

      // 2. Decrement available spots counter
      await supabase.rpc('decrement_spots');

      // 3. Send welcome WhatsApp via Twilio (if configured)
      if (process.env.TWILIO_ACCOUNT_SID && buyer_phone) {
        await sendWhatsAppWelcome({ name: buyer_name, phone: buyer_phone, plan });
      }

      // 4. Send welcome email via Resend
      if (process.env.RESEND_API_KEY) {
        await sendWelcomeEmail({ name: buyer_name, email, plan });
      }

      // 5. Notify Mr. MVX via Telegram bot
      if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_ADMIN_CHAT_ID) {
        await notifyAdmin({ name: buyer_name, email, plan, amount: pi.amount });
      }

    } catch (err) {
      console.error('[Webhook] Post-payment processing error:', err.message);
      // Don't return 500 — Stripe would retry. Log and continue.
    }
  }

  return res.status(200).json({ received: true });
}

// ── Twilio WhatsApp welcome ──
async function sendWhatsAppWelcome({ name, phone, plan }) {
  const PLAN_LABELS = { basic: 'Básico', pro: 'Pro', elite: 'Élite' };
  const TELEGRAM_LINKS = {
    basic: process.env.TELEGRAM_GROUP_BASIC,
    pro:   process.env.TELEGRAM_GROUP_PRO,
    elite: process.env.TELEGRAM_GROUP_ELITE,
  };
  const message = `Hola ${name} 👋 ¡Bienvenido a Mr. MVX · The Pick ${PLAN_LABELS[plan] || plan}!\n\n✅ Tu acceso está activo para el Mundial 2026.\n\n📲 Únete al grupo privado aquí: ${TELEGRAM_LINKS[plan] || 'link próximamente'}\n\nRecibirás picks 2 horas antes de cada partido. Cualquier duda, responde este mensaje.\n\n— Mr. MVX`;

  const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`;
  const formattedPhone = phone.replace(/\s/g, '').replace(/^\+?/, '+');

  const body = new URLSearchParams({
    From: `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`,
    To:   `whatsapp:${formattedPhone}`,
    Body: message,
  });

  const resp = await fetch(twilioUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64'),
    },
    body,
  });

  if (!resp.ok) {
    const t = await resp.text();
    console.error('[Twilio] WhatsApp send failed:', t);
  }
}

// ── Resend welcome email ──
async function sendWelcomeEmail({ name, email, plan }) {
  const PLAN_LABELS = { basic: 'Básico', pro: 'Pro', elite: 'Élite' };
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: 'Mr. MVX <noreply@mrmvx.com>',
      to: email,
      subject: `✅ Acceso confirmado — The Pick ${PLAN_LABELS[plan] || plan} · Mundial 2026`,
      html: `
        <div style="background:#080808;color:#EDEAE4;font-family:Inter,sans-serif;max-width:520px;margin:0 auto;padding:40px 24px;">
          <h1 style="font-family:'Bebas Neue',sans-serif;color:#F5A623;font-size:36px;margin:0 0 12px;">MR. MVX · THE PICK</h1>
          <p style="font-size:16px;margin:0 0 24px;">Hola <strong>${name}</strong>, tu acceso está confirmado.</p>
          <div style="background:#181818;border:1px solid #F5A623;border-radius:6px;padding:20px 24px;margin-bottom:24px;">
            <p style="margin:0 0 8px;font-size:13px;color:#8A8680;text-transform:uppercase;letter-spacing:0.1em;">Plan activo</p>
            <p style="margin:0;font-size:20px;font-weight:700;color:#F5A623;">The Pick · ${PLAN_LABELS[plan] || plan}</p>
            <p style="margin:4px 0 0;font-size:13px;color:#8A8680;">40 días · Mundial 2026 completo</p>
          </div>
          <p style="font-size:14px;color:#8A8680;margin:0 0 16px;">Próximos pasos:</p>
          <ol style="font-size:14px;color:#EDEAE4;padding-left:20px;line-height:1.8;">
            <li>Únete al grupo Telegram con el link de abajo</li>
            <li>Activa las notificaciones del grupo</li>
            <li>Los picks llegan 2 horas antes de cada partido automáticamente</li>
          </ol>
          <a href="${process.env.SITE_URL}/gracias?plan=${plan}&email=${encodeURIComponent(email)}" style="display:block;margin-top:28px;background:#F5A623;color:#080808;font-weight:700;font-size:14px;text-align:center;padding:16px;border-radius:4px;text-decoration:none;text-transform:uppercase;letter-spacing:0.07em;">VER MIS INSTRUCCIONES DE ACCESO →</a>
          <p style="font-size:10px;color:#3a3a3a;margin-top:32px;">Mr. MVX · The Pick es un sistema de análisis estadístico. No garantiza ganancias. Uso para mayores de 18 años.</p>
        </div>
      `,
    }),
  });
}

// ── Telegram admin notification ──
async function notifyAdmin({ name, email, plan, amount }) {
  const PLAN_LABELS = { basic: 'Básico', pro: 'Pro', elite: 'Élite' };
  const msg = `💰 *NUEVO MIEMBRO*\n\n👤 ${name}\n📧 ${email}\n📦 Plan: ${PLAN_LABELS[plan] || plan}\n💵 $${(amount/100).toFixed(0)} MXN`;
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_ADMIN_CHAT_ID,
      text: msg,
      parse_mode: 'Markdown',
    }),
  });
}
