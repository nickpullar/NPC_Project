# Literary Evaluation — NPC Profile Generator

**Evaluator:** Professor Eleanor Hawthorne  
**Title:** Distinguished Professor of English Literature and Narrative Craft, Oxford  
**Date:** 2026-03-18  
**Methodology:** Monte Carlo simulation (N=10,000); stratified sample of 500+ narratives; qualitative deep review of 50 representative profiles  
**Reference standard:** Encyclopædia Britannica (formal, authoritative, concise, objective, stylistically flawless)

---

## 1. SIMULATION EXECUTION

The Monte Carlo script (`monte-carlo-literary.js`) was executed, generating exactly 10,000 NPC profiles using `generateFullNPC()` with full randomisation across:

- **Social classes:** noble, merchant, warrior, soldier, peasant, artisan, unguilded, clergy, lia_kavair, guilded_innkeeper  
- **Sex:** male, female (alternating)  
- **Age:** 18–75 (varied by iteration)  
- **Seed:** 0 to 9,999 (deterministic per run)

Outputs were stored in `literary-corpus/`:
- `analysis-sample-500.json` — narratives for quantitative analysis  
- `deep-review-50.json` — 50 full profiles with markdown  
- `sample-profiles/` — 50 `.md` files for close reading

**Execution time:** ~28 seconds. Zero crashes.

---

## 2. LITERARY EVALUATION

### 2.1 Narrative Coherence

**Strengths:** The underlying simulation is structurally sound. Events proceed chronologically; conditions align with history; family trees are internally consistent. The *content* of lives is plausible.

**Contradictions and errors:**

1. **Pronoun–referent mismatch (critical)**  
   When a child dies (age 12–17), the flavour text reads:  
   > *"Talith Corsen was nearly grown when **he** died. Talith Corsen died (age 13)"*  
   Talith is female. The pronoun is wrong. Observed in profile-45 (Garan Corsen), profile-31 (Durst Falendi), and in the corpus search.  
   **Source:** `aging-engine.js`, `childDiesFlavour()` line 2693 and a near-identical block at lines 4878–4880 (family flavour for child death). Both use "he" for the child regardless of sex. Fix: use `child.sex` / `deadChild.sex` to choose "he" or "she".

2. **Repeated lengthy passages within a single profile**  
   Corin Halman (profile-25, unguilded male, age 42) contains the death-of-parent flavour twice (ages 23 and 31):  
   > *"She was ill for three weeks before she died. He had not understood until the second week what the illness was going to become. He had time to understand afterward — the empty space in the work, the meals, the bed — and he understands it still. He is doing what people do. He is continuing."*  
   The first occurrence refers to his wife (Caris Cooper); the second to his mother. The same 60-word passage is reused. A reader cannot distinguish whose death is described without external context. This is a failure of differentiation.

3. **Generic "quiet years" placeholder**  
   The formula `*(Ages X–Y: quiet years)*` appears whenever multiple uneventful years are collapsed. It is serviceable but entirely repetitive. No variation (e.g. "uneventful seasons," "years of routine," "a stretch of ordinary life") is offered.

### 2.2 Well-Formed Text

**Grammar and syntax:** Generally correct. Sentences are complete; subordination is used appropriately in the longer passages.

**Sentence variety:** Poor. Every narrative line follows the pattern:

```
**Age X (YYYY TR)** — [flavour text].
```

The rhythm never varies. Encyclopædia entries shift between declarative, explanatory, and narrative modes. Here, every year is a single sentence with the same template. Predictability is extreme.

**Punctuation:** Correct use of em dashes, commas, and full stops. No systematic errors noted.

### 2.3 Absence of Stock Phrases and Repetition

**Severe failures:**

1. **The hundred moot passage**  
   A 100-word paragraph appears verbatim whenever that event fires:  
   > *"The hundred moot is held monthly and most months he has no business there. This month he does — a minor dispute about a field boundary that has been running since before he inherited the holding. He has the documentation. The other party also has documentation. The moot will look at both sets of documentation and reach a finding. He is not certain the finding will favour him. He has prepared an appeal to the shire assize on the assumption it won't, which is not pessimism but preparation. The moot is a public proceeding and everyone in the room knows everyone else and their business. This is simultaneously the moot's strength and its limitation."*  
   Observed in Horic Corsen (seed 4), Harlan Valkin (seed 34), and others. Identical in every profile. This is the opposite of encyclopedic prose; it is a fixed set piece.

2. **Extended Family Chronicle**  
   Templates such as:  
   - "A poor harvest year — the family went hungry"  
   - "Exceptional harvest — the best in years; modest surplus"  
   - "Patriarch died — the family reorganised around the eldest son"  
   appear dozens of times across profiles with no lexical variation.

3. **Personality descriptions**  
   Every personality string begins with "Character is":  
   - "Character is self-assured and enthusiastic"  
   - "Character is very boring"  
   - "Character is disciplined and reserved"  
   The "Character is" formula is unvarying. "Character is very boring" is not a personality trait; it is a fallback when no traits qualify, and it reads as dismissive.

### 2.4 Subtle Quirks and Micro-Repetitions

1. **Faint AI-generation echoes**  
   Some passages have a reflective, interior-monologue quality:  
   > *"He thought about it afterward: the specific way the crowd becomes a legal instrument..."*  
   > *"She has thought about the incident since mostly in terms of what the mistress actually communicated..."*  
   The diction ("the specific way," "mostly in terms of") suggests a modern, analytical voice rather than medieval Kaldorian idiom.

2. **Overuse of "He/She" openings**  
   A high proportion of sentences begin with the subject pronoun. The prose does not use inversion, participial phrases, or other devices to vary opening structure.

3. **RelationalNote vs. flavour**  
   Some lines append metadata:  
   > *"Married Caris Cooper (artisan, age 16)"*  
   > *"week 40 Alura Halman born (female)"*  
   These are functional but break the narrative flow. The blend of story and record is uneven.

4. **Mara Moring, ~Age -4**  
   In one extended family table, a cousin appears with "~Age -4" — an impossible value. This is a data-generation bug, not a prose one, but it undermines reader trust.

### 2.5 Verdict Against the Reference Standard

**Does this read like a polished Encyclopædia Britannica entry?**  

No. Britannica entries are concise, varied in structure, and avoid repetition. They establish context, then deliver facts in measured prose. The NPC profiles are chronologically ordered life summaries built from fixed templates. The best passages (e.g. death of a parent, the mistress and the cloth) approach literary quality. The worst are mechanical, repetitive, and occasionally erroneous (pronoun mismatch, "Character is very boring"). The aggregate is competent but not encyclopedic.

---

## 3. CONCRETE IMPROVEMENT ACTIONS

### 3.1 Pronoun Fix (Critical)

**File:** `aging-engine.js`  
**Location:** `childDiesFlavour()` and any similar helpers  
**Change:** Pass the child's sex. Use "when he died" or "when she died" based on `child.sex`, not the principal's sex.

```javascript
// Current (wrong when child is female):
: `${name} was nearly grown when he died.`;

// Corrected:
: `${name} was nearly grown when ${(child.sex === 'female') ? 'she' : 'he'} died.`;
```

Apply the same logic wherever child/grandchild pronouns appear.

### 3.2 Personality Fallback

**File:** `npc-generator.js`  
**Location:** `generatePersonality()`, line 497  
**Change:** Replace `'Character is very boring'` with a neutral fallback, e.g. "Character exhibits no strongly dominant traits" or "Character's temperament is unremarkable." Never use "boring" in reference to a person in formal text.

### 3.3 Vocabulary and Phrase Variants

**File:** `life-events.js`  
**Approach:** For events that fire frequently (hundred_moot, coroners_jury, recovery_regimen, serious_illness, death_of_parent, spouse_dies), add 2–4 phrase variants per flavour. At runtime, select one via `rand()`. Example:

```javascript
flavour: {
  male: [
    'The hundred moot is held monthly and most months he has no business there. This month he does...',
    'A boundary dispute that had simmered for years reached the hundred moot. He had the charters. So did the other party...',
  ],
  female: [ /* ... */ ],
},
```

Then in `buildNarrative` or the resolver, pick `flavour.male[rand() * flavour.male.length | 0]` (or equivalent).

### 3.4 Extended Family Chronicle Variants

**File:** `extended-family.js` (or wherever chronicle labels are defined)  
**Change:** Define synonym sets for common outcomes (poor harvest, exceptional harvest, patriarch died, etc.). At render time, choose randomly from the set so the same event is not always worded identically.

### 3.5 "Quiet Years" Variation

**File:** `aging-engine.js`, `buildNarrative()`  
**Change:** Replace the single `*(Ages X–Y: quiet years)*` with a small array of alternatives, e.g.:  
- "*(Ages X–Y: uneventful years)*"  
- "*(Ages X–Y: years of routine)*"  
- "*(Ages X–Y: no notable events)*"  

Select via RNG to reduce repetition.

### 3.6 Personality Phrase Structure

**File:** `npc-generator.js`, `generatePersonality()`  
**Change:** Vary the opening. Instead of always "Character is X," use:  
- "X by temperament"  
- "Displays X tendencies"  
- "Marked by X"  
Choose structure randomly to avoid the "Character is" echo.

### 3.7 Duplicate-Event Flavour Guard

**File:** `aging-engine.js` or event-resolution layer  
**Change:** When the same flavour string would appear twice in one narrative (e.g. death_of_parent and spouse_dies sharing text), either:  
- Use a shorter, differentiated variant for the second occurrence, or  
- Introduce a "condensed" form for repeated semantic events (e.g. "Another loss. He continued.").

### 3.8 Cousin Age Validation

**File:** `extended-family.js` or equivalent  
**Change:** Ensure cousin ages are never negative. Clamp or recalculate from birth year and game year. Fix the "~Age -4" bug.

---

## 4. PLAIN-LANGUAGE SUMMARY FOR THE AUTHOR

### What’s Working

The simulator produces coherent life histories. Events fit together; family ties and conditions match the story. Many flavour passages are well written — for example, the death of a parent, the mistress and the cloth, the hundred moot passage (on first encounter), and the knight and the shortsword. Grammar is generally correct. The system is stable and does not crash.

### What’s Wrong

**Pronoun mistake:** When a daughter dies, the text sometimes says "when he died" instead of "when she died." This is a clear bug in the child-death flavour.

**Too much repetition:** The same long passage (e.g. the hundred moot, death of a parent) can appear multiple times in one life or across many lives with no change in wording. After several profiles, it feels copied and pasted.

**"Character is very boring":** When no personality traits qualify, the generator returns "Character is very boring." That reads as rude and unprofessional. It should be rephrased.

**Predictable structure:** Every line in the life story uses the same pattern: "Age X — sentence." There is no variation in layout or rhythm.

**"Character is" everywhere:** Every personality line starts with "Character is." A little variation would reduce the mechanical feel.

**Extended Family Chronicle:** Descriptions like "A poor harvest year — the family went hungry" are repeated hundreds of times with no alternative wording.

### What You Should Do

1. Fix the pronoun bug so "he/she" matches the child’s sex.  
2. Replace "Character is very boring" with a neutral phrase.  
3. Add 2–4 alternate phrasings for the most common events (harvests, deaths, moots, etc.) and pick one at random.  
4. Vary the "quiet years" line and the opening of personality descriptions.  
5. Fix the cousin age bug (negative ages).  
6. For events that share the same long flavour (e.g. different deaths), use shorter or different text so the same paragraph does not repeat.

---

## 5. CLAUDE FIX PROMPT

**COPY-AND-PASTE THIS INTO CLAUDE**

```
You are a world-class senior software engineer and literary stylist. Professor Eleanor Hawthorne has completed a literary evaluation of the Kaldor NPC Aging Engine. Your task is to implement every concrete improvement identified in that evaluation so that future NPC profiles read like genuine Encyclopædia Britannica entries.

**CONTEXT:** The project generates NPC life histories for a HârnWorld RPG. Output is assembled from flavour text in life-events.js, helpers in aging-engine.js, and personality generation in npc-generator.js. A Monte Carlo run of 10,000 profiles revealed pronoun errors, repetition, and formulaic phrasing.

**REQUIRED CHANGES:**

1. **PRONOUN FIX (aging-engine.js)**
   - In `childDiesFlavour()` (line ~2693): `${name} was nearly grown when he died` is wrong when the child is female. Use `when ${(child.sex === 'female') ? 'she' : 'he'} died`.
   - In the family flavour block for child death (lines ~4878–4880): same fix using `deadChild.sex`.
   - Audit grandchildDiesFlavour and any similar helpers for pronoun/child-sex mismatches.

2. **PERSONALITY FALLBACK (npc-generator.js, generatePersonality, ~line 497)**
   - Replace `'Character is very boring'` with a neutral fallback such as "Character exhibits no strongly dominant traits" or "Character's temperament is unremarkable."

3. **PERSONALITY PHRASE VARIATION (npc-generator.js, generatePersonality)**
   - Vary the opening instead of always "Character is X". Add alternatives: "X by temperament", "Displays X tendencies", "Marked by X". Select randomly.

4. **FLAVOUR VARIANT SYSTEM (life-events.js + aging-engine.js)**
   - For high-frequency events (hundred_moot, death_of_parent, serious_illness, recovery_regimen, spouse_dies, etc.), add 2–4 alternate phrasings per flavour.
   - Modify the code that selects flavour text to choose randomly from an array when the flavour is an array, otherwise use the string as before.
   - Ensure the project RNG (rand from rng.js) is used so results remain deterministic for a given seed.

5. **QUIET YEARS VARIATION (aging-engine.js, buildNarrative)**
   - Replace the single "(Ages X–Y: quiet years)" with 3–4 variants: "uneventful years", "years of routine", "no notable events". Select via rand().

6. **EXTENDED FAMILY CHRONICLE VARIATION (extended-family.js or equivalent)**
   - For chronicle labels (poor harvest, exceptional harvest, patriarch died, child died, etc.), define synonym sets and select at random.

7. **DUPLICATE FLAVOUR GUARD (aging-engine.js)**
   - When building the narrative, if the same long flavour string appears twice in one profile, use a condensed variant for the second occurrence (e.g. "Another loss. He continued." for a second death-of-close-relative).

8. **COUSIN AGE BUG (extended-family.js)**
   - Ensure cousin ages are never negative. Fix the calculation that produced "~Age -4".

**CONSTRAINTS:**
- Use the project's seeded RNG (rand from rng.js) for all randomness. Do not use Math.random().
- Preserve existing behaviour except where explicitly changed.
- Do not break the 171 regression tests or the 10 edge-case tests.
- After implementing, output the complete corrected code for every file you modified, and explain each change and how it improves narrative coherence, well-formed text, and originality.
```

---

*Evaluation complete. — Professor Eleanor Hawthorne*
