# RUTHLESS REX AUDIT REPORT — Kaldor NPC Aging Engine (v1.1.2)

**Date:** 2026-03-18  
**Auditor:** Ruthless Rex (Senior Test Engineer)  
**Repository:** NPC_Project (HârnWorld Kaldor NPC Generator)  
**VERSION:** 1.1.2 (post–Literary Quality Pass)

---

## 1. FULL REPO RECON — VERDICT

**Structure:** Unchanged from v1.1.0. Flat root, no package.json, no build. `literary-corpus/` now holds Monte Carlo outputs. README still claims v1.0.0 and "158 tests" — stale. Actual test count: 171 regression + 10 edge-case. Documentation drift is a recurring theme. Someone keeps forgetting to update the README.

**Architecture:** `aging-engine.js` remains a 5.7k-line god file. The literary pass (v1.1.2) added flavour variants, quiet-years rotation, condensed fallbacks, and extended-family label arrays. It also introduced a **new pronoun bug** in condensed fallbacks and left **regressions unfixed** from the prior audit.

---

## 2. RANKED ISSUE LIST (Critical → Low)

### CRITICAL

| # | File:Line | Issue | Savage One-Liner |
|---|-----------|-------|------------------|
| 1 | `constraint-injector.js:400, 483` | Child sex uses `Math.random()` instead of project RNG | *"The previous audit said this was FIXED. It wasn't. Same seed, different injected children. Your reproducibility is a lie."* |
| 2 | `aging-engine.js:5308` | Condensed fallback "He endured" used for female principals | *"Female soldier Aldis Lorsen gets 'He endured' nine times in her life story. The literary pass fixed child-death pronouns and then broke condensed fallbacks. Inconsistent incompetence."* |
| 3 | `generate-from-description.js:370` | Passes `craftsperson` to ageCharacter; engine has no craftsperson | *"The engine comment says 'craftsperson is normalised in generate-from-description'. It isn't. `CLASS_PHASE_CONFIGS['craftsperson']` is undefined. Constraint-based innkeepers and blacksmiths get undefined phase configs and undefined behaviour."* |

### HIGH

| # | File:Line | Issue | Savage One-Liner |
|---|-----------|-------|------------------|
| 4 | `physical-description.js:397-406` | Anthropic API call has no `x-api-key` header | *"This will 401 every single time. No key, no auth, no handling. Security theatre."* |
| 5 | `md-writer.js:99, 101` | `npc.name` may be `{ full, given, surname }`; toSlug and name emit `[object Object]` | *"Pass the full NPC from ageCharacter — which has `name: { full, given, surname }` — and your frontmatter id becomes `object-object` and your name becomes literal `[object Object]`. Defensive coding? Never heard of it."* |
| 6 | `constraint-injector.js:207` | `const condSet = new Set(result.attributes ? [] : []);` — dead, unused | *"Still there. Still unused. The audit said delete it. Nobody listened."* |

### MEDIUM

| # | File:Line | Issue | Savage One-Liner |
|---|-----------|-------|------------------|
| 7 | `README.md` | States "v1.0.0", "158 tests" — actual: v1.1.2, 171+10 | *"Documentation rot. Two numbers and a version. Update them."* |
| 8 | `aging-engine.js:5305-5312` | Condensed fallbacks: only 3 phrases, overused (10+ per profile) | *"The duplicate guard works, but 'Another difficult year. Life continued.' and 'He endured...' appear 10+ times in eventful lives. You traded verbatim repetition for stock-phrase monotony."* |
| 9 | `constraint-injector.js:560` | `findLast?.(...)` — ES2023; fails on Node &lt;18 | *"Optional chaining on a method that doesn't exist on older Node. Polyfill or use reverse+find."* |

### LOW

| # | File:Line | Issue | Savage One-Liner |
|---|-----------|-------|------------------|
| 10 | `test-regression.js` | Comment "22 unguilded archetypes" vs assertion expecting 85 | *"Comment and assertion disagree. One of them is wrong. Fix it."* |
| 11 | `physical-description.js` | Uses xorshift32; engine uses mulberry32 | *"Two PRNGs. Works, but document why."* |
| 12 | Monte Carlo | 9/10,000 profiles emit "undefined"/"null"/"NaN" in markdown | *"Template leakage. Rare but real. Guard your flavours."* |

---

## 3. MONTE CARLO STATISTICAL SUMMARY

**Run:** N=10,000 (quick mode)

### Structural Coherence (0–100)

| Metric | Value |
|--------|-------|
| Mean | 99.98 |
| Median | 100.00 |
| Perfect (100) | 99.91% |
| Failures | 9 (0.09%) |
| Top violation | markdown contains undefined/null/NaN |

### Narrative Fluency (0–100)

| Metric | Value |
|--------|-------|
| Mean | 98.30 |
| Acceptable (≥80) | 99.91% |
| Poor (&lt;80) | 9 (0.09%) |

### Crashes

| Total | 0 |
|-------|---|
| Crash-free rate | 100% |

**Comment:** *"Structure and fluency are solid. The nine failures are template leakage — same root cause as before. The condensed fallback pronoun bug and Math.random() in constraint-injector are not caught by Monte Carlo; they require code review."*

---

## 4. PLAIN-LANGUAGE SUMMARY FOR THE AUTHOR

### What’s Actually Good

The core engine is solid. Pagaelin OCEAN uses `rand()` — determinism there is fixed. The literary pass improved child-death pronouns, personality fallbacks, and duplicate-flavour guarding. Monte Carlo shows 100% crash-free, 99.91% structurally clean. The 753 events and 315 archetypes remain well-structured.

### What’s Broken (and Was Supposed to Be Fixed)

**Constraint-injector still uses Math.random().** The previous audit said this was fixed. It wasn’t. Lines 400 and 483 still flip a coin with `Math.random()` when choosing injected children’s sex. Same seed produces different children in constraint-based generation. Reproducibility is broken.

**craftsperson is not normalised.** The engine comment says craftsperson is mapped to artisan in generate-from-description. It isn’t. The constraint extractor returns "craftsperson" for innkeepers, blacksmiths, etc. That gets passed to ageCharacter. The engine has no `craftsperson` in CLASS_PHASE_CONFIGS or CLASS_CULTURE_MAP. Result: undefined configs, potential crashes, weird behaviour.

**Female NPCs get "He endured" in their narratives.** The condensed fallback for duplicate long flavours includes "He endured. The details were different; the shape was the same." It’s used for everyone. Female soldiers, merchants, and clergy get "He" in their life stories. Same class of bug as the old child-death pronoun — and it was introduced by the literary pass that fixed the child-death pronoun.

### What’s Still Problematic

**Physical description API.** Still no API key. Still will 401.

**npc.name handling.** The md-writer assumes `npc.name` is a string. The engine outputs `name: { full, given, surname }`. When that hits `toSlug(npc.name)` or `npc.name || 'Unknown'`, you get `[object Object]` in the output.

**Dead code.** `condSet` in constraint-injector is still there, still unused.

**Documentation.** README says 158 tests and v1.0.0. Reality: 181 tests, v1.1.2.

**Condensed fallback overuse.** In busy lives, "Another difficult year. Life continued." and "He endured..." appear 10+ times each. The fix for repetition created a new kind of repetition.

### Overall

The project is in worse shape than the previous audit suggested. Several "fixed" items were never fixed. The literary pass fixed one pronoun bug and introduced another. Fix the criticals first: Math.random(), craftsperson normalisation, and condensed fallback pronouns. Then clean up the rest.

---

## 5. CLAUDE FIX PROMPT

**COPY-AND-PASTE THIS INTO CLAUDE**

```
You are a world-class senior software engineer. A ruthless audit has been performed on the Kaldor NPC Aging Engine v1.1.2. Your job is to fix EVERY issue from the audit. Be thorough. Do not assume any prior fixes were applied — verify and fix.

---

**CRITICAL FIXES**

1. **Constraint-injector child sex (constraint-injector.js)**
   Lines 400 and 483 use `Math.random() < 0.5 ? 'male' : 'female'` for injected children.
   - The injector is called as `injectConstraints(result, constraints)` from generate-from-description. Neither baseParams nor ageCharacter currently receive a seed in the constraint flow, so reproducibility is already compromised for the full flow. Fix the injector first.
   - Add a deterministic local RNG: (a) Create a simple hash function, e.g. `function hash(s){ let h=2166136261; for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619)>>>0; } return h; }`; (b) Seed it from the result: `const injSeed = hash(String(result.birthYear ?? 0) + '_' + (typeof result.name === 'object' ? result.name?.full : result.name) + '_' + (result.history?.length ?? 0) + '_' + (result.children?.length ?? 0)) >>> 0`; (c) Use an LCG like extended-family.js: `function mkRng(seed){ let s=seed>>>0; return ()=>{ s=Math.imul(s,1664525)+1013904223>>>0; return s/0x100000000; }; }`; (d) Call it `const rng = mkRng(injSeed);` at the start of injectConstraints, and pass/use it for both child sex rolls. For each injection, advance the RNG (each `rng() < 0.5` consumes one draw). Same result → same injSeed → same child sexes.
   - Replace both `Math.random() < 0.5` with `rng() < 0.5`.

2. **Condensed fallback pronoun (aging-engine.js)**
   In `buildNarrative()` (around lines 5258–5314), the CONDENSED_FALLBACKS array includes "He endured. The details were different; the shape was the same." This is used for both male and female principals.
   - Add a fourth parameter `principalSex` to `buildNarrative(history, classChanges, deityChanges, principalSex)`.
   - At the call site in `assembleResult()` (around line 5062), pass `char.sex`: `buildNarrative(history, classChanges, deityChanges, char.sex)`.
   - Replace the single "He endured" string with sex-aware selection: when `principalSex === 'female'`, use "She endured. The details were different; the shape was the same." Otherwise "He endured...".
   - Add 3–5 additional condensed fallback phrases (gender-neutral or sex-aware) to reduce overuse. Examples: "The year passed without notable change.", "Routine persisted.", "Another season of ordinary life."
   - Ensure principalSex defaults to 'male' if undefined for backward compatibility.

3. **craftsperson → artisan (generate-from-description.js)**
   The engine expects 'artisan', not 'craftsperson'. CLASS_PHASE_CONFIGS has no 'craftsperson'.
   - Before building baseParams, add: `const socialClass = (constraints.socialClass === 'craftsperson') ? 'artisan' : (constraints.socialClass ?? 'craftsperson');` — wait, the default should map too. Use: `const socialClass = ['craftsperson', null, undefined].includes(constraints.socialClass) ? 'artisan' : constraints.socialClass;` — actually simpler: `const socialClass = (constraints.socialClass === 'craftsperson' || !constraints.socialClass) ? 'artisan' : constraints.socialClass;` — and the default when missing is 'craftsperson' in the original, so: `const effectiveClass = constraints.socialClass ?? 'craftsperson'; const socialClass = effectiveClass === 'craftsperson' ? 'artisan' : effectiveClass;`
   - Use `socialClass` (not constraints.socialClass) in baseParams for the socialClass field.

---

**HIGH FIXES**

4. **physical-description.js API**
   Add safe API key handling: read from `process.env.ANTHROPIC_API_KEY` (or similar). If missing, throw a clear error like "ANTHROPIC_API_KEY required for generatePhysicalDescription" or return a fallback that uses the non-API descriptive path. Never hardcode or log the key. Add the key to the request headers: `'x-api-key': process.env.ANTHROPIC_API_KEY` (or whatever the Anthropic API expects).

5. **md-writer.js npc.name**
   `npc.name` may be `{ full, given, surname }` or a string.
   - Add a helper: `const fullName = typeof npc.name === 'string' ? npc.name : (npc.name?.full ?? npc.given && npc.surname ? `${npc.given} ${npc.surname}` : 'Unknown');`
   - Use fullName for: (a) `toSlug(...)` in the id line — change `toSlug(toSlug(npc.name) || 'unknown')` to `toSlug(fullName || 'unknown')` (single toSlug, correct source); (b) the `name: "..."` line — use `fullName` instead of `npc.name`.
   - Audit other uses of npc.name, p.name, s.name, etc. in md-writer. Stubs typically have `name` as a string (child/spouse stubs). The principal may have an object. Focus on renderFrontmatter and any place the principal's name is used.

6. **Dead code (constraint-injector.js)**
   Remove the unused line: `const condSet = new Set(result.attributes ? [] : []);` (line 207). The comment says "unused — use conditions array". Delete it.

---

**MEDIUM FIXES**

7. **README.md**
   Update "158 tests" to "181 tests" (171 regression + 10 edge-case) or whatever the actual count is. Update "v1.0.0" to "v1.1.2" (or read from VERSION file).

8. **findLast (constraint-injector.js)**
   Replace `result.history.findLast?.(e => e.eventId === adderEvent)` with a polyfill: `(result.history.findLast && result.history.findLast(e => e.eventId === adderEvent)) || [...result.history].reverse().find(e => e.eventId === adderEvent)`

---

**LOW / OPTIONAL**

9. **Test comment mismatch**
   In test-regression.js Suite 6, fix the comment "22 unguilded archetypes" to match the assertion (85) or correct the assertion if 22 is intended.

10. **physical-description.js RNG**
    Add a brief comment explaining the module uses a local xorshift32 RNG so physical appearance is deterministic from the NPC seed without consuming the engine's global RNG state.

11. **Template guards**
    In buildNarrative and md-writer output paths, ensure flavour, eventLabel, relationalNote, label never emit undefined/null/NaN. Add fallbacks like `|| ''` or skip the line when falsy. This addresses the 9/10k Monte Carlo failures.

---

**CONSTRAINTS**
- Use the project's seeded RNG (rand from rng.js) for all randomness in code paths that require reproducibility. Do not use Math.random() where determinism matters.
- Preserve existing behaviour except where explicitly changed.
- Run `node test-regression.js` and `node test-edge-cases.js` after implementing. Fix any failures.
**DELIVERABLES**
Output the complete corrected code for every modified file. Explain each change and why it fixes the audit finding.
```

---

*Report complete. — Ruthless Rex*
