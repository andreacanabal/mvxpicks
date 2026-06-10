// api/check-results.js
// Runs AFTER each match day to update pick accuracy in Supabase
// Trigger: Vercel Cron at 23:00 UTC daily (or manual)
// "crons": [{ "path": "/api/check-results", "schedule": "0 23 * * *" }]

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const WC_LEAGUE_ID = 1;
const WC_SEASON    = 2026;

export default async function handler(req, res) {
  const cronSecret = req.headers['x-cron-secret'];
  if (cronSecret !== process.env.CRON_SECRET && req.headers['x-vercel-cron'] !== '1') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Get all picks without results yet, from today or earlier
    const { data: pending, error } = await supabase
      .from('picks_history')
      .select('*')
      .is('result', null)
      .lte('date', new Date().toISOString());

    if (error) throw error;
    if (!pending?.length) return res.status(200).json({ updated: 0 });

    let updated = 0;
    let correct = 0;

    for (const pick of pending) {
      const result = await getFixtureResult(pick.fixture_id);
      if (!result) continue;

      // Check if pick was correct
      const isCorrect = evaluatePick(pick.prediction, result, pick.home_team, pick.away_team);

      await supabase.from('picks_history').update({
        result: `${result.home_goals}-${result.away_goals}`,
        correct: isCorrect,
      }).eq('fixture_id', pick.fixture_id);

      if (isCorrect) correct++;
      updated++;
    }

    // Update overall accuracy in config table
    if (updated > 0) {
      await updateAccuracyStats();

      // Send results recap to Telegram groups
      if (process.env.TELEGRAM_BOT_TOKEN) {
        await sendResultsRecap(pending, updated, correct);
      }
    }

    return res.status(200).json({ updated, correct, accuracy: updated > 0 ? Math.round((correct/updated)*100) : null });

  } catch (err) {
    console.error('[CheckResults] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

async function getFixtureResult(fixtureId) {
  try {
    const r = await fetch(`https://v3.football.api-sports.io/fixtures?id=${fixtureId}`, {
      headers: { 'x-rapidapi-key': process.env.FOOTBALL_API_KEY, 'x-rapidapi-host': 'v3.football.api-sports.io' },
    });
    const d = await r.json();
    const f = d.response?.[0];
    if (!f || f.fixture.status.short !== 'FT') return null; // Not finished
    return {
      home_goals: f.goals.home,
      away_goals: f.goals.away,
      home_winner: f.teams.home.winner,
      away_winner: f.teams.away.winner,
    };
  } catch { return null; }
}

function evaluatePick(prediction, result, homeTeam, awayTeam) {
  const pred = prediction.toUpperCase();
  if (pred.includes('VICTORIA') && pred.includes(homeTeam.toUpperCase())) {
    return result.home_winner === true;
  }
  if (pred.includes('VICTORIA') && pred.includes(awayTeam.toUpperCase())) {
    return result.away_winner === true;
  }
  if (pred.includes('EMPATE')) {
    return result.home_winner === null && result.away_winner === null;
  }
  if (pred.includes('MENOS DE 2.5')) {
    return (result.home_goals + result.away_goals) < 3;
  }
  if (pred.includes('MÁS DE 2.5') || pred.includes('MAS DE 2.5')) {
    return (result.home_goals + result.away_goals) >= 3;
  }
  return false;
}

async function updateAccuracyStats() {
  const { data } = await supabase
    .from('picks_history')
    .select('correct')
    .not('correct', 'is', null);

  if (!data?.length) return;
  const totalCorrect = data.filter(p => p.correct).length;
  const accuracy = Math.round((totalCorrect / data.length) * 100);

  await supabase.from('config').upsert({ id: 1, accuracy_pct: accuracy, total_picks: data.length, correct_picks: totalCorrect });
}

async function sendResultsRecap(picks, updated, correct) {
  const accuracy = updated > 0 ? Math.round((correct/updated)*100) : 0;
  const msg = `📊 *MR. MVX · RESULTADOS DEL DÍA*\n\n✅ Picks correctos: ${correct}/${updated}\n📈 Precisión de hoy: ${accuracy}%\n\n_Historial completo actualizado en tiempo real._`;

  const groups = [
    process.env.TELEGRAM_GROUP_BASIC,
    process.env.TELEGRAM_GROUP_PRO,
    process.env.TELEGRAM_GROUP_ELITE,
  ].filter(Boolean);

  for (const chatId of groups) {
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'Markdown' }),
    });
  }
}
