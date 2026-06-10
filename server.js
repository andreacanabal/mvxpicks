// server.js — Mr. MVX · The Pick · Mundial 2026
// Railway Node.js backend — adapted from usa-fan-pass
// ═══════════════════════════════════════════════════════════════

import express    from 'express';
import cors       from 'cors';
import Stripe     from 'stripe';
import { createClient } from '@supabase/supabase-js';
import fetch      from 'node-fetch';
import crypto     from 'crypto';

const app    = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
const sb     = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ── Plan config ──
const PLANS = {
  basic: { amount: 29900, currency: 'mxn', name: 'The Pick · Básico — Mundial 2026',   list_id: parseInt(process.env.BREVO_BUYERS_LIST_ID || '7') },
  pro:   { amount: 49900, currency: 'mxn', name: 'The Pick + Contexto · Pro — Mundial 2026', list_id: parseInt(process.env.BREVO_BUYERS_LIST_ID || '7') },
  elite: { amount: 99900, currency: 'mxn', name: 'The Pick + Acceso Total · Élite — Mundial 2026', list_id: parseInt(process.env.BREVO_BUYERS_LIST_ID || '7') },
};

const TELEGRAM_GROUPS = {
  basic: process.env.TELEGRAM_GROUP_BASIC,
  pro:   process.env.TELEGRAM_GROUP_PRO,
  elite: process.env.TELEGRAM_GROUP_ELITE,
};

// ── Middleware ──
app.use(cors({ origin: process.env.SITE_URL || 'https://mvxpicks.com' }));
app.use((req, res, next) => {
  // Raw body for Stripe webhook verification
  if (req.path === '/webhook') {
    express.raw({ type: 'application/json' })(req, res, next);
  } else {
    express.json()(req, res, next);
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /health
// ═══════════════════════════════════════════════════════════════
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'mrmvx-the-pick', ts: new Date().toISOString() });
});

// ═══════════════════════════════════════════════════════════════
// GET /buyer-count — dynamic spots counter (from Supabase)
// ═══════════════════════════════════════════════════════════════
app.get('/buyer-count', async (req, res) => {
  try {
    const { data } = await sb.from('config').select('spots_total, spots_sold, accuracy_pct').eq('id', 1).single();
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
// POST /capture-lead — email gate pre-payment (Brevo list 6)
// ═══════════════════════════════════════════════════════════════
app.post('/capture-lead', async (req, res) => {
  const { email, name, plan } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email requerido' });

  try {
    await addToBrevoList({
      email,
      firstName: name?.split(' ')[0] || '',
      lastName:  name?.split(' ').slice(1).join(' ') || '',
      plan:      plan || '',
      listId:    parseInt(process.env.BREVO_LEADS_LIST_ID || '6'),
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[capture-lead]', err.message);
    res.status(500).json({ error: 'Error guardando lead' });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /create-checkout-session — Stripe Payment Intent
// ═══════════════════════════════════════════════════════════════
app.post('/create-checkout-session', async (req, res) => {
  const { plan, name, email, phone } = req.body || {};

  if (!plan || !PLANS[plan]) return res.status(400).json({ error: 'Plan no válido' });
  if (!email || !name)       return res.status(400).json({ error: 'Nombre y email requeridos' });

  const cfg = PLANS[plan];

  try {
    // Find or create Stripe customer
    const existing = await stripe.customers.list({ email, limit: 1 });
    const customer = existing.data.length > 0
      ? existing.data[0]
      : await stripe.customers.create({ email, name, phone: phone || undefined, metadata: { plan, source: 'mrmvx_mundial26' } });

    // Create PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create({
      amount:       cfg.amount,
      currency:     cfg.currency,
      customer:     customer.id,
      description:  cfg.name,
      receipt_email: email,
      metadata: { plan, buyer_name: name, buyer_phone: phone || '', source: 'mrmvx_mundial26' },
      automatic_payment_methods: { enabled: true },
    });

    // Add to Brevo leads list (cart abandon automation triggers)
    await addToBrevoList({
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
// GET /verify-session?session_id=pi_xxx — post-payment verification
// ═══════════════════════════════════════════════════════════════
app.get('/verify-session', async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'session_id requerido' });

  try {
    const pi = await stripe.paymentIntents.retrieve(session_id);
    if (pi.status !== 'succeeded') return res.status(400).json({ error: 'Pago no completado', status: pi.status });

    const plan = pi.metadata?.plan || 'pro';
    res.json({
      success:       true,
      plan,
      email:         pi.receipt_email,
      name:          pi.metadata?.buyer_name,
      telegram_link: TELEGRAM_GROUPS[plan] || '',
      amount:        pi.amount,
      currency:      pi.currency,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /webhook — Stripe webhook (payment_intent.succeeded)
// ═══════════════════════════════════════════════════════════════
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[webhook] Signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    const { plan, buyer_name, buyer_phone } = pi.metadata;
    const email = pi.receipt_email;
    const name  = buyer_name || '';

    console.log(`[webhook] Payment succeeded — ${plan} — ${email}`);

    // 1. Register in Supabase
    await sb.from('members').upsert({
      email, name, phone: buyer_phone || '',
      plan, stripe_payment_intent: pi.id,
      amount_paid: pi.amount, currency: pi.currency,
      active: true, joined_at: new Date().toISOString(),
      picks_until: new Date('2026-07-20').toISOString(),
    }, { onConflict: 'email' }).catch(e => console.error('[Supabase]', e.message));

    // 2. Decrement spots
    await sb.rpc('decrement_spots').catch(e => console.error('[Supabase spots]', e.message));

    // 3. Add to Brevo buyers list (triggers post-purchase automation)
    await addToBrevoList({
      email, firstName: name.split(' ')[0], lastName: name.split(' ').slice(1).join(' '),
      plan, orderValue: pi.amount / 100,
      telegramLink: TELEGRAM_GROUPS[plan] || '',
      listId: parseInt(process.env.BREVO_BUYERS_LIST_ID || '7'),
    }).catch(e => console.error('[Brevo buyer]', e.message));

    // 4. Remove from leads list (stop cart abandon sequence)
    await removeFromBrevoList(email, parseInt(process.env.BREVO_LEADS_LIST_ID || '6'))
      .catch(e => console.warn('[Brevo remove lead]', e.message));

    // 5. Server-side Meta CAPI — Purchase event
    await sendMetaCAPI({
      event_name: 'Purchase',
      email, name,
      phone: buyer_phone || '',
      value: pi.amount / 100,
      currency: pi.currency.toUpperCase(),
      event_id: pi.id,
      plan,
    }).catch(e => console.warn('[Meta CAPI]', e.message));

    // 6. Notify Mr. MVX via Telegram
    await notifyAdmin({ name, email, plan, amount: pi.amount })
      .catch(e => console.warn('[Telegram admin]', e.message));
  }

  res.json({ received: true });
});

// ═══════════════════════════════════════════════════════════════
// BREVO helpers
// ═══════════════════════════════════════════════════════════════
async function addToBrevoList({ email, firstName, lastName, plan, orderValue, telegramLink, listId }) {
  const body = {
    email,
    attributes: {
      FIRSTNAME:     firstName || '',
      LASTNAME:      lastName  || '',
      PLAN:          plan      || '',
      ORDER_VALUE:   orderValue || 0,
      TELEGRAM_LINK: telegramLink || '',
      SOURCE:        'mrmvx_mundial26',
    },
    listIds:     [listId],
    updateEnabled: true,
  };

  const r = await fetch('https://api.brevo.com/v3/contacts', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!r.ok && r.status !== 204) {
    const t = await r.text();
    throw new Error(`Brevo add contact: ${r.status} ${t}`);
  }
}

async function removeFromBrevoList(email, listId) {
  // Get contact ID first
  const r = await fetch(`https://api.brevo.com/v3/contacts/${encodeURIComponent(email)}`, {
    headers: { 'api-key': process.env.BREVO_API_KEY },
  });
  if (!r.ok) return;
  const contact = await r.json();

  // Remove from list
  await fetch(`https://api.brevo.com/v3/contacts/lists/${listId}/contacts/remove`, {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ emails: [email] }),
  });
}

// ═══════════════════════════════════════════════════════════════
// META CAPI — server-side Purchase event
// ═══════════════════════════════════════════════════════════════
async function sendMetaCAPI({ event_name, email, name, phone, value, currency, event_id, plan }) {
  if (!process.env.META_PIXEL_ID || !process.env.META_ACCESS_TOKEN) return;

  const hash = s => crypto.createHash('sha256').update(s.toLowerCase().trim()).digest('hex');

  const payload = {
    data: [{
      event_name,
      event_time: Math.floor(Date.now() / 1000),
      event_id,
      action_source: 'website',
      user_data: {
        em: [hash(email)],
        ph: phone ? [hash(phone.replace(/\D/g, ''))] : undefined,
        fn: name ? [hash(name.split(' ')[0])] : undefined,
        ln: name && name.split(' ').length > 1 ? [hash(name.split(' ').slice(1).join(' '))] : undefined,
      },
      custom_data: {
        currency,
        value,
        content_name: `The Pick · ${plan}`,
        content_category: 'membership',
        num_items: 1,
      },
    }],
    test_event_code: process.env.META_TEST_EVENT_CODE || undefined,
  };

  await fetch(`https://graph.facebook.com/v20.0/${process.env.META_PIXEL_ID}/events?access_token=${process.env.META_ACCESS_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

// ═══════════════════════════════════════════════════════════════
// TELEGRAM admin notify
// ═══════════════════════════════════════════════════════════════
async function notifyAdmin({ name, email, plan, amount }) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_ADMIN_CHAT_ID) return;
  const planLabels = { basic: 'Básico', pro: 'Pro', elite: 'Élite' };
  const msg = `💰 *NUEVO MIEMBRO — Mr. MVX*\n\n👤 ${name}\n📧 ${email}\n📦 Plan: ${planLabels[plan] || plan}\n💵 $${(amount / 100).toFixed(0)} MXN`;
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_ADMIN_CHAT_ID, text: msg, parse_mode: 'Markdown' }),
  });
}

// ── Start ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Mr. MVX backend running on port ${PORT}`));
