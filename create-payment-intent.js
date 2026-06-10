// api/create-payment-intent.js
// Vercel Serverless Function
// Registers member in DB after payment intent created

import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

// Prices in MXN cents
const PLAN_CONFIG = {
  basic: {
    amount: 29900,
    currency: 'mxn',
    name: 'Mr. MVX · The Pick Básico — Mundial 2026',
    telegram_group: process.env.TELEGRAM_GROUP_BASIC || '',
  },
  pro: {
    amount: 49900,
    currency: 'mxn',
    name: 'Mr. MVX · The Pick Pro — Mundial 2026',
    telegram_group: process.env.TELEGRAM_GROUP_PRO || '',
  },
  elite: {
    amount: 99900,
    currency: 'mxn',
    name: 'Mr. MVX · The Pick Élite — Mundial 2026',
    telegram_group: process.env.TELEGRAM_GROUP_ELITE || '',
  },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.SITE_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { plan, name, email, phone } = req.body || {};

  if (!plan || !PLAN_CONFIG[plan]) {
    return res.status(400).json({ error: 'Plan no válido.' });
  }
  if (!email || !name) {
    return res.status(400).json({ error: 'Nombre y email requeridos.' });
  }

  const cfg = PLAN_CONFIG[plan];

  try {
    // Find or create Stripe customer
    const existing = await stripe.customers.list({ email, limit: 1 });
    const customer = existing.data.length > 0
      ? existing.data[0]
      : await stripe.customers.create({
          email, name,
          phone: phone || undefined,
          metadata: { plan, source: 'mrmvx_mundial26' },
        });

    const paymentIntent = await stripe.paymentIntents.create({
      amount: cfg.amount,
      currency: cfg.currency,
      customer: customer.id,
      description: cfg.name,
      receipt_email: email,
      metadata: { plan, buyer_name: name, buyer_phone: phone || '', source: 'mrmvx_mundial26' },
      automatic_payment_methods: { enabled: true },
    });

    return res.status(200).json({ clientSecret: paymentIntent.client_secret });

  } catch (err) {
    console.error('[PaymentIntent Error]', err.message);
    return res.status(500).json({ error: 'Error procesando el pago. Intenta de nuevo.' });
  }
}
