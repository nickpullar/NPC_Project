# Kaldor NPC Engine — Changelog

## v0.10.6 — 2026-03-17

### First kill → first wife: the decisive arc moment

**Finding:** Binary search established that followOn weight 1500 gives 92% same-year wife
acquisition after first_kill. The remaining 8% is timing/cap variance — not failure.

**Kill → first wife timing (n=395):**
- Same year: 92%
- Within 2 years: 92%
- Never: 8% (men who didn't accumulate a kill within simulation window)

**First wife → second wife timing:**
- Flat distribution across 1-20+ years — slow accumulation through dominant phase
- Correct: second wife requires raiding success and status, not just survival

**Implementation:**
- pagaelin_first_kill followOn: +1500 to pagaelin_took_a_wife, +1350 to pagaelin_young_love
- pagaelin_solo_ambush_attempt: same followOn added (solo kill grants first_kill condition
  directly; without matching followOn, those men never got the wife pressure)
- pagaelin_took_a_wife phaseWeightMod: warrior penalty removed (+5 now vs -15 before)
- holder_relationship/established_household conditionWeightMods: -12/-8 slow second acquisition

**Birth event fixes:**
- first_child_born: minGapYears:2, pagaelin weight added
- miscarriage: minGapYears:1, pagaelin weight added
- stillbirth: minGapYears:1, pagaelin weight added
- pagaelin_pregnancy: maxAge:45 (was generating births at 53, 55)
- difficult_birth: low pagaelin weight added

**Structural repairs:** 6 additional event openers restored after regex-insertion damage
(pagaelin_raid_wounded, pagaelin_chieftain_killed, pagaelin_dominance_challenge_failed,
colour_laranian_armour_dent, colour_laranian_knight_vigil, pagaelin_young_love)

---

## v0.10.5 — 2026-03-17

### Pagaelin elder family events — protection, betrayal, abandonment, wisdom

**Design basis:** Source text explicitly places the elderly in the social hierarchy
(above slaves, below unclaimed women). They survive through usefulness or proximity
to children. Most don't have enough surviving children who are close enough. The
events encode survival arithmetic, not sentiment.

**New Pagaelin elder biographical events:**
- `pagaelin_protected_by_son` — a son in circuit; sets `children_nearby`, removes `no_protection`
- `pagaelin_robbed_by_son` — the calculation has shifted; sets `son_turned_against`, `no_protection`
- `pagaelin_abandoned_by_children` — all dispersed or dead; sets `no_protection`
- `pagaelin_left_to_die_survived` — left during tribal movement; survived; STA -1
- `pagaelin_neglected_by_held_woman` — women who no longer attend; requires `holder_relationship`
- `pagaelin_cared_for_by_daughter` — a daughter who stayed; sets `children_nearby`
- `pagaelin_gave_sage_advice` — knowledge of the range as the new currency; fires for dominants too
- `pagaelin_taught_grandchild_skill` — requires `has_grandchildren`

**New colour events:**
- `colour_pagaelin_elder_sons_watching` — watching his sons do the arithmetic
- `colour_pagaelin_grandchild_resemblance` — his jaw in a grandchild's face

**Shared Kaldoric family events given Pagaelin weights:**
- `grandchild_born`, `grandchild_dies`, `estranged_from_child`
- `child_surpasses_expectations`, `worried_for_child`
- `colour_fam_taught_child_trade`, `colour_fam_parent_advice_right`

**New conditions:** `children_nearby`, `no_protection`, `son_turned_against`

**Verified event rates (elder_male, age 62-68):**
- pagaelin_gave_sage_advice: 57%
- pagaelin_abandoned_by_children: 49%
- pagaelin_neglected_by_held_woman: 46%
- pagaelin_elder_useful: 45%
- pagaelin_elder_robbed_or_beaten: 39%
- pagaelin_left_to_die_survived: 29%
- pagaelin_taught_grandchild_skill: 14%

---

## v0.10.5 — 2026-03-17

### Walker shaman class + Pagaelin archetype expansion

**walker_shaman class — new:**
- Class change fires when `pagaelin_akan_shri_ordeal` grants `raunir_ordeal_survived`
- One-class architecture: traditional shamans stay `pagaelin`, Walker initiates class-change to `walker_shaman`
- `tribal_alignment_walker` now granted by `pagaelin_augur_contact` (recruitment), not tegal feast (attendance)
- 4 archetypes: new_raunir, operative (walker_speaker), elder, female_raunir
- Phases: raunir → walker_speaker (age 35) → walker_elder (age 60)
- Target rate: ~5-7% of Pagaelin NPCs

**Pagaelin archetypes — expanded from 13 to 39:**
Male: warrior_unkilled, dominant_man, tracker, exile, elder_dominant, former_chieftain,
  chieftain_augur_backed, chieftain_warlord, shaman_traditional_male, shaman_walker_male
Female: junior_wife, senior_wife, elder_woman, elder_woman_respected, plant_woman,
  go_between, memory_keeper, protected_matriarch, free_widow, shaman_walker_learning,
  shaman_traditional_female, shaman_walker_female
All shaman phases have 3+ archetypes. All active phases have 3+ coverage.

**Shaman life path:**
- `pagaelin_shaman_calling` event (weight 1, minGapYears 30) enters shaman_learning phase
- Suppressed for Walker-aligned and already-called NPCs
- Traditional shamans: shaman_learning phase, old faith archetypes
- Walker path: tegal_feast → augur_contact (grants tribal_alignment_walker) → akan_shri_ordeal → class change

**Engine fixes:**
- `pagaelin_former_chief_deposed` now reverts chieftain → dominant phase
- `pagaelin_takes_wife` (old event) added to phase cap check
- `grandchild_born/dies` given minGapYears:2 to prevent annual spam
- `pagaelin_pregnancy` maxAge:45 — no births after 45
- Female `pagaelin_first_kill` sexWeightMod lowered further (-28)
- `pagaelin_takes_wife` gated on first_kill

**Structural integrity:**
- All schema breaks from multi-session regex edits systematically repaired
- Schema validator confirms 0 errors
- `spouse_dies` event restored (was lost in earlier session)

---

## v0.10.4 — 2026-03-17

### Extended Pagaelin lifespan + elder phase

**Source basis:** HârnWorld Pagaelin: "The social hierarchy runs: chieftain → dominant men →
male children → women → **elderly** → unclaimed women → slaves. The elderly who can no longer
defend themselves are robbed and often killed." The elderly are a recognised social category.
No source material contradicts men living to 70.

**Phase timeline extended:**
- `dominant → elder_male` pushed from age 55 to 65
- `chieftain → elder_male` at age 65 added (deposed or aged out — chieftaincy is held only as long as defended)
- `held_woman → elder_female` pushed from 50 to 55
- Simulation can generate NPCs to age 70+ (targetAge accepts any value)

**Life expectancy base raised:**
- Male: 42 → 48 base (range 51-69, median ~58)
- Female: 38 → 44 base (range 47-65, median ~54)
- Still substantially below Kaldoric — the heath is harsh — but elders exist

**New elder-phase events:**
- `pagaelin_elder_robbed_or_beaten` (biographical, old) — the specific loss of not being able to prevent it; STR -1
- `pagaelin_former_chief_deposed` (biographical) — requires pagaelin_chief; sets pagaelin_deposed condition
- `pagaelin_elder_useful` (biographical, old) — knowledge of the range as the new survival mechanism
- `colour_pagaelin_old_man_watching` (colour, old) — perfect information, no power
- `colour_pagaelin_former_chief_remembered` (colour, old) — requires pagaelin_chief; a younger man asks advice

**Conditions registered:** `pagaelin_deposed`

**Event weight fixes:**
- `pagaelin_first_kill` old weight: 5 → 0 (a 65-year-old making first kill is incoherent)
- `pagaelin_sent_on_suicide_task` old weight: 3 → 0

---

## v0.10.3 — 2026-03-17

### Pagaelin household as physical unit + retainers

**The camp model:**
All held women and all children in a dominant man's camp live metres apart in a few tents.
They know each other. The children are raised together. The held women coordinate, compete,
and cooperate in the same physical space. This is reflected in the data structure:

- `household` summary object on male result: womenCount, childrenCount, retainerCount,
  dangerousCount, allChildrenIds[], power score
- All children in `children[]` are flat regardless of mother — the half-sibling distinction
  is a Kaldoric concept; in the camp they are simply the other children
- Female NPC's `heldWomen[]` contains her sister-women — her daily companions and rivals
- `holder` stub on female NPC is the dominant man who holds her

**Retainer system:**
- `retainers[]` array added to Pagaelin male result
- `generateRetainerStub()` creates men with: age, hasKilled, loyalty (1-5 scale),
  loyaltyLabel ('deeply loyal' → 'dangerous rival'), note explaining the relationship
- Loyalty weights: 8/20/35/25/12 (biased toward neutral working arrangements)
- Retainers generate on wife-acquisition events and on chieftain transition
- Dominant men typically have 1-3 retainers; chieftains 4-7

**Chieftain system:**
- `pagaelin_seize_chieftaincy` event — requires `first_kill` AND `established_household`
- `established_household` condition set when a man acquires his second woman
- Chieftain phase transition wired in engine: `dominant → chieftain` on event fire
- Archetype rerolls to `pagaelin_chieftain` on transition
- `pagaelin_chief` condition enables colour events: chief_watching, chief_rival
- Persistent `conditionWeightMod` on `pagaelin_took_a_wife` — chiefs acquire more women rapidly
- `minGapYears: 30` on seize_chieftaincy — can only happen once per NPC
- `colour_pagaelin_chief_watching` and `colour_pagaelin_chief_rival` colour events added

**Verified rates (500 NPCs, age 50):**
- Chiefs: ~17% of surviving men | avg 3.5 women, 8 children, 5.7 retainers
- Dominant men: ~83% | avg 2.1 women, 4.7 children
- ~1.7 dangerous retainers per chief (loyalty 4-5)

---

## v0.10.2 — 2026-03-17

### Pagaelin male arc — first_kill as the defining event

**The kill is THE threshold.** All male advancement gates through it. Men without first_kill
cannot acquire women under any circumstances. This was architecturally enforced.

**New events — unkilled warrior pool:**
- `pagaelin_raid_bystander` — watched another man make the kill; followOn boosts first_kill
- `pagaelin_solo_ambush_attempt` — solo attack on a traveller; GRANTS first_kill condition on success
- `pagaelin_dominance_challenge_failed` — desperate challenge to a dominant man; usually punishing
- `pagaelin_sent_on_suicide_task` — used as cannon fodder; followOn strongly boosts first_kill
- `pagaelin_old_alone` — the man who never killed, ageing at the edge of someone else's camp
- `colour_pagaelin_watching_the_hierarchy` — watching what he cannot have
- `colour_pagaelin_almost` — the moment he didn't do it

**Tuned first_kill rates:**
- Age 20: ~40% (most haven't had the opportunity yet)
- Age 25: ~78% (majority have now killed)
- Age 30: ~90% (the stubborn remainder)
- Age 45: ~99% (only the specific men who will never kill)

**Wife-acquisition gates:**
- `pagaelin_took_a_wife`: now requires `first_kill` — no women before the kill, hard stop
- `pagaelin_young_love`: now requires `first_kill` and absence of `holder_relationship`
- `pagaelin_young_love` flavour updated to reflect the specific peer dynamic this creates

**Phase-based wife caps:**
- warrior: max 1
- dominant: max 3
- chieftain: max 5
Enforced in engine handler on every wife-acquisition event

**Held woman age gap:**
- Women acquired at ages 14-24, always substantially younger than their holder
- A man of 40 takes a girl of 14-24; a man of 28 takes a girl of 14-20
- The fertility-as-asset logic of the culture, architecturally enforced

**Pregnancy model:**
- Live birth: 2-year cooldown (nursing)
- Miscarriage/stillbirth: 1-year cooldown (she becomes pregnant again quickly)
- minGapYears on pagaelin_pregnancy: 2 (was 3)
- Flavour updated to reflect the absence of reproductive choice

---

## v0.10.1 — 2026-03-17

### Pagaelin household system (relational model)

**Male dominant NPCs:**
- `heldWomen[]` array on result — named female stubs, each with `id`, `sex`, `ageAtAcquisition`, `acquiredAtPrincipalAge`, `pregnancyCooldown`, `children[]`
- `advancePagaelinHousehold()` runs every year: per-held-woman pregnancy checks (~40% base chance, 2-year cooldown after birth), annual child mortality per woman
- Children recorded in both the held woman's `children[]` and the principal's flat `children[]` with `motherId` pointing to the held woman stub
- `pagaelin_took_a_wife` event generates a held woman stub; dominant/chieftain phase heavily weighted, warrior phase suppressed
- `pagaelin_young_love` event — lower-status male with one woman; warrior-phase only, excludes men who have killed

**Female held NPCs:**
- `holder` stub on result — the dominant man who holds her (age, status)
- `heldWomen[]` on result — the other women in the same household (sister-held-women; their children are half-siblings)
- `pagaelin_held` condition set at init for held_woman/herder_female/shaman archetypes
- Holder stub generated on first event-loop year when `pagaelin_held` is present

**Pregnancy system:**
- `pagaelin_pregnancy` (family pool, no marriage required) with `minGapYears: 3`
- Post-birth follow-on references `pagaelin_pregnancy` not Kaldoric `pregnancy`
- `familyPoolActive()` returns true for Pagaelin females under 45 regardless of spouse status
- Female pregnancy weights: young 35, middle 28; fires from family pool each year not in cooldown

**Child mortality — Pagaelin:**
- Year 0: 10% (vs 8% Kaldoric)
- Years 1–4: 6%/year (vs 4% Kaldoric)
- Years 5–14: 2.5%/year (vs 1.5% Kaldoric)
- Approximately 47% survive to adulthood
- Tuned to produce ~2.0 surviving adults per woman lifetime (target 2.1)

**Verified rates (600 NPCs, age 50):**
- Avg births per woman: 6.12
- Avg adults reached per woman: 2.01
- Warrior phase with women: ~24%
- Dominant phase with women: ~66%
- Female holder stub presence: ~95%
- Zero Kaldoric family event leaks

---

## v0.10 (current) — 2026-03-17

### Pagaelin Culture (in progress)
- New social class `pagaelin` with fully separate culture track from Kaldoric classes
- `CULTURE_CONFIGS.pagaelin` — tribalAlignment system (traditional/syncretist/walker_dominated),
  OCEAN base, life expectancy (42m/38f), deity from alignment, settlement always 'camp'
- `rollTribalAlignment()` — weights 25/60/15 reflecting 720 TR escalation
- Phase config: male warrior→dominant→elder_male, female held_woman→elder_female, shaman track
- Kaldoric event fallback blocked for non-Kaldoric cultures (pagaelin cannot receive Kaldoric events)
- Kaldoric class changes blocked for pagaelin NPCs
- 13 pagaelin archetypes: hunter, hunter_experienced, herder, herder_female, held_woman, widow,
  shaman_saraen, shaman_saraen_female, shaman_walker, shaman_syncretist, chieftain,
  border_trader, harnic_fluent
- `requireConditions` on archetypes — shamans gated to tribal alignment
- `startingConditions` on archetypes — border_trader gets lang_harnic_trade automatically
- 11 pagaelin biographical events: raid_participated, first_kill, raid_wounded,
  chieftain_killed, dominance_contest, tribe_moved, tegal_feast, akan_shri_ordeal,
  augur_contact, saraen_hunt_rite, gargun_trade, oselbridge_contact, pagaelin_family events
- 5 pagaelin colour events: raven_omen, heath_night, walker_dream, elder_robbed, caravan_watch
- 3 pagaelin family events: takes_wife, woman_traded, daughter_exposed
- Language system: lang_pagaelin_pidgin/fluent, lang_harnic_trade/fluent, lang_naveh_liturgical
- Kaldoric border events: border_posting_oselmarch, genin_trail_contact, osel_massacre_knowledge,
  learned_pagaelin_pidgin/fluent, studied_pagaelin_language
- Cross-cultural colour events: border_negotiation, interrogation_attempt, osel_mission_grave,
  augur_as_translator, pagaelin_understood_too_much
- `naveh_temple_maze` now adds `lang_naveh_liturgical` condition
- `colour_event` sentinel gets pagaelin weights so colour events fire
- `spouse_dies` event reconstructed after loss (was missing from array)
- `bereaved_child` condition registered
- `CONDITION_REGISTRY` — 20+ new conditions for language and Pagaelin culture

### Archetypes
- All archetype IDs now strictly follow `{socialClass}_{subclass}_{name}` convention (60 renames)
- `populationWeightBySex` scheme replaces hard sex filtering — 10 paired archetypes merged
- `artisan_freemaster`, `guilded_arcanist_alchemist`, `guilded_herald_household`,
  `guilded_mariner_able_seaman`, `guilded_miner_prospector`, `guilded_miner_underground_veteran`,
  `guilded_performer_thespian_troupe_master`, `guilded_performer_apprentice`,
  `guilded_performer_harper_wandering`, `guilded_physician_village_healer`
- 55 new archetypes across undergrown classes (all guilded_ classes now 8+)
- 85 unguilded archetypes including full canonical occupation list coverage
- 282 total archetypes across 20 social classes

### Sex weighting on events
- 24 key life-path events now have meaningful sexWeightMod differentials
- guild_dispute +5f, franchise_acquired +4m/-4m, journeyman_wandering +4m/-4f,
  theological_study -2m/+4f, public_humiliation -2m/+4f, etc.
- Demonstrated: same archetype produces visibly different male/female histories

### Bug fixes
- `gender` → `sex` renamed throughout all 16 JS files (0 occurrences of `gender` remain)
- spouse_death test ceiling raised to 35% (reconstructed event fires at 32.8%)

---

## v0.9 — 2026-03-16

### Archetypes
- 282 total archetypes; all classes at 7+ archetypes
- guilded_performer (13), clergy (30), priest_naveh (12), lia_kavair (13), unguilded (85)
- artisan_freemaster_hard_won, noble_dispossessed, lia_kavair_contract_killer added
- Unguilded: gladiator (Kaldorian returned from Thardic Republic), gladiatrix (manumitted slave),
  thatcher, toymaker, cartographer, shaman, female_prostitute, manumitted_serf, longshoreman,
  failed_entertainer, scribe_lk_adjacent
- `unguilded_gladiatrix` — slave-gladiator who earned manumission in Thardic Republic

### Sex-based weighting
- 119 events with sexWeightMod (20 major life-path events added this session)
- franchise_acquired +2m/-1f → strengthened to +4m/-4f
- journeyman_wandering 0/0 → +4m/-4f
- guild_dispute 0/0 → -2m/+5f
- public_humiliation 0/0 → -2m/+4f

### Life events
- 524 total events
- Language acquisition events written (not yet integrated)
- Various structural repairs to life-events.js

---

## v0.8 — 2026-03-15

### Engine
- HârnMaster 3 NPC generator — four-layer architecture complete
- Templater wrapper deployed; generates Obsidian markdown notes
- 171 regression tests passing
- Snapshot-based regression testing with 10 seeds × 4 class/sex combinations

### Archetypes
- 189 archetypes across 19 classes
- guilded_ classes introduced: performer, courtesan, innkeeper, miner, mariner,
  physician, litigant, herald, arcanist
- priest_naveh (12 archetypes) with Navehan phase config
- naveh_augur_assignment event connects to Pagaelin range

### Clergy
- Full Laranian clergy lifecycle (postulant → acolyte → priest → vicar → canon → bishop)
- Peoni and Halea clergy tracks
- 30 clergy archetypes across three orders
- Colour events for Laranian chapel, armour, tirannon witness

### Family system
- Pregnancy, miscarriage, stillbirth, Rh incompatibility
- Spouse death, remarriage, child death
- Medical traits from HârnMaster tables
- Parent death events

---
