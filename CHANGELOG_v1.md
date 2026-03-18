# Kaldor NPC Aging Engine — v1.0.0 Changelog

## Summary

Version 1.0.0 represents the first production-ready release. Built over sessions 96–130+,
it introduces complete biographical simulation for all Kaldorian social classes and the
Pagaelin tribal culture, with 760+ life events, 170+ archetypes, and a fully calibrated
Monte Carlo population model.

---

## New Systems (since v0.10.9)

### Destitute Class
A new social class representing genuine homelessness — below ruination, survival-mode poverty.
- Entry: `fallen_to_destitution` fires when a ruined NPC hits the floor
- Street life: begging, petty theft (morality-bypassed), Peonian shelter, day labour, dangerous work
- Exits: `rescued_by_church` → unguilded, `destitute_lk_recruitment` → lia_kavair, `destitute_monastery_taken` → clergy, `destitute_labour_recovery` → unguilded
- LK actively recruits from the desperate (+40 conditionWeightMod on `lk_guild_initiation`)

### Morality Baseline & Reversion
- Every NPC now stores `baseMorality` — their constitutional disposition set at birth
- `moralityDrift` pulls current morality back toward baseline when circumstances stabilise
- Rate multiplied by circumstance: clergy/prosperous/devout → ×1.6, adversity → ×0.4
- Destitution blocks reversion entirely while the cause persists
- Recovery events (shame_fades, rescued_by_church, etc.) added to morality softening set

### Disgrace Fade System
Disgrace is no longer permanent. Communities have short memories.
- `disgraced` fades naturally after 4-7 years (20% at year 4, 35% at year 5, 55% at year 6+)
- `ever_disgraced` permanently records the biographical fact
- `shame_fades` and `reputation_restored` now add `ever_disgraced` on removal
- `breach_of_rank_incident` and `public_humiliation` cannot fire while already disgraced
- Key events (`estranged_from_child`, `feud_involvement`, `contact_becomes_enemy`, `outlawed`) now also boost on `ever_disgraced` at reduced rate — stigma lingers after shame fades
- `char.disgracedAtAge` tracks onset; resets on removal and restarts clock on re-disgrace

### Archetype Phase-Advance Re-Roll
Guilded classes starting in `apprentice` phase had no archetypes assigned (0/N match rate).
Fixed by adding a general archetype re-roll on phase advance to `journeyman`, `established`,
`senior`, `ordained`, `master` etc. for any NPC without an archetype. All guilded classes
now assign archetypes correctly.

### Midwife Access Model
Skilled birth attendance now reduces difficult birth probability:
- Two-path model: urban (wealth-gated) vs rural (proximity-gated, Peonian duty)
- Ruination/indebtedness reduces urban access significantly
- Rural Peonian access is class-blind — the Esolani comes regardless of means
- Isolation (hamlet/camp) reduces access regardless of wealth
- `skilled_herbalist` and `devout Peoni` both boost access

### Pregnancy Age Scaling
- Smooth per-year escalation from age 35 (replaces two-step step-function)
- Miscarriage: +2.5%/yr age 35-40, +4%/yr age 40+
- Stillbirth: +1%/yr age 35-40, +2%/yr age 40+
- Difficult birth and disability: same curve
- Midwife access reduces `pDifficult` by 45% when attended

### Menopause Guarantee
- Menopause fires naturally from pool between 43-49 (weighted bell curve)
- Guaranteed at age 50 if not yet fired — catches pool-dilution stragglers
- Result: 93% natural (43-49), 7% guaranteed at 50

---

## Event Expansion (since v0.10.9)

### New Events by Category (~100 new events total)

**Apprentice / early guild (shared across guilded classes):**
`apprentice_taught_a_technique`, `apprentice_workshop_hierarchy`, `apprentice_tool_accident`,
`apprentice_another_trade_glimpsed`, `colour_apprentice_waiting`, `colour_apprentice_daily_grind`,
`apprentice_first_commission`, `apprentice_watched_master_work`, `apprentice_ruined_a_piece`,
`master_struck_apprentice` (with OCEAN-weighted personality gates), `master_played_favourites`

**Artisan-only (archetype-differentiated via oceanWeightMod):**
`artisan_changed_masters`, `artisan_guild_officer_run`, `artisan_worked_alone_period`,
`artisan_female_client_relationship`, `colour_artisan_guild_hall`, `artisan_restless_between_towns`,
`artisan_delayed_franchise`, `artisan_female_guild_exclusion`, `artisan_herbalist_sourced_rare`,
`artisan_weapon_order_commission`, `artisan_rejected_masterwork`, `artisan_left_workshop`

**Soldier archetypes:**
`soldier_intelligence_tasked`, `soldier_cover_compromised`, `colour_soldier_maintaining_cover`,
`sutler_camp_economy`, `sutler_bad_debt`, `camp_healer_battlefield_triage`, `camp_healer_fever_epidemic`,
`soldier_pressed_hated_it`, `soldier_learned_to_survive`

**Guilded courtesan:**
`courtesan_contract_terms`, `courtesan_trained_specific_skill`, `courtesan_sister_left`,
`courtesan_difficult_patron`, `courtesan_house_politics`, `courtesan_first_patron`,
`colour_courtesan_the_house_at_night`

**Guilded herald:**
`herald_learned_blazon`, `herald_witnessed_ceremony`, `herald_rode_the_circuit`,
`herald_memorised_dispute`

**Guilded mariner:**
`mariner_first_voyage`, `mariner_crew_trouble`, `colour_mariner_reading_weather`

**Guilded arcanist:**
`arcanist_first_successful_working`, `arcanist_master_relationship`, `colour_arcanist_learning_the_limits`

**Guilded performer:**
`performer_guild_examination`, `performer_piece_that_changed_things`, `colour_performer_the_empty_day`

**Guilded miner:**
`miner_camp_economy`, `miner_roof_fall`

**Lia-Kavair:**
`lk_learned_the_territory`, `lk_fence_relationship`, `lk_close_call_watch`

**Destitute class:**
`destitution_reached`, `destitute_begging`, `destitute_petty_theft`, `destitute_peonian_shelter`,
`destitute_day_labour`, `destitute_dangerous_work`, `colour_destitute_night`, `colour_destitute_invisible`,
`rescued_by_church`, `destitute_monastery_taken`, `destitute_lk_recruitment`, `destitute_labour_recovery`

**Law-informed events:**
`reeve_comes_calling`, `serf_status_contested`, `fled_serfdom`, `royal_forest_poaching`,
`called_to_hue_and_cry`, `juror_at_assize`, `heriot_paid`, `merchet_paid`,
`breach_of_rank_incident`, `arms_bearing_challenge`, `colour_hundred_moot`, `colour_the_lords_justice`,
`litigant_case_lost`, `litigant_serf_status_case`, `litigant_bribed_court`,
`innkeeper_death_on_premises`, `innkeeper_sheltered_the_wrong_person`,
`herald_genealogy_fraud`, `herald_message_too_late`, `herald_arms_bearing_ruling`

---

## Bug Fixes & Calibration

- `outlawed` minGapYears:20, conditionWeightMod disgraced reduced 5→2
- `assault` minGapYears:6 (was unlimited — could fire every year)
- `convicted_of_crime` minGapYears:8
- `breach_of_rank_incident` weights reduced, excludeConditions added, minGapYears:20
- `public_humiliation` excludeConditions added, weights reduced
- `guild_dispute` requirement removed (was gating on `guild_member`, blocking most journeymen)
- `apprentice_graduates` weights restored from zero
- `workshop_fire` journeyman penalty removed
- `military_campaign` and `enriched_from_plunder` female exclusion lifted (-999 → -6/-8)
- `widowed` → `ever_widowed` rename (permanent biographical record)
- `financial_ruin` settlement-aware routing (city/town → unguilded, rural → peasant)
- `bad_harvest` minGapYears:4 (was firing 3× in a decade)
- `significant_injury` followOn reference corrected to `serious_wound`
- Duplicate `poaching_caught` renamed to `royal_forest_poaching` for law-expansion version
- Clergy test seed updated after morality reversion shifted RNG sequence

---

## Monte Carlo Calibration (1000 NPCs, weighted class distribution)

| Metric | v0.10.9 | v1.0 | Target |
|---|---|---|---|
| No archetype | ~10% guilded | 0.2% | 0% |
| Disgraced (active) | 20.5% | 13.4% | ~12% |
| ever_disgraced | — | 38.7% | biographical record |
| Outlawed | 7.9% | 6.6% | ~5% |
| Criminal record | 28.8% | 25.8% | ~20% |
| Ever married | 65.0% | 66.5% | 60-70% |
| Has children | 62.5% | 63.3% | 60-70% |
| Lost a child | 41.7% | 41.9% | 35-45% |
| Avg events/NPC | ~35 | 40.3 | 35-50 |
| Errors | 0 | 0 | 0 |

---

## Test Suite

150 fast tests + 8 heavy tests = **158 tests passing, 0 failing**
