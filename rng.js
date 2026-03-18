'use strict';

/**
 * rng.js — Seedable pseudo-random number generator
 *
 * Implements mulberry32, a fast 32-bit PRNG with good statistical properties.
 * All randomness in the NPC engine flows through this module so that passing
 * a `seed` to ageCharacter() produces a fully deterministic result.
 *
 * USAGE
 * ─────
 *   const { getRng, seedRng, rand } = require('./rng');
 *
 *   // Seed at the start of a generation run:
 *   seedRng(42);
 *
 *   // Then everywhere you'd use Math.random():
 *   rand();                 // → float in [0, 1)
 *
 *   // Or grab the current function directly (useful for passing to helpers):
 *   const rng = getRng();
 *   rng();
 *
 * MODULE STATE
 * ────────────
 * The module holds one global RNG instance. seedRng() replaces it.
 * When no seed has been set (or seedRng(null) called), rand() delegates
 * to Math.random() — backwards-compatible behaviour.
 *
 * DETERMINISM SCOPE
 * ─────────────────
 * For a fully deterministic run, call seedRng(n) before ageCharacter().
 * All downstream calls — injury rolls, name generation, archetype rolls,
 * OCEAN scores, every weightedRandom draw — will be reproducible.
 */

// ─────────────────────────────────────────────────────────────────────────────
// mulberry32 implementation
// ─────────────────────────────────────────────────────────────────────────────

function mulberry32(seed) {
  // seed must be a 32-bit integer
  let s = seed >>> 0;
  return function () {
    s += 0x6D2B79F5;
    let z = s;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    z = (z ^ (z >>> 14)) >>> 0;
    return z / 4294967296;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level state
// ─────────────────────────────────────────────────────────────────────────────

let _rng = null;   // null → use Math.random()

/**
 * Seed the global RNG. Pass null to revert to Math.random().
 * @param {number|null} seed  Integer seed value, or null for unseeded mode.
 */
function seedRng(seed) {
  if (seed === null || seed === undefined) {
    _rng = null;
  } else {
    // Hash the seed to avoid poor behaviour with seed=0 or seed=1
    const hashed = (seed ^ 0xDEADBEEF) >>> 0;
    _rng = mulberry32(hashed);
  }
}

/**
 * Return the current RNG function (mulberry32 or Math.random).
 * Use this when you need to pass the RNG as a value.
 */
function getRng() {
  return _rng || Math.random.bind(Math);
}

/**
 * Draw one value in [0, 1) from the current RNG.
 * Drop-in replacement for Math.random().
 */
function rand() {
  return _rng ? _rng() : Math.random();
}

/**
 * Roll n dice each with x faces, return the sum.
 * e.g. dN(3, 6) = 3d6, dN(1, 100) = d100
 */
function dN(n, x) {
  let t = 0;
  for (let i = 0; i < n; i++) t += Math.floor(rand() * x) + 1;
  return t;
}

module.exports = { seedRng, getRng, rand, dN };
