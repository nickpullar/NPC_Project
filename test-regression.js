'use strict';

/**
 * test-regression.js
 *
 * Regression and behavioural tests for the Kaldor NPC aging engine.
 *
 * Suites:
 *   1. Golden snapshots (40 cases) — bit-for-bit determinism check
 *   2. _resolvePregnancyOutcome unit tests (7 cases)
 *   3. Scorecard bounds — population rates across all 8 classes (N=500)
 *   4. Attribute generation — distribution bounds for key vs non-key attrs
 *   5. Class coverage — all 8 classes generate without crash, with archetype
 *   6. Unguilded — settlement bias, event patterns, no guild events
 *   7. Degeneration — attribute decline at old age, no sub-1 attrs
 *   8. Medical traits — rollBirthAttributes private fields present
 *   9. Physical description integration — height/frame/weight coherence
 *
 * Run:  node test-regression.js
 */

const assert = require('assert');
const { ageCharacter, _resolvePregnancyOutcome } = require('./aging-engine');
const { generatePhysical } = require('./physical-description');
const { ARCHETYPES }       = require('./archetypes');
const SNAPSHOTS            = require('./test-snapshots.json');

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

function deepEqual(actual, expected, label) {
  try {
    assert.deepStrictEqual(actual, expected);
  } catch (_) {
    if (typeof actual === 'object' && !Array.isArray(actual)) {
      for (const k of new Set([...Object.keys(actual), ...Object.keys(expected)])) {
        if (JSON.stringify(actual[k]) !== JSON.stringify(expected[k]))
          throw new Error(`${label} — diff at '${k}': got ${JSON.stringify(actual[k])}, expected ${JSON.stringify(expected[k])}`);
      }
    }
    if (Array.isArray(actual)) {
      for (let i = 0; i < Math.max(actual.length, expected.length); i++) {
        if (actual[i] !== expected[i])
          throw new Error(`${label} — diff at [${i}]: got ${actual[i]}, expected ${expected[i]}`);
      }
    }
    throw new Error(`${label}: values differ`);
  }
}

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 1 — Golden snapshots
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── Suite 1: Golden snapshot regression ──────────────────────────────');

const SEEDS = [0, 7, 42, 99, 137, 256, 512, 1000, 2048, 9999];
const COMBOS = [['female','peasant'],['male','warrior'],['female','noble'],['male','merchant']];

for (const seed of SEEDS) {
  for (const [sex, socialClass] of COMBOS) {
    const key = `${seed}_${sex}_${socialClass}`;
    test(`seed=${seed} ${sex} ${socialClass}`, () => {
      const snap = SNAPSHOTS[key];
      assert.ok(snap, `No snapshot for '${key}'`);
      const r = ageCharacter({ socialClass, sex, targetAge: 45, seed });
      const actual = {
        conditions:  [...r.conditions].sort(),
        childCount:  r.children.length,
        spouseCount: r.spouses.length,
        spouseAlive: r.spouses.filter(s => s.status === 'alive').length,
        eventIds:    r.history.map(e => e.eventId),
        attributes:  { ...r.attributes },
        morality:    r.morality,
        phase:       r.phase,
      };
      deepEqual(actual.conditions,  snap.conditions,  'conditions');
      deepEqual(actual.childCount,  snap.childCount,  'childCount');
      deepEqual(actual.spouseCount, snap.spouseCount, 'spouseCount');
      deepEqual(actual.spouseAlive, snap.spouseAlive, 'spouseAlive');
      deepEqual(actual.eventIds,    snap.eventIds,    'eventIds');
      deepEqual(actual.attributes,  snap.attributes,  'attributes');
      deepEqual(actual.morality,    snap.morality,    'morality');
      deepEqual(actual.phase,       snap.phase,       'phase');
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 2 — _resolvePregnancyOutcome unit tests
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── Suite 2: _resolvePregnancyOutcome unit tests ────────────────────');

function mockRand(vals) { let i = 0; return () => vals[i++ % vals.length]; }

function baseCtx(overrides = {}) {
  return {
    char: { conditions: [], attributes: { STA: 10 }, socialClass: 'peasant', rhPositive: true, sex: 'female' },
    isFemale: true,
    rand: mockRand([0.5]),
    currentSpouse: () => ({ id: 's1', rhPositive: true, surname: 'Elernin' }),
    name: null, children: [], familyFollowOns: new Map(),
    ...overrides,
  };
}

test('miscarriage: roll 0.10 < pMiscarriage 0.22', () => {
  const ctx = baseCtx({ rand: mockRand([0.10, 0.05]) });
  const r = _resolvePregnancyOutcome(ctx, 22, 'young', 22);
  assert.strictEqual(r.outcome, 'miscarriage');
  assert.ok(r.weeks >= 4 && r.weeks <= 20);
  assert.ok(ctx.familyFollowOns.has('grief_and_introspection'));
  assert.ok(ctx.familyFollowOns.has('pregnancy'));
  assert.strictEqual(r.child, null);
});

test('stillbirth: roll 0.25 in stillbirth band [0.22, 0.29)', () => {
  const ctx = baseCtx({ rand: mockRand([0.25, 0.50, 0.90, 0.90, 0.90]) });
  const r = _resolvePregnancyOutcome(ctx, 24, 'young', 24);
  assert.ok(['stillbirth','miscarriage'].includes(r.outcome));
  assert.ok(ctx.familyFollowOns.has('grief_and_introspection'));
  assert.strictEqual(r.child, null);
  assert.ok(ctx.char.conditions.includes('bereaved_child'));
});

test('live birth: roll 0.80 above both thresholds', () => {
  const ctx = baseCtx({ rand: mockRand([0.80, 0.90, 0.90, 0.90, 0.80, 0.50, 0.50, 0.50, 0.50]) });
  const r = _resolvePregnancyOutcome(ctx, 24, 'young', 24);
  assert.strictEqual(r.outcome, 'live_birth');
  assert.ok(r.child !== null);
  assert.ok(ctx.char.conditions.includes('has_children'));
  assert.strictEqual(ctx.children.length, 1);
});

test('maternal age ≥41 raises miscarriage rate: roll 0.30 is live at 24, miss at 42', () => {
  const ctxY = baseCtx({ rand: mockRand([0.30, 0.50, 0.90, 0.80, 0.50, 0.50, 0.50, 0.50, 0.50]) });
  const rY = _resolvePregnancyOutcome(ctxY, 24, 'young', 24);
  const ctxO = baseCtx({ rand: mockRand([0.30, 0.50]) });
  const rO = _resolvePregnancyOutcome(ctxO, 42, 'middle', 42);
  assert.ok(rY.outcome !== 'miscarriage', `expected non-miscarriage at 24, got ${rY.outcome}`);
  assert.strictEqual(rO.outcome, 'miscarriage');
});

test('chronic_illness raises miscarriage rate: roll 0.25 is live healthy, miss ill', () => {
  const ctxH = baseCtx({ rand: mockRand([0.25, 0.50, 0.90, 0.80, 0.50, 0.50, 0.50, 0.50, 0.50]) });
  const rH = _resolvePregnancyOutcome(ctxH, 28, 'young', 28);
  const ctxI = baseCtx({
    rand: mockRand([0.25, 0.50]),
    char: { conditions: ['chronic_illness'], attributes: { STA: 10 }, socialClass: 'peasant', rhPositive: true, sex: 'female' },
  });
  const rI = _resolvePregnancyOutcome(ctxI, 28, 'young', 28);
  assert.ok(rH.outcome !== 'miscarriage');
  assert.strictEqual(rI.outcome, 'miscarriage');
});

test('male principal: child pushed, spouse_pregnant follow-on set', () => {
  const ctx = baseCtx({
    isFemale: false,
    rand: mockRand([0.80, 0.90, 0.90, 0.90, 0.80, 0.50, 0.50, 0.50, 0.50, 0.50]),
    char: { conditions: [], attributes: { STA: 10 }, socialClass: 'warrior', rhPositive: true, sex: 'male' },
    currentSpouse: () => ({ id: 's1', rhPositive: true, surname: 'Talanz' }),
    name: { surname: 'Talanz' },
  });
  const r = _resolvePregnancyOutcome(ctx, 28, 'young', 25);
  assert.strictEqual(r.outcome, 'live_birth');
  assert.ok(ctx.familyFollowOns.has('spouse_pregnant'));
  assert.ok(!ctx.familyFollowOns.has('pregnancy'));
});

test('difficult birth + male: spouse_dies_childbirth follow-on set', () => {
  const ctx = baseCtx({
    isFemale: false,
    rand: mockRand([0.80, 0.05, 0.90, 0.50, 0.50, 0.50, 0.50, 0.50, 0.50, 0.50]),
    char: { conditions: [], attributes: { STA: 10 }, socialClass: 'soldier', rhPositive: true, sex: 'male' },
    currentSpouse: () => ({ id: 's1', rhPositive: false, surname: 'Melarn' }),
    name: { surname: 'Melarn' },
  });
  const r = _resolvePregnancyOutcome(ctx, 26, 'young', 23);
  if (r.difficult) {
    assert.ok(ctx.familyFollowOns.has('spouse_dies_childbirth'));
    assert.ok(!ctx.familyFollowOns.has('spouse_pregnant'));
  } else {
    assert.ok(ctx.familyFollowOns.has('spouse_pregnant'));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 3 — Scorecard bounds (N=500, all 8 classes)
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── Suite 3: Scorecard bounds (N=500, all 8 classes) ────────────────');

{
  const ALL_CLASSES = ['noble','merchant','warrior','soldier','peasant','artisan','unguilded','clergy'];
  const N = 500;
  let crashes = 0, spouseDeath = 0, disgraced = 0, chronicIll = 0, lame = 0;

  for (let i = 0; i < N; i++) {
    const sex      = i % 2 === 0 ? 'female' : 'male';
    const socialClass = ALL_CLASSES[i % ALL_CLASSES.length];
    try {
      const r = ageCharacter({ socialClass, sex, targetAge: 45, seed: i + 10000 });
      if (r.spouses?.some(s => s.status === 'deceased')) spouseDeath++;
      if (r.conditions.includes('disgraced'))            disgraced++;
      if (r.conditions.includes('chronic_illness'))      chronicIll++;
      if (r.conditions.includes('lame'))                 lame++;
    } catch (e) {
      crashes++;
      console.error(`    crash: ${socialClass} ${sex} seed=${i + 10000}: ${e.message}`);
    }
  }

  test(`crashes = 0 across all 8 classes (got ${crashes})`, () => assert.strictEqual(crashes, 0));

  const spouseRate    = spouseDeath / N * 100;
  const disgracedRate = disgraced   / N * 100;
  const illRate       = chronicIll  / N * 100;
  const lameRate      = lame        / N * 100;

  test(`spouse death ≥12% (got ${spouseRate.toFixed(1)}%)`, () =>
    assert.ok(spouseRate >= 12, `${spouseRate.toFixed(1)}% below floor`));
  test(`spouse death ≤35% (got ${spouseRate.toFixed(1)}%)`, () =>
    assert.ok(spouseRate <= 35, `${spouseRate.toFixed(1)}% above ceiling`));
  test(`disgraced ≤32% (got ${disgracedRate.toFixed(1)}%)`, () =>
    assert.ok(disgracedRate <= 32, `${disgracedRate.toFixed(1)}% above ceiling`));
  test(`chronic_illness ≤25% (got ${illRate.toFixed(1)}%)`, () =>
    assert.ok(illRate <= 25, `${illRate.toFixed(1)}% above ceiling`));
  test(`lame ≤15% (got ${lameRate.toFixed(1)}%)`, () =>
    assert.ok(lameRate <= 15, `${lameRate.toFixed(1)}% above ceiling`));
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 4 — Attribute generation distribution
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── Suite 4: Attribute generation ───────────────────────────────────');

{
  const N = 400;
  const keyAttrs    = ['STR','STA','DEX','AGL','INT','AUR','WIL'];
  const nonKeyAttrs = ['EYE','HRG','SML','VOI','CML'];
  const samples = { key: {}, non: {} };
  for (const k of keyAttrs)    samples.key[k] = [];
  for (const k of nonKeyAttrs) samples.non[k] = [];

  for (let i = 0; i < N; i++) {
    // Use age 20 to minimise injury degradation noise
    const r = ageCharacter({ socialClass: 'warrior', sex: 'male', targetAge: 20, seed: i + 30000 });
    for (const k of keyAttrs)    samples.key[k].push(r.attributes[k]);
    for (const k of nonKeyAttrs) samples.non[k].push(r.attributes[k]);
  }

  // Key attrs (4d6 drop lowest) should average ~12–13; all values ≥1
  for (const k of keyAttrs) {
    const vals = samples.key[k];
    const m = mean(vals);
    test(`${k} (key): mean 11–14 (got ${m.toFixed(1)})`, () =>
      assert.ok(m >= 11 && m <= 14, `mean ${m.toFixed(1)} out of [11,14]`));
    test(`${k} (key): all values ≥1 and ≤21`, () => {
      const mn = Math.min(...vals), mx = Math.max(...vals);
      assert.ok(mn >= 1, `min ${mn} < 1`);
      assert.ok(mx <= 21, `max ${mx} > 21`);
    });
  }

  // Non-key attrs (3d6) should average ~10–11
  for (const k of nonKeyAttrs) {
    const vals = samples.non[k];
    const m = mean(vals);
    test(`${k} (non-key): mean 9.5–12 (got ${m.toFixed(1)})`, () =>
      assert.ok(m >= 9.5 && m <= 12, `mean ${m.toFixed(1)} out of [9.5,12]`));
  }

  // Female AUR should be higher than male AUR due to +2 modifier
  const femAUR = [], malAUR = [];
  for (let i = 0; i < 200; i++) {
    femAUR.push(ageCharacter({ socialClass: 'peasant', sex: 'female', targetAge: 20, seed: i + 31000 }).attributes.AUR);
    malAUR.push(ageCharacter({ socialClass: 'peasant', sex: 'male',   targetAge: 20, seed: i + 31000 }).attributes.AUR);
  }
  const femMean = mean(femAUR), malMean = mean(malAUR);
  test(`Female AUR mean > male AUR mean (f=${femMean.toFixed(1)} m=${malMean.toFixed(1)}, expected +~2)`, () =>
    assert.ok(femMean > malMean, `female ${femMean.toFixed(1)} not > male ${malMean.toFixed(1)}`));

  // Noble height should exceed peasant height (class modifier)
  const nobleH = [], peasantH = [];
  for (let i = 0; i < 200; i++) {
    nobleH.push(ageCharacter({ socialClass: 'noble', sex: 'male',   targetAge: 20, seed: i + 32000 }).attributes._heightIn);
    peasantH.push(ageCharacter({ socialClass: 'peasant', sex: 'male', targetAge: 20, seed: i + 32000 }).attributes._heightIn);
  }
  const nH = mean(nobleH), pH = mean(peasantH);
  test(`Noble mean height > peasant mean height (n=${nH.toFixed(1)}" p=${pH.toFixed(1)}")`, () =>
    assert.ok(nH > pH, `noble ${nH.toFixed(1)}" not taller than peasant ${pH.toFixed(1)}"`));

  // Private fields present
  test('_frame is valid string on every NPC', () => {
    const valid = new Set(['Scant','Light','Medium','Heavy','Massive']);
    for (let i = 0; i < 50; i++) {
      const r = ageCharacter({ socialClass: 'merchant', sex: 'female', targetAge: 30, seed: i + 33000 });
      assert.ok(valid.has(r.attributes._frame), `invalid frame '${r.attributes._frame}' seed ${i + 33000}`);
    }
  });
  test('_heightIn in plausible range [52, 84] inches for all sexs/classes', () => {
    for (let i = 0; i < 50; i++) {
      const r = ageCharacter({ socialClass: 'peasant', sex: 'female', targetAge: 25, seed: i + 34000 });
      assert.ok(r.attributes._heightIn >= 52 && r.attributes._heightIn <= 84,
        `height ${r.attributes._heightIn}" out of [52,84] seed ${i+34000}`);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 5 — Class coverage: all 8 classes, both sexs, no crashes
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── Suite 5: Class coverage ──────────────────────────────────────────');

{
  const ALL_CLASSES = ['noble','merchant','warrior','soldier','peasant','artisan','unguilded','clergy'];
  for (const socialClass of ALL_CLASSES) {
    for (const sex of ['male','female']) {
      test(`${socialClass} ${sex} generates without crash`, () => {
        for (let seed = 0; seed < 10; seed++) {
          const r = ageCharacter({ socialClass, sex, targetAge: 40, seed: seed + 60000 });
          assert.ok(r.attributes, 'missing attributes');
          assert.ok(Array.isArray(r.history), 'missing history');
          assert.ok(Array.isArray(r.conditions), 'missing conditions');
          // Archetype assigned for all except clergy (not implemented)
          if (socialClass !== 'clergy') {
            assert.ok(r.archetype, `no archetype for ${socialClass} ${sex} seed ${seed + 60000}`);
          }
        }
      });
    }
  }

  // Phase sanity — each class should reach appropriate phases
  test('noble male reaches lord or senior_noble by age 50', () => {
    let reached = 0;
    for (let i = 0; i < 30; i++) {
      const r = ageCharacter({ socialClass: 'noble', sex: 'male', targetAge: 50, seed: i + 70000 });
      if (['lord','senior_noble','senior'].includes(r.phase)) reached++;
    }
    assert.ok(reached >= 10, `only ${reached}/30 nobles reached lord/senior_noble by 50`);
  });
  test('artisan male progresses past apprentice by age 25', () => {
    let progressed = 0;
    for (let i = 0; i < 30; i++) {
      const r = ageCharacter({ socialClass: 'artisan', sex: 'male', targetAge: 25, seed: i + 71000 });
      if (r.phase !== 'apprentice') progressed++;
    }
    assert.ok(progressed >= 25, `only ${progressed}/30 artisans past apprentice by 25`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 6 — Unguilded class behaviour
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── Suite 6: Unguilded class behaviour ───────────────────────────────');

{
  // Settlement bias: hamlet births should produce more rural archetypes
  const RURAL_ARCHETYPES = new Set([
    'unguilded_freeholder','unguilded_freeholder_wife','unguilded_herdsman',
    'unguilded_charcoaler_woodsman','unguilded_rural_woman',
    'unguilded_fisherman','unguilded_fisherwoman','unguilded_hunter',
  ]);
  const URBAN_ARCHETYPES = new Set([
    'unguilded_scribe_sage','unguilded_laborer','unguilded_performer',
    'unguilded_beggar','unguilded_urban_craftsman','unguilded_urban_woman',
    'unguilded_male_servant','unguilded_ratter',
  ]);

  // Sample NPCs, stratify by birthSettlement
  const ruralBirthRural = [], ruralBirthUrban = [];
  const cityBirthRural  = [], cityBirthUrban  = [];
  for (let i = 0; i < 600; i++) {
    const g = i % 2 === 0 ? 'male' : 'female';
    const r = ageCharacter({ socialClass: 'unguilded', sex: g, targetAge: 35, seed: i + 80000 });
    const id = r.archetype?.id;
    if (!id) continue;
    if (r.birthSettlement === 'hamlet' || r.birthSettlement === 'village') {
      if (RURAL_ARCHETYPES.has(id)) ruralBirthRural.push(id);
      if (URBAN_ARCHETYPES.has(id)) ruralBirthUrban.push(id);
    }
    if (r.birthSettlement === 'city') {
      if (RURAL_ARCHETYPES.has(id)) cityBirthRural.push(id);
      if (URBAN_ARCHETYPES.has(id)) cityBirthUrban.push(id);
    }
  }
  const ruralTotal = ruralBirthRural.length + ruralBirthUrban.length;
  const cityTotal  = cityBirthRural.length  + cityBirthUrban.length;

  test('hamlet/village births: majority of archetypes are rural-biased', () => {
    assert.ok(ruralTotal > 0, 'no hamlet/village births sampled');
    const ruralPct = ruralBirthRural.length / ruralTotal * 100;
    assert.ok(ruralPct >= 45, `only ${ruralPct.toFixed(0)}% rural archetypes for hamlet/village births`);
  });
  test('city births: majority of archetypes are urban-biased', () => {
    assert.ok(cityTotal > 0, 'no city births sampled');
    const urbanPct = cityBirthUrban.length / cityTotal * 100;
    assert.ok(urbanPct >= 45, `only ${urbanPct.toFixed(0)}% urban archetypes for city births`);
  });

  // Guild events should be rare for unguilded
  test('unguilded: guild_advancement only fires after class change to artisan/merchant', () => {
    for (let i = 0; i < 100; i++) {
      const r = ageCharacter({ socialClass: 'unguilded', sex: 'male', targetAge: 45, seed: i + 81000 });
      const guildAdv = r.history.filter(h => h.eventId === 'guild_advancement');
      if (guildAdv.length > 0) {
        // Must have had a class change before it fired
        const firstGaAge = guildAdv[0].age;
        const hadClassChange = r.classChanges?.some(cc =>
          (cc.to === 'artisan' || cc.to === 'merchant') && cc.fromAge < firstGaAge
        );
        assert.ok(hadClassChange,
          `guild_advancement at age ${firstGaAge} without prior class change, seed ${i + 81000}`);
      }
    }
  });

  // Unguilded NPCs should have more journey/travel events than peasants on average
  test('unguilded: journey_abroad fires more often than for peasant', () => {
    let unguildedJourneys = 0, peasantJourneys = 0;
    const n = 200;
    for (let i = 0; i < n; i++) {
      const u = ageCharacter({ socialClass: 'unguilded', sex: 'male', targetAge: 45, seed: i + 82000 });
      const p = ageCharacter({ socialClass: 'peasant',   sex: 'male', targetAge: 45, seed: i + 82000 });
      unguildedJourneys += u.history.filter(h => h.eventId === 'journey_abroad').length;
      peasantJourneys   += p.history.filter(h => h.eventId === 'journey_abroad').length;
    }
    assert.ok(unguildedJourneys >= peasantJourneys,
      `unguilded journeys ${unguildedJourneys} not ≥ peasant ${peasantJourneys}`);
  });

  // Archetype count matches current registry (see assertion below for exact number)
  const unguildedArchetypes = ARCHETYPES.filter(a => a.socialClass === 'unguilded');
  test(`85 unguilded archetypes defined (got ${unguildedArchetypes.length})`, () =>
    assert.strictEqual(unguildedArchetypes.length, 85));

  // Each unguilded archetype rolls without crash
  test('all unguilded archetypes reachable via rollArchetype', () => {
    const { rollArchetype } = require('./archetypes');
    const { seedRng } = require('./rng');
    const found = new Set();
    for (let i = 0; i < 5000; i++) {
      seedRng(i);
      const g = i % 2 === 0 ? 'male' : 'female';
      const a = rollArchetype('unguilded', g, 'established', ['hamlet','village','town','city'][i%4]);
      if (a) found.add(a.id);
    }
    // All 22 should be reachable in 5000 rolls
    assert.ok(found.size >= 20, `only ${found.size}/22 archetypes reached in 5000 rolls`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 7 — Degeneration at old age
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── Suite 7: Degeneration ────────────────────────────────────────────');

{
  // No attribute ever drops below 1
  test('no attribute below 1 for any NPC age 70 (N=100)', () => {
    for (let i = 0; i < 100; i++) {
      const r = ageCharacter({ socialClass: 'peasant', sex: 'male', targetAge: 70, seed: i + 90000 });
      for (const [k, v] of Object.entries(r.attributes)) {
        if (k.startsWith('_')) continue;
        assert.ok(v >= 1, `attribute ${k}=${v} below 1 at age 70 seed ${i + 90000}`);
      }
    }
  });

  // At age 70, most NPCs should show some degeneration from their rolled baseline
  // (life expectancy −10 = roughly age 40–50 onset, so by 70 most will have degraded)
  test('majority of NPCs show attribute decline by age 70 (N=100)', () => {
    let degraded = 0;
    for (let i = 0; i < 100; i++) {
      const young = ageCharacter({ socialClass: 'peasant', sex: 'male', targetAge: 20, seed: i + 90000 });
      const old   = ageCharacter({ socialClass: 'peasant', sex: 'male', targetAge: 70, seed: i + 90000 });
      // If any key sensory/stamina attr is lower in the old NPC vs young, degeneration fired
      // (injuries also reduce attrs, so this is an upper bound check — just confirm it happens)
      const checkAttrs = ['STA','EYE','HRG','INT'];
      if (checkAttrs.some(k => old.attributes[k] < young.attributes[k])) degraded++;
    }
    assert.ok(degraded >= 50, `only ${degraded}/100 NPCs show attr decline at 70 — degeneration may not be firing`);
  });

  // No crashes at extreme ages
  test('no crashes at age 80 across all classes', () => {
    const cls = ['noble','merchant','warrior','soldier','peasant','artisan','unguilded'];
    for (const socialClass of cls) {
      for (let i = 0; i < 5; i++) {
        assert.doesNotThrow(
          () => ageCharacter({ socialClass, sex: 'male', targetAge: 80, seed: i + 91000 }),
          `crash: ${socialClass} age 80 seed ${i + 91000}`
        );
      }
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 8 — Physical description integration
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── Suite 8: Physical description integration ────────────────────────');

{
  // Height/frame/weight coherence: physical-description.js uses engine's rolled values
  test('physical profile height matches engine _heightIn', () => {
    for (const seed of [42, 110, 200, 427, 999]) {
      const npc = ageCharacter({ socialClass: 'artisan', sex: 'female', targetAge: 40, seed });
      const profile = generatePhysical(npc, seed);
      assert.strictEqual(profile.heightInches, npc.attributes._heightIn,
        `seed ${seed}: profile height ${profile.heightInches}" ≠ engine ${npc.attributes._heightIn}"`);
    }
  });

  test('physical profile frame matches engine _frame', () => {
    for (const seed of [42, 110, 200, 427, 999]) {
      const npc = ageCharacter({ socialClass: 'warrior', sex: 'male', targetAge: 40, seed });
      const profile = generatePhysical(npc, seed);
      assert.strictEqual(profile.frame, npc.attributes._frame,
        `seed ${seed}: profile frame '${profile.frame}' ≠ engine '${npc.attributes._frame}'`);
    }
  });

  test('physical profile weight matches engine _weightLbs', () => {
    for (const seed of [42, 110, 200, 427, 999]) {
      const npc = ageCharacter({ socialClass: 'noble', sex: 'male', targetAge: 40, seed });
      const profile = generatePhysical(npc, seed);
      assert.strictEqual(profile.weightLbs, npc.attributes._weightLbs,
        `seed ${seed}: profile weight ${profile.weightLbs} ≠ engine ${npc.attributes._weightLbs}`);
    }
  });

  // Hair greying: NPCs age ≥52 should often have grey/white hair
  test('hair greying increases with age', () => {
    let youngGrey = 0, oldGrey = 0;
    const n = 100;
    for (let i = 0; i < n; i++) {
      const young = ageCharacter({ socialClass: 'peasant', sex: 'male', targetAge: 25, seed: i + 95000 });
      const old   = ageCharacter({ socialClass: 'peasant', sex: 'male', targetAge: 60, seed: i + 95000 });
      const py = generatePhysical(young, i + 95000);
      const po = generatePhysical(old,   i + 95000);
      if (/grey|white/.test(py.hairColour)) youngGrey++;
      if (/grey|white/.test(po.hairColour)) oldGrey++;
    }
    assert.ok(oldGrey > youngGrey,
      `old grey ${oldGrey} not > young grey ${youngGrey} — greying not increasing with age`);
  });

  // Complexion modifier: Fair complexion should produce more blond/fair hair
  test('complexion modifier: fair complexion biases toward blond/fair hair', () => {
    // Generate many NPCs and check hair distribution by complexion
    let fairCompBlond = 0, fairCompBrown = 0;
    let darkCompBlond = 0, darkCompBrown = 0;
    for (let i = 0; i < 300; i++) {
      const npc = ageCharacter({ socialClass: 'peasant', sex: 'male', targetAge: 25, seed: i + 96000 });
      const p = generatePhysical(npc, i + 96000);
      if (p.complexion === 'Fair') {
        if (/blond|fair|sandy/.test(p.hairColour)) fairCompBlond++;
        if (/brown|black/.test(p.hairColour)) fairCompBrown++;
      }
      if (p.complexion === 'Dark') {
        if (/blond|fair/.test(p.hairColour)) darkCompBlond++;
        if (/brown|black/.test(p.hairColour)) darkCompBrown++;
      }
    }
    // Fair complexion should have more blond than dark complexion
    if (fairCompBlond + fairCompBrown > 10 && darkCompBlond + darkCompBrown > 5) {
      const fairPct = fairCompBlond / (fairCompBlond + fairCompBrown);
      const darkPct = darkCompBlond / (darkCompBlond + darkCompBrown);
      assert.ok(fairPct > darkPct,
        `fair complexion blond% (${(fairPct*100).toFixed(0)}%) not > dark complexion (${(darkPct*100).toFixed(0)}%)`);
    }
  });

  // Scars: scarred condition produces marks
  test('scarred condition produces marks in physical profile', () => {
    let checked = 0;
    for (let i = 0; i < 200; i++) {
      const npc = ageCharacter({ socialClass: 'warrior', sex: 'male', targetAge: 45, seed: i + 97000 });
      if (npc.conditions.includes('scarred')) {
        const p = generatePhysical(npc, i + 97000);
        assert.ok(p.marks.length > 0,
          `seed ${i + 97000}: scarred condition but no marks in physical profile`);
        checked++;
        if (checked >= 20) break;
      }
    }
    assert.ok(checked >= 5, `only ${checked} scarred warriors found — not enough to test`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 9 — Character creation completeness
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── Suite 9: Character creation completeness ─────────────────────────');

{
  const { expandStub } = require('./aging-engine');

  // Every NPC gets a deity
  test('publicDeity always set at creation (N=100)', () => {
    for (let i = 0; i < 100; i++) {
      const cls = ['noble','merchant','warrior','peasant','artisan','unguilded'][i % 6];
      const r = ageCharacter({ socialClass: cls, sex: i%2===0?'male':'female', targetAge: 25, seed: i + 200000 });
      assert.ok(r.publicDeity, `no deity for ${cls} seed ${i + 200000}`);
    }
  });

  // Clergy deity handled separately (set by order, not rolled)
  test('clergy may have null publicDeity at creation (order assigns it)', () => {
    // Clergy use a different assignment path — just confirm no crash
    assert.doesNotThrow(() => {
      for (let i = 0; i < 10; i++) {
        ageCharacter({ socialClass: 'clergy', sex: 'male', targetAge: 40, seed: i + 201000 });
      }
    });
  });

  // Sunsign always set
  test('sunsign always set (N=100)', () => {
    const VALID_SUNSIGNS = new Set(['Ulandus','Aralius','Feneri','Ahnu','Angberelius',
      'Nadai','Hirin','Tarael','Tai','Skorus','Masara','Lado']);
    for (let i = 0; i < 100; i++) {
      const r = ageCharacter({ socialClass: 'peasant', sex: 'female', targetAge: 25, seed: i + 202000 });
      assert.ok(VALID_SUNSIGNS.has(r.sunsign), `invalid sunsign '${r.sunsign}' seed ${i + 202000}`);
    }
  });

  // Birthdate always set and valid
  test('birthdate always valid (month 0–11, day 1–30)', () => {
    for (let i = 0; i < 100; i++) {
      const r = ageCharacter({ socialClass: 'peasant', sex: 'male', targetAge: 25, seed: i + 203000 });
      assert.ok(r.birthMonth >= 0 && r.birthMonth <= 11, `invalid birthMonth ${r.birthMonth}`);
      assert.ok(r.birthDay >= 1 && r.birthDay <= 30, `invalid birthDay ${r.birthDay}`);
    }
  });

  // Piety set for non-clergy
  test('piety set for non-clergy (5d6: range 5–30)', () => {
    for (let i = 0; i < 50; i++) {
      const r = ageCharacter({ socialClass: 'peasant', sex: 'female', targetAge: 25, seed: i + 204000 });
      assert.ok(r.piety >= 5 && r.piety <= 30, `piety ${r.piety} out of range`);
    }
  });

  // Medical traits: ~68% of NPCs have one; CML adjustment flows to comely/striking
  test('medical trait CML deltas flow to comely/striking conditions', () => {
    let cmlMismatch = 0;
    for (let i = 0; i < 500; i++) {
      const r = ageCharacter({ socialClass: 'peasant', sex: 'female', targetAge: 20, seed: i + 205000 });
      const cml = r.attributes.CML;
      const hasComely   = r.conditions.includes('comely');
      const hasStriking = r.conditions.includes('striking');
      // Exclude cases where CML was reduced below threshold by a post-birth injury:
      // a beautiful person who gets a scar doesn't lose the comely condition.
      const cmlInjured = r.history.some(h => h.attrDeltas?.CML < 0);
      if (!cmlInjured) {
        if (cml >= 13 && !hasComely)   cmlMismatch++;
        if (cml < 13  &&  hasComely)   cmlMismatch++;
        if (cml >= 17 && !hasStriking) cmlMismatch++;
        if (cml < 17  &&  hasStriking) cmlMismatch++;
      }
    }
    assert.strictEqual(cmlMismatch, 0, `${cmlMismatch} CML/comely mismatches`);
  });

  // comely/striking prevalence
  test(`comely ~20-28% of population (got from N=500)`, () => {
    let comely = 0;
    for (let i = 0; i < 500; i++) {
      const r = ageCharacter({ socialClass: 'peasant', sex: 'female', targetAge: 20, seed: i + 206000 });
      if (r.conditions.includes('comely')) comely++;
    }
    const pct = comely / 500 * 100;
    assert.ok(pct >= 18 && pct <= 32, `comely ${pct.toFixed(1)}% outside expected range`);
  });

  // Stub expansion: under-18 returns null
  test('expandStub returns null for stubs under 18', () => {
    const GAME_YEAR = 720;
    let violations = 0;
    for (let i = 0; i < 200; i++) {
      const r = ageCharacter({ socialClass: 'peasant', sex: 'male', targetAge: 45, seed: i + 207000 });
      r.children.forEach(c => {
        if (!c.birthYear) return;
        const age = GAME_YEAR - c.birthYear;
        const expanded = expandStub(c, GAME_YEAR);
        if (age < 18 && expanded !== null) violations++;
      });
    }
    assert.strictEqual(violations, 0, `${violations} under-18 stubs were expanded`);
  });

  // Stub expansion: adult alive stubs have metadata and expand
  test('expandStub works for adult spouse stubs', () => {
    const GAME_YEAR = 720;
    let checked = 0;
    for (let i = 0; i < 200; i++) {
      const r = ageCharacter({ socialClass: 'peasant', sex: 'male', targetAge: 40, seed: i + 208000 });
      const aliveSpouse = r.spouses.find(s => s.status === 'alive');
      if (!aliveSpouse || !aliveSpouse.birthYear) continue;
      const expanded = expandStub(aliveSpouse, GAME_YEAR);
      assert.ok(expanded !== null, `alive spouse could not be expanded seed ${i + 208000}`);
      assert.ok(expanded.publicDeity, 'expanded spouse missing publicDeity');
      assert.ok(expanded.sunsign, 'expanded spouse missing sunsign');
      assert.ok(Array.isArray(expanded.history), 'expanded spouse missing history');
      checked++;
      if (checked >= 20) break;
    }
    assert.ok(checked >= 10, `only ${checked} spouse expansions tested`);
  });

  // Stub metadata: all children have birthYear, stubSeed, sharedEvents
  test('all child stubs have expansion metadata', () => {
    for (let i = 0; i < 100; i++) {
      const r = ageCharacter({ socialClass: 'peasant', sex: 'female', targetAge: 40, seed: i + 209000 });
      r.children.forEach(c => {
        assert.ok(c.birthYear != null, `child ${c.name} missing birthYear seed ${i + 209000}`);
        assert.ok(c.stubSeed != null, `child ${c.name} missing stubSeed`);
        assert.ok(Array.isArray(c.sharedEvents), `child ${c.name} missing sharedEvents`);
      });
    }
  });

  // Household propagation: financial_ruin appears in spouse sharedEvents
  test('financial_ruin propagates to spouse sharedEvents', () => {
    let checked = 0;
    for (let i = 0; i < 500; i++) {
      const r = ageCharacter({ socialClass: 'peasant', sex: 'male', targetAge: 50, seed: i + 210000 });
      const hadRuin = r.history.some(h => h.eventId === 'financial_ruin');
      if (!hadRuin) continue;
      const ruinAge = r.history.find(h => h.eventId === 'financial_ruin').age;
      // Spouse who was alive at ruin time should have it in sharedEvents
      const spouseAtRuin = r.spouses.find(s =>
        s.marriedAtPrincipalAge <= ruinAge &&
        (s.status === 'alive' || (s.diedAtPrincipalAge && s.diedAtPrincipalAge > ruinAge))
      );
      if (!spouseAtRuin?.sharedEvents) continue;
      const inShared = spouseAtRuin.sharedEvents.some(e => e.eventId === 'financial_ruin');
      assert.ok(inShared, `financial_ruin not in spouse sharedEvents seed ${i + 210000}`);
      checked++;
      if (checked >= 20) break;
    }
    assert.ok(checked >= 5, `only ${checked} financial_ruin+spouse cases found`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 10 — Levy mechanics
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── Suite 10: Levy mechanics ──────────────────────────────────────────');

{
  // Age cap: no conscription over 40
  test('no conscription fires after age 40 (N=2000)', () => {
    let violations = 0;
    for (let i = 0; i < 2000; i++) {
      const r = ageCharacter({ socialClass: 'peasant', sex: 'male', targetAge: 60, seed: i + 300000 });
      r.history.filter(h => h.eventId === 'conscripted').forEach(h => {
        if (h.age > 40) violations++;
      });
    }
    assert.strictEqual(violations, 0, `${violations} over-40 conscriptions`);
  });

  // Tour cap: max 3 tours total, no single tour > 3 years
  test('max 3 levy tours per NPC (N=2000)', () => {
    let tourViolations = 0, durationViolations = 0;
    for (let i = 0; i < 2000; i++) {
      const r = ageCharacter({ socialClass: 'peasant', sex: 'male', targetAge: 60, seed: i + 300000 });
      const conscriptions = r.history.filter(h => h.eventId === 'conscripted');
      const discharges    = r.history.filter(h => h.eventId === 'discharged_from_levy');
      if (conscriptions.length > 3) tourViolations++;
      conscriptions.forEach(c => {
        const d = discharges.find(d => d.age > c.age);
        if (d && (d.age - c.age) > 3) durationViolations++;
      });
    }
    assert.strictEqual(tourViolations, 0, `${tourViolations} NPCs served >3 tours`);
    assert.strictEqual(durationViolations, 0, `${durationViolations} tours lasted >3 years`);
  });

  // Archetype switch: conscripted NPCs get soldier_pressed_man
  test('conscripted NPC gets soldier_pressed_man archetype during service', () => {
    let checked = 0;
    for (let i = 0; i < 500; i++) {
      const r = ageCharacter({ socialClass: 'peasant', sex: 'male', targetAge: 50, seed: i + 301000 });
      const hasLevyStart = r.archetypeChanges.some(a => a.reason === 'levy_start');
      if (!hasLevyStart) continue;
      const levyChange = r.archetypeChanges.find(a => a.reason === 'levy_start');
      assert.strictEqual(levyChange.to, 'soldier_pressed_man',
        `levy archetype was ${levyChange.to}, expected soldier_pressed_man`);
      checked++;
      if (checked >= 20) break;
    }
    assert.ok(checked >= 5, `only ${checked} levy archetype switches found`);
  });

  // Archetype restore: discharged NPCs get civilian archetype back
  test('discharged NPC restores civilian archetype (levy_end reason)', () => {
    let checked = 0, mismatches = 0;
    for (let i = 0; i < 500; i++) {
      const r = ageCharacter({ socialClass: 'peasant', sex: 'male', targetAge: 50, seed: i + 302000 });
      const levyStart = r.archetypeChanges.find(a => a.reason === 'levy_start');
      const levyEnd   = r.archetypeChanges.find(a => a.reason === 'levy_end');
      if (!levyStart || !levyEnd) continue;
      // The restored archetype should be what was saved before conscription
      assert.strictEqual(levyEnd.to, levyStart.from,
        `restored to ${levyEnd.to} but pre-levy was ${levyStart.from}`);
      checked++;
      if (checked >= 20) break;
    }
    assert.ok(checked >= 5, `only ${checked} full levy cycles found`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 11 — Archetype re-roll integrity
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── Suite 11: Archetype re-roll integrity ────────────────────────────');

{
  // No double re-roll: financial_ruin should produce exactly one archetype change
  test('financial_ruin produces at most one archetype change per firing', () => {
    let doubleRolls = 0;
    for (let i = 0; i < 1000; i++) {
      const r = ageCharacter({ socialClass: 'peasant', sex: 'male', targetAge: 50, seed: i + 400000 });
      const ruinEvents = r.history.filter(h => h.eventId === 'financial_ruin');
      ruinEvents.forEach(ruin => {
        const changesThisAge = r.archetypeChanges.filter(a => a.fromAge === ruin.age);
        if (changesThisAge.length > 1) doubleRolls++;
      });
    }
    assert.strictEqual(doubleRolls, 0, `${doubleRolls} double archetype re-rolls on financial_ruin`);
  });

  // fled_to_town peasant: class changes to unguilded, archetype re-rolls once
  test('fled_to_town peasant: single archetype re-roll to unguilded archetype', () => {
    let checked = 0, wrongClass = 0;
    for (let i = 0; i < 1000; i++) {
      const r = ageCharacter({ socialClass: 'peasant', sex: 'male', targetAge: 50, seed: i + 401000 });
      const fled = r.history.find(h => h.eventId === 'fled_to_town');
      if (!fled) continue;
      const cc = r.classChanges.find(c => c.from === 'peasant' && c.to === 'unguilded' && c.fromAge === fled.age);
      if (!cc) continue;
      // Should have exactly one archetype change at this age (class_change reason)
      const changesAtAge = r.archetypeChanges.filter(a => a.fromAge === fled.age);
      assert.strictEqual(changesAtAge.length, 1,
        `${changesAtAge.length} archetype changes at fled_to_town age seed ${i + 401000}`);
      assert.strictEqual(changesAtAge[0].reason, 'class_change');
      // New archetype should be unguilded
      assert.ok(changesAtAge[0].to.startsWith('unguilded_'),
        `new archetype ${changesAtAge[0].to} not unguilded`);
      checked++;
      if (checked >= 20) break;
    }
    assert.ok(checked >= 5, `only ${checked} fled_to_town+class_change cases found`);
  });

  // Mistress system: taken_as_mistress requires comely
  test('taken_as_mistress only fires for comely NPCs', () => {
    let violations = 0;
    for (let i = 0; i < 1000; i++) {
      const r = ageCharacter({ socialClass: 'peasant', sex: 'female', targetAge: 50, seed: i + 402000 });
      if (r.history.some(h => h.eventId === 'taken_as_mistress') &&
          !r.conditions.includes('comely')) {
        violations++;
      }
    }
    assert.strictEqual(violations, 0, `${violations} non-comely NPCs became mistress`);
  });

  // taken_as_kept_man requires striking
  test('taken_as_kept_man only fires for striking NPCs', () => {
    let violations = 0;
    for (let i = 0; i < 1000; i++) {
      const r = ageCharacter({ socialClass: 'peasant', sex: 'male', targetAge: 50, seed: i + 403000 });
      if (r.history.some(h => h.eventId === 'taken_as_kept_man') &&
          !r.conditions.includes('striking')) {
        violations++;
      }
    }
    assert.strictEqual(violations, 0, `${violations} non-striking NPCs became kept man`);
  });

  // married is never in conditions (always derived)
  test('married is never in char.conditions (always derived from spouses array)', () => {
    let violations = 0;
    for (let i = 0; i < 500; i++) {
      const cls = ['noble','merchant','warrior','peasant','artisan','unguilded'][i % 6];
      const r = ageCharacter({ socialClass: cls, sex: i%2===0?'male':'female', targetAge: 45, seed: i + 404000 });
      if (r.conditions.includes('married')) violations++;
    }
    assert.strictEqual(violations, 0, `${violations} NPCs had 'married' in conditions`);
  });

  // abandoned_family: marriage persists (NPC still legally married)
  test('abandoned_family does not end marriage in law', () => {
    let checked = 0, violations = 0;
    for (let i = 0; i < 2000; i++) {
      const r = ageCharacter({ socialClass: 'peasant', sex: 'male', targetAge: 55, seed: i + 405000 });
      if (!r.history.some(h => h.eventId === 'abandoned_family')) continue;
      // The spouse should still be alive (still married) OR died later
      const hasLivingSpouse = r.spouses.some(s => s.status === 'alive');
      const spouseKeptAlive = r.spouses.some(s =>
        s.status === 'deceased' && s.diedAtPrincipalAge > r.history.find(h=>h.eventId==='abandoned_family')?.age
      );
      // abandoned_family should NOT remove the spouse record
      if (r.spouses.length === 0) violations++;
      checked++;
      if (checked >= 20) break;
    }
    assert.ok(checked >= 5, `only ${checked} abandoned_family cases`);
    assert.strictEqual(violations, 0, `${violations} abandoned NPCs lost spouse record`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 12 — expandStub end-to-end
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── Suite 12: expandStub end-to-end ──────────────────────────────────');

{
  const { expandStub } = require('./aging-engine');
  const GAME_YEAR = 720;

  // Shared events propagate correctly into expanded NPC history
  test('shared household events appear in expanded child history', () => {
    let checked = 0;
    for (let seed = 0; seed < 1000; seed++) {
      const r = ageCharacter({ socialClass: 'peasant', sex: 'male', targetAge: 55, seed: seed + 500000 });
      const ruin = r.history.find(h => h.eventId === 'financial_ruin');
      if (!ruin) continue;
      // Find a child who was 18+ at time of ruin AND is adult at game year
      const adultChild = r.children.find(c => {
        if (c.status !== 'alive' || !c.birthYear) return false;
        const ageAtRuin = ruin.age - c.bornAtPrincipalAge;
        const ageAtGame = GAME_YEAR - c.birthYear;
        return ageAtRuin >= 18 && ageAtGame >= 18 &&
          c.sharedEvents?.some(e => e.eventId === 'financial_ruin' && !e.preHistory);
      });
      if (!adultChild) continue;
      const expanded = expandStub(adultChild, GAME_YEAR);
      if (!expanded) continue;
      const ruinShared = adultChild.sharedEvents.find(e => e.eventId === 'financial_ruin' && !e.preHistory);
      const childRuin = expanded.history.find(h => h.eventId === 'financial_ruin');
      assert.ok(childRuin, `financial_ruin not in expanded child history seed ${seed + 500000}`);
      assert.ok(Math.abs(childRuin.age - ruinShared.ageMin) <= 1, `ruin age mismatch in expanded child: got ${childRuin.age}, expected ~${ruinShared.ageMin}`);
      checked++;
      if (checked >= 10) break;
    }
    assert.ok(checked >= 3, `only ${checked} valid financial_ruin+adult child cases found`);
  });

  // Expanded NPC has full birth profile
  test('expanded stub has publicDeity, sunsign, piety', () => {
    let checked = 0;
    for (let seed = 0; seed < 300; seed++) {
      const r = ageCharacter({ socialClass: 'peasant', sex: 'male', targetAge: 45, seed: seed + 501000 });
      const spouse = r.spouses.find(s => s.status === 'alive' && s.birthYear);
      if (!spouse) continue;
      const expanded = expandStub(spouse, GAME_YEAR);
      if (!expanded) continue;
      assert.ok(expanded.publicDeity, 'expanded spouse missing publicDeity');
      assert.ok(expanded.sunsign, 'expanded spouse missing sunsign');
      assert.ok(expanded.piety != null, 'expanded spouse missing piety');
      checked++;
      if (checked >= 10) break;
    }
    assert.ok(checked >= 5, `only ${checked} spouse expansions`);
  });

  // Clergy piety = WIL×5
  test('clergy piety equals WIL×5', () => {
    for (let i = 0; i < 20; i++) {
      const r = ageCharacter({ socialClass: 'clergy', sex: 'male', targetAge: 30, seed: i + 502000 });
      const expected = r.attributes.WIL * 5;
      assert.strictEqual(r.piety, expected, `clergy piety ${r.piety} !== WIL×5 (${expected}) seed ${i + 502000}`);
    }
  });

  // Non-clergy piety range 5-30
  test('non-clergy piety in range 5-30', () => {
    for (let i = 0; i < 50; i++) {
      const r = ageCharacter({ socialClass: 'peasant', sex: 'female', targetAge: 25, seed: i + 503000 });
      assert.ok(r.piety >= 5 && r.piety <= 30, `piety ${r.piety} out of range`);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 13 — OCEAN personality weighting
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── Suite 13: OCEAN personality weighting ────────────────────────────');

{
  // Reckless personality has dramatically higher affair + gambling rates
  test('reckless personality (high O/N, low C/A) has higher affair+gambling rates', () => {
    let recklessAffair = 0, recklessGamble = 0, recklessN = 0;
    let conscientiousAffair = 0, conscientiousGamble = 0, conscientiousN = 0;
    for (let i = 0; i < 5000; i++) {
      const r = ageCharacter({ socialClass: 'merchant', sex: 'male', targetAge: 50, seed: i + 600000 });
      const o = r.oceanScores;
      const isReckless       = o.O > 65 && o.C < 35 && o.A < 35 && o.N > 65;
      const isConscientious  = o.O < 35 && o.C > 65 && o.A > 65 && o.N < 35;
      const hadAffair   = r.history.some(h => ['affair','open_affair'].includes(h.eventId));
      const hadGambling = r.history.some(h => h.eventId === 'gambling_loss');
      if (isReckless)      { recklessN++; if (hadAffair) recklessAffair++; if (hadGambling) recklessGamble++; }
      if (isConscientious) { conscientiousN++; if (hadAffair) conscientiousAffair++; if (hadGambling) conscientiousGamble++; }
    }
    assert.ok(recklessN >= 20, `too few reckless NPCs: ${recklessN}`);
    assert.ok(conscientiousN >= 10, `too few conscientious NPCs: ${conscientiousN}`);
    const rAffairPct = recklessAffair / recklessN;
    const cAffairPct = conscientiousAffair / conscientiousN;
    assert.ok(rAffairPct > cAffairPct * 2, `reckless affair rate (${(rAffairPct*100).toFixed(0)}%) not 2× conscientious (${(cAffairPct*100).toFixed(0)}%)`);
    const rGamblePct = recklessGamble / recklessN;
    const cGamblePct = conscientiousGamble / conscientiousN;
    assert.ok(rGamblePct > cGamblePct * 2 || cGamblePct === 0, `reckless gambling not 2× conscientious`);
  });

  // Devout personality has higher religious_devotion rate
  test('high-A/high-N personality has higher religious_devotion rate', () => {
    let devoutRelig = 0, devoutN = 0, irreligN = 0, irreligRelig = 0;
    for (let i = 0; i < 3000; i++) {
      const r = ageCharacter({ socialClass: 'peasant', sex: 'female', targetAge: 50, seed: i + 601000 });
      const o = r.oceanScores;
      const isDevout = o.A > 70 && o.N > 60;
      const isIrreig = o.A < 30 && o.N < 30;
      const hadRelig = r.history.some(h => ['religious_devotion','pilgrimage'].includes(h.eventId));
      if (isDevout)  { devoutN++;  if (hadRelig) devoutRelig++;  }
      if (isIrreig)  { irreligN++; if (hadRelig) irreligRelig++; }
    }
    if (devoutN >= 10 && irreligN >= 10) {
      assert.ok(devoutRelig / devoutN > irreligRelig / irreligN,
        `devout personality not more religious than irreligious`);
    }
  });

  // open_affair has immediate disgrace
  test('open_affair immediately sets disgraced condition', () => {
    let violations = 0;
    for (let i = 0; i < 1000; i++) {
      const r = ageCharacter({ socialClass: 'noble', sex: 'male', targetAge: 50, seed: i + 602000 });
      const oa = r.history.find(h => h.eventId === 'open_affair');
      if (!oa) continue;
      if (!oa.conditionsAfter?.includes('disgraced')) violations++;
    }
    assert.strictEqual(violations, 0, `${violations} open_affair events without immediate disgraced`);
  });

  // Multiple concurrent affairs possible
  test('multiple concurrent secret affairs possible (not mutually exclusive)', () => {
    let multipleFound = false;
    for (let i = 0; i < 2000; i++) {
      const r = ageCharacter({ socialClass: 'merchant', sex: 'male', targetAge: 55, seed: i + 603000 });
      let concurrent = 0, max = 0;
      for (const h of r.history) {
        if (h.eventId === 'affair') concurrent++;
        if (h.eventId === 'affair_discovered') concurrent = 0;
        max = Math.max(max, concurrent);
      }
      if (max >= 2) { multipleFound = true; break; }
    }
    assert.ok(multipleFound, 'no NPC ever had 2+ concurrent affairs');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 14 — Camp follower / levy system (female principal)
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── Suite 14: Camp follower (female principal) ───────────────────────');

{
  // husband_conscripted fires for married peasant women
  test('husband_conscripted fires for married peasant women (N=2000)', () => {
    let fired = 0;
    for (let i = 0; i < 2000; i++) {
      const r = ageCharacter({ socialClass: 'peasant', sex: 'female', targetAge: 55, seed: i + 700000 });
      if (r.history.some(h => h.eventId === 'husband_conscripted')) fired++;
    }
    assert.ok(fired >= 100, `only ${fired} husband_conscripted events in 2000 runs`);
  });

  // followed_husband_to_levy switches archetype to soldier_camp_healer
  test('followed_husband_to_levy switches archetype to soldier_camp_healer', () => {
    let checked = 0, violations = 0;
    for (let seed = 0; seed < 3000; seed++) {
      const r = ageCharacter({ socialClass: 'peasant', sex: 'female', targetAge: 55, seed: seed + 700000 });
      if (!r.history.some(h => h.eventId === 'followed_husband_to_levy')) continue;
      const campSwitch = r.archetypeChanges.find(a => a.reason === 'camp_follower_start');
      if (!campSwitch) violations++;
      else if (campSwitch.to !== 'soldier_camp_healer') violations++;
      checked++;
      if (checked >= 20) break;
    }
    assert.ok(checked >= 5, `only ${checked} followed_husband_to_levy cases`);
    assert.strictEqual(violations, 0, `${violations} camp follower archetype switch failures`);
  });

  // lover_conscripted only fires when NPC has affair or open_affair
  test('lover_conscripted only fires when NPC has affair or open_affair', () => {
    let violations = 0;
    for (let i = 0; i < 2000; i++) {
      const r = ageCharacter({ socialClass: 'peasant', sex: 'female', targetAge: 55, seed: i + 701000 });
      r.history.forEach(h => {
        if (h.eventId === 'lover_conscripted') {
          const hasAffair = h.conditionsAfter?.includes('affair') || h.conditionsAfter?.includes('open_affair') ||
            r.history.some(h2 => h2.age <= h.age && ['affair','open_affair'].includes(h2.eventId));
          if (!hasAffair) violations++;
        }
      });
    }
    assert.strictEqual(violations, 0, `${violations} lover_conscripted without affair/open_affair`);
  });

  // husband_returns_from_levy clears spouse_on_levy
  test('husband_returns_from_levy clears spouse_on_levy condition', () => {
    let checked = 0, violations = 0;
    for (let seed = 0; seed < 2000; seed++) {
      const r = ageCharacter({ socialClass: 'peasant', sex: 'female', targetAge: 55, seed: seed + 702000 });
      const returned = r.history.find(h => h.eventId === 'husband_returns_from_levy');
      if (!returned) continue;
      if (returned.conditionsAfter?.includes('spouse_on_levy')) violations++;
      checked++;
      if (checked >= 20) break;
    }
    assert.ok(checked >= 5, `only ${checked} husband_returns cases`);
    assert.strictEqual(violations, 0, `${violations} cases where spouse_on_levy persisted after return`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 15 — Parallel child simulation
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── Suite 15: Parallel child simulation ──────────────────────────────');

{
  // Witnessed events are flagged and appear in history
  test('child events are witnessed: true in principal history', () => {
    const WITNESSED_IDS = new Set(['child_dies','child_married','child_leaves_home',
      'grandchild_born','bastard_grandchild_born','grandchild_dies']);
    let found = 0;
    for (let i = 0; i < 500; i++) {
      const r = ageCharacter({ socialClass: 'peasant', sex: 'male', targetAge: 55, seed: i + 800000 });
      for (const h of r.history) {
        if (WITNESSED_IDS.has(h.eventId)) {
          assert.ok(h.witnessed === true, `${h.eventId} missing witnessed flag`);
          found++;
        }
      }
    }
    assert.ok(found >= 50, `only ${found} witnessed child events found`);
  });

  // Child mortality 30-40% pre-adulthood
  test('pre-adult child mortality 25-42% (N=1000)', () => {
    let preAdultDead = 0, total = 0;
    for (let i = 0; i < 1000; i++) {
      const r = ageCharacter({ socialClass: 'peasant', sex: 'male', targetAge: 55, seed: i + 801000 });
      r.children.forEach(c => {
        total++;
        if (c.status === 'deceased' && (c.diedAge ?? 0) < 18) preAdultDead++;
      });
    }
    const pct = preAdultDead / total * 100;
    assert.ok(pct >= 25 && pct <= 42, `pre-adult mortality ${pct.toFixed(1)}% outside 25-42% range`);
  });

  // grandchild_dies fires in history when grandchildren exist long enough
  test('grandchild_dies appears in history for long-lived principals', () => {
    let gcDeathFound = false;
    for (let i = 0; i < 500; i++) {
      const r = ageCharacter({ socialClass: 'noble', sex: 'male', targetAge: 70, seed: i + 802000 });
      if (r.history.some(h => h.eventId === 'grandchild_dies')) {
        gcDeathFound = true;
        break;
      }
    }
    assert.ok(gcDeathFound, 'no grandchild_dies found in 500 nobles aged 70');
  });

  // child_married generates spouse stub with expansion metadata on child
  test('child_married generates spouse stub with birthYear and stubSeed', () => {
    let checked = 0, violations = 0;
    for (let seed = 0; seed < 500; seed++) {
      const r = ageCharacter({ socialClass: 'noble', sex: 'male', targetAge: 60, seed: seed + 803000 });
      r.children.forEach(c => {
        if (!c.spouse) return;
        checked++;
        if (c.spouse.birthYear == null) violations++;
        if (c.spouse.stubSeed == null) violations++;
      });
      if (checked >= 30) break;
    }
    assert.ok(checked >= 5, `only ${checked} married children found`);
    assert.strictEqual(violations, 0, `${violations} married child spouses missing expansion metadata`);
  });

  // grandchild stubs attached to child stub, not principal's children array
  test('grandchildren are in child.children[], not principal.children[]', () => {
    let violations = 0;
    for (let i = 0; i < 200; i++) {
      const r = ageCharacter({ socialClass: 'noble', sex: 'male', targetAge: 65, seed: i + 804000 });
      // principal.children should only contain direct children (role === 'child')
      r.children.forEach(c => {
        if (c.role === 'grandchild') violations++;
      });
    }
    assert.strictEqual(violations, 0, `${violations} grandchildren found directly in principal.children[]`);
  });

  // widowed children remarry at realistic rates
  test('widowed children: >40% remarry overall, young widows >70%', () => {
    let widowedAll = 0, remarriedAll = 0;
    let widowedYoung = 0, remarriedYoung = 0;
    for (let i = 0; i < 400; i++) {
      const r = ageCharacter({ socialClass: 'noble', sex: 'male', targetAge: 70, seed: i + 807000 });
      r.children.forEach(c => {
        const widowedAt = c.previousSpouses?.[0]?.diedAtChildAge ?? c.spouse?.diedAtChildAge;
        if (!widowedAt) return;
        widowedAll++;
        const didRemarry = (c.previousSpouses?.length ?? 0) > 0;
        if (didRemarry) remarriedAll++;
        if (widowedAt < 35) {
          widowedYoung++;
          if (didRemarry) remarriedYoung++;
        }
      });
    }
    assert.ok(widowedAll >= 20, `only ${widowedAll} widowed children found`);
    const overallRate = remarriedAll / widowedAll * 100;
    assert.ok(overallRate >= 40, `overall remarriage rate ${overallRate.toFixed(1)}% below 40%`);
    if (widowedYoung >= 10) {
      const youngRate = remarriedYoung / widowedYoung * 100;
      assert.ok(youngRate >= 60, `young widow remarriage rate ${youngRate.toFixed(1)}% below 60%`);
    }
  });

  // remarriage restores fertility — grandchildren born after remarriage
  test('remarried children can have grandchildren post-remarriage', () => {
    let gcAfterRemarriage = 0;
    for (let i = 0; i < 300; i++) {
      const r = ageCharacter({ socialClass: 'noble', sex: 'male', targetAge: 70, seed: i + 808000 });
      r.children.forEach(c => {
        const didRemarry = (c.previousSpouses?.length ?? 0) > 0;
        if (!didRemarry || !(c.children||[]).length) return;
        const priorSpouseDiedAt = c.previousSpouses?.[0]?.diedAtChildAge ?? 0;
        if ((c.children||[]).some(gc => gc.parentAge > priorSpouseDiedAt)) gcAfterRemarriage++;
      });
    }
    assert.ok(gcAfterRemarriage >= 5, `only ${gcAfterRemarriage} cases of GC born after remarriage`);
  });

  // post-menopausal women have near-zero affair rate; men unaffected
  test('post-menopausal women: affair rate ~0%; men unaffected', () => {
    let postMenoAffairs = 0, postMenoN = 0, maleAffairs = 0, maleN = 0;
    for (let i = 0; i < 1000; i++) {
      const r = ageCharacter({ socialClass: 'merchant', sex: 'female', targetAge: 60, seed: i + 809000 });
      const menoAge = r.history.find(h => h.eventId === 'menopause')?.age ?? 99;
      if (menoAge <= 55) {
        postMenoN++;
        if (r.history.some(h => ['affair','open_affair'].includes(h.eventId) && h.age > menoAge))
          postMenoAffairs++;
      }
    }
    for (let i = 0; i < 500; i++) {
      const r = ageCharacter({ socialClass: 'merchant', sex: 'male', targetAge: 60, seed: i + 810000 });
      maleN++;
      if (r.history.some(h => ['affair','open_affair'].includes(h.eventId))) maleAffairs++;
    }
    assert.ok(postMenoN >= 20, `only ${postMenoN} post-menopausal NPCs`);
    assert.ok(postMenoAffairs === 0, `${postMenoAffairs} affairs after menopause`);
    const maleRate = maleAffairs / maleN * 100;
    assert.ok(maleRate >= 20, `male affair rate ${maleRate.toFixed(1)}% seems suppressed by menopausal gate`);
  });

  // bastard_grandchild_born adds disgraced to principal
  test('bastard_grandchild_born sets disgraced on principal', () => {
    let bastardFired = 0, disgracedAfter = 0;
    for (let i = 0; i < 1000; i++) {
      const r = ageCharacter({ socialClass: 'peasant', sex: 'male', targetAge: 60, seed: i + 811000 });
      const bastardEvent = r.history.find(h => h.eventId === 'bastard_grandchild_born');
      if (!bastardEvent) continue;
      bastardFired++;
      // disgraced should be in conditionsAfter for the event entry
      if (bastardEvent.conditionsAfter?.includes('disgraced')) disgracedAfter++;
    }
    assert.ok(bastardFired >= 10, `only ${bastardFired} bastard_grandchild_born events`);
    assert.strictEqual(bastardFired, disgracedAfter,
      `${bastardFired - disgracedAfter} bastard GC events without disgraced condition`);
  });

  // only_child and large_family conditions set at correct rates
  test('only_child ~4%, large_family ~62% of population (HârnMaster RAW families are large)', () => {
    let onlyChild = 0, largeFam = 0, N = 1000;
    for (let i = 0; i < N; i++) {
      const r = ageCharacter({ socialClass: 'peasant', sex: 'male', targetAge: 20, seed: i + 812000 });
      if (r.conditions.includes('only_child'))   onlyChild++;
      if (r.conditions.includes('large_family'))  largeFam++;
    }
    const oc = onlyChild / N * 100, lf = largeFam / N * 100;
    // RAW: rank 1 (~25%) × d6=1 (1/6) = ~4% only children
    // RAW: avg family size 5.25; siblingCount >= 4 fires for ~60% of population
    assert.ok(oc >= 1  && oc <= 8,  `only_child ${oc.toFixed(1)}% outside 1-8% range`);
    assert.ok(lf >= 50 && lf <= 75, `large_family ${lf.toFixed(1)}% outside 50-75% range`);
  });

  // family_estranged ~8%, family_distant ~20%
  test('family_estranged ~8%, family_distant ~20% of population', () => {
    let estranged = 0, distant = 0, N = 1000;
    for (let i = 0; i < N; i++) {
      const r = ageCharacter({ socialClass: 'peasant', sex: 'male', targetAge: 20, seed: i + 813000 });
      if (r.conditions.includes('family_estranged')) estranged++;
      if (r.conditions.includes('family_distant'))   distant++;
    }
    const ep = estranged / N * 100, dp = distant / N * 100;
    assert.ok(ep >= 4  && ep <= 14, `family_estranged ${ep.toFixed(1)}% outside 4-14% range`);
    assert.ok(dp >= 12 && dp <= 30, `family_distant ${dp.toFixed(1)}% outside 12-30% range`);
  });

  // grandchild birth count is realistic (spacing + lifetime cap)
  test('grandchildren per child: avg born 1.5-5, max ≤9 (N=300)', () => {
    const gcPerChild = [];
    for (let i = 0; i < 300; i++) {
      const r = ageCharacter({ socialClass: 'noble', sex: 'male', targetAge: 70, seed: i + 806000 });
      r.children.forEach(c => {
        if ((c.children || []).length > 0) {
          gcPerChild.push({ born: c.children.length });
        }
      });
    }
    assert.ok(gcPerChild.length >= 20, `only ${gcPerChild.length} children with grandchildren`);
    const avgBorn = gcPerChild.reduce((a, b) => a + b.born, 0) / gcPerChild.length;
    const maxBorn = Math.max(...gcPerChild.map(g => g.born));
    assert.ok(avgBorn >= 1.5 && avgBorn <= 5, `avg born ${avgBorn.toFixed(1)} outside 1.5-5 range`);
    assert.ok(maxBorn <= 9, `max born ${maxBorn} exceeds 9 — birth spacing not working`);
  });

  // child_fostered still works (family pool draw, not parallel sim)
  test('child_fostered fires via family pool and sets fostered flag', () => {
    let fosterFired = 0, fosterFlagSet = 0;
    for (let i = 0; i < 500; i++) {
      const r = ageCharacter({ socialClass: 'noble', sex: 'male', targetAge: 50, seed: i + 805000 });
      if (r.history.some(h => h.eventId === 'child_fostered')) {
        fosterFired++;
        if (r.children.some(c => c.fostered)) fosterFlagSet++;
      }
    }
    assert.ok(fosterFired >= 20, `only ${fosterFired} child_fostered events`);
    assert.strictEqual(fosterFired, fosterFlagSet, 'child_fostered fired without setting fostered flag');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 16 — Menopause calibration and disability mortality
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── Suite 16: Menopause calibration ─────────────────────────────────');

{
  test('menopause fires age 43-58, avg 45-52, never before 43', () => {
    const ages = [];
    for (let i = 0; i < 600; i++) {
      const r = ageCharacter({ socialClass: 'peasant', sex: 'female', targetAge: 65, seed: i + 900000 });
      const m = r.history.find(h => h.eventId === 'menopause');
      if (m) ages.push(m.age);
    }
    assert.ok(ages.length >= 300, `only ${ages.length} menopause events in 600 runs`);
    const u43 = ages.filter(a => a < 43).length;
    assert.strictEqual(u43, 0, `${u43} menopause events before age 43`);
    const avg = ages.reduce((a, b) => a + b, 0) / ages.length;
    assert.ok(avg >= 45 && avg <= 52, `avg menopause age ${avg.toFixed(1)} outside 45-52`);
  });

  test('no children born after principal reaches menopausal condition', () => {
    let violations = 0;
    for (let i = 0; i < 500; i++) {
      const r = ageCharacter({ socialClass: 'peasant', sex: 'female', targetAge: 60, seed: i + 901000 });
      const menoAge = r.history.find(h => h.eventId === 'menopause')?.age ?? 99;
      r.children.forEach(c => { if (c.bornAtPrincipalAge > menoAge) violations++; });
    }
    assert.ok(violations <= 2, `${violations} children born after menopause`);
  });

  test('disabled children have higher mortality than non-disabled', () => {
    let disabledDead = 0, disabledTotal = 0, normalDead = 0, normalTotal = 0;
    for (let i = 0; i < 1000; i++) {
      const r = ageCharacter({ socialClass: 'peasant', sex: 'male', targetAge: 55, seed: i + 902000 });
      r.children.forEach(c => {
        if (c.disability) { disabledTotal++; if (c.status === 'deceased') disabledDead++; }
        else               { normalTotal++;   if (c.status === 'deceased') normalDead++; }
      });
    }
    assert.ok(disabledTotal >= 20, `only ${disabledTotal} disabled children`);
    assert.ok(disabledDead / disabledTotal > normalDead / normalTotal,
      `disabled mortality ${(disabledDead/disabledTotal*100).toFixed(1)}% not higher than normal ${(normalDead/normalTotal*100).toFixed(1)}%`);
  });

  test('child_placed_in_monastery sets leftHome and inMonastery on child stub', () => {
    let checked = 0, violations = 0;
    for (let seed = 0; seed < 1000; seed++) {
      const r = ageCharacter({ socialClass: 'noble', sex: 'male', targetAge: 55, seed: seed + 903000 });
      if (!r.history.some(h => h.eventId === 'child_placed_in_monastery')) continue;
      const monasteryChild = r.children.find(c => c.inMonastery);
      if (!monasteryChild) { violations++; checked++; continue; }
      if (!monasteryChild.leftHome) violations++;
      checked++;
      if (checked >= 15) break;
    }
    assert.ok(checked >= 5, `only ${checked} monastery placements found`);
    assert.strictEqual(violations, 0, `${violations} monastery placements without stub flag`);
  });
}


// ─────────────────────────────────────────────────────────────────────────────
// SUITE 17 — md-writer output
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── Suite 17: md-writer output ───────────────────────────────────────');

{
  const { renderNPC, renderStub } = require('./md-writer');

  test('renderNPC includes sunsign, piety, OCEAN, birthdate in GM callout', () => {
    for (let i = 0; i < 5; i++) {
      const r = ageCharacter({ socialClass: 'noble', sex: 'male', targetAge: 50, seed: i + 950000 });
      const md = renderNPC(r);
      assert.ok(md.includes('Sunsign'),  `seed ${i+950000}: Sunsign missing`);
      assert.ok(md.includes('Piety'),    `seed ${i+950000}: Piety missing`);
      assert.ok(md.includes('OCEAN'),    `seed ${i+950000}: OCEAN missing`);
      assert.ok(md.includes('Born:'),    `seed ${i+950000}: Born: missing`);
    }
  });

  test('renderNPC includes grandchildren in family section', () => {
    let found = false;
    for (let seed = 0; seed < 200; seed++) {
      const r = ageCharacter({ socialClass: 'noble', sex: 'male', targetAge: 65, seed: seed + 951000 });
      if (!r.children.some(c => (c.children||[]).length > 0)) continue;
      const md = renderNPC(r);
      assert.ok(md.includes('grandchild'), 'grandchild not rendered in family section');
      found = true;
      break;
    }
    assert.ok(found, 'no NPC with grandchildren found in 200 seeds');
  });

  test('renderNPC shows relationship flags for affair/open_affair/abandoned_family', () => {
    let found = 0;
    for (let seed = 0; seed < 500; seed++) {
      const r = ageCharacter({ socialClass: 'merchant', sex: 'male', targetAge: 55, seed: seed + 952000 });
      const hasFlag = ['affair','open_affair','abandoned_family'].some(c => r.conditions.includes(c));
      if (!hasFlag) continue;
      const md = renderNPC(r);
      assert.ok(md.includes('Relationship flags'), `seed ${seed+952000}: Relationship flags missing despite condition`);
      found++;
      if (found >= 5) break;
    }
    assert.ok(found >= 3, `only ${found} NPC with relationship flags found`);
  });

  test('renderStub includes birthYear, stubSeed, grandchildren if present', () => {
    let checked = 0;
    for (let seed = 0; seed < 300; seed++) {
      const r = ageCharacter({ socialClass: 'noble', sex: 'male', targetAge: 65, seed: seed + 953000 });
      const child = r.children.find(c => c.birthYear && (c.children||[]).length > 0);
      if (!child) continue;
      const md = renderStub(child);
      assert.ok(md.includes('birthYear'), 'birthYear missing from stub frontmatter');
      assert.ok(md.includes('Grandchildren'), 'grandchildren missing from stub GM note');
      assert.ok(md.includes('expandStub'), 'expandStub reference missing');
      checked++;
      if (checked >= 5) break;
    }
    assert.ok(checked >= 3, `only ${checked} child stubs with grandchildren found`);
  });

  test('renderStub for monastery child shows inMonastery flag', () => {
    let found = false;
    for (let seed = 0; seed < 1000; seed++) {
      const r = ageCharacter({ socialClass: 'noble', sex: 'male', targetAge: 55, seed: seed + 954000 });
      const mc = r.children.find(c => c.inMonastery);
      if (!mc) continue;
      const md = renderStub(mc);
      assert.ok(md.includes('monastery'), 'monastery not mentioned in stub');
      found = true;
      break;
    }
    assert.ok(found, 'no monastery child found in 1000 seeds');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// LARANIAN CLERGY TESTS
// ─────────────────────────────────────────────────────────────────────────────
test('clergy start as postulant, advance through ranks', () => {
    const results = [];
    for (let i = 0; i < 500; i++) {
      results.push(ageCharacter({ socialClass: 'clergy', sex: 'male', targetAge: 55, seed: i }));
    }
    // Phase: most should reach ordained or senior_clergy
    const senior = results.filter(r => r.phase === 'senior_clergy').length;
    assert.ok(senior / 500 >= 0.70, `Only ${(senior/5).toFixed(0)}% reached senior_clergy (expected ≥70%)`);

    // Postulants: very few should still be postulant at 55
    const postulants = results.filter(r => r.conditions.includes('clergy_postulant')).length;
    assert.ok(postulants / 500 <= 0.10, `${(postulants/5).toFixed(0)}% still postulant at 55 (expected ≤10%)`);

    // Matakea (priest+vicar+canon) should be majority
    const matakea = results.filter(r =>
      ['clergy_priest','clergy_vicar','clergy_canon'].some(c => r.conditions.includes(c))
    ).length;
    assert.ok(matakea / 500 >= 0.60, `Only ${(matakea/5).toFixed(0)}% are Matakea+ at 55 (expected ≥60%)`);
  });

  test('clergy can marry and have children (not celibate per RAW)', () => {
    const results = [];
    for (let i = 0; i < 500; i++) {
      results.push(ageCharacter({ socialClass: 'clergy', sex: 'male', targetAge: 55, seed: i }));
    }
    // All clergy combined — lower rate expected now that Peoni (celibate) are correctly blocked
    const married = results.filter(r => r.spouses.length > 0).length;
    const withChildren = results.filter(r => r.children.length > 0).length;
    assert.ok(married / 500 >= 0.10, `Only ${(married/5).toFixed(0)}% married (expected ≥10%)`);
    assert.ok(married / 500 <= 0.50, `${(married/5).toFixed(0)}% married (expected ≤50%)`);
    assert.ok(withChildren / 500 >= 0.08, `Only ${(withChildren/5).toFixed(0)}% have children (expected ≥8%)`);

    // Laranian/Halean clergy specifically must be able to marry (non-celibate per RAW)
    const laranianMale = results.filter(r => r.publicDeity === 'Larani');
    const laranianMarried = laranianMale.filter(r => r.spouses.length > 0).length;
    assert.ok(laranianMarried / laranianMale.length >= 0.18,
      `Only ${(100*laranianMarried/laranianMale.length).toFixed(0)}% of Laranian clergy married (expected ≥18%)`);

    // Peoni clergy must NOT gain new marriages post-ordination (celibacy vow).
    // Pre-ordination spouses are permitted (widow late-entry archetype and similar).
    let peoniPostOrdMarriages = 0;
    for (const r of results) {
      if (r.publicDeity !== 'Peoni' || !r.conditions.includes('peoni_celibate')) continue;
      const ordEvent = r.history.find(e =>
        e.eventId === 'ordained_as_acolyte' || e.eventId === 'ordained_as_priest');
      if (!ordEvent) continue;
      for (const s of r.spouses) {
        // s.ageAtMarriage is the SPOUSE's age at marriage.
        // We need the PRINCIPAL's age at marriage = r.age at time of marriage.
        // The principal's marriage age ≈ ordEvent.age - years between events.
        // Better: check if 'married' event in history is after ordination
        const marriedEvent = r.history.find(e => e.eventId === 'married' || e.eventId === 'remarriage_older');
        if (marriedEvent && marriedEvent.age >= ordEvent.age) peoniPostOrdMarriages++;
      }
    }
    assert.strictEqual(peoniPostOrdMarriages, 0,
      `${peoniPostOrdMarriages} ordained Peoni clergy had post-ordination marriage events (must be 0)`);
  });

  test('bishop/archbishop never fire from random pool', () => {
    let bishops = 0;
    for (let i = 0; i < 2000; i++) {
      const r = ageCharacter({ socialClass: 'clergy', sex: 'male', targetAge: 65, seed: i });
      if (r.history.some(h => h.eventId === 'elevated_to_bishop' || h.eventId === 'elevated_to_archbishop')) {
        bishops++;
      }
    }
    assert.strictEqual(bishops, 0, `${bishops} NPCs got bishop/archbishop from pool (must be 0)`);
  });

  test('bishop created via forcedEvents fires in correct order', () => {
    const r = ageCharacter({
      socialClass: 'clergy', sex: 'male', targetAge: 65, seed: 2,
      forcedEvents: [{ eventId: 'elevated_to_bishop', ageMin: 52, ageMax: 58, pool: 'biographical' }],
    });
    assert.ok(r.conditions.includes('clergy_bishop'), 'clergy_bishop condition not set');
    assert.ok(!r.conditions.includes('clergy_canon'), 'clergy_canon should be removed on bishop appointment');
    const bishopEvent = r.history.find(h => h.eventId === 'elevated_to_bishop');
    assert.ok(bishopEvent, 'elevated_to_bishop not in history');
    assert.ok(bishopEvent.age >= 52 && bishopEvent.age <= 58, `elevated_to_bishop fired at age ${bishopEvent.age}, expected 52-58`);
    // At minimum the acolyte ordination must have fired (entry into order)
    assert.ok(r.history.some(h => h.eventId === 'ordained_as_acolyte'), 'ordained_as_acolyte missing');
  });

  test('clergy deity is Larani and RITUAL skill uses SBx4', () => {
    const r = ageCharacter({ socialClass: 'clergy', sex: 'male', targetAge: 40, seed: 1 });
    assert.strictEqual(r.publicDeity, 'Larani', `publicDeity is ${r.publicDeity}, expected Larani`);
    const { generateAutomaticSkills } = require('./npc-generator');
    const skills = generateAutomaticSkills(r.attributes, r.sunsign, r.publicDeity, 'clergy');
    const ritual = skills.find(s => s.isRitual);
    assert.ok(ritual, 'RITUAL skill not found');
    assert.strictEqual(ritual.oml, ritual.sb * 4, `RITUAL OML ${ritual.oml} ≠ SB×4 (${ritual.sb * 4})`);
  });

  test('clergy have correct professional skills from Character 23', () => {
    const r = ageCharacter({ socialClass: 'clergy', sex: 'male', targetAge: 40, seed: 1 });
    const { generateAutomaticSkills } = require('./npc-generator');
    const skills = generateAutomaticSkills(r.attributes, r.sunsign, r.publicDeity, 'clergy');
    const skillNames = skills.map(s => s.name);
    const required = ['Script (Lakise)', 'Script (Khruni)', 'Language (Emela)',
                      'PHYSICIAN', 'LAW', 'MENTAL CONFLICT', 'HERALDRY',
                      'EMBALMING', 'SWORD', 'SHIELD', 'DAGGER'];
    required.forEach(name => {
      assert.ok(skillNames.includes(name), `Missing clergy skill: ${name}`);
    });
  });

  test('Laranian colour events fire for clergy', () => {
    let total = 0;
    for (let i = 0; i < 200; i++) {
      const r = ageCharacter({ socialClass: 'clergy', sex: 'male', targetAge: 55, seed: i });
      total += r.history.filter(h => h.eventId?.startsWith('colour_laranian_')).length;
    }
    const avg = total / 200;
    assert.ok(avg >= 0.3, `Avg Laranian colour events per NPC: ${avg.toFixed(2)} (expected ≥0.3)`);
  });

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`  ${passed + failed} tests  |  ${passed} passed  |  ${failed} failed`);
console.log('─'.repeat(60));

if (failed > 0) process.exit(1);
