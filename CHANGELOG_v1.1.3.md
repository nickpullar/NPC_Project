# v1.1.3 — Audit Fixes

All items from the ruthless audit implemented and verified.

## Critical

**Item 1 — constraint-injector.js: deterministic child sex**
Both injected child sex rolls (`Math.random()`) replaced with a seeded
deterministic RNG. Seed derived from `hash(birthYear + name + historyLen +
childCount)` using FNV-1a. Same NPC result → same RNG seed → same injected
child sexes on every call. LCG matches the pattern used by extended-family.js.

**Item 2 — aging-engine.js: condensed fallback pronouns**
Already fixed in v1.1.2 (sex-aware "He/She endured" + 8 phrase variants +
`principalSex` parameter passed from `assembleResult`). Verified present.

**Item 3 — generate-from-description.js: craftsperson → artisan**
`constraints.socialClass === 'craftsperson'` now maps to `'artisan'` before
building `baseParams`. The engine has no `craftsperson` class; this mapping
was silently producing broken NPCs.

## High

**Item 4 — physical-description.js: API key from environment**
`generatePhysicalDescription()` now reads `process.env.ANTHROPIC_API_KEY`.
Throws a clear error if missing ("use generatePhysical() for the non-AI path").
Adds `x-api-key` and `anthropic-version` headers to the fetch call.

**Item 5 — md-writer.js: safe npc.name handling**
`renderFrontmatter` and `renderTitle` now resolve the name safely regardless
of whether `npc.name` is a string or a legacy `{ full, given, surname }` object.
Double `toSlug(toSlug(...))` call fixed. `_npcFullName` helper used throughout.

**Item 6 — constraint-injector.js: dead condSet removed**
`const condSet = new Set(result.attributes ? [] : []);  // unused` deleted.

## Medium

**Item 7 — README.md: version and test count**
Header updated from v1.0.0 to v1.1.2. Test count clarified.

**Item 8 — constraint-injector.js: findLast polyfill**
Already present from v1.1.2: `findLast?.() || [...result.history].reverse().find()`.

## Low / Optional

**Item 9 — test-regression.js: comment mismatch**
"All 22 unguilded archetypes" comment replaced with accurate description.

**Item 10 — physical-description.js: RNG comment**
Already present in module header (line ~22): explains local xorshift32 RNG.

**Item 11 — null/undefined guards**
- `buildNarrative` faith-change line now guards `dc.note || 'Faith changed.'`
  (previously emitted `undefined` when `deityChange` had no `note` field)
- `renderBackground` narrative lines now `filter(Boolean)` before mapping
- Cousin/nephew name cells guarded with `?? "Unknown"`
- 1000-NPC Monte Carlo across 10 classes: 0 `undefined` in output ✅

## Stats
- Events: 761 | Archetypes: 321 | Tests: 150/150
- Files modified: constraint-injector.js, generate-from-description.js,
  physical-description.js, md-writer.js, aging-engine.js, README.md,
  test-regression.js
