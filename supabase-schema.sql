-- ═══════════════════════════════════════════════════════════════
-- SUPABASE SCHEMA — Mr. MVX · The Pick · Mundial 2026
-- Run this in your Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════

-- Members table
CREATE TABLE IF NOT EXISTS members (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                TEXT NOT NULL UNIQUE,
  name                 TEXT NOT NULL,
  phone                TEXT,
  plan                 TEXT NOT NULL CHECK (plan IN ('basic', 'pro', 'elite')),
  stripe_payment_intent TEXT,
  amount_paid          INTEGER,
  currency             TEXT DEFAULT 'mxn',
  active               BOOLEAN DEFAULT TRUE,
  joined_at            TIMESTAMPTZ DEFAULT NOW(),
  picks_until          TIMESTAMPTZ DEFAULT '2026-07-20 00:00:00+00',
  notes                TEXT
);

-- Picks history (public record — the core trust asset)
CREATE TABLE IF NOT EXISTS picks_history (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id           INTEGER UNIQUE NOT NULL,
  date                 TIMESTAMPTZ NOT NULL,
  home_team            TEXT NOT NULL,
  away_team            TEXT NOT NULL,
  prediction           TEXT NOT NULL,
  confidence           INTEGER NOT NULL CHECK (confidence BETWEEN 1 AND 100),
  reasoning            JSONB,
  league_round         TEXT,
  venue                TEXT,
  timestamp_published  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  result               TEXT,       -- e.g. "2-1"
  correct              BOOLEAN,    -- NULL until match ends
  created_at           TIMESTAMPTZ DEFAULT NOW()
);

-- Site config (spots counter, accuracy stats)
CREATE TABLE IF NOT EXISTS config (
  id               INTEGER PRIMARY KEY DEFAULT 1,
  spots_total      INTEGER DEFAULT 500,
  spots_sold       INTEGER DEFAULT 0,
  accuracy_pct     INTEGER DEFAULT 95,
  total_picks      INTEGER DEFAULT 0,
  correct_picks    INTEGER DEFAULT 0,
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Seed config row
INSERT INTO config (id, spots_total, spots_sold) VALUES (1, 500, 0)
ON CONFLICT (id) DO NOTHING;

-- Function to safely decrement spots
CREATE OR REPLACE FUNCTION decrement_spots()
RETURNS VOID AS $$
BEGIN
  UPDATE config
  SET spots_sold = LEAST(spots_sold + 1, spots_total),
      updated_at = NOW()
  WHERE id = 1;
END;
$$ LANGUAGE plpgsql;

-- Row Level Security (RLS) — allow public read on picks_history (for historial page)
ALTER TABLE picks_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public picks read" ON picks_history FOR SELECT USING (true);

-- Members are private (server-only via service key)
ALTER TABLE members ENABLE ROW LEVEL SECURITY;

-- Config is publicly readable (for spots counter)
ALTER TABLE config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public config read" ON config FOR SELECT USING (true);

-- Index for performance
CREATE INDEX IF NOT EXISTS idx_members_email  ON members(email);
CREATE INDEX IF NOT EXISTS idx_members_active ON members(active);
CREATE INDEX IF NOT EXISTS idx_picks_date     ON picks_history(date);
CREATE INDEX IF NOT EXISTS idx_picks_correct  ON picks_history(correct);
