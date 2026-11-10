// CEnT-S seat monitor: checks the CISIA calendar and pushes alerts to your phone via ntfy.
// Runs on GitHub Actions (see .github/workflows/cents-monitor.yml). No dependencies.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const CALENDAR_URL = 'https://testcisia.it/calendario.php?tolc=cents&l=gb&lingua=inglese';
const BOOKING_URL = 'https://testcisia.it/studenti_tolc/login_sso.php';
const STATE_FILE = 'state.json';
const TOPIC = process.env.NTFY_TOPIC;
const REMIND_EVERY_MIN = 30; // repeat the urgent alert while @HOME seats stay open
const FAIL_ALERT_AFTER = 3; // consecutive failed checks before warning you
const HEARTBEAT_UTC_HOUR = 3; // 03:xx UTC = ~9 AM IST daily "still alive" message

// ---------- parsing ----------
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', agrave: 'à', egrave: 'è', eacute: 'é', igrave: 'ì', ograve: 'ò', ugrave: 'ù' };
function clean(html) {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

const COLS = ['format', 'university', 'region', 'city', 'deadline', 'seats', 'state', 'date'];
const HEADER_MATCH = {
  format: /format/i, university: /universit/i, region: /region/i, city: /city|citt/i,
  deadline: /deadline|scadenza/i, seats: /seats|posti/i, state: /state|stato/i, date: /^date|^data/i,
};

export function parseRows(html) {
  const rows = [];
  let index = null; // column name -> position, taken from the header row if we find it
  for (const tr of html.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => clean(m[1]));
    if (!cells.length) continue;
    if (/^format/i.test(cells[0])) {
      index = {};
      for (const col of COLS) {
        const i = cells.findIndex((c) => HEADER_MATCH[col].test(c));
        if (i >= 0) index[col] = i;
      }
      continue;
    }
    if (!/^CENT@(HOME|UNI)$/i.test(cells[0])) continue;
    const row = {};
    COLS.forEach((col, i) => { row[col] = cells[index?.[col] ?? i] ?? ''; });
    row.format = row.format.toUpperCase();
    row.home = row.format === 'CENT@HOME';
    row.open = isOpen(row);
    row.key = [row.format, row.university, row.city, row.date].join('|');
    rows.push(row);
  }
  return rows;
}

function isOpen(row) {
  const s = row.state.toUpperCase();
  if (/NOT|NON |ESAURIT|CLOSED|CHIUS|FULL/.test(s)) return false;
  if (/AVAILABLE|DISPONIBIL/.test(s)) return true;
  return /^\d+$/.test(row.seats) && +row.seats > 0;
}

// ---------- alerts ----------
async function push({ title, message, priority = 3, tags = [] }) {
  console.log(`\n[ALERT p${priority}] ${title}\n${message}\n`);
  const res = await fetch('https://ntfy.sh/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: TOPIC, title, message, priority, tags, click: BOOKING_URL,
      actions: [{ action: 'view', label: 'Open calendar', url: CALENDAR_URL }] }),
  });
  if (!res.ok) throw new Error(`ntfy responded ${res.status}: ${await res.text()}`);
}

const short = (r) => `${r.university} (${r.city}) · test ${r.date} · book by ${r.deadline}` +
  (/^\d+$/.test(r.seats) ? ` · ${r.seats} seats` : '');

// ---------- main ----------
async function fetchCalendar() {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(CALENDAR_URL, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; cents-seat-monitor)' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = parseRows(await res.text());
      if (!rows.length) throw new Error('page loaded but no CENT rows found (layout may have changed)');
      return rows;
    } catch (e) {
      lastErr = e;
      console.log(`Attempt ${attempt} failed: ${e.message}`);
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
  throw lastErr;
}

export async function main() {
  if (!TOPIC) throw new Error('NTFY_TOPIC secret is not set (Settings → Secrets and variables → Actions).');

  const firstRun = !existsSync(STATE_FILE);
  const prev = firstRun ? { sessions: {}, failures: 0 } : JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  const next = { ...prev };
  const now = new Date();

  let rows;
  try {
    rows = await fetchCalendar();
  } catch (e) {
    next.failures = (prev.failures ?? 0) + 1;
    console.log(`Check failed (${next.failures} in a row): ${e.message}`);
    if (next.failures === FAIL_ALERT_AFTER) {
      await push({ title: 'CEnT-S monitor: cannot read the calendar', priority: 3, tags: ['warning'],
        message: `The last ${FAIL_ALERT_AFTER} checks failed: ${e.message}\nCheck the page yourself until this recovers.` });
    }
    writeFileSync(STATE_FILE, JSON.stringify(next, null, 2) + '\n');
    return;
  }

  if ((prev.failures ?? 0) >= FAIL_ALERT_AFTER) {
    await push({ title: 'CEnT-S monitor is working again', priority: 2, tags: ['white_check_mark'], message: 'Calendar readable again.' });
  }
  next.failures = 0;

  console.log(`Found ${rows.length} sessions:`);
  for (const r of rows) console.log(`  ${r.open ? 'OPEN ' : 'full '} ${r.format}  ${short(r)}  [${r.state}]`);

  const home = rows.filter((r) => r.home);
  const openHome = home.filter((r) => r.open);
  const sessions = {};
  // seat counts are left out on purpose so state.json (and the repo) only changes when something matters
  for (const r of rows) sessions[r.key] = { open: r.open, state: r.state };

  if (firstRun) {
    await push({ title: 'CEnT-S monitor is set up ✅', priority: 3, tags: ['white_check_mark'],
      message: `Watching ${rows.length} sessions (${home.length} @HOME, ${openHome.length} open).\n` +
        (openHome.length ? 'OPEN NOW:\n' + openHome.map(short).join('\n') : 'You will get an urgent alert the moment @HOME seats open.') });
    next.lastUrgentAt = openHome.length ? now.toISOString() : null;
  } else {
    // 1) @HOME seats: urgent, and repeated every REMIND_EVERY_MIN while still open
    const newlyOpen = openHome.filter((r) => !prev.sessions?.[r.key]?.open);
    const minsSinceUrgent = prev.lastUrgentAt ? (now - new Date(prev.lastUrgentAt)) / 60000 : Infinity;
    if (newlyOpen.length || (openHome.length && minsSinceUrgent >= REMIND_EVERY_MIN - 2)) {
      await push({ title: newlyOpen.length ? '🚨 CEnT@HOME SEATS OPEN — BOOK NOW' : '⏰ CEnT@HOME seats still open',
        priority: 5, tags: ['rotating_light'],
        message: openHome.map(short).join('\n') + '\n\nBookings close 2:00 PM CET on the deadline day. Tap to log in.' });
      next.lastUrgentAt = now.toISOString();
    }
    if (!openHome.length) next.lastUrgentAt = null;

    // 2) new sessions listed (even if already full) — tells you new dates are coming out
    const added = rows.filter((r) => !prev.sessions?.[r.key] && !(r.home && r.open));
    const addedHome = added.filter((r) => r.home);
    const addedUni = added.filter((r) => !r.home);
    if (addedHome.length) {
      await push({ title: 'New CEnT@HOME session listed', priority: 4, tags: ['calendar'],
        message: addedHome.map((r) => `${short(r)} — ${r.state}`).join('\n') });
    }
    if (addedUni.length) {
      await push({ title: 'New CEnT@UNI (in-person) session listed', priority: 2, tags: ['school'],
        message: addedUni.map((r) => `${short(r)} — ${r.state}`).join('\n') });
    }

    // 3) daily heartbeat so you know it is still running
    const today = now.toISOString().slice(0, 10);
    if (now.getUTCHours() >= HEARTBEAT_UTC_HOUR && prev.lastHeartbeat !== today) {
      await push({ title: 'CEnT-S monitor: daily check-in', priority: 2, tags: ['heartbeat'],
        message: `Still watching. ${home.length} @HOME sessions listed, ${openHome.length} open.` });
      next.lastHeartbeat = today;
    }
  }
  if (firstRun) next.lastHeartbeat = now.toISOString().slice(0, 10);

  next.sessions = sessions;
  writeFileSync(STATE_FILE, JSON.stringify(next, null, 2) + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
