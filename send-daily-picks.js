// api/send-daily-picks.js
// ═══════════════════════════════════════════════════════════════
// DAILY PICKS ENGINE — Mr. MVX · The Pick · Mundial 2026
// ═══════════════════════════════════════════════════════════════
//
// HOW TO TRIGGER:
//   Option A (recommended): Vercel Cron Job → runs daily at 8AM Mexico City time
//   Set in vercel.json: "crons": [{ "path": "/api/send-daily-picks", "schedule": "0 14 * * *" }]
//   (14:00 UTC = 8:00 AM CDT Mexico)
//
//   Option B: Manual HTTP GET with secret header
//   GET https://yourdomain.com/api/send-daily-picks
//   Header: x-cron-secret: YOUR_CRON_SECRET
//
// FOOTBALL DATA API:
//   Uses API-Football (api-football.com) — recommended for World Cup 2026
//   Plan: Basic ($10/mo) or Pro ($25/mo) — has FIFA World Cup data
//   Alternative: football-data.org (free tier has WC data)
//   Sign up at: https://www.api-football.com/
//
// ═══════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ── World Cup 2026 FIFA league ID on API-Football ──
const WC_LEAGUE_ID = 1;  // Replace with actual ID once API-Football confirms for 2026
const WC_SEASON    = 2026;

export default async function handler(req, res) {
  // Auth: only allow Vercel cron or secret header
  const cronSecret = req.headers['x-cron-secret'];
  if (cronSecret !== process.env.CRON_SECRET && req.headers['x-vercel-cron'] !== '1') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // 1. Get today's World Cup fixtures
    const fixtures = await getTodayFixtures();

    if (!fixtures || fixtures.length === 0) {
      console.log('[DailyPicks] No fixtures today.');
      return res.status(200).json({ sent: 0, message: 'No fixtures today' });
    }

    // 2. Generate picks for each fixture
    const picks = [];
    for (const fixture of fixtures) {
      const pick = await generatePick(fixture);
      if (pick) picks.push(pick);
    }

    if (picks.length === 0) {
      return res.status(200).json({ sent: 0, message: 'No picks generated' });
    }

    // 3. Get all active members from DB
    const { data: members, error } = await supabase
      .from('members')
      .select('email, name, phone, plan')
      .eq('active', true)
      .lte('picks_until', new Date('2026-07-20').toISOString());

    if (error) throw error;

    // 4. Send picks to Telegram groups (by plan)
    await sendPicksToTelegram(picks);

    // 5. Send WhatsApp to members who have phone (Pro + Elite only)
    let whatsappSent = 0;
    for (const member of members) {
      if (['pro', 'elite'].includes(member.plan) && member.phone) {
        await sendWhatsAppPick(member, picks);
        whatsappSent++;
        // Rate limit: 1 msg per 300ms
        await new Promise(r => setTimeout(r, 300));
      }
    }

    // 6. Save picks to DB for public historial
    await savePicksToHistory(picks);

    console.log(`[DailyPicks] Sent ${picks.length} picks to ${members.length} members (${whatsappSent} via WhatsApp)`);
    return res.status(200).json({
      success: true,
      picks: picks.length,
      members: members.length,
      whatsappSent,
    });

  } catch (err) {
    console.error('[DailyPicks] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════
// FOOTBALL API — GET TODAY'S WORLD CUP FIXTURES
// ═══════════════════════════════════════════════════════════════
async function getTodayFixtures() {
  // API-Football: https://www.api-football.com/documentation-v3
  // Endpoint: GET /fixtures?league={id}&season={year}&date={YYYY-MM-DD}

  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  const res = await fetch(
    `https://v3.football.api-sports.io/fixtures?league=${WC_LEAGUE_ID}&season=${WC_SEASON}&date=${today}`,
    {
      headers: {
        'x-rapidapi-host': 'v3.football.api-sports.io',
        'x-rapidapi-key':  process.env.FOOTBALL_API_KEY,
      },
    }
  );

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Football API error: ${res.status} — ${t}`);
  }

  const data = await res.json();
  return data.response || [];
}

// ═══════════════════════════════════════════════════════════════
// PICK GENERATOR — Confidence % logic
// ═══════════════════════════════════════════════════════════════
async function generatePick(fixture) {
  const f = fixture.fixture;
  const teams = fixture.teams;
  const goals = fixture.goals;
  const league = fixture.league;

  // Get H2H and team stats from API-Football
  const [h2h, homeStats, awayStats, odds] = await Promise.allSettled([
    fetchH2H(teams.home.id, teams.away.id),
    fetchTeamStats(teams.home.id),
    fetchTeamStats(teams.away.id),
    fetchOdds(f.id),
  ]);

  // ── Confidence Algorithm ──
  // This is a simplified scoring model. Replace with your ML model or external predictor.
  let confidence = 50; // baseline
  let prediction = 'DRAW';
  let reasoning  = [];

  const homeH2H = h2h.status === 'fulfilled' ? h2h.value?.home_wins || 0 : 0;
  const awayH2H = h2h.status === 'fulfilled' ? h2h.value?.away_wins || 0 : 0;
  const totalH2H = homeH2H + awayH2H + (h2h.value?.draws || 0) || 1;

  // H2H factor (±10 points)
  const h2hEdge = ((homeH2H - awayH2H) / totalH2H) * 10;
  confidence += h2hEdge;
  if (Math.abs(h2hEdge) > 3) {
    reasoning.push(h2hEdge > 0
      ? `${teams.home.name} ganó ${homeH2H} de los últimos enfrentamientos directos`
      : `${teams.away.name} tiene ventaja en enfrentamientos directos`);
  }

  // Form factor from team stats (±15 points)
  const homeForm = homeStats.status === 'fulfilled' ? homeStats.value?.form_score || 0 : 0;
  const awayForm = awayStats.status === 'fulfilled' ? awayStats.value?.form_score || 0 : 0;
  const formEdge = (homeForm - awayForm) * 0.15;
  confidence += formEdge;
  if (Math.abs(formEdge) > 5) {
    reasoning.push(formEdge > 0
      ? `${teams.home.name} en mejor forma reciente`
      : `${teams.away.name} en mejor forma reciente`);
  }

  // Odds factor (if available) — market consensus is strong signal (±20 points)
  if (odds.status === 'fulfilled' && odds.value) {
    const o = odds.value;
    const impliedHome = 1 / (o.home || 2);
    const impliedAway = 1 / (o.away || 2);
    const oddsEdge = (impliedHome - impliedAway) * 20;
    confidence += oddsEdge;
    if (Math.abs(oddsEdge) > 5) {
      reasoning.push(`El mercado da ${Math.round(impliedHome * 100)}% de probabilidad a ${teams.home.name}`);
    }
  }

  // Round and clamp confidence
  confidence = Math.min(98, Math.max(52, Math.round(confidence)));

  // Determine prediction based on final confidence and edge direction
  if (h2hEdge + formEdge > 5) {
    prediction = `VICTORIA ${teams.home.name.toUpperCase()}`;
  } else if (h2hEdge + formEdge < -5) {
    prediction = `VICTORIA ${teams.away.name.toUpperCase()}`;
  } else {
    prediction = 'EMPATE O MENOS DE 2.5 GOLES';
    confidence = Math.min(72, confidence); // draws are harder to predict
  }

  // Build pick object
  return {
    fixture_id:   f.id,
    date:         f.date,
    home_team:    teams.home.name,
    away_team:    teams.away.name,
    prediction,
    confidence,
    reasoning:    reasoning.slice(0, 3), // max 3 reasons
    league_round: league.round,
    venue:        f.venue?.name || '',
    timestamp_published: new Date().toISOString(),
    result: null, // filled in by results checker
    correct: null,
  };
}

// ═══════════════════════════════════════════════════════════════
// TELEGRAM — Send picks to group channels
// ═══════════════════════════════════════════════════════════════
async function sendPicksToTelegram(picks) {
  const BOT = process.env.TELEGRAM_BOT_TOKEN;
  if (!BOT) return;

  // All plans get picks (Basic gets 1 pick/day — the highest confidence one)
  // Pro + Elite get all picks

  const topPick     = picks.sort((a, b) => b.confidence - a.confidence)[0];
  const allPicksMsg = formatPicksMessage(picks);
  const topPickMsg  = formatPicksMessage([topPick]);

  const groups = {
    basic: process.env.TELEGRAM_GROUP_BASIC,
    pro:   process.env.TELEGRAM_GROUP_PRO,
    elite: process.env.TELEGRAM_GROUP_ELITE,
  };

  for (const [plan, chatId] of Object.entries(groups)) {
    if (!chatId) continue;
    const msg = plan === 'basic' ? topPickMsg : allPicksMsg;
    await telegramSend(BOT, chatId, msg);
  }
}

function formatPicksMessage(picks) {
  const dateStr = new Date().toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
  let msg = `🔮 *MR. MVX · THE PICK — ${dateStr.toUpperCase()}*\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

  for (const p of picks) {
    const time = new Date(p.date).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' });
    msg += `⚽ *${p.home_team} vs ${p.away_team}*\n`;
    msg += `🕐 ${time} (Hora México) · ${p.league_round}\n`;
    msg += `🎯 Pick: *${p.prediction}*\n`;
    msg += `📊 Confianza del sistema: *${p.confidence}%*\n`;
    if (p.reasoning?.length) {
      msg += `💡 Razonamiento:\n`;
      p.reasoning.forEach(r => { msg += `   • ${r}\n`; });
    }
    msg += `\n`;
  }

  msg += `━━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `_El pick muestra la confianza del sistema ANTES del partido._\n`;
  msg += `_Historial público y verificable en tiempo real._`;
  return msg;
}

async function telegramSend(botToken, chatId, text) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });
    if (!r.ok) console.error('[Telegram] Send failed:', await r.text());
  } catch (e) {
    console.error('[Telegram] Error:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// WHATSAPP — Send to individual Pro/Elite members
// ═══════════════════════════════════════════════════════════════
async function sendWhatsAppPick(member, picks) {
  if (!process.env.TWILIO_ACCOUNT_SID) return;

  const topPick  = picks[0]; // already sorted by confidence
  const isElite  = member.plan === 'elite';
  const picksToSend = isElite ? picks : [topPick];

  const lines = picksToSend.map(p => {
    const time = new Date(p.date).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' });
    return `⚽ ${p.home_team} vs ${p.away_team} (${time})\n🎯 ${p.prediction} — ${p.confidence}% confianza`;
  }).join('\n\n');

  const msg = `Hola ${member.name} 👋\n\n🔮 *PICKS DE HOY — Mr. MVX*\n\n${lines}\n\n_Llegan 2h antes del pitazo. Apostá con criterio._`;

  const phone = member.phone.replace(/\s/g, '').replace(/^\+?/, '+');
  const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`;

  try {
    await fetch(twilioUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64'),
      },
      body: new URLSearchParams({
        From: `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`,
        To:   `whatsapp:${phone}`,
        Body: msg,
      }),
    });
  } catch (e) {
    console.error(`[WhatsApp] Failed to send to ${phone}:`, e.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// SUPABASE — Save picks for public historial
// ═══════════════════════════════════════════════════════════════
async function savePicksToHistory(picks) {
  const rows = picks.map(p => ({
    fixture_id:           p.fixture_id,
    date:                 p.date,
    home_team:            p.home_team,
    away_team:            p.away_team,
    prediction:           p.prediction,
    confidence:           p.confidence,
    reasoning:            p.reasoning,
    league_round:         p.league_round,
    timestamp_published:  p.timestamp_published,
    result:               null,
    correct:              null,
  }));

  const { error } = await supabase.from('picks_history').upsert(rows, { onConflict: 'fixture_id' });
  if (error) console.error('[Supabase] Save picks error:', error.message);
}

// ═══════════════════════════════════════════════════════════════
// HELPERS — Football API calls
// ═══════════════════════════════════════════════════════════════
async function fetchH2H(team1Id, team2Id) {
  try {
    const r = await fetch(`https://v3.football.api-sports.io/fixtures/headtohead?h2h=${team1Id}-${team2Id}&last=10`, {
      headers: { 'x-rapidapi-key': process.env.FOOTBALL_API_KEY, 'x-rapidapi-host': 'v3.football.api-sports.io' },
    });
    const d = await r.json();
    const fixtures = d.response || [];
    return {
      home_wins: fixtures.filter(f => f.teams.home.id === team1Id && f.teams.home.winner).length,
      away_wins: fixtures.filter(f => f.teams.away.id === team2Id && f.teams.away.winner).length,
      draws:     fixtures.filter(f => !f.teams.home.winner && !f.teams.away.winner).length,
    };
  } catch { return null; }
}

async function fetchTeamStats(teamId) {
  try {
    const r = await fetch(`https://v3.football.api-sports.io/teams/statistics?team=${teamId}&league=${WC_LEAGUE_ID}&season=${WC_SEASON}`, {
      headers: { 'x-rapidapi-key': process.env.FOOTBALL_API_KEY, 'x-rapidapi-host': 'v3.football.api-sports.io' },
    });
    const d = await r.json();
    const s = d.response?.fixtures;
    if (!s) return null;
    const wins = s.wins?.total || 0;
    const total = (s.played?.total || 1);
    return { form_score: (wins / total) * 100 };
  } catch { return null; }
}

async function fetchOdds(fixtureId) {
  try {
    const r = await fetch(`https://v3.football.api-sports.io/odds?fixture=${fixtureId}&bookmaker=8`, { // bookmaker 8 = Bet365
      headers: { 'x-rapidapi-key': process.env.FOOTBALL_API_KEY, 'x-rapidapi-host': 'v3.football.api-sports.io' },
    });
    const d = await r.json();
    const bets = d.response?.[0]?.bookmakers?.[0]?.bets?.[0]?.values;
    if (!bets) return null;
    return {
      home: parseFloat(bets.find(b => b.value === 'Home')?.odd || 0),
      draw: parseFloat(bets.find(b => b.value === 'Draw')?.odd || 0),
      away: parseFloat(bets.find(b => b.value === 'Away')?.odd || 0),
    };
  } catch { return null; }
}
