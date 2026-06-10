// server.js — Mr. MVX · The Pick · Mundial 2026
// Railway Node.js — backend completo + picks automáticos integrados

import express from 'express';
import cors    from 'cors';
import Stripe  from 'stripe';
import { createClient } from '@supabase/supabase-js';
import crypto  from 'crypto';

// Node 18+ tiene fetch nativo — no necesitamos node-fetch

const app    = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
const sb     = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ── Constantes ──
const FOOTBALL_API_KEY  = process.env.FOOTBALL_API_KEY;
const FOOTBALL_API_HOST = 'v3.football.api-sports.io';
const WC_LEAGUE_ID      = 1;
const WC_SEASON         = 2026;

const PLANS = {
  basic: { amount: 29900, currency: 'mxn', name: 'The Pick · Básico — Mundial 2026' },
  pro:   { amount: 49900, currency: 'mxn', name: 'The Pick + Contexto · Pro — Mundial 2026' },
  elite: { amount: 99900, currency: 'mxn', name: 'The Pick + Acceso Total · Élite — Mundial 2026' },
};

const TELEGRAM_BOT = () => process.env.TELEGRAM_BOT_TOKEN;
const GROUPS = () => ({
  basic: process.env.TELEGRAM_GROUP_BASIC,
  pro:   process.env.TELEGRAM_GROUP_PRO,
  elite: process.env.TELEGRAM_GROUP_ELITE,
});

// ── Middleware ──
app.use(cors({
  origin: ['https://mvxpicks.com', 'https://www.mvxpicks.com', /\.vercel\.app$/],
  credentials: true,
}));
app.use(express.json());

// ═══════════════════════════════════════════════════════════════
// ENDPOINTS — Pagos y utilidades
// ═══════════════════════════════════════════════════════════════

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'mrmvx-the-pick', ts: new Date().toISOString() });
});

app.get('/buyer-count', async (req, res) => {
  try {
    const { data } = await sb.from('config').select('spots_total,spots_sold,accuracy_pct').eq('id', 1).single();
    res.json({
      total:     data?.spots_total  || 500,
      sold:      data?.spots_sold   || 0,
      remaining: Math.max(0, (data?.spots_total || 500) - (data?.spots_sold || 0)),
      accuracy:  data?.accuracy_pct || 95,
    });
  } catch { res.json({ total: 500, sold: 0, remaining: 500, accuracy: 95 }); }
});

app.post('/capture-lead', async (req, res) => {
  const { email, name, plan } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email requerido' });
  try {
    await addToBrevoList({ email, firstName: name?.split(' ')[0] || '', lastName: name?.split(' ').slice(1).join(' ') || '', plan: plan || '', listId: parseInt(process.env.BREVO_LEADS_LIST_ID || '6') });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/create-checkout-session', async (req, res) => {
  const { plan, name, email, phone } = req.body || {};
  if (!plan || !PLANS[plan]) return res.status(400).json({ error: 'Plan no válido' });
  if (!email || !name)       return res.status(400).json({ error: 'Nombre y email requeridos' });
  const cfg = PLANS[plan];
  try {
    const existing = await stripe.customers.list({ email, limit: 1 });
    const customer = existing.data.length > 0
      ? existing.data[0]
      : await stripe.customers.create({ email, name, phone: phone || undefined, metadata: { plan, source: 'mrmvx_mundial26' } });
    const paymentIntent = await stripe.paymentIntents.create({
      amount: cfg.amount, currency: cfg.currency, customer: customer.id,
      description: cfg.name, receipt_email: email,
      metadata: { plan, buyer_name: name, buyer_phone: phone || '', source: 'mrmvx_mundial26' },
      automatic_payment_methods: { enabled: true },
    });
    addToBrevoList({ email, firstName: name.split(' ')[0], lastName: name.split(' ').slice(1).join(' '), plan, listId: parseInt(process.env.BREVO_LEADS_LIST_ID || '6') }).catch(() => {});
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error('[checkout]', err.message);
    res.status(500).json({ error: 'Error procesando el pago. Intenta de nuevo.' });
  }
});

app.get('/verify-session', async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'session_id requerido' });
  try {
    const pi = await stripe.paymentIntents.retrieve(session_id);
    if (pi.status !== 'succeeded') return res.status(400).json({ error: 'Pago no completado', status: pi.status });
    const plan = pi.metadata?.plan || 'pro';
    processSuccessfulPayment(pi).catch(e => console.error('[verify process]', e.message));
    res.json({ success: true, plan, email: pi.receipt_email, name: pi.metadata?.buyer_name, telegram_link: GROUPS()[plan] || '', amount: pi.amount, currency: pi.currency });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════
// ENDPOINT — Trigger manual de picks (protegido con secret)
// GET /run-picks?secret=CRON_SECRET
// ═══════════════════════════════════════════════════════════════
app.get('/run-picks', async (req, res) => {
  if (req.query.secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await runDailyPicks();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /run-results?secret=CRON_SECRET
app.get('/run-results', async (req, res) => {
  if (req.query.secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await runCheckResults();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// POLLING — Detecta pagos nuevos cada 30s
// ═══════════════════════════════════════════════════════════════
let lastPolledAt = Math.floor(Date.now() / 1000) - 60;

async function pollStripePayments() {
  if (!process.env.STRIPE_SECRET_KEY) return;
  try {
    const paymentIntents = await stripe.paymentIntents.list({ created: { gte: lastPolledAt }, limit: 20 });
    const now = Math.floor(Date.now() / 1000);
    for (const pi of paymentIntents.data) {
      if (pi.status !== 'succeeded') continue;
      if (pi.metadata?.source !== 'mrmvx_mundial26') continue;
      const { data: existing } = await sb.from('members').select('id').eq('stripe_payment_intent', pi.id).maybeSingle();
      if (existing) continue;
      console.log(`[polling] Nuevo pago: ${pi.id} — ${pi.receipt_email}`);
      await processSuccessfulPayment(pi);
    }
    lastPolledAt = now - 10;
  } catch (err) { console.error('[polling]', err.message); }
}

setInterval(pollStripePayments, 30000);

// ═══════════════════════════════════════════════════════════════
// SCHEDULER INTERNO — Picks 8AM y resultados 11PM (México)
// ═══════════════════════════════════════════════════════════════
function scheduleDaily(hourMexico, minuteMexico, fn, label) {
  function msUntilNext() {
    const now = new Date();
    const mxNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
    const target = new Date(mxNow);
    target.setHours(hourMexico, minuteMexico, 0, 0);
    if (target <= mxNow) target.setDate(target.getDate() + 1);
    return target - mxNow;
  }

  function schedule() {
    const ms = msUntilNext();
    const hrs = (ms / 3600000).toFixed(1);
    console.log(`[scheduler] ${label} → próxima ejecución en ${hrs}h`);
    setTimeout(async () => {
      console.log(`[scheduler] Ejecutando ${label}...`);
      try { await fn(); } catch (e) { console.error(`[scheduler] ${label} error:`, e.message); }
      schedule(); // reprogramar para el día siguiente
    }, ms);
  }

  schedule();
}

// Programar picks diarios a las 8:00 AM México
scheduleDaily(8, 0, runDailyPicks, 'PICKS DIARIOS');

// Programar verificación de resultados a las 11:00 PM México
scheduleDaily(23, 0, runCheckResults, 'CHECK RESULTADOS');

console.log('[scheduler] Picks programados: 8:00 AM México · Resultados: 11:00 PM México');

// ═══════════════════════════════════════════════════════════════
// MOTOR DE PICKS DIARIOS
// ═══════════════════════════════════════════════════════════════
async function runDailyPicks() {
  console.log('[DailyPicks] Iniciando...');

  const fixtures = await getFixturesToday();
  console.log(`[DailyPicks] Partidos hoy: ${fixtures.length}`);

  if (!fixtures.length) {
    await telegramSendAll('📅 *Mr. MVX · The Pick*\n\nNo hay partidos del Mundial hoy. ¡Hasta mañana!');
    return { sent: 0, message: 'No fixtures today' };
  }

  const picks = [];
  for (const fixture of fixtures) {
    const pick = await generatePick(fixture);
    if (pick) picks.push(pick);
  }

  if (!picks.length) return { sent: 0, message: 'No picks generated' };

  picks.sort((a, b) => b.confidence - a.confidence);

  await sendPicksTelegram(picks);
  await savePicksSupabase(picks);

  console.log(`[DailyPicks] ✓ ${picks.length} picks enviados`);
  return { success: true, picks: picks.length, data: picks };
}

async function getFixturesToday() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' }); // YYYY-MM-DD
  const data = await footballAPI('/fixtures', { league: WC_LEAGUE_ID, season: WC_SEASON, date: today, status: 'NS' });
  return data?.response || [];
}

async function generatePick(fixture) {
  const fixtureId = fixture.fixture.id;
  const homeTeam  = fixture.teams.home.name;
  const awayTeam  = fixture.teams.away.name;

  try {
    const predData = await footballAPI('/predictions', { fixture: fixtureId });
    const pred = predData?.response?.[0];
    if (!pred) return null;

    const winner      = pred.predictions?.winner;
    const percentages = pred.predictions?.percent || {};
    const homePct     = parseInt(percentages.home) || 33;
    const drawPct     = parseInt(percentages.draw) || 33;
    const awayPct     = parseInt(percentages.away) || 34;

    let prediction, rawConf;
    if (winner?.id === fixture.teams.home.id) {
      prediction = `VICTORIA ${homeTeam.toUpperCase()}`; rawConf = homePct;
    } else if (winner?.id === fixture.teams.away.id) {
      prediction = `VICTORIA ${awayTeam.toUpperCase()}`; rawConf = awayPct;
    } else {
      prediction = 'EMPATE'; rawConf = drawPct;
    }

    const confidence = Math.min(97, Math.max(65, Math.round(rawConf * 1.2)));
    const oddsData   = await footballAPI('/odds', { fixture: fixtureId, bookmaker: 8 }).catch(() => null);
    const odds       = extractOdds(oddsData);
    const reasoning  = buildReasoning(pred, odds, homeTeam, awayTeam, homePct, drawPct, awayPct);

    return {
      fixture_id: fixtureId,
      date: fixture.fixture.date,
      home_team: homeTeam,
      away_team: awayTeam,
      prediction,
      confidence,
      reasoning,
      league_round: fixture.league.round,
      advice: pred.predictions?.advice || '',
      timestamp_published: new Date().toISOString(),
      result: null,
      correct: null,
    };
  } catch (err) {
    console.error(`[generatePick] ${fixtureId}:`, err.message);
    return null;
  }
}

function extractOdds(data) {
  try {
    const bets = data?.response?.[0]?.bookmakers?.[0]?.bets?.[0]?.values;
    if (!bets) return null;
    return {
      home: parseFloat(bets.find(b => b.value === 'Home')?.odd || 0),
      draw: parseFloat(bets.find(b => b.value === 'Draw')?.odd || 0),
      away: parseFloat(bets.find(b => b.value === 'Away')?.odd || 0),
    };
  } catch { return null; }
}

function buildReasoning(pred, odds, homeTeam, awayTeam, homePct, drawPct, awayPct) {
  const reasons = [];
  const comp = pred.comparison || {};

  if (comp.form) {
    const hf = parseInt(comp.form.home) || 50;
    const af = parseInt(comp.form.away) || 50;
    if (hf > af + 10) reasons.push(`${homeTeam} llega con mejor forma reciente (${comp.form.home} vs ${comp.form.away})`);
    else if (af > hf + 10) reasons.push(`${awayTeam} llega con mejor forma reciente (${comp.form.away} vs ${comp.form.home})`);
  }

  if (comp.att && comp.def) {
    reasons.push(`Ataque/Defensa: ${homeTeam} ${comp.att.home}/${comp.def.home} — ${awayTeam} ${comp.att.away}/${comp.def.away}`);
  }

  if (odds?.home > 0) {
    const min = Math.min(odds.home, odds.draw, odds.away);
    if (odds.home === min) reasons.push(`Mercado favorece a ${homeTeam} (cuota ${odds.home})`);
    else if (odds.away === min) reasons.push(`Mercado favorece a ${awayTeam} (cuota ${odds.away})`);
  }

  if (!reasons.length) {
    reasons.push(`Probabilidad del sistema: ${homeTeam} ${homePct}% / Empate ${drawPct}% / ${awayTeam} ${awayPct}%`);
  }

  return reasons.slice(0, 3);
}

async function sendPicksTelegram(picks) {
  if (!TELEGRAM_BOT()) return;
  const groups = GROUPS();
  for (const [plan, chatId] of Object.entries(groups)) {
    if (!chatId) continue;
    const picksToSend = plan === 'basic' ? [picks[0]] : picks;
    await telegramSend(chatId, formatPicksMessage(picksToSend, plan));
  }
}

function formatPicksMessage(picks, plan) {
  const dateStr = new Date().toLocaleDateString('es-MX', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Mexico_City',
  }).toUpperCase();
  const planLabel = { basic: 'BÁSICO', pro: 'PRO', elite: 'ÉLITE' }[plan] || plan.toUpperCase();

  let msg = `🔮 *MR. MVX · THE PICK — ${dateStr}*\n📦 Plan ${planLabel}\n━━━━━━━━━━━━━━━━━━━━━\n\n`;

  for (const p of picks) {
    const t = new Date(p.date).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' });
    msg += `⚽ *${p.home_team} vs ${p.away_team}*\n`;
    msg += `🕐 ${t} hrs (México) · ${p.league_round}\n`;
    msg += `🎯 Pick: *${p.prediction}*\n`;
    msg += `📊 Confianza: *${p.confidence}%*\n`;
    if (p.reasoning?.length) {
      msg += `💡 Por qué:\n`;
      p.reasoning.forEach(r => { msg += `   • ${r}\n`; });
    }
    if (p.advice) msg += `📝 ${p.advice}\n`;
    msg += `\n`;
  }

  msg += `━━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `_% publicado ANTES del partido · mvxpicks.com_`;
  return msg;
}

async function savePicksSupabase(picks) {
  const rows = picks.map(p => ({
    fixture_id: p.fixture_id, date: p.date,
    home_team: p.home_team, away_team: p.away_team,
    prediction: p.prediction, confidence: p.confidence,
    reasoning: p.reasoning, league_round: p.league_round,
    timestamp_published: p.timestamp_published,
    result: null, correct: null,
  }));
  const { error } = await sb.from('picks_history').upsert(rows, { onConflict: 'fixture_id' });
  if (error) console.error('[Supabase picks]', error.message);
}

// ═══════════════════════════════════════════════════════════════
// VERIFICADOR DE RESULTADOS
// ═══════════════════════════════════════════════════════════════
async function runCheckResults() {
  console.log('[CheckResults] Iniciando...');

  const { data: pending, error } = await sb
    .from('picks_history').select('*').is('result', null)
    .lte('date', new Date().toISOString());

  if (error) throw error;
  if (!pending?.length) return { updated: 0 };

  let updated = 0, correct = 0;

  for (const pick of pending) {
    const result = await getFixtureResult(pick.fixture_id);
    if (!result) continue;

    const isCorrect = evaluatePick(pick.prediction, result, pick.home_team, pick.away_team);
    await sb.from('picks_history').update({
      result: `${result.home_goals}-${result.away_goals}`, correct: isCorrect,
    }).eq('fixture_id', pick.fixture_id);

    if (isCorrect) correct++;
    updated++;
  }

  if (updated > 0) {
    await updateAccuracyStats();
    await sendResultsRecap(updated, correct);
  }

  console.log(`[CheckResults] ✓ ${correct}/${updated} correctos`);
  return { updated, correct, accuracy: updated > 0 ? Math.round((correct / updated) * 100) : null };
}

async function getFixtureResult(fixtureId) {
  try {
    const data = await footballAPI('/fixtures', { id: fixtureId });
    const f = data?.response?.[0];
    if (!f || f.fixture.status.short !== 'FT') return null;
    return { home_goals: f.goals.home, away_goals: f.goals.away, home_winner: f.teams.home.winner, away_winner: f.teams.away.winner };
  } catch { return null; }
}

function evaluatePick(prediction, result, homeTeam, awayTeam) {
  const pred = prediction.toUpperCase();
  if (pred.includes('VICTORIA') && pred.includes(homeTeam.toUpperCase())) return result.home_winner === true;
  if (pred.includes('VICTORIA') && pred.includes(awayTeam.toUpperCase())) return result.away_winner === true;
  if (pred.includes('EMPATE')) return result.home_winner === null && result.away_winner === null;
  return false;
}

async function updateAccuracyStats() {
  const { data } = await sb.from('picks_history').select('correct').not('correct', 'is', null);
  if (!data?.length) return;
  const totalCorrect = data.filter(p => p.correct).length;
  const accuracy = Math.round((totalCorrect / data.length) * 100);
  await sb.from('config').upsert({ id: 1, accuracy_pct: accuracy, total_picks: data.length, correct_picks: totalCorrect });
  console.log(`[Accuracy] ${accuracy}% (${totalCorrect}/${data.length})`);
}

async function sendResultsRecap(updated, correct) {
  if (!TELEGRAM_BOT()) return;
  const accuracy = updated > 0 ? Math.round((correct / updated) * 100) : 0;
  const emoji = accuracy >= 80 ? '🔥' : '✅';
  const msg = `${emoji} *MR. MVX · RESULTADOS DEL DÍA*\n\n✅ Correctos: ${correct}/${updated}\n📈 Precisión: ${accuracy}%\n\n_mvxpicks.com_`;
  await telegramSendAll(msg);
}

// ═══════════════════════════════════════════════════════════════
// HELPERS — Football API / Brevo / Telegram / Meta CAPI
// ═══════════════════════════════════════════════════════════════
async function footballAPI(endpoint, params = {}) {
  const url = new URL(`https://${FOOTBALL_API_HOST}${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { 'x-rapidapi-key': FOOTBALL_API_KEY, 'x-rapidapi-host': FOOTBALL_API_HOST },
  });
  if (!res.ok) throw new Error(`API-Football ${res.status}`);
  return res.json();
}

async function telegramSend(chatId, text) {
  if (!TELEGRAM_BOT() || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT()}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });
  } catch (e) { console.error('[Telegram]', e.message); }
}

async function telegramSendAll(text) {
  for (const chatId of Object.values(GROUPS())) {
    if (chatId) await telegramSend(chatId, text);
  }
}

async function processSuccessfulPayment(pi) {
  const plan  = pi.metadata?.plan || 'pro';
  const email = pi.receipt_email;
  const name  = pi.metadata?.buyer_name || '';
  const phone = pi.metadata?.buyer_phone || '';
  if (!email) return;

  const { error: dbErr } = await sb.from('members').upsert({
    email, name, phone, plan,
    stripe_payment_intent: pi.id,
    amount_paid: pi.amount, currency: pi.currency,
    active: true, joined_at: new Date().toISOString(),
    picks_until: new Date('2026-07-20').toISOString(),
  }, { onConflict: 'stripe_payment_intent' });

  if (dbErr) { console.error('[processPayment] DB:', dbErr.message); return; }

  await sb.rpc('decrement_spots').catch(() => {});

  await addToBrevoList({
    email, firstName: name.split(' ')[0], lastName: name.split(' ').slice(1).join(' '),
    plan, orderValue: pi.amount / 100,
    telegramLink: GROUPS()[plan] || '',
    listId: parseInt(process.env.BREVO_BUYERS_LIST_ID || '7'),
  }).catch(() => {});

  await removeFromBrevoList(email, parseInt(process.env.BREVO_LEADS_LIST_ID || '6')).catch(() => {});

  await sendMetaCAPI({ event_name: 'Purchase', email, name, phone, value: pi.amount / 100, currency: pi.currency.toUpperCase(), event_id: pi.id, plan }).catch(() => {});

  await notifyAdmin({ name, email, plan, amount: pi.amount }).catch(() => {});

  console.log(`[processPayment] ✓ ${email} — ${plan} — $${pi.amount / 100} MXN`);
}

async function addToBrevoList({ email, firstName, lastName, plan, orderValue, telegramLink, listId }) {
  const r = await fetch('https://api.brevo.com/v3/contacts', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      attributes: { FIRSTNAME: firstName || '', LASTNAME: lastName || '', PLAN: plan || '', ORDER_VALUE: orderValue || 0, TELEGRAM_LINK: telegramLink || '', SOURCE: 'mrmvx_mundial26' },
      listIds: [listId],
      updateEnabled: true,
    }),
  });
  if (!r.ok && r.status !== 204) throw new Error(`Brevo ${r.status}`);
}

async function removeFromBrevoList(email, listId) {
  await fetch(`https://api.brevo.com/v3/contacts/lists/${listId}/contacts/remove`, {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ emails: [email] }),
  });
}

async function sendMetaCAPI({ event_name, email, name, phone, value, currency, event_id, plan }) {
  if (!process.env.META_PIXEL_ID || !process.env.META_ACCESS_TOKEN) return;
  const hash = s => crypto.createHash('sha256').update(s.toLowerCase().trim()).digest('hex');
  await fetch(`https://graph.facebook.com/v20.0/${process.env.META_PIXEL_ID}/events?access_token=${process.env.META_ACCESS_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      data: [{
        event_name, event_time: Math.floor(Date.now() / 1000), event_id, action_source: 'website',
        user_data: { em: [hash(email)], ph: phone ? [hash(phone.replace(/\D/g, ''))] : undefined, fn: name ? [hash(name.split(' ')[0])] : undefined },
        custom_data: { currency, value, content_name: `The Pick · ${plan}`, num_items: 1 },
      }],
    }),
  });
}

async function notifyAdmin({ name, email, plan, amount }) {
  if (!TELEGRAM_BOT() || !process.env.TELEGRAM_ADMIN_CHAT_ID) return;
  const labels = { basic: 'Básico', pro: 'Pro', elite: 'Élite' };
  const msg = `💰 *NUEVO MIEMBRO — Mr. MVX*\n\n👤 ${name}\n📧 ${email}\n📦 Plan: ${labels[plan] || plan}\n💵 $${(amount / 100).toFixed(0)} MXN`;
  await telegramSend(process.env.TELEGRAM_ADMIN_CHAT_ID, msg);
}

// ── Start ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Mr. MVX backend running on port ${PORT}`));
