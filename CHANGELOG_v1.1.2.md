# v1.1.2 — Literary Quality Pass (Prof. Hawthorne Evaluation)

All eight items from the literary evaluation implemented.

## 1. Pronoun Fix
`childDiesFlavour()` in aging-engine.js now uses the child's actual sex when
generating "nearly grown when he/she died" — no longer defaults to masculine.
Same fix applied to the inline family flavour block.

## 2. Personality Fallback
"Character is very boring" replaced with "Character's temperament is
unremarkable — no strongly dominant traits."

## 3. Personality Opening Variation
Instead of always "Character is X", four openers rotate randomly:
- "Character is X"
- "X by temperament"  
- "Displays X tendencies"
- "Marked by X"

## 4. Flavour Variant System
**Framework:** `pickFlavour(field)` helper added to aging-engine.js. When a
flavour field is an array it picks one entry via the seeded `rand()`;
when it is a string it returns it unchanged — fully backwards compatible.

**Event-pool variants (16 fields updated in life-events.js):**
`first_child_born` (m/f), `grandchild_born` (m/f), `miscarriage` (m/f),
`married` (m/f), `recovery_regimen` (m/f), `grief_and_introspection` (m/f),
`serious_illness` (m/f), `journey_abroad` (m/f) — each with 3 phrasings.

**Pregnancy-path variants:** Normal live birth and miscarriage flavour text
in `resolvePregnancy()` now selects from 3 variants via `rand()`. These
are computed inline (child name interpolated) so use direct variant arrays
rather than the event's flavour field.

## 5. Quiet Years Variation
"quiet years" rotates through four phrases:
- "quiet years" / "uneventful years" / "years of routine" / "no notable events"
Both mid-narrative and trailing quiet-year lines use the rotation.

## 6. Extended Family Chronicle Variation
Every `FAMILY_EVENTS` entry in extended-family.js now carries a `labels`
array of 3 synonymous phrasings. The chronicle picks one per family unit
event via the unit's seeded RNG. The `fire` event alone now has:
"Fire destroyed the home — rebuilt over two years" /
"The workshop burned — a year's work gone" /
"Fire took the roof; the family slept rough until spring".

## 7. Duplicate Flavour Guard
`buildNarrative()` checks whether a long flavour string (>60 chars) has
already appeared in the narrative. If so, a condensed stand-in is substituted:
"Another difficult year. Life continued." etc. — three variants rotated via
`rand()`. Prevents the same multi-sentence flavour block appearing twice in
one profile.

## 8. Cousin Age Clamp
Cousin and nephew/niece ages in `renderExtendedFamily()` now use
`Math.max(0, gameYear - birthYear)` rather than raw subtraction. Cousins
not yet born (future birth year) show age 0 rather than a negative number.
The calculation also uses `npc.gameYear` if set, rather than hardcoded 720.

## Stats
- Events: 761 (unchanged)
- Archetypes: 321 (unchanged)
- Tests: 150/150 passing
- Files modified: aging-engine.js, npc-generator.js, life-events.js,
  extended-family.js, md-writer.js
