# Literary Reanalysis — Post v1.1.2 Fixes

**Evaluator:** Professor Eleanor Hawthorne  
**Date:** 2026-03-18  
**Methodology:** Monte Carlo rerun (N=10,000); comparison against baseline findings in `LITERARY_EVALUATION_PROFESSOR_HAWTHORNE.md`  
**Code version:** v1.1.2 (Literary Quality Pass) — all eight improvement actions implemented

---

## 1. SIMULATION EXECUTION (RE-RUN)

The Monte Carlo script was executed again, generating 10,000 NPC profiles with the same parameters:
- Social classes, sex, age, seed — identical distribution to baseline
- Outputs written to `literary-corpus/` (overwriting previous run):
  - `analysis-sample-500.json` (250 narratives in this build)
  - `deep-review-50.json`
  - `sample-profiles/*.md` (50 profiles)

**Execution time:** 29.2 seconds. Zero crashes.

---

## 2. IMPROVEMENTS CONFIRMED

### 2.1 Pronoun Fix (Child Death) ✓ FIXED

**Baseline:** Female children described as "was nearly grown when **he** died" (e.g. Talith Corsen, Orla Falendi).

**Post-fix sample:**
- Varath Rorman (female child) — *"Varath Rorman was nearly grown when **she** died"* ✓
- Edric Idkin (male child) — *"Edric Idkin was nearly grown when **he** died"* ✓
- Edda Lansen (female child) — *"Edda Lansen was nearly grown when **she** died"* ✓

No pronoun–referent mismatches found in child death passages. The fix is working.

### 2.2 Personality Fallback ✓ FIXED

**Baseline:** "Character is very boring" when no traits qualified.

**Post-fix:** Replaced with *"Character's temperament is unremarkable — no strongly dominant traits."*  
Zero instances of "Character is very boring" in the corpus.

### 2.3 Personality Phrase Variation ✓ FIXED

**Baseline:** Every personality began with "Character is X".

**Post-fix:** Multiple openers observed:
- "Character is practical"
- "Self-assured and enthusiastic by temperament"
- "Marked by disciplined and reserved"
- "Displays duty-bound tendencies"
- "Empathetic, perfectionist and level-headed by temperament"

Distribution across the 50 deep-review profiles shows genuine rotation.

### 2.4 Duplicate Flavour Guard ✓ WORKING

**Baseline:** Same long passage (e.g. death of parent, spouse) could appear twice in one profile.

**Post-fix:** When a long flavour (>60 chars) has already appeared, a condensed stand-in is substituted. Examples:
- *"Another difficult year. Life continued."*
- *"The year passed much as the last had."*
- *"He endured. The details were different; the shape was the same."*

Duplicate long passages no longer appear verbatim in a single profile.

### 2.5 Cousin Age Bug ✓ FIXED

**Baseline:** "Mara Moring, ~Age -4" — negative cousin age.

**Post-fix:** No instances of negative cousin ages (`~Age -` or `Age -\d`) in the corpus.

### 2.6 Extended Family Chronicle Labels ✓ IMPLEMENTED (partial verification)

**Code:** `extended-family.js` defines `labels` arrays with 3 synonymous phrasings per event (fire, famine, patriarch died, etc.).

**Sample:** Chronicle entries in the 50 profiles showed "A poor harvest year — the family went hungry", "Patriarch died — the family reorganised around the eldest son", "Fire destroyed the home — rebuilt over two years". Alternative phrasings ("The workshop burned", "Fire took the roof", "The stores ran short") were not observed in this sample — plausibly due to RNG clustering across a small set of families. The structure is in place; a larger corpus would confirm rotation.

### 2.7 Quiet Years Variation ✓ IMPLEMENTED (limited evidence)

**Code:** `buildNarrative()` selects from four phrases: `quiet years`, `uneventful years`, `years of routine`, `no notable events`.

**Sample:** Only "quiet years" observed in the 50 profiles. Few profiles include quiet-period blocks; the sample may simply not have triggered the other variants. Implementation is correct.

### 2.8 Flavour Variant System ✓ IMPLEMENTED

**Code:** `pickFlavour()` and event-pool variants added to `life-events.js` (16 fields with 3 phrasings each).  
Quantitative verification would require parsing the full 10k corpus for phrase diversity; not performed here. The architecture is present.

---

## 3. GAPS AND NEW ISSUES

### 3.1 Condensed Fallback: Gendered Pronoun (New Bug)

**Finding:** The condensed fallback *"He endured. The details were different; the shape was the same."* appears in **female** profiles.

**Evidence:** Aldis Lorsen (female, soldier, profile-44) — lines 213, 217, 223, 232, 233, 248, 254, 255, 269:
> *"**Age 32 (691 TR)** — He endured. The details were different; the shape was the same."*

Similar instances in:
- Carith Tradesworth (female, merchant)
- Vala Glazier (female, merchant)
- Tarath Korsen (female, soldier)
- Edris Lankin (female, guilded_innkeeper)
- Zara (female, clergy)
- Belyn Yorkin (female, soldier)
- Kelyn Oldcoin (female, merchant)
- Idris Walson (male — correct)
- Loran Belekar (male — correct)

**Cause:** `CONDENSED_FALLBACKS` in `aging-engine.js` line ~5308 includes a fixed "He endured" string. The narrative builder does not vary by principal sex when selecting condensed text.

**Fix:** Either (a) add a sex-aware variant: "She endured" / "He endured", or (b) use a gender-neutral form: "They endured" or "Life continued. The details were different; the shape was the same."

### 3.2 Condensed Fallback: Overuse and Monotony

**Finding:** "Another difficult year. Life continued." and "He endured. The details were different; the shape was the same." appear very frequently — in some profiles 10+ times each.

**Evidence:** Profile-44 (Aldis Lorsen): 10 instances of "Another difficult year" + 9 instances of "He endured" in a single narrative. Profile-49 (lia_kavair male): 13 instances of "Another difficult year."

**Cause:** The duplicate guard triggers whenever *any* long flavour (>60 chars) has appeared before. Eventful lives accumulate many events; multiple event types may share the same or similar long flavour text, or many events exceed 60 chars. Each duplicate is replaced with one of three condensed forms, producing heavy repetition of those three phrases.

**Implication:** The duplicate guard solves verbatim repetition of long passages but introduces a new monotony: the condensed substitutes themselves become stock phrases. Options: (a) expand the condensed fallback set (6–8 variants, including sex-aware forms); (b) consider shortening or paraphrasing source flavours so fewer hit the 60-char threshold; (c) track *semantic* similarity (e.g. "death" vs "death") rather than exact string match to avoid over-triggering.

### 3.3 Extended Family Chronicle: Variant Visibility

**Finding:** In the 50-profile sample, only the first label from each `FAMILY_EVENTS` entry appeared (e.g. "A poor harvest year — the family went hungry", "Fire destroyed the home — rebuilt over two years"). No "The workshop burned", "Fire took the roof", "The stores ran short", etc.

**Possible causes:** (a) Small sample — RNG may favor first index; (b) `pick()` or equivalent may not be invoked correctly for chronicle labels; (c) seed clustering. Recommend spot-check of `extended-family.js` selection logic and a larger sample (e.g. 500+ chronicle blocks) to confirm rotation.

### 3.4 "Marked by" Grammar

**Finding:** Some personality strings read awkwardly: *"Marked by dreamer and self-assured"* — adjectives after "Marked by" can sound odd. *"Marked by disciplined and reserved"* — similar.

**Observation:** "Marked by" works better with noun phrases ("marked by discipline and reserve"). Not a regression; a refinement for a future pass.

### 3.5 Structural Predictability (Unchanged)

**Baseline:** Every narrative line follows `**Age X (YYYY TR)** — [flavour].`

**Post-fix:** No change. The rigid template remains. Encyclopædic prose varies structure; this does not. Deferred as a design decision rather than a quick fix.

---

## 4. SUMMARY TABLE

| Issue | Baseline | Post v1.1.2 |
|-------|----------|-------------|
| Pronoun (child death) | ✗ "he" for female children | ✓ Fixed |
| "Character is very boring" | ✗ Present | ✓ Fixed |
| Personality opening | ✗ Always "Character is" | ✓ Varied |
| Duplicate long flavours | ✗ Repeated verbatim | ✓ Condensed substitute |
| Cousin negative age | ✗ Observed | ✓ None found |
| Quiet years variation | ✗ Single phrase | ✓ Four variants (code) |
| Extended family labels | ✗ Single phrase | ✓ Three per event (code) |
| Flavour variants | ✗ Single phrase | ✓ Array selection (code) |
| Condensed fallback pronoun | — | ✗ "He endured" for females |
| Condensed overuse | — | ✗ 10+ per profile in some |
| Chronicle variant visibility | — | ? Unclear in sample |

---

## 5. PLAIN-LANGUAGE SUMMARY FOR THE AUTHOR

### What Got Better

The pronoun bug for dead children is fixed: daughters now get "she died" and sons "he died."  
"Character is very boring" is gone; you now get a neutral fallback.  
Personality lines vary their openings ("Character is," "by temperament," "Marked by," "Displays ... tendencies").  
When the same long passage would appear twice in one life, it's replaced with a shorter line.  
Negative cousin ages are gone.  
Quiet years and extended-family and flavour text have variation built into the code.

### What Still Needs Work

**New bug:** The condensed substitute "He endured. The details were different; the shape was the same." is used for both men and women. Female NPCs are getting "He" in their life stories — same type of mistake as the old child-death pronoun.

**Overuse:** In busy lives, "Another difficult year. Life continued." and "He endured..." show up many times (10+ in some profiles). The fix for repeating long passages created a new kind of repetition.

**Recommendations:**  
1. Make the condensed fallbacks sex-aware ("She endured" vs "He endured") or use a neutral form.  
2. Add more condensed variants (6–8 options) and/or tweak when the duplicate guard triggers so it doesn’t fire so often.

---

## 6. RECOMMENDED NEXT FIXES

1. **Sex-aware condensed fallbacks** (`aging-engine.js`): Pass principal sex into the narrative builder and select "He endured" / "She endured" (or a neutral alternative) accordingly.
2. **Expand condensed fallbacks**: Add 3–5 new phrases to reduce repetition when the guard triggers frequently.
3. **Verify extended-family label selection**: Confirm `pick(rng, labels)` is called and that seeds produce varied choices across a larger run.

---

*Reanalysis complete. — Professor Eleanor Hawthorne*
