import axios from 'axios';
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  }
);

const BASE = 'https://www.jeopardytoday.com';

function categorySlug(name) {
  return name
    .normalize('NFKD')
    .replace(/[’'"]/g, '')
    .replace(/&/g, ' ')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function longDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);

  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC'
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

function linesFromHtml(html) {
  const $ = cheerio.load(html);

  $('script, style, noscript, svg').remove();

  const lines = [];

  $('body *').each((_, el) => {
    const ownText = $(el)
      .contents()
      .filter((_, node) => node.type === 'text')
      .text()
      .replace(/\s+/g, ' ')
      .trim();

    if (ownText && lines.at(-1) !== ownText) {
      lines.push(ownText);
    }
  });

  return lines;
}

async function getHtml(url) {
  const response = await axios.get(url, {
    timeout: 20000,
    headers: {
      'User-Agent': 'Mozilla/5.0 DailyQuizAlexa/0.1'
    }
  });

  return response.data;
}

function getYesterdayEastern() {
  const now = new Date();

  const easternDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);

  const [year, month, day] = easternDate
    .split('-')
    .map(Number);

  const yesterday = new Date(
    Date.UTC(year, month - 1, day - 1)
  );

  return yesterday.toISOString().slice(0, 10);
}

function gameSlug(date) {
  const [year, month, day] = date.split('-').map(Number);

  const monthName = new Intl.DateTimeFormat('en-US', {
    month: 'long',
    timeZone: 'UTC'
  })
    .format(new Date(Date.UTC(year, month - 1, day)))
    .toLowerCase();

  return `${monthName}-${day}-${year}`;
}

function parseCategories(html) {
  const lines = linesFromHtml(html);

  const out = [];
  let round = null;

  for (let i = 0; i < lines.length - 1; i++) {
    const s = lines[i];

    if (/^Jeopardy! Round$/i.test(s)) {
      round = 'J';
      continue;
    }

    if (/^Double Jeopardy! Round$/i.test(s)) {
      round = 'DJ';
      continue;
    }

    if (
      /^FINAL JEOPARDY!?$/i.test(s) ||
      /^◆ FINAL JEOPARDY!?$/i.test(s)
    ) {
      round = null;
      continue;
    }

    if (!round) continue;

    const next = lines[i + 1];

    const firstValue =
      round === 'J'
        ? '$200'
        : '$400';

    if (
      next === firstValue &&
      !/^\$/.test(s) &&
      !/categories|clue values|daily double/i.test(s)
    ) {
      out.push({
        round,
        category: s,
        values:
          round === 'J'
            ? [200, 400, 600, 800, 1000]
            : [400, 800, 1200, 1600, 2000]
      });
    }
  }

  const deduped = out.filter(
    (item, index, arr) =>
      arr.findIndex(
        other =>
          other.round === item.round &&
          other.category === item.category
      ) === index
  );

  return deduped.slice(0, 12);
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

    const clue = section[i - 1]?.trim();
    const response = section[i + 1]?.trim();

    if (!clue || !response) continue;

    const isDailyDouble =
      /^◆?\s*DD$/i.test(section[i - 2] || '');

    const position = clues.length;

    if (position >= 5) break;

    clues.push({
      round: cat.round,
      category: cat.category,
      value:
        cat.round === 'J'
          ? (position + 1) * 200
          : (position + 1) * 400,
      board_position: position + 1,
      clue,
      response,
      is_daily_double: isDailyDouble
    });
  }

  if (clues.length !== 5) {
    throw new Error(
      `Expected 5 clues for ${cat.category}, found ${clues.length}`
    );
  }

  return clues;
}

function parseFinalJeopardy(html) {
  const lines = linesFromHtml(html);

  const finalIndex = lines.findIndex(line =>
    /FINAL JEOPARDY/i.test(line)
  );

  if (finalIndex < 0) {
    throw new Error('Final Jeopardy section not found');
  }

  for (let i = finalIndex; i < lines.length; i++) {
    if (/REVEAL/i.test(lines[i])) {
      const clue = lines[i - 1]?.trim();
      const response = lines[i + 1]?.trim();

      if (clue && response) {
        return {
          round: 'FJ',
          category: 'FINAL JEOPARDY',
          value: 2000,
          board_position: 1,
          clue,
          response,
          is_daily_double: false
        };
      }
    }
  }

  throw new Error('Final Jeopardy clue not found');
}

async function importDate(date) {
  const url =
    `${BASE}/game/${gameSlug(date)}`;

  console.log(`Importing ${date} from ${url}`);

  const gameHtml = await getHtml(url);

  const categories = parseCategories(gameHtml);
console.log('Categories found:');

for (const cat of categories) {
  console.log(`${cat.round}: ${cat.category}`);
}

if (categories.length !== 12) {
  throw new Error(
    `Expected 12 categories, found ${categories.length}`
  );
}
  const importedClues = [];

  for (const cat of categories) {
    const url =
      `${BASE}/category/${categorySlug(cat.category)}`;

    const html = await getHtml(url);
    const lines = linesFromHtml(html);

    const clues =
      parseCategoryDate(lines, date, cat);

    importedClues.push(...clues);
  }

  const finalClue = parseFinalJeopardy(gameHtml);
  importedClues.push(finalClue);

  if (importedClues.length !== 61) {
    throw new Error(
      `Expected 61 clues, found ${importedClues.length}`
    );
  }

  const { data: existing } = await supabase
    .from('episodes')
    .select('id')
    .eq('air_date', date)
    .maybeSingle();

  let episodeId;

  if (existing) {
    episodeId = existing.id;

    const { error } = await supabase
      .from('clues')
      .delete()
      .eq('episode_id', episodeId);

    if (error) throw error;
  } else {
    const { data, error } = await supabase
        .from('episodes')
        .insert({
            air_date: date,
            source_url: url
        })
        .select()
        .single();

    if (error) throw error;

    episodeId = data.id;
  }

  const rows = importedClues.map(clue => ({
    episode_id: episodeId,
    ...clue
  }));

  const { error } = await supabase
    .from('clues')
    .insert(rows);

  if (error) throw error;

  return {
    date,
    clues: rows.length
  };
}

export default async function handler(req, res) {
  try {
    // Vercel cron automatically sends this when CRON_SECRET is configured.
    const auth = req.headers.authorization;

    if (
      process.env.CRON_SECRET &&
      auth !== `Bearer ${process.env.CRON_SECRET}`
    ) {
      return res.status(401).json({
        error: 'Unauthorized'
      });
    }

    let date;

    if (req.query.date) {
    // Manual testing still imports the exact requested date.
    date = req.query.date;
    } else {
    const yesterday = getYesterdayEastern();

    date = await findLatestAvailableDate(
        yesterday,
        7
    );
    }

    const result = await importDate(date);

    return res.status(200).json({
      ok: true,
      ...result
    });
  } catch (error) {
    console.error('Nightly import failed:', error);

    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
}

async function findLatestAvailableDate(startDate, maxDaysBack = 7) {
  const [year, month, day] = startDate.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, day));

  for (let offset = 0; offset <= maxDaysBack; offset++) {
    const candidate = new Date(start);
    candidate.setUTCDate(start.getUTCDate() - offset);

    const date = candidate.toISOString().slice(0, 10);
    const url = `${BASE}/game/${gameSlug(date)}`;

    try {
      const response = await axios.get(url, {
        timeout: 15000,
        validateStatus: () => true,
        headers: {
          'User-Agent': 'Mozilla/5.0 DailyQuizAlexa/0.1'
        }
      });

      if (response.status === 200) {
        const text = String(response.data);

        // Basic sanity check that this is actually a game page.
        if (
          /Jeopardy/i.test(text) &&
          /Double Jeopardy/i.test(text)
        ) {
          return date;
        }
      }
    } catch (error) {
      console.log(`No usable game found for ${date}`);
    }
  }

  throw new Error(
    `No available Jeopardy game found within ${maxDaysBack} days of ${startDate}`
  );
}