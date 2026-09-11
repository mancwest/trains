/* Lotto Number Lab — app.js
 * Historical stats, a chi-square randomness audit, a prize-splitting-avoidance
 * generator, and an expected-value calculator built on real published NZ Lotto odds.
 *
 * Nothing in this file predicts a draw. See README.md for why, and the
 * on-page "honest bit" for the short version.
 */

// ===================== Constants ===================== //

const POOL_SIZE = 40;
const PICK_COUNT = 6;
const MAIN_COMBINATIONS = 3838380; // C(40,6) — exact, published by Lotto NZ

// Powerball's pool expands from 10 to 14 numbers on 13 September 2026.
// Lotto-only odds are unaffected. We apply the right pool size per draw
// (by date) for stats, and "today's" pool size for the generators/EV calc.
const PB_POOL_OLD = 10;
const PB_POOL_NEW = 14;
const PB_CUTOVER_DATE = '2026-09-13';

// Real published odds (lottoresults.nz / Lotto NZ), per line, Lotto-only.
// "With Powerball" = lottoOdds × current Powerball pool size (10 or 14).
const ODDS_TABLE = [
  { div: 1, match: '6 numbers', lottoOdds: 3838380 },
  { div: 2, match: '5 + bonus', lottoOdds: 639730 },
  { div: 3, match: '5 numbers', lottoOdds: 19386 },
  { div: 4, match: '4 + bonus', lottoOdds: 7754 },
  { div: 5, match: '4 numbers', lottoOdds: 485 },
  { div: 6, match: '3 + bonus', lottoOdds: 363 },
  { div: 7, match: '3 numbers', lottoOdds: 35 },
];
const PAYOUT_RATIO = 0.53; // ~53c returned per $1 spent, across all divisions, long run

// ===================== State ===================== //

let draws = []; // {date, drawNumber, jackpotStatus, nums:[6 ints], bonus:int|null, powerball:int|null}

const $ = id => document.getElementById(id);

// ===================== Utility: dates & Powerball pool size ===================== //

function pbPoolSizeForDate(isoDate) {
  if (!isoDate) return currentPbPoolSize();
  return isoDate >= PB_CUTOVER_DATE ? PB_POOL_NEW : PB_POOL_OLD;
}

function currentPbPoolSize() {
  const today = new Date().toISOString().slice(0, 10);
  return today >= PB_CUTOVER_DATE ? PB_POOL_NEW : PB_POOL_OLD;
}

// ===================== Data loading ===================== //

function parseCsv(text) {
  const lines = text.trim().split('\n').map(l => l.replace(/\r$/, '')).filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].split(',').map(h => h.trim());
  const idx = name => header.indexOf(name);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    // simple CSV split that tolerates a quoted jackpot field like "$1,000,000"
    const row = splitCsvLine(lines[i]);
    if (row.length < header.length) continue;
    const get = name => row[idx(name)];
    const nums = [1, 2, 3, 4, 5, 6].map(n => parseInt(get(`m${n}`), 10));
    if (nums.some(isNaN)) continue;
    const bonusRaw = get('bonus');
    const pbRaw = get('powerball');
    out.push({
      date: get('date'),
      drawNumber: get('draw_number'),
      jackpotStatus: get('jackpot_status'),
      nums,
      bonus: bonusRaw !== '' && !isNaN(parseInt(bonusRaw, 10)) ? parseInt(bonusRaw, 10) : null,
      powerball: pbRaw !== '' && !isNaN(parseInt(pbRaw, 10)) ? parseInt(pbRaw, 10) : null,
    });
  }
  return out;
}

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQuotes = !inQuotes; continue; }
    if (c === ',' && !inQuotes) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function parseManualDraws(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const parsed = [];
  for (const line of lines) {
    const [mainPart, bonusPart, pbPart] = line.split(';');
    const nums = mainPart.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
    if (nums.length !== 6 || nums.some(n => n < 1 || n > POOL_SIZE)) continue;
    const bonus = bonusPart ? parseInt(bonusPart.trim(), 10) : null;
    const powerball = pbPart ? parseInt(pbPart.trim(), 10) : null;
    parsed.push({
      date: null, drawNumber: null, jackpotStatus: null,
      nums,
      bonus: (bonus && bonus >= 1 && bonus <= POOL_SIZE) ? bonus : null,
      powerball: (powerball && powerball >= 1 && powerball <= PB_POOL_NEW) ? powerball : null,
    });
  }
  return parsed;
}

async function loadCsvDataset() {
  $('data-hint').textContent = 'loading…';
  try {
    const res = await fetch('data/nz_lotto_history.csv');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const parsed = parseCsv(text);
    if (parsed.length === 0) throw new Error('CSV had no valid rows');
    draws = parsed;
    renderAll();
    describeDataset();
  } catch (err) {
    $('data-hint').textContent = 'could not load';
    $('data-status').innerHTML =
      `Couldn't load <code>data/nz_lotto_history.csv</code> (${escapeHtml(String(err.message))}). ` +
      `If you're opening this file directly (file://), browsers block that fetch — run a local server ` +
      `(<code>python -m http.server</code>) or deploy via GitHub Pages. You can also paste draws manually below.`;
  }
}

function describeDataset() {
  if (draws.length === 0) {
    $('data-hint').textContent = 'no data loaded';
    $('data-status').textContent = '';
    return;
  }
  const dated = draws.filter(d => d.date);
  $('data-hint').textContent = `${draws.length} draws loaded`;
  if (dated.length > 0) {
    const sorted = [...dated].sort((a, b) => a.date.localeCompare(b.date));
    $('data-status').textContent =
      `Covering ${sorted[0].date} to ${sorted[sorted.length - 1].date}. ` +
      (draws.length < 500
        ? `That's a real sample, not the full 1987–present archive — run scripts/scrape_lotto_history.py for the complete history.`
        : `Looking like a solid chunk of history — nice.`);
  } else {
    $('data-status').textContent = `${draws.length} manually entered draws (no dates attached).`;
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ===================== Stats ===================== //

function computeStats(drawList) {
  const freq = Array(POOL_SIZE + 1).fill(0);
  const bonusFreq = Array(POOL_SIZE + 1).fill(0);
  const pairCounts = new Map();
  const pbFreqOld = Array(PB_POOL_OLD + 1).fill(0);
  const pbFreqNew = Array(PB_POOL_NEW + 1).fill(0);
  let pbOldCount = 0, pbNewCount = 0;

  drawList.forEach(d => {
    d.nums.forEach(n => { if (n >= 1 && n <= POOL_SIZE) freq[n]++; });
    if (d.bonus && d.bonus >= 1 && d.bonus <= POOL_SIZE) bonusFreq[d.bonus]++;
    for (let a = 0; a < d.nums.length; a++) {
      for (let b = a + 1; b < d.nums.length; b++) {
        const key = [d.nums[a], d.nums[b]].sort((x, y) => x - y).join('-');
        pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
      }
    }
    if (d.powerball) {
      const pool = pbPoolSizeForDate(d.date);
      if (pool === PB_POOL_NEW) { pbFreqNew[d.powerball]++; pbNewCount++; }
      else { pbFreqOld[d.powerball]++; pbOldCount++; }
    }
  });

  return { freq, bonusFreq, pairCounts, pbFreqOld, pbFreqNew, pbOldCount, pbNewCount };
}

// ===================== Chi-square goodness-of-fit ===================== //
// Numerical Recipes-style regularized incomplete gamma function, used to turn
// a chi-square statistic into a p-value. Verified against standard critical-
// value tables (df=1,chiSq=3.841 -> p=0.05; df=9,chiSq=16.92 -> p=0.05; etc).

function gammln(xx) {
  const cof = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let x = xx, y = xx;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) { y += 1; ser += cof[j] / y; }
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}
function gser(a, x) {
  const ITMAX = 100, EPS = 3e-7;
  const gln = gammln(a);
  if (x <= 0) return 0;
  let ap = a, sum = 1 / a, del = sum;
  for (let n = 1; n <= ITMAX; n++) {
    ap += 1; del *= x / ap; sum += del;
    if (Math.abs(del) < Math.abs(sum) * EPS) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - gln);
}
function gcf(a, x) {
  const ITMAX = 100, EPS = 3e-7, FPMIN = 1e-30;
  const gln = gammln(a);
  let b = x + 1 - a, c = 1 / FPMIN, d = 1 / b, h = d;
  for (let i = 1; i <= ITMAX; i++) {
    const an = -i * (i - a);
    b += 2; d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c; h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return Math.exp(-x + a * Math.log(x) - gln) * h;
}
function gammq(a, x) {
  if (x < 0 || a <= 0) return NaN;
  if (x < a + 1) return 1 - gser(a, x);
  return gcf(a, x);
}
function chiSquarePValue(chiSq, df) {
  if (df <= 0) return NaN;
  return gammq(df / 2, chiSq / 2);
}

function chiSquareGoodnessOfFit(observedCounts, expectedPerCategory) {
  let chiSq = 0;
  for (const obs of observedCounts) {
    chiSq += Math.pow(obs - expectedPerCategory, 2) / expectedPerCategory;
  }
  const df = observedCounts.length - 1;
  const p = chiSquarePValue(chiSq, df);
  return { chiSq, df, p };
}

function verdictFromP(p) {
  if (isNaN(p)) return { label: 'Not enough data', cls: '' };
  if (p < 0.01) return { label: 'Notably unusual — worth a second look, though not proof of anything', cls: 'flag' };
  if (p < 0.05) return { label: 'Mildly unusual — plausibly just chance at this sample size', cls: '' };
  return { label: 'Consistent with a fair, independent draw', cls: 'ok' };
}

// ===================== Popularity-avoidance model ===================== //
// Heuristic, transparent, and openly approximate — not fit to real ticket-
// sales data (Lotto NZ doesn't publish that). It encodes well-documented
// human number-picking biases: birthday ranges (1-31), "lucky" numbers, and
// round numbers. This changes who you'd split a jackpot with, not your odds.

function popularityWeight(n, poolSize) {
  let w = 1.0;
  const birthdayCeiling = Math.min(31, poolSize);
  if (n <= birthdayCeiling) w += 0.8;
  if (n <= 12) w += 0.2; // doubles as a month number too
  const luckyNumbers = new Set([3, 7, 9, 11, 13, 21, 33]);
  if (luckyNumbers.has(n)) w += 0.3;
  if (n % 10 === 0) w += 0.2; // round numbers, slip patterns
  return w;
}

function comboPatternPenalty(nums) {
  // Extra penalty for arithmetic runs and for lying in a single row/column
  // of the standard 4-row-by-10-column paper coupon (a well-known human bias).
  let penalty = 0;
  const sorted = [...nums].sort((a, b) => a - b);
  let runLength = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1] + 1) {
      runLength++;
      if (runLength >= 3) penalty += 0.5;
    } else {
      runLength = 1;
    }
  }
  const cols = nums.map(n => (n - 1) % 10);
  const rows = nums.map(n => Math.floor((n - 1) / 10));
  const colCounts = {}, rowCounts = {};
  cols.forEach(c => colCounts[c] = (colCounts[c] || 0) + 1);
  rows.forEach(r => rowCounts[r] = (rowCounts[r] || 0) + 1);
  const maxColShare = Math.max(...Object.values(colCounts));
  const maxRowShare = Math.max(...Object.values(rowCounts));
  if (maxColShare >= 4) penalty += 0.6;
  if (maxRowShare >= 5) penalty += 0.6;
  const allBirthdayRange = nums.every(n => n <= 31);
  if (allBirthdayRange) penalty += 0.4;
  return penalty;
}

function comboPopularityScore(nums) {
  const base = nums.reduce((sum, n) => sum + popularityWeight(n, POOL_SIZE), 0);
  return base + comboPatternPenalty(nums);
}

function weightedSampleWithoutReplacement(pool, weightFn, count) {
  const remaining = [...pool];
  const picked = [];
  for (let i = 0; i < count; i++) {
    const weights = remaining.map(weightFn);
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    let idx = 0;
    for (let j = 0; j < remaining.length; j++) {
      r -= weights[j];
      if (r <= 0) { idx = j; break; }
    }
    picked.push(remaining.splice(idx, 1)[0]);
  }
  return picked;
}

// ===================== Generators ===================== //

function pickTrueRandom() {
  const pool = Array.from({ length: POOL_SIZE }, (_, i) => i + 1);
  const picked = [];
  for (let i = 0; i < PICK_COUNT; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(idx, 1)[0]);
  }
  picked.sort((a, b) => a - b);
  const bonus = pool[Math.floor(Math.random() * pool.length)];
  const pbPool = currentPbPoolSize();
  const powerball = Math.floor(Math.random() * pbPool) + 1;
  return { nums: picked, bonus, powerball };
}

function pickWeighted() {
  const { freq, bonusFreq, pbFreqOld, pbFreqNew } = computeStats(draws);
  const weights = freq.map(f => f + 1);
  const pool = Array.from({ length: POOL_SIZE }, (_, i) => i + 1);
  const picked = weightedSampleWithoutReplacement(pool, n => weights[n], PICK_COUNT).sort((a, b) => a - b);
  const remainingPool = pool.filter(n => !picked.includes(n));
  const bonus = weightedSampleWithoutReplacement(remainingPool, n => bonusFreq[n] + 1, 1)[0];

  const pbPool = currentPbPoolSize();
  const pbFreq = pbPool === PB_POOL_NEW ? pbFreqNew : pbFreqOld;
  const pbWeights = pbFreq.slice(0, pbPool + 1).map(f => f + 1);
  let total = 0;
  for (let i = 1; i <= pbPool; i++) total += pbWeights[i];
  let r = Math.random() * total;
  let powerball = 1;
  for (let i = 1; i <= pbPool; i++) {
    r -= pbWeights[i];
    if (r <= 0) { powerball = i; break; }
  }
  return { nums: picked, bonus, powerball };
}

function pickPopularityAvoiding() {
  // Generate several genuinely-random weighted candidates (weighted toward
  // LESS popular numbers), then keep the one with the lowest popularity
  // score. Still fully random — just biased away from crowded tickets.
  const pool = Array.from({ length: POOL_SIZE }, (_, i) => i + 1);
  let best = null, bestScore = Infinity;
  for (let attempt = 0; attempt < 30; attempt++) {
    const candidate = weightedSampleWithoutReplacement(
      pool, n => 1 / popularityWeight(n, POOL_SIZE), PICK_COUNT
    ).sort((a, b) => a - b);
    const score = comboPopularityScore(candidate);
    if (score < bestScore) { bestScore = score; best = candidate; }
  }
  const remainingPool = pool.filter(n => !best.includes(n));
  const bonus = remainingPool[Math.floor(Math.random() * remainingPool.length)];

  const pbPool = currentPbPoolSize();
  const pbCandidates = Array.from({ length: pbPool }, (_, i) => i + 1);
  const pbWeighted = weightedSampleWithoutReplacement(
    pbCandidates, n => 1 / popularityWeight(n, pbPool), 1
  );
  return { nums: best, bonus, powerball: pbWeighted[0] };
}

function renderPick(containerId, result) {
  // Only show what you'd actually write on a real ticket: your 6 main
  // numbers, plus your Powerball number if you're playing that add-on.
  // The Bonus Ball isn't something you pick -- it's drawn separately by
  // the machine and checked against these same 6 numbers, so showing it
  // as a 7th ball here would be misleading.
  const el = $(containerId);
  el.innerHTML = result.nums.map(n => `<div class="gen-ball">${n}</div>`).join('')
    + `<div class="gen-ball power">${result.powerball}</div>`;
}

// ===================== Expected value ===================== //

function calculateEV({ lines, ticketPrice, jackpot, includePowerball }) {
  const pbPool = currentPbPoolSize();
  const totalCombinations = MAIN_COMBINATIONS * (includePowerball ? pbPool : 1);
  const pDiv1 = Math.min(1, lines / totalCombinations);
  const expectedDiv1Value = pDiv1 * jackpot;
  const div1NetEV = expectedDiv1Value - ticketPrice;
  const typicalReturn = ticketPrice * PAYOUT_RATIO;
  const typicalNetEV = typicalReturn - ticketPrice;
  return { pDiv1, totalCombinations, expectedDiv1Value, div1NetEV, typicalReturn, typicalNetEV, pbPool };
}

function formatOdds(n) {
  return `1 in ${Math.round(n).toLocaleString()}`;
}
function formatMoney(n) {
  return n.toLocaleString('en-NZ', { style: 'currency', currency: 'NZD', maximumFractionDigits: 2 });
}

// ===================== Rendering ===================== //

function renderAll() {
  renderStats();
  renderAudit();
  describeDataset();
  $('weighted-btn').disabled = draws.length === 0;
  $('weighted-btn').textContent = draws.length === 0 ? 'Load draws first' : 'Generate';
}

function renderStats() {
  if (draws.length === 0) {
    $('stats-section').style.display = 'none';
    return;
  }
  $('stats-section').style.display = '';

  const { freq, bonusFreq, pairCounts, pbFreqOld, pbFreqNew, pbOldCount, pbNewCount } = computeStats(draws);
  const maxFreq = Math.max(...freq.slice(1));

  const field = $('ball-field');
  field.innerHTML = '';
  for (let n = 1; n <= POOL_SIZE; n++) {
    const ball = document.createElement('div');
    ball.className = 'ball';
    const intensity = maxFreq ? freq[n] / maxFreq : 0;
    ball.style.background = `rgba(201,154,62,${0.08 + intensity * 0.55})`;
    ball.style.borderColor = `rgba(201,154,62,${0.2 + intensity * 0.6})`;
    ball.style.color = intensity > 0.4 ? '#0D1F19' : 'rgba(242,238,225,0.6)';
    ball.style.fontWeight = intensity > 0.4 ? '600' : '500';
    ball.textContent = n;
    field.appendChild(ball);
  }

  const ranked = freq.map((count, n) => ({ n, count })).slice(1).sort((a, b) => b.count - a.count);
  $('hot-list').innerHTML = ranked.slice(0, 6).map(r => `<div class="chip hot">${r.n}</div>`).join('');
  $('cold-list').innerHTML = ranked.slice(-6).reverse().map(r => `<div class="chip cold">${r.n}</div>`).join('');

  const topPairs = [...pairCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  $('pair-list').innerHTML = topPairs.map(([key, count]) => {
    const [a, b] = key.split('-');
    return `<div class="pair-row"><span class="pair-nums">${a} — ${b}</span><span class="pair-count">${count} draws together</span></div>`;
  }).join('') || '<p class="input-help">Not enough draws yet to find repeat pairings.</p>';

  const maxBonusFreq = Math.max(...bonusFreq.slice(1));
  const bonusField = $('bonus-field');
  bonusField.innerHTML = '';
  for (let n = 1; n <= POOL_SIZE; n++) {
    const ball = document.createElement('div');
    ball.className = 'ball';
    const intensity = maxBonusFreq ? bonusFreq[n] / maxBonusFreq : 0;
    ball.style.background = `rgba(76,122,115,${0.08 + intensity * 0.55})`;
    ball.style.borderColor = `rgba(76,122,115,${0.2 + intensity * 0.6})`;
    ball.style.color = intensity > 0.4 ? '#0D1F19' : 'rgba(242,238,225,0.6)';
    ball.style.fontWeight = intensity > 0.4 ? '600' : '500';
    ball.textContent = n;
    bonusField.appendChild(ball);
  }
  const bonusRanked = bonusFreq.map((count, n) => ({ n, count })).slice(1).sort((a, b) => b.count - a.count);
  $('bonus-hot-list').innerHTML = bonusRanked.slice(0, 6).map(r => `<div class="chip hot">${r.n}</div>`).join('');
  $('bonus-cold-list').innerHTML = bonusRanked.slice(-6).reverse().map(r => `<div class="chip cold">${r.n}</div>`).join('');

  const usingNewPool = currentPbPoolSize() === PB_POOL_NEW;
  const pbFreq = usingNewPool ? pbFreqNew : pbFreqOld;
  const pbCount = usingNewPool ? pbNewCount : pbOldCount;
  const pbPool = usingNewPool ? PB_POOL_NEW : PB_POOL_OLD;
  $('pb-hint').textContent = `1–${pbPool} · ${usingNewPool ? 'current pool (from 13 Sep 2026)' : 'pool before 13 Sep 2026'}`;
  const pbField = $('pb-field');
  if (pbCount > 0) {
    const maxPb = Math.max(...pbFreq.slice(1));
    pbField.innerHTML = '';
    for (let n = 1; n <= pbPool; n++) {
      const ball = document.createElement('div');
      ball.className = 'pb-ball';
      const intensity = maxPb ? pbFreq[n] / maxPb : 0;
      ball.style.background = `rgba(139,58,58,${0.1 + intensity * 0.6})`;
      ball.style.borderColor = `rgba(139,58,58,${0.3 + intensity * 0.6})`;
      ball.style.color = intensity > 0.4 ? '#F2EEE1' : 'rgba(242,238,225,0.6)';
      ball.textContent = n;
      pbField.appendChild(ball);
    }
    const pbRanked = pbFreq.map((count, n) => ({ n, count })).slice(1, pbPool + 1).sort((a, b) => b.count - a.count);
    $('pb-hot-list').innerHTML = pbRanked.slice(0, 6).map(r => `<div class="chip hot">${r.n}</div>`).join('');
    $('pb-cold-list').innerHTML = pbRanked.slice(-6).reverse().map(r => `<div class="chip cold">${r.n}</div>`).join('');
  } else {
    pbField.innerHTML = `<p class="input-help">No Powerball numbers for the ${usingNewPool ? '14-ball (current)' : '10-ball (pre-Sep-2026)'} era in your loaded draws yet.</p>`;
    $('pb-hot-list').innerHTML = '';
    $('pb-cold-list').innerHTML = '';
  }
}

function renderAudit() {
  if (draws.length < 20) {
    $('audit-section').style.display = 'none';
    return;
  }
  $('audit-section').style.display = '';

  const { freq, pbFreqOld, pbFreqNew, pbOldCount, pbNewCount } = computeStats(draws);
  const totalMainDraws = draws.length;
  const expectedMain = (totalMainDraws * PICK_COUNT) / POOL_SIZE;
  const mainResult = chiSquareGoodnessOfFit(freq.slice(1), expectedMain);
  const mainVerdict = verdictFromP(mainResult.p);

  let pbHtml = '<div class="audit-card"><h3>Powerball</h3><p class="input-help">Not enough Powerball draws loaded yet for this era.</p></div>';
  const usingNewPool = currentPbPoolSize() === PB_POOL_NEW;
  const pbFreq = usingNewPool ? pbFreqNew : pbFreqOld;
  const pbCount = usingNewPool ? pbNewCount : pbOldCount;
  const pbPool = usingNewPool ? PB_POOL_NEW : PB_POOL_OLD;
  if (pbCount >= 20) {
    const expectedPb = pbCount / pbPool;
    const pbResult = chiSquareGoodnessOfFit(pbFreq.slice(1, pbPool + 1), expectedPb);
    const pbVerdict = verdictFromP(pbResult.p);
    pbHtml = `
      <div class="audit-card">
        <h3>Powerball (1–${pbPool} pool)</h3>
        <div class="audit-stat"><span>Draws tested</span><b>${pbCount}</b></div>
        <div class="audit-stat"><span>χ² statistic</span><b>${pbResult.chiSq.toFixed(2)}</b></div>
        <div class="audit-stat"><span>Degrees of freedom</span><b>${pbResult.df}</b></div>
        <div class="audit-stat"><span>p-value</span><b>${pbResult.p.toFixed(4)}</b></div>
        <div class="audit-verdict ${pbVerdict.cls}">${pbVerdict.label}</div>
      </div>`;
  }

  $('audit-grid').innerHTML = `
    <div class="audit-card">
      <h3>Main numbers (1–40)</h3>
      <div class="audit-stat"><span>Draws tested</span><b>${totalMainDraws}</b></div>
      <div class="audit-stat"><span>χ² statistic</span><b>${mainResult.chiSq.toFixed(2)}</b></div>
      <div class="audit-stat"><span>Degrees of freedom</span><b>${mainResult.df}</b></div>
      <div class="audit-stat"><span>p-value</span><b>${mainResult.p.toFixed(4)}</b></div>
      <div class="audit-verdict ${mainVerdict.cls}">${mainVerdict.label}</div>
    </div>
    ${pbHtml}
  `;
}

function renderOddsTable() {
  const pbPool = currentPbPoolSize();
  const rows = ODDS_TABLE.map(row => `
    <tr>
      <td>${row.div}</td>
      <td>${row.match}</td>
      <td>${formatOdds(row.lottoOdds)}</td>
      <td>${formatOdds(row.lottoOdds * pbPool)}</td>
    </tr>`).join('');
  $('odds-table').innerHTML = `
    <tr><th>Div</th><th>Match</th><th>Lotto odds</th><th>With Powerball</th></tr>
    ${rows}`;
  $('odds-note').textContent =
    `Powerball currently drawn from 1–${pbPool}` +
    (pbPool === PB_POOL_NEW ? ' (the pool expanded from 10 to 14 on 13 Sep 2026).' : ' (expands to 1–14 on 13 Sep 2026).') +
    ` Across all divisions, Lotto NZ returns about ${Math.round(PAYOUT_RATIO * 100)}c of every $1 spent as prizes, on average, over time.`;
}

function renderEvResult() {
  const lines = Math.max(1, parseInt($('ev-lines').value, 10) || 1);
  const ticketPrice = Math.max(0, parseFloat($('ev-price').value) || 0);
  const jackpot = Math.max(0, parseFloat($('ev-jackpot').value) || 0);
  const includePowerball = $('ev-powerball').checked;

  const r = calculateEV({ lines, ticketPrice, jackpot, includePowerball });

  const positiveNote = r.div1NetEV > 0 ? `
    <p class="ev-caption">
      <strong>Notice the jackpot-only EV is positive here.</strong> That's real — at a big enough jackpot,
      the isolated Division-1 calculation can flip positive. It does <em>not</em> mean this is a good bet.
      It ignores: the chance you'd have to split a jackpot this size with other winners (popular numbers make
      that more likely — see the "popularity-avoiding" generator above), every lower division still being
      excluded from this figure, and that a single positive-EV instance with a ~1-in-millions chance is a
      wildly high-variance bet, not a reliable one. Treat this as "interesting math," not "advice to buy more."
    </p>` : '';

  $('ev-result').innerHTML = `
    <div class="ev-line"><span>Division 1 odds with ${lines} line${lines === 1 ? '' : 's'}${includePowerball ? ' + Powerball' : ''}</span><b>${formatOdds(r.totalCombinations / lines)}</b></div>
    <div class="ev-line"><span>Expected value from the jackpot alone</span><b>${formatMoney(r.expectedDiv1Value)}</b></div>
    <div class="ev-line"><span>Net EV (jackpot only) vs. ticket price</span><b>${formatMoney(r.div1NetEV)}</b></div>
    <div class="ev-line"><span>Typical long-run return (all divisions, ${Math.round(PAYOUT_RATIO * 100)}c/$1)</span><b>${formatMoney(r.typicalReturn)}</b></div>
    <div class="ev-line"><span>Typical net EV (all divisions)</span><b>${formatMoney(r.typicalNetEV)}</b></div>
    <p class="ev-caption">
      "Jackpot only" isolates Division 1 — it ignores every lower division, which pay real money too
      but are pari-mutuel (split among winners) so we can't hardcode an exact amount for them.
      The "typical long-run return" row is the more honest single number for what a ticket is worth
      on average: it already includes every division, using Lotto NZ's own published ${Math.round(PAYOUT_RATIO * 100)}c-per-$1 payout ratio.
    </p>
    ${positiveNote}`;
}

// ===================== Event wiring ===================== //

$('load-btn').addEventListener('click', () => {
  const parsed = parseManualDraws($('draw-input').value);
  if (parsed.length === 0) {
    $('data-status').textContent = 'No valid draws found. Each line needs 6 numbers between 1 and 40.';
    return;
  }
  draws = parsed;
  renderAll();
});

$('reload-btn').addEventListener('click', () => {
  $('draw-input').value = '';
  loadCsvDataset();
});

$('random-btn').addEventListener('click', () => renderPick('random-balls', pickTrueRandom()));
$('weighted-btn').addEventListener('click', () => { if (draws.length > 0) renderPick('weighted-balls', pickWeighted()); });
$('popavoid-btn').addEventListener('click', () => renderPick('popavoid-balls', pickPopularityAvoiding()));

$('ev-btn').addEventListener('click', renderEvResult);

// ===================== Init ===================== //

renderOddsTable();
renderPick('random-balls', pickTrueRandom());
renderPick('popavoid-balls', pickPopularityAvoiding());
loadCsvDataset();
