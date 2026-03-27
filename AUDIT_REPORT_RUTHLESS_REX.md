# RUTHLESS REX AUDIT REPORT — Kaldor NPC Aging Engine

**Date:** 2026-03-18  
**Auditor:** Ruthless Rex (Senior Test Engineer)  
**Repository:** NPC_Project (HârnWorld Kaldor NPC Generator)  
**VERSION:** 1.1.0

---

## 1. FULL REPO RECON — VERDICT

**Structure:** Flat, no package.json, no build system. Every `.js` file dumped in the root like a teenager’s desktop. `scripts/` holds two one-off migration scripts. No `node_modules` — zero dependencies. That’s either discipline or poverty. README claims "158 tests" — **outdated;** the suite has 171. Someone forgot to update the README. Embarrassing.

**Architecture:** ~75k LOC across 20+ modules. `aging-engine.js` is a 5.7k-line god file. The main flow is clear: `generate-full-npc.js` → `ageCharacter()` → year loop, event draws, pregnancy, morality, injury resolution, narrative build. Constraint-based generation (`generate-from-description.js`) is optional and depends on an AI parser.

---

## 2. RANKED ISSUE LIST (Critical → Low)

### CRITICAL

| # | File:Line | Issue | Savage One-Liner |
|---|-----------|-------|------------------|
| 1 | `aging-engine.js:2237` | Pagaelin OCEAN uses `Math.random()` instead of project RNG | *"Every Pagaelin NPC you’ve ever generated is non-deterministic garbage. Same seed, different person. Congratulations."* **FIXED** |
| 2 | `constraint-injector.js:400, 483` | Child sex in injected children uses `Math.random()` | *"Constraint-based generation: fully non-reproducible. Your 'seed: 42' means nothing when the injector flips a coin."* **FIXED** |
| 3 | `generate-from-description.js:277` | Passes `socialClass: 'craftsperson'` to engine; engine expects `artisan` | *"craftsperson falls through to undefined phase configs and wrong archetype lookup. Good luck debugging that."* **FIXED** |

### HIGH

| # | File:Line | Issue | Savage One-Liner |
|---|-----------|-------|------------------|
| 4 | `physical-description.js:384–399` | `generatePhysicalDescription()` calls Anthropic API with no auth, no key handling | *"This will 401 every time. If you add a key, you’ll paste it in and it’ll end up in git history. Security 101: you failed."* |
| 5 | `physical-description.js:99` | `toSlug(toSlug(npc.name))` — double toSlug on name; `npc.name` may be object | *"Defensive coding? Never heard of it. Pass a name object and watch the frontmatter id turn into 'unknown'."* |
| 6 | `constraint-injector.js:206` | `const condSet = new Set(result.attributes ? [] : []);` — dead code, always empty | *"Someone wrote a variable, never used it, and left a comment 'unused'. Delete it or use it."* |

### MEDIUM

| # | File:Line | Issue | Savage One-Liner |
|---|-----------|-------|------------------|
| 7 | `test-regression.js:319` | Typo: "all sexs/classes" → "sexes" | *"Spellcheck exists. 'sexs' is not a word."* **FIXED** |
| 8 | `README.md` | States "158 tests" — actual count is 171 | *"Documentation rot. One number. Update it."* |
| 9 | `aging-engine.js` | No `craftsperson` in `CLASS_CULTURE_MAP` or `CLASS_PHASE_CONFIGS` | *"External callers can pass craftsperson and get undefined behaviour. Validate or normalise at the boundary."* |
| 10 | `md-writer.js` | `npc.name` may be object `{ full, given, surname }` — string concat can emit `[object Object]` | *"Assuming name is a string in several places. One object later and your markdown explodes."* |

### LOW

| # | File:Line | Issue | Savage One-Liner |
|---|-----------|-------|------------------|
| 11 | `constraint-injector.js:421` | `findLast` — may not exist on older Node | *"Array.prototype.findLast is ES2023. Use a polyfill or reverse+find for broader support."* |
| 12 | `physical-description.js` | Uses xorshift32; engine uses mulberry32 | *"Two PRNGs for reproducibility. Works, but adds cognitive load. Document why."* |
| 13 | `test-regression.js:431` | Comment says "22 unguilded archetypes"; assertion expects 85 | *"Comment and assertion don’t match. One of them is wrong."* |

---

## 3. MONTE CARLO STATISTICAL SUMMARY

**Run:** N=10,000 (quick mode); config supports N=50,000.

### Structural Coherence (0–100)

| Metric | Value |
|--------|-------|
| Mean | 99.98 |
| Median | 100.00 |
| Std Dev | 0.66 |
| 95% CI | [99.97, 100.00] |
| Perfect (100) | 99.93% |
| Failures (<100) | 7 (0.07%) |
| Top violation | markdown contains undefined/null/NaN |

**Comment:** *"Structure is solid. The seven failures are template leakage — someone forgot to guard a flavour string. 99.93% clean is good. Not perfect."*

### Narrative Fluency (0–100)

| Metric | Value |
|--------|-------|
| Mean | 99.96 |
| Median | 100.00 |
| Std Dev | 1.13 |
| 95% CI | [99.94, 99.98] |
| Acceptable (≥80) | 99.93% |
| Poor (<80) | 7 (0.07%) |

**Comment:** *"The narrative fluency here is not 'drunk toddler' level. It’s template-driven and consistent. The same seven outliers as structure — fix the template guards and both scores go to 100."*

### Events per NPC

| Metric | Value |
|--------|-------|
| Mean | 43.9 |
| Median | 39 |
| Min / Max | 1 / 174 |
| P5 / P95 | 4 / 102 |

**Comment:** *"Event count distribution is sane. Young NPCs get few events; old NPCs get many. No explosions."*

### Crashes

| Metric | Value |
|--------|-------|
| Total | 0 |
| Crash-free rate | 100% |

**Comment:** *"No crashes in 10k runs. That’s baseline competence, not a medal."*

### Distribution Sketch (structural score)

```
100 |████████████████████████████████████████████████ 9993
 99 |██ 5
 98 |█ 2
 ...
  0 |
```

**Comment:** *"The structural integrity of these NPCs is not 'wet toilet paper'. It’s actually firm. The 0.07% leakage is annoying, not catastrophic."*

---

## 4. FIXES APPLIED (Code Changes)

### Fix 1: Pagaelin OCEAN determinism — `aging-engine.js:2237`

```javascript
// BEFORE
const variation = Math.floor(Math.random() * 31) - 15;

// AFTER
const variation = Math.floor(rand() * 31) - 15;
```

### Fix 2: Constraint-injector child sex — `constraint-injector.js`

- Added: `const { rand } = require('./rng');`
- Replaced `Math.random() < 0.5` with `rand() < 0.5` at lines 400 and 483.

### Fix 3: craftsperson → artisan — `generate-from-description.js`

- Normalise `craftsperson` to `artisan` before calling `ageCharacter`.

### Fix 4: Typo — `test-regression.js:319`

- "sexs" → "sexes".

---

## 5. NEW TEST SUITE ADDED

### `test-monte-carlo.js`

- 50,000-iteration Monte Carlo (10k in `--quick` mode).
- Structural coherence scoring: attributes, morality, age/birthYear, marriage/children consistency, history validity, markdown leakage.
- Narrative fluency scoring: length, sentence endings, duplicates, template leakage.
- Full stats: mean, median, std dev, 95% CI, failure rates.
- Run: `node test-monte-carlo.js` or `node test-monte-carlo.js --quick`.

### `test-edge-cases.js`

- craftsperson and invalid socialClass handling.
- Determinism: same seed → identical NPC.
- Pagaelin OCEAN determinism (catches Math.random bug).
- Extreme age (95), targetAge 18.
- renderNPC no undefined/null/NaN (500-sample check).
- Null/undefined optional params.
- All documented classes generate without crash.

---

## 6. SURVIVAL SCORE: **72/100**

**Breakdown:**

- Test coverage: 171 tests, solid regression + new edge/Monte Carlo. (+18)
- Determinism: Fixed; was broken in Pagaelin and constraint-injector. (+12)
- Structural integrity: 99.93% clean. (+15)
- Narrative output: Same 99.93%. (+12)
- Security: API key handling absent; no OWASP howlers. (-8)
- Code hygiene: Dead code, typos, doc drift. (-5)
- Architecture: Single 5.7k-line engine file; no build. (-5)
- Monte Carlo: No crashes; consistent stats. (+5)

**Verdict:** *"Above average. The engine is serious work. Fix the remaining leakage, lock down the API, and this could clear 85."*

---

## 7. PLAIN-LANGUAGE SUMMARY OF EVERYTHING FOUND

### What’s Actually Good

**The NPC generation logic is solid.** The simulation produces plausible lives: events, morality, injuries, family, and skills hang together. The test suite is large and covers many edge cases. Name generation and physical descriptions are consistent. The 753 life events and 315 archetypes are well-structured. Monte Carlo runs show 100% crash-free and 99.93% structurally coherent outputs. The narrative text is template-driven and mostly clean.

### What Was Broken (and Fixed)

**Pagaelin NPCs were non-deterministic.** Pagaelin is a tribal culture. Their personality scores used `Math.random()` instead of the project’s seeded RNG. Same seed produced different people. That’s fixed by using `rand()`.

**Constraint-injected children were non-deterministic.** When generating NPCs from descriptions (e.g. “widowed with two children”), missing children were injected. Their sex was chosen with `Math.random()`, so reproducibility was lost. Fixed by using `rand()`.

**craftsperson vs artisan mismatch.** The constraint system uses “craftsperson” for innkeepers and similar roles. The aging engine expects “artisan”. Passing “craftsperson” led to undefined phase configs and odd behaviour. Fixed by mapping craftsperson → artisan before simulation.

**Typo in tests.** A test message said “sexs” instead of “sexes”. Fixed.

### What’s Still Problematic

**Physical description API call.** There’s a function that calls Anthropic’s API for AI-written physical descriptions. It has no API key handling and would fail in production. If a key is added, it risks ending up in source control.

**A few markdown leaks.** About 7 in 10,000 NPCs produce output containing “undefined”, “null”, or “NaN”. This comes from rare events where a flavour or label is missing. It’s infrequent but should be tracked and fixed.

**Documentation drift.** README says 158 tests; the suite has 171. Small but sloppy.

**Dead code.** The constraint-injector has a variable that’s never used. It should be removed or actually used.

### Security and Performance

No obvious OWASP Top 10 issues beyond the API key risk. No SQL, no eval on user input. The main concern is the AI description feature and how keys would be managed. Performance is adequate: ~343 NPCs/second in Monte Carlo, ~2 minutes for the full regression suite.

### Overall

The project is in good shape for a simulation-heavy NPC generator. The core engine is strong; the main flaws were determinism and one class-name mismatch. Those are fixed. Remaining work: guard rare template outputs, secure the AI description path, and tidy documentation and dead code.

---

## 8. CLAUDE FIX PROMPT

**COPY-AND-PASTE THIS INTO CLAUDE**

```
You are a world-class senior software engineer. A ruthless audit has been performed on the Kaldor NPC Aging Engine (NPC_Project). Your job is to fix EVERY issue from the audit. You do not have access to git — apply ALL fixes yourself, including those the auditor may have already attempted elsewhere.

---

**CRITICAL FIXES**

1. **Pagaelin OCEAN determinism (aging-engine.js)**  
   Find the block where `isPagaelin` OCEAN scores are computed (around line 2230). It uses `Math.random()`. Replace with the project RNG:
   - Ensure `rand` is imported from `./rng` at the top (it likely already is).
   - Change: `Math.floor(Math.random() * 31) - 15`  
     To: `Math.floor(rand() * 31) - 15`  
   This ensures Pagaelin NPCs are deterministic for the same seed.

2. **Constraint-injector child sex (constraint-injector.js)**  
   The injector uses `Math.random()` for child sex when injecting missing children.
   - Add at top: `const { rand } = require('./rng');`
   - Find both occurrences of `Math.random() < 0.5 ? 'male' : 'female'` (around lines 400 and 483).
   - Replace with: `rand() < 0.5 ? 'male' : 'female'`

3. **craftsperson → artisan (generate-from-description.js)**  
   The engine expects `artisan`, not `craftsperson`. Before building `baseParams`:
   - Add: `const socialClass = (constraints.socialClass === 'craftsperson') ? 'artisan' : (constraints.socialClass ?? 'artisan');`
   - Use `socialClass` (not `constraints.socialClass`) in `baseParams`.

---

**OTHER FIXES**

4. **Typo (test-regression.js)**  
   Find "all sexs/classes" and change to "all sexes/classes".

5. **physical-description.js API**  
   Add safe API key handling for `generatePhysicalDescription`: read from env (e.g. `process.env.ANTHROPIC_API_KEY`), do not hardcode. If key missing, throw a clear error or return a no-op. Never log or emit the key.

6. **npc.name handling**  
   In md-writer and physical-description: `npc.name` may be `{ full, given, surname }` or a string. Use `typeof npc.name === 'string' ? npc.name : (npc.name?.full ?? '')` (or similar) wherever name is used as a string.

7. **Dead code (constraint-injector.js)**  
   Remove the unused line: `const condSet = new Set(result.attributes ? [] : []);` (or use it properly).

8. **README.md**  
   Update "158 tests" to "171 tests".

9. **craftsperson in aging-engine (optional)**  
   Either add `craftsperson` to `CLASS_CULTURE_MAP` and `CLASS_PHASE_CONFIGS` mapping to artisan config, or document that it is normalised in `generate-from-description` and should not be passed to `ageCharacter` directly.

10. **Template guards**  
    In `buildNarrative` (aging-engine.js) and any md-writer output paths: ensure `.flavour`, `.eventLabel`, `.relationalNote`, `.label` never emit `undefined`/`null`/`NaN`. Add fallbacks like `|| ''` or skip the line when falsy.

11. **findLast (constraint-injector.js)**  
    Replace `findLast` with a polyfill if targeting older Node:  
    `(history.findLast && history.findLast(e => e.eventId === adderEvent)) || [...history].reverse().find(e => e.eventId === adderEvent)`

12. **Test comment mismatch**  
    In test-regression.js Suite 6, fix the comment "22 unguilded archetypes" to "85" to match the assertion, or correct the assertion if 22 is the intended value.

13. **physical-description.js RNG**  
    Add a brief comment explaining that the module uses xorshift32 (salted) so physical appearance is deterministic from the NPC seed without consuming engine RNG state.

---

Preserve all existing behaviour that works. Do not break the 171 regression tests or the 10 edge-case tests. Explain every change you make.
```

---

*Report complete. — Ruthless Rex*
