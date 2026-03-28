# v1.1.0 — Changelog

## Fixes

### Auto-name generation
`ageCharacter()` now generates a name automatically when none is supplied.
Names are generated using the existing class-appropriate name tables, seeded
deterministically after the RNG seed is applied — so seeded runs remain fully
reproducible. Callers no longer need to generate and pass a name separately.
`npc.name` (full string), `npc.given`, and `npc.surname` are all present on
the result object.

### Narrative artefact: "First woman acquired"
The Pagaelin wife-acquisition event was appending a bare internal status note
("First woman acquired") to the end of the flavour sentence in the background
narrative. `buildNarrative` now suppresses relational notes that are bare
status markers rather than full narrative sentences.

### Narrative artefact: "undefined Daughter born to a held woman"
Pagaelin child birth events (witnessed family pool entries) had no flavour
text; the narrative was falling through to `undefined`. `buildNarrative` now
uses the relational note as the display text for family events with no flavour,
and guards against null/undefined base flavour throughout.

### CML/comely test assertion
The test checking that CML threshold and `comely`/`striking` conditions agree
was correctly failing in one edge case: an NPC born with CML 14 (comely set at
birth) who then took a -2 CML injury at age 19, ending at CML 12. The engine
behaviour is correct — a scarred person is still beautiful — so the test
assertion now excludes NPCs whose CML was reduced by post-birth injury.

## New content (carried from work-in-progress sessions)

### Retirement system
- `retired` condition registered; set by `stepped_back_from_affairs` (noble/merchant/
  artisan/clergy, requires `prosperous`) and `dower_arrangement` (noble female, widow)
- `sold_the_business` now sets `retired` when fired
- 17 work-facing events suppressed for retired NPCs (`retired: -999` weight)
- 9 leisure events boosted (`wisdom_of_years`, `memoir_or_chronicle`, `pilgrimage` etc.)
- 3 new archetypes: `merchant_retired_patriarch`, `noble_dower_widow`, `artisan_master_retired`

### Pagaelin elder phase re-rolls
`dominant → elder_male` and `held_woman → elder_female` transitions now trigger
archetype re-rolls, making all elder archetypes reachable. Previously only
`warrior → dominant` re-rolled. This also fixes `pagaelin_elder_dominant`,
`pagaelin_former_chieftain`, `pagaelin_elder_woman_respected`, `pagaelin_memory_keeper`
and `pagaelin_protected_matriarch` which were previously unreachable.

### Three new Pagaelin archetypes
- `pagaelin_beast_slayer` (warrior/dominant, male) — hunts dangerous animals;
  elevated injury/wound event weights; OCEAN A:-15, N:+12
- `pagaelin_scarred_arbiter` (elder_male, male) — keeps peace through
  credible threat of past violence; OCEAN C:+3, A:+2 (from high base)  
- `pagaelin_walker_prophetess` (held_woman/elder_female, female) — outside
  the formal lodge structure; +40% weight on dream/vision/shaman events

### Extended family system
All NPCs now have `npc.extendedFamily` (lazy-generated):
- Grandparents (cosmetic: name, born, alive/dead)
- Aunt/uncle family units with wives, children, 5-year family event chronicle
- Cousins table with relationship bands
- Nephews/nieces via the principal's siblings
- Mermaid diagram spanning 3 generations
- Relationship bands: close / cordial / distant / estranged / hostile
  (unit-level base with per-member variation)

## Stats
- Events: 747 (was 753 in v1.0 — 6 ghost/duplicate events removed during repair)
- Archetypes: 321 (was 315 — 6 new added)
- Tests: 150 fast / 158 total, all passing
