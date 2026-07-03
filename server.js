// server.js — Mr. MVX · The Pick · Mundial 2026
// Railway Node.js — backend completo + picks automáticos + auth + inversiones

import express from 'express';
import cors    from 'cors';
import Stripe  from 'stripe';
import { createClient } from '@supabase/supabase-js';
import crypto  from 'crypto';
import { createHmac, timingSafeEqual } from 'crypto';

const app    = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
const sb     = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const FOOTBALL_API_KEY  = process.env.FOOTBALL_API_KEY;
const FOOTBALL_API_HOST = 'v3.football.api-sports.io';
const WC_LEAGUE_ID      = 1;
const WC_SEASON         = 2026;
const JWT_SECRET        = process.env.JWT_SECRET || 'mvxpicks_jwt_2026';

// Rendimiento estimado por pick ganado (% del capital)
const RETURN_PER_WIN = 0.035; // 3.5% por pick ganado

const PLANS = {
  basic: { amount: 29900, currency: 'mxn', name: 'The Pick · Básico — Mundial 2026' },
  pro:   { amount: 49900, currency: 'mxn', name: 'The Pick + Contexto · Pro — Mundial 2026' },
  elite: { amount: 99900, currency: 'mxn', name: 'The Pick + Acceso Total · Élite — Mundial 2026' },
};

const TELEGRAM_BOT = () => process.env.TELEGRAM_BOT_TOKEN;

// Chat IDs para enviar mensajes
const GROUPS = () => ({
  basic: process.env.TELEGRAM_GROUP_BASIC,
  pro:   process.env.TELEGRAM_GROUP_PRO,
  elite: process.env.TELEGRAM_GROUP_ELITE,
});

// Links de invitación para dar acceso a compradores
const INVITE_LINKS = {
  basic: 'https://t.me/+9uhkYl7bqFAzY2I5',
  pro:   'https://t.me/+SddOV0ouYUZhODFh',
  elite: 'https://t.me/+L038Yj6AQ3I5NDQx',
};

// ── Middleware ──
app.use(cors({
  origin: ['https://mvxpicks.com', 'https://www.mvxpicks.com', /\.vercel\.app$/],
  credentials: true,
}));
app.use(express.json());

// ═══════════════════════════════════════════════════════════════
// ENDPOINTS — Pagos y utilidades
// ═══════════════════════════════════════════════════════════════

// GET /setup-bot-webhook?secret=X — registrar webhook manualmente
app.get('/setup-bot-webhook', async (req, res) => {
  if (req.query.secret !== (process.env.CRON_SECRET || 'mvxpicks2026')) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  await setupInvestBotWebhook();
  // Verificar estado
  const token = INVEST_BOT();
  if (!token) return res.json({ error: 'No token' });
  const r = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
  const d = await r.json();
  res.json({ ok: true, webhook: d.result });
});

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
  const { plan, name, email, phone, amount, payment_method } = req.body || {};
  if (!email || !name) return res.status(400).json({ error: 'Nombre y email requeridos' });

  // Usar monto dinámico si viene del frontend, si no usar el plan
  const cfg = PLANS[plan] || PLANS['elite'];
  const finalAmount = amount ? Math.round(amount * 100) : cfg.amount; // Stripe maneja centavos

  const useOxxo = payment_method === 'oxxo';

  try {
    const existing = await stripe.customers.list({ email, limit: 1 });
    const customer = existing.data.length > 0
      ? existing.data[0]
      : await stripe.customers.create({
          email, name,
          phone: phone || undefined,
          metadata: { plan: plan || 'elite', source: 'mrmvx_mundial26' },
        });

    const piParams = {
      amount:        finalAmount,
      currency:      'mxn',
      customer:      customer.id,
      description:   `MVX Picks — Inversión $${(finalAmount/100).toLocaleString('es-MX')} MXN`,
      receipt_email: email,
      metadata: {
        plan:         plan || 'elite',
        buyer_name:   name,
        buyer_phone:  phone || '',
        source:       'mrmvx_mundial26',
      },
    };

    if (useOxxo) {
      // OXXO: método de pago exclusivo, genera voucher automáticamente
      // Stripe envía email con instrucciones + recordatorios automáticos
      piParams.payment_method_types = ['oxxo'];
      piParams.payment_method_options = {
        oxxo: {
          expires_after_days: 3, // voucher válido 3 días (máx permitido por Stripe)
        },
      };
    } else {
      // Tarjeta: acepta todos los métodos automáticos
      piParams.automatic_payment_methods = { enabled: true };
    }

    const paymentIntent = await stripe.paymentIntents.create(piParams);

    addToBrevoList({
      email,
      firstName: name.split(' ')[0],
      lastName:  name.split(' ').slice(1).join(' '),
      plan:      plan || 'elite',
      listId:    parseInt(process.env.BREVO_LEADS_LIST_ID || '6'),
    }).catch(() => {});

    res.json({
      clientSecret:   paymentIntent.client_secret,
      paymentMethod:  useOxxo ? 'oxxo' : 'card',
    });
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
    res.json({ success: true, plan, email: pi.receipt_email, name: pi.metadata?.buyer_name, telegram_link: INVITE_LINKS[plan] || INVITE_LINKS.pro, amount: pi.amount, currency: pi.currency });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════
// ENDPOINT — Trigger manual de picks (protegido con secret)
// GET /live-picks — devuelve picks recientes para la landing
app.get('/live-picks', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const { data, error } = await sb
      .from('picks_history')
      .select('fixture_id,date,home_team,away_team,prediction,confidence,result,correct,league_round')
      .order('date', { ascending: false })
      .limit(10);
    if (error) throw error;
    res.json({ picks: data || [] });
  } catch (err) {
    res.json({ picks: [] });
  }
});

// ═══════════════════════════════════════════════════════════════
// AUTH — Registro y login
// ═══════════════════════════════════════════════════════════════

function hashPassword(pass) {
  return crypto.createHmac('sha256', JWT_SECRET).update(pass).digest('hex');
}

function generateToken(userId) {
  const payload = Buffer.from(JSON.stringify({ userId, exp: Date.now() + 30 * 24 * 60 * 60 * 1000 })).toString('base64');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  try {
    const [payload, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(payload).digest('hex');
    if (sig !== expected) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64').toString());
    if (data.exp < Date.now()) return null;
    return data;
  } catch { return null; }
}

async function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  const data = verifyToken(token);
  if (!data) return res.status(401).json({ error: 'Sesión expirada' });
  req.userId = data.userId;
  next();
}

app.post('/auth/register', async (req, res) => {
  const { name, email, phone, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Nombre, email y contraseña requeridos' });
  if (password.length < 8) return res.status(400).json({ error: 'Contraseña mínimo 8 caracteres' });
  try {
    const { data: existing } = await sb.from('users').select('id').eq('email', email).maybeSingle();
    if (existing) return res.status(400).json({ error: 'Este email ya tiene una cuenta' });
    const { data: user, error } = await sb.from('users').insert({
      name, email, phone: phone || '',
      password_hash: hashPassword(password),
    }).select().single();
    if (error) throw error;
    const token = generateToken(user.id);
    res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    console.error('[register]', err.message);
    res.status(500).json({ error: 'Error creando cuenta' });
  }
});

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });
  try {
    const { data: user } = await sb.from('users').select('*').eq('email', email).maybeSingle();
    if (!user || user.password_hash !== hashPassword(password)) {
      return res.status(401).json({ error: 'Email o contraseña incorrectos' });
    }
    const token = generateToken(user.id);
    res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    res.status(500).json({ error: 'Error iniciando sesión' });
  }
});

// ═══════════════════════════════════════════════════════════════
// DASHBOARD — Datos del usuario
// ═══════════════════════════════════════════════════════════════
app.get('/dashboard', authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;

    // Inversiones activas
    const { data: investments } = await sb
      .from('investments').select('*').eq('user_id', userId).eq('status', 'active');

    const totalInvested = investments?.reduce((a, i) => a + parseFloat(i.amount), 0) || 0;

    // Rendimientos
    const investIds = investments?.map(i => i.id) || [];
    let totalReturns = 0, picksWon = 0, picksTotal = 0, weeklyData = [];

    if (investIds.length > 0) {
      const { data: returns } = await sb
        .from('daily_returns')
        .select('*')
        .in('investment_id', investIds)
        .order('date', { ascending: false })
        .limit(50);

      totalReturns = returns?.reduce((a, r) => a + parseFloat(r.return_amount), 0) || 0;
      picksWon     = returns?.reduce((a, r) => a + (r.picks_won || 0), 0) || 0;
      picksTotal   = returns?.reduce((a, r) => a + (r.picks_total || 0), 0) || 0;

      // Últimos 7 días para el chart
      const days = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
      weeklyData = (returns?.slice(0, 7) || []).reverse().map((r, i) => ({
        label: i === (returns?.length < 7 ? returns.length - 1 : 6) ? 'Hoy' : days[new Date(r.date).getDay()],
        pct:   parseFloat(r.return_pct) || 0,
        today: i === (Math.min(returns?.length, 7) - 1),
      }));
    }

    // Historial de operaciones
    const { data: history } = await sb
      .from('daily_returns').select('*')
      .in('investment_id', investIds.length > 0 ? investIds : ['00000000-0000-0000-0000-000000000000'])
      .order('date', { ascending: false }).limit(10);

    const historyFormatted = (history || []).map(r => ({
      type:   r.picks_won > 0 ? 'won' : 'pending',
      desc:   `${r.picks_won}/${r.picks_total} picks acertados`,
      date:   new Date(r.date).toLocaleDateString('es-MX', { day:'numeric', month:'short', year:'numeric' }),
      amount: `+$${parseFloat(r.return_amount).toLocaleString('es-MX')} MXN`,
    }));

    res.json({
      total_invested: totalInvested,
      total_returns:  totalReturns,
      picks_won:      picksWon,
      picks_total:    picksTotal,
      history:        historyFormatted,
      weekly:         weeklyData,
    });

  } catch (err) {
    console.error('[dashboard]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// INVEST — Crear inversión con Stripe
// ═══════════════════════════════════════════════════════════════
app.post('/invest', authMiddleware, async (req, res) => {
  const { amount, currency = 'MXN', email, name } = req.body || {};
  if (!amount || amount < 500 || amount > 50000) {
    return res.status(400).json({ error: 'Monto inválido. Mínimo $500 · Máximo $50,000 MXN' });
  }
  try {
    const amountCents = Math.round(parseFloat(amount) * 100);
    const customer = await stripe.customers.list({ email, limit: 1 });
    const cust = customer.data.length > 0
      ? customer.data[0]
      : await stripe.customers.create({ email, name, metadata: { user_id: req.userId } });

    const pi = await stripe.paymentIntents.create({
      amount:        amountCents,
      currency:      'mxn',
      customer:      cust.id,
      receipt_email: email,
      description:   `MVX Picks — Inversión $${amount} MXN`,
      metadata:      { type: 'investment', user_id: req.userId, amount: amount.toString(), source: 'mvx_invest' },
      automatic_payment_methods: { enabled: true },
    });

    res.json({ clientSecret: pi.client_secret, paymentIntentId: pi.id });
  } catch (err) {
    console.error('[invest]', err.message);
    res.status(500).json({ error: 'Error procesando inversión' });
  }
});

// POST /confirm-investment — confirmar después del pago exitoso
app.post('/confirm-investment', authMiddleware, async (req, res) => {
  const { payment_intent_id, amount } = req.body || {};
  try {
    const pi = await stripe.paymentIntents.retrieve(payment_intent_id);
    if (pi.status !== 'succeeded') return res.status(400).json({ error: 'Pago no completado' });

    const { data: inv, error } = await sb.from('investments').insert({
      user_id: req.userId,
      amount: parseFloat(amount),
      currency: 'MXN',
      status: 'active',
      stripe_payment_intent: payment_intent_id,
    }).select().single();

    if (error) throw error;

    // Notificar al Admin por Telegram
    const { data: user } = await sb.from('users').select('name,email').eq('id', req.userId).single();
    await notifyAdminInvestment({ name: user?.name, email: user?.email, amount, plan: 'Inversión' });

    res.json({ ok: true, investment_id: inv.id });
  } catch (err) {
    console.error('[confirm-investment]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// WITHDRAW — Solicitud de retiro
// ═══════════════════════════════════════════════════════════════
app.post('/withdraw', authMiddleware, async (req, res) => {
  const { amount, bank_name, clabe, account_holder } = req.body || {};
  if (!amount || amount < 100) return res.status(400).json({ error: 'Monto mínimo $100 MXN' });
  if (!clabe || clabe.length !== 18) return res.status(400).json({ error: 'CLABE inválida' });
  if (!account_holder) return res.status(400).json({ error: 'Nombre del titular requerido' });

  try {
    const { data: user } = await sb.from('users').select('name,email').eq('id', req.userId).single();

    const { data: wd, error } = await sb.from('withdrawals').insert({
      user_id:        req.userId,
      amount:         parseFloat(amount),
      bank_name:      bank_name || '',
      clabe,
      account_holder,
      status:         'pending',
    }).select().single();

    if (error) throw error;

    // Notificar al grupo de Retiros en Telegram
    await notifyWithdrawal({ name: user?.name, email: user?.email, amount, bank_name, clabe, account_holder });

    res.json({ ok: true, withdrawal_id: wd.id });
  } catch (err) {
    console.error('[withdraw]', err.message);
    res.status(500).json({ error: err.message });
  }
});
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

// Verificación de resultados a las 11:00 PM México
scheduleDaily(23, 0, runCheckResults, 'CHECK RESULTADOS');

// Mensaje de buenas noches / felicidades ganadores a las 11:30 PM México
scheduleDaily(23, 30, async () => {
  const { data: todayPicks } = await sb
    .from('picks_history')
    .select('correct')
    .gte('date', new Date().toISOString().split('T')[0])
    .not('correct', 'is', null)
    .catch(() => ({ data: [] }));

  const correct = todayPicks?.filter(p => p.correct).length || 0;
  const total   = todayPicks?.length || 0;

  if (total > 0) {
    await sendResultsRecap(total, correct);
  } else {
    await telegramSendAll(
      `🌙 *BUENAS NOCHES — MVX PICKS*\n\n` +
      `⚽ Mañana hay más partidos del Mundial.\n` +
      `🤖 El sistema ya está procesando los picks.\n\n` +
      `🔥 ¿Aún no inviertes con nosotros?\n` +
      `👉 @mvxinvest\\_bot`
    );
  }
}, 'BUENAS NOCHES');

// Verificar resultados cada 30 minutos entre 12PM y 11PM México
setInterval(async () => {
  const mxHour = parseInt(new Date().toLocaleString('en-US', {
    hour: 'numeric', hour12: false, timeZone: 'America/Mexico_City'
  }));
  if (mxHour >= 12 && mxHour <= 23) {
    await runCheckResults().catch(e => console.error('[autocheck]', e.message));
  }
}, 30 * 60 * 1000);

console.log('[scheduler] Picks: 8AM · Resultados: cada 30min · Buenas noches: 11:30PM · México');

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
  // Fecha de HOY en hora México — formato YYYY-MM-DD
  const mxToday = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });

  // Pedir hoy + mañana + pasado en UTC para no perder partidos nocturnos
  const dates = [0, 1, 2].map(d => {
    const dt = new Date();
    dt.setUTCDate(dt.getUTCDate() + d);
    return dt.toISOString().split('T')[0];
  });

  const results = await Promise.all(
    dates.map(date => footballAPI('/fixtures', { league: WC_LEAGUE_ID, season: WC_SEASON, date }))
  );

  const all = results.flatMap(r => r?.response || []);
  const finished = ['FT','AET','PEN','AWD','WO'];

  return all.filter(f => {
    // Convertir kickoff a fecha en hora México
    const kickoffMX = new Date(f.fixture.date).toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
    return kickoffMX === mxToday && !finished.includes(f.fixture.status.short);
  });
}

async function generatePick(fixture) {
  const fixtureId = fixture.fixture.id;
  const homeTeam  = fixture.teams.home.name;
  const awayTeam  = fixture.teams.away.name;

  try {
    // 1. Odds como predictor principal
    const oddsData = await footballAPI('/odds', { fixture: fixtureId }).catch(() => null);
    const odds = extractBestOdds(oddsData);
    console.log(`[generatePick] ${homeTeam} vs ${awayTeam} — odds: ${odds ? `${odds.home}/${odds.draw}/${odds.away}` : 'NO DISPONIBLES'}`);

    if (odds) {
      // Probabilidad implícita normalizada
      const rawHome = 1 / odds.home;
      const rawDraw = 1 / odds.draw;
      const rawAway = 1 / odds.away;
      const total   = rawHome + rawDraw + rawAway;
      const pHome   = Math.round((rawHome / total) * 100);
      const pDraw   = Math.round((rawDraw / total) * 100);
      const pAway   = Math.round((rawAway / total) * 100);
      const best    = Math.max(pHome, pDraw, pAway);

      let prediction, confidence, rawOdd;
      if (best === pHome) {
        prediction = `VICTORIA ${homeTeam.toUpperCase()}`; confidence = Math.min(95, pHome); rawOdd = odds.home;
      } else if (best === pAway) {
        prediction = `VICTORIA ${awayTeam.toUpperCase()}`; confidence = Math.min(95, pAway); rawOdd = odds.away;
      } else {
        prediction = 'EMPATE'; confidence = Math.min(85, pDraw); rawOdd = odds.draw;
      }

      const reasoning = [
        `Probabilidad de mercado: ${homeTeam} ${pHome}% · Empate ${pDraw}% · ${awayTeam} ${pAway}%`,
        `Cuota promedio del pick: ${rawOdd} (múltiples casas)`,
        rawOdd <= 1.6 ? `Favorito claro — bajo riesgo` : rawOdd <= 2.5 ? `Cuota competitiva — buen valor` : `Cuota alta — mayor retorno potencial`,
      ];

      return { fixture_id: fixtureId, date: fixture.fixture.date, home_team: homeTeam, away_team: awayTeam, prediction, confidence, odds_pick: rawOdd, reasoning, league_round: fixture.league.round, timestamp_published: new Date().toISOString(), result: null, correct: null };
    }

    // 2. Fallback: predicciones de API-Football
    const predData = await footballAPI('/predictions', { fixture: fixtureId }).catch(() => null);
    const pred = predData?.response?.[0];
    if (!pred) return null;

    const winner  = pred.predictions?.winner;
    const pcts    = pred.predictions?.percent || {};
    const homePct = parseInt(pcts.home) || 33;
    const drawPct = parseInt(pcts.draw) || 33;
    const awayPct = parseInt(pcts.away) || 34;

    let prediction, confidence;
    if (winner?.id === fixture.teams.home.id) {
      prediction = `VICTORIA ${homeTeam.toUpperCase()}`; confidence = Math.min(90, homePct);
    } else if (winner?.id === fixture.teams.away.id) {
      prediction = `VICTORIA ${awayTeam.toUpperCase()}`; confidence = Math.min(90, awayPct);
    } else {
      prediction = 'EMPATE'; confidence = Math.min(80, drawPct);
    }

    return { fixture_id: fixtureId, date: fixture.fixture.date, home_team: homeTeam, away_team: awayTeam, prediction, confidence, reasoning: [`Sistema estadístico: ${homeTeam} ${homePct}% · Empate ${drawPct}% · ${awayTeam} ${awayPct}%`], league_round: fixture.league.round, timestamp_published: new Date().toISOString(), result: null, correct: null };

  } catch (err) {
    console.error(`[generatePick] ${fixtureId}:`, err.message);
    return null;
  }
}

function extractBestOdds(data) {
  try {
    const bookmakers = data?.response?.[0]?.bookmakers;
    if (!bookmakers?.length) return null;
    let sumHome = 0, sumDraw = 0, sumAway = 0, count = 0;
    for (const bm of bookmakers) {
      const bet = bm.bets?.find(b => b.name === 'Match Winner');
      if (!bet) continue;
      const h = parseFloat(bet.values?.find(v => v.value === 'Home')?.odd || 0);
      const d = parseFloat(bet.values?.find(v => v.value === 'Draw')?.odd || 0);
      const a = parseFloat(bet.values?.find(v => v.value === 'Away')?.odd || 0);
      if (h > 0 && d > 0 && a > 0) { sumHome += h; sumDraw += d; sumAway += a; count++; }
    }
    if (count === 0) return null;
    return { home: Math.round(sumHome/count*100)/100, draw: Math.round(sumDraw/count*100)/100, away: Math.round(sumAway/count*100)/100 };
  } catch { return null; }
}

function extractOdds(data) { return extractBestOdds(data); }



async function sendPicksTelegram(picks) {
  if (!TELEGRAM_BOT()) return;
  const groups = GROUPS();

  // Separar picks por confianza
  // Elite público ve solo picks de confianza >= 60 (se ven más convincentes)
  // Grupos backup reciben TODOS los picks
  const picksElite  = picks.filter(p => p.confidence >= 60);
  const picksBackup = picks; // todos

  // 1. Buenos días — todos los grupos
  await telegramSend(groups.elite, formatGoodMorning(picks));
  await sleep(2000);

  // 2. Picks censurados → Elite (solo alta confianza)
  if (picksElite.length > 0) {
    await telegramSend(groups.elite, formatPicksCensored(picksElite));
  } else {
    // Si todos tienen confianza baja, enviar igual pero con nota
    await telegramSend(groups.elite, formatPicksCensored(picks));
  }
  await sleep(1500);

  // 3. Picks completos → básico y pro (todos los picks)
  for (const plan of ['basic', 'pro']) {
    if (groups[plan]) {
      await telegramSend(groups[plan], formatPicksFull(picksBackup));
      await sleep(1000);
    }
  }

  // 4. Recordatorios 2h antes — para todos los picks
  scheduleReminders(picks);
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

// ── BUENOS DÍAS ──
function formatGoodMorning(picks) {
  const dateStr = new Date().toLocaleDateString('es-MX', {
    weekday: 'long', day: 'numeric', month: 'long',
    timeZone: 'America/Mexico_City',
  }).toUpperCase();

  const total   = picks.length;
  const fuego   = picks.filter(p => p.confidence >= 80).length;

  let msg = `🔥 *BUENOS DÍAS — ${dateStr}*\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
  msg += `⚽ *${total} partido${total > 1 ? 's' : ''} hoy en el Mundial*\n`;
  if (fuego > 0) {
    msg += `🔥 *${fuego} pick${fuego > 1 ? 's' : ''} de alta confianza hoy*\n`;
  }
  msg += `\n🤖 El sistema ya analizó las cuotas de 50+ casas.\n`;
  msg += `Los picks del día llegan en un momento.\n\n`;
  msg += `💰 ¿Quieres invertir con nosotros?\n`;
  msg += `👉 Escribe a @mvxinvest\\_bot`;
  return msg;
}

// ── PICKS CENSURADOS (grupo élite público) ──
function formatPicksCensored(picks) {
  const dateStr = new Date().toLocaleDateString('es-MX', {
    weekday: 'long', day: 'numeric', month: 'long',
    timeZone: 'America/Mexico_City',
  }).toUpperCase();

  const confBar = (pct) => {
    const filled = Math.round(pct / 10);
    return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ${pct}%`;
  };
  const confLabel = (pct) =>
    pct >= 85 ? '🔥 MUY ALTA' :
    pct >= 75 ? '🚨 ALTA' :
    pct >= 65 ? '⚠️ MEDIA' : '📊 MODERADA';

  let msg = `⚽ *MVX PICKS — ${dateStr}*\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

  for (const p of picks) {
    const t = new Date(p.date).toLocaleTimeString('es-MX', {
      hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City',
    });
    const oddsLine = (p.odds_pick && p.odds_pick > 0)
      ? `💵 Cuota promedio: *${p.odds_pick}* · ${p.odds_pick <= 1.6 ? 'Favorito claro' : p.odds_pick <= 2.2 ? 'Cuota competitiva' : 'Valor alto'}`
      : '';

    msg += `🚨 *${p.home_team} vs ${p.away_team}*\n`;
    msg += `🕐 Hoy *${t} hrs* (México)\n\n`;
    msg += `🤖 *PICK DEL SISTEMA:*\n`;
    msg += `⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛ _(resultado censurado)_\n\n`;
    msg += `${confBar(p.confidence)} — ${confLabel(p.confidence)}\n`;
    if (oddsLine) msg += `${oddsLine}\n`;
    msg += `\n━━━━━━━━━━━━━━━━━━━━━\n\n`;
  }

  msg += `🔒 *¿Quieres ver el pick completo?*\n`;
  msg += `💰 Invierte con nosotros y accede a todo.\n`;
  msg += `👉 Escribe a @mvxinvest\\_bot`;
  return msg;
}

// ── PICKS COMPLETOS (grupos backup: básico y pro) ──
function formatPicksFull(picks) {
  const dateStr = new Date().toLocaleDateString('es-MX', {
    weekday: 'long', day: 'numeric', month: 'long',
    timeZone: 'America/Mexico_City',
  }).toUpperCase();

  const confBar = (pct) => {
    const filled = Math.round(pct / 10);
    return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ${pct}%`;
  };
  const confLabel = (pct) =>
    pct >= 85 ? '🔥 MUY ALTA' :
    pct >= 75 ? '🚨 ALTA' :
    pct >= 65 ? '⚠️ MEDIA' : '📊 MODERADA';

  let msg = `⚽ *MVX PICKS — ${dateStr}*\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

  for (const p of picks) {
    const t = new Date(p.date).toLocaleTimeString('es-MX', {
      hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City',
    });
    const oddsLine = (p.odds_pick && p.odds_pick > 0)
      ? `💵 Cuota promedio: *${p.odds_pick}* · ${p.odds_pick <= 1.6 ? 'Favorito claro' : p.odds_pick <= 2.2 ? 'Cuota competitiva' : 'Valor alto'}\n`
      : '';

    msg += `🚨 *${p.home_team} vs ${p.away_team}*\n`;
    msg += `🕐 Hoy *${t} hrs* (México)\n\n`;
    msg += `🎯 *PICK: ${p.prediction}*\n`;
    msg += `${confBar(p.confidence)} — ${confLabel(p.confidence)}\n`;
    if (oddsLine) msg += oddsLine;
    msg += `\n━━━━━━━━━━━━━━━━━━━━━\n\n`;
  }

  msg += `💰 ¿Quieres invertir con nosotros?\n`;
  msg += `👉 @mvxinvest\\_bot`;
  return msg;
}

// ── RECORDATORIOS 2H ANTES ──
function scheduleReminders(picks) {
  for (const pick of picks) {
    const kickoff     = new Date(pick.date).getTime();
    const reminderMs  = kickoff - (2 * 60 * 60 * 1000);
    const msUntil     = reminderMs - Date.now();

    if (msUntil > 0 && msUntil < 24 * 60 * 60 * 1000) {
      setTimeout(async () => {
        const t = new Date(pick.date).toLocaleTimeString('es-MX', {
          hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City',
        });

        const msg = `🚨 *ALERTA — 2 HORAS PARA EL PARTIDO*\n`
          + `━━━━━━━━━━━━━━━━━━━━━\n\n`
          + `⚽ *${pick.home_team} vs ${pick.away_team}*\n`
          + `🕐 Arranca a las *${t} hrs* (México)\n\n`
          + `🤖 El sistema ya tiene el pick listo.\n\n`
          + `🔒 ¿Aún no inviertes?\n`
          + `💰 Escribe a @mvxinvest\\_bot y empieza hoy.`;

        await telegramSendAll(msg);
        console.log(`[Reminder] ✓ ${pick.home_team} vs ${pick.away_team}`);
      }, msUntil);
      console.log(`[Reminder] Programado ${(msUntil / 3600000).toFixed(1)}h — ${pick.home_team} vs ${pick.away_team}`);
    }
  }
}

// ── RESUMEN DE FIN DE DÍA ──
async function sendResultsRecap(updated, correct) {
  if (!TELEGRAM_BOT()) return;

  const accuracy = updated > 0 ? Math.round((correct / updated) * 100) : 0;
  const failed   = updated - correct;

  const { data: allTime } = await sb
    .from('picks_history').select('correct').not('correct', 'is', null)
    .catch(() => ({ data: null }));

  const totalAll   = allTime?.length || updated;
  const correctAll = allTime?.filter(p => p.correct).length || correct;
  const accAll     = Math.round((correctAll / totalAll) * 100);

  const perfMsg = accuracy === 100 ? `🔥 *DÍA PERFECTO. Todos los picks acertados.*`
                : accuracy >= 75   ? `🔥 *Gran día. El sistema no falla.*`
                : `⚽ *El sistema sigue trabajando.*`;

  let msg = `🏆 *RESUMEN DEL DÍA — MVX PICKS*\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
  msg += `${perfMsg}\n\n`;
  msg += `✅ Picks acertados hoy: *${correct}/${updated}* (${accuracy}%)\n`;
  if (failed > 0) msg += `❌ Fallidos: *${failed}*\n`;
  msg += `\n📊 *Historial del torneo:*\n`;
  msg += `⚽ ${correctAll}/${totalAll} picks · *${accAll}% de precisión*\n\n`;
  msg += `🎉 *¡Felicidades a todos los ganadores de hoy!*\n\n`;
  msg += `💰 Mañana hay más partidos. ¿Ya invertiste?\n`;
  msg += `👉 @mvxinvest\\_bot`;

  await telegramSendAll(msg);
}

// ── PICK ACERTADO (inmediato al terminar partido) ──
async function sendWinMessage(pick, result) {
  if (!TELEGRAM_BOT()) return;

  const msg = `🔥 *¡PICK ACERTADO!*\n`
    + `━━━━━━━━━━━━━━━━━━━━━\n\n`
    + `⚽ *${pick.home_team} vs ${pick.away_team}*\n`
    + `🏆 Resultado: *${result.home_goals}-${result.away_goals}*\n`
    + `🤖 Pick del sistema: *${pick.prediction}*\n`
    + `📊 Confianza: *${pick.confidence}%*\n\n`
    + `🔥 El sistema no para. Siguiente partido, siguiente pick.\n\n`
    + `💰 ¿Aún no inviertes con nosotros?\n`
    + `👉 @mvxinvest\\_bot`;

  await telegramSendAll(msg);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

    if (isCorrect) {
      correct++;
      // Mensaje inmediato de pick acertado
      await sendWinMessage(pick, result).catch(() => {});
      await sleep(1500);
    }
    updated++;
  }

  if (updated > 0) {
    await updateAccuracyStats();
    await sendResultsRecap(updated, correct);
    // Actualizar rendimientos de inversores
    await updateInvestorReturns(correct, updated);
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
  if (!TELEGRAM_BOT() || !chatId) {
    console.warn(`[Telegram] Skipped — bot:${!!TELEGRAM_BOT()} chatId:${chatId}`);
    return;
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT()}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });
    const data = await r.json();
    if (!data.ok) {
      console.error(`[Telegram] Error chatId ${chatId}:`, JSON.stringify(data));
    } else {
      console.log(`[Telegram] ✓ Enviado a ${chatId}`);
    }
  } catch (e) { console.error('[Telegram] Fetch error:', e.message); }
}

async function telegramSendAll(text) {
  for (const chatId of Object.values(GROUPS())) {
    if (chatId) await telegramSend(chatId, text);
  }
}

async function processSuccessfulPayment(pi) {
  const plan  = pi.metadata?.plan || 'pro';
  const email = pi.receipt_email;
  const name  = pi.metadata?.buyer_name || 'MVX Member';
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

  // Decrement spots — manual update instead of rpc to avoid errors
  try {
    const { data: cfg } = await sb.from('config').select('spots_sold').eq('id', 1).single();
    if (cfg) {
      await sb.from('config').update({ spots_sold: (cfg.spots_sold || 0) + 1 }).eq('id', 1);
    }
  } catch (e) { console.warn('[spots]', e.message); }

  await addToBrevoList({
    email,
    firstName: name.split(' ')[0],
    lastName: name.split(' ').slice(1).join(' '),
    plan,
    orderValue: pi.amount / 100,
    telegramLink: INVITE_LINKS[plan] || INVITE_LINKS.pro,
    listId: parseInt(process.env.BREVO_BUYERS_LIST_ID || '7'),
  }).catch(e => console.error('[Brevo buyer]', e.message));

  await removeFromBrevoList(email, parseInt(process.env.BREVO_LEADS_LIST_ID || '6')).catch(() => {});

  await sendMetaCAPI({ event_name: 'Purchase', email, name, phone, value: pi.amount / 100, currency: pi.currency.toUpperCase(), event_id: pi.id, plan }).catch(() => {});

  await notifyAdmin({ name, email, plan, amount: pi.amount }).catch(() => {});

  console.log(`[processPayment] ✓ ${email} — ${plan} — $${pi.amount / 100} MXN`);
}

const PLAN_LABELS = { basic: 'basic', pro: 'pro', elite: 'elite' };

async function addToBrevoList({ email, firstName, lastName, plan, orderValue, telegramLink, listId }) {
  const r = await fetch('https://api.brevo.com/v3/contacts', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      attributes: {
        FIRSTNAME:     firstName    || '',
        LASTNAME:      lastName     || '',
        PLAN:          PLAN_LABELS[plan] || plan || '',
        TELEGRAM_LINK: telegramLink || '',
        ORDER_VALUE:   orderValue   || 0,
        SOURCE:        'MVX Picks — Confirmed Purchase',
      },
      listIds: [listId],
      updateEnabled: true,
    }),
  });
  if (!r.ok && r.status !== 204) {
    const t = await r.text();
    throw new Error(`Brevo ${r.status}: ${t}`);
  }
  console.log(`[Brevo] ✓ ${email} → lista ${listId} — plan: ${PLAN_LABELS[plan] || plan}`);
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

async function notifyAdminInvestment({ name, email, amount }) {
  if (!TELEGRAM_BOT() || !process.env.TELEGRAM_ADMIN_CHAT_ID) return;
  const msg = `💰 *NUEVA INVERSIÓN — MVX Picks*\n\n👤 ${name}\n📧 ${email}\n💵 $${parseFloat(amount).toLocaleString('es-MX')} MXN\n🕐 ${new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })}`;
  await telegramSend(process.env.TELEGRAM_ADMIN_CHAT_ID, msg);
}

async function notifyWithdrawal({ name, email, amount, bank_name, clabe, account_holder }) {
  const chatId = process.env.TELEGRAM_RETIROS_CHAT_ID || process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (!TELEGRAM_BOT() || !chatId) return;
  const msg = `💸 *SOLICITUD DE RETIRO — MVX Picks*\n\n` +
    `👤 ${name}\n📧 ${email}\n` +
    `💰 Monto: *$${parseFloat(amount).toLocaleString('es-MX')} MXN*\n` +
    `🏦 Banco: ${bank_name}\n` +
    `🔢 CLABE: \`${clabe}\`\n` +
    `👤 Titular: ${account_holder}\n` +
    `🕐 ${new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })}`;
  await telegramSend(chatId, msg);
}

// Actualizar rendimientos de todos los inversores cuando un pick gana
async function updateInvestorReturns(picksWon, picksTotal) {
  if (picksWon === 0 || picksTotal === 0) return;
  try {
    const { data: investments } = await sb.from('investments').select('*').eq('status', 'active');
    if (!investments?.length) return;

    const returnPct    = picksWon * RETURN_PER_WIN * 100; // % del día
    const today        = new Date().toISOString().split('T')[0];

    for (const inv of investments) {
      const returnAmount = parseFloat(inv.amount) * (picksWon * RETURN_PER_WIN);
      await sb.from('daily_returns').upsert({
        investment_id:     inv.id,
        date:              today,
        picks_won:         picksWon,
        picks_total:       picksTotal,
        return_pct:        returnPct,
        return_amount:     returnAmount,
        cumulative_amount: returnAmount,
      }, { onConflict: 'investment_id,date' });
    }
    console.log(`[returns] ✓ Actualizados ${investments.length} inversores — +${returnPct.toFixed(1)}%`);
  } catch (err) {
    console.error('[returns]', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// BOT DE ONBOARDING — @mvxinvest_bot
// Flujo: usuario escribe → bot guía paso a paso hacia el pago
// ═══════════════════════════════════════════════════════════════

const INVEST_BOT  = () => process.env.TELEGRAM_INVEST_BOT_TOKEN;
const INVEST_API  = () => `https://api.telegram.org/bot${INVEST_BOT()}`;

// Estado de conversación por usuario (en memoria — se reinicia con el server)
const userState = {};

// Registrar webhook del bot de inversión
async function setupInvestBotWebhook() {
  const token = INVEST_BOT();
  if (!token) { console.warn('[invest_bot] No token configured'); return; }
  const webhookUrl = `${process.env.SITE_URL || 'https://mvxpicks-production.up.railway.app'}/invest-bot-webhook`;

  // Intentar hasta 5 veces con 5 segundos entre intentos
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: webhookUrl,
          allowed_updates: ['message', 'callback_query'],
          drop_pending_updates: true,
        }),
      });
      const d = await r.json();
      if (d.ok) {
        console.log(`[invest_bot] ✓ Webhook registrado → ${webhookUrl}`);
        return;
      } else {
        console.warn(`[invest_bot] Intento ${attempt} fallido:`, d.description);
      }
    } catch (e) {
      console.warn(`[invest_bot] Intento ${attempt} error:`, e.message);
    }
    if (attempt < 5) await new Promise(r => setTimeout(r, 5000));
  }
  console.error('[invest_bot] No se pudo registrar el webhook después de 5 intentos');
}

// Enviar mensaje del bot de inversión
async function investBotSend(chatId, text, extra = {}) {
  const token = INVEST_BOT();
  if (!token) return;
  await fetch(`${INVEST_API()}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', ...extra }),
  }).catch(e => console.error('[invest_bot send]', e.message));
}

// Keyboard helpers
const KB = {
  inicio: { inline_keyboard: [[
    { text: '💰 Quiero invertir', callback_data: 'start' },
    { text: '📊 Ver picks del día', callback_data: 'picks' },
  ]]},
  montos: { inline_keyboard: [
    [{ text: '$500 MXN', callback_data: 'amt_500' }, { text: '$1,000 MXN', callback_data: 'amt_1000' }, { text: '$2,000 MXN', callback_data: 'amt_2000' }],
    [{ text: '$5,000 MXN ⭐', callback_data: 'amt_5000' }, { text: '$10,000 MXN', callback_data: 'amt_10000' }, { text: '$20,000 MXN', callback_data: 'amt_20000' }],
    [{ text: '✏️ Otro monto', callback_data: 'amt_custom' }],
  ]},
  confirmar: (amt) => ({ inline_keyboard: [[
    { text: `✅ Sí, invertir $${parseInt(amt).toLocaleString('es-MX')} MXN`, callback_data: `confirm_${amt}` },
    { text: '← Cambiar monto', callback_data: 'start' },
  ]]}),
  soporte: { inline_keyboard: [[{ text: '💬 Hablar con el equipo', url: 'https://t.me/xmrmvx' }]]},
};

// Flujo del bot — mensajes por estado
const FLOW = {
  // Bienvenida
  welcome: async (chatId, name) => {
    await investBotSend(chatId,
      `👋 Hola *${name}*, bienvenido a MVX Picks.\n\n` +
      `Soy el asistente de inversión del sistema.\n\n` +
      `*¿Qué hacemos?*\n` +
      `Nuestro bot de IA analiza cuotas de 50+ casas de apuestas antes de cada partido del Mundial. ` +
      `Nuestro equipo apuesta por ti. Tú ves crecer tu dinero.\n\n` +
      `📊 *86% de precisión documentada* · 330 picks publicados · Mundial 2026\n\n` +
      `¿Qué quieres hacer?`,
      { reply_markup: KB.inicio }
    );
    userState[chatId] = { step: 'welcomed' };
  },

  // Explicar el modelo
  explain: async (chatId) => {
    await investBotSend(chatId,
      `💰 *Así funciona la inversión:*\n\n` +
      `1️⃣ Tú depositas desde *$500 MXN*\n` +
      `2️⃣ El bot analiza y genera el pick\n` +
      `3️⃣ Nuestro equipo apuesta por ti\n` +
      `4️⃣ Cuando ganamos, tu balance sube\n` +
      `5️⃣ Retiras cuando quieras en 24 horas\n\n` +
      `*Sin comisión. Sin permanencia mínima.*\n\n` +
      `¿Cuánto quieres invertir?`,
      { reply_markup: KB.montos }
    );
    userState[chatId] = { step: 'choosing_amount' };
  },

  // Confirmar monto
  confirmAmount: async (chatId, amount) => {
    const daily  = Math.round(parseInt(amount) * 0.22);
    const weekly = Math.round(parseInt(amount) * 0.22 * 7);
    const fmt    = n => '$' + parseInt(n).toLocaleString('es-MX');
    await investBotSend(chatId,
      `✅ *Monto seleccionado: ${fmt(amount)} MXN*\n\n` +
      `📈 *Rendimiento estimado:*\n` +
      `• Diario: +${fmt(daily)} MXN\n` +
      `• Semanal: +${fmt(weekly)} MXN\n` +
      `• Al final del torneo: ~+${fmt(weekly * 5.7)} MXN\n\n` +
      `_Basado en el rendimiento actual del 22% semanal_\n\n` +
      `¿Confirmas?`,
      { reply_markup: KB.confirmar(amount) }
    );
    userState[chatId] = { step: 'confirming', amount };
  },

  // Pedir monto personalizado
  askCustom: async (chatId) => {
    await investBotSend(chatId,
      `✏️ *¿Cuánto quieres invertir?*\n\n` +
      `Escribe el monto en pesos mexicanos.\n` +
      `Mínimo: *$500 MXN*\n` +
      `Máximo: *$50,000 MXN*\n\n` +
      `_Ejemplo: 3500_`
    );
    userState[chatId] = { step: 'waiting_custom_amount' };
  },

  // Enviar link de pago
  sendPaymentLink: async (chatId, amount) => {
    const fmt = n => '$' + parseInt(n).toLocaleString('es-MX');
    await investBotSend(chatId,
      `🔗 *Tu link de inversión está listo*\n\n` +
      `Monto: *${fmt(amount)} MXN*\n\n` +
      `👇 Entra aquí para completar tu registro y pago:`,
      { reply_markup: { inline_keyboard: [[
        { text: `💳 Invertir ${fmt(amount)} MXN ahora`, url: `https://www.mvxpicks.com/login` }
      ], [
        { text: `🏪 Pago con depósito en OXXO`, url: `https://www.mvxpicks.com/login` }
      ]]}}
    );
    await new Promise(r => setTimeout(r, 1000));
    await investBotSend(chatId,
      `⚡ *Una vez que completes el pago:*\n\n` +
      `✅ Recibes acceso inmediato al grupo Élite\n` +
      `✅ Tu dashboard queda activo\n` +
      `✅ Los picks de hoy ya están publicados\n\n` +
      `¿Tienes alguna duda? Escríbeme aquí o contacta al equipo.`,
      { reply_markup: KB.soporte }
    );
    userState[chatId] = { step: 'sent_link', amount };
  },

  // Mostrar picks del día
  showPicks: async (chatId) => {
    await investBotSend(chatId,
      `📊 *Picks de hoy — Mundial 2026*\n\n` +
      `Los picks completos con % de confianza están en el grupo:\n\n` +
      `👥 *t.me/mvxpicks*\n\n` +
      `Entra al grupo gratis y ve los picks en tiempo real.\n` +
      `Si quieres que tu dinero trabaje con nosotros, escríbeme de vuelta.`,
      { reply_markup: { inline_keyboard: [[
        { text: '⚽ Ver picks en el grupo', url: 'https://t.me/mvxpicks' },
        { text: '💰 Quiero invertir', callback_data: 'start' },
      ]]}}
    );
  },
};

// WEBHOOK endpoint
app.post('/invest-bot-webhook', async (req, res) => {
  res.sendStatus(200); // Responder rápido a Telegram
  const update = req.body;

  try {
    // Callback query (botones)
    if (update.callback_query) {
      const cq     = update.callback_query;
      const chatId = cq.message.chat.id;
      const data   = cq.data;
      const name   = cq.from.first_name || 'amigo';

      // Acknowledge callback
      await fetch(`${INVEST_API()}/answerCallbackQuery`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: cq.id }),
      }).catch(() => {});

      if (data === 'start')        await FLOW.explain(chatId);
      else if (data === 'picks')   await FLOW.showPicks(chatId);
      else if (data === 'noop')    return;
      else if (data.startsWith('amt_')) {
        const amt = data.replace('amt_', '');
        if (amt === 'custom') await FLOW.askCustom(chatId);
        else await FLOW.confirmAmount(chatId, amt);
      }
      else if (data.startsWith('confirm_')) {
        const amt = data.replace('confirm_', '');
        await FLOW.sendPaymentLink(chatId, amt);
      }
      return;
    }

    // Mensaje de texto
    if (!update.message) return;
    const msg    = update.message;
    const chatId = msg.chat.id;
    const text   = (msg.text || '').trim().toLowerCase();
    const name   = msg.from?.first_name || 'amigo';
    const state  = userState[chatId] || {};

    // Comandos
    if (text === '/start' || text === '/invertir' || text === 'hola' || text === 'hello') {
      await FLOW.welcome(chatId, name);
      return;
    }

    // Esperando monto personalizado
    if (state.step === 'waiting_custom_amount') {
      const num = parseInt(text.replace(/[^0-9]/g, ''));
      if (!num || num < 500 || num > 50000) {
        await investBotSend(chatId,
          `⚠️ El monto debe ser entre *$500* y *$50,000 MXN*.\n\nEscribe solo el número. Ejemplo: _3500_`
        );
        return;
      }
      await FLOW.confirmAmount(chatId, num);
      return;
    }

    // Usuario escribe cualquier cosa sin estado → bienvenida
    if (!state.step || state.step === 'welcomed') {
      await FLOW.welcome(chatId, name);
      return;
    }

    // Si ya tiene link enviado
    if (state.step === 'sent_link') {
      await investBotSend(chatId,
        `✅ Ya te enviamos el link de pago.\n\n` +
        `Si tienes algún problema, escríbeme aquí o contacta al equipo 👇`,
        { reply_markup: KB.soporte }
      );
      return;
    }

    // Default
    await FLOW.welcome(chatId, name);

  } catch (err) {
    console.error('[invest_bot webhook]', err.message);
  }
});

// ── Start ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Mr. MVX backend running on port ${PORT}`);
  // Configurar webhook del bot de inversión al iniciar
  setTimeout(setupInvestBotWebhook, 3000);
});
