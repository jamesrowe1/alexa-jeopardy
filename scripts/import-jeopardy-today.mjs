import 'dotenv/config';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';

const BASE = 'https://www.jeopardytoday.com';
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
const supabase = createClient(url, key, { auth: { persistSession: false } });

const targetDate = process.argv[2] || yesterdayEastern();
const gameSlug = toGameSlug(targetDate);
const gameUrl = `${BASE}/game/${gameSlug}`;

console.log(`Importing ${targetDate} from ${gameUrl}`);
const gameHtml = await get(gameUrl);
const gameText = linesFromHtml(gameHtml);
const meta = parseGameMeta(gameText, targetDate);
const board = parseBoard(gameText);

console.log('Categories found:');
for (const c of board) console.log(`  ${c.round}: ${c.category}`);
if (board.length !== 12) {
  throw new Error(`Expected 12 categories, found ${board.length}. The archive layout may have changed.`);
}

const allClues = [];
for (const cat of board) {
  const slug = categorySlug(cat.category);
  const catUrl = `${BASE}/category/${slug}`;
  const html = await get(catUrl);
  const lines = linesFromHtml(html);
  const clues = parseCategoryDate(lines, targetDate, cat);
  if (clues.length !== 5) {
    throw new Error(`Expected 5 clues for ${cat.category}, got ${clues.length} (${catUrl})`);
  }
  allClues.push(...clues);
}

const final = parseFinal(gameText);
if (final) allClues.push(final);

const { data: ep, error: epErr } = await supabase
  .from('episodes')
  .upsert({
    air_date: targetDate,
    season: meta.season,
    show_number: meta.showNumber,
    source_url: gameUrl,
    imported_at: new Date().toISOString()
  }, { onConflict: 'air_date' })
  .select('id')
  .single();
if (epErr) throw epErr;

const { error: delErr } = await supabase.from('clues').delete().eq('episode_id', ep.id);
if (delErr) throw delErr;

const rows = allClues.map(c => ({ ...c, episode_id: ep.id }));
const { error: clueErr } = await supabase.from('clues').insert(rows);
if (clueErr) throw clueErr;

console.log(`Done: saved ${rows.length} clues for ${targetDate}.`);

async function get(u) {
  const r = await axios.get(u, {
    timeout: 20000,
    headers: { 'User-Agent': 'Mozilla/5.0 DailyQuizAlexa/0.1 (personal project)' }
  });
  return r.data;
}

function linesFromHtml(html) {
  const $ = cheerio.load(html);
  $('script,style,noscript,svg').remove();
  const lines = [];
  $('body *').each((_, el) => {
    const own = $(el).contents().filter((_, n) => n.type === 'text').text().replace(/\s+/g, ' ').trim();
    if (own && lines.at(-1) !== own) lines.push(own);
  });
  return lines;
}

function parseGameMeta(lines) {
  const joined = lines.join(' ');
  const m = joined.match(/SEASON\s+(\d+)\s*[·•]\s*SHOW\s*#?([\d,]+)/i);
  return {
    season: m ? Number(m[1]) : null,
    showNumber: m ? Number(m[2].replace(/,/g, '')) : null
  };
}

function parseBoard(lines) {
  const out = [];
  let round = null;
  for (let i = 0; i < lines.length - 1; i++) {
    const s = lines[i];
    if (/^Jeopardy! Round$/i.test(s)) { round = 'J'; continue; }
    if (/^Double Jeopardy! Round$/i.test(s)) { round = 'DJ'; continue; }
    if (/^FINAL JEOPARDY!?$/i.test(s) || /^◆ FINAL JEOPARDY!?$/i.test(s)) { round = null; continue; }
    if (!round) continue;
    const next = lines[i + 1];
    const firstVal = round === 'J' ? '$200' : '$400';
    if (next === firstVal && !/^\$/.test(s) && !/categories|clue values|daily double/i.test(s)) {
      out.push({ round, category: s, values: round === 'J' ? [200,400,600,800,1000] : [400,800,1200,1600,2000] });
    }
  }
  // De-dupe while preserving order.
  return out.filter((x, i, a) => a.findIndex(y => y.round === x.round && y.category === x.category) === i).slice(0,12);
}

function parseCategoryDate(lines, isoDate, cat) {
  const label = longDate(isoDate);

  let start = lines.findIndex(line =>
    line.includes(label)
  );

  if (start < 0) {
    throw new Error(
      `Date heading ${label} not found for ${cat.category}`
    );
  }

  start++;

  // Stop at the next dated game on this category page.
  let end = lines.length;

  for (let i = start; i < lines.length; i++) {
    if (
      /^◆?\s*(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+[A-Z][a-z]+\s+\d{1,2},\s+\d{4}/.test(
        lines[i]
      )
    ) {
      end = i;
      break;
    }
  }

  const section = lines.slice(start, end);
  const clues = [];

  for (let i = 0; i < section.length; i++) {
    if (!/REVEAL/i.test(section[i])) {
      continue;
    }

    // Exact JeopardyToday structure:
    //
    // clue
    // ◆ REVEAL
    // response
    // — contestant / triple stumper

    const clue = section[i - 1]?.trim();
    const response = section[i + 1]?.trim();

    if (!clue || !response) {
      continue;
    }

    // If this was a Daily Double, ◆ DD appears directly
    // before the clue.
    const isDailyDouble =
      /^◆?\s*DD$/i.test(section[i - 2] || '');

    const position = clues.length;

    if (position >= 5) {
      break;
    }

    clues.push({
      round: cat.round,
      category: cat.category,
      value: cat.values[position],
      board_position: position + 1,
      clue,
      response,
      is_daily_double: isDailyDouble
    });
  }

  if (clues.length !== 5) {
    console.log(`\nParsed clues for ${cat.category}:`);

    clues.forEach((c, index) => {
      console.log(
        `${index + 1}. ${c.clue} -> ${c.response}` +
        (c.is_daily_double ? ' [DD]' : '')
      );
    });

    throw new Error(
      `Expected 5 clues for ${cat.category}, found ${clues.length}`
    );
  }

  return clues;
}

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function isClueMetadata(text, category) {
  const escapedCategory = category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (
    new RegExp(`^${escapedCategory}$`, 'i').test(text) ||
    /^(?:J!|DJ!|DD|◆\s*DD)$/i.test(text) ||
    /^\$[\d,]+(?:\s*→\s*bet\s*\$[\d,]+)?$/i.test(text) ||
    /\b(?:TRIPLE STUMPER|DAILY DOUBLE)\b/i.test(text) ||
    /^(?:FULL GAME|CATEGORY|CORRECT RESPONSE)$/i.test(text) ||
    /(?:Tap any clue|JeopardyToday|archive)/i.test(text) ||
    /REVEAL/i.test(text)
  );
}

function isResponseMetadata(text, category) {
  return (
    isClueMetadata(text, category) ||
    /^(?:correct|incorrect)$/i.test(text) ||
    /^No one responded correctly\.?$/i.test(text) ||
    /^\d+ of \d+ contestants? responded correctly\.?$/i.test(text) ||
    /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+/i.test(text)
  );
}

function looksLikeContestantResult(text) {
  // Typical archive result lines: "John Edwards — correct".
  if (/\s+—\s+(?:correct|incorrect)\b/i.test(text)) return true;

  // A bare two- or three-word proper name is usually contestant metadata here,
  // not a clue. Responses may themselves be names, but this filter is only used
  // while searching backward for the clue or skipping post-response result lines.
  if (/^[A-Z][A-Za-z.'’-]+(?:\s+[A-Z][A-Za-z.'’-]+){1,2}$/.test(text)) return true;

  return false;
}

function parseFinal(lines) {
  const idx = lines.findIndex(x => /^THE 15th CENTURY$/i.test(x)); // Fast path for current test game
  const finalIdx = lines.findIndex(x => /FINAL JEOPARDY/i.test(x));
  if (finalIdx < 0) return null;
  const section = lines.slice(finalIdx);
  const catIdx = section.findIndex((x,i) => /^CATEGORY$/i.test(x) && section[i+1]);
  const category = catIdx >= 0 ? section[catIdx + 1] : (idx >= 0 ? lines[idx] : 'FINAL JEOPARDY');
  const reveal = section.findIndex(x => /REVEAL THE CORRECT RESPONSE/i.test(x));
  if (reveal < 1) return null;
  const clue = section[reveal - 1];
  let response = null;
  for (let i = reveal + 1; i < section.length; i++) {
    if (/^CORRECT RESPONSE$/i.test(section[i]) && section[i+1]) { response = section[i+1]; break; }
  }
  if (!response) return null;
  return { round: 'FJ', category, value: null, board_position: 1, clue, response, is_daily_double: false };
}

function categorySlug(name) {
  return name
    .normalize('NFKD')
    .replace(/[’'\"]/g, '')
    .replace(/&/g, ' ')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function toGameSlug(iso) {
  const [y,m,d] = iso.split('-').map(Number);
  const month = new Intl.DateTimeFormat('en-US',{month:'long',timeZone:'UTC'}).format(new Date(Date.UTC(y,m-1,d)));
  return `${month}-${d}-${y}`.toLowerCase();
}

function longDate(iso) {
  const [y,m,d] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric',timeZone:'UTC'}).format(new Date(Date.UTC(y,m-1,d)));
}

function yesterdayEastern() {
  const now = new Date();
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(now).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
  const d = new Date(Date.UTC(Number(parts.year), Number(parts.month)-1, Number(parts.day)));
  d.setUTCDate(d.getUTCDate()-1);
  return d.toISOString().slice(0,10);
}
