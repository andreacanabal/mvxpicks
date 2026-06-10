// api/spots.js — Returns available spots from Supabase config table
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY  // public anon key is fine — config is public read
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  try {
    const { data, error } = await supabase
      .from('config')
      .select('spots_total, spots_sold, accuracy_pct')
      .eq('id', 1)
      .single();

    if (error || !data) throw error || new Error('No config row');

    return res.status(200).json({
      total:     data.spots_total,
      sold:      data.spots_sold,
      remaining: Math.max(0, data.spots_total - data.spots_sold),
      accuracy:  data.accuracy_pct,
    });
  } catch (_) {
    // Fallback if Supabase not configured yet
    return res.status(200).json({ total: 500, sold: 0, remaining: 500, accuracy: 95 });
  }
}
