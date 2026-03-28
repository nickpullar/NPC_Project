# v1.1.1 — Changelog

## Bug Fix: Destitute class event starvation

NPCs generated with `socialClass: 'destitute'` now receive the `destitute`
condition at character initialisation. Previously, all 11 destitute-specific
events (`destitute_begging`, `destitute_petty_theft`, `destitute_peonian_shelter`,
`destitute_day_labour`, `destitute_dangerous_work`, `colour_destitute_night`,
`colour_destitute_invisible`, `rescued_by_church`, `destitute_monastery_taken`,
`destitute_lk_recruitment`, `destitute_labour_recovery`) require `destitute`
as a condition — but NPCs born into the class never had the condition set,
as the entry event `fallen_to_destitution` only fires for mid-life transitions
from other classes. spec/NPC: 4.7 → 7.7.

## New Events (14 total)

### Guilded Physician (4 events)
- `physician_surgical_skill` — developed a technique through practice; not in the texts
- `physician_peoni_relationship` — working arrangement with Peoni hospice healers
- `physician_the_fee_question` — treated a patient who could not pay the guild rate
- `colour_physician_diagnosis` — sitting with a differential diagnosis overnight

spec/NPC: 5.3 → 10.3 ✅

### Guilded Arcanist (4 events)
- `arcanist_concealment_practice` — managing the necessary secrecy of arcane work in Kaldor
- `arcanist_material_cost` — the economics of component acquisition
- `arcanist_patron_arrangement` — entered or ended a noble patron relationship
- `colour_arcanist_the_failed_working` — a working that produced the wrong result

spec/NPC: 4.7 → 8.4 ✅

### Guilded Performer (3 events)
- `performer_hostile_room` — performed for an indifferent or hostile audience
- `performer_the_piece_abandoned` — a composition that would not resolve after years of work
- `performer_winter_residence` — four months in residence at a noble hall
- `performer_taught_a_student` — took on a formal student or apprentice

spec/NPC: 4.9 → 6.5 🟡

### Guilded Litigant (3 events)
- `litigant_significant_case` — argued a case that set a precedent
- `litigant_court_politics` — navigated systematic obstruction from established advocates
- `colour_litigant_the_argument` — turning an argument over the night before court

spec/NPC: 5.9 → 9.8 ✅

## Stats
- Events: 761 (up from 747 in v1.1.0)
- Archetypes: 321 (unchanged)
- Tests: 150/150 passing
