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

// Verificar resultados cada 30 minutos entre 12PM y 11PM México
// Para detectar picks ganados inmediatamente al terminar los partidos
setInterval(async () => {
  const mxHour = parseInt(new Date().toLocaleString('en-US', {
    hour: 'numeric', hour12: false, timeZone: 'America/Mexico_City'
  }));
  if (mxHour >= 12 && mxHour <= 23) {
    await runCheckResults().catch(e => console.error('[autocheck]', e.message));
  }
}, 30 * 60 * 1000); // cada 30 minutos

console.log('[scheduler] Picks programados: 8:00 AM México · Resultados: cada 30min (12PM-11PM) + 11:00 PM México');

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
  const mxToday = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });

  // También pedir el día siguiente en UTC para capturar partidos nocturnos
  const utcTomorrow = new Date();
  utcTomorrow.setUTCDate(utcTomorrow.getUTCDate() + 1);
  const utcTomorrowStr = utcTomorrow.toISOString().split('T')[0];

  const utcDayAfter = new Date();
  utcDayAfter.setUTCDate(utcDayAfter.getUTCDate() + 2);
  const utcDayAfterStr = utcDayAfter.toISOString().split('T')[0];

  const [res1, res2, res3] = await Promise.all([
    footballAPI('/fixtures', { league: WC_LEAGUE_ID, season: WC_SEASON, date: mxToday }),
    footballAPI('/fixtures', { league: WC_LEAGUE_ID, season: WC_SEASON, date: utcTomorrowStr }),
    footballAPI('/fixtures', { league: WC_LEAGUE_ID, season: WC_SEASON, date: utcDayAfterStr }),
  ]);

  const all = [...(res1?.response || []), ...(res2?.response || []), ...(res3?.response || [])];

  // Filtrar: solo partidos que ocurren en las próximas 24h en hora México
  const now = Date.now();
  const in24h = now + 30 * 60 * 60 * 1000; // 30h para capturar partidos nocturnos

  return all.filter(f => {
    const kickoff = new Date(f.fixture.date).getTime();
    const status  = f.fixture.status.short;
    const finished = ['FT','AET','PEN','AWD','WO'].includes(status);
    return !finished && kickoff >= now - 3600000 && kickoff <= in24h;
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

  // Mensaje hype de apertura del día — solo si hay partidos
  await telegramSendAll(formatHypeMessage(picks));
  await sleep(2000);

  // Picks por plan
  for (const [plan, chatId] of Object.entries(groups)) {
    if (!chatId) continue;
    const picksToSend = plan === 'basic' ? [picks[0]]
                      : plan === 'pro'   ? picks.slice(0, 3)
                      : picks; // elite: TODOS
    await telegramSend(chatId, formatPicksMessage(picksToSend, plan));
    await sleep(1000);
  }

  // Parlay del día — solo Pro y Élite — picks con confianza >= 70%
  const parlayPicks = picks.filter(p => p.confidence >= 70).slice(0, 3);
  if (parlayPicks.length >= 2) {
    const parlayMsg = formatParlayMessage(parlayPicks);
    await telegramSend(groups.pro,   parlayMsg);
    await telegramSend(groups.elite, parlayMsg);
  }

  // Programar recordatorios 2h antes de cada partido
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

// ── PARLAY DEL DÍA ──
function formatParlayMessage(picks) {
  const parlayOdds = picks.reduce((acc, p) => acc * (p.odds_pick || 1.5), 1);
  const roundedOdds = Math.round(parlayOdds * 100) / 100;

  let msg = `🎯 *PARLAY SUGERIDO DEL DÍA*\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
  msg += `Combinación de los picks con mayor confianza:\n\n`;

  picks.forEach((p, i) => {
    msg += `${i + 1}. ⚽ *${p.home_team} vs ${p.away_team}*\n`;
    msg += `   Pick: *${p.prediction}* · ${p.confidence}%\n\n`;
  });

  msg += `━━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `📊 Cuota combinada estimada: *${roundedOdds}x*\n\n`;
  msg += `_El parlay es de alto riesgo. Apuesta solo lo que puedes perder._\n`;
  msg += `_mvxpicks.com_`;
  return msg;
}

// ── MENSAJE HYPE DE APERTURA ──
function formatHypeMessage(picks) {
  const dateStr = new Date().toLocaleDateString('es-MX', {
    weekday: 'long', day: 'numeric', month: 'long',
    timeZone: 'America/Mexico_City',
  }).toUpperCase();

  const totalPartidos = picks.length;
  const highConf = picks.filter(p => p.confidence >= 80).length;

  let msg = `⚡ *BUENOS DÍAS — ${dateStr}*\n\n`;
  msg += `El sistema procesó los partidos de hoy.\n\n`;
  msg += `📅 *${totalPartidos} partido${totalPartidos > 1 ? 's' : ''} hoy*\n`;
  if (highConf > 0) {
    msg += `🎯 *${highConf} pick${highConf > 1 ? 's' : ''} con confianza alta (+80%)*\n`;
  }
  msg += `\nLos picks completos llegan en un momento.\n`;
  msg += `_Publicados antes del partido. Sin editar._`;
  return msg;
}

// ── PICKS DEL DÍA ──
function formatPicksMessage(picks, plan) {
  const dateStr = new Date().toLocaleDateString('es-MX', {
    weekday: 'long', day: 'numeric', month: 'long',
    timeZone: 'America/Mexico_City',
  }).toUpperCase();

  const planLabel = { basic: 'BÁSICO', pro: 'PRO', elite: 'ÉLITE' }[plan] || plan.toUpperCase();
  const confBar = (pct) => {
    const filled = Math.round(pct / 10);
    return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ${pct}%`;
  };

  let msg = `🔮 *THE PICK — ${dateStr}*\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

  for (const p of picks) {
    const t = new Date(p.date).toLocaleTimeString('es-MX', {
      hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City',
    });

    // Nivel de confianza en texto
    const confLabel = p.confidence >= 85 ? '🔥 MUY ALTA'
                    : p.confidence >= 75 ? '✅ ALTA'
                    : p.confidence >= 65 ? '⚠️ MEDIA'
                    : '📊 MODERADA';

    msg += `⚽ *${p.home_team} vs ${p.away_team}*\n`;
    msg += `🕐 Hoy a las *${t} hrs* (México)\n\n`;
    msg += `🎯 *PICK: ${p.prediction}*\n`;
    msg += `${confBar(p.confidence)} — ${confLabel}\n\n`;

    // Razonamiento limpio — solo líneas con información real
    const cleanReasons = (p.reasoning || []).filter(r =>
      !r.includes('0%/0%') &&
      !r.includes('No predictions') &&
      !r.includes('undefined') &&
      r.trim().length > 5
    );

    if (cleanReasons.length > 0) {
      msg += `💡 *Por qué:*\n`;
      cleanReasons.forEach(r => { msg += `  · ${r}\n`; });
      msg += `\n`;
    }

    msg += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
  }

  msg += `_% publicado ANTES del partido · Sin editar_\n`;
  msg += `_mvxpicks.com_`;
  return msg;
}

// ── RECORDATORIOS 2H ANTES ──
function scheduleReminders(picks) {
  for (const pick of picks) {
    const kickoff = new Date(pick.date).getTime();
    const reminderTime = kickoff - (2 * 60 * 60 * 1000); // 2h antes
    const msUntil = reminderTime - Date.now();

    if (msUntil > 0 && msUntil < 24 * 60 * 60 * 1000) {
      setTimeout(async () => {
        const t = new Date(pick.date).toLocaleTimeString('es-MX', {
          hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City',
        });
        const msg = `⏰ *RECORDATORIO — 2 HORAS*\n\n`
          + `⚽ *${pick.home_team} vs ${pick.away_team}*\n`
          + `🕐 Arranca a las *${t} hrs* (México)\n\n`
          + `🎯 Pick: *${pick.prediction}*\n`
          + `📊 Confianza: *${pick.confidence}%*\n\n`
          + `_Ya tienes la información. Tú decides._`;
        await telegramSendAll(msg);
        console.log(`[Reminder] ✓ Enviado — ${pick.home_team} vs ${pick.away_team}`);
      }, msUntil);
      console.log(`[Reminder] Programado en ${(msUntil / 3600000).toFixed(1)}h — ${pick.home_team} vs ${pick.away_team}`);
    }
  }
}

// ── RESUMEN DE RESULTADOS (mejorado) ──
async function sendResultsRecap(updated, correct) {
  if (!TELEGRAM_BOT()) return;

  const accuracy = updated > 0 ? Math.round((correct / updated) * 100) : 0;
  const failed = updated - correct;

  const { data: allTime } = await sb
    .from('picks_history').select('correct').not('correct', 'is', null)
    .catch(() => ({ data: null }));

  const totalAll   = allTime?.length || updated;
  const correctAll = allTime?.filter(p => p.correct).length || correct;
  const accAll     = Math.round((correctAll / totalAll) * 100);

  let msg = `📊 *RESUMEN DEL DÍA — THE PICK*\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
  msg += `*Partidos de hoy:*\n`;
  msg += `✅ Acertados: *${correct}*\n`;
  if (failed > 0) msg += `❌ Fallidos: *${failed}*\n`;
  msg += `📈 Precisión hoy: *${accuracy}%*\n\n`;
  msg += `*Historial total del torneo:*\n`;
  msg += `🎯 ${correctAll}/${totalAll} picks correctos — *${accAll}% precisión*\n\n`;

  if (accuracy === 100) {
    msg += `🔥 *Día perfecto. Todos los picks acertados.*\n\n`;
  } else if (accuracy >= 80) {
    msg += `💪 *Muy buen día. El sistema sigue funcionando.*\n\n`;
  } else if (accuracy >= 60) {
    msg += `📊 *Día normal. El historial habla por sí solo.*\n\n`;
  }

  msg += `_mvxpicks.com_`;
  await telegramSendAll(msg);
}

// ── MENSAJE DE PICK ACERTADO (para enviar cuando se confirma resultado) ──
async function sendWinMessage(pick, result) {
  if (!TELEGRAM_BOT()) return;

  const msg = `✅ *PICK ACERTADO*\n\n`
    + `⚽ *${pick.home_team} vs ${pick.away_team}*\n`
    + `🏆 Resultado: *${result.home_goals}-${result.away_goals}*\n`
    + `🎯 Pick publicado: *${pick.prediction}*\n`
    + `📊 Confianza del sistema: *${pick.confidence}%*\n\n`
    + `_El historial no miente. Siguiente partido, siguiente pick._\n`
    + `_mvxpicks.com_`;

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

// ── Start ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Mr. MVX backend running on port ${PORT}`));
