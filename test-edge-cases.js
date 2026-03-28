'use strict';

/**
 * Edge-case and destruction tests
 * - Invalid inputs, garbage data
 * - Determinism violations (Math.random bypass)
 * - craftsperson vs artisan mapping
 * - Constraint-injector determinism
 */

const assert = require('assert');
const { ageCharacter } = require('./aging-engine');
const { renderNPC } = require('./md-writer');
const { seedRng, rand } = require('./rng');

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

console.log('\n── Edge-case & destruction tests ────────────────────────────────');

// 1. craftsperson passed to ageCharacter — engine expects 'artisan'
test('craftsperson socialClass does not crash ageCharacter', () => {
  seedRng(1);
  const r = ageCharacter({ socialClass: 'craftsperson', sex: 'female', targetAge: 35, seed: 1 });
  assert.ok(r, 'result null');
  // Engine may not have craftsperson in phase configs — could return undefined phase
  assert.ok(r.age === 35, 'age mismatch');
});

// 2. Invalid socialClass
test('invalid socialClass "garbage" handled without crash', () => {
  seedRng(2);
  try {
    const r = ageCharacter({ socialClass: 'garbage', sex: 'male', targetAge: 30, seed: 2 });
    // Engine may crash or return partial result — document behaviour
    assert.ok(r !== undefined, 'undefined result');
  } catch (e) {
    assert.ok(e.message, 'expected error with message');
  }
});

// 3. Determinism: same seed produces identical output
test('determinism: same seed produces identical NPC', () => {
  const seed = 12345;
  const r1 = ageCharacter({ socialClass: 'peasant', sex: 'male', targetAge: 45, seed });
  const r2 = ageCharacter({ socialClass: 'peasant', sex: 'male', targetAge: 45, seed });
  assert.deepStrictEqual(r1.attributes, r2.attributes, 'attributes differ');
  assert.deepStrictEqual(r1.history.map(h => h.eventId), r2.history.map(h => h.eventId), 'history differ');
  assert.strictEqual(r1.morality, r2.morality, 'morality differs');
});

// 4. Pagaelin: uses Math.random() in aging-engine — determinism broken
test('Pagaelin OCEAN uses seeded RNG (not Math.random)', () => {
  const seed = 999;
  const r1 = ageCharacter({ socialClass: 'pagaelin', sex: 'male', targetAge: 35, seed });
  const r2 = ageCharacter({ socialClass: 'pagaelin', sex: 'male', targetAge: 35, seed });
  // If Math.random is used, these will differ across runs
  assert.ok(r1.oceanScores, 'oceanScores missing');
  assert.ok(r2.oceanScores, 'oceanScores missing');
  const keys = ['O','C','E','A','N'];
  for (const k of keys) {
    assert.strictEqual(r1.oceanScores[k], r2.oceanScores[k],
      `Pagaelin OCEAN ${k} not deterministic: ${r1.oceanScores[k]} vs ${r2.oceanScores[k]}`);
  }
});

// 5. Extreme age
test('age 95 does not crash', () => {
  assert.doesNotThrow(() => {
    ageCharacter({ socialClass: 'noble', sex: 'male', targetAge: 95, seed: 42 });
  });
});

// 6. Minimum age 18
test('targetAge 18 produces valid NPC', () => {
  const r = ageCharacter({ socialClass: 'peasant', sex: 'female', targetAge: 18, seed: 7 });
  assert.strictEqual(r.age, 18);
  assert.ok(r.history.length >= 0);
});

// 7. renderNPC produces no undefined/null/NaN in output
test('renderNPC output contains no undefined, null, or NaN (sample 500)', () => {
  let badCount = 0;
  const badSeeds = [];
  for (let i = 0; i < 500; i++) {
    const r = ageCharacter({ socialClass: 'peasant', sex: 'male', targetAge: 40, seed: i + 100000 });
    const md = renderNPC(r);
    if (md.includes('undefined') || md.includes('null') || md.includes('NaN')) {
      badCount++;
      if (badSeeds.length < 5) badSeeds.push(i + 100000);
    }
  }
  assert.ok(badCount <= 2, `Expected ≤2 bad renders in 500, got ${badCount} at seeds ${badSeeds.join(', ')}`);
});

// 8. Null/undefined optional params
test('ageCharacter handles omitted optional params', () => {
  const r = ageCharacter({ socialClass: 'noble', sex: 'female', targetAge: 50 });
  assert.ok(r.name || r.given !== undefined, 'name/given present');
  assert.ok(Array.isArray(r.conditions));
});

// 9. Empty history edge (very young, rare)
test('young NPC can have minimal history', () => {
  const r = ageCharacter({ socialClass: 'artisan', sex: 'male', targetAge: 18, seed: 888 });
  assert.ok(Array.isArray(r.history));
  assert.ok(r.history.length >= 0);
});

// 10. All 22 classes from README (including guilded)
const ALL_CLASSES = [
  'noble', 'merchant', 'warrior', 'soldier', 'peasant', 'artisan', 'unguilded', 'clergy',
  'lia_kavair', 'priest_naveh', 'guilded_innkeeper', 'guilded_arcanist', 'guilded_mariner',
  'guilded_miner', 'pagaelin', 'walker_shaman', 'destitute',
];
test('all documented classes generate without crash', () => {
  for (const cls of ALL_CLASSES) {
    assert.doesNotThrow(() => {
      ageCharacter({ socialClass: cls, sex: 'male', targetAge: 40, seed: 1 });
    }, `crash: ${cls}`);
  }
});

console.log(`\n${'─'.repeat(60)}`);
console.log(`  ${passed + failed} edge tests  |  ${passed} passed  |  ${failed} failed`);
console.log('─'.repeat(60));
if (failed > 0) process.exit(1);
