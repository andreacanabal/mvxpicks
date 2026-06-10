// server.js — Mr. MVX · The Pick · Mundial 2026
// Railway Node.js — sin webhook Stripe, usa polling cada 30s

import express from 'express';
import cors    from 'cors';
import Stripe  from 'stripe';
import { createClient } from '@supabase/supabase-js';
import fetch   from 'node-fetch';
import crypto  from 'crypto';

const app    = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
const sb     = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const PLANS = {
  basic: { amount: 29900, currency: 'mxn', name: 'The Pick · Básico — Mundial 2026' },
  pro:   { amount: 49900, currency: 'mxn', name: 'The Pick + Contexto · Pro — Mundial 2026' },
  elite: { amount: 99900, currency: 'mxn', name: 'The Pick + Acceso Total · Élite — Mundial 2026' },
};

const TELEGRAM_GROUPS = {
  basic: process.env.TELEGRAM_GROUP_BASIC  || '',
  pro:   process.env.TELEGRAM_GROUP_PRO    || '',
  elite: process.env.TELEGRAM_GROUP_ELITE  || '',
};

// ── Middleware ──
app.use(cors({
  origin: ['https://mvxpicks.com', 'https://www.mvxpicks.com', /\.vercel\.app$/],
  credentials: true,
}));
app.use(express.json());

// ═══════════════════════════════════════════════════════════════
// GET /health
// ═══════════════════════════════════════════════════════════════
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'mrmvx-the-pick', ts: new Date().toISOString() });
});

// ═══════════════════════════════════════════════════════════════
// GET /buyer-count
// ═══════════════════════════════════════════════════════════════
app.get('/buyer-count', async (req, res) => {
  try {
    const { data } = await sb.from('config').select('spots_total,spots_sold,accuracy_pct').eq('id', 1).single();
    res.json({
      total:     data?.spots_total  || 500,
      sold:      data?.spots_sold   || 0,
      remaining: Math.max(0, (data?.spots_total || 500) - (data?.spots_sold || 0)),
      accuracy:  data?.accuracy_pct || 95,
    });
  } catch {
    res.json({ total: 500, sold: 0, remaining: 500, accuracy: 95 });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /capture-lead — email gate pre-pago (Brevo lista 6)
// ═══════════════════════════════════════════════════════════════
app.post('/capture-lead', async (req, res) => {
  const { email, name, plan } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email requerido' });
  try {
    await addToBrevoList({
      email,
      firstName: name?.split(' ')[0] || '',
      lastName:  name?.split(' ').slice(1).join(' ') || '',
      plan: plan || '',
      listId: parseInt(process.env.BREVO_LEADS_LIST_ID || '6'),
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[capture-lead]', err.message);
    res.status(500).json({ error: 'Error guardando lead' });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /create-checkout-session — crea PaymentIntent en Stripe
// ═══════════════════════════════════════════════════════════════
app.post('/create-checkout-session', async (req, res) => {
  const { plan, name, email, phone } = req.body || {};

  if (!plan || !PLANS[plan]) return res.status(400).json({ error: 'Plan no válido' });
  if (!email || !name)       return res.status(400).json({ error: 'Nombre y email requeridos' });

  const cfg = PLANS[plan];

  try {
    const existing  = await stripe.customers.list({ email, limit: 1 });
    const customer  = existing.data.length > 0
      ? existing.data[0]
      : await stripe.customers.create({
          email, name,
          phone: phone || undefined,
          metadata: { plan, source: 'mrmvx_mundial26' },
        });

    const paymentIntent = await stripe.paymentIntents.create({
      amount:        cfg.amount,
      currency:      cfg.currency,
      customer:      customer.id,
      description:   cfg.name,
      receipt_email: email,
      metadata: { plan, buyer_name: name, buyer_phone: phone || '', source: 'mrmvx_mundial26' },
      automatic_payment_methods: { enabled: true },
    });

    // Agregar a Brevo leads (dispara carrito abandonado si no paga)
    addToBrevoList({
      email,
      firstName: name.split(' ')[0],
      lastName:  name.split(' ').slice(1).join(' '),
      plan,
      listId: parseInt(process.env.BREVO_LEADS_LIST_ID || '6'),
    }).catch(e => console.warn('[Brevo lead]', e.message));

    res.json({ clientSecret: paymentIntent.client_secret });

  } catch (err) {
    console.error('[create-checkout-session]', err.message);
    res.status(500).json({ error: 'Error procesando el pago. Intenta de nuevo.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /verify-session?session_id=pi_xxx — verificación post-pago
// También dispara el flujo de bienvenida si aún no se procesó
// ═══════════════════════════════════════════════════════════════
app.get('/verify-session', async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'session_id requerido' });

  try {
    const pi = await stripe.paymentIntents.retrieve(session_id);
    if (pi.status !== 'succeeded') {
      return res.status(400).json({ error: 'Pago no completado', status: pi.status });
    }

    const plan  = pi.metadata?.plan || 'pro';
    const email = pi.receipt_email;
    const name  = pi.metadata?.buyer_name || '';

    // Procesar en background (no bloqueamos la respuesta)
    processSuccessfulPayment(pi).catch(e => console.error('[verify-session process]', e.message));

    res.json({
      success:       true,
      plan,
      email,
      name,
      telegram_link: TELEGRAM_GROUPS[plan] || '',
      amount:        pi.amount,
      currency:      pi.currency,
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// POLLING — revisa pagos nuevos cada 30 segundos
// Reemplaza el webhook de Stripe completamente
// ═══════════════════════════════════════════════════════════════
let lastPolledAt = Math.floor(Date.now() / 1000) - 60; // empieza revisando el último minuto

async function pollStripePayments() {
  if (!process.env.STRIPE_SECRET_KEY) return;

  try {
    const paymentIntents = await stripe.paymentIntents.list({
      created: { gte: lastPolledAt },
      limit: 20,
    });

    const now = Math.floor(Date.now() / 1000);

    for (const pi of paymentIntents.data) {
      if (pi.status !== 'succeeded') continue;
      if (pi.metadata?.source !== 'mrmvx_mundial26') continue;

      // Verificar si ya lo procesamos
      const { data: existing } = await sb
        .from('members')
        .select('id')
        .eq('stripe_payment_intent', pi.id)
        .maybeSingle();

      if (existing) continue; // ya procesado

      console.log(`[polling] Nuevo pago detectado: ${pi.id} — ${pi.receipt_email}`);
      await processSuccessfulPayment(pi);
    }

    lastPolledAt = now - 10; // 10s de overlap para no perder nada

  } catch (err) {
    console.error('[polling] Error:', err.message);
  }
}

// Arrancar polling
setInterval(pollStripePayments, 30000); // cada 30 segundos
console.log('[polling] Stripe payment polling activo — cada 30s');

// ═══════════════════════════════════════════════════════════════
// PROCESO DE PAGO EXITOSO — lógica central
// Llamado desde polling Y desde verify-session
// ═══════════════════════════════════════════════════════════════
async function processSuccessfulPayment(pi) {
  const plan        = pi.metadata?.plan || 'pro';
  const email       = pi.receipt_email;
  const name        = pi.metadata?.buyer_name || '';
  const phone       = pi.metadata?.buyer_phone || '';

  if (!email) return;

  // 1. Registrar en Supabase
  const { error: dbErr } = await sb.from('members').upsert({
    email, name, phone, plan,
    stripe_payment_intent: pi.id,
    amount_paid:  pi.amount,
    currency:     pi.currency,
    active:       true,
    joined_at:    new Date().toISOString(),
    picks_until:  new Date('2026-07-20').toISOString(),
  }, { onConflict: 'stripe_payment_intent' });

  if (dbErr) {
    console.error('[processPayment] Supabase error:', dbErr.message);
    return; // no continuar si falló el insert (evita duplicados)
  }

  // 2. Decrementar spots
  await sb.rpc('decrement_spots').catch(e => console.error('[spots]', e.message));

  // 3. Brevo — mover de leads a buyers
  await addToBrevoList({
    email,
    firstName:    name.split(' ')[0],
    lastName:     name.split(' ').slice(1).join(' '),
    plan,
    orderValue:   pi.amount / 100,
    telegramLink: TELEGRAM_GROUPS[plan] || '',
    listId:       parseInt(process.env.BREVO_BUYERS_LIST_ID || '7'),
  }).catch(e => console.error('[Brevo buyer]', e.message));

  await removeFromBrevoList(email, parseInt(process.env.BREVO_LEADS_LIST_ID || '6'))
    .catch(e => console.warn('[Brevo remove]', e.message));

  // 4. Meta CAPI
  await sendMetaCAPI({
    event_name: 'Purchase',
    email, name, phone,
    value:    pi.amount / 100,
    currency: pi.currency.toUpperCase(),
    event_id: pi.id,
    plan,
  }).catch(e => console.warn('[CAPI]', e.message));

  // 5. Notificar a Mr. MVX por Telegram
  await notifyAdmin({ name, email, plan, amount: pi.amount })
    .catch(e => console.warn('[Telegram]', e.message));

  console.log(`[processPayment] ✓ Procesado: ${email} — ${plan} — $${pi.amount / 100} MXN`);
}

// ═══════════════════════════════════════════════════════════════
// BREVO helpers
// ═══════════════════════════════════════════════════════════════
async function addToBrevoList({ email, firstName, lastName, plan, orderValue, telegramLink, listId }) {
  const r = await fetch('https://api.brevo.com/v3/contacts', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      attributes: {
        FIRSTNAME:     firstName    || '',
        LASTNAME:      lastName     || '',
        PLAN:          plan         || '',
        ORDER_VALUE:   orderValue   || 0,
        TELEGRAM_LINK: telegramLink || '',
        SOURCE:        'mrmvx_mundial26',
      },
      listIds:       [listId],
      updateEnabled: true,
    }),
  });
  if (!r.ok && r.status !== 204) {
    const t = await r.text();
    throw new Error(`Brevo ${r.status}: ${t}`);
  }
}

async function removeFromBrevoList(email, listId) {
  await fetch(`https://api.brevo.com/v3/contacts/lists/${listId}/contacts/remove`, {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ emails: [email] }),
  });
}

// ═══════════════════════════════════════════════════════════════
// META CAPI
// ═══════════════════════════════════════════════════════════════
async function sendMetaCAPI({ event_name, email, name, phone, value, currency, event_id, plan }) {
  if (!process.env.META_PIXEL_ID || !process.env.META_ACCESS_TOKEN) return;
  const hash = s => crypto.createHash('sha256').update(s.toLowerCase().trim()).digest('hex');
  await fetch(`https://graph.facebook.com/v20.0/${process.env.META_PIXEL_ID}/events?access_token=${process.env.META_ACCESS_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      data: [{
        event_name,
        event_time:    Math.floor(Date.now() / 1000),
        event_id,
        action_source: 'website',
        user_data: {
          em: [hash(email)],
          ph: phone ? [hash(phone.replace(/\D/g, ''))] : undefined,
          fn: name  ? [hash(name.split(' ')[0])]       : undefined,
        },
        custom_data: { currency, value, content_name: `The Pick · ${plan}`, num_items: 1 },
      }],
    }),
  });
}

// ═══════════════════════════════════════════════════════════════
// TELEGRAM — notificación de venta
// ═══════════════════════════════════════════════════════════════
async function notifyAdmin({ name, email, plan, amount }) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_ADMIN_CHAT_ID) return;
  const labels = { basic: 'Básico', pro: 'Pro', elite: 'Élite' };
  const msg = `💰 *NUEVO MIEMBRO — Mr. MVX*\n\n👤 ${name}\n📧 ${email}\n📦 Plan: ${labels[plan] || plan}\n💵 $${(amount / 100).toFixed(0)} MXN`;
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_ADMIN_CHAT_ID, text: msg, parse_mode: 'Markdown' }),
  });
}

// ── Start ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Mr. MVX backend running on port ${PORT}`));
