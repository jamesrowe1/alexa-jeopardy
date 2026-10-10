import 'dotenv/config';
import axios from 'axios';
import * as cheerio from 'cheerio';

const BASE = 'https://www.jeopardytoday.com';
const targetDate = process.argv[2] || '2026-10-08';
const category =
  process.argv.slice(3).join(' ') || 'HISTORICAL HODGEPODGE';

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

const url = `${BASE}/category/${categorySlug(category)}`;

console.log(`Fetching ${url}`);

const response = await axios.get(url, {
  timeout: 20000,
  headers: {
    'User-Agent': 'Mozilla/5.0 DailyQuizAlexa/0.1'
  }
});

const lines = linesFromHtml(response.data);
const dateLabel = longDate(targetDate);

const dateIndex = lines.findIndex(line =>
  line.includes(dateLabel)
);

console.log(`\nLooking for: ${dateLabel}`);
console.log(`Date heading index: ${dateIndex}`);
console.log(`Total extracted lines: ${lines.length}\n`);

if (dateIndex < 0) {
  console.log('Date heading not found.\n');

  lines.slice(0, 200).forEach((line, i) => {
    console.log(`${String(i).padStart(4)} | ${line}`);
  });

  process.exit(1);
}

const start = Math.max(0, dateIndex - 10);
const end = Math.min(lines.length, dateIndex + 120);

for (let i = start; i < end; i++) {
  console.log(`${String(i).padStart(4)} | ${lines[i]}`);
}