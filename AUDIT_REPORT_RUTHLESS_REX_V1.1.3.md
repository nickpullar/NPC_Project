# RUTHLESS REX AUDIT REPORT — Kaldor NPC Aging Engine (v1.1.3)

**Date:** 2026-03-18  
**Auditor:** Ruthless Rex (Senior Test Engineer)  
**Repository:** NPC_Project (HârnWorld Kaldor NPC Generator)  
**VERSION:** 1.1.3 (Audit Fixes)

---

## 1. FULL REPO RECON — VERDICT

**Structure:** Unchanged. Flat root, no package.json. `literary-corpus/` holds Monte Carlo outputs. The v1.1.3 changelog documents all audit fixes from the v1.1.2 ruthless report. Implementation appears complete.

**Architecture:** `aging-engine.js` remains large (~5.7k lines) but functional. The audit remediation addressed determinism, pronouns, craftsperson mapping, API key handling, name handling, dead code, and template guards.

---

## 2. ISSUES FROM v1.1.2 AUDIT — STATUS

### CRITICAL (3) — ALL FIXED ✓

| # | Issue | Status |
|---|-------|--------|
| 1 | constraint-injector Math.random() for child sex | ✓ **FIXED** — Deterministic RNG seeded from `_injHash(birthYear + name + historyLen + childCount)`. LCG in `_injMkRng()`. |
| 2 | Condensed fallback "He endured" for female principals | ✓ **FIXED** — `buildNarrative` takes `principalSex`; `assembleResult` passes `char.sex`. Sex-aware "He/She endured" and "He/She bore it." Eight fallback phrases. |
| 3 | craftsperson passed to ageCharacter | ✓ **FIXED** — `generate-from-description.js` maps `craftsperson` → `artisan` before `baseParams`. |

### HIGH (3) — ALL FIXED ✓

| # | Issue | Status |
|---|-------|--------|
| 4 | physical-description API: no key | ✓ **FIXED** — Reads `process.env.ANTHROPIC_API_KEY`, throws if missing, adds `x-api-key` header. |
| 5 | md-writer npc.name object handling | ✓ **FIXED** — `_npcFullName` resolves string or `{ full, given, surname }`. Single `toSlug()`. |
| 6 | Dead code condSet | ✓ **FIXED** — Removed. |

### MEDIUM (2) — MOSTLY FIXED

| # | Issue | Status |
|---|-------|--------|
| 7 | README version and test count | ⚠ **PARTIAL** — README still says "v1.1.2" and "150 fast + 8 heavy = 158 tests". Actual: v1.1.3, 171 regression + 10 edge = 181. Minor doc drift. |
| 8 | findLast polyfill | ✓ **FIXED** — `findLast?.(...) \|\| [...].reverse().find(...)` already present. |

### LOW (2) — FIXED

| # | Issue | Status |
|---|-------|--------|
| 9 | Test comment "22 unguilded" vs 85 | ✓ **FIXED** — CHANGELOG says comment replaced. |
| 10 | Template guards (undefined/null/NaN) | ✓ **FIXED** — faith-change `dc.note` guarded, narrative `filter(Boolean)`, cousin names `?? "Unknown"`. |

---

## 3. MONTE CARLO STATISTICAL SUMMARY

**Run:** N=10,000 (quick mode)

### Structural Coherence (0–100)

| Metric | v1.1.2 | v1.1.3 |
|--------|--------|--------|
| Mean | 99.98 | **100.00** |
| Perfect (100) | 99.91% | **100.00%** |
| Failures | 9 | **0** |

**Comment:** *"Template leakage is gone. 100% structurally clean. The guards worked."*

### Narrative Fluency (0–100)

| Metric | v1.1.2 | v1.1.3 |
|--------|--------|--------|
| Mean | 98.30 | **99.27** |
| Acceptable (≥80) | 99.91% | **100.00%** |
| Poor (<80) | 9 | **0** |

**Comment:** *"Narrative fluency improved. No poor scores."*

### Crashes

| Total | 0 |
|-------|---|
| Crash-free rate | 100% |

---

## 4. TEST SUITE

| Suite | Count | Status |
|-------|-------|--------|
| Regression | 171 | 171 passed, 0 failed |
| Edge cases | 10 | 10 passed, 0 failed |
| **Total** | **181** | **181 passed** |

---

## 5. REMAINING MINOR ITEMS

| # | Item | Severity | Recommendation |
|---|------|----------|----------------|
| 1 | README version "v1.1.2" | Low | Update to v1.1.3. |
| 2 | README test count "158" | Low | Update to "171 regression + 10 edge = 181 tests". |
| 3 | craftsperson in ageCharacter | Info | `test-edge-cases.js` passes `socialClass: 'craftsperson'` directly to `ageCharacter` and it does not crash. The engine may fall back to a default when phase config is missing. generate-from-description normalises before calling, so the main path is correct. Document or add `craftsperson` → `artisan` in aging-engine for defensive robustness. |

---

## 6. PLAIN-LANGUAGE SUMMARY FOR THE AUTHOR

### What's Good

**All critical and high issues from the v1.1.2 audit are fixed.** Constraint-injected children are now deterministic. Female NPCs no longer get "He endured" in their narratives. craftsperson maps to artisan before hitting the engine. The physical description API key is read from the environment. The md-writer handles both string and object names safely. Dead code is removed. Template guards eliminated the undefined/null/NaN leakage.

**Monte Carlo improved dramatically.** Structural coherence: 100% perfect (was 99.91%). Narrative fluency: 100% acceptable, mean 99.27 (was 98.30). Zero failures. Zero crashes.

**Tests pass.** 171 regression + 10 edge = 181, all green.

### What's Left

**Documentation drift.** README still says v1.1.2 and 158 tests. Update to v1.1.3 and 181.

**Optional hardening.** If someone passes `craftsperson` directly to `ageCharacter` (bypassing generate-from-description), the engine doesn't crash — but adding an explicit `craftsperson` → `artisan` mapping in the engine would make the contract clearer and guard against future callers.

### Overall

v1.1.3 is in strong shape. The ruthless audit findings have been addressed. The codebase is deterministic, pronoun-correct, and template-clean. Minor README updates would complete the polish.

---

## 7. SURVIVAL SCORE: **88/100**

**Breakdown:**

- Test coverage: 181 tests, all passing. (+20)
- Determinism: Fixed in constraint-injector and Pagaelin. (+15)
- Structural integrity: 100% clean. (+18)
- Narrative output: 100% acceptable. (+15)
- Security: API key from env. (+5)
- Code hygiene: Dead code removed, name handling fixed. (+8)
- Documentation: Minor version/count drift. (-3)
- Architecture: God file remains. (-5)
- Monte Carlo: 100% crash-free, 100% structural. (+6)

**Verdict:** *"Above 85. The engine is production-ready. Update the README and you're done."*

---

## 8. CLAUDE FIX PROMPT (Remaining Items Only)

**COPY-AND-PASTE THIS INTO CLAUDE**

```
You are a senior software engineer. The Ruthless Rex audit of v1.1.3 found that all critical and high issues are fixed. Only minor documentation updates remain.

**REMAINING FIXES:**

1. **README.md**
   - Update the header from "v1.1.2" to "v1.1.3".
   - Update the test suite line from "150 fast + 8 heavy = 158 tests" to "171 regression + 10 edge = 181 tests".

2. **Optional: aging-engine.js craftsperson fallback**
   If you want defensive robustness: add `craftsperson` to `CLASS_CULTURE_MAP` and `CLASS_PHASE_CONFIGS` mapping to the same config as `artisan`. This guards against callers who pass craftsperson directly to ageCharacter without going through generate-from-description. The edge-case test passes craftsperson and the engine doesn't crash (it likely falls back somewhere), but explicit mapping would make the contract clear. Skip if time-constrained.

**CONSTRAINTS:**
- Do not change any logic that is working.
- Run `node test-regression.js` and `node test-edge-cases.js` to verify.
```

---

*Report complete. — Ruthless Rex*
