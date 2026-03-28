'use strict';

/**
 * Monte Carlo Simulation — NPC Profile Stress Test
 *
 * Generates 50,000+ NPCs across all classes, sexes, ages, seeds.
 * Scores structural coherence and narrative fluency. Outputs full statistics.
 *
 * Run: node test-monte-carlo.js
 * Run (quick): node test-monte-carlo.js --quick  (10k iterations)
 */

const { ageCharacter } = require('./aging-engine');
const { renderNPC } = require('./md-writer');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const ITERATIONS = process.argv.includes('--quick') ? 10_000 : 50_000;
const CLASSES = [
  'noble', 'merchant', 'warrior', 'soldier', 'peasant', 'artisan',
  'unguilded', 'clergy', 'lia_kavair', 'guilded_innkeeper',
];
const SEXES = ['male', 'female'];
const MIN_AGE = 18;
const MAX_AGE = 75;

// ─────────────────────────────────────────────────────────────────────────────
// STRUCTURAL COHERENCE SCORING (0–100)
// ─────────────────────────────────────────────────────────────────────────────

function scoreStructuralCoherence(npc) {
  let score = 100;
  const violations = [];

  // Attributes in valid range 1–21 (key), 1–20 (non-key)
  const KEY_ATTRS = ['STR','STA','DEX','AGL','INT','AUR','WIL'];
  const ALL_ATTRS = [...KEY_ATTRS, 'EYE','HRG','SML','VOI','CML'];
  for (const k of ALL_ATTRS) {
    const v = npc.attributes?.[k];
    if (v == null) { score -= 5; violations.push(`attr ${k} missing`); continue; }
    if (v < 1) { score -= 15; violations.push(`attr ${k}=${v} < 1`); }
    if (v > 21) { score -= 15; violations.push(`attr ${k}=${v} > 21`); }
  }

  // Morality 3–18
  if (npc.morality != null && (npc.morality < 3 || npc.morality > 18)) {
    score -= 10;
    violations.push(`morality ${npc.morality} out of [3,18]`);
  }

  // Age consistent with birthYear
  const gameYear = npc.gameYear ?? 720;
  if (npc.birthYear != null && npc.age !== gameYear - npc.birthYear) {
    score -= 20;
    violations.push(`age/birthYear mismatch`);
  }

  // Widowed: if in conditions, expect at least one spouse (deceased)
  if (npc.conditions?.includes('widowed')) {
    const hasDeceased = npc.spouses?.some(s => s.status === 'deceased');
    if (!hasDeceased && (!npc.spouses || npc.spouses.length === 0)) {
      score -= 15;
      violations.push('widowed but no deceased spouse');
    }
  }

  // Has alive spouse but no spouses array
  const hasAliveSpouse = npc.spouses?.some(s => s.status === 'alive');
  if (hasAliveSpouse === false && npc.spouses?.length > 0) {
    // All deceased - fine for widowed
  }

  // has_children implies children array non-empty
  if (npc.conditions?.includes('has_children')) {
    if (!npc.children?.length) {
      score -= 15;
      violations.push('has_children but no children');
    }
  }

  // History events have valid structure
  for (const h of npc.history || []) {
    if (!h.eventId) { score -= 2; violations.push('event missing eventId'); }
    if (h.age != null && (h.age < 18 || h.age > 120)) {
      score -= 5;
      violations.push(`event age ${h.age} implausible`);
    }
  }

  // Narrative has no undefined/null in output
  const md = renderNPC(npc);
  if (md.includes('undefined') || md.includes('null') || md.includes('NaN')) {
    score -= 25;
    violations.push('markdown contains undefined/null/NaN');
  }

  return { score: Math.max(0, score), violations };
}

// ─────────────────────────────────────────────────────────────────────────────
// NARRATIVE FLUENCY SCORING (0–100)
// ─────────────────────────────────────────────────────────────────────────────

function scoreNarrativeFluency(npc) {
  let score = 100;
  const issues = [];

  const narrative = npc.narrative || [];
  const fullText = narrative.join(' ');

  // Empty narrative
  if (narrative.length === 0) {
    score -= 30;
    issues.push('empty narrative');
  }

  // Very short narratives (< 50 chars) — likely template failure
  if (fullText.length < 50 && narrative.length < 3) {
    score -= 20;
    issues.push('extremely short narrative');
  }

  // Sentence fragments (lines not ending with . ! ? or )
  const badEndings = narrative.filter(l => {
    const t = l.trim();
    return t.length > 10 && !/[.!?)]$|\*$/.test(t);
  });
  if (badEndings.length > narrative.length * 0.5) {
    score -= 10;
    issues.push('many fragments without sentence endings');
  }

  // Duplicate consecutive lines
  let dupes = 0;
  for (let i = 1; i < narrative.length; i++) {
    if (narrative[i] === narrative[i - 1]) dupes++;
  }
  if (dupes > 0) {
    score -= Math.min(15, dupes * 5);
    issues.push(`${dupes} duplicate consecutive lines`);
  }

  // "undefined" or broken template output
  if (fullText.includes('undefined') || fullText.includes('NaN')) {
    score -= 40;
    issues.push('template leakage (undefined/NaN)');
  }

  // Average word count per line (too short = fragmented)
  if (narrative.length > 0) {
    const avgWords = fullText.split(/\s+/).filter(Boolean).length / narrative.length;
    if (avgWords < 3) {
      score -= 15;
      issues.push('very fragmented prose');
    }
  }

  return { score: Math.max(0, score), issues };
}

// ─────────────────────────────────────────────────────────────────────────────
// STATISTICS HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}
function stdDev(arr) {
  const m = mean(arr);
  const sqDiffs = arr.map(x => (x - m) ** 2);
  return Math.sqrt(mean(sqDiffs));
}
function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function percentile(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.floor(p / 100 * (s.length - 1));
  return s[Math.max(0, idx)];
}
// 95% CI for mean
function conf95(arr) {
  const n = arr.length;
  if (n < 2) return [mean(arr), mean(arr)];
  const m = mean(arr);
  const s = stdDev(arr);
  const se = s / Math.sqrt(n);
  const z = 1.96; // 95% CI
  return [m - z * se, m + z * se];
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

function run() {
  console.log(`\n=== Monte Carlo NPC Simulation (N=${ITERATIONS.toLocaleString()}) ===\n`);

  const structScores = [];
  const fluScores = [];
  const crashes = [];
  const structViolations = [];
  const fluIssues = [];
  const eventsPerNpc = [];

  const start = Date.now();

  for (let i = 0; i < ITERATIONS; i++) {
    const seed = i;
    const socialClass = CLASSES[i % CLASSES.length];
    const sex = SEXES[i % 2];
    const targetAge = MIN_AGE + (i % (MAX_AGE - MIN_AGE + 1));

    try {
      const npc = ageCharacter({ socialClass, sex, targetAge, seed });

      const { score: sScore, violations: sV } = scoreStructuralCoherence(npc);
      const { score: fScore, issues: fI } = scoreNarrativeFluency(npc);

      structScores.push(sScore);
      fluScores.push(fScore);
      eventsPerNpc.push(npc.history?.length ?? 0);

      if (sV.length) structViolations.push(...sV.slice(0, 3));
      if (fI.length) fluIssues.push(...fI.slice(0, 3));
    } catch (e) {
      crashes.push({ seed, socialClass, sex, targetAge, err: e.message });
    }

    if ((i + 1) % 10000 === 0) {
      console.log(`  ... ${(i + 1).toLocaleString()} / ${ITERATIONS.toLocaleString()}`);
    }
  }

  const elapsed = Date.now() - start;
  console.log(`\nCompleted in ${(elapsed / 1000).toFixed(1)}s (${(ITERATIONS / (elapsed / 1000)).toFixed(0)} NPCs/sec)\n`);

  // ── Structural Coherence Stats ────────────────────────────────────────────
  console.log('─── STRUCTURAL COHERENCE ─────────────────────────────────────────');
  console.log(`  Mean:              ${mean(structScores).toFixed(2)}`);
  console.log(`  Median:            ${median(structScores).toFixed(2)}`);
  console.log(`  Std Dev:           ${stdDev(structScores).toFixed(2)}`);
  const [sLo, sHi] = conf95(structScores);
  console.log(`  95% CI:            [${sLo.toFixed(2)}, ${sHi.toFixed(2)}]`);
  const failStruct = structScores.filter(s => s < 100).length;
  console.log(`  Perfect (100):     ${structScores.filter(s => s === 100).length} (${(100 * structScores.filter(s => s === 100).length / ITERATIONS).toFixed(1)}%)`);
  console.log(`  Failures (<100):   ${failStruct} (${(100 * failStruct / ITERATIONS).toFixed(2)}%)`);
  if (structViolations.length > 0) {
    const top = [...new Map(structViolations.map(v => [v, (structViolations.filter(x => x === v).length)]))]
      .sort((a, b) => b[1] - a[1]).slice(0, 5);
    console.log(`  Top violations:     ${top.map(([v, c]) => `${v} (${c})`).join('; ')}`);
  }

  // ── Narrative Fluency Stats ─────────────────────────────────────────────────
  console.log('\n─── NARRATIVE FLUENCY ───────────────────────────────────────────');
  console.log(`  Mean:              ${mean(fluScores).toFixed(2)}`);
  console.log(`  Median:            ${median(fluScores).toFixed(2)}`);
  console.log(`  Std Dev:           ${stdDev(fluScores).toFixed(2)}`);
  const [fLo, fHi] = conf95(fluScores);
  console.log(`  95% CI:            [${fLo.toFixed(2)}, ${fHi.toFixed(2)}]`);
  const failFlu = fluScores.filter(s => s < 80).length;
  console.log(`  Acceptable (≥80):   ${fluScores.filter(s => s >= 80).length} (${(100 * fluScores.filter(s => s >= 80).length / ITERATIONS).toFixed(1)}%)`);
  console.log(`  Poor (<80):        ${failFlu} (${(100 * failFlu / ITERATIONS).toFixed(2)}%)`);

  // ── Events distribution ───────────────────────────────────────────────────
  console.log('\n─── EVENTS PER NPC ──────────────────────────────────────────────');
  console.log(`  Mean:              ${mean(eventsPerNpc).toFixed(1)}`);
  console.log(`  Median:            ${median(eventsPerNpc)}`);
  console.log(`  Min/Max:           ${Math.min(...eventsPerNpc)} / ${Math.max(...eventsPerNpc)}`);
  console.log(`  P5 / P95:          ${percentile(eventsPerNpc, 5)} / ${percentile(eventsPerNpc, 95)}`);

  // ── Crashes ───────────────────────────────────────────────────────────────
  console.log('\n─── CRASHES ─────────────────────────────────────────────────────');
  console.log(`  Total:             ${crashes.length}`);
  if (crashes.length > 0) {
    crashes.slice(0, 5).forEach(c => {
      console.log(`    ${c.socialClass} ${c.sex} age ${c.targetAge} seed ${c.seed}: ${c.err}`);
    });
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const survivalRate = (1 - crashes.length / ITERATIONS) * 100;
  const structHealth = mean(structScores) >= 99 ? 'EXCELLENT' : mean(structScores) >= 95 ? 'GOOD' : mean(structScores) >= 90 ? 'FAIR' : 'POOR';
  const fluHealth = mean(fluScores) >= 95 ? 'EXCELLENT' : mean(fluScores) >= 85 ? 'GOOD' : mean(fluScores) >= 75 ? 'FAIR' : 'POOR';

  console.log('\n' + '─'.repeat(60));
  console.log('  Monte Carlo Summary');
  console.log('─'.repeat(60));
  console.log(`  Crash-free rate:     ${survivalRate.toFixed(2)}%`);
  console.log(`  Structural grade:    ${structHealth} (mean ${mean(structScores).toFixed(1)})`);
  console.log(`  Narrative grade:     ${fluHealth} (mean ${mean(fluScores).toFixed(1)})`);
  console.log('─'.repeat(60) + '\n');

  return { structScores, fluScores, crashes, eventsPerNpc };
}

run();
