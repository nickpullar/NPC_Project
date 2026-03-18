#!/usr/bin/env node

/**
 * Kaldor NPC Aging Engine
 *
 * Walks a character from their starting age to a target age.
 * Each year runs TWO independent draws:
 *
 *   1. BIOGRAPHICAL POOL — one event per year, always active.
 *      Covers injuries, career, faith, skill-building, quiet years.
 *
 *   2. FAMILY POOL — one event per year, active when the character
 *      has a spouse OR living children. Covers marriage, pregnancy,
 *      childbirth, child death, affairs, spouse death, remarriage.
 *      A null draw from the family pool is silent (counted as uneventful).
 *
 * Calendar dates: every history entry carries a `year` field (TR calendar).
 * Default game year is 720 TR; pass `gameYear` to override.
 *
 * Usage:
 *   const { ageCharacter } = require('./aging-engine');
 *   const result = ageCharacter({ socialClass: 'soldier', sex: 'male',
 *                                  targetAge: 35, gameYear: 720 });
 */

'use strict';

const { rand, seedRng, dN } = require('./rng');
const { rollArchetype, getArchetype } = require('./archetypes.js');
// NOTE: MAJOR_NEGATIVE_EVENTS is defined in op-spending.js. Keep in sync with
// isMajor:true events in life-events.js whenever new major events are added.
const { createOPSpender, MAJOR_NEGATIVE_EVENTS, normaliseSkillName } = require('./op-spending');

const DEFAULT_GAME_YEAR = 720;  // Kaldor campaign default (TR)

const { LIFE_EVENTS, CONDITION_REGISTRY }                               = require('./life-events');
const { STARTING_AGES, OP_ACCRUAL_RATE, generateOCEANScores, rollSunsign, SUNSIGNS, selectDeity } = require('./npc-generator');
const { EVENT_INJURY_MAP, resolveInjuryEffects, resolveDiseaseEffects } = require('./injury-tables');
const { generateSpouseStub, generateChildStub, generateContactStub, generateName, generateParentStub, generateSiblingStub, generateChildName } = require('./name-tables');

// O(1) event lookup by id — built once at module load to avoid repeated
// LIFE_EVENTS.find() calls in the hot follow-on registration path.
const LIFE_EVENTS_BY_ID = new Map(LIFE_EVENTS.map(e => [e.id, e]));

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const AGE_GROUPS = {
  young:  { min: 18, max: 35 },
  middle: { min: 36, max: 60 },
  old:    { min: 61, max: 999 },
};

const OP_ANNUAL_BUDGET = 3;   // OPs available per year of life
const MIN_SEX_WEIGHT = 0;  // weights are floored at 0 after modifiers

// ─────────────────────────────────────────────────────────────────────────────
// CULTURE CONFIGS
// ─────────────────────────────────────────────────────────────────────────────
// Each culture defines its own settlement type array and birth/event weights.
// Add new cultures here — the engine picks the right config via CLASS_CULTURE_MAP.
// The 'kaldor' culture covers all existing Kaldorian classes.
//
// Settlement type arrays must be ordered from least to most urban (for shift ops).
// birthWeights entries must align with the settlement type array by index.
//
// To add a tribal/nomadic culture (e.g. Pagaelin):
//   1. Add an entry to CULTURE_CONFIGS with appropriate settlement types
//   2. Add the new class → culture mapping to CLASS_CULTURE_MAP
//   3. Add birth settlement weights and event weight modifiers
//   The engine will use these automatically — no other changes needed.

const CULTURE_CONFIGS = {
  kaldor: {
    // Standard Kaldorian feudal settlement hierarchy
    settlementTypes: ['hamlet', 'village', 'town', 'city'],
    // See BIRTH_SETTLEMENT_WEIGHTS below for per-class weights within this culture
  },
  // ── Pagaelin tribal culture ─────────────────────────────────────────────────
  // Pagaelin NPCs are born into nomadic tribal camps. What varies is not
  // settlement type (always 'camp') but the tribe's religious alignment:
  //   traditional       — Saraen-following old faith, no augur presence (~25%)
  //   syncretist        — attends augur feasts, some Walker influence (~60%)
  //   walker_dominated  — fully under Navehan augur control (~15%)
  // Stored as char.tribalAlignment rather than char.settlementType.
  // At 720 TR: situation is escalating — walker_dominated fraction growing.
  pagaelin: {
    settlementTypes: ['camp'],
    tribalAlignments: ['traditional', 'syncretist', 'walker_dominated'],
    tribalAlignmentWeights: [25, 60, 15],
    // OCEAN base: low A (dominance culture), low C (erratic subsistence),
    // high N (perpetual threat), variable O by subclass.
    oceanBase: { O: 40, C: 30, E: 45, A: 25, N: 65 },
    // Life expectancy: harsh environment, violence, erratic diet.
    lifeExpectancyBase: { male: 42, female: 38 },
    // Public deity resolved at init from tribalAlignment.
    deities: {
      traditional:      'Saraen',
      syncretist:       'Saraen',
      walker_dominated: 'Walker',
    },
  },
};

// Maps each social class to its culture config key.
// All existing Kaldorian classes → 'kaldor'.
// Add new classes here when implementing new cultures.
const CLASS_CULTURE_MAP = {
  noble:        'kaldor',
  merchant:     'kaldor',
  warrior:      'kaldor',
  soldier:      'kaldor',
  artisan: 'kaldor',
  peasant:      'kaldor',
  unguilded:    'kaldor',
  clergy:       'kaldor',
  lia_kavair:   'kaldor',
  priest_naveh: 'kaldor',
  guilded_performer:    'kaldor',
  guilded_courtesan:    'kaldor',
  guilded_innkeeper:    'kaldor',
  guilded_miner:        'kaldor',
  guilded_mariner:      'kaldor',
  guilded_physician:    'kaldor',
  guilded_litigant:     'kaldor',
  guilded_herald:       'kaldor',
  guilded_arcanist:     'kaldor',
  destitute:            'kaldor',   // Fallen — genuinely homeless, no income, survival-mode
  pagaelin: 'pagaelin',
  walker_shaman: 'pagaelin',  // Pagaelin who crossed the Raunir threshold — Naveh lodge asset
};

// ─────────────────────────────────────────────────────────────────────────────
// CLASS PHASE CONFIGS
// ─────────────────────────────────────────────────────────────────────────────
// Data-driven phase ladder definitions. Used by the engine to determine starting
// phase and automatic age-based transitions without hardcoded if/else chains.
//
// Each entry defines:
//   startingPhase: function(sex, birthOrder, settlementType) → phase string
//   ageTransitions: [ { fromPhase, toPhase, atAge, condition? } ]
//     condition: optional function(char) → bool for guarded transitions
//   agingPhase: phase given when character runs out of progression (age 50+)
//
// Complex condition-driven phases (priest_naveh, lia_kavair, clergy) are still
// handled in the engine body — this config covers the simple age-based cases
// and makes it trivially easy to add new classes.

const CLASS_PHASE_CONFIGS = {
  noble: {
    startingPhase: (sex, birthOrder) =>
      sex === 'female' ? 'lady' : (birthOrder === 1 ? 'heir' : 'spare'),
    ageTransitions: [
      { fromPhase: 'heir',         toPhase: 'senior_noble', atAge: 55 },
      { fromPhase: 'spare',        toPhase: 'senior_noble', atAge: 55 },
      { fromPhase: 'lady',         toPhase: 'senior_noble', atAge: 55 },
      { fromPhase: 'married_noble',toPhase: 'senior_noble', atAge: 55 },
      { fromPhase: 'widow',        toPhase: 'senior_noble', atAge: 55 },
      { fromPhase: 'lord',         toPhase: 'senior_noble', atAge: 50 },
    ],
  },
  warrior: {
    startingPhase: () => 'recruit',
    ageTransitions: [
      { fromPhase: 'recruit',  toPhase: 'broken',  atAge: 50 },
      { fromPhase: 'veteran',  toPhase: 'senior',  atAge: 50 },
      { fromPhase: 'sergeant', toPhase: 'senior',  atAge: 50 },
    ],
  },
  soldier: {
    startingPhase: () => 'recruit',
    ageTransitions: [
      { fromPhase: 'established', toPhase: 'senior', atAge: 50 },
      { fromPhase: 'veteran',     toPhase: 'senior', atAge: 50 },
      { fromPhase: 'sergeant',    toPhase: 'senior', atAge: 50 },
    ],
  },
  artisan: {
    startingPhase: () => 'apprentice',
    ageTransitions: [
      { fromPhase: 'apprentice', toPhase: 'journeyman', atAge: 18,
        condition: char => char.sex === 'male' },
      { fromPhase: 'journeyman', toPhase: 'senior',     atAge: 50 },
      { fromPhase: 'established',toPhase: 'senior',     atAge: 50 },
    ],
  },
  merchant: {
    startingPhase: () => 'established',
    ageTransitions: [
      { fromPhase: 'established', toPhase: 'senior', atAge: 50 },
      { fromPhase: 'journeyman',  toPhase: 'senior', atAge: 50 },
    ],
  },
  peasant: {
    startingPhase: () => 'established',
    ageTransitions: [
      { fromPhase: 'established', toPhase: 'senior', atAge: 50 },
    ],
  },
  unguilded: {
    startingPhase: () => 'established',
    ageTransitions: [
      { fromPhase: 'established', toPhase: 'senior', atAge: 50 },
      { fromPhase: 'journeyman',  toPhase: 'senior', atAge: 50 },
    ],
  },
  clergy: {
    startingPhase: () => 'postulant',
    // Clergy phase transitions are condition-driven (ordination), not purely age-based.
    // Handled separately in the engine body. Age-50 senior is handled there too.
    ageTransitions: [],
  },
  lia_kavair: {
    startingPhase: () => 'recruit',
    // LK phase is event-driven (initiation, rank advancement). Age-50 master handled in engine.
    ageTransitions: [],
  },
  priest_naveh: {
    startingPhase: () => 'dranatha_new',
    // Naveh phase is age+condition driven. Handled separately in engine body.
    ageTransitions: [],
  },

  // ── NEW GUILDED CLASSES ────────────────────────────────────────────────────
  guilded_performer: {
    startingPhase: () => 'apprentice',
    ageTransitions: [
      { fromPhase: 'apprentice', toPhase: 'journeyman', atAge: 18 },
      { fromPhase: 'journeyman', toPhase: 'established', atAge: 30 },
      { fromPhase: 'established', toPhase: 'senior', atAge: 50 },
    ],
  },
  guilded_courtesan: {
    startingPhase: () => 'bonded',     // bonded contract to a guild house
    ageTransitions: [
      { fromPhase: 'bonded',    toPhase: 'free',    atAge: 25 },   // 7-year contract expires
      { fromPhase: 'free',      toPhase: 'senior',  atAge: 35 },   // most retired by 30; those who stay
    ],
  },
  guilded_innkeeper: {
    startingPhase: () => 'apprentice',
    ageTransitions: [
      { fromPhase: 'apprentice', toPhase: 'journeyman',  atAge: 18 },
      { fromPhase: 'journeyman', toPhase: 'established', atAge: 26 },
      { fromPhase: 'established', toPhase: 'senior',     atAge: 50 },
    ],
  },
  guilded_miner: {
    startingPhase: () => 'apprentice',
    ageTransitions: [
      { fromPhase: 'apprentice', toPhase: 'journeyman',  atAge: 16 },  // miners' unique early start
      { fromPhase: 'journeyman', toPhase: 'established', atAge: 26 },
      { fromPhase: 'established', toPhase: 'senior',     atAge: 50 },
    ],
  },
  guilded_mariner: {
    startingPhase: () => 'deck_boy',
    ageTransitions: [
      { fromPhase: 'deck_boy',   toPhase: 'ordinary',  atAge: 16 },
      { fromPhase: 'ordinary',   toPhase: 'able',       atAge: 20 },
      { fromPhase: 'able',       toPhase: 'established', atAge: 28 },
      { fromPhase: 'established', toPhase: 'senior',    atAge: 50 },
    ],
  },
  guilded_physician: {
    startingPhase: () => 'apprentice',
    ageTransitions: [
      { fromPhase: 'apprentice', toPhase: 'journeyman',  atAge: 20 },
      { fromPhase: 'journeyman', toPhase: 'established', atAge: 28 },
      { fromPhase: 'established', toPhase: 'senior',     atAge: 50 },
    ],
  },
  guilded_litigant: {
    startingPhase: () => 'apprentice',
    ageTransitions: [
      { fromPhase: 'apprentice', toPhase: 'journeyman',  atAge: 20 },
      { fromPhase: 'journeyman', toPhase: 'established', atAge: 28 },
      { fromPhase: 'established', toPhase: 'senior',     atAge: 50 },
    ],
  },
  guilded_herald: {
    startingPhase: () => 'apprentice',
    ageTransitions: [
      { fromPhase: 'apprentice', toPhase: 'journeyman',  atAge: 18 },
      { fromPhase: 'journeyman', toPhase: 'established', atAge: 26 },
      { fromPhase: 'established', toPhase: 'senior',     atAge: 50 },
    ],
  },
  guilded_arcanist: {
    startingPhase: () => 'apprentice',
    ageTransitions: [
      { fromPhase: 'apprentice', toPhase: 'journeyman',  atAge: 20 },
      { fromPhase: 'journeyman', toPhase: 'established', atAge: 30 },
      { fromPhase: 'established', toPhase: 'senior',     atAge: 50 },
    ],
  },
  destitute: {
    // Two phases:
    //   street    — living rough, no fixed address, immediate survival
    //   sheltered — found temporary institutional shelter (Peonian house, monastery
    //               hostel, charity lodgings) — not permanent recovery, but not street
    // No automatic age transitions — exit is entirely event-driven:
    //   rescued_by_church → unguilded/peasant
    //   lk_guild_initiation → lia_kavair (criminal recruitment)
    //   entered_monastery → clergy
    //   recovered_through_labour → unguilded
    startingPhase: () => 'street',
    ageTransitions: [],
  },

  walker_shaman: {
    startingPhase: () => 'raunir',
    // Walker shaman phase is entirely event-driven — the lodge controls progression.
    // raunir: newly initiated, learning the Walker's ways
    // walker_speaker: full operative, speaks for the lodge to the tribe
    // walker_elder: aged Walker shaman with decades of lodge service
    ageTransitions: [
      { fromPhase: 'raunir',         toPhase: 'walker_speaker', atAge: 35 },
      { fromPhase: 'walker_speaker', toPhase: 'walker_elder',   atAge: 60 },
    ],
  },

  // ── Pagaelin phase config ────────────────────────────────────────────────────
  // Male lifecycle: youth → warrior → dominant → (chieftain — rare, event-driven)
  // Female lifecycle: girl → held_woman → (widow — when holder dies)
  // Slave: single phase throughout
  // Shaman: learning → raunir (ordeal event) → walker_speaker
  //
  // Age transitions are approximate — Pagaelin society doesn't track age formally.
  // Transitions are social/status events as much as age-based.
  // The 'dominant' phase requires surviving and accumulating; age is a proxy.
  // Chieftain phase is NOT age-driven — it's event-driven (pagaelin_seize_chieftaincy).
  pagaelin: {
    startingPhase: (sex) => {
      // NPCs are generated at minimum age 18. By 18, males are in 'warrior'
      // phase (transition from youth→warrior happens at age 14).
      // 'youth' phase exists for internal tracking only (age 8-14 children).
      if (sex === 'female') return 'held_woman';
      return 'warrior';
    },
    ageTransitions: [
      // Male track
      { fromPhase: 'youth',     toPhase: 'warrior',   atAge: 14 },
      { fromPhase: 'warrior',   toPhase: 'dominant',  atAge: 28 },
      { fromPhase: 'dominant',  toPhase: 'elder_male', atAge: 65 },
      { fromPhase: 'chieftain', toPhase: 'elder_male', atAge: 65 },
      // Female track
      { fromPhase: 'girl',      toPhase: 'held_woman', atAge: 12 },
      { fromPhase: 'held_woman', toPhase: 'elder_female', atAge: 55 },
      // Shaman track (any sex, replaces standard track when shaman archetype rolled)
      { fromPhase: 'shaman_learning', toPhase: 'raunir',         atAge: 20,
        condition: c => c.conditions.includes('raunir_ordeal_survived') },
      { fromPhase: 'raunir',          toPhase: 'walker_speaker', atAge: 30 },
    ],
  },
};



// Birth settlement probabilities by class [hamlet, village, town, city]
// Weights — not percentages; will be normalised on roll.
// Reflects HârnWorld demography: overwhelmingly rural, with class-specific skews.
// ─────────────────────────────────────────────────────────────────────────────
// SETTLEMENT SYSTEM
// ─────────────────────────────────────────────────────────────────────────────

// Settlement types in ascending urban order (Kaldorian feudal hierarchy).
// New cultures define their own type arrays in CULTURE_CONFIGS above.
const SETTLEMENT_TYPES = CULTURE_CONFIGS.kaldor.settlementTypes;

// Birth settlement probabilities by class [hamlet, village, town, city]
// Weights — not percentages; will be normalised on roll.
// Reflects HârnWorld demography: overwhelmingly rural, with class-specific skews.
const BIRTH_SETTLEMENT_WEIGHTS = {
  peasant:      [40, 45, 12,  3],
  artisan: [10, 35, 40, 15],
  warrior:      [ 5, 25, 45, 25],
  soldier:      [15, 35, 35, 15],
  merchant:     [ 2, 15, 45, 38],
  noble:        [20, 30, 30, 20],
  clergy:       [10, 30, 40, 20],
  unguilded:    [15, 40, 35, 10],  // wider rural/village spread; fewer city births than artisan
  lia_kavair:   [ 0, 10, 40, 50],  // guild operates in towns/cities; rare in villages, never hamlet
  priest_naveh: [ 0,  0, 20, 80],  // temple is in Tashal (city); Dranatha can operate in large towns
  // New guilded classes
  guilded_performer:    [ 0, 20, 45, 35],  // harpers/thespians gravitate to towns and cities; some rural circuits
  guilded_courtesan:    [ 0,  0, 30, 70],  // guild houses are urban; smaller towns possible
  guilded_innkeeper:    [15, 35, 35, 15],  // inns everywhere from crossroads hamlet to city inn
  guilded_miner:        [30, 50, 15,  5],  // mines are rural; some smelting towns
  guilded_mariner:      [ 0,  0, 20, 80],  // port cities; coastal towns; never inland hamlet
  guilded_physician:    [ 5, 20, 45, 30],  // physicians serve towns and up; some rural itinerants
  guilded_litigant:     [ 0,  0, 35, 65],  // explicitly urban; rural areas use noble/church justice
  guilded_herald:       [10, 25, 35, 30],  // bonded to noble households; spread across settlement types
  guilded_arcanist:     [ 0, 10, 40, 50],  // chantries in towns and cities; some rural hermits
  destitute:            [ 5, 15, 35, 45],  // concentrates in towns/cities; some rural vagrants
  // Pagaelin: birthSettlement is always 'camp' — these weights are unused
  // but the entry prevents silent fallback to peasant weights.
  pagaelin:             [100,  0,  0,  0],
};

// Events that trigger a settlement transition.
// reason: { male, female } — human-readable explanation for md-writer.
// to/shift as before.
const SETTLEMENT_TRANSITIONS = {
  fled_to_town:         { to: 'town',    reason: { male: 'fled to the nearest town',                      female: 'fled to the nearest town' } },
  joined_garrison:      { to: 'town',    reason: { male: 'took up garrison service',                      female: null } },
  hired_as_bodyguard:   { shift: +1,     reason: { male: 'hired on as a bodyguard, followed his employer', female: 'hired on, followed her employer' } },
  joined_guild:         { to: 'town',    reason: { male: 'joined a guild, settled in town',               female: 'joined a guild, settled in town' } },
  long_distance_trade:  { to: 'city',    reason: { male: 'established himself in long-distance trade',    female: 'established herself in long-distance trade' } },
  court_appointment:    { to: 'city',    reason: { male: 'took a position at court',                      female: 'took a position at court' } },
  noble_exile:          { to: 'town',    reason: { male: 'fled into exile',                               female: 'fled into exile' } },
  enfeoffed:            { to: 'village', reason: { male: 'granted lands, moved to his estate',            female: null } },
  spare_finds_position: { shift: +1,     reason: { male: 'found his own position, moved for it',          female: null } },
  conscripted:          { shift: +1,     reason: { male: 'conscripted, pulled toward the garrison',       female: null } },
  deserted:             { to: 'town',    reason: { male: 'deserted, slipped away to a town',              female: 'slipped away to a town' } },
  outlawed:             { to: 'town',    reason: { male: 'outlawed, sought anonymity in a town',          female: 'outlawed, sought anonymity in a town' } },
  established_workshop: { shift: 0,     reason: null },  // no movement
  journey_abroad:       { shift: 0,     reason: null },  // temporary
};

// Weight modifiers per settlement type for events.
// Format: { hamlet: n, village: n, town: n, city: n }
// Applied as flat modifier in buildDrawTable, same layer as rootless.
const SETTLEMENT_EVENT_WEIGHTS = {
  // ── Rural-heavy events ────────────────────────────────────────────────────
  good_harvest:         { hamlet: +8, village: +6, town: -2, city: -8 },
  bad_harvest:          { hamlet: +8, village: +6, town: -2, city: -8 },
  land_dispute:         { hamlet: +6, village: +6, town:  0, city: -4 },
  conscripted:          { hamlet: +6, village: +4, town:  0, city: -4 },
  weather_reading:      { hamlet: +4, village: +4, town:  0, city: -4 },
  hunting_regularly:    { hamlet: +6, village: +4, town: -2, city: -6 },
  herbalism_practice:   { hamlet: +4, village: +4, town:  0, city: -2 },
  survived_famine:      { hamlet: +6, village: +4, town:  0, city: -4 },

  // ── Urban-heavy events ────────────────────────────────────────────────────
  joined_guild:         { hamlet: -8, village: -4, town: +6, city: +10 },
  guild_advancement:    { hamlet: -8, village: -4, town: +6, city: +10 },
  long_distance_trade:  { hamlet: -6, village: -2, town: +4, city:  +8 },
  court_appointment:    { hamlet:-10, village: -6, town: +2, city:  +8 },
  political_intrigue:   { hamlet: -6, village: -4, town: +2, city:  +6 },
  tournament_attended:  { hamlet: -4, village: -2, town: +4, city:  +6 },
  affair:               { hamlet: -4, village: -2, town: +2, city:  +4 },
  public_humiliation:   { hamlet: -2, village:  0, town: +2, city:  +4 },
  confided_secret:      { hamlet: -2, village:  0, town: +2, city:  +4 },
  made_useful_contact:  { hamlet: -4, village: -2, town: +2, city:  +6 },
  successful_trade_venture: { hamlet: -4, village: -2, town: +4, city: +6 },

  // ── Illness — worse in cities (epidemic) ─────────────────────────────────
  serious_illness:      { hamlet: -2, village:  0, town: +2, city:  +6 },

  // ── Fire — devastating in crowded urban areas ─────────────────────────────
  fire_or_flood:        { hamlet: -2, village:  0, town: +2, city:  +6 },

  // ── Military — more visible near garrison towns ───────────────────────────
  military_campaign:    { hamlet: -2, village:  0, town: +2, city:  +2 },
  joined_garrison:      { hamlet: -4, village: -2, town: +4, city:  +4 },
  hired_as_bodyguard:   { hamlet: -4, village: -2, town: +4, city:  +6 },

  // ── Road events — more likely when mobile ────────────────────────────────
  robbed_on_the_road:   { hamlet: -4, village: -2, town: +2, city:  +4 },
  journey_abroad:       { hamlet: -4, village: -2, town: +2, city:  +4 },
};

// ─────────────────────────────────────────────────────────────────────────────
// MORALITY SYSTEM
// Maps to HârnMaster Morality characteristic (3–18).
// Derived from OCEAN scores; can drift via life events.
// ─────────────────────────────────────────────────────────────────────────────

const MORALITY_BANDS = [
  { min: 16, max: 18, label: 'principled'  },
  { min: 13, max: 15, label: 'honest'      },
  { min: 10, max: 12, label: 'situational' },
  { min:  7, max:  9, label: 'corruptible' },
  { min:  3, max:  6, label: 'predatory'   },
];

function getMoralityBand(score) {
  for (const b of MORALITY_BANDS) {
    if (score >= b.min && score <= b.max) return b.label;
  }
  return 'situational';
}

function deriveMorality(ocean) {
  const cContrib  = ((ocean.C - 50) / 50) * 5;
  const aContrib  = ((ocean.A - 50) / 50) * 2;
  const nVariance = ((ocean.N - 50) / 50) * 0.5 * (rand() < 0.5 ? 1 : -1);
  // Base 11.5: shifts distribution toward honest/situational rather than corruptible.
  // Morality 3-18 scale; bands: predatory 3-6, corruptible 7-9, situational 10-12,
  // honest 13-15, principled 16-18.
  const raw = 11.5 + cContrib + aContrib + nVariance;
  return Math.round(Math.max(3, Math.min(18, raw)));
}

// Settlement multipliers on criminal event opportunity
const CRIMINAL_SETTLEMENT_OPPORTUNITY = {
  hamlet:  0.3,
  village: 0.6,
  town:    1.0,
  city:    1.6,
};

function moralityDrift(morality, char, evId) {
  const hardens = new Set([
    'falsely_accused', 'unjust_punishment', 'betrayed_by_friend',
    'lost_everything', 'driven_off', 'survived_famine',
    'noble_exile', 'outlawed', 'deserted', 'broken_by_war',
    'fallen_to_destitution', 'destitute_petty_theft', 'destitute_dangerous_work',
  ]);
  const softens = new Set([
    'religious_conversion', 'pilgrimage_completed', 'found_purpose',
    'generous_patron', 'made_good_marriage', 'prosperous_union',
    'rescued_by_church', 'destitute_labour_recovery', 'destitute_monastery_taken',
    'shame_fades', 'reputation_restored',
    'estate_put_in_order', 'debt_cleared',
  ]);

  // ── Event-driven drift ─────────────────────────────────────────────────────
  // Specific life events push morality one step in a direction.
  if (hardens.has(evId) && rand() < 0.15) return -1;
  if (softens.has(evId) && rand() < 0.20) return  1;

  // ── Condition-driven pressure ──────────────────────────────────────────────
  // Active adverse conditions push morality away from baseline AND block reversion.
  // The pressure persists every year the condition exists. Once removed, reversion
  // begins. Severity determines rate — hunger is immediate; debt is background.
  //
  // Multiple conditions stack: a ruined outlaw erodes faster than either alone,
  // up to a practical cap.
  //
  // Conditions that elevate morality above baseline also suppress downward
  // reversion while active.

  const conds = char.conditions;

  // ── ADVERSE CONDITIONS — push down, block upward reversion ────────────────
  // Calculate total downward pressure from all active conditions.
  let erosionRate = 0;

  // Destitution (class-based): extreme — starvation, daily crime, survival mode.
  // Collapses moral framework fast. A principled man stealing bread daily: weeks,
  // not years. ~60% per year means expected first drop within 1-2 years, full
  // collapse (6-8 pts) in 3-4 years.
  if (char.socialClass === 'destitute') {
    erosionRate += morality > 10 ? 0.60 :   // principled: collapse is fast and hard
                   morality > 7  ? 0.35 :   // situational: steady grind
                                   0.10;    // already predatory: little room left
  }

  // Outlawed: living outside society, constant threat, cannot seek justice.
  if (conds.includes('outlawed'))          erosionRate += 0.25;

  // Ruined: structural loss — no income, debts, dependents suffering.
  if (conds.includes('ruined'))            erosionRate += 0.15;

  // Chronic illness: daily pain and dependency changes what seems permissible.
  if (conds.includes('chronic_illness'))   erosionRate += 0.10;

  // Indebted: background financial pressure — small daily compromises.
  if (conds.includes('indebted'))          erosionRate += 0.05;

  // Declining health: mortality proximity, loss of hope.
  if (conds.includes('declining_health'))  erosionRate += 0.05;

  // Criminal record: ongoing social stigma makes legitimate paths harder.
  if (conds.includes('criminal_record'))   erosionRate += 0.05;

  if (erosionRate > 0 && morality > 3) {
    const cap = Math.min(0.90, erosionRate);
    if (rand() < cap) return -1;
    return 0;   // active pressure blocks reversion — return early
  }

  // ── ELEVATING CONDITIONS — push above baseline, block downward reversion ──
  // Active positive conditions can temporarily elevate morality above baseline.
  // Once removed, downward reversion pulls it back. The moral inflation of a
  // bishop is real; it also fades if he loses the position and the structure.
  let elevationRate = 0;

  if (char.socialClass === 'clergy')        elevationRate += 0.15;
  if (conds.includes('prosperous'))         elevationRate += 0.08;
  if (conds.includes('devout'))             elevationRate += 0.08;
  if (char.phase === 'sheltered')           elevationRate += 0.10;

  const base = char.baseMorality;
  if (base == null) return 0;

  const gap = base - morality;  // positive = need to go up, negative = need to go down

  if (elevationRate > 0 && morality < 18) {
    // Only elevate if above baseline OR if gap calls for upward movement
    // Don't let elevation push below baseline (that's reversion territory)
    if (gap <= 0) {
      // morality is at or above baseline — elevation can push it higher
      if (rand() < Math.min(0.80, elevationRate)) return +1;
      return 0;  // elevation active, suppress downward reversion
    }
    // morality is below baseline — elevation accelerates reversion (handled below)
  }

  // ── Baseline reversion ─────────────────────────────────────────────────────
  // No active adverse or elevating conditions. The person is in ordinary
  // circumstances and their constitutional character reasserts over time.
  // A decade to close a large gap; faster for small gaps.

  if (gap === 0) return 0;

  // Stability accelerates reversion
  const isStable = char.socialClass === 'clergy' ||
                   char.phase === 'sheltered' ||
                   conds.includes('prosperous') ||
                   conds.includes('devout');

  const rateMult = isStable ? 1.6 : 1.0;

  // elevationRate > 0 and gap > 0 means: positive conditions + below baseline
  // = accelerated upward reversion
  const elevAccel = (elevationRate > 0 && gap > 0) ? 1.5 : 1.0;

  const pRevert = Math.min(0.90, Math.abs(gap) * 0.08 * rateMult * elevAccel);

  if (rand() < pRevert) {
    return gap > 0 ? +1 : -1;
  }

  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// BIRTH ATTRIBUTE GENERATION  (HârnMaster RAW, page 6–8)
//
// Generation order follows the rulebook because later attributes derive from
// earlier ones (Frame → AGL modifier; Weight → STR modifier).
//
// Key attributes (4d6-drop-lowest): STR, STA, DEX, AGL, INT, AUR, WIL
// Non-key (3d6):                    EYE, HRG, SML, VOI, CML
//
// Modifiers applied:
//   STR  –4 to +4  based on Weight band (derived from Height+Frame)
//   AGL  –2 to +2  based on Frame
//   AUR  +2         for human female
//
// All attributes clamped to minimum 1.
// ─────────────────────────────────────────────────────────────────────────────

function rollBirthAttributes(sex, socialClass) {
  // dN(n,x) imported from rng.js
  // 4d6 drop lowest (key attribute rule)
  function key4d6() {
    const d = [dN(1,6), dN(1,6), dN(1,6), dN(1,6)];
    return d.reduce((s,v) => s+v, 0) - Math.min(...d);
  }
  function plain3d6() { return dN(3, 6); }

  const isFemale = sex === 'female';

  // ── Step 1: Frame (3d6, female –3) ────────────────────────────────────────
  let frameRoll = dN(3, 6);
  if (isFemale) frameRoll -= 3;
  let frame, aglFrameMod;
  if      (frameRoll <= 5)  { frame = 'Scant';   aglFrameMod = +2; }
  else if (frameRoll <= 8)  { frame = 'Light';   aglFrameMod = +1; }
  else if (frameRoll <= 12) { frame = 'Medium';  aglFrameMod =  0; }
  else if (frameRoll <= 15) { frame = 'Heavy';   aglFrameMod = -1; }
  else                      { frame = 'Massive'; aglFrameMod = -2; }

  // ── Step 2: Height (inches) ────────────────────────────────────────────────
  // Human: male 54+4d6, female 52+4d6. Class modifier: nobility +2, peasant –1.
  const heightBase = isFemale ? 52 : 54;
  const classMod   = socialClass === 'noble' ? +2 : (socialClass === 'peasant' ? -1 : 0);
  const heightIn   = heightBase + dN(4, 6) + classMod;

  // ── Step 3: Weight (from HGT/WGT table + frame modifier) ──────────────────
  const HGT_WGT = {
    40:75,41:77,42:79,43:81,44:83,45:85,46:87,47:89,48:91,49:93,
    50:95,51:97,52:100,53:103,54:106,55:109,56:112,57:115,58:118,59:121,
    60:124,61:127,62:130,63:133,64:137,65:141,66:145,67:149,68:153,69:157,
    70:160,71:165,72:170,73:175,74:180,75:185,76:190,77:195,78:200,79:205,
    80:210,81:215,82:220,83:225,84:230,85:235,86:240,87:245,88:250,89:255,
  };
  const FRAME_WEIGHT_MOD = { Scant:-0.20, Light:-0.10, Medium:0, Heavy:+0.10, Massive:+0.20 };
  const clampedH   = Math.max(40, Math.min(89, heightIn));
  const baseWeight = HGT_WGT[clampedH] || 153;
  const weightLbs  = Math.round(baseWeight * (1 + (FRAME_WEIGHT_MOD[frame] || 0)));

  // ── Step 4: STR modifier from weight band ────────────────────────────────
  let strWeightMod;
  if      (weightLbs <= 55)  strWeightMod = -4;
  else if (weightLbs <= 85)  strWeightMod = -4;
  else if (weightLbs <= 110) strWeightMod = -3;
  else if (weightLbs <= 130) strWeightMod = -2;
  else if (weightLbs <= 145) strWeightMod = -1;
  else if (weightLbs <= 155) strWeightMod =  0;
  else if (weightLbs <= 170) strWeightMod = +1;
  else if (weightLbs <= 190) strWeightMod = +2;
  else if (weightLbs <= 215) strWeightMod = +3;
  else if (weightLbs <= 245) strWeightMod = +4;
  else                        strWeightMod = +4;

  // ── Step 5: Roll attributes in rulebook order ─────────────────────────────
  const STR = Math.max(1, key4d6() + strWeightMod);
  const STA = Math.max(1, key4d6());
  const DEX = Math.max(1, key4d6());
  const AGL = Math.max(1, key4d6() + aglFrameMod);
  const EYE = Math.max(1, plain3d6());
  const HRG = Math.max(1, plain3d6());
  const SML = Math.max(1, plain3d6());
  const VOI = Math.max(1, plain3d6());
  const INT = Math.max(1, key4d6());
  const AUR = Math.max(1, key4d6() + (isFemale ? 2 : 0));
  const WIL = Math.max(1, key4d6());
  const CML = Math.max(1, plain3d6());

  return { STR, STA, DEX, AGL, EYE, HRG, SML, VOI, INT, AUR, WIL, CML,
           _frame: frame, _heightIn: heightIn, _weightLbs: weightLbs };
}

// ─────────────────────────────────────────────────────────────────────────────
// BIRTH PROFILE  — birthdate, sunsign, piety, medical traits, sibling rank,
//                  family size, estrangement  (HârnMaster RAW pp 3–5, 9, 12)
// ─────────────────────────────────────────────────────────────────────────────

const HARN_MONTHS = [
  'Nuzyael','Peonu','Kelen','Nolus','Larane','Agrazhar',
  'Azura','Halane','Savor','Ilvin','Navek','Morgat',
];

// Sunsign date ranges — [monthIdx 0-based, dayStart, monthIdx, dayEnd]
// Source: Character_Generation.pdf p3
const SUNSIGN_RANGES = [
  { sign:'Ulandus',    start:[0,4],  end:[1,3]  },
  { sign:'Aralius',    start:[1,4],  end:[2,2]  },
  { sign:'Feneri',     start:[2,3],  end:[3,3]  },
  { sign:'Ahnu',       start:[3,4],  end:[4,4]  },
  { sign:'Angberelius',start:[4,5],  end:[5,6]  },
  { sign:'Nadai',      start:[5,7],  end:[6,5]  },
  { sign:'Hirin',      start:[6,6],  end:[7,4]  },
  { sign:'Tarael',     start:[7,5],  end:[8,3]  },
  { sign:'Tai',        start:[8,4],  end:[9,2]  },
  { sign:'Skorus',     start:[9,3],  end:[10,2] },
  { sign:'Masara',     start:[10,3], end:[11,1] },
  { sign:'Lado',       start:[11,2], end:[0,3]  },
];

function sunsignFromDate(monthIdx, day) {
  // Convert to a simple ordinal (1-360) for comparison
  const ord = monthIdx * 30 + day;
  for (const r of SUNSIGN_RANGES) {
    const s = r.start[0] * 30 + r.start[1];
    let   e = r.end[0]   * 30 + r.end[1];
    if (r.sign === 'Lado') {  // wraps year boundary
      if (ord >= s || ord <= e) return r.sign;
      continue;
    }
    if (ord >= s && ord <= e) return r.sign;
  }
  return 'Ulandus'; // fallback
}

// Medical trait table (1d100, human, RAW p9).
// Each entry: { maleRange, femaleRange, id, label, attrDeltas, conditions }
// Only the mechanically significant traits are modelled. Flavour-only entries
// (Addiction, Allergy, Parasites, Lycanthropy, etc.) are noted as conditions.
const MEDICAL_TRAIT_TABLE = [
  { m:[1,8],   f:[1,5],   id:'addiction',    label:'Addiction',            attrDeltas:null, conditions:['addicted'] },
  { m:[9,9],   f:[6,6],   id:'albinism',     label:'Albinism',             attrDeltas:null, conditions:['albino'] },
  { m:[10,14], f:[7,10],  id:'allergy',      label:'Allergy',              attrDeltas:null, conditions:['allergy'] },
  { m:[15,17], f:[11,14], id:'ambidextrous', label:'Ambidextrous',         attrDeltas:{ DEX:2 }, conditions:[] },
  { m:[18,20], f:[15,15], id:'missing_arm',  label:'Arm missing/deformed', attrDeltas:{ DEX:-2 }, conditions:['lame'] },
  { m:[21,24], f:[16,19], id:'birthmark',    label:'Birthmark',            attrDeltas:{ CML:-2 }, conditions:[] },
  { m:[25,25], f:[20,20], id:'dwarfism',     label:'Dwarfism',             attrDeltas:null, conditions:['dwarfism'] },
  { m:[26,27], f:[21,22], id:'epilepsy',     label:'Epilepsy',             attrDeltas:{ INT:2 }, conditions:['epilepsy'] },
  { m:[28,28], f:[23,23], id:'deaf_ear',     label:'Deaf in one ear',      attrDeltas:{ HRG:-2 }, conditions:[] },
  { m:[29,30], f:[24,25], id:'blind_eye',    label:'Blind in one eye',     attrDeltas:{ EYE:-2 }, conditions:[] },
  { m:[31,31], f:[26,26], id:'gigantism',    label:'Gigantism',            attrDeltas:null, conditions:['gigantism'] },
  { m:[33,33], f:[28,29], id:'hirsutism',    label:'Hirsutism',            attrDeltas:{ CML:-2 }, conditions:[] },
  { m:[34,35], f:[30,30], id:'missing_leg',  label:'Leg missing/deformed', attrDeltas:null, conditions:['lame'] },
  { m:[36,39], f:[31,40], id:'left_handed',  label:'Left-handed',          attrDeltas:{ DEX:1 }, conditions:[] },
  { m:[40,41], f:[41,42], id:'leprosy',      label:'Leprosy',              attrDeltas:{ CML:-6 }, conditions:['chronic_illness'] },
  { m:[43,44], f:[44,45], id:'monochromasia',label:'Colour blind',         attrDeltas:{ EYE:-2 }, conditions:[] },
  { m:[45,47], f:[46,48], id:'obesity',      label:'Obesity',              attrDeltas:{ AGL:-2 }, conditions:[] },
  { m:[48,57], f:[49,58], id:'parasites',    label:'Parasites',            attrDeltas:null, conditions:[] },
  { m:[58,60], f:[59,61], id:'poxmarks',     label:'Poxmarks',             attrDeltas:{ CML:-2 }, conditions:['scarred'] },
  { m:[61,63], f:[62,63], id:'scars',        label:'Birth scars',          attrDeltas:{ CML:-2 }, conditions:['scarred'] },
  { m:[64,65], f:[64,65], id:'sterile',      label:'Sterile',              attrDeltas:null, conditions:['sterile'] },
];

function rollMedicalTrait(sex) {
  const roll = dN(1,100);
  const isFemale = sex === 'female';

  // 66–70 Multiple traits
  if (roll >= 66 && roll <= 70) {
    // Roll twice more (can cascade once only)
    const t1 = rollMedicalTraitAt(dN(1,65), isFemale);
    const t2 = rollMedicalTraitAt(dN(1,65), isFemale);
    const traits = [t1, t2].filter(Boolean);
    return traits.length ? traits : null;
  }
  // 71–00 No medical traits
  if (roll >= 71) return null;

  const t = rollMedicalTraitAt(roll, isFemale);
  return t ? [t] : null;
}

function rollMedicalTraitAt(roll, isFemale) {
  for (const entry of MEDICAL_TRAIT_TABLE) {
    const [lo, hi] = isFemale ? entry.f : entry.m;
    if (roll >= lo && roll <= hi) return entry;
  }
  return null;
}

function applyMedicalTraits(traits, attrs, conditions) {
  if (!traits) return;
  for (const trait of traits) {
    if (trait.attrDeltas) {
      for (const [attr, delta] of Object.entries(trait.attrDeltas)) {
        if (attrs[attr] !== undefined) attrs[attr] = Math.max(1, Math.min(21, attrs[attr] + delta));
      }
    }
    for (const cond of trait.conditions) {
      if (!conditions.includes(cond)) conditions.push(cond);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LIFE EXPECTANCY + DEGENERATION (RAW p20)
// Rolled once at creation; applied year-by-year in the loop.
// ─────────────────────────────────────────────────────────────────────────────

function rollLifeExpectancy(sex, socialClass) {
  // Pagaelin: harsher environment, endemic violence, erratic diet, no medicine.
  // Base 42 male / 38 female, ±3d6, no income modifier.
  if (socialClass === 'pagaelin') {
    const base = sex === 'female' ? 44 : 48;
    return base + dN(3, 6);
  }
  const base   = sex === 'female' ? 55 : 50;
  const roll   = dN(3, 6);
  // Class income proxy: noble/merchant = high (+5), peasant/soldier = average (0)
  const income = ['noble','merchant'].includes(socialClass) ? +5
               : ['peasant','soldier'].includes(socialClass) ? 0 : +2;
  return base + roll + income;
}

// AGING TABLE — applied once per year from (lifeExpectancy − 10) onward.
// Each entry: { threshold, attr, reduction, condition }
// Roll 1d100 + age; if result exceeds threshold, effect occurs.
const AGING_TABLE = [
  { threshold: 106, label: 'Weight gain',        attr: null,  reduction: null, condition: null },  // cosmetic
  { threshold: 111, label: 'Stamina loss',        attr: 'STA', reduction: 1,    condition: null },
  { threshold: 111, label: 'Vision impairment',   attr: 'EYE', reduction: 1,    condition: null },
  { threshold: 101, label: 'Hearing loss',        attr: 'HRG', reduction: 1,    condition: null },
  { threshold: 106, label: 'Senility',            attr: 'INT', reduction: 1,    condition: null },
  {
    threshold: 96,  label: 'Arthritis/Rheumatism',
    attr: null, reduction: null, condition: null,
    special: 'arthritis',  // handles DEX+AGL roll separately
  },
  { threshold: 111, label: 'Gout',               attr: 'AGL', reduction: null, condition: null, special: 'gout' },
  { threshold: 141, label: 'Chronic disease',    attr: null,  reduction: null, condition: 'chronic_illness' },
  { threshold: 136, label: 'Heart attack/stroke',attr: 'STA', reduction: 3,    condition: 'chronic_illness', special: 'heart' },
];

function applyAgingForYear(char, age) {
  const effects = [];

  for (const row of AGING_TABLE) {
    const roll = dN(1,100) + age;
    if (roll <= row.threshold) continue;  // no effect this year

    if (row.special === 'arthritis') {
      // Reduce DEX and/or AGL by 1d3−1 (0–2) each
      const dDex = Math.max(0, dN(1,3) - 1);
      const dAgl = Math.max(0, dN(1,3) - 1);
      if (dDex > 0) char.attributes.DEX = Math.max(1, char.attributes.DEX - dDex);
      if (dAgl > 0) char.attributes.AGL = Math.max(1, char.attributes.AGL - dAgl);
      if (dDex > 0 || dAgl > 0) effects.push('Arthritis');
    } else if (row.special === 'gout') {
      const reduction = dN(1,3) + 1;  // 1d3+1
      char.attributes.AGL = Math.max(1, char.attributes.AGL - reduction);
      effects.push('Gout');
    } else if (row.special === 'heart') {
      // Treat as chronic disease + STA hit (failed endurance test abstracted)
      if (!char.conditions.includes('chronic_illness')) char.conditions.push('chronic_illness');
      char.attributes.STA = Math.max(1, char.attributes.STA - 3);
      effects.push('Heart attack/stroke');
    } else {
      if (row.attr) {
        char.attributes[row.attr] = Math.max(1, char.attributes[row.attr] - (row.reduction || 1));
      }
      if (row.condition && !char.conditions.includes(row.condition)) {
        char.conditions.push(row.condition);
      }
      effects.push(row.label);
    }
  }

  return effects;
}

/**
 * Deterministic integer hash of a string — used to derive a reproducible seed
 * for stub expansion. Returns a positive integer.
 */
function hashId(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h;
}

/**
 * Roll a birth settlement type for a given social class.
 */
function rollBirthSettlement(cls) {
  const weights = BIRTH_SETTLEMENT_WEIGHTS[cls] || BIRTH_SETTLEMENT_WEIGHTS.peasant;
  const total   = weights.reduce((s, w) => s + w, 0);
  let roll      = rand() * total;
  for (let i = 0; i < SETTLEMENT_TYPES.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return SETTLEMENT_TYPES[i];
  }
  return SETTLEMENT_TYPES[SETTLEMENT_TYPES.length - 1];
}

/**
 * Roll the tribal alignment for a Pagaelin NPC at birth.
 * Returns 'traditional' | 'syncretist' | 'walker_dominated'.
 * Weights are defined in CULTURE_CONFIGS.pagaelin.tribalAlignmentWeights.
 * The situation is escalating at 720 TR — walker_dominated fraction growing.
 */
function rollTribalAlignment() {
  const cfg = CULTURE_CONFIGS.pagaelin;
  const weights = cfg.tribalAlignmentWeights;
  const alignments = cfg.tribalAlignments;
  const total = weights.reduce((s, w) => s + w, 0);
  let roll = rand() * total;
  for (let i = 0; i < alignments.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return alignments[i];
  }
  return alignments[alignments.length - 1];
}

/**
 * Apply a settlement transition triggered by an event.
 * Returns { next: settlementType, reason: string|null }.
 * reason is null if no meaningful movement occurred.
 */
function applySettlementTransition(eventId, current, sex) {
  const t = SETTLEMENT_TRANSITIONS[eventId];
  if (!t) return { next: current, reason: null };

  let next = current;
  if (t.to) {
    next = t.to;
  } else if (t.shift !== undefined && t.shift !== 0) {
    const idx    = SETTLEMENT_TYPES.indexOf(current);
    const newIdx = Math.max(0, Math.min(SETTLEMENT_TYPES.length - 1, idx + t.shift));
    next = SETTLEMENT_TYPES[newIdx];
  }

  // Only return a reason if there was actual movement
  if (next === current) return { next, reason: null };

  const reason = t.reason
    ? (t.reason[sex] || t.reason.male || null)
    : null;

  return { next, reason };
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function getAgeGroup(age) {
  for (const [group, { min, max }] of Object.entries(AGE_GROUPS)) {
    if (age >= min && age <= max) return group;
  }
  return 'old';
}

/**
 * Weighted random selection from an array of [item, weight] pairs.
 * Returns the selected item, or null if the table is empty / all weights zero.
 */
function weightedRandom(table) {
  const total = table.reduce((sum, [, w]) => sum + w, 0);
  if (total <= 0) return null;
  let roll = rand() * total;
  for (const [item, weight] of table) {
    roll -= weight;
    if (roll <= 0) return item;
  }
  return table[table.length - 1][0];
}

/**
 * Build the weighted draw table for a single year.
 *
 * @param {object}  char        - Current character state
 * @param {string}  ageGroup    - 'young' | 'middle' | 'old'
 * @param {Map}     followOns   - Map<eventId, { weightMod, yearsLeft }>
 * @param {string}  pool        - 'biographical' | 'family' | null (all)
 * @param {object}  archetype   - Resolved archetype object or null
 * @param {Map}     recentFires - Map<eventId, lastFiredAge> for minGapYears enforcement
 * @param {boolean} explain     - If true, returns { table, breakdown } where breakdown is
 *                                an array of per-event weight component objects, including
 *                                events that were filtered out (with a rejectedReason field).
 *                                Useful for debugging unexpected event frequencies.
 * @returns {Array|{table,breakdown}}
 */
function buildDrawTable(char, ageGroup, followOns, pool = null, archetype = null, recentFires = null, explain = false) {
  const { socialClass, sex, conditions, phase, rootless } = char;
  const condSet = new Set(conditions);

  // 'married' is a derived boolean — true iff there is a living spouse.
  // It is NOT stored in char.conditions; it is computed here at draw time
  // so that the spouses array is always the single source of truth.
  // Events may still reference 'married' in requireConditions/excludeConditions
  // and the draw table will honour those via this derived flag.
  if (char._spousesRef && char._spousesRef.some(s => s.status === 'alive')) {
    condSet.add('married');
  } else {
    condSet.delete('married');
  }
  const table   = [];
  const breakdown = explain ? [] : null;

  for (const event of LIFE_EVENTS) {
    // ── pool filter ───────────────────────────────────────────────────────
    if (pool && event.pool !== pool) {
      if (explain) breakdown.push({ id: event.id, rejectedReason: `pool:${event.pool}≠${pool}` });
      continue;
    }

    // ── eligibility checks ────────────────────────────────────────────────
    // excludeClasses: if present, event is blocked for those classes.
    // classes: legacy whitelist — still honoured if present, but new events
    //          should use excludeClasses instead. If neither is present,
    //          event is eligible for all classes.
    if (event.excludeClasses && event.excludeClasses.includes(socialClass)) {
      if (explain) breakdown.push({ id: event.id, rejectedReason: `class:${socialClass} in excludeClasses` });
      continue;
    }
    if (event.classes && !event.classes.includes(socialClass)) {
      if (explain) breakdown.push({ id: event.id, rejectedReason: `class:${socialClass} not in [${event.classes}]` });
      continue;
    }
    if (!event.ageGroups.includes(ageGroup)) {
      if (explain) breakdown.push({ id: event.id, rejectedReason: `ageGroup:${ageGroup} not in [${event.ageGroups}]` });
      continue;
    }

    // Optional minimum age
    if (event.minAge && char.age < event.minAge) {
      if (explain) breakdown.push({ id: event.id, rejectedReason: `minAge:${event.minAge}>age:${char.age}` });
      continue;
    }
    if (event.maxAge && char.age > event.maxAge) {
      if (explain) breakdown.push({ id: event.id, rejectedReason: `maxAge:${event.maxAge}<age:${char.age}` });
      continue;
    }

    // Sex exclusivity: null flavour = exclusive to the other sex
    if (sex === 'male'   && event.flavour.male   === null) {
      if (explain) breakdown.push({ id: event.id, rejectedReason: 'sex:female-only' });
      continue;
    }
    if (sex === 'female' && event.flavour.female === null) {
      if (explain) breakdown.push({ id: event.id, rejectedReason: 'sex:male-only' });
      continue;
    }

    // Required conditions (all must be present)
    const missingReq = event.requireConditions.filter(c => !condSet.has(c));
    if (missingReq.length > 0) {
      if (explain) breakdown.push({ id: event.id, rejectedReason: `requireConditions missing: [${missingReq}]` });
      continue;
    }

    // Excluded conditions (none must be present)
    const presentExcl = event.excludeConditions.filter(c => condSet.has(c));
    if (presentExcl.length > 0) {
      if (explain) breakdown.push({ id: event.id, rejectedReason: `excludeConditions present: [${presentExcl}]` });
      continue;
    }

    // minGapYears: suppress if this event fired too recently
    if (event.minGapYears && recentFires) {
      const lastFired = recentFires.get(event.id);
      if (lastFired != null && (char.age - lastFired) < event.minGapYears) {
        if (explain) breakdown.push({ id: event.id, rejectedReason: `minGapYears:${event.minGapYears} (lastFired age ${lastFired}, now ${char.age})` });
        continue;
      }
    }

    // ── weight calculation ─────────────────────────────────────────────────
    // Look up weights for this class. If not present, fall back to 'unguilded'
    // then 'peasant' as generic baselines for Kaldoric classes without explicit
    // weights — they get reasonable default behaviour rather than being excluded.
    //
    // Exception: Pagaelin and other non-Kaldoric cultures must NOT fall back to
    // Kaldoric baselines. If an event has no explicit 'pagaelin' weight entry,
    // it does not fire for Pagaelin NPCs. This prevents Kaldoric social events
    // (guild disputes, franchise acquisition, debt cycles) from bleeding into
    // a culture that has none of those institutions.
    const KALDORIC_FALLBACK_CULTURES = new Set(['kaldor']);
    const charCulture = CLASS_CULTURE_MAP[socialClass] || 'kaldor';
    const classWeights = event.weights[socialClass]
      || (KALDORIC_FALLBACK_CULTURES.has(charCulture)
          ? (event.weights['unguilded'] || event.weights['peasant'])
          : null)
      || null;
    if (!classWeights) {
      if (explain) breakdown.push({ id: event.id, rejectedReason: `no weights for class:${socialClass}` });
      continue;
    }

    const base       = classWeights[ageGroup] || 0;
    const sexMod  = event.sexWeightMod ? (event.sexWeightMod[sex] || 0) : 0;

    let condMod = 0;
    const condModDetail = {};
    for (const [cond, mod] of Object.entries(event.conditionWeightMods || {})) {
      if (condSet.has(cond)) { condMod += mod; if (explain) condModDetail[cond] = mod; }
    }

    const rootlessMod  = (rootless && event.rootlessWeightMod) ? event.rootlessWeightMod : 0;
    const phaseMod     = (phase && event.phaseWeightMods?.[phase]) ? event.phaseWeightMods[phase] : 0;

    let ageTaperMod = 0;
    if (event.ageWeightTaper) {
      const brackets = event.ageWeightTaper[sex] || null;
      if (brackets) {
        for (const [upToAge, mod] of brackets) {
          if (char.age <= upToAge) { ageTaperMod = mod; break; }
        }
      }
    }

    const fo           = followOns.get(event.id);
    const followOnMod  = fo ? fo.weightMod : 0;

    const archetypeMod = (archetype?.eventWeightMods?.[event.id] !== undefined)
      ? archetype.eventWeightMods[event.id] : 0;

    const settleMod = (char.settlementType && SETTLEMENT_EVENT_WEIGHTS[event.id])
      ? (SETTLEMENT_EVENT_WEIGHTS[event.id][char.settlementType] || 0) : 0;

    let moralityMod = 0;
    if (event.moralityWeighted && char.morality !== undefined) {
      const band = getMoralityBand(char.morality);
      const moralityMods = { predatory: +12, corruptible: +6, situational: 0, honest: -6, principled: -10 };
      const baseMod    = moralityMods[band] || 0;
      const settleMult = CRIMINAL_SETTLEMENT_OPPORTUNITY[char.settlementType] || 1.0;
      moralityMod = Math.round(baseMod * settleMult);
    }

    // ── OCEAN personality modifier ────────────────────────────────────────────
    // Events can declare oceanWeightMod: { O: n, C: n, E: n, A: n, N: n }
    // Each value is the weight adjustment per 10 points of that trait above 50
    // (or below 50 for negative values). Score 50 = neutral; 100 = +5×value; 1 = -4.9×value.
    // Example: { O: +2, C: -2 } means high-Openness adds weight, high-Conscientiousness removes it.
    let oceanMod = 0;
    if (event.oceanWeightMod && char.oceanScores) {
      for (const [trait, perTen] of Object.entries(event.oceanWeightMod)) {
        const score = char.oceanScores[trait];
        if (score == null) continue;
        // Deviation from 50, in units of 10; clamped to ±5 to prevent extreme swings
        const deviation = Math.max(-5, Math.min(5, (score - 50) / 10));
        oceanMod += Math.round(deviation * perTen);
      }
    }

    let weight = base + sexMod + condMod + rootlessMod + phaseMod + ageTaperMod + followOnMod + archetypeMod + settleMod + moralityMod + oceanMod;

    // Archetype minSettlingAge — suppress settling events below archetype's floor
    let settlingClamped = false;
    if (archetype && archetype.minSettlingAge && char.age < archetype.minSettlingAge) {
      const SETTLING_EVENTS = new Set([
        'joined_garrison','hired_as_bodyguard','promoted_sergeant',
        'established_workshop','joined_guild','masterwork_created',
        'spare_finds_position','court_appointment','enfeoffed',
        'father_dies_heir_inherits',
      ]);
      if (SETTLING_EVENTS.has(event.id)) { weight = Math.min(weight, 0); settlingClamped = true; }
    }

    // Floor at zero
    weight = Math.max(0, weight);

    if (explain) {
      breakdown.push({
        id: event.id, label: event.label,
        finalWeight: weight,
        components: { base, sexMod, condMod, condModDetail, rootlessMod, phaseMod,
                      ageTaperMod, followOnMod, archetypeMod, settleMod, moralityMod, oceanMod },
        settlingClamped,
        rejectedReason: weight <= 0 ? 'weight≤0 after modifiers' : null,
      });
    }

    if (weight <= 0) continue;
    table.push([event, weight]);
  }

  if (explain) return { table, breakdown };
  return table;
}

/**
 * Draw a specific colour event from the colour subtable.
 *
 * Filters pool:'colour' events by:
 *   - class, ageGroup, sex (via buildDrawTable logic, inline here to avoid pool mismatch)
 *   - requireConditions / excludeConditions
 *   - rootlessWeightMod, phaseWeightMods, ageWeightTaper
 *   - propagateTo family filter: event only eligible if the character
 *     has the required living family members
 *       'spouse'          → at least one living spouse
 *       'children_over_5' → at least one child aged > 5
 *       'parents'         → always eligible (parents assumed present when young)
 *
 * Returns the winning colour event object, or null if the table is empty.
 */
function resolveColourEvent(char, ageGroup, spouses, children, archetype = null) {
  const hasSpouse         = spouses && spouses.some(s => s.status === 'alive');
  const hasChildOver5     = children && children.some(c => (char.age - c.bornAtPrincipalAge) > 5);

  // Build a condition set that includes the derived 'married' flag
  const condSet = new Set(char.conditions);
  if (hasSpouse) condSet.add('married'); else condSet.delete('married');

  const table = [];

  for (const ev of LIFE_EVENTS) {
    if (!ev || ev.pool !== 'colour') continue;

    // Age group filter
    if (!ev.ageGroups.includes(ageGroup)) continue;

    // Class filter
    const classWeights = ev.weights[char.socialClass];
    if (!classWeights) continue;
    const baseWeight = classWeights[ageGroup];
    if (!baseWeight || baseWeight <= 0) continue;

    // Sex filter (null flavour = no text for that sex → skip)
    if (char.sex === 'male'   && ev.flavour.male   === null) continue;
    if (char.sex === 'female' && ev.flavour.female === null) continue;

    // Condition filters
    if (ev.requireConditions && ev.requireConditions.length > 0) {
      if (!ev.requireConditions.every(c => condSet.has(c))) continue;
    }
    if (ev.excludeConditions && ev.excludeConditions.length > 0) {
      if (ev.excludeConditions.some(c => condSet.has(c))) continue;
    }

    // Family filter for propagateTo events
    if (ev.propagateTo && ev.propagateTo.length > 0) {
      const needs = ev.propagateTo;
      if (needs.includes('spouse') && !hasSpouse) continue;
      if (needs.includes('children_over_5') && !hasChildOver5) continue;
      // 'parents' always allowed (assumed present for young; old characters can reminisce)
    }

    // Build effective weight
    let w = baseWeight;

    if (char.rootless && ev.rootlessWeightMod) {
      w += ev.rootlessWeightMod;
    }
    if (ev.phaseWeightMods && char.phase && ev.phaseWeightMods[char.phase] !== undefined) {
      w += ev.phaseWeightMods[char.phase];
    }
    if (ev.conditionWeightMods) {
      for (const [cond, mod] of Object.entries(ev.conditionWeightMods)) {
        if (condSet.has(cond)) w += mod;
      }
    }
    if (ev.sexWeightMod && ev.sexWeightMod[char.sex]) {
      w += ev.sexWeightMod[char.sex];
    }
    // ageWeightTaper: first matching bracket wins
    if (ev.ageWeightTaper && ev.ageWeightTaper[char.sex]) {
      for (const [maxAge, mod] of ev.ageWeightTaper[char.sex]) {
        if (char.age <= maxAge) { w += mod; break; }
      }
    }

    // Archetype colour modifier
    if (archetype && archetype.colourWeightMods && archetype.colourWeightMods[ev.id] !== undefined) {
      w += archetype.colourWeightMods[ev.id];
    }

    if (w <= 0) continue;
    table.push([ev, w]);
  }

  if (table.length === 0) return null;
  return weightedRandom(table);
}

/**
 * Apply an event's OP effects to the character's OP budget for the year.
 * Total OPs consumed by an event cannot exceed the annual budget.
 * Returns { freeOPs, skillOPs, totalSpent }.
 *
 * skillOPs is an array of { skill, ops } with amounts scaled down proportionally
 * if the total would exceed the budget.
 */
function applyOPs(event, annualBudget) {
  if (!event.effects) return { freeOPs: 0, skillOPs: [], totalSpent: 0 };
  const { ops: freeOPs, skills: skillDefs, totalOPs: desired } = event.effects;

  if (desired <= 0) return { freeOPs: 0, skillOPs: [], totalSpent: 0 };

  // Scale down if event wants more than the budget allows
  const scale     = desired > annualBudget ? annualBudget / desired : 1;
  const spentFree = Math.round(freeOPs * scale);
  const skillOPs  = (skillDefs || []).map(s => ({
    skill: s.skill,
    ops:   Math.max(1, Math.round(s.ops * scale)),
  }));

  // Re-check total after rounding — clamp to budget
  const totalSpent = Math.min(annualBudget, spentFree + skillOPs.reduce((s, x) => s + x.ops, 0));

  return { freeOPs: spentFree, skillOPs, totalSpent };
}

// ─────────────────────────────────────────────────────────────────────────────
// RH INCOMPATIBILITY RESOLUTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determine whether a pregnancy proceeds normally or ends in miscarriage/stillbirth
 * based on maternal Rh status, sensitisation, and the current father's Rh type.
 *
 * Called when 'pregnant' condition is present and a birth/miscarriage event fires.
 *
 * Returns:
 *   { outcome: 'normal' | 'miscarriage' | 'stillbirth',
 *     fatherRhPositive: bool,
 *     sensitisedNow: bool,   // true if sensitisation occurs this pregnancy
 *     note: string }         // GM flavour note
 */
function resolveRhOutcome(char, currentSpouse) {
  // Only relevant for Rh-negative mothers
  if (!char.conditions.includes('rh_negative')) {
    return { outcome: 'normal', fatherRhPositive: true, sensitisedNow: false, note: null };
  }

  // Roll father's Rh type — use current spouse if known, else random
  const fatherRhPositive = currentSpouse
    ? currentSpouse.rhPositive
    : (rand() < 0.85);

  // If father is Rh-negative, no problem — foetus is Rh-negative
  if (!fatherRhPositive) {
    return { outcome: 'normal', fatherRhPositive: false, sensitisedNow: false,
      note: 'Rh-negative father — no incompatibility.' };
  }

  // Father is Rh-positive
  const alreadySensitised = char.conditions.includes('sensitised');

  if (!alreadySensitised) {
    // First Rh-incompatible pregnancy: usually proceeds normally.
    // Sensitisation occurs at delivery (or miscarriage/difficult birth).
    // ~5% chance of problems even first time (partial sensitisation from previous loss)
    if (rand() < 0.05) {
      return { outcome: 'miscarriage', fatherRhPositive: true, sensitisedNow: true,
        note: 'Rh-negative mother, Rh-positive father. First sensitising pregnancy — rare early loss.' };
    }
    return { outcome: 'normal', fatherRhPositive: true, sensitisedNow: true,
      note: 'Rh-negative mother, Rh-positive father. First pregnancy proceeds normally; sensitisation occurs at birth.' };
  }

  // Already sensitised + Rh-positive father: ~75% chance of foetal loss
  const roll = rand();
  if (roll < 0.55) {
    return { outcome: 'miscarriage', fatherRhPositive: true, sensitisedNow: false,
      note: 'Rh-sensitised mother, Rh-positive father. Foetal haemolytic disease — miscarriage.' };
  }
  if (roll < 0.75) {
    return { outcome: 'stillbirth', fatherRhPositive: true, sensitisedNow: false,
      note: 'Rh-sensitised mother, Rh-positive father. Foetal haemolytic disease — stillbirth.' };
  }
  // 25% chance of live birth despite sensitisation (Rh-negative foetus by chance, or mild reaction)
  return { outcome: 'normal', fatherRhPositive: true, sensitisedNow: false,
    note: 'Rh-sensitised mother, Rh-positive father. Live birth despite sensitisation (foetus Rh-negative, or mild reaction).' };
}

// ─────────────────────────────────────────────────────────────────────────────
// CHILD DEATH SELECTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Select a living child to die, weighted inversely by age.
 * Younger children have much higher mortality risk.
 */
// ─────────────────────────────────────────────────────────────────────────────
// PREGNANCY OUTCOME RESOLVER (module-level, independently testable)
// ─────────────────────────────────────────────────────────────────────────────
//
// All state is passed explicitly via `ctx` — no closure dependency.
// The inner closure wrapper inside ageCharacter() calls this with a ctx
// built from the per-character closure variables.
//
// ctx shape:
//   char           {object}   Character state — conditions and attributes are mutated
//   isFemale       {boolean}
//   rand           {function} Seeded RNG () => [0,1)
//   currentSpouse  {function} () => spouse record | null
//   name           {object|null} { surname } for child stub
//   children       {Array}    Mutated: new child stubs pushed here
//   familyFollowOns {Map}     Mutated: follow-on entries set here
//
// Returns a PregnancyOutcome object (see return statement for shape).
//
// ─────────────────────────────────────────────────────────────────────────────
// PREGNANCY SYSTEM  — single authoritative pregnancy resolver
// ─────────────────────────────────────────────────────────────────────────────
//
// All child creation passes through here. No other code calls generateChildStub.
//
// ctx shape:
//   char            {object}   Character state — conditions and attributes mutated
//   isFemale        {boolean}
//   rand            {function} Seeded RNG () => [0,1)
//   currentSpouse   {function} () => spouse stub | null
//   name            {object|null} { surname }
//   children        {Array}    Mutated: new child stubs pushed here
//   spouses         {Array}    For updating father stub sharedEvents
//   familyFollowOns {Map}      Mutated: follow-on entries set here
//   birthYear       {number}   Principal's birth year (for child birthYear)
//   hashId          {function} Deterministic string → integer seed
//
// Returns a PregnancyResult:
//   { outcome, weeks, eventId, eventLabel, flavour, child, twin, twins,
//     disability, difficult, rhNote, relationalNote }
//
// The caller is responsible for recording the result in the history entry
// and for NOT calling generateChildStub anywhere else.
//
function resolvePregnancy(ctx, age, ageGroup, maternalAge = age) {
  const {
    char, isFemale, rand, currentSpouse, name, children, spouses,
    familyFollowOns, birthYear: ctxBirthYear, hashId: ctxHashId,
  } = ctx;

  const DISABILITY_TYPES = [
    'lame','lame','lame','lame','lame','lame','lame',              // 35%
    'simple','simple','simple','simple','simple','simple','simple', // 35%
    'blind','blind','blind',                                        // 15%
    'deaf','deaf','deaf',                                           // 15%
  ];

  // ── Base rates ──────────────────────────────────────────────────────────────
  let pMiscarriage = 0.22;
  let pStillbirth  = 0.07;

  // ── Modifiers — maternal conditions ─────────────────────────────────────────
  if (isFemale) {
    if (char.conditions.includes('chronic_illness')) { pMiscarriage += 0.08; pStillbirth += 0.03; }
    if (char.conditions.includes('sensitised'))      { pStillbirth  += 0.15; }
  }

  // ── Modifiers — maternal age (smooth per-year escalation from 35) ─────────
  // Risk rises gradually from 35, accelerates after 40, becomes severe at 44+.
  // Each year over 35 adds a compounding increment — not a step function.
  //   Age 35: baseline
  //   Age 38: miscarriage ~32%, stillbirth ~11%
  //   Age 41: miscarriage ~44%, stillbirth ~16%
  //   Age 44: miscarriage ~57%, stillbirth ~22%
  if (maternalAge >= 35) {
    const yearsOver35 = maternalAge - 35;
    // Miscarriage: +2.5% per year 35-40, +4% per year 40+
    const misBase = Math.min(yearsOver35, 5) * 0.025;
    const misHigh = Math.max(0, yearsOver35 - 5) * 0.040;
    pMiscarriage += misBase + misHigh;
    // Stillbirth: +1% per year 35-40, +2% per year 40+
    const sbBase = Math.min(yearsOver35, 5) * 0.010;
    const sbHigh = Math.max(0, yearsOver35 - 5) * 0.020;
    pStillbirth += sbBase + sbHigh;
  }

  // ── Roll outcome ─────────────────────────────────────────────────────────────
  const roll = rand();
  let outcome;
  if      (roll < pMiscarriage)               outcome = 'miscarriage';
  else if (roll < pMiscarriage + pStillbirth) outcome = 'stillbirth';
  else                                         outcome = 'live_birth';

  // ── Gestational week ─────────────────────────────────────────────────────────
  let weeks;
  if      (outcome === 'miscarriage') weeks = Math.floor(rand() * 17) + 4;
  else if (outcome === 'stillbirth')  weeks = Math.floor(rand() * 19) + 21;
  else                                weeks = 40;

  // ── Rh sensitisation ─────────────────────────────────────────────────────────
  let rhNote = null;
  if (isFemale && outcome !== 'miscarriage') {
    const rh = resolveRhOutcome(char, currentSpouse());
    rhNote = rh.note;
    if (rh.sensitisedNow && !char.conditions.includes('sensitised')) {
      char.conditions.push('sensitised');
    }
    if (rh.outcome === 'stillbirth' && outcome === 'live_birth') {
      outcome = 'stillbirth'; weeks = Math.floor(rand() * 19) + 21;
    } else if (rh.outcome === 'miscarriage' && outcome === 'live_birth') {
      outcome = 'miscarriage'; weeks = Math.floor(rand() * 17) + 4;
    }
  }

  // ── Live birth ───────────────────────────────────────────────────────────────
  let child      = null;
  let twin       = null;
  let difficult  = false;
  let disability = null;
  let eventId    = outcome === 'miscarriage' ? 'miscarriage' : 'stillbirth';
  let eventLabel = outcome === 'miscarriage' ? 'Miscarriage' : 'Stillbirth';

  if (outcome === 'live_birth') {
    let pDifficult  = 0.15;
    let pDisability = 0.04;
    // Difficult birth and disability: smooth escalation from 35
    // pDifficult: +2% per year 35-40, +4% per year 40+ (caps ~65% at 46)
    // pDisability: +0.8% per year 35-40, +1.5% per year 40+ (caps ~15% at 46)
    if (maternalAge >= 35) {
      const y = maternalAge - 35;
      pDifficult  += Math.min(y, 5) * 0.020 + Math.max(0, y - 5) * 0.040;
      pDisability += Math.min(y, 5) * 0.008 + Math.max(0, y - 5) * 0.015;
    }
    if (isFemale && char.conditions.includes('chronic_illness')) {
      pDifficult += 0.08; pDisability += 0.03;
    }

    // ── Skilled midwife access (Peonian Esolani or equivalent) ──────────────
    // Access is derived from social class and settlement — not a fired event.
    // A skilled attendant reduces pDifficult by 40-50% of its current value,
    // reflecting genuine pre-modern improvement from skilled birth attendance.
    // Pagaelin use a separate birth system; access is always 0 for them.
    if (isFemale && char.socialClass !== 'pagaelin' && char.socialClass !== 'walker_shaman') {
      const settlement  = char.settlementType || 'village';
      const isUrban     = settlement === 'city' || settlement === 'town';
      const isRural     = !isUrban; // village, hamlet, camp
      const isIsolated  = settlement === 'hamlet' || settlement === 'camp';

      const ruined   = char.conditions.includes('ruined');
      const indebted = char.conditions.includes('indebted');
      const prosperous = char.conditions.includes('prosperous');
      const devoutPeoni = char.conditions.includes('devout') && char.publicDeity === 'Peoni';
      const herbalist  = char.conditions.includes('skilled_herbalist');

      // ── URBAN ACCESS ──────────────────────────────────────────────────────
      // Peonian hospitals, guild physicians, and trained midwives are in towns
      // and cities. Access here IS primarily about money — the Peonian asks
      // for a donation, the physician charges a fee. The destitute get charity
      // care but it's less attentive.
      //
      // Ruined or deeply indebted: can barely afford coal, let alone a midwife.
      // Indebted (moderate): reduced access — husband spent the coin.
      // Prosperous: can summon the best available.
      let pUrban;
      if (char.socialClass === 'noble') {
        pUrban = ruined ? 0.70 : 0.92;  // nobles ruined still have connections
      } else if (char.socialClass === 'clergy') {
        pUrban = 0.88;  // Peonian connections transcend personal wealth
      } else if (char.socialClass === 'guilded_courtesan') {
        pUrban = ruined ? 0.55 : 0.80;  // guild house provides care while in good standing
      } else if (['merchant','guilded_physician','guilded_litigant'].includes(char.socialClass)) {
        pUrban = ruined   ? 0.40 :
                 indebted ? 0.55 :
                 prosperous ? 0.85 : 0.72;
      } else if (['artisan','guilded_innkeeper','guilded_arcanist'].includes(char.socialClass)) {
        pUrban = ruined   ? 0.30 :
                 indebted ? 0.45 :
                 prosperous ? 0.78 : 0.62;
      } else if (char.socialClass === 'unguilded') {
        // Urban poor — near the temples, but charity care only if truly destitute
        pUrban = ruined   ? 0.30 :
                 indebted ? 0.40 :
                 prosperous ? 0.65 : 0.50;
      } else if (['guilded_mariner','guilded_performer','guilded_herald'].includes(char.socialClass)) {
        pUrban = ruined   ? 0.25 :
                 indebted ? 0.40 :
                 prosperous ? 0.72 : 0.55;
      } else if (char.socialClass === 'guilded_miner') {
        pUrban = ruined ? 0.25 : indebted ? 0.35 : 0.50;
      } else if (char.socialClass === 'destitute') {
        // Genuinely homeless — urban Peonian charity provides some access; rural very low
        pUrban = 0.35;  // charity care from Peonian house; no coin but sisters still attend
      } else if (char.socialClass === 'lia_kavair') {
        pUrban = ruined ? 0.20 : indebted ? 0.30 : 0.45;
      } else if (char.socialClass === 'priest_naveh') {
        pUrban = 0.10;  // Naveh does not welcome Peonian attendance
      } else if (['soldier','warrior'].includes(char.socialClass)) {
        pUrban = 0.35;  // if she's in a town/city posting, some access
      } else {
        // peasant in town setting (unusual but possible)
        pUrban = ruined ? 0.25 : indebted ? 0.35 : prosperous ? 0.60 : 0.42;
      }

      // ── RURAL ACCESS ──────────────────────────────────────────────────────
      // Peonian sisters are an agricultural/rural church — their Esolani are
      // embedded in village life, attending births as a religious duty. Wealth
      // matters less here: the Esolani comes regardless of ability to pay.
      // What limits access is DISTANCE and ISOLATION, not class or coin.
      //
      // A peasant in a settled village with a Peonian chapel is actually BETTER
      // placed than an indebted merchant's wife in a remote manor.
      // skilled_herbalist represents the village wise woman — a real resource.
      let pRural;
      if (isIsolated) {
        // Hamlet or camp — no temple nearby, possibly days from any skilled help
        pRural = char.socialClass === 'noble'  ? 0.55 :  // can send a messenger
                 char.socialClass === 'clergy' ? 0.65 :
                 herbalist                     ? 0.45 :
                 0.25;  // mostly on their own
      } else {
        // Village — Peonian chapel within a day's ride for most of Kaldor
        // Wealth has little effect here; Peonian duty supersedes payment
        const ruralBase = {
          noble:       0.82,  // can summon, or Peonian lives at the manor
          clergy:      0.88,  // Peonian network
          merchant:    0.68,  // usually rural merchant = some means, some connections
          artisan:     0.65,
          peasant:     0.60,  // village Esolani attends; ruined peasant still gets her
          unguilded:   0.55,
          soldier:     0.30,  // camp/posting; may be away from village infrastructure
          warrior:     0.55,  // often at a manor with Peonian chapel access
          lia_kavair:  0.40,
          priest_naveh:0.10,
        }[char.socialClass] ?? 0.50;

        // In rural settings, ruination barely affects Peonian access — she
        // comes as a duty. But it does affect whether you can supplement with
        // a travelling physician or herbalist goods.
        const ruralWealthMod = ruined   ? -0.05 :   // small penalty — can't buy supplies
                               indebted ?  0.00 :   // no penalty — Peonian doesn't charge
                               prosperous ? +0.08 : 0;  // can afford the physician too

        pRural = ruralBase + ruralWealthMod;
      }

      // ── SHARED MODIFIERS ──────────────────────────────────────────────────
      // skilled_herbalist: local knowledge or self-knowledge reduces risk
      // regardless of whether a formal midwife attends
      const herbMod    = herbalist ? +0.12 : 0;

      // Active Peonian devotion opens a direct channel to the sisterhood
      const devoutMod  = devoutPeoni ? +0.10 : 0;

      const baseP = isUrban ? pUrban : pRural;
      const pAccess = Math.min(0.95, Math.max(0, baseP + herbMod + devoutMod));

      if (rand() < pAccess) {
        // Skilled attendance: reduce pDifficult by 45% of current value.
        // Effect is proportional — more valuable at older ages where risk is higher.
        pDifficult  *= 0.55;
        pDisability *= 0.70;
      }
    }

    const twins = rand() < 0.015;
    difficult = twins ? true : rand() < pDifficult;

    const cs           = currentSpouse();
    const fatherRhPos  = isFemale ? (cs ? cs.rhPositive : rand() < 0.85) : char.rhPositive;
    const motherRhPos  = isFemale ? char.rhPositive : (cs ? cs.rhPositive : rand() < 0.85);
    const childSurname = isFemale
      ? (cs?.surname || name?.surname || null)
      : (name?.surname || null);

    // ── Helper: stamp and register one child stub ──────────────────────────────
    function makeChild(dis) {
      const stub = generateChildStub({
        motherRhPositive:   motherRhPos,
        fatherRhPositive:   fatherRhPos,
        familySurname:      childSurname,
        socialClass:        char.socialClass,
        bornAtPrincipalAge: age,
        motherId:           isFemale ? 'principal' : (cs?.id || null),
        fatherId:           isFemale ? (cs?.id || null) : 'principal',
        existingGivenNames: children.map(c => c.given).filter(Boolean),
        disability:         dis,
      });
      // Expansion metadata — every stub gets these
      stub.birthYear    = ctxBirthYear != null ? ctxBirthYear + age : null;
      stub.stubSeed     = ctxHashId ? ctxHashId(stub.id) : null;
      stub.sharedEvents = [];
      children.push(stub);
      return stub;
    }

    if (rand() < pDisability) {
      disability = DISABILITY_TYPES[Math.floor(rand() * DISABILITY_TYPES.length)];
    }
    child = makeChild(disability);

    let twinDisability = null;
    if (twins) {
      if (rand() < pDisability) {
        twinDisability = DISABILITY_TYPES[Math.floor(rand() * DISABILITY_TYPES.length)];
      }
      twin = makeChild(twinDisability);
    }

    const anyDisability = disability || twinDisability;
    child._twin          = twin;
    child._twins         = twins;
    child._twinDisability = twinDisability;
    child._anyDisability  = anyDisability;

    eventId    = twins        ? 'twins_born'
               : anyDisability ? 'disabled_child_born'
               : difficult    ? 'difficult_birth'
               :                'first_child_born';
    eventLabel = twins        ? 'Twins born'
               : anyDisability ? 'Child born with a disability'
               : difficult    ? 'Difficult birth'
               :                'Child born';

    // ── Update conditions ──────────────────────────────────────────────────────
    if (!char.conditions.includes('has_children')) char.conditions.push('has_children');
    if (anyDisability && !char.conditions.includes('has_disabled_child'))
      char.conditions.push('has_disabled_child');
    const childlessIdx = char.conditions.indexOf('childless');
    if (childlessIdx !== -1) char.conditions.splice(childlessIdx, 1);
    if (difficult && isFemale) char.attributes.STA = Math.max(1, char.attributes.STA - 1);

    // ── Update father stub's sharedEvents ─────────────────────────────────────
    // If the principal is female, the father is the current spouse.
    // If the principal is male, he IS the father — update mother stub if present.
    if (isFemale && cs?.sharedEvents) {
      cs.sharedEvents.push({
        eventId: eventId, ageMin: cs.ageAtMarriage + (age - cs.marriedAtPrincipalAge),
        ageMax: cs.ageAtMarriage + (age - cs.marriedAtPrincipalAge),
        pool: 'family',
        meta: { childId: child.id, twins, disability: anyDisability || null },
      });
    } else if (!isFemale && cs?.sharedEvents) {
      // Male principal: record the birth on the wife's stub
      cs.sharedEvents.push({
        eventId: eventId, ageMin: cs.ageAtMarriage + (age - cs.marriedAtPrincipalAge),
        ageMax: cs.ageAtMarriage + (age - cs.marriedAtPrincipalAge),
        pool: 'family',
        meta: { childId: child.id, twins, disability: anyDisability || null },
      });
    }

  } else {
    // Loss
    if (outcome === 'stillbirth' && !char.conditions.includes('bereaved_child')) {
      char.conditions.push('bereaved_child');
    }
  }

  // Remove pregnant condition if present
  const pregIdx = char.conditions.indexOf('pregnant');
  if (pregIdx !== -1) char.conditions.splice(pregIdx, 1);

  // ── Register follow-ons ───────────────────────────────────────────────────────
  if (outcome === 'miscarriage' || outcome === 'stillbirth') {
    familyFollowOns.set('grief_and_introspection', {
      weightMod: outcome === 'stillbirth' ? +15 : +10, yearsLeft: 2,
    });
    if (outcome === 'stillbirth') familyFollowOns.set('religious_devotion', { weightMod: +8, yearsLeft: 2 });
    if (isFemale) {
      const pregFollowId = char.socialClass === 'pagaelin' ? 'pagaelin_pregnancy' : 'pregnancy';
      familyFollowOns.set(pregFollowId, { weightMod: +12, yearsLeft: 3 });
    } else {
      familyFollowOns.set('spouse_pregnant', { weightMod: +12, yearsLeft: 3 });
    }
  } else {
    const twins     = child?._twins ?? false;
    const anyDisab  = child?._anyDisability ?? false;
    // child_dies is handled by the parallel child simulation (advanceChildStubs),
    // not the family pool. No follow-on boost needed here.
    if (!isFemale && difficult) {
      familyFollowOns.set('spouse_dies_childbirth', { weightMod: twins ? +28 : +18, yearsLeft: 2 });
    } else if (!twins) {
      if (isFemale) {
        const pregFollowId = char.socialClass === 'pagaelin' ? 'pagaelin_pregnancy' : 'pregnancy';
        familyFollowOns.set(pregFollowId, { weightMod: +30, yearsLeft: 3 });
      } else {
        familyFollowOns.set('spouse_pregnant', { weightMod: +30, yearsLeft: 3 });
      }
    }
    if (anyDisab) {
      familyFollowOns.set('worried_for_child',       { weightMod: +20, yearsLeft: 5 });
      familyFollowOns.set('grief_and_introspection', { weightMod: +8,  yearsLeft: 2 });
    }
  }

  // ── Flavour text ─────────────────────────────────────────────────────────────
  const twins2       = child?._twins        ?? false;
  const twin2        = child?._twin         ?? null;
  const anyDisab2    = child?._anyDisability ?? false;
  const disLabel     = disability === 'simple' ? 'simple-minded'
                     : disability === 'lame'   ? 'lame'
                     : disability === 'blind'  ? 'blind'
                     : disability === 'deaf'   ? 'deaf' : null;
  let flavour;

  if (isFemale) {
    if      (outcome === 'miscarriage') {
      flavour = weeks <= 10
        ? 'She lost the child early — before she had said much aloud about it. She said nothing after, either.'
        : 'She lost the child before its time. She did not speak of it openly.';
    } else if (outcome === 'stillbirth') {
      flavour = weeks >= 38
        ? 'The child came at term and did not breathe. She had been so close.'
        : 'The child came too still. She had carried it through the quickening, had felt it move, and then nothing.';
    } else if (twins2) {
      flavour = `She bore twins — ${child.name} and ${twin2.name}. The birth was hard and left her exhausted for weeks, but both children lived.`;
    } else if (anyDisab2) {
      flavour = LIFE_EVENTS_BY_ID.get('disabled_child_born')?.flavour.female
        || `She bore a ${disLabel} child. The birth was ${difficult ? 'hard' : 'safe'}.`;
    } else if (difficult) {
      flavour = `The birth was hard and left her weakened for months. But the child — ${child.name} — lived.`;
    } else {
      flavour = `She bore a child. ${child.name} came into the world healthy.`;
    }
  } else {
    if      (outcome === 'miscarriage') {
      flavour = weeks <= 10
        ? 'His wife lost the child early. Neither of them spoke much about it.'
        : 'His wife lost the child before its time. He did not know what to do with his grief.';
    } else if (outcome === 'stillbirth') {
      flavour = weeks >= 38
        ? 'The child came at term and did not live. He had thought the danger past.'
        : 'The child came still. They had felt it move. He had no words for what followed.';
    } else if (twins2) {
      flavour = `His wife bore twins — ${child.name} and ${twin2.name}. The labour was long and hard; she was weakened for months. Both children lived.`;
    } else if (anyDisab2) {
      flavour = LIFE_EVENTS_BY_ID.get('disabled_child_born')?.flavour.male
        || `His wife bore a ${disLabel} child. He held the infant and made no promises about what came next.`;
    } else if (difficult) {
      flavour = `His wife's labour was hard, and she was weakened for months. The child — ${child.name} — survived.`;
    } else {
      flavour = `His wife bore him a child. ${child.name} came into the world, and the house changed around that fact.`;
    }
  }

  const relNote = twins2 && twin2
    ? `${child.name} and ${twin2.name} born (twins)`
    : child
      ? `${child.name} born (${child.sex}${disability ? ', ' + disLabel : ''})`
      : null;

  return {
    outcome, weeks, eventId, eventLabel, flavour,
    child, twin: twin2, twins: twins2, disability, difficult, rhNote,
    relationalNote: relNote,
  };
}

// Keep old name as alias for test suite compatibility
const _resolvePregnancyOutcome = resolvePregnancy;

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ENGINE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Age a character from their starting age to targetAge, one year at a time.
 * Each year runs a biographical draw and (if family active) a family draw.
 *
 * @param {object} options
 *   socialClass  {string}        'noble'|'merchant'|'warrior'|'soldier'|'peasant'|'artisan'|'clergy'
 *   sex       {string}        'male' | 'female'
 *   targetAge    {number}        Final age at end of aging
 *   gameYear     {number}        Current campaign year in TR (default 720)
 *   attributes   {object|null}   Starting attributes (defaults to all-10)
 *   conditions   {string[]}      Starting conditions (default [])
 *   publicDeity  {string|null}   Starting deity
 *   name         {object|null}   { given, surname, full } — if pre-generated
 *   location     {string|null}   Vault location for this NPC
 *   rhPositive   {bool|null}     Override Rh type (null = roll)
 *   birthOrder   {number|null}   1 = firstborn heir; 2+ = spare. null = roll.
 *   seed         {number|null}   Reserved for deterministic generation
 *
 * @returns {object} CharacterResult
 */
function ageCharacter({
  socialClass,
  sex       = 'male',
  targetAge    = 25,
  gameYear     = DEFAULT_GAME_YEAR,
  attributes   = null,
  conditions   = [],
  publicDeity  = null,
  name         = null,
  location     = null,
  rhPositive   = null,
  birthOrder   = null,
  archetype      = null,   // archetype id string, or null to auto-roll
  settlement     = null,   // 'hamlet'|'village'|'town'|'city' — current location type, or null to roll
  settlementPool = null,   // { hamlet: string[], village: string[], town: string[], city: string[] }
                           // drawn from vault at call time; enables named locations in history
  seed           = null,
  hobbySkill     = null,    // skill name from HOBBY_SKILL_DATA, or null to skip OP spending
  occupationSkills = [],    // list of skill names the character has from their occupation
  checkpoint     = null,    // saved state from captureCheckpoint() — resumes simulation from that age
  forcedEvents   = [],      // [{ eventId, ageMin, ageMax, pool? }] — events that must fire in window
}) {
  // ── Initialise: unified fresh-run and checkpoint-resume path ────────────
  //
  // When `checkpoint` is supplied every state variable is restored from it
  // and the year loop begins at checkpoint.resumeAge. The two code paths share
  // one year loop, one resolveEvent closure, and one return block.

  const cp       = checkpoint;
  const isResume = !!cp;

  // ── Deterministic seed ────────────────────────────────────────────────────
  // If a seed is provided, seed the global PRNG before any randomness fires.
  // This makes the entire run (including name generation, injury rolls, OCEAN
  // scores, archetype selection, every weighted draw) fully reproducible.
  // Pass seed: null (default) for non-deterministic generation.
  if (!isResume && seed !== null && seed !== undefined) {
    seedRng(seed);
  }

  // Core scalars
  const cls      = isResume ? cp.socialClass.toLowerCase()
                            : (socialClass || 'peasant').toLowerCase();
  const _sex  = isResume ? cp.sex : (sex || 'male');
  const isFemale = _sex === 'female';

  const startingAge  = STARTING_AGES[cls] || 14;
  const beginAge     = isResume ? cp.resumeAge : Math.max(startingAge, 18);
  const endAge       = Math.max(beginAge, targetAge);
  if (!isResume && targetAge < beginAge) {
    process.stderr.write(
      `[aging-engine] targetAge ${targetAge} clamped to ${beginAge} ` +
      `(minimum for class '${cls}'). Set targetAge >= ${beginAge} to suppress this warning.\n`
    );
  }
  const _gameYear    = isResume ? cp.gameYear  : (gameYear || DEFAULT_GAME_YEAR);
  const birthYear    = isResume ? cp.birthYear : (_gameYear - targetAge);

  // ── Sibling rank / family size (HârnMaster RAW p.4) ──────────────────────
  // Roll 1d100 for SIBLING RANK (the principal's birth position).
  // Then roll 1d6-1 + Rank for FAMILY SIZE (total children including principal).
  // Siblings = Family Size − 1.
  // Estrangement: 0=close, 1=distant, 2=estranged — set at birth, may deepen.
  //
  // Birth order: if caller supplied a specific birthOrder, honour it.
  // Otherwise derive from the sibling rank roll so rank/size/birthOrder are consistent.
  let resolvedBirthOrder = isResume ? cp.birthOrder : (birthOrder ?? null);

  const _siblingData = (() => {
    if (isResume) return {
      siblingCount:      cp.siblingCount ?? 0,
      estrangementLevel: cp.estrangementLevel ?? 0,
      familySize:        cp.familySize ?? (cp.siblingCount ?? 0) + 1,
    };

    // 1d100 → sibling rank
    const rankRoll = Math.floor(rand() * 100) + 1;
    let rank;
    if      (rankRoll <= 25) rank = 1;
    else if (rankRoll <= 50) rank = 2;
    else if (rankRoll <= 70) rank = 3;
    else if (rankRoll <= 85) rank = 4;
    else if (rankRoll <= 95) rank = 5;
    else                     rank = 6;

    // If caller supplied birthOrder, use it; otherwise use the rolled rank
    if (resolvedBirthOrder === null) resolvedBirthOrder = rank;

    // 1d6-1 + rank = family size (minimum = rank, so principal always fits)
    const d6m1       = Math.floor(rand() * 6);          // 0-5
    const familySize = Math.max(rank, rank + d6m1);     // rank..rank+5
    const siblingCount = familySize - 1;

    // Estrangement: ~8% fully estranged, ~20% distant, rest close
    const estRoll         = rand();
    const estrangementLevel = estRoll < 0.08 ? 2 : estRoll < 0.28 ? 1 : 0;

    return { siblingCount, estrangementLevel, familySize };
  })();

  // ── Parent table (HârnMaster RAW p.4) ────────────────────────────────────
  // Rolls 1d100 to determine upbringing type, then resolves parent stubs,
  // initial conditions, and sibling stubs.
  const _familyOrigin = (() => {
    if (isResume) return cp._familyOrigin ?? { type: 'offspring', parents: [], siblings: [] };

    const principalSurname = null; // name may not be set yet; stubs use class-based surname
    const d100 = () => Math.floor(rand() * 100) + 1;

    // ── Main roll ──────────────────────────────────────────────────────────
    const mainRoll = d100();
    let upbringingType; // 'offspring' | 'fostered' | 'adopted' | 'bastard' | 'orphan'

    if      (mainRoll <= 50) upbringingType = 'offspring';
    else if (mainRoll <= 70) upbringingType = 'fostered';
    else if (mainRoll <= 75) upbringingType = 'adopted';
    else if (mainRoll <= 90) upbringingType = 'bastard';
    else                     upbringingType = 'orphan';

    const conditions  = [];  // conditions added to initConditions
    const parents     = [];  // parent stubs
    const siblings    = [];  // sibling stubs

    // ── Helper: determine parent statuses for offspring/fostered ──────────
    const rollOffspringSubtable = (modifier = 0) => {
      const roll = Math.min(100, d100() + modifier);
      if      (roll <= 60) return { fatherStatus: 'alive',    motherStatus: 'alive',    fatherRemarried: false, motherRemarried: false };
      else if (roll <= 70) return { fatherStatus: 'absent',   motherStatus: 'alive',    fatherRemarried: false, motherRemarried: false };
      else if (roll <= 75) return { fatherStatus: 'alive',    motherStatus: 'absent',   fatherRemarried: false, motherRemarried: false };
      else if (roll <= 80) return { fatherStatus: 'deceased', motherStatus: 'alive',    fatherRemarried: false, motherRemarried: false };
      else if (roll <= 85) return { fatherStatus: 'deceased', motherStatus: 'alive',    fatherRemarried: false, motherRemarried: true  };
      else if (roll <= 90) return { fatherStatus: 'alive',    motherStatus: 'deceased', fatherRemarried: false, motherRemarried: false };
      else                 return { fatherStatus: 'alive',    motherStatus: 'deceased', fatherRemarried: true,  motherRemarried: false };
    };

    // ── Helper: build natural parent stubs ────────────────────────────────
    const makeNaturalParents = (fatherStatus, motherStatus, fatherRemarried, motherRemarried) => {
      const father = generateParentStub({
        role: 'father', socialClass: cls,
        principalBirthYear: birthYear, principalSurname,
        status: fatherStatus, remarried: fatherRemarried,
      });
      const mother = generateParentStub({
        role: 'mother', socialClass: cls,
        principalBirthYear: birthYear, principalSurname,
        status: motherStatus, remarried: motherRemarried,
      });
      parents.push(father, mother);

      if (fatherStatus === 'absent')   conditions.push('father_absent');
      if (fatherRemarried || motherRemarried) conditions.push('stepchild');

      // Step-parent stubs (GM discretion — generate if remarried)
      if (fatherRemarried) {
        parents.push(generateParentStub({
          role: 'step_mother', socialClass: cls,
          principalBirthYear: birthYear, principalSurname: null,
          status: 'alive', remarried: false,
        }));
      }
      if (motherRemarried) {
        parents.push(generateParentStub({
          role: 'step_father', socialClass: cls,
          principalBirthYear: birthYear, principalSurname: null,
          status: 'alive', remarried: false,
        }));
      }
    };

    // ── Helper: build sibling stubs ────────────────────────────────────────
    const makeSiblingStubs = () => {
      const usedNames     = [];
      const { siblingCount, estrangementLevel } = _siblingData;
      const rank          = resolvedBirthOrder ?? 1;  // principal's position
      // Siblings occupy all positions except the principal's rank
      // Positions: 1..familySize, skipping rank
      const familySz = _siblingData.familySize;
      const positions = [];
      for (let pos = 1; pos <= familySz; pos++) {
        if (pos !== rank) positions.push(pos);
      }

      for (const pos of positions) {
        // 60% chance each sibling is still alive (HârnMaster RAW p.4)
        const alive  = rand() < 0.60;
        // birthOrderOffset: negative = elder than principal, positive = younger
        const offset = pos - rank;

        const sib = generateSiblingStub({
          socialClass:        cls,
          principalBirthYear: birthYear,
          familySurname:      principalSurname,
          birthOrderOffset:   offset,
          existingGivenNames: usedNames,
          estrangementLevel,
        });
        sib.status   = alive ? 'alive' : 'deceased';
        if (!alive) sib.diedAge = Math.floor(rand() * 60) + 1; // rough age at death
        usedNames.push(sib.given);
        siblings.push(sib);
      }
    };

    // ── Resolve by upbringing type ─────────────────────────────────────────
    if (upbringingType === 'offspring') {
      const sub = rollOffspringSubtable(0);
      makeNaturalParents(sub.fatherStatus, sub.motherStatus, sub.fatherRemarried, sub.motherRemarried);
      makeSiblingStubs();
    }
    else if (upbringingType === 'fostered') {
      // Reroll offspring subtable at +30 (fostered know their natural parents)
      const sub = rollOffspringSubtable(30);
      makeNaturalParents(sub.fatherStatus, sub.motherStatus, sub.fatherRemarried, sub.motherRemarried);
      // Foster parents
      parents.push(
        generateParentStub({ role: 'foster_father', socialClass: cls, principalBirthYear: birthYear, principalSurname: null, status: 'alive', remarried: false }),
        generateParentStub({ role: 'foster_mother', socialClass: cls, principalBirthYear: birthYear, principalSurname: null, status: 'alive', remarried: false }),
      );
      conditions.push('fostered');
      makeSiblingStubs();
    }
    else if (upbringingType === 'adopted') {
      // Both natural parents usually deceased; adoptive parents are primary
      parents.push(
        generateParentStub({ role: 'father', socialClass: cls, principalBirthYear: birthYear, principalSurname, status: 'deceased', remarried: false }),
        generateParentStub({ role: 'mother', socialClass: cls, principalBirthYear: birthYear, principalSurname, status: 'deceased', remarried: false }),
        generateParentStub({ role: 'adoptive_father', socialClass: cls, principalBirthYear: birthYear, principalSurname: null, status: 'alive', remarried: false }),
        generateParentStub({ role: 'adoptive_mother', socialClass: cls, principalBirthYear: birthYear, principalSurname: null, status: 'alive', remarried: false }),
      );
      conditions.push('adopted', 'orphaned');
      makeSiblingStubs();
    }
    else if (upbringingType === 'bastard') {
      // Father of higher class or already married; usually lives with mother
      const acknowledged = mainRoll <= 80; // 76-80 = acknowledged
      const fatherSocialClass = (cls === 'peasant' || cls === 'unguilded') ? 'merchant' : 'noble';
      parents.push(
        generateParentStub({ role: 'father', socialClass: fatherSocialClass, principalBirthYear: birthYear, principalSurname: null, status: acknowledged ? 'alive' : 'unknown', remarried: false }),
        generateParentStub({ role: 'mother', socialClass: cls, principalBirthYear: birthYear, principalSurname, status: 'alive', remarried: false }),
      );
      conditions.push('illegitimate');
      if (!acknowledged) conditions.push('father_absent');
      makeSiblingStubs();
    }
    else { // orphan
      // Both parents deceased
      parents.push(
        generateParentStub({ role: 'father', socialClass: cls, principalBirthYear: birthYear, principalSurname, status: 'deceased', remarried: false }),
        generateParentStub({ role: 'mother', socialClass: cls, principalBirthYear: birthYear, principalSurname, status: 'deceased', remarried: false }),
      );
      conditions.push('orphaned');
      const orphanRoll = d100();
      if (orphanRoll <= 80) {
        // Fostered with another family
        parents.push(
          generateParentStub({ role: 'foster_father', socialClass: cls, principalBirthYear: birthYear, principalSurname: null, status: 'alive', remarried: false }),
          generateParentStub({ role: 'foster_mother', socialClass: cls, principalBirthYear: birthYear, principalSurname: null, status: 'alive', remarried: false }),
        );
        conditions.push('fostered');
      } else if (orphanRoll <= 95) {
        // Adopted
        parents.push(
          generateParentStub({ role: 'adoptive_father', socialClass: cls, principalBirthYear: birthYear, principalSurname: null, status: 'alive', remarried: false }),
          generateParentStub({ role: 'adoptive_mother', socialClass: cls, principalBirthYear: birthYear, principalSurname: null, status: 'alive', remarried: false }),
        );
        conditions.push('adopted');
      }
      // 96-00: living alone — no additional stubs
      makeSiblingStubs();
    }

    return { type: upbringingType, parents, siblings, conditions };
  })();


  // Pagaelin: settlement is always 'camp'; tribalAlignment varies.
  // All other cultures: settlement varies; tribalAlignment is null.
  const isPagaelin        = cls === 'pagaelin';
  const birthSettlement   = isResume ? cp.birthSettlement
    : isPagaelin ? 'camp'
    : rollBirthSettlement(cls);
  const tribalAlignment   = isResume ? (cp.tribalAlignment || null)
    : isPagaelin ? rollTribalAlignment()
    : null;
  const settlementHistory = isResume ? cp.settlementHistory.map(s => ({ ...s })) : [];

  // ── Archetype ─────────────────────────────────────────────────────────────
  let resolvedArchetype = null;
  // Saved when levy service begins; restored on discharge.
  let savedCivilianArchetype = null;
  if (isResume) {
    resolvedArchetype = cp.archetype ? getArchetype(cp.archetype) : null;
    savedCivilianArchetype = cp.savedCivilianArchetype ? getArchetype(cp.savedCivilianArchetype) : null;
  } else {
    const startingPhase = (() => {
      const cfg = CLASS_PHASE_CONFIGS[cls];
      if (cfg) return cfg.startingPhase(isFemale ? 'female' : 'male', resolvedBirthOrder, birthSettlement);
      return 'established';  // safe default for any future class not yet in config
    })();
    if (archetype) {
      resolvedArchetype = getArchetype(archetype);
      if (!resolvedArchetype) console.warn(`[aging-engine] Unknown archetype "${archetype}" — auto-rolling.`);
    }
    if (!resolvedArchetype) {
      // For Pagaelin, pass tribal alignment as a minimal condition set so that
      // requireConditions on archetypes (e.g. traditional shamans only in
      // traditional tribes) are respected at initial archetype roll.
      const initCondSet = isPagaelin && tribalAlignment
        ? new Set(['tribal_alignment_' + tribalAlignment,
                   ...(tribalAlignment === 'walker_dominated' ? ['tribal_alignment_walker'] : [])])
        : null;
      resolvedArchetype = rollArchetype(cls, _sex, startingPhase, birthSettlement, initCondSet);
    }
  }

  // ── Rh type ───────────────────────────────────────────────────────────────
  const charRhPositive = isResume ? cp.rhPositive
    : (rhPositive !== null ? rhPositive : (isFemale ? rand() >= 0.15 : true));

  // ── OCEAN + Morality ──────────────────────────────────────────────────────
  // Pagaelin OCEAN base differs fundamentally from Kaldoric class biases.
  // Low A (dominance culture), low C (erratic subsistence, no long-term planning),
  // high N (perpetual threat environment), moderate E, variable O by archetype.
  // The culture config base is applied first; archetype oceanBias refines further.
  const oceanScores = (() => {
    if (isResume) return { ...cp.oceanScores };
    if (isPagaelin) {
      const base = CULTURE_CONFIGS.pagaelin.oceanBase;
      const result = {};
      for (const key of ['O', 'C', 'E', 'A', 'N']) {
        // ±15 random variation around the cultural base
        const variation = Math.floor(Math.random() * 31) - 15;
        result[key] = Math.max(1, Math.min(100, base[key] + variation));
      }
      return result;
    }
    return generateOCEANScores(cls, _sex);
  })();
  // Apply archetype oceanBias if present — shifts the NPC's personality toward the archetype's
  // characteristic profile. Applied once at creation, not on resume (bias already baked in).
  if (!isResume && resolvedArchetype?.oceanBias) {
    for (const [trait, delta] of Object.entries(resolvedArchetype.oceanBias)) {
      if (oceanScores[trait] !== undefined) {
        oceanScores[trait] = Math.max(1, Math.min(100, oceanScores[trait] + delta));
      }
    }
  }

  let morality = isResume ? cp.morality : deriveMorality(oceanScores);
  // baseMorality: the constitutional baseline — set once at birth, never changes.
  // moralityDrift uses this to pull the current score back toward baseline
  // after adversity has pushed it away. A man who became bitter under destitution
  // will, given time and stability, recover toward his original disposition.
  const baseMorality = isResume ? (cp.baseMorality ?? cp.morality) : morality;

  // ── Deity ─────────────────────────────────────────────────────────────────
  // Roll at creation if not supplied by caller and not resuming.
  // selectDeity returns { publicDeity, secretDeity, isSecretWorshipper }.
  // Pagaelin: deity is determined by tribal alignment, not the Kaldoric deity table.
  //   traditional/syncretist → Saraen (old faith hunter-god, Ivinian-derived)
  //   walker_dominated       → Walker (Naveh repackaged for tribal audience)
  //   syncretist shamans may have Walker as secret deity — handled by archetype events.
  const _deityRoll = (!isResume && publicDeity === null && cls !== 'clergy' && !isPagaelin)
    ? selectDeity(cls, _sex, null)
    : null;
  // Clergy have their public deity assigned by their order — not rolled at creation.
  // Infer from archetype ID when not explicitly set: clergy_peoni_* → Peoni, else Larani.
  const _inferredClergyDeity = (() => {
    if (publicDeity) return publicDeity;
    const archId = resolvedArchetype?.id || '';
    if (archId.startsWith('clergy_peoni')) return 'Peoni';
    if (archId.startsWith('clergy_halea')) return 'Halea';
    return 'Larani';
  })();
  // Pagaelin deity from culture config based on tribal alignment.
  const _pagaelinDeity = isPagaelin
    ? (CULTURE_CONFIGS.pagaelin.deities[tribalAlignment] || 'Saraen')
    : null;
  const _publicDeityAtBirth  = isResume ? cp.publicDeity
    : cls === 'clergy' ? _inferredClergyDeity
    : isPagaelin ? (publicDeity ?? _pagaelinDeity)
    : (publicDeity ?? _deityRoll?.publicDeity ?? null);
  const _secretDeityAtBirth  = isResume ? cp.secretDeity  : (_deityRoll?.secretDeity  ?? null);
  const _isSecretWorshipper  = isResume ? cp.isSecretWorshipper : (_deityRoll?.isSecretWorshipper ?? false);

  // ── Birth profile ─────────────────────────────────────────────────────────
  // Rolled once at creation per HârnMaster RAW pp 3–5, 9, 12.
  const _birthProfile = (() => {
    if (isResume) return {
      birthMonth: cp.birthMonth, birthDay: cp.birthDay,
      sunsign:    cp.sunsign,    piety:     cp.piety,
      medicalTrait: cp.medicalTrait ?? null,
    };    const birthMonth = Math.floor(rand() * 12);           // 0-based month index
    const birthDay   = Math.floor(rand() * 30) + 1;       // 1–30
    const sunsign    = sunsignFromDate(birthMonth, birthDay);
    // Piety: 5d6 for non-clergy per HârnMaster RAW.
    // Clergy piety = WIL × 5 — resolved after birthAttrs below.
    const piety = cls === 'clergy'
      ? null   // sentinel — resolved to WIL×5 after birthAttrs is rolled
      : [1,2,3,4,5].reduce((t) => t + Math.floor(rand() * 6) + 1, 0);
    const medicalTrait = rollMedicalTrait(_sex);
    return { birthMonth, birthDay, sunsign, piety, medicalTrait };
  })();
  const initConditions = (() => {
    if (isResume) return [...cp.conditions];
    const c = [...(conditions || [])];
    if (isFemale && !charRhPositive && !c.includes('rh_negative')) c.push('rh_negative');
    if (cls === 'clergy' && !c.includes('clergy')) c.push('clergy');
    // Pagaelin: set tribal alignment condition, Pagaelin language, and
    // starting language conditions based on archetype (fluent speakers are rare).
    if (isPagaelin) {
      // Female Pagaelin who are in held roles start held
      if (isFemale) {
        const heldArchetypes = ['pagaelin_held_woman','pagaelin_herder_female',
                                'pagaelin_widow','pagaelin_shaman_saraen_female'];
        const archId = resolvedArchetype?.id || '';
        if (heldArchetypes.some(a => archId.startsWith(a))) {
          if (!c.includes('pagaelin_held')) c.push('pagaelin_held');
        }
      }
      const alignCond = 'tribal_alignment_' + tribalAlignment;
      if (!c.includes(alignCond)) c.push(alignCond);
      // Walker-dominated tribes also get the base walker condition
      if (tribalAlignment === 'walker_dominated' && !c.includes('tribal_alignment_walker'))
        c.push('tribal_alignment_walker');
      // All Pagaelin speak Pagaelin — no condition needed (it's the baseline)
      // Fluent Hârnic speakers get their condition from archetype events, not here
    }
    return c;
  })();

  // ── Birth attributes ───────────────────────────────────────────────────────
  // Roll once at creation using HarnMaster RAW (4d6-drop-lowest for key attrs,
  // 3d6 for the rest) or restore from checkpoint / use caller-supplied values.
  // Private _frame/_heightIn/_weightLbs are passed through so physical-description.js
  // can use the same derived body without re-rolling.
  const birthAttrs = (() => {
    if (isResume)   return { ...cp.attributes };
    if (attributes) return { ...attributes };
    return rollBirthAttributes(_sex, cls);
  })();

  // Apply archetype startingConditions — language conditions, specialist markers etc.
  // Applied after initConditions is built so they can be combined cleanly.
  if (!isResume && resolvedArchetype?.startingConditions) {
    for (const c of resolvedArchetype.startingConditions) {
      if (!initConditions.includes(c)) initConditions.push(c);
    }
  }

  // CML thresholds and family estrangement set at birth as stable conditions.
  if (!isResume) {
    if (birthAttrs.CML >= 13 && !initConditions.includes('comely'))   initConditions.push('comely');
    if (birthAttrs.CML >= 17 && !initConditions.includes('striking')) initConditions.push('striking');
    if (_siblingData.estrangementLevel === 2 && !initConditions.includes('family_estranged'))
      initConditions.push('family_estranged');
    else if (_siblingData.estrangementLevel === 1 && !initConditions.includes('family_distant'))
      initConditions.push('family_distant');
    // Sibling count conditions — affects inheritance weight and family dynamics
    if (_siblingData.siblingCount === 0 && !initConditions.includes('only_child'))
      initConditions.push('only_child');
    else if (_siblingData.siblingCount >= 4 && !initConditions.includes('large_family'))
      initConditions.push('large_family');
    // Parent table conditions (orphaned, father_absent, illegitimate, fostered, adopted, stepchild)
    for (const c of _familyOrigin.conditions) {
      if (!initConditions.includes(c)) initConditions.push(c);
    }
    // orphaned_at_birth: marks NPCs whose parents were already dead at birth (adopted/orphan upbringing)
    // Prevents second_parent_dies from misfiring since orphaned is set in initConditions
    if (['adopted','orphan'].includes(_familyOrigin.type) && !initConditions.includes('orphaned_at_birth')) {
      initConditions.push('orphaned_at_birth');
    }
    // Clergy begin as postulants; rank advances via ordained_as_acolyte → ordained_as_priest etc.
    if (cls === 'clergy' && !initConditions.includes('clergy_postulant')) {
      initConditions.push('clergy_postulant');
    }
  }

  // Resolve clergy piety now that WIL is available (WIL × 5, range 15–90).
  if (!isResume && cls === 'clergy' && _birthProfile.piety === null) {
    _birthProfile.piety = birthAttrs.WIL * 5;
  }

  // ── Apply medical trait ───────────────────────────────────────────────────
  // Attribute deltas and conditions from birth. Applied once, permanent.
  // Re-checks comely/striking after CML may have been modified.
  if (!isResume && _birthProfile.medicalTrait) {
    const mt = _birthProfile.medicalTrait;
    if (mt.attrDeltas) {
      for (const [attr, delta] of Object.entries(mt.attrDeltas)) {
        if (birthAttrs[attr] !== undefined) {
          birthAttrs[attr] = Math.max(1, Math.min(21, birthAttrs[attr] + delta));
        }
      }
    }
    for (const c of (mt.conditions || [])) {
      if (!initConditions.includes(c)) initConditions.push(c);
    }
    // CML may have changed — recompute appearance thresholds
    const cmlFinal = birthAttrs.CML;
    const hasComely   = initConditions.includes('comely');
    const hasStriking = initConditions.includes('striking');
    if (cmlFinal >= 13  && !hasComely)   initConditions.push('comely');
    if (cmlFinal < 13   &&  hasComely)   initConditions.splice(initConditions.indexOf('comely'), 1);
    if (cmlFinal >= 17  && !hasStriking) initConditions.push('striking');
    if (cmlFinal < 17   &&  hasStriking) initConditions.splice(initConditions.indexOf('striking'), 1);
  }

  // ── Life expectancy ────────────────────────────────────────────────────────
  // Rolled once, secret to the GM. Degeneration begins at (lifeExpectancy − 10).
  const lifeExpectancy = isResume ? cp.lifeExpectancy : rollLifeExpectancy(_sex, cls);
  const ageOfDegeneration = lifeExpectancy - 10;

  const char = {
    socialClass:    cls,
    sex:         _sex,
    age:            beginAge,
    conditions:     initConditions,
    attributes:     birthAttrs,
    publicDeity:    isResume ? cp.publicDeity : _publicDeityAtBirth,
    rhPositive:     charRhPositive,
    birthOrder:     resolvedBirthOrder,
    // phase: artisan: apprentice→journeyman→established→senior
    //        noble: heir|spare|lady → lord → senior_noble
    //        warrior: recruit → veteran → sergeant
    //        clergy/others: established → senior
    phase: isResume ? cp.phase : (() => {
      const cfg = CLASS_PHASE_CONFIGS[cls];
      if (cfg) return cfg.startingPhase(isFemale ? 'female' : 'male', resolvedBirthOrder, birthSettlement);
      return 'established';
    })(),
    rootless:       isResume ? cp.rootless : false,
    archetype:      resolvedArchetype ? resolvedArchetype.id : null,
    settlementType: isResume ? cp.settlementType : birthSettlement,
    tribalAlignment: isResume ? (cp.tribalAlignment || null) : tribalAlignment,
    lifeExpectancy,
    oceanScores,
    morality,
    baseMorality,
    disgracedAtAge: null,  // when current disgrace was applied (for time-based fade)
  };

  // ── Relational records ────────────────────────────────────────────────────
  const spouses  = isResume ? cp.spouses.map(s  => ({ ...s })) : [];
  const children = isResume ? cp.children.map(c => ({ ...c })) : [];
  const contacts = isResume ? cp.contacts.map(c => ({ ...c })) : [];
  // Pagaelin household arrays
  // heldWomen: named female stubs held by a dominant male NPC
  // holder:    the dominant man stub on a female NPC (single entry or null)
  const heldWomen = isResume ? (cp.heldWomen || []).map(w => ({ ...w })) : [];
  let   holder    = isResume ? (cp.holder    || null) : null;
  // Retainers: men attached to this dominant/chieftain's camp
  const retainers = isResume ? (cp.retainers || []).map(r => ({ ...r })) : [];

  // Live reference so buildDrawTable can derive 'married' from spouses array.
  // Must be set after spouses is defined; reassigned is not needed since
  // spouses is mutated in place (push/property changes), not replaced.
  char._spousesRef = spouses;

  function currentSpouse() {
    return spouses.filter(s => s.status === 'alive').slice(-1)[0] || null;
  }
  function familyPoolActive() {
    // Standard Kaldoric gate: requires a spouse, widowed status, or existing children
    if (spouses.some(s => s.status === 'alive') ||
        char.conditions.includes('ever_widowed') ||
        char.conditions.includes('has_children') ||
        children.some(c => c.status === 'alive')) {
      return true;
    }
    // Pagaelin women of reproductive age: family pool is always active.
    // They do not need a formal spouse — the pagaelin_pregnancy event handles
    // childbearing without the Kaldoric marriage prerequisite.
    if (char.socialClass === 'pagaelin' && isFemale && char.age < 45) {
      return true;
    }
    return false;
  }

  // ── Engine-side cooldown trackers ────────────────────────────────────────
  // recentFireMap: eventId → last age fired, used to enforce event.minGapYears
  const recentFireMap = isResume ? new Map(Object.entries(cp.recentFireMap ?? {})) : new Map();

  // ── Accumulated totals ────────────────────────────────────────────────────
  let totalOPsEarned = isResume ? cp.totalOPsEarned : 0;
  let totalOPsFree   = isResume ? cp.totalOPsFree   : 0;
  const skillOPMap    = isResume ? { ...cp.skillOPMap } : {};
  const opSpendingMap = {};

  const history          = isResume ? cp.history.map(e     => ({ ...e })) : [];
  const classChanges     = isResume ? cp.classChanges.map(e => ({ ...e })) : [];
  const deityChanges     = isResume ? cp.deityChanges.map(e => ({ ...e })) : [];
  const archetypeChanges = isResume ? (cp.archetypeChanges || []).map(e => ({ ...e })) : [];

  // Follow-on maps start fresh; they re-establish from the resumed events naturally
  const bioFollowOns    = new Map();
  const familyFollowOns = new Map();

  // Forced events: always make local copies so _fired flags are isolated per run
  const _forcedEvts = (forcedEvents || []).map(fe => ({ ...fe, _fired: false }));

  // ── Relational record handlers ────────────────────────────────────────────
  // Each function handles one category of relational mutation. They close over
  // the shared arrays (spouses, children, contacts, char) so they can be called
  // from resolveEvent without passing state explicitly.
  // All return a relationalNote string (or null if nothing happened).

  function handleMarriage(resolvedEventId, age) {
    if (resolvedEventId !== 'married' && resolvedEventId !== 'remarriage_older') return null;
    // Peoni clergy have taken a celibacy vow — hard block regardless of event draw
    if (char.conditions.includes('peoni_celibate')) return null;
    const spouseSex = char.sex === 'male' ? 'female' : 'male';
    const spouseClass  = ['noble','merchant','clergy'].includes(char.socialClass)
      ? char.socialClass
      : weightedRandom([[char.socialClass, 70], ['peasant', 15], ['artisan', 15]]);
    const stub = generateSpouseStub({
      sex:           spouseSex,
      socialClass:      spouseClass,
      principalSurname: name?.surname || null,
      principalAge:     age,
    });
    // Expansion metadata: enough to run ageCharacter on this stub as a principal.
    // birthYear: derived from principal's birthYear and age difference at marriage.
    // stubSeed: deterministic hash of the stub's id for reproducible expansion.
    // sharedEvents: injected as forcedEvents when expanding to ensure consistency.
    stub.birthYear    = birthYear + age - stub.ageAtMarriage;
    stub.stubSeed     = hashId(stub.id);
    stub.sharedEvents = [
      { eventId: 'married', ageMin: stub.ageAtMarriage, ageMax: stub.ageAtMarriage,
        pool: 'biographical', meta: { principalId: 'principal', principalAge: age } },
    ];
    spouses.push(stub);
    return `Married ${stub.name} (${spouseClass}, age ${stub.ageAtMarriage})`;
  }

  function handleSpouseDeath(resolvedEventId, age) {
    if (resolvedEventId !== 'spouse_dies') return null;
    const cs = currentSpouse();
    if (!cs) return null;
    cs.status             = 'deceased';
    cs.diedAtPrincipalAge = age;
    cs.diedAge            = cs.ageAtMarriage + (age - cs.marriedAtPrincipalAge);
    // Record death in sharedEvents so stub expansion can inject it
    if (cs.sharedEvents) {
      cs.sharedEvents.push({
        eventId: 'spouse_dies', ageMin: cs.diedAge, ageMax: cs.diedAge,
        pool: 'biographical', meta: { principalId: 'principal', principalAge: age },
      });
    }
    return `${cs.name} died (approx. age ${cs.diedAge})`;
  }

  // ── PREGNANCY OUTCOME RESOLVER ───────────────────────────────────────────
  // Thin closure wrapper — delegates to the module-level _resolvePregnancyOutcome
  // which is independently testable via an explicit ctx object.
  function resolvePregnancyOutcome(age, ageGroup, maternalAge = age) {
    return resolvePregnancy(
      { char, isFemale, rand, currentSpouse, name, children, spouses,
        familyFollowOns, birthYear, hashId },
      age, ageGroup, maternalAge
    );
  }

  // Selects the oldest fosterable living child (aged 8–15, not yet fostered).
  // Flags the child stub with fostered:true and records the principal's age.
  // Returns a class-appropriate relationalNote string, or null if no eligible child.
  function handleChildFostering(resolvedEventId, age) {
    if (resolvedEventId === 'child_fostered') {
      const candidate = children
        .filter(c => {
          const childAge = age - c.bornAtPrincipalAge;
          return c.status === 'alive' && childAge >= 8 && childAge <= 15 && !c.fostered;
        })
        .sort((a, b) => b.bornAtPrincipalAge - a.bornAtPrincipalAge)[0];
      if (!candidate) return null;
      const childAge = age - candidate.bornAtPrincipalAge;
      candidate.fostered              = true;
      candidate.fosteredAtPrincipalAge = age;
      candidate.fosteredAtChildAge    = childAge;
      candidate.leftHome              = true;      // fostered = departed household
      candidate.leftHomeAtPrincipalAge = age;
      candidate.leftHomeAtChildAge    = childAge;
      if (candidate.sharedEvents) {
        candidate.sharedEvents.push({
          eventId: 'fostered', ageMin: childAge, ageMax: childAge,
          pool: 'biographical', principalAge: age, preHistory: childAge < 18,
        });
      }
      const placement = {
        noble:        `${candidate.name} sent as ward (age ${childAge})`,
        merchant:     `${candidate.name} apprenticed (age ${childAge})`,
        artisan: `${candidate.name} apprenticed (age ${childAge})`,
        warrior:      `${candidate.name} placed as page (age ${childAge})`,
        soldier:      `${candidate.name} hired out (age ${childAge})`,
        peasant:      `${candidate.name} hired out (age ${childAge})`,
      };
      return placement[char.socialClass] || `${candidate.name} fostered (age ${childAge})`;
    }

    if (resolvedEventId === 'child_placed_in_monastery') {
      // Selects the disabled child being placed. Sets monastery flag on stub.
      const candidate = children
        .filter(c => c.status === 'alive' && c.disability)
        .sort((a, b) => a.bornAtPrincipalAge - b.bornAtPrincipalAge)[0];
      if (!candidate) return null;
      const childAge = age - candidate.bornAtPrincipalAge;
      candidate.inMonastery              = true;
      candidate.monasteryAtPrincipalAge  = age;
      candidate.monasteryAtChildAge      = childAge;
      candidate.leftHome                 = true;
      candidate.leftHomeAtPrincipalAge   = age;
      candidate.leftHomeAtChildAge       = childAge;
      if (candidate.sharedEvents) {
        candidate.sharedEvents.push({
          eventId: 'placed_in_monastery', ageMin: childAge, ageMax: childAge,
          pool: 'biographical', principalAge: age, preHistory: childAge < 18,
          meta: { disability: candidate.disability },
        });
      }
      return `${candidate.name} placed in religious house (age ${childAge}, ${candidate.disability})`;
    }

    return null;
  }

  // ── PARALLEL CHILD SIMULATION ────────────────────────────────────────────────
  // Advances each living child stub one year, generating witnessed events for the
  // principal history. Called once per year after the family pool draw.
  // Replaces the random-draw approach for: child_married, child_dies,
  // grandchild_born, bastard_grandchild_born, child_leaves_home.
  // ─────────────────────────────────────────────────────────────────────────────

  function childMortalityProb(childAge, disability) {
    let prob;
    // Pagaelin: harsher environment, no medicine, female infanticide skews survival.
    // Target ~47% dying before 16 → ~53% survive → ~2.1 adults from ~4 early births.
    if (char.socialClass === 'pagaelin') {
      if (childAge < 1)  prob = 0.10;
      else if (childAge < 5)  prob = 0.06;
      else if (childAge < 15) prob = 0.025;
      else if (childAge < 40) prob = 0.015;
      else if (childAge < 60) prob = 0.030;
      else                    prob = 0.080;
    } else {
      if (childAge < 1)  prob = 0.08;
      else if (childAge < 5)  prob = 0.04;
      else if (childAge < 15) prob = 0.015;
      else if (childAge < 40) prob = 0.010;
      else if (childAge < 60) prob = 0.020;
      else                    prob = 0.055;
    }
    // Disabled children face higher mortality at all ages
    if (disability === 'simple' || disability === 'blind') prob *= 4;
    else if (disability === 'lame' || disability === 'deaf') prob *= 2.5;
    return Math.min(prob, 0.99);
  }

  function childMarriageProb(childAge, socialClass, sex) {
    if (childAge < 16) return 0;
    // Post-menopausal women almost never marry for the first time
    if (sex === 'female' && childAge >= 45) return 0.005;
    if (sex === 'female' && childAge >= 42) return 0.02;
    const base = { noble: 0.22, merchant: 0.20, warrior: 0.18, soldier: 0.15,
                   peasant: 0.18, unguilded: 0.16, artisan: 0.16 }[socialClass] ?? 0.18;
    if (childAge <= 25) return base;
    if (childAge <= 35) return base * 0.5;
    if (childAge <= 45) return base * 0.2;
    return base * 0.05;  // elderly men: rare but possible
  }

  function childDiesFlavour(child, childAge, isFemale) {
    const name = child.name || 'The child';
    const dis = child.disability;
    if (dis) {
      const disLabel = { simple: 'simple-minded', blind: 'blind', lame: 'lame' }[dis] ?? 'deaf';
      return isFemale
        ? `She lost ${name} \u2014 the ${disLabel} child she had given so much to.`
        : `${name} died \u2014 the ${disLabel} child he had worried over for years.`;
    }
    if (childAge < 3)  return isFemale
      ? 'She lost the infant before it had lived. She did not speak of it for a long time.'
      : 'The child did not survive its first years. He buried it and said nothing.';
    if (childAge < 12) return isFemale
      ? `She lost ${name} \u2014 still a child, not yet grown.`
      : `${name} died young \u2014 a child still.`;
    if (childAge < 18) return isFemale
      ? `${name} had nearly reached adulthood. She had thought the worst years of worry were behind her.`
      : `${name} was nearly grown when he died.`;
    return isFemale
      ? `${name} died before she had expected it. The grief of outliving a child did not diminish with their age.`
      : `${name} died. He had not thought a parent could grieve an adult child as much as an infant. He had been wrong.`;
  }

  function grandchildDiesFlavour(gc, gcAge, childName, isFemale) {
    const gcName = gc.name || 'the grandchild';
    if (gcAge < 3) return isFemale
      ? `${childName}'s infant did not survive. She felt the grief twice \u2014 for the child and for her own child's loss.`
      : `${childName}'s infant died. He grieved for the child and for what he saw in ${childName}'s face.`;
    return isFemale
      ? `${childName} lost ${gcName}. She watched her child grieve and did not know how to carry both sorrows at once.`
      : `${childName}'s child ${gcName} died. He watched his child grieve and could do nothing for either of them.`;
  }

  // Helper: create one grandchild stub, attach to parent child stub, return witnessed event object
  function _makeGrandchildStub(parent, parentAge, principalAge, isBastard) {
    const gcSex = rand() < 0.5 ? 'male' : 'female';
    const gcId = `${parent.id}-gc-${principalAge}-${(rand() * 1e6 | 0).toString(36)}`;
    // Generate a name — grandchild inherits parent's surname and social class
    const gcName = generateChildName(gcSex, parent.socialClass, parent.surname || null);
    const gc = {
      id: gcId, type: 'lightweight', role: 'grandchild',
      name: gcName.full, given: gcName.given, surname: gcName.surname,
      sex: gcSex,
      socialClass: parent.socialClass, status: 'alive',
      bornAtPrincipalAge: principalAge,
      birthYear: birthYear + principalAge,
      stubSeed: hashId(gcId), sharedEvents: [],
      parentId: parent.id, parentAge, isBastard,
    };
    if (!parent.children) parent.children = [];
    parent.children.push(gc);
    if (parent.sharedEvents) {
      parent.sharedEvents.push({
        eventId: 'first_child_born', ageMin: parentAge, ageMax: parentAge,
        pool: 'family', principalAge,
        meta: { gcId: gc.id, isBastard },
      });
    }
    if (!char.conditions.includes('has_grandchildren')) char.conditions.push('has_grandchildren');
    const isFemale = _sex === 'female';
    const eventId  = isBastard ? 'bastard_grandchild_born' : 'grandchild_born';
    const label    = isBastard ? 'Illegitimate grandchild born' : 'Grandchild born';
    const flavour  = isBastard
      ? (isFemale ? `One of her children had a child outside marriage.`
                  : `One of his children had a child outside marriage.`)
      : (isFemale ? `She held the grandchild and felt the full weight and joy of years.`
                  : `He held the child of his child and understood that time had passed.`);
    return {
      eventId, eventLabel: label, flavour,
      relationalNote: `${parent.name}'s ${isBastard ? 'illegitimate ' : ''}child born (${gcSex}, ${parent.name} age ${parentAge})`,
      gcId: gc.id, parentChildId: parent.id,
    };
  }


  // ── PAGAELIN HOUSEHOLD SYSTEM ─────────────────────────────────────────────
  // Dominant men hold multiple women; each held woman can be pregnant each year.
  // Female NPCs record the dominant man who holds them and their sister women.

  function generateHeldWomanStub(principalAge) {
    // Held women are substantially younger than the dominant man.
    // Pagaelin women are acquired at peak fertility: 14-22 years old.
    // A man aged 28 takes a girl of 16; a dominant man of 40 takes a girl of 18.
    // This is the economic logic of the culture: fertility is the asset.
    const minAge = 14;
    const maxAge = Math.min(24, Math.max(16, principalAge - 10));
    const womanAge = minAge + Math.floor(rand() * (maxAge - minAge + 1));
    const id = 'held_' + hashId('held_' + principalAge + '_' + heldWomen.length + '_' + rand());
    return {
      id,
      name:              null,
      sex:               'female',
      socialClass:       'pagaelin',
      ageAtAcquisition:  womanAge,
      acquiredAtPrincipalAge: principalAge,
      status:            'alive',
      pregnancyCooldown: 0,
      children:          [],
    };
  }

  function generateHolderStub(principalAge) {
    // The dominant man who holds a female NPC — typically older
    const manAge = principalAge + Math.floor(rand() * 15) + 2; // 2-17y older
    return {
      id:          'holder_' + hashId('holder_' + principalAge + '_' + rand()),
      name:        null,
      sex:         'male',
      socialClass: 'pagaelin',
      age:         manAge,
      status:      'alive',
    };
  }

  function generateRetainerStub(principalAge, phase) {
    // Retainers are men attached to a dominant man or chief's camp.
    // They fight for him, work for him, eat his food.
    // Their loyalty ranges: some are genuinely attached, some are using him to climb.
    // Age: mix of young warriors (seeking to learn) and older men who chose patronage.
    const ageRange = phase === 'chieftain'
      ? { min: 18, max: principalAge - 5 }   // chiefs attract a wider age range
      : { min: 18, max: Math.min(40, principalAge + 2) };  // dominants mostly younger men
    const retainerAge = ageRange.min + Math.floor(rand() * (ageRange.max - ageRange.min + 1));

    // Loyalty: 1=deeply loyal, 2=professionally loyal, 3=neutral, 4=climbing, 5=dangerous
    // Weighted toward middle — most men are using the relationship for mutual benefit
    const loyaltyWeights = [8, 20, 35, 25, 12];  // sum 100
    let loyaltyRoll = Math.floor(rand() * 100);
    let loyalty = 1;
    for (let i = 0; i < loyaltyWeights.length; i++) {
      loyaltyRoll -= loyaltyWeights[i];
      if (loyaltyRoll < 0) { loyalty = i + 1; break; }
    }

    const hasKilled = rand() < (retainerAge > 25 ? 0.85 : 0.50);  // older men more likely to have killed
    const id = 'retainer_' + hashId('ret_' + principalAge + '_' + heldWomen.length + '_' + rand());
    return {
      id,
      role:        'retainer',
      sex:         'male',
      socialClass: 'pagaelin',
      age:         retainerAge,
      status:      'alive',
      hasKilled,   // whether they have first_kill — affects their own ambitions
      loyalty,     // 1=loyal, 2=professional, 3=neutral, 4=climbing, 5=dangerous rival
      loyaltyLabel: ['deeply loyal','professionally loyal','neutral','climbing','dangerous rival'][loyalty-1],
      note:        hasKilled
        ? (loyalty <= 2 ? 'A proven fighter who chose to serve rather than compete.'
           : loyalty >= 4 ? 'Has killed. Watches the patron for weakness. This is what the patron did to his own patron.'
           : 'A working arrangement. He fights well. Neither of them examines it closely.')
        : (loyalty <= 2 ? 'Has not yet killed but is attached by something more than opportunity.'
           : 'Has not yet killed. Attached to this camp because it gives him access to raids. Will leave if a better offer appears.'),
    };
  }

  function advancePagaelinHousehold(age) {
    if (char.socialClass !== 'pagaelin') return [];
    const witnessed = [];

    if (!isFemale) {
      // ── MALE: advance each held woman ──────────────────────────────────
      for (const woman of heldWomen) {
        if (woman.status !== 'alive') continue;

        // Age the woman
        const womanCurrentAge = woman.ageAtAcquisition + (age - woman.acquiredAtPrincipalAge);

        // Pregnancy cooldown countdown
        if (woman.pregnancyCooldown > 0) {
          woman.pregnancyCooldown--;
          continue;
        }

        // Menopausal: no pregnancy after age 45
        if (womanCurrentAge >= 45) continue;

        // Pregnancy chance per year: ~40% when not in cooldown
        // (gives ~1 pregnancy every 2.5 years on average, matching Pagaelin realism)
        const pregChance = womanCurrentAge < 20 ? 0.35
                         : womanCurrentAge < 35 ? 0.42
                         : 0.25;

        if (rand() < pregChance) {
          // Determine outcome
          const miscarriageChance = 0.15 + (womanCurrentAge > 35 ? 0.05 : 0);
          const stillbirthChance  = 0.06;
          const roll = rand();
          let outcome;
          if (roll < miscarriageChance)                     outcome = 'miscarriage';
          else if (roll < miscarriageChance + stillbirthChance) outcome = 'stillbirth';
          else                                               outcome = 'live_birth';

          if (outcome === 'live_birth') {
            const childSex = rand() < 0.515 ? 'male' : 'female';
            const childId  = 'child_' + hashId('child_' + age + '_' + woman.id + '_' + rand());
            const childStub = {
              id:                 childId,
              name:               null,
              sex:                childSex,
              socialClass:        'pagaelin',
              bornAtPrincipalAge: age,
              status:             'alive',
              motherId:           woman.id,
              fatherId:           'principal',
              disability:         null,
              rhPositive:         true,
            };
            woman.children.push(childStub);
            children.push(childStub);   // also in principal's flat children array
            // 2-year nursing/recovery cooldown after live birth
            woman.pregnancyCooldown = 2;
            witnessed.push({
              age,
              eventId:        'pagaelin_child_born',
              label:          'Child born to held woman',
              pool:           'family',
              witnessed:      true,
              relationalNote: `${childSex === 'male' ? 'Son' : 'Daughter'} born to a held woman`,
            });
          } else {
            // Miscarriage or stillbirth: 1-year cooldown — she becomes pregnant again quickly.
            // This is the lived reality: no spacing by choice, only biology.
            woman.pregnancyCooldown = 1;
          }
        }
      }

      // Annual child mortality for children of held women
      for (const woman of heldWomen) {
        for (const child of woman.children) {
          if (child.status !== 'alive') continue;
          const childAge = age - child.bornAtPrincipalAge;
          if (rand() < childMortalityProb(childAge, child.disability)) {
            child.status             = 'deceased';
            child.diedAtPrincipalAge = age;
            child.diedAge            = childAge;
            // Mirror in flat children array
            const flat = children.find(c => c.id === child.id);
            if (flat) {
              flat.status             = 'deceased';
              flat.diedAtPrincipalAge = age;
              flat.diedAge            = childAge;
            }
          }
        }
      }

    } else {
      // ── FEMALE: set up holder and sister women if not yet done ─────────
      // On first year (age 18), if she is held, generate holder and sisters
      // Holder setup is handled in the event handler when pagaelin_held is first set.
      // No duplicate generation needed here.
    }

    return witnessed;
  }

    function advanceChildStubs(age) {
    const isFemale = _sex === 'female';
    const witnessed = [];

    for (const child of children) {
      if (child.status !== 'alive') continue;
      const childAge = age - child.bornAtPrincipalAge;

      // 1. Child mortality
      if (rand() < childMortalityProb(childAge, child.disability)) {
        child.status             = 'deceased';
        child.diedAtPrincipalAge = age;
        child.diedAge            = childAge;
        const stillAlive = children.filter(c => c.status === 'alive');
        if (stillAlive.length === 0) {
          const idx = char.conditions.indexOf('has_children');
          if (idx !== -1) char.conditions.splice(idx, 1);
          if (!char.conditions.includes('childless')) char.conditions.push('childless');
        }
        if (child.disability && !stillAlive.some(c => c.disability)) {
          const disIdx = char.conditions.indexOf('has_disabled_child');
          if (disIdx !== -1) char.conditions.splice(disIdx, 1);
        }
        witnessed.push({
          eventId: 'child_dies', eventLabel: 'Death of a child',
          flavour: childDiesFlavour(child, childAge, isFemale),
          relationalNote: `${child.name} died (age ${childAge})`,
          diedChildId: child.id,
        });
        continue;
      }

      // 2. Marriage
      if (!child.spouse && childAge >= 16 && rand() < childMarriageProb(childAge, child.socialClass, child.sex)) {
        const spouseSex = child.sex === 'male' ? 'female' : 'male';
        const spouseClass  = weightedRandom([[child.socialClass, 65], ['peasant', 20], ['artisan', 15]]);
        const spouseStub = generateSpouseStub({
          sex: spouseSex, socialClass: spouseClass,
          principalSurname: child.surname || null, principalAge: childAge,
        });
        if (child.birthYear != null) {
          spouseStub.birthYear    = child.birthYear + childAge - spouseStub.ageAtMarriage;
          spouseStub.stubSeed     = hashId(spouseStub.id);
          spouseStub.sharedEvents = [{
            eventId: 'married', ageMin: spouseStub.ageAtMarriage, ageMax: spouseStub.ageAtMarriage,
            pool: 'biographical', meta: { childId: child.id, childAge },
          }];
        }
        child.spouse = {
          id: spouseStub.id, name: spouseStub.name, given: spouseStub.given,
          surname: spouseStub.surname, sex: spouseStub.sex,
          socialClass: spouseStub.socialClass, ageAtMarriage: spouseStub.ageAtMarriage,
          marriedAtPrincipalAge: age, marriedAtChildAge: childAge, status: 'alive',
          birthYear: spouseStub.birthYear ?? null,
          stubSeed: spouseStub.stubSeed ?? null,
          sharedEvents: spouseStub.sharedEvents ?? [],
        };
        if (child.sharedEvents) {
          child.sharedEvents.push({
            eventId: 'married', ageMin: childAge, ageMax: childAge,
            pool: 'biographical', principalAge: age,
            meta: { spouseId: spouseStub.id, spouseName: spouseStub.name },
          });
        }
        const childLabel = child.sex === 'male' ? 'son' : 'daughter';
        witnessed.push({
          eventId: 'child_married', eventLabel: 'Child married',
          flavour: isFemale
            ? `Her ${childLabel} ${child.name} married ${spouseStub.name}.`
            : `His ${childLabel} ${child.name} married ${spouseStub.name}.`,
          relationalNote: `${child.name} married ${spouseStub.name} (${spouseClass}, age ${spouseStub.ageAtMarriage})`,
        });
      }

      // 3. Spouse mortality
      if (child.spouse?.status === 'alive') {
        const spouseAge = child.spouse.ageAtMarriage + (childAge - child.spouse.marriedAtChildAge);
        if (rand() < childMortalityProb(spouseAge, null)) {
          child.spouse.status             = 'deceased';
          child.spouse.diedAtPrincipalAge = age;
          child.spouse.diedAtChildAge     = childAge;
          // Record widowing age on child stub for remarriage probability
          child.widowedAtChildAge = childAge;
        }
      }

      // 3b. Remarriage (widowed children)
      if (child.spouse?.status === 'deceased') {
        const widowedAt    = child.widowedAtChildAge ?? child.spouse.diedAtChildAge ?? childAge;
        const yearsSince   = childAge - widowedAt;
        const hasGC        = (child.children||[]).some(g => g.status === 'alive');
        const remarriages  = child.previousSpouses?.length ?? 0;
        // Each prior remarriage halves the probability — uncommon but possible
        const remarriageMult = Math.pow(0.5, remarriages);

        let baseProb;
        if      (widowedAt < 30) baseProb = hasGC ? 0.30 : 0.22;
        else if (widowedAt < 40) baseProb = hasGC ? 0.20 : 0.14;
        else if (widowedAt < 50) baseProb = 0.08;
        else                     baseProb = 0.03;

        // Post-menopausal women almost never remarry — near-zero after 45,
        // essentially zero after 50. Men remain eligible as long as someone will have them.
        if (child.sex === 'female') {
          if (childAge >= 50) baseProb = 0.005;
          else if (childAge >= 45) baseProb = Math.min(baseProb, 0.04);
        }

        if (yearsSince > 5)  baseProb *= 0.4;
        if (yearsSince > 10) baseProb *= 0.2;
        if (child.sex === 'male') baseProb *= 1.3;
        baseProb *= remarriageMult;

        if (rand() < baseProb) {
          // Create new spouse stub
          const newSpouseSex = child.sex === 'male' ? 'female' : 'male';
          // Remarriage partners tend to be older or same age — wider age range
          const ageOffset = child.sex === 'male'
            ? Math.floor(rand() * 15) - 5
            : Math.floor(rand() * 10) - 2;
          const newSpouseClass = weightedRandom([
            [child.socialClass, 60], ['peasant', 25], ['artisan', 15],
          ]);
          const newSpouseStub = generateSpouseStub({
            sex: newSpouseSex, socialClass: newSpouseClass,
            principalSurname: child.surname || null,
            principalAge: childAge, ageOffset,
          });
          const newSpouseAge = newSpouseStub.ageAtMarriage;
          if (child.birthYear != null) {
            newSpouseStub.birthYear    = child.birthYear + childAge - newSpouseAge;
            newSpouseStub.stubSeed     = hashId(newSpouseStub.id);
            newSpouseStub.sharedEvents = [{
              eventId: 'married', ageMin: newSpouseAge, ageMax: newSpouseAge,
              pool: 'biographical', meta: { childId: child.id, childAge, isRemarriage: true },
            }];
          }

          // Archive old spouse, install new one
          if (!child.previousSpouses) child.previousSpouses = [];
          child.previousSpouses.push(child.spouse);
          child.spouse = {
            id: newSpouseStub.id, name: newSpouseStub.name, given: newSpouseStub.given,
            surname: newSpouseStub.surname, sex: newSpouseStub.sex,
            socialClass: newSpouseStub.socialClass,
            ageAtMarriage: newSpouseAge,
            marriedAtPrincipalAge: age, marriedAtChildAge: childAge, status: 'alive',
            birthYear: newSpouseStub.birthYear ?? null,
            stubSeed:  newSpouseStub.stubSeed  ?? null,
            sharedEvents: newSpouseStub.sharedEvents ?? [],
            isRemarriage: true,
          };
          child.widowedAtChildAge = null;  // reset — not widowed while spouse is alive

          if (child.sharedEvents) {
            child.sharedEvents.push({
              eventId: 'remarried', ageMin: childAge, ageMax: childAge,
              pool: 'biographical', principalAge: age,
              meta: { spouseId: newSpouseStub.id, spouseName: newSpouseStub.name },
            });
          }

          const childLabel = child.sex === 'male' ? 'son' : 'daughter';
          witnessed.push({
            eventId: 'child_married', eventLabel: 'Child remarried',
            flavour: isFemale
              ? `Her ${childLabel} ${child.name} remarried.`
              : `His ${childLabel} ${child.name} remarried.`,
            relationalNote: `${child.name} remarried ${newSpouseStub.name} (${newSpouseClass}, age ${newSpouseAge})`,
          });
        }
      }

      // 4. Births (legitimate and bastard)
      // Birth spacing: minimum 2 years between births (nursing/recovery).
      // Lifetime cap: tracked via child.gcBornCount — medieval women averaged
      // 6-8 pregnancies; we use a soft cap via declining probability after 6.
      const lastBirth       = child.lastGcBirthAge ?? -99;
      const birthsSoFar     = child.gcBornCount ?? 0;
      const birthCooldown   = (childAge - lastBirth) >= 2;
      // Probability declines after 6 births to enforce realistic lifetime fertility
      const birthProbMult   = birthsSoFar < 4 ? 1.0 : birthsSoFar < 7 ? 0.5 : 0.15;

      const isFertileWife    = child.sex === 'female' && child.spouse?.status === 'alive'
                               && childAge >= 16 && childAge <= 42 && birthCooldown;
      const isFertileHusband = child.sex === 'male'   && child.spouse?.status === 'alive'
                               && childAge >= 16 && birthCooldown;
      const isUnmarriedAdult = !child.spouse && childAge >= 16 && birthCooldown;

      if ((isFertileWife || isFertileHusband) && rand() < 0.18 * birthProbMult) {
        const gcNote = _makeGrandchildStub(child, childAge, age, false);
        if (gcNote) {
          child.lastGcBirthAge = childAge;
          child.gcBornCount    = birthsSoFar + 1;
          witnessed.push(gcNote);
        }
      } else if (isUnmarriedAdult && rand() < 0.05 * birthProbMult) {
        const gcNote = _makeGrandchildStub(child, childAge, age, true);
        if (gcNote) {
          child.lastGcBirthAge = childAge;
          child.gcBornCount    = birthsSoFar + 1;
          if (!char.conditions.includes('disgraced')) char.conditions.push('disgraced');
          witnessed.push(gcNote);
        }
      }

      // 5. Grandchild mortality
      for (const gc of (child.children || [])) {
        if (gc.status !== 'alive') continue;
        const gcAge = age - gc.bornAtPrincipalAge;
        if (rand() < childMortalityProb(gcAge, gc.disability)) {
          gc.status             = 'deceased';
          gc.diedAtPrincipalAge = age;
          gc.diedAge            = gcAge;
          witnessed.push({
            eventId: 'grandchild_dies', eventLabel: 'Death of a grandchild',
            flavour: grandchildDiesFlavour(gc, gcAge, child.name, isFemale),
            relationalNote: `${child.name}'s child died (age ${gcAge})`,
            gcId: gc.id, parentChildId: child.id,
          });
        }
      }

      // 6. Departure
      if (!child.leftHome && childAge >= 18 && childAge <= 28 && rand() < 0.15) {
        child.leftHome               = true;
        child.leftHomeAtPrincipalAge = age;
        child.leftHomeAtChildAge     = childAge;
        if (child.sharedEvents) {
          child.sharedEvents.push({
            eventId: 'left_home', ageMin: childAge, ageMax: childAge,
            pool: 'biographical', principalAge: age,
          });
        }
        witnessed.push({
          eventId: 'child_leaves_home', eventLabel: 'Child left home',
          flavour: isFemale
            ? `${child.name} left to make her own way.`
            : `${child.name} left home to make his own way.`,
          relationalNote: `${child.name} left home (age ${childAge})`,
        });
      }
    }

    return witnessed;
  }

  function handleContactCreation(evId, age) {
    // Helper: create a contact stub with expansion metadata stamped.
    // All contact creation must go through here — never call generateContactStub directly.
    function makeContactStub(opts) {
      const stub = generateContactStub(opts);
      stub.birthYear    = birthYear - (stub.ageAtMeeting - age);  // back-compute from meeting age
      stub.stubSeed     = hashId(stub.id);
      stub.sharedEvents = [];  // contacts have no shared household events by default
      return stub;
    }

    switch (evId) {
      case 'lost_comrade': {
        const stub = makeContactStub({
          role: 'comrade', sex: null, socialClass: char.socialClass,
          principalAge: age, ageOffsetMin: -5, ageOffsetMax: 5,
          eventId: evId, metAtPrincipalAge: age, status: 'deceased',
          note: 'Died — lost as a close companion.',
        });
        stub.diedAtPrincipalAge = age;
        contacts.push(stub);
        return `${stub.name} died`;
      }
      case 'acquaintance_killed': {
        const g = rand() < 0.75 ? 'male' : 'female';
        const stub = makeContactStub({
          role: 'acquaintance', sex: g, socialClass: char.socialClass,
          principalAge: age, ageOffsetMin: -10, ageOffsetMax: 10,
          eventId: evId, metAtPrincipalAge: age, status: 'deceased',
          note: 'Killed by violence.',
        });
        stub.diedAtPrincipalAge = age;
        contacts.push(stub);
        return `${stub.name} was killed`;
      }
      case 'feud_involvement': {
        const stub = makeContactStub({
          role: 'enemy', sex: 'male', socialClass: char.socialClass,
          principalAge: age, ageOffsetMin: -5, ageOffsetMax: 15,
          eventId: evId, metAtPrincipalAge: age, status: 'alive',
          note: 'Drew this character into a killing feud.',
        });
        contacts.push(stub);
        return `Feud with ${stub.name}`;
      }
      case 'reconciled_old_enemy': {
        const enemy = [...contacts].reverse().find(c => c.role === 'enemy' && c.status === 'alive');
        if (enemy) {
          enemy.note = (enemy.note || '') + ` Reconciled at principal age ${age}.`;
          return `Reconciled with ${enemy.name}`;
        }
        const stub = makeContactStub({
          role: 'enemy', sex: null, socialClass: char.socialClass,
          principalAge: age, ageOffsetMin: -10, ageOffsetMax: 10,
          eventId: evId, metAtPrincipalAge: age, status: 'alive',
          note: `Old enemy — reconciled at principal age ${age}.`,
        });
        contacts.push(stub);
        return `Reconciled with ${stub.name}`;
      }
      case 'made_useful_contact': {
        const contactClass = weightedRandom([
          [char.socialClass, 50], ['merchant', 20], ['noble', 15], ['clergy', 15],
        ]);
        const stub = makeContactStub({
          role: 'contact', sex: null, socialClass: contactClass,
          principalAge: age, ageOffsetMin: -5, ageOffsetMax: 15,
          eventId: evId, metAtPrincipalAge: age, status: 'alive',
          note: 'A useful connection made during travels or dealings.',
        });
        contacts.push(stub);
        return `Made contact: ${stub.name} (${contactClass})`;
      }
      case 'confided_secret': {
        const stub = makeContactStub({
          role: 'confidant', sex: null, socialClass: char.socialClass,
          principalAge: age, ageOffsetMin: -10, ageOffsetMax: 10,
          eventId: evId, metAtPrincipalAge: age, status: 'alive',
          note: 'Trusted with a dangerous secret.',
        });
        contacts.push(stub);
        return `Confided in ${stub.name}`;
      }
      case 'ward_received': {
        const wardSex = rand() < 0.5 ? 'male' : 'female';
        const stub = makeContactStub({
          role: 'ward', sex: wardSex, socialClass: 'noble',
          principalAge: age, ageOffsetMin: -25, ageOffsetMax: -8,
          eventId: evId, metAtPrincipalAge: age, status: 'alive',
          note: 'Ward placed in this household by their family.',
        });
        contacts.push(stub);
        return `Took in ${stub.name} as ward`;
      }
      case 'masterwork_commissioned': {
        const patronClass = weightedRandom([['noble', 55], ['merchant', 30], ['clergy', 15]]);
        const stub = makeContactStub({
          role: 'patron', sex: null, socialClass: patronClass,
          principalAge: age, ageOffsetMin: -5, ageOffsetMax: 20,
          eventId: evId, metAtPrincipalAge: age, status: 'alive',
          note: 'Commissioned a significant work from this artisan.',
        });
        contacts.push(stub);
        return `Commissioned by ${stub.name} (${patronClass})`;
      }
      case 'took_an_apprentice': {
        const stub = makeContactStub({
          role: 'apprentice', sex: null, socialClass: char.socialClass,
          principalAge: age, ageOffsetMin: -20, ageOffsetMax: -8,
          eventId: evId, metAtPrincipalAge: age, status: 'alive',
          note: 'Taken on as apprentice.',
        });
        contacts.push(stub);
        return `Took on ${stub.name} as apprentice`;
      }
      case 'apprentice_graduates': {
        // Promote the most recent living apprentice to former_apprentice
        const apprentice = [...contacts].reverse()
          .find(c => c.status === 'alive' && c.role === 'apprentice');
        if (!apprentice) return null;
        apprentice.role = 'former_apprentice';
        apprentice.note = (apprentice.note ? apprentice.note + ' ' : '') +
          `Completed apprenticeship and became a journeyman at principal age ${age}.`;
        return `${apprentice.name} completed apprenticeship`;
      }
      case 'mentor_a_youngster': {
        const stub = makeContactStub({
          role: 'protégé', sex: null, socialClass: char.socialClass,
          principalAge: age, ageOffsetMin: -20, ageOffsetMax: -8,
          eventId: evId, metAtPrincipalAge: age, status: 'alive',
          note: 'Mentored by this character.',
        });
        contacts.push(stub);
        return `Mentored ${stub.name}`;
      }
      case 'protege_finds_their_path': {
        // Promote the most recent living protégé
        const protege = [...contacts].reverse()
          .find(c => c.status === 'alive' && c.role === 'protégé');
        if (!protege) return null;
        protege.role = 'former_protégé';
        protege.note = (protege.note ? protege.note + ' ' : '') +
          `Found their own path at principal age ${age}.`;
        return `${protege.name} found their own way`;
      }
      case 'studied_with_master': {
        const masterClass = weightedRandom([
          [char.socialClass, 40], ['clergy', 30], ['merchant', 20], ['noble', 10],
        ]);
        const stub = makeContactStub({
          role: 'master', sex: 'male', socialClass: masterClass,
          principalAge: age, ageOffsetMin: 8, ageOffsetMax: 30,
          eventId: evId, metAtPrincipalAge: age, status: 'alive',
          note: 'A skilled practitioner under whom this character studied.',
        });
        contacts.push(stub);
        return `Studied under ${stub.name}`;
      }
      default:
        return null;
    }
  }

  function handleContactEvolution(evId, age) {
    switch (evId) {
      case 'contact_dies': {
        const target = contacts.find(c => c.status === 'alive' && c.role !== 'enemy');
        if (!target) return null;
        target.status             = 'deceased';
        target.diedAtPrincipalAge = age;
        target.diedAge            = target.ageAtMeeting != null
          ? (age - target.metAtPrincipalAge) + target.ageAtMeeting : null;
        target.note = (target.note ? target.note + ' ' : '') +
          `Died while known to principal (principal age ${age}).`;
        return `${target.name} has died`;
      }
      case 'contact_betrayal': {
        const target = [...contacts].reverse().find(c =>
          c.status === 'alive' &&
          (c.relationshipBand === 'close' || c.relationshipBand === 'neutral') &&
          c.role !== 'enemy'
        );
        if (!target) return null;
        const oldBand           = target.relationshipBand;
        target.relationshipBand = 'hostile';
        target.hostileSetAtAge  = age;
        target.note = (target.note ? target.note + ' ' : '') +
          `Betrayed the principal at principal age ${age} (was ${oldBand}).`;
        return `Betrayed by ${target.name}`;
      }
      case 'contact_falls_out': {
        const target = [...contacts].reverse().find(c =>
          c.status === 'alive' && c.relationshipBand === 'close'
        ) || [...contacts].reverse().find(c =>
          c.status === 'alive' && c.relationshipBand === 'neutral' && c.role !== 'enemy'
        );
        if (!target) return null;
        const oldBand           = target.relationshipBand;
        target.relationshipBand = oldBand === 'close' ? 'strained' : 'neutral';
        target.note = (target.note ? target.note + ' ' : '') +
          `Fell out with the principal at principal age ${age} (was ${oldBand}).`;
        return `Fell out with ${target.name}`;
      }
      case 'contact_reconciles': {
        const target = [...contacts].reverse().find(c =>
          c.status === 'alive' &&
          (c.relationshipBand === 'strained' || c.relationshipBand === 'hostile') &&
          !(c.reconciledAtAge != null && (age - c.reconciledAtAge) < 3) &&
          !(c.hostileSetAtAge  != null && (age - c.hostileSetAtAge)  < 2)
        );
        if (!target) return null;
        const oldBand           = target.relationshipBand;
        target.relationshipBand = oldBand === 'hostile' ? 'neutral' : 'close';
        if (target.role === 'enemy') target.role = 'contact';
        target.reconciledAtAge  = age;
        target.note = (target.note ? target.note + ' ' : '') +
          `Reconciled with the principal at principal age ${age} (was ${oldBand}).`;
        return `Reconciled with ${target.name}`;
      }
      case 'contact_deepens': {
        const target = [...contacts].reverse().find(c =>
          c.status === 'alive' && c.relationshipBand === 'neutral' && c.role !== 'enemy'
        );
        if (!target) return null;
        target.relationshipBand = 'close';
        target.note = (target.note ? target.note + ' ' : '') +
          `Became a genuine friend/ally of the principal at principal age ${age}.`;
        return `${target.name} became a close friend`;
      }
      case 'contact_lost_touch': {
        const target = [...contacts].reverse().find(c =>
          c.status === 'alive' &&
          c.role !== 'enemy' &&
          !(c.relationshipBand === 'hostile' && (age - (c.hostileSetAtAge ?? -99)) < 2)
        );
        if (!target) return null;
        target.status = 'lost_touch';
        target.note = (target.note ? target.note + ' ' : '') +
          `Lost touch with the principal at principal age ${age}.`;
        return `Lost touch with ${target.name}`;
      }
      case 'contact_becomes_enemy': {
        const target = [...contacts].reverse().find(c =>
          c.status === 'alive' &&
          (c.relationshipBand === 'strained' || c.relationshipBand === 'neutral') &&
          c.role !== 'enemy'
        );
        if (!target) return null;
        const oldRole           = target.role;
        const oldBand           = target.relationshipBand;
        target.role             = 'enemy';
        target.relationshipBand = 'hostile';
        target.hostileSetAtAge  = age;
        target.note = (target.note ? target.note + ' ' : '') +
          `Became an enemy of the principal at principal age ${age} (was ${oldRole}, ${oldBand}).`;
        return `${target.name} became an enemy`;
      }
      default:
        return null;
    }
  }

  // ── shared event resolution helper ──────────────────────────────────────
  // Resolves one drawn event: injuries, Rh outcomes, relational records,
  // OP/attribute/condition/class/deity effects.
  // Returns { resolvedEvent, injuryDetail, rhNote, relationalNote,
  //           freeOPs, skillOPs, totalSpent }
  // and mutates char, spouses, children, skillOPMap, classChanges, deityChanges.

  function resolveEvent(event, age, ageGroup) {

    let resolvedAttributes      = event.effects?.attributes ? { ...event.effects.attributes } : null;
    let resolvedConditionsAdd    = event.effects?.conditions?.add    ? [...event.effects.conditions.add]    : [];
    let resolvedConditionsRemove = event.effects?.conditions?.remove ? [...event.effects.conditions.remove] : [];
    // Ensure effects is never null downstream — colour events carry null effects
    const resolvedEffects = event.effects ?? { ops: 0, skills: null, totalOPs: 0, attributes: null, conditions: null, classChange: null, deityChange: null };
    let injuryDetail             = null;
    let rhNote                   = null;
    let relationalNote           = null;
    let resolvedEvent            = event;
    let diedChildId              = null;   // set when child_dies fires

    // ── injury / disease resolver ───────────────────────────────────────
    const injuryBinding = EVENT_INJURY_MAP[event.id];
    if (injuryBinding) {
      if (injuryBinding.type === 'injury') {
        const resolved = resolveInjuryEffects(injuryBinding.context);
        resolvedAttributes = resolved.attributes;
        for (const c of resolved.conditionsAdd) {
          if (!resolvedConditionsAdd.includes(c)) resolvedConditionsAdd.push(c);
        }
        injuryDetail = resolved;
      } else if (injuryBinding.type === 'disease') {
        const resolved = resolveDiseaseEffects(injuryBinding.diseaseType);
        resolvedAttributes = resolved.attributes;
        for (const c of resolved.conditionsAdd) {
          if (!resolvedConditionsAdd.includes(c)) resolvedConditionsAdd.push(c);
        }
        injuryDetail = resolved;
      }
    }

    // ── Maternal death — male principal's wife ───────────────────────────
    // When spouse_dies_childbirth fires for a male, roll whether the child
    // born this year survives. The spouse is marked deceased with cause childbirth.
    // Maternal mortality rate scales with wife's age (~8% base, +2% per 5yr over 25).
    if (!isFemale && resolvedEvent.id === 'spouse_dies_childbirth') {
      const cs = currentSpouse();
      if (cs) {
        const wifeAge = cs.ageAtMarriage + (age - cs.marriedAtPrincipalAge);
        const mortalityChance = Math.min(0.35, 0.08 + Math.max(0, wifeAge - 25) * 0.004);
        if (rand() < mortalityChance) {
          cs.status              = 'deceased';
          cs.diedAtPrincipalAge  = age;
          cs.diedAge             = wifeAge;
          cs.causeOfDeath        = 'childbirth';
          relationalNote = `${cs.name} died in childbirth (age ${wifeAge})`;
          // married is derived from spouses array — no condition removal needed
          resolvedConditionsAdd    = ['ever_widowed','bereaved_child'];
          resolvedConditionsRemove = [];
        } else {
          // Wife survived — downgrade to a difficult birth, record child
          resolvedEvent = LIFE_EVENTS_BY_ID.get('difficult_birth') || event;
          resolvedConditionsAdd    = ['has_children'];
          resolvedConditionsRemove = [];
        }
      }
    }

    // ── apply OPs ────────────────────────────────────────────────────────
    const { freeOPs, skillOPs, totalSpent } = applyOPs(resolvedEvent, OP_ANNUAL_BUDGET);
    totalOPsEarned += totalSpent;
    totalOPsFree   += freeOPs;
    for (const { skill, ops } of skillOPs) {
      skillOPMap[skill] = (skillOPMap[skill] || 0) + ops;
    }

    // ── apply attributes ─────────────────────────────────────────────────
    if (resolvedAttributes) {
      for (const [attr, delta] of Object.entries(resolvedAttributes)) {
        if (char.attributes[attr] !== undefined) {
          char.attributes[attr] = Math.max(1, Math.min(21, char.attributes[attr] + delta));
        }
      }
    }

    // ── apply conditions ─────────────────────────────────────────────────
    for (const c of resolvedConditionsRemove) {
      const idx = char.conditions.indexOf(c);
      if (idx !== -1) char.conditions.splice(idx, 1);
      // Reset tracking when disgrace is explicitly removed by an event
      if (c === 'disgraced') char.disgracedAtAge = null;
    }
    for (const c of resolvedConditionsAdd) {
      if (!char.conditions.includes(c)) char.conditions.push(c);
      // Track when disgrace was first applied for time-based fade
      if (c === 'disgraced') {
        char.disgracedAtAge = age;   // always reset — each new disgrace restarts the clock
      }
    }
    // ── Mutually exclusive condition groups ───────────────────────────────
    // When a condition in a group is added, remove all other conditions in
    // the same group. Prevents contradictions like 'prosperous' + 'ruined'.
    const MUTEX_GROUPS = [
      ['prosperous', 'ruined', 'destitute'],       // economic status
      ['devout', 'faith_crisis'],                   // faith status
      ['robust', 'declining_health', 'chronic_illness'], // health trajectory
    ];
    for (const newCond of resolvedConditionsAdd) {
      for (const group of MUTEX_GROUPS) {
        if (group.includes(newCond)) {
          for (const other of group) {
            if (other !== newCond) {
              const idx = char.conditions.indexOf(other);
              if (idx !== -1) char.conditions.splice(idx, 1);
            }
          }
        }
      }
    }
    // Track start ages for spouse/lover levy so the 4-year cap can fire
    if (resolvedConditionsAdd.includes('spouse_on_levy') && char.spouseLevyStartAge == null)
      char.spouseLevyStartAge = age;
    if (resolvedConditionsAdd.includes('lover_on_levy') && char.loverLevyStartAge == null)
      char.loverLevyStartAge = age;
    if (resolvedConditionsRemove.includes('spouse_on_levy')) char.spouseLevyStartAge = null;
    if (resolvedConditionsRemove.includes('lover_on_levy'))  char.loverLevyStartAge  = null;

    // ── apply class change ────────────────────────────────────────────────
    let archetypeRerolledThisEvent = false;
    if (resolvedEffects.classChange) {
      const { to, note, onlyFrom } = resolvedEffects.classChange;
      // priest_naveh class changes are blocked entirely — the temple controls its
      // members' lives from birth. A Navehan priest who 'loses livelihood to debt'
      // is narratively incoherent: they would be dead, compromised, or extracted by
      // the order, not casually downwardly mobile. Naveh-specific exit events handle
      // the genuine exit cases (cover_burned, expelled) via forcedEvents instead.
      if (char.socialClass === 'priest_naveh') {
        // swallow the class change silently — temple controls its members' lives
      } else if (char.socialClass === 'pagaelin') {
        // swallow — Pagaelin cannot casually drift into Kaldoric social classes
        // Cross-cultural transitions (slave capture, escape) use dedicated events
      } else if (!onlyFrom || char.socialClass === onlyFrom) {
        // Settlement-aware ruin destination:
        // financial_ruin sends urban NPCs to unguilded (urban poor), rural to peasant
        let resolvedTo = to;
        if (event.id === 'financial_ruin' && to === 'peasant') {
          const isUrban = ['city','town'].includes(char.settlementType);
          resolvedTo = isUrban ? 'unguilded' : 'peasant';
        }
        classChanges.push({ fromAge: age, from: char.socialClass, to: resolvedTo, note });
        char.socialClass = resolvedTo;

        const newPhase = to === 'artisan'    ? 'journeyman' :
                          to === 'destitute'  ? 'street'     :
                          to === 'lia_kavair' && char.socialClass === 'destitute' ? 'recruit' :
                          'established';
        const settlementAfter = (() => {
          const trans = applySettlementTransition(resolvedEvent.id, char.settlementType, _sex);
          return trans.next || char.settlementType;
        })();
        const newArchetype = rollArchetype(to, _sex, newPhase, settlementAfter);
        if (newArchetype) {
          archetypeChanges.push({ fromAge: age, from: resolvedArchetype?.id || null, to: newArchetype.id, reason: 'class_change' });
          resolvedArchetype = newArchetype;
          char.archetype    = newArchetype.id;
          archetypeRerolledThisEvent = true;
        }
      }
    }

    // ── apply deity change ────────────────────────────────────────────────
    if (resolvedEffects.deityChange) {
      const { to, note } = resolvedEffects.deityChange;
      const oldDeity = char.publicDeity;
      if (to === 'ROLL') {
        // Re-roll from the deity table for the current class — conversion to new faith
        const rerolled = selectDeity(char.socialClass, _sex, null);
        char.publicDeity = rerolled.publicDeity;
      } else {
        char.publicDeity = to;
      }
      deityChanges.push({ fromAge: age, from: oldDeity, to: char.publicDeity, note });
    }

    // ── relational record updates ─────────────────────────────────────────
    const evId = resolvedEvent.id;

    // ── archetype re-roll on major trajectory shift (same class) ─────────
    // Only fires if the class-change block did NOT already re-roll the archetype.
    // financial_ruin and fled_to_town both trigger class changes AND appear in
    // ROOTLESS_TRIGGERS — without this guard both blocks would re-roll, with the
    // second overwriting the first and consuming extra RNG calls.
    if (!archetypeRerolledThisEvent) {
      const ROOTLESS_TRIGGERS = new Set(['fled_to_town','outlawed','deserted','noble_exile','financial_ruin']);
      if (ROOTLESS_TRIGGERS.has(evId)) {
        const settlementAfter = (() => {
          const trans = applySettlementTransition(evId, char.settlementType, _sex);
          return trans.next || char.settlementType;
        })();
        const currentBias = resolvedArchetype?.settlementBias?.[settlementAfter] ?? 1.0;
        if (currentBias < 0.5) {
          const rerolled = rollArchetype(char.socialClass, _sex, char.phase, settlementAfter,
             char.socialClass === 'pagaelin' ? new Set(char.conditions) : null);
          if (rerolled && rerolled.id !== resolvedArchetype?.id) {
            archetypeChanges.push({ fromAge: age, from: resolvedArchetype?.id || null, to: rerolled.id, reason: 'trajectory_shift' });
            resolvedArchetype = rerolled;
            char.archetype    = rerolled.id;
          }
        }
      }
    }

    // ── kept_woman archetype switch ───────────────────────────────────────
    // taken_as_mistress: switch to peasant_kept_woman, save civilian archetype.
    // patron_marries_her: re-roll for new merchant class (class change handles
    //   the social class; archetype re-roll handled by class-change block above).
    // patron_abandons_her: restore civilian archetype or re-roll unguilded poor.
    // Not applicable to lia_kavair — patron relationships are social cover, not class change.
    if (char.socialClass !== 'lia_kavair' && (evId === 'taken_as_mistress' || evId === 'taken_as_kept_man')) {
      const keptArch = getArchetype('peasant_kept_woman');
      if (keptArch) {
        savedCivilianArchetype = resolvedArchetype;
        archetypeChanges.push({ fromAge: age, from: resolvedArchetype?.id || null, to: keptArch.id, reason: 'kept_woman_start' });
        resolvedArchetype = keptArch;
        char.archetype    = keptArch.id;
      }
    }
    if (evId === 'patron_abandons_her') {
      // Restore civilian archetype; if none saved, re-roll for current class + settlement
      const restored = savedCivilianArchetype
        || rollArchetype(char.socialClass, _sex, char.phase, char.settlementType,
             char.socialClass === 'pagaelin' ? new Set(char.conditions) : null);
      if (restored) {
        archetypeChanges.push({ fromAge: age, from: resolvedArchetype?.id || null, to: restored.id, reason: 'kept_woman_end' });
        resolvedArchetype      = restored;
        char.archetype         = restored.id;
        savedCivilianArchetype = null;
      }
    }
    // patron_marries_her: the class-change block above handles the archetype re-roll
    // for the new merchant class; just clear the saved civilian archetype.
    if (evId === 'patron_marries_her') {
      savedCivilianArchetype = null;
    }

    // ── levy service handlers ─────────────────────────────────────────────
    // All conscription side-effects in one place. Schema handles on_levy+veteran
    // (via resolveEvent condition application above). Engine handles the rest:
    // archetype switch, levyStartAge, and tour counter (which depends on
    // how many previous tours have occurred — state the schema cannot express).
    if (evId === 'conscripted') {
      const levyArch = getArchetype(_sex === 'female' ? 'soldier_camp_healer' : 'soldier_pressed_man');
      if (levyArch && resolvedArchetype?.id !== levyArch.id) {
        savedCivilianArchetype = resolvedArchetype;
        archetypeChanges.push({ fromAge: age, from: resolvedArchetype?.id || null, to: levyArch.id, reason: 'levy_start' });
        resolvedArchetype = levyArch;
        char.archetype    = levyArch.id;
      }
      char.levyStartAge = age;
      const nextTour = char.conditions.includes('levy_tour_2') ? 'levy_tour_3'
                     : char.conditions.includes('levy_tour_1') ? 'levy_tour_2'
                     : 'levy_tour_1';
      if (!char.conditions.includes(nextTour)) char.conditions.push(nextTour);
    }

    // Female principal follows husband or lover to the army — same archetype switch
    // as conscripted. Schema sets camp_follower condition; engine handles archetype.
    // lover_conscripted just sets lover_on_levy — no archetype change at that point.
    if (evId === 'followed_husband_to_levy') {
      const campArch = getArchetype('soldier_camp_healer');
      if (campArch && resolvedArchetype?.id !== campArch.id) {
        savedCivilianArchetype = resolvedArchetype;
        archetypeChanges.push({ fromAge: age, from: resolvedArchetype?.id || null, to: campArch.id, reason: 'camp_follower_start' });
        resolvedArchetype = campArch;
        char.archetype    = campArch.id;
      }
    }

    // All discharge side-effects in one place. Schema handles removing on_levy+camp_follower.
    if (evId === 'discharged_from_levy' || evId === 'husband_returns_from_levy' || evId === 'lover_returns_from_levy') {
      // Restore pre-levy/pre-camp civilian archetype
      if (savedCivilianArchetype) {
        const reason = evId === 'discharged_from_levy' ? 'levy_end' : 'camp_follower_end';
        archetypeChanges.push({ fromAge: age, from: resolvedArchetype?.id || null, to: savedCivilianArchetype.id, reason });
        resolvedArchetype      = savedCivilianArchetype;
        char.archetype         = savedCivilianArchetype.id;
        savedCivilianArchetype = null;
      }
      if (evId === 'discharged_from_levy') char.levyStartAge = null;
    }

    // ── household event propagation ───────────────────────────────────────
    // Certain events affect every member of the household — they are recorded
    // on the sharedEvents arrays of all current spouses and children so that
    // when any stub is expanded into a full NPC, the shared hardship or fortune
    // is injected into their simulation as a forced event.
    //
    // Categories:
    //   FULL_HOUSEHOLD — fire at the same age on every member's timeline.
    //     The spouse/child's equivalent age is computed from birthYear difference.
    //   DEPARTURE — records that the principal left; stubs get a note, not an event.
    //
    {
      const FULL_HOUSEHOLD = new Set([
        'financial_ruin',    // destitution: everyone loses their status
        'survived_famine',   // starvation or near-starvation
        'fire_or_flood',     // house destroyed; everyone displaced
        'bad_harvest',       // whole farming family goes hungry
        'outlawed',          // family must flee or hide
        'noble_exile',       // household follows lord into exile
        'fled_to_town',      // whole family uproots
        'inheritance_received', // windfall benefits the whole household
        'prosperous_union',  // marriage improves everyone's station
        'good_harvest',      // shared prosperity
        'patron_marries_her', // mother's class change affects children's class
      ]);

      if (FULL_HOUSEHOLD.has(evId)) {
        const principalBirthYear = birthYear;
        const entry = { eventId: evId, principalAge: age, pool: 'biographical' };

        // Propagate to current living spouse
        const cs = currentSpouse();
        if (cs && cs.sharedEvents) {
          const spouseAge = cs.ageAtMarriage + (age - cs.marriedAtPrincipalAge);
          cs.sharedEvents.push({ ...entry, ageMin: spouseAge, ageMax: spouseAge });
        }

        // Propagate to all living children aged ≥18 at time of event.
        // Children under 18 are below simulation start age — forced events at those
        // ages would never fire (engine starts at 18). Store as preHistory note instead.
        for (const child of children) {
          if (child.status !== 'alive' || !child.sharedEvents) continue;
          const childAge = age - child.bornAtPrincipalAge;
          if (childAge < 1) continue;   // newborns skipped entirely
          if (childAge < 18) {
            // Pre-adulthood: record as context note, not a forced event
            child.sharedEvents.push({ ...entry, ageMin: childAge, ageMax: childAge,
              preHistory: true, note: `Household event before adulthood (age ${childAge})` });
          } else {
            child.sharedEvents.push({ ...entry, ageMin: childAge, ageMax: childAge });
          }
        }
      }

      // Departure events: record on stubs as narrative metadata, not forced events
      // The left-behind spouse/children get a note; the event itself is the principal's
      if (evId === 'abandoned_family' || evId === 'spouse_absconded') {
        const cs = currentSpouse();
        if (cs && cs.sharedEvents) {
          cs.sharedEvents.push({
            eventId: evId === 'abandoned_family' ? 'spouse_absconded' : 'abandoned_family',
            ageMin: cs.ageAtMarriage + (age - cs.marriedAtPrincipalAge),
            ageMax: cs.ageAtMarriage + (age - cs.marriedAtPrincipalAge),
            pool: 'biographical',
            meta: { principalId: 'principal', principalAge: age,
                    note: evId === 'abandoned_family'
                      ? 'Principal departed this marriage'
                      : 'This person departed the marriage' },
          });
        }
        // Children of an abandoned family also get a note
        if (evId === 'abandoned_family') {
          for (const child of children) {
            if (child.status !== 'alive' || !child.sharedEvents) continue;
            const childAge = age - child.bornAtPrincipalAge;
            if (childAge < 1) continue;
            child.sharedEvents.push({
              eventId: 'parent_departed',   // narrative-only; engine won't find this event
              ageMin: childAge, ageMax: childAge,
              pool: 'biographical',
              meta: { principalId: 'principal', principalAge: age,
                      note: 'Parent left the family' },
            });
          }
        }
      }
    }

    // Pagaelin wife-acquisition: generate a held woman stub if below phase cap.
    // Phase caps:  warrior=1, dominant=3, chieftain=5
    // The household is a physical space — all women and children live together.
    // Retainers attach when a man first forms a household; more join as he rises.
    if ((evId === 'pagaelin_took_a_wife' || evId === 'pagaelin_young_love' || evId === 'pagaelin_takes_wife')
        && !isFemale && char.socialClass === 'pagaelin') {
      const phaseCap = char.phase === 'chieftain'  ? 5
                     : char.phase === 'dominant'   ? 3
                     : char.phase === 'elder_male' ? 3
                     : 1;  // warrior
      const livingWomen = heldWomen.filter(w => w.status === 'alive').length;
      if (livingWomen < phaseCap) {
        const woman = generateHeldWomanStub(age);
        heldWomen.push(woman);
        const note = evId === 'pagaelin_young_love'
          ? 'First bond — one woman, unusual peer relationship'
          : livingWomen === 0 ? 'First woman acquired'
          : `Acquired another woman (now ${livingWomen + 1} women in household)`;
        if (!relationalNote) relationalNote = note;

        // Second woman: the household is now visible and established
        // This is the threshold that makes a man recognisable as dominant
        if (livingWomen >= 1 && !char.conditions.includes('established_household')) {
          char.conditions.push('established_household');
        }

        // First acquisition: 1-2 retainers attach to the new household
        // Subsequent acquisitions: 0-1 additional retainer (word spreads — this is a rising man)
        const retainerTarget = livingWomen === 0
          ? 1 + Math.floor(rand() * 2)   // 1-2 on first woman
          : Math.floor(rand() * 2);       // 0-1 on subsequent
        for (let r = 0; r < retainerTarget; r++) {
          retainers.push(generateRetainerStub(age, char.phase));
        }
      }
    }
    // Pagaelin female: set up holder stub on first year
    // Female Pagaelin: set up holder stub on first encounter if held
    if (isFemale && char.socialClass === 'pagaelin' && !holder
        && char.conditions.includes('pagaelin_held')) {
      holder = generateHolderStub(age);
      // Sister women — other women held by the same dominant man
      const sisterCount = Math.floor(rand() * 4);
      for (let i = 0; i < sisterCount; i++) {
        heldWomen.push(generateHeldWomanStub(holder.age));
      }
    }
    // ── Pagaelin former_chief_deposed phase reversion ──────────────────────
    // When pagaelin_former_chief_deposed fires, the NPC is no longer chief.
    // Phase reverts from chieftain to dominant — still a dangerous man, but
    // no longer the man. The condition pagaelin_deposed is set by the event.
    if (char.socialClass === 'pagaelin' && evId === 'pagaelin_former_chief_deposed'
        && char.phase === 'chieftain') {
      char.phase = 'dominant';
      // Reroll archetype to dominant-phase — no longer chieftain archetype
      const newArch = rollArchetype('pagaelin', _sex, 'dominant',
        char.settlementType, new Set(char.conditions));
      if (newArch && newArch.id !== resolvedArchetype?.id) {
        archetypeChanges.push({
          fromAge: age, from: resolvedArchetype?.id || null,
          to: newArch.id, reason: 'deposed',
        });
        resolvedArchetype = newArch;
        char.archetype    = newArch.id;
      }
    }

    // ── Pagaelin walker_shaman class change ────────────────────────────────
    // When raunir_ordeal_survived is gained from the pagaelin class,
    // the NPC has crossed the threshold — they are now an initiate of the
    // Navehan lodge. Class changes to walker_shaman.
    // This fires after conditions are applied (raunir_ordeal_survived just added).
    if (char.socialClass === 'pagaelin'
        && evId === 'pagaelin_akan_shri_ordeal'
        && char.conditions.includes('raunir_ordeal_survived')) {
      classChanges.push({
        fromAge: age, from: 'pagaelin', to: 'walker_shaman',
        note: 'Survived the Akan-shri ordeal — named Raunir; entered the Walker lodge',
      });
      char.socialClass = 'walker_shaman';
      char.phase = 'raunir';
      // Roll walker_shaman archetype
      const newArch = rollArchetype('walker_shaman', _sex, 'raunir',
        char.settlementType, new Set(char.conditions));
      if (newArch) {
        archetypeChanges.push({
          fromAge: age, from: resolvedArchetype?.id || null,
          to: newArch.id, reason: 'raunir_initiation',
        });
        resolvedArchetype = newArch;
        char.archetype    = newArch.id;
      }
    }

    // ── Pagaelin shaman calling transition ────────────────────────────────
    // When pagaelin_shaman_calling fires, the NPC enters the shaman track.
    // This overrides their standard phase (warrior/held_woman) with shaman_learning.
    // Shamans do not abandon their social position — a held woman shaman is still
    // held; an unkilled warrior shaman is still unkilled. The shaman track runs
    // alongside the social position, not instead of it.
    if (char.socialClass === 'pagaelin' && evId === 'pagaelin_shaman_calling'
        && char.phase !== 'shaman_learning' && !char.conditions.includes('raunir_ordeal_survived')) {
      char.phase = 'shaman_learning';
      const newArch = rollArchetype('pagaelin', _sex, 'shaman_learning',
        char.settlementType, new Set(char.conditions));
      if (newArch && newArch.id !== resolvedArchetype?.id) {
        archetypeChanges.push({
          fromAge: age, from: resolvedArchetype?.id || null,
          to: newArch.id, reason: 'shaman_calling',
        });
        resolvedArchetype = newArch;
        char.archetype    = newArch.id;
      }
    }

    // ── Pagaelin chieftain transition ─────────────────────────────────────
    // Fired when pagaelin_seize_chieftaincy event resolves for a dominant man.
    // The camp reorganises: old retainers either commit or drift away,
    // new retainers attach because being attached to the chief is worth something.
    if (char.socialClass === 'pagaelin' && !isFemale
        && evId === 'pagaelin_seize_chieftaincy' && char.phase === 'dominant') {
      char.phase = 'chieftain';
      const newArch = rollArchetype('pagaelin', _sex, 'chieftain',
        char.settlementType, new Set(char.conditions));
      if (newArch && newArch.id !== resolvedArchetype?.id) {
        archetypeChanges.push({
          fromAge: age, from: resolvedArchetype?.id || null,
          to: newArch.id, reason: 'became_chieftain',
        });
        resolvedArchetype = newArch;
        char.archetype    = newArch.id;
      }
      // Becoming chief draws new retainers — 2-4 additional men attach
      // Some are genuinely loyal to the new order; some are calculating
      const newRetainers = 2 + Math.floor(rand() * 3);
      for (let r = 0; r < newRetainers; r++) {
        retainers.push(generateRetainerStub(age, 'chieftain'));
      }
      if (!relationalNote) relationalNote = 'Seized the chieftaincy';
    }

    const marriageNote    = handleMarriage(evId, age);
    if (marriageNote && !relationalNote) relationalNote = marriageNote;

    const spouseDeathNote = handleSpouseDeath(evId, age);
    if (spouseDeathNote && !relationalNote) relationalNote = spouseDeathNote;

    // Child creation is handled exclusively by resolvePregnancyOutcome (called
    // when pregnancy/spouse_pregnant/pregnancy_unmarried events fire in the year loop).
    // handleBirth has been removed — do not add child stubs here.
    // Child death is handled by advanceChildStubs (parallel child simulation).

    // handleChildFostering handles both child_fostered and child_placed_in_monastery
    const childFosterNote = handleChildFostering(evId, age);
    if (childFosterNote && !relationalNote) relationalNote = childFosterNote;

    const contactCreateNote = handleContactCreation(evId, age);
    if (contactCreateNote && !relationalNote) relationalNote = contactCreateNote;

    const contactEvolveNote = handleContactEvolution(evId, age);
    if (contactEvolveNote && !relationalNote) relationalNote = contactEvolveNote;

    // Ensure has_contacts is set whenever the contacts array is non-empty
    if (contacts.length > 0 && !char.conditions.includes('has_contacts')) {
      char.conditions.push('has_contacts');
    }

    // ── phase & rootless side-effects ─────────────────────────────────────
    //
    // Declarative transition table — all event-driven phase and rootless
    // changes in one place. Each entry:
    //   { fromPhase: string|string[]|null, toPhase: string|null, rootless: bool|null,
    //     requireClass: string|null, requireFemale: bool|null,
    //     requireCondition: string|null }
    //
    // fromPhase null = fires regardless of current phase.
    // toPhase   null = phase unchanged (only rootless is updated).
    // requireClass/requireFemale: class/sex guard — skip if not matched.
    // requireCondition: only fire if char currently has this condition.
    //
    // Rules are processed in order; ALL matching rules fire (not first-match).
    // This allows one event to set both phase and rootless independently.
    {
      const PHASE_TRANSITIONS = [
        // ── Craftsperson ────────────────────────────────────────────────────
        { eventId: 'masterwork_created',        fromPhase: 'journeyman', toPhase: 'established', rootless: false },
        { eventId: 'established_workshop',      fromPhase: 'journeyman', toPhase: 'established', rootless: false },
        { eventId: 'joined_guild',              fromPhase: 'journeyman', toPhase: 'established', rootless: false },
        { eventId: 'remarriage_older',          fromPhase: 'journeyman', toPhase: 'established', rootless: false },

        // ── Warrior ─────────────────────────────────────────────────────────
        { eventId: 'joined_garrison',           fromPhase: 'recruit',              toPhase: 'veteran',   rootless: false },
        { eventId: 'hired_as_bodyguard',        fromPhase: 'recruit',              toPhase: 'veteran',   rootless: false },
        { eventId: 'promoted_sergeant',         fromPhase: ['recruit','veteran'],  toPhase: 'sergeant',  rootless: false },

        // ── Noble female: marital phase track ───────────────────────────────
        { eventId: 'married',                   fromPhase: 'lady',          toPhase: 'married_noble', requireClass: 'noble', requireFemale: true },
        { eventId: 'prosperous_union',          fromPhase: 'lady',          toPhase: 'married_noble', requireClass: 'noble', requireFemale: true },
        { eventId: 'spouse_dies',               fromPhase: 'married_noble', toPhase: 'widow',         requireClass: 'noble', requireFemale: true },
        { eventId: 'spouse_dies_childbirth',    fromPhase: 'married_noble', toPhase: 'widow',         requireClass: 'noble', requireFemale: true },
        { eventId: 'married',                   fromPhase: 'widow',         toPhase: 'married_noble', requireClass: 'noble', requireFemale: true },
        { eventId: 'remarriage_older',          fromPhase: 'widow',         toPhase: 'married_noble', requireClass: 'noble', requireFemale: true },

        // ── Noble: inheritance and position ─────────────────────────────────
        { eventId: 'father_dies_heir_inherits', fromPhase: 'heir',             toPhase: 'lord',  rootless: false },
        { eventId: 'elder_brother_dies_heir',   fromPhase: 'spare',            toPhase: 'heir'  },
        { eventId: 'spare_finds_position',      fromPhase: 'spare',            toPhase: 'lord',  rootless: false },
        { eventId: 'inherited_estate',          fromPhase: ['heir','spare'],   toPhase: 'lord',  rootless: false },
        { eventId: 'court_appointment',         fromPhase: 'spare',            toPhase: 'lord',  rootless: false },
        { eventId: 'court_appointment',         fromPhase: null,               toPhase: null,    rootless: false },
        { eventId: 'enfeoffed',                 fromPhase: ['heir','spare','lord'], toPhase: 'lord', rootless: false, requireClass: 'noble' },
        { eventId: 'enfeoffed',                 fromPhase: null,               toPhase: null,    rootless: false },

        // ── Universal rootless transitions ───────────────────────────────────
        { eventId: 'fled_to_town',              fromPhase: null, toPhase: null, rootless: true  },
        { eventId: 'noble_exile',               fromPhase: null, toPhase: null, rootless: true  },
        { eventId: 'deserted',                  fromPhase: null, toPhase: null, rootless: true  },
        { eventId: 'outlawed',                  fromPhase: null, toPhase: null, rootless: true  },
        { eventId: 'exile_lifted',              fromPhase: null, toPhase: null, rootless: false, requireCondition: 'exiled' },
        { eventId: 'remarriage_older',          fromPhase: null, toPhase: null, rootless: false },
        { eventId: 'joined_guild',              fromPhase: null, toPhase: null, rootless: false },
      ];

      for (const rule of PHASE_TRANSITIONS) {
        if (rule.eventId !== evId) continue;

        // Class guard
        if (rule.requireClass && char.socialClass !== rule.requireClass) continue;

        // Sex guard
        if (rule.requireFemale === true  && !isFemale) continue;
        if (rule.requireFemale === false &&  isFemale) continue;

        // Condition guard
        if (rule.requireCondition && !char.conditions.includes(rule.requireCondition)) continue;

        // Phase guard — null means fire regardless of current phase
        if (rule.fromPhase !== null) {
          const allowed = Array.isArray(rule.fromPhase) ? rule.fromPhase : [rule.fromPhase];
          if (!allowed.includes(char.phase)) continue;
        }

        // Apply
        if (rule.toPhase  !== null && rule.toPhase  !== undefined) char.phase    = rule.toPhase;
        if (rule.rootless !== null && rule.rootless  !== undefined) char.rootless = rule.rootless;
      }
    }

    // ── SETTLEMENT TRANSITIONS ────────────────────────────────────────────
    // Apply any settlement shift triggered by this event.
    // Record in settlementHistory if the type actually changes.
    // fromName/toName are null until a settlementPool is supplied by the caller.
    {
      const prev              = char.settlementType;
      // Pagaelin are nomadic — settlement type is always 'camp', no transitions.
      const { next, reason }  = char.socialClass === 'pagaelin'
        ? { next: 'camp', reason: null }
        : applySettlementTransition(evId, prev, char.sex);
      if (next !== prev) {
        char.settlementType = next;
        settlementHistory.push({
          age,
          from:     prev,
          to:       next,
          via:      evId,
          reason,
          fromName: null,   // populated if settlementPool supplied
          toName:   null,   // populated if settlementPool supplied
        });
      }
    }

    return { resolvedEvent, injuryDetail, rhNote, relationalNote, freeOPs, skillOPs, totalSpent, attrDeltas: resolvedAttributes, diedChildId };
  }

  // ── OP spender initialisation ─────────────────────────────────────────────
  // Created once before the simulation starts so it accumulates state across years.
  // On resume, pass saved skillImprovements so cost tiers start at the right level.
  const opSpender = createOPSpender(
    cls, hobbySkill, occupationSkills,
    isResume ? (cp.skillImprovements ?? {}) : {}
  );

  // ── Family table post-filters ─────────────────────────────────────────────
  // Structural eligibility rules that depend on runtime state (spouse records,
  // children array) and therefore cannot be encoded in event requireConditions.
  // Called after buildDrawTable to remove ineligible events from the raw table.
  //
  // Keeping all family filters here means the year loop body only needs to call
  // buildDrawTable + applyFamilyTableFilters + weightedRandom, with no inline
  // filter logic cluttering the loop.
  //
  //   Fix A  — spouse_dies: marriage must be ≥2 years old
  //   Fix C  — grandchild_born: oldest living child must be ≥16
  //   Fix 13 — child_dies: suppressed during forced-event child-deficit recovery
  //
  function applyFamilyTableFilters(famTable, age, suppressPregnancy = false) {
    // Fix A: spouse can't die within 4 years of marriage (or if no spouse)
    const cs = currentSpouse();
    if (!cs || (age - cs.marriedAtPrincipalAge) < 4) {
      famTable = famTable.filter(([ev]) => ev.id !== 'spouse_dies');
    }

    // child_married, child_dies, grandchild_born, bastard_grandchild_born,
    // child_leaves_home are now handled by advanceChildStubs — remove from pool.
    famTable = famTable.filter(([ev]) => ![
      'child_married', 'child_dies', 'grandchild_born',
      'bastard_grandchild_born', 'child_leaves_home',
    ].includes(ev.id));

    // child_fostered: living child 8–15 not yet fostered
    const hasFosterableChild = children.some(c => {
      const childAge = age - c.bornAtPrincipalAge;
      return c.status === 'alive' && childAge >= 8 && childAge <= 15 && !c.fostered;
    });
    if (!hasFosterableChild) {
      famTable = famTable.filter(([ev]) => ev.id !== 'child_fostered');
    }

    // estranged_from_child scales with number of adult children who have left home.
    // A child still living at home is hard to become fully estranged from.
    // Years since departure deepen the risk: a child gone 5+ years without contact
    // is much more likely to become a stranger.
    const departedChildren = children.filter(c =>
      c.status === 'alive' && c.leftHome &&
      (age - (c.leftHomeAtPrincipalAge ?? age)) >= 2
    );
    if (departedChildren.length === 0) {
      // No departed adult children — suppress estrangement entirely
      famTable = famTable.filter(([ev]) => ev.id !== 'estranged_from_child');
    } else {
      const longGone = departedChildren.filter(c =>
        (age - (c.leftHomeAtPrincipalAge ?? age)) >= 5
      ).length;
      // Fostered/monastery children separated during formative years count extra —
      // removed from household before age 16, formative bond never fully formed
      const earlyDeparted = departedChildren.filter(c =>
        (c.fostered || c.inMonastery) &&
        ((c.fosteredAtChildAge ?? c.monasteryAtChildAge ?? 18) < 16)
      ).length;
      const multiplier = departedChildren.length + longGone * 0.5 + earlyDeparted * 0.5;
      famTable = famTable.map(([ev, w]) =>
        ev.id === 'estranged_from_child' ? [ev, Math.round(w * multiplier)] : [ev, w]
      );
    }

    // Fix P: pregnancy suppression
    if (suppressPregnancy) {
      famTable = famTable.filter(([ev]) =>
        ev.id !== 'pregnancy' &&
        ev.id !== 'pagaelin_pregnancy' &&
        ev.id !== 'extramarital_pregnancy' &&
        ev.id !== 'spouse_pregnant'
      );
    }

    return famTable;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 2 — YEAR-BY-YEAR SIMULATION
  // ═══════════════════════════════════════════════════════════════════════════
  // runYearLoop() closes over all Phase 1 state (char, spouses, children,
  // contacts, follow-on maps, history arrays, opSpender, etc.) and iterates
  // from beginAge to endAge, drawing and resolving one biographical and one
  // family event per year.
  //
  // Extracted as a named function to make the three-phase structure of
  // ageCharacter() visible at a glance. No state escapes this function —
  // all mutations are on the closed-over objects.
  function runYearLoop() {
    // ── year-by-year loop ──────────────────────────────────────────────────
    for (let age = beginAge; age <= endAge; age++) {
      char.age = age;
      const ageGroup = getAgeGroup(age);
      const year     = birthYear + age;   // calendar year (TR)

    // ── AUTOMATIC PHASE TRANSITIONS ──────────────────────────────────────
    // Levy cap: if on_levy for more than 3 years, force discharge this year.
    // Levy men are due back on their land — the lord can't keep them indefinitely.
    if (char.conditions.includes('on_levy') && char.levyStartAge != null
        && (age - char.levyStartAge) >= 3) {
      const dischargeEvent = LIFE_EVENTS_BY_ID.get('discharged_from_levy');
      if (dischargeEvent) {
        _forcedEvts.push({ eventId: 'discharged_from_levy', ageMin: age, ageMax: age, pool: 'biographical', _fired: false });
      }
    }

    // Master beating guarantee: every apprentice gets struck at least once.
    // If an apprentice-phase NPC reaches age 20 without having been beaten,
    // inject it now. This is historically universal across all guild crafts.
    const APPRENTICE_CLASSES = new Set([
      'artisan','guilded_performer','guilded_mariner','guilded_miner',
      'guilded_physician','guilded_litigant','guilded_herald','guilded_innkeeper',
      'guilded_arcanist','guilded_courtesan','merchant','clergy','lia_kavair',
    ]);
    if (age === 19 && APPRENTICE_CLASSES.has(char.socialClass) &&
        // Include journeyman/free/ordinary for classes that leave apprentice early
        ['apprentice','bonded','deck_boy','ordinary','postulant','recruit',
         'journeyman','free','able'].includes(char.phase) &&
        // Don't beat clergy who are already advancing through ordination
        !char.conditions.some(c => c === 'clergy_acolyte' || c === 'clergy_priest') &&
        !history.some(h => h.eventId === 'master_struck_apprentice')) {
      _forcedEvts.push({
        eventId: 'master_struck_apprentice',
        ageMin: 20, ageMax: 20,
        pool: 'biographical',
        _fired: false,
      });
    }

    // Menopause guarantee: if a woman reaches 50 without menopause, force it now.
    // Menopause fires from the pool between 43-58, but pool dilution can prevent it.
    // At 50 it should always have occurred — inject as a forced event if not yet set.
    if (age === 50 && isFemale &&
        !char.conditions.includes('menopausal') &&
        !char.conditions.includes('pagaelin') &&
        char.socialClass !== 'pagaelin' && char.socialClass !== 'walker_shaman') {
      _forcedEvts.push({ eventId: 'menopause', ageMin: 50, ageMax: 50, pool: 'biographical', _fired: false });
    }

    // ── DISGRACE TIME-BASED FADE ─────────────────────────────────────────────
    // Disgrace is not permanent — communities have short memories. After ~5 years
    // the active shame fades naturally. The biographical fact is preserved as
    // 'ever_disgraced'. shame_fades / reputation_restored events accelerate this;
    // the engine handles the slow natural fade here for everyone else.
    if (char.conditions.includes('disgraced') && char.disgracedAtAge != null) {
      const yearsDisgraced = age - char.disgracedAtAge;
      const fadePct = yearsDisgraced >= 6 ? 0.55 :
                      yearsDisgraced === 5 ? 0.35 :
                      yearsDisgraced === 4 ? 0.20 : 0;
      if (fadePct > 0 && rand() < fadePct) {
        const dIdx = char.conditions.indexOf('disgraced');
        if (dIdx !== -1) char.conditions.splice(dIdx, 1);
        if (!char.conditions.includes('ever_disgraced')) char.conditions.push('ever_disgraced');
        char.disgracedAtAge = null;
      }
    }

    // ── DISGRACE TIME-BASED FADE ─────────────────────────────────────────────
    // Disgrace is not permanent — communities have short memories. After ~5 years,
    // active shame fades. The biographical fact is preserved in 'ever_disgraced'.
    // Shame_fades / reputation_restored events can accelerate this; the engine
    // handles the slow natural fade here for NPCs who never get that chance.
    // Randomise the window slightly (4-7 years) so it's not perfectly uniform.
    if (char.conditions.includes('disgraced') && char.disgracedAtAge != null) {
      const yearsDisgraced = age - char.disgracedAtAge;
      // Fade probability rises each year past year 4: 20%/yr at y4, 35% at y5, 55% at y6+
      const fadePct = yearsDisgraced >= 6 ? 0.55 :
                      yearsDisgraced === 5 ? 0.35 :
                      yearsDisgraced === 4 ? 0.20 : 0;
      if (fadePct > 0 && rand() < fadePct) {
        const dIdx = char.conditions.indexOf('disgraced');
        if (dIdx !== -1) char.conditions.splice(dIdx, 1);
        if (!char.conditions.includes('ever_disgraced')) {
          char.conditions.push('ever_disgraced');
        }
        char.disgracedAtAge = null;
      }
    }

    // Spouse/lover levy cap: if spouse_on_levy or lover_on_levy for 4+ years, force return.
    // Male levy lasts max 3 years; female principal tracks her own start age.
    if (char.conditions.includes('spouse_on_levy') && char.spouseLevyStartAge != null
        && (age - char.spouseLevyStartAge) >= 4) {
      _forcedEvts.push({ eventId: 'husband_returns_from_levy', ageMin: age, ageMax: age, pool: 'family', _fired: false });
      char.spouseLevyStartAge = null;
    }
    if (char.conditions.includes('lover_on_levy') && char.loverLevyStartAge != null
        && (age - char.loverLevyStartAge) >= 4) {
      _forcedEvts.push({ eventId: 'lover_returns_from_levy', ageMin: age, ageMax: age, pool: 'family', _fired: false });
      char.loverLevyStartAge = null;
    }

    // ── DATA-DRIVEN PHASE TRANSITIONS (CLASS_PHASE_CONFIGS) ──────────────
    // Run each age transition defined in the class config. Handles simple
    // age-based phase advances without hardcoded per-class conditionals.
    // Complex transitions (clergy ordination, Naveh conditions, LK rank) are
    // still handled further below in their own dedicated blocks.
    {
      const cfg = CLASS_PHASE_CONFIGS[char.socialClass];
      if (cfg?.ageTransitions) {
        for (const t of cfg.ageTransitions) {
          if (char.phase === t.fromPhase && age >= t.atAge) {
            if (!t.condition || t.condition(char)) {
              char.phase = t.toPhase;
              // Pagaelin warrior→dominant: reroll archetype to unlock dominant-phase archetypes
              if (char.socialClass === 'pagaelin' && t.toPhase === 'dominant' && !isFemale) {
                const newArch = rollArchetype('pagaelin', _sex, 'dominant',
                  char.settlementType, new Set(char.conditions));
                if (newArch && newArch.id !== resolvedArchetype?.id) {
                  archetypeChanges.push({
                    fromAge: age, from: resolvedArchetype?.id || null,
                    to: newArch.id, reason: 'warrior_to_dominant',
                  });
                  resolvedArchetype = newArch;
                  char.archetype    = newArch.id;
                }
              }
              // artisan apprentice → journeyman sets rootless
              if (char.socialClass === 'artisan' && t.toPhase === 'journeyman') {
                char.rootless = true;
              }

              // Re-roll archetype on phase advance for classes where the starting phase
              // has no archetypes (guilded classes start as apprentice, archetypes begin
              // at journeyman or established). Also re-rolls if NPC has no archetype yet.
              const REROLL_PHASES = new Set([
                'journeyman','established','senior','ordained','master',
                'able','walker_speaker','dominant','senior_noble','senior_clergy',
              ]);
              if (REROLL_PHASES.has(t.toPhase)) {
                const condSet = new Set(char.conditions);
                const candidate = rollArchetype(
                  char.socialClass, _sex, t.toPhase, char.settlementType, condSet
                );
                if (candidate && (!resolvedArchetype || candidate.id !== resolvedArchetype.id)) {
                  // Only replace if no archetype yet, or moving to a strictly later phase
                  // (prevents thrashing for classes that have archetypes from the start)
                  const hadNone = !resolvedArchetype;
                  if (hadNone) {
                    archetypeChanges.push({
                      fromAge: age, from: null, to: candidate.id,
                      reason: 'phase_advance_first_archetype',
                    });
                    resolvedArchetype = candidate;
                    char.archetype    = candidate.id;
                  }
                }
              }
            }
          }
        }
      }
    }

    // Settled phases age into class-appropriate senior at 50
    // (covers phases not in CLASS_PHASE_CONFIGS ageTransitions — e.g. event-set phases)
    if (age >= 50) {
      const settle2senior = {
        established:     'senior',
        lord:            'senior_noble',
        veteran:         'senior',
        sergeant:        'senior',
        ordained:        'senior_clergy',
        footpad:         char.socialClass === 'lia_kavair' ? 'master' : 'senior',
      };
      if (settle2senior[char.phase]) char.phase = settle2senior[char.phase];
    }
    // Wanderers who survive to 50 — but NOT lia_kavair or priest_naveh
    if (char.phase === 'journeyman' && char.socialClass !== 'lia_kavair' && age >= 50) char.phase = 'senior';
    if (char.phase === 'journeyman' && char.socialClass === 'lia_kavair' && age >= 50) {
      char.phase = 'master';
      const rerolledA = rollArchetype(char.socialClass, _sex, 'master', char.settlementType);
      if (rerolledA && rerolledA.id !== resolvedArchetype?.id) {
        archetypeChanges.push({ fromAge: age, from: resolvedArchetype?.id || null, to: rerolledA.id, reason: 'lk_aged_master' });
        resolvedArchetype = rerolledA;
        char.archetype    = rerolledA.id;
      }
    }
    if (char.phase === 'knight_errant' && age >= 50) char.phase = 'senior';

    // Naveh clergy phase progression — condition-driven, not age-driven
    // dranatha_new → dranatha_active at age 27 (9 years of operational experience)
    // dranatha_active → dranatha_deep at age 41 (long-rooted cover)
    // dranatha_deep / master_position → declining at age 56
    // master_position fires only via forcedEvents (named canonical positions)
    if (char.socialClass === 'priest_naveh') {
      if (char.phase === 'dranatha_new' && age >= 27) {
        char.phase = 'dranatha_active';
        const rerolled = rollArchetype(char.socialClass, _sex, 'dranatha_active', char.settlementType);
        if (rerolled && rerolled.id !== resolvedArchetype?.id) {
          archetypeChanges.push({ fromAge: age, from: resolvedArchetype?.id || null, to: rerolled.id, reason: 'naveh_active' });
          resolvedArchetype = rerolled;
          char.archetype    = rerolled.id;
        }
      } else if (char.phase === 'dranatha_active' && age >= 41) {
        char.phase = 'dranatha_deep';
        const rerolled = rollArchetype(char.socialClass, _sex, 'dranatha_deep', char.settlementType);
        if (rerolled && rerolled.id !== resolvedArchetype?.id) {
          archetypeChanges.push({ fromAge: age, from: resolvedArchetype?.id || null, to: rerolled.id, reason: 'naveh_deep' });
          resolvedArchetype = rerolled;
          char.archetype    = rerolled.id;
        }
      } else if ((char.phase === 'dranatha_deep' || char.phase === 'master_position') && age >= 56) {
        char.phase = 'declining';
        const rerolled = rollArchetype(char.socialClass, _sex, 'declining', char.settlementType);
        if (rerolled && rerolled.id !== resolvedArchetype?.id) {
          archetypeChanges.push({ fromAge: age, from: resolvedArchetype?.id || null, to: rerolled.id, reason: 'naveh_declining' });
          resolvedArchetype = rerolled;
          char.archetype    = rerolled.id;
        }
      }
    }

    // Clergy phase driven by rank conditions:
    // postulant → ordained when they gain clergy_acolyte or clergy_priest
    // ordained  → senior_clergy at 50 (handled above)
    if (char.phase === 'postulant' && char.socialClass === 'clergy') {
      if (char.conditions.includes('clergy_acolyte') ||
          char.conditions.includes('clergy_priest')  ||
          char.conditions.includes('clergy_vicar')   ||
          char.conditions.includes('clergy_canon')   ||
          char.conditions.includes('clergy_prior')) {
        char.phase = 'ordained';
        // Re-roll archetype now that phase is known — opens ordained/senior archetypes
        const rerolled = rollArchetype(char.socialClass, _sex, 'ordained', char.settlementType);
        if (rerolled && rerolled.id !== resolvedArchetype?.id) {
          // Apply the difference in oceanBias between old and new archetype
          if (rerolled.oceanBias) {
            const oldBias = resolvedArchetype?.oceanBias || {};
            for (const [trait, newDelta] of Object.entries(rerolled.oceanBias)) {
              const oldDelta = oldBias[trait] || 0;
              const diff = newDelta - oldDelta;
              if (diff !== 0 && char.oceanScores[trait] !== undefined) {
                char.oceanScores[trait] = Math.max(1, Math.min(100, char.oceanScores[trait] + diff));
              }
            }
            // Also remove old bias that no longer applies
            for (const [trait, oldDelta] of Object.entries(oldBias)) {
              if (!(trait in rerolled.oceanBias) && char.oceanScores[trait] !== undefined) {
                char.oceanScores[trait] = Math.max(1, Math.min(100, char.oceanScores[trait] - oldDelta));
              }
            }
            // Recalculate morality after OCEAN shift
            morality = deriveMorality(char.oceanScores);
            char.morality = morality;
          }
          archetypeChanges.push({ fromAge: age, from: resolvedArchetype?.id || null, to: rerolled.id, reason: 'ordination' });
          resolvedArchetype = rerolled;
          char.archetype    = rerolled.id;
          // Update deity to match the ordained order — a Peoni postulant who re-rolls
          // to a Laranian archetype at ordination joins the Laranian order, and vice versa.
          const newDeity = rerolled.id.startsWith('clergy_peoni') ? 'Peoni'
                         : rerolled.id.startsWith('clergy_halea') ? 'Halea'
                         : 'Larani';
          if (char.publicDeity !== newDeity) {
            char.publicDeity = newDeity;
          }
        }
        // Peoni clergy take a celibacy vow at ordination (the Irreproachable Order).
        // Laranian and Halean clergy are non-celibate and do NOT receive this condition.
        // Fires whenever phase becomes 'ordained', after archetype re-roll updates deity.
        if (char.publicDeity === 'Peoni' && !char.conditions.includes('peoni_celibate')) {
          char.conditions.push('peoni_celibate');
        }
      }
    }
    // Lia-Kavair phase driven by rank conditions:
    // recruit → footpad on lk_initiated
    // footpad → journeyman on lk_thief_rank or lk_journeyman_rank
    // journeyman → master on lk_journeyman_rank or lk_master_rank
    if (char.socialClass === 'lia_kavair') {
      if (char.phase === 'recruit' && char.conditions.includes('lk_initiated')) {
        char.phase = 'footpad';
        // Re-roll archetype now that phase is known — opens footpad/journeyman archetypes
        const rerolled = rollArchetype(char.socialClass, _sex, 'footpad', char.settlementType);
        if (rerolled && rerolled.id !== resolvedArchetype?.id) {
          if (rerolled.oceanBias) {
            const oldBias = resolvedArchetype?.oceanBias || {};
            for (const [trait, newDelta] of Object.entries(rerolled.oceanBias)) {
              const oldDelta = oldBias[trait] || 0;
              const diff = newDelta - oldDelta;
              if (diff !== 0 && char.oceanScores[trait] !== undefined) {
                char.oceanScores[trait] = Math.max(1, Math.min(100, char.oceanScores[trait] + diff));
              }
            }
            for (const [trait, oldDelta] of Object.entries(oldBias)) {
              if (!(trait in rerolled.oceanBias) && char.oceanScores[trait] !== undefined) {
                char.oceanScores[trait] = Math.max(1, Math.min(100, char.oceanScores[trait] - oldDelta));
              }
            }
            morality = deriveMorality(char.oceanScores);
            char.morality = morality;
          }
          archetypeChanges.push({ fromAge: age, from: resolvedArchetype?.id || null, to: rerolled.id, reason: 'initiated' });
          resolvedArchetype = rerolled;
          char.archetype    = rerolled.id;
        }
      } else if (char.phase === 'footpad' &&
          (char.conditions.includes('lk_thief_rank') || char.conditions.includes('lk_journeyman_rank'))) {
        char.phase = 'journeyman';
        // Re-roll archetype for journeyman phase
        const rerolledJ = rollArchetype(char.socialClass, _sex, 'journeyman', char.settlementType);
        if (rerolledJ && rerolledJ.id !== resolvedArchetype?.id) {
          archetypeChanges.push({ fromAge: age, from: resolvedArchetype?.id || null, to: rerolledJ.id, reason: 'lk_promoted' });
          resolvedArchetype = rerolledJ;
          char.archetype    = rerolledJ.id;
        }
      } else if (char.phase === 'journeyman' &&
          (char.conditions.includes('lk_journeyman_rank') || char.conditions.includes('lk_master_rank'))) {
        char.phase = 'master';
        const rerolledM = rollArchetype(char.socialClass, _sex, 'master', char.settlementType);
        if (rerolledM && rerolledM.id !== resolvedArchetype?.id) {
          archetypeChanges.push({ fromAge: age, from: resolvedArchetype?.id || null, to: rerolledM.id, reason: 'lk_master' });
          resolvedArchetype = rerolledM;
          char.archetype    = rerolledM.id;
        }
      }
    }

    // ── BIOGRAPHICAL DRAW ────────────────────────────────────────────────
    const bioTable = buildDrawTable(char, ageGroup, bioFollowOns, 'biographical', resolvedArchetype, recentFireMap);
    let bioEvent   = bioTable.length > 0
      ? weightedRandom(bioTable)
      : LIFE_EVENTS_BY_ID.get('uneventful_year');
    if (!bioEvent) bioEvent = LIFE_EVENTS[0];

    // ── FORCED EVENT OVERRIDE (biographical) ─────────────────────────────
    // If a forced event is scheduled for this age window and hasn't fired yet,
    // replace the drawn event. Only fires once per forced event entry.
    const pendingBioForced = _forcedEvts.find(fe =>
      (!fe.pool || fe.pool === 'biographical') &&
      age >= fe.ageMin && age <= fe.ageMax &&
      !fe._fired
    );
    if (pendingBioForced) {
      const forcedDef = LIFE_EVENTS_BY_ID.get(pendingBioForced.eventId);
      if (forcedDef) {
        bioEvent = forcedDef;
        pendingBioForced._fired = true;
      }
    }

    // ── COLOUR SUBTABLE DRAW ─────────────────────────────────────────────
    // When the sentinel fires, replace it with a specific colour event.
    // If resolveColourEvent returns null (empty subtable), suppress the draw
    // entirely — do NOT fall back to the sentinel, which would leak '__colour__'
    // into the narrative output.
    if (bioEvent.id === 'colour_event') {
      const resolved = resolveColourEvent(char, ageGroup, spouses, children, resolvedArchetype);
      if (!resolved) continue;   // skip this year's colour draw silently
      bioEvent = resolved;
    }

    // Fix E: contact evolution no-op suppression ─────────────────────────
    // If the drawn event is a contact-evolution event but no valid target
    // exists for it, re-draw from the table with that event excluded.
    // This prevents flavour-only no-ops from silently consuming a year.
    {
      const CONTACT_EVOLUTION_IDS = new Set([
        'contact_dies','contact_betrayal','contact_falls_out',
        'contact_reconciles','contact_deepens','contact_lost_touch','contact_becomes_enemy',
      ]);
      if (CONTACT_EVOLUTION_IDS.has(bioEvent.id)) {
        const hasValidTarget = (() => {
          const alive     = contacts.filter(c => c.status === 'alive');
          const nonEnemy  = alive.filter(c => c.role !== 'enemy');
          const close     = nonEnemy.filter(c => c.relationshipBand === 'close');
          const neutral   = nonEnemy.filter(c => c.relationshipBand === 'neutral');
          const strained  = nonEnemy.filter(c => c.relationshipBand === 'strained');
          const hostile   = alive.filter(c =>
            c.relationshipBand === 'hostile' ||
            (c.relationshipBand === 'strained' && c.role !== 'enemy')
          );
          switch (bioEvent.id) {
            case 'contact_dies':         return nonEnemy.length > 0;
            case 'contact_betrayal':     return (close.length + neutral.length) > 0;
            case 'contact_falls_out':    return (close.length + neutral.length) > 0;
            case 'contact_reconciles':   return hostile.filter(c =>
              !(c.reconciledAtAge != null && (age - c.reconciledAtAge) < 3) &&
              !(c.hostileSetAtAge  != null && (age - c.hostileSetAtAge)  < 2)
            ).length > 0;
            case 'contact_deepens':      return neutral.length > 0;
            case 'contact_lost_touch':   return nonEnemy.filter(c =>
              !(c.relationshipBand === 'hostile' && (age - (c.hostileSetAtAge ?? -99)) < 2)
            ).length > 0;
            case 'contact_becomes_enemy':return (strained.length + neutral.length) > 0;
            default: return true;
          }
        })();
        if (!hasValidTarget) {
          // Re-draw, excluding this event
          const fallbackTable = bioTable.filter(([ev]) => !CONTACT_EVOLUTION_IDS.has(ev.id));
          bioEvent = fallbackTable.length > 0
            ? weightedRandom(fallbackTable)
            : (LIFE_EVENTS_BY_ID.get('uneventful_year') || bioEvent);
        }
      }
    }

    const bioResult = resolveEvent(bioEvent, age, ageGroup);
    // Update recentFireMap for minGapYears enforcement
    if (bioEvent.minGapYears) recentFireMap.set(bioEvent.id, age);

    // ── ATOMIC PREGNANCY RESOLUTION (biographical pool) ──────────────────
    // pregnancy_unmarried fires in the bio pool. resolveEvent() already applied
    // its social conditions (disgraced, father_absent). Now resolve the pregnancy
    // outcome atomically and attach the result to bioResult for the history entry.
    if (isFemale && bioEvent.id === 'pregnancy_unmarried') {
      const pregOutcome = resolvePregnancyOutcome(age, ageGroup);
      bioResult._pregnancyFlavour   = pregOutcome.flavour;
      bioResult._pregnancyEventId   = pregOutcome.eventId;
      bioResult._pregnancyLabel     = pregOutcome.eventLabel;
      bioResult._pregnancyWeeks     = pregOutcome.weeks;
      bioResult._pregnancyDisability = pregOutcome.disability;
      bioResult.rhNote              = pregOutcome.rhNote;
      bioResult.relationalNote      = pregOutcome.relationalNote ?? bioResult.relationalNote;
      // Override the resolvedEvent to point at the actual outcome event
      bioResult.resolvedEvent = LIFE_EVENTS_BY_ID.get(pregOutcome.eventId) || bioResult.resolvedEvent;
    }

    // Register biographical follow-ons
    for (const fo of bioResult.resolvedEvent.followOn) {
      const tgt = fo.eventId;
      const targetEvent = LIFE_EVENTS_BY_ID.get(tgt);
      const foMap = targetEvent?.pool === 'family' ? familyFollowOns : bioFollowOns;
      const existing = foMap.get(tgt);
      if (!existing || fo.weightMod > existing.weightMod) {
        foMap.set(tgt, { weightMod: fo.weightMod, yearsLeft: fo.duration });
      }
    }

    // ── FAMILY DRAW ──────────────────────────────────────────────────────
    let famEvent   = null;
    let famResult  = null;

    // Fix P: if bio pool resolved a pregnancy this year, suppress family pool
    // pregnancy events. A character cannot conceive twice in one year-tick.
    const suppressFamPregnancy = !!bioResult._pregnancyEventId;

    if (familyPoolActive()) {
      let famTable = buildDrawTable(char, ageGroup, familyFollowOns, 'family', resolvedArchetype, recentFireMap);
      famTable = applyFamilyTableFilters(famTable, age, suppressFamPregnancy);
      if (famTable.length > 0) {
        famEvent  = weightedRandom(famTable);

        // ── FORCED EVENT OVERRIDE (family) ─────────────────────────────
        const pendingFamForced = _forcedEvts.find(fe =>
          fe.pool === 'family' &&
          age >= fe.ageMin && age <= fe.ageMax &&
          !fe._fired
        );
        if (pendingFamForced) {
          const forcedDef = LIFE_EVENTS_BY_ID.get(pendingFamForced.eventId);
          if (forcedDef) {
            famEvent = forcedDef;
            pendingFamForced._fired = true;
          }
        }

        famResult = resolveEvent(famEvent, age, ageGroup);
        // Update recentFireMap for minGapYears enforcement
        if (famEvent.minGapYears) recentFireMap.set(famEvent.id, age);

        // ── ATOMIC PREGNANCY RESOLUTION ────────────────────────────────
        // Intercept all pregnancy-trigger events for both sexs:
        //   Female: 'pregnancy', 'extramarital_pregnancy'
        //   Male:   'spouse_pregnant'
        // resolveEvent() above already applied any social conditions
        // (father_absent for extramarital). Replace famResult with a synthetic
        // object carrying the pregnancy outcome data.
        const isFamPregnancyTrigger =
          (isFemale  && (famEvent.id === 'pregnancy' || famEvent.id === 'extramarital_pregnancy'
                         || famEvent.id === 'pagaelin_pregnancy')) ||
          (!isFemale && famEvent.id === 'spouse_pregnant');

        if (isFamPregnancyTrigger) {
          // For male principals, use wife's estimated age for maternal risk modifiers
          let maternalAge = age;
          if (!isFemale) {
            const cs = currentSpouse();
            if (cs) maternalAge = cs.ageAtMarriage + (age - cs.marriedAtPrincipalAge);
          }
          const pregOutcome = resolvePregnancyOutcome(age, ageGroup, maternalAge);
          // Replace famResult with a synthetic result shaped like resolveEvent output
          famResult = {
            resolvedEvent:   LIFE_EVENTS_BY_ID.get(pregOutcome.eventId) || famEvent,
            injuryDetail:    null,
            rhNote:          pregOutcome.rhNote,
            relationalNote:  pregOutcome.relationalNote,
            freeOPs:         0,
            skillOPs:        [],
            totalSpent:      0,
            // STA delta is applied directly by resolvePregnancyOutcome (female only),
            // but record it in attrDeltas for the history entry
            attrDeltas:      (pregOutcome.difficult && isFemale) ? { STA: -1 } : null,
            diedChildId:     null,
            _pregnancyFlavour:   pregOutcome.flavour,
            _pregnancyEventId:   pregOutcome.eventId,
            _pregnancyLabel:     pregOutcome.eventLabel,
            _pregnancyWeeks:     pregOutcome.weeks,
            _pregnancyDisability: pregOutcome.disability,
            _pregnancyTwins:     pregOutcome.twins ?? false,
          };
          // No follow-ons to register — resolvePregnancyOutcome wrote them directly
        } else {
          // Register family follow-ons normally
          for (const fo of famResult.resolvedEvent.followOn) {
            const tgt = fo.eventId;
            const targetEvent = LIFE_EVENTS_BY_ID.get(tgt);
            const foMap = targetEvent?.pool === 'family' ? familyFollowOns : bioFollowOns;
            const existing = foMap.get(tgt);
            if (!existing || fo.weightMod > existing.weightMod) {
              foMap.set(tgt, { weightMod: fo.weightMod, yearsLeft: fo.duration });
            }
          }
        }
      }
    }

    // ── OP spending ──────────────────────────────────────────────────────────
    // Collect all event IDs that fired this year (both pools), then run the
    // spender. Free OPs from both biographical and family events are pooled —
    // the character has one OP budget regardless of which pool generated them.
    const yearEventIds = [
      bioResult._pregnancyEventId ?? bioResult.resolvedEvent.id,
    ];
    if (famResult) yearEventIds.push(famResult._pregnancyEventId ?? famResult.resolvedEvent.id);

    const totalFreeThisYear = bioResult.freeOPs + (famResult?.freeOPs ?? 0);
    const yearHasMajorNeg   = yearEventIds.some(id => MAJOR_NEGATIVE_EVENTS.has(id));

    const spendResult = opSpender.processYear(
      totalFreeThisYear,
      char.conditions,
      yearEventIds,
      yearHasMajorNeg
    );

    for (const { skill, ops } of spendResult.skillInvestments) {
      opSpendingMap[skill] = (opSpendingMap[skill] || 0) + ops;
    }

    // ── record year in history ────────────────────────────────────────────
    // Biographical event always recorded. Family event recorded only if it
    // fired (not null) and is not itself uneventful.
    // contactId: the most recently added contact stub for this event, if any
    const bioContactId = (() => {
      const CONTACT_EVENTS = new Set([
        'lost_comrade','acquaintance_killed','feud_involvement','reconciled_old_enemy',
        'made_useful_contact','confided_secret','took_an_apprentice',
        'mentor_a_youngster','studied_with_master',
        // Relationship-evolution events (target existing stubs rather than creating new ones;
        // contactId here refers to the mutated stub, not a newly-pushed one)
        'contact_dies','contact_betrayal','contact_falls_out','contact_reconciles',
        'contact_deepens','contact_lost_touch','contact_becomes_enemy',
      ]);
      if (!CONTACT_EVENTS.has(bioResult.resolvedEvent.id)) return null;
      // For stub-creation events: find by sourceEventId.
      // For relationship-evolution events: the relationalNote names the target;
      // find the most recent stub whose name appears in the relationalNote.
      const EVOLUTION_EVENTS = new Set([
        'contact_dies','contact_betrayal','contact_falls_out','contact_reconciles',
        'contact_deepens','contact_lost_touch','contact_becomes_enemy',
      ]);
      if (EVOLUTION_EVENTS.has(bioResult.resolvedEvent.id) && bioResult.relationalNote) {
        const note = bioResult.relationalNote;
        const match = [...contacts].reverse().find(c => note.includes(c.name));
        return match?.id ?? null;
      }
      // Standard: most recently pushed contact for this event
      const match = [...contacts].reverse().find(c => c.sourceEventId === bioResult.resolvedEvent.id);
      return match?.id ?? null;
    })();

    const isBioPregnancyOutcome = !!bioResult._pregnancyEventId;

    const bioEntry = {
      age,
      year,
      ageGroup,
      phase:           char.phase,
      rootless:        char.rootless,
      pool:            'biographical',
      eventId:         isBioPregnancyOutcome ? bioResult._pregnancyEventId   : bioResult.resolvedEvent.id,
      eventLabel:      isBioPregnancyOutcome ? bioResult._pregnancyLabel      : bioResult.resolvedEvent.label,
      flavour:         isBioPregnancyOutcome
                         ? bioResult._pregnancyFlavour
                         : (char.sex === 'female'
                             ? bioResult.resolvedEvent.flavour.female
                             : bioResult.resolvedEvent.flavour.male),
      flavourNote:     isBioPregnancyOutcome
                         ? `week ${bioResult._pregnancyWeeks}${bioResult._pregnancyDisability ? ' — ' + bioResult._pregnancyDisability : ''}`
                         : (bioResult.injuryDetail?.flavourNote ?? null),
      rhNote:          bioResult.rhNote,
      relationalNote:  bioResult.relationalNote,
      contactId:       bioContactId,
      opsEarned:       bioResult.totalSpent,
      freeOPs:         bioResult.freeOPs,
      skillOPs:        bioResult.skillOPs.length > 0 ? [...bioResult.skillOPs] : null,
      attrDeltas:      bioResult.attrDeltas && Object.keys(bioResult.attrDeltas).length > 0
                         ? { ...bioResult.attrDeltas }
                         : null,
      conditionsAfter: [...char.conditions],
      moralityAfter:   char.morality,
    };
    history.push(bioEntry);

    if (famResult
        && famResult.resolvedEvent.id !== 'uneventful_year'
        && famResult.resolvedEvent.id !== 'family_quiet_year') {

      // ── Determine eventId / label / flavour ──────────────────────────────
      // Pregnancy outcomes carry their data in _pregnancy* fields; all other
      // events use the standard resolvedEvent fields.
      const isPregnancyOutcome = !!famResult._pregnancyEventId;

      const famEventId    = isPregnancyOutcome ? famResult._pregnancyEventId    : famResult.resolvedEvent.id;
      const famEventLabel = isPregnancyOutcome ? famResult._pregnancyLabel       : famResult.resolvedEvent.label;

      let famFlavour = isPregnancyOutcome
        ? famResult._pregnancyFlavour
        : (char.sex === 'female'
            ? famResult.resolvedEvent.flavour.female
            : famResult.resolvedEvent.flavour.male);

      // Fix D: child_dies — override flavour text based on child's age and disability
      if (famEventId === 'child_dies' && famResult.diedChildId) {
        const deadChild = children.find(c => c.id === famResult.diedChildId);
        if (deadChild != null) {
          const childAge = deadChild.diedAge ?? 0;
          const dis = deadChild.disability;
          if (dis) {
            // Disability-specific flavour
            const disLabel = dis === 'simple' ? 'simple-minded'
                           : dis === 'blind'  ? 'blind'
                           : dis === 'lame'   ? 'lame' : 'deaf';
            famFlavour = char.sex === 'female'
              ? `She lost ${deadChild.name} — the ${disLabel} child she had given so much to. The grief was mixed with other things she could not name.`
              : `${deadChild.name} died — the ${disLabel} child he had worried over for years. He had never stopped hoping.`;
          } else if (childAge < 3) {
            famFlavour = char.sex === 'female'
              ? 'She lost the infant before it had lived. She did not speak of it for a long time.'
              : 'The child did not survive its first years. He buried it and said nothing.';
          } else if (childAge < 12) {
            famFlavour = char.sex === 'female'
              ? `She lost ${deadChild.name} — still a child, not yet grown. The grief was not the kind that passed.`
              : `${deadChild.name} died young — a child still. He could not account for the size of the absence.`;
          } else {
            famFlavour = char.sex === 'female'
              ? `${deadChild.name} had nearly reached adulthood. She had thought the worst years of worry were behind her.`
              : `${deadChild.name} was nearly grown when he died. A different grief from losing an infant — heavier in some ways.`;
          }
        }
      }

      // spouse_dies tiered flavour — short marriage vs long marriage
      if (famEventId === 'spouse_dies') {
        const cs = spouses.find(s => s.status === 'deceased' && s.diedAtPrincipalAge === age);
        if (cs != null) {
          const marriageDuration = age - cs.marriedAtPrincipalAge;
          if (marriageDuration < 5) {
            famFlavour = char.sex === 'female'
              ? `${cs.name} died before they had found their way into a life together. She had barely learned what she was losing.`
              : `${cs.name} died before they had been long married. He had not had time to learn the shape of the loss.`;
          } else {
            famFlavour = char.sex === 'female'
              ? `${cs.name} died after ${marriageDuration} years together. The silence in the house that followed was unlike any other silence.`
              : `${cs.name} died. They had been married ${marriageDuration} years. He had not thought enough about what that meant until it was over.`;
          }
        }
      }

      // Fix H: miscarriage/stillbirth — widowed flavour variant
      if ((famEventId === 'miscarriage' || famEventId === 'stillbirth')
          && char.conditions.includes('ever_widowed')) {
        famFlavour = famEventId === 'miscarriage'
          ? 'She lost the child before its time. There was no husband to grieve beside her.'
          : 'The child came too still. She had no husband to share the weight of it.';
      }

      const famEntry = {
        age,
        year,
        ageGroup,
        phase:           char.phase,
        rootless:        char.rootless,
        pool:            'family',
        eventId:         famEventId,
        eventLabel:      famEventLabel,
        flavour:         famFlavour,
        flavourNote:     isPregnancyOutcome
                           ? (famResult._pregnancyTwins
                               ? 'twins'
                               : `week ${famResult._pregnancyWeeks}${famResult._pregnancyDisability ? ' — ' + famResult._pregnancyDisability : ''}`)
                           : null,
        rhNote:          famResult.rhNote,
        relationalNote:  famResult.relationalNote,
        opsEarned:       famResult.totalSpent,
        freeOPs:         famResult.freeOPs,
        skillOPs:        famResult.skillOPs.length > 0 ? [...famResult.skillOPs] : null,
        attrDeltas:      famResult.attrDeltas && Object.keys(famResult.attrDeltas).length > 0
                           ? { ...famResult.attrDeltas }
                           : null,
        conditionsAfter: [...char.conditions],
        moralityAfter:   char.morality,
        injuryDetail:    null,
        diedChildId:     famResult.diedChildId ?? null,
      };
      history.push(famEntry);
    }

    // Apply morality drift from the bio event
    const drift = moralityDrift(char.morality, char, bioEntry.eventId);
    if (drift !== 0) {
      char.morality = Math.max(3, Math.min(18, char.morality + drift));
      morality = char.morality;
    }

    // ── PARALLEL CHILD SIMULATION ─────────────────────────────────────────
    // Advance each living child stub one year: mortality, marriage, births,
    // grandchild mortality, departure. Each event is witnessed by the principal
    // and pushed directly to history.
    // Pagaelin household advances every year (pregnancy checks per held woman,
    // child mortality for held women's children).
    if (char.socialClass === 'pagaelin') {
      const hhWitnessed = advancePagaelinHousehold(age);
      for (const w of hhWitnessed) {
        history.push({
          age, year, ageGroup,
          phase:    char.phase,
          rootless: char.rootless,
          pool:     'family',
          eventId:  w.eventId,
          label:    w.label,
          witnessed: true,
          flavour:  null,
          relationalNote: w.relationalNote,
          attrDeltas: null, injuryDetail: null, rhNote: null,
          conditionsAdded: [], conditionsRemoved: [],
          contactId: null, childId: null,
        });
      }
    }
    if (children.length > 0) {
      const witnessed = advanceChildStubs(age);
      for (const w of witnessed) {
        history.push({
          age,
          year,
          ageGroup,
          phase:           char.phase,
          rootless:        char.rootless,
          pool:            'family',
          eventId:         w.eventId,
          eventLabel:      w.eventLabel,
          flavour:         w.flavour,
          flavourNote:     null,
          rhNote:          null,
          relationalNote:  w.relationalNote ?? null,
          opsEarned:       0,
          freeOPs:         0,
          skillOPs:        null,
          attrDeltas:      null,
          conditionsAfter: [...char.conditions],
          moralityAfter:   char.morality,
          injuryDetail:    null,
          diedChildId:     w.diedChildId ?? null,
          gcId:            w.gcId ?? null,
          parentChildId:   w.parentChildId ?? null,
          witnessed:       true,   // flag: generated by parallel child sim, not pool draw
        });
      }
    }

    // ── DEGENERATION (RAW p20) ────────────────────────────────────────────
    // Fires each year from ageOfDegeneration onward. Applies the aging table
    // (1d100 + age vs threshold). Effects are permanent attribute reductions
    // and/or conditions. Does not generate a history entry — these are
    // background processes, not life events.
    if (age >= ageOfDegeneration) {
      applyAgingForYear(char, age);
    }

    // Tick down follow-on durations (at end of year so full duration is available)
    for (const [id, fo] of bioFollowOns)    { fo.yearsLeft--; if (fo.yearsLeft <= 0) bioFollowOns.delete(id); }
    for (const [id, fo] of familyFollowOns) { fo.yearsLeft--; if (fo.yearsLeft <= 0) familyFollowOns.delete(id); }
  }
  } // end runYearLoop()

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 3 — RESULT ASSEMBLY
  // ═══════════════════════════════════════════════════════════════════════════
  // assembleResult() closes over all Phase 1 + Phase 2 state and builds the
  // final CharacterResult object. Also resolves settlement pool names and
  // handles the caller-supplied settlement override.
  function assembleResult() {
  const narrative = buildNarrative(history, classChanges, deityChanges);

  // ── settlement pool name resolution ──────────────────────────────────────
  // If the caller supplied a settlementPool, populate fromName/toName on each
  // history entry by picking randomly from the appropriate pool bucket.
  // The current named location (if supplied) is used as the toName of the
  // final entry rather than a random pick, so the history terminates correctly.
  if (settlementPool) {
    const pickName = (type) => {
      const bucket = settlementPool[type];
      if (!bucket || bucket.length === 0) return null;
      return bucket[Math.floor(rand() * bucket.length)];
    };

    // Track what named place the character is "currently in" at each move.
    // Starts as a random pick from their birth settlement type.
    let currentNamedPlace = pickName(birthSettlement);

    for (const entry of settlementHistory) {
      entry.fromName = currentNamedPlace;
      // For the final history entry whose destination is the caller's named
      // location, use that directly rather than a random pool pick.
      const isLast = entry === settlementHistory[settlementHistory.length - 1];
      if (isLast && location) {
        entry.toName = location;
      } else {
        entry.toName = pickName(entry.to);
      }
      currentNamedPlace = entry.toName;
    }
  }

  // ── settlement override ───────────────────────────────────────────────────
  // If caller supplied a current settlement type that differs from what the
  // simulation ended on, record it as a final implied migration.
  // Derive a reason from the character's history if possible.
  const finalSettlement = (() => {
    if (settlement && SETTLEMENT_TYPES.includes(settlement)) {
      if (settlement !== char.settlementType) {
        // Derive a plausible reason from history
        const isFem    = char.sex === 'female';
        const rootless = char.rootless;
        const movingUp = SETTLEMENT_TYPES.indexOf(settlement) > SETTLEMENT_TYPES.indexOf(char.settlementType);
        let impliedReason;

        if (char.conditions.includes('exiled') || char.conditions.includes('disgraced')) {
          impliedReason = movingUp
            ? 'came seeking anonymity in a larger place'
            : 'withdrew to a quieter life after disgrace';
        } else if (char.conditions.includes('ever_widowed') || char.conditions.includes('bereaved_child')) {
          impliedReason = movingUp
            ? 'sought a fresh start after loss'
            : 'retreated to somewhere smaller after loss';
        } else if (rootless) {
          impliedReason = 'drifted here';
        } else if (movingUp) {
          impliedReason = 'came seeking better prospects';
        } else {
          impliedReason = 'settled for a quieter life';
        }

        settlementHistory.push({
          age:      endAge,
          from:     char.settlementType,
          to:       settlement,
          via:      'arrived_at_current_location',
          reason:   impliedReason,
          fromName: null,         // pool resolution above already ran; leave null for override
          toName:   location || null,
        });
      }
      return settlement;
    }
    return char.settlementType;
  })();

  return {
    socialClass:        char.socialClass,
    sex:             char.sex,
    age:                endAge,
    birthYear,
    gameYear:           _gameYear,
    birthOrder:         char.birthOrder,
    siblingCount:       _siblingData.siblingCount,
    familySize:         _siblingData.familySize,
    estrangementLevel:  _siblingData.estrangementLevel,
    upbringing:         _familyOrigin.type,
    parents:            _familyOrigin.parents,
    siblings:           _familyOrigin.siblings,
    archetype:          resolvedArchetype ? { id: resolvedArchetype.id, label: resolvedArchetype.label, description: resolvedArchetype.description } : null,
    rhPositive:         char.rhPositive,
    phase:              char.phase,
    rootless:           char.rootless,
    attributes:         { ...char.attributes },
    conditions:         [...char.conditions],
    publicDeity:        char.publicDeity,
    secretDeity:        _secretDeityAtBirth,
    isSecretWorshipper: _isSecretWorshipper,

    // Birth profile (HârnMaster RAW pp 3–5, 9, 12)
    birthMonth:         _birthProfile.birthMonth,
    birthDay:           _birthProfile.birthDay,
    sunsign:            _birthProfile.sunsign,
    piety:              _birthProfile.piety,
    medicalTrait:       _birthProfile.medicalTrait ?? null,
    name:               name || null,
    location:           location || null,
    birthSettlement,
    currentSettlement:  finalSettlement,
    settlementType:     char.settlementType,   // current settlement type (hamlet/village/town/city)
    tribalAlignment:    char.tribalAlignment,  // Pagaelin only: 'traditional'|'syncretist'|'walker_dominated'
    settlementHistory,

    oceanScores:        { ...char.oceanScores },
    morality:           char.morality,
    baseMorality:       char.baseMorality,
    disgracedAtAge:     char.disgracedAtAge,
    moralityBand:       getMoralityBand(char.morality),
    lifeExpectancy:     char.lifeExpectancy,
    savedCivilianArchetype: savedCivilianArchetype?.id ?? null,

    spouses,
    children,
    contacts,
    heldWomen,
    holder,
    retainers,
    // Pagaelin household summary — all members share a physical camp
    household: char.socialClass === 'pagaelin' && !isFemale ? (() => {
      const livingWomen    = heldWomen.filter(w => w.status === 'alive');
      const allChildren    = children;  // flat array — all half-siblings know each other
      const livingKids     = allChildren.filter(c => c.status === 'alive');
      const livingRetainers = retainers.filter(r => r.status === 'alive');
      const dangerousRetainers = retainers.filter(r => r.loyalty >= 4 && r.status === 'alive');
      return {
        womenCount:       livingWomen.length,
        childrenCount:    livingKids.length,
        retainerCount:    livingRetainers.length,
        dangerousCount:   dangerousRetainers.length,
        // All children in the household know each other regardless of mother.
        // Half-sibling is a Kaldoric distinction the camp does not make.
        allChildrenIds:   allChildren.map(c => c.id),
        // Power assessment: a rough measure of the man's current standing
        power: Math.min(10, livingWomen.length * 2 + livingRetainers.length
               + (char.phase === 'chieftain' ? 4 : char.phase === 'dominant' ? 1 : 0)),
      };
    })() : null,

    totalOPsEarned,
    totalOPsFree,
    skillOPMap,
    opSpendingMap,
    skillImprovements: opSpender.getSkillRegistry(),
    opSpenderSummary: opSpender.getSummary(),

    history,
    classChanges,
    deityChanges,
    archetypeChanges,
    narrative,
  };
  } // end assembleResult()

  // ═══════════════════════════════════════════════════════════════════════════
  // ORCHESTRATION — three-phase call sequence
  // ═══════════════════════════════════════════════════════════════════════════
  runYearLoop();
  return assembleResult();
}

// ─────────────────────────────────────────────────────────────────────────────
// NARRATIVE BUILDER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Produce a compact narrative from the year-by-year history.
 * Filters out uneventful years and null flavour, clusters consecutive
 * uneventful years as a single "quiet period" note.
 *
 * Returns an array of strings suitable for embedding in an NPC file.
 */
function buildNarrative(history, classChanges, deityChanges) {
  const lines = [];
  let quietStreak = 0;

  for (const year of history) {
    if (year.eventId === 'uneventful_year') {
      quietStreak++;
      continue;
    }

    if (quietStreak > 1) {
      const startAge  = year.age - quietStreak;
      const startYear = year.year ? year.year - quietStreak : null;
      const endAge    = year.age - 1;
      const endYear   = year.year ? year.year - 1 : null;
      const yearRange = startYear ? ` (${startYear}–${endYear} TR)` : '';
      lines.push(`*(Ages ${startAge}–${endAge}${yearRange}: quiet years)*`);
      quietStreak = 0;
    } else {
      quietStreak = 0;  // single quiet year — just skip it silently
    }

    const baseFlavour = year.flavour || year.eventLabel;
    const notes = [year.flavourNote, year.relationalNote].filter(Boolean);
    const fullFlavour = notes.length ? `${baseFlavour} ${notes.join(' ')}` : baseFlavour;
    const yearLabel   = year.year ? ` (${year.year} TR)` : '';
    lines.push(`**Age ${year.age}${yearLabel}** — ${fullFlavour}`);
  }

  // Trailing quiet years
  if (quietStreak > 0) {
    const lastAge = history[history.length - 1]?.age || 0;
    lines.push(`*(Ages ${lastAge - quietStreak + 1}–${lastAge}: quiet years)*`);
  }

  // Class changes
  for (const cc of classChanges) {
    lines.push(`**Age ${cc.fromAge}** *(class change)* — ${cc.note} [${cc.from} → ${cc.to}]`);
  }

  // Deity changes
  for (const dc of deityChanges) {
    if (dc.to !== 'ROLL') {
      lines.push(`**Age ${dc.fromAge}** *(faith change)* — ${dc.note}`);
    }
  }

  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// FORMATTING HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format the narrative lines as a markdown callout block for an NPC file.
 * Uses a [!background] callout — visible to players.
 */
function formatNarrativeCallout(narrative, npcName = 'This character') {
  if (!narrative.length) return '';
  const body = narrative.map(l => `> ${l}`).join('\n');
  return `\n> [!background] Background — ${npcName}\n${body}\n`;
}

/**
 * Format the skill OP map as a compact string for GM reference.
 * e.g. "Rhetoric ×3, Awareness ×2, Oratory ×1"
 */
function formatSkillOPs(skillOPMap) {
  return Object.entries(skillOPMap)
    .sort((a, b) => b[1] - a[1])
    .map(([skill, ops]) => `${skill} \u00d7${ops}`)
    .join(', ');
}

/**
 * Format a one-line summary for Claude Code logging.
 */
function formatHistorySummary(result) {
  const conds  = result.conditions.length ? result.conditions.join(', ') : 'none';
  const skills = Object.keys(result.skillOPMap).length
    ? formatSkillOPs(result.skillOPMap)
    : 'none';
  const spouseStr = result.spouses?.length
    ? result.spouses.map(s => `${s.name} (${s.status})`).join(', ')
    : 'none';
  const childStr = result.children?.length
    ? result.children.map(c => `${c.name} (${c.status}, age ${result.age - c.bornAtPrincipalAge})`).join(', ')
    : 'none';
  return [
    `  Age:          ${result.age}  (${result.socialClass}, ${result.sex}, Rh${result.rhPositive ? '+' : '-'})`,
    `  Total OPs:    ${result.totalOPsEarned}  (${result.totalOPsFree} free, skill-targeted: ${skills})`,
    `  Attributes:   ${Object.entries(result.attributes).map(([k,v])=>`${k}${v}`).join(' ')}`,
    `  Conditions:   ${conds}`,
    `  Deity:        ${result.publicDeity || '(unchanged / re-roll)'}`,
    `  Class:        ${result.socialClass}${result.classChanges.length ? ' (changed)' : ''}`,
    `  Spouses:      ${spouseStr}`,
    `  Children:     ${childStr}`,
  ].join('\n');
}


// ─────────────────────────────────────────────────────────────────────────────
// CHECKPOINT: CAPTURE AND RESUME
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Capture a resumable snapshot of a CharacterResult at a given age.
 *
 * The snapshot contains everything ageCharacter needs to resume simulation
 * from that age: character state, relational records, follow-on maps,
 * accumulated totals, and the history up to that point.
 *
 * @param  {object} result     - CharacterResult from ageCharacter()
 * @param  {number} atAge      - Age to checkpoint at (must be <= result.age)
 * @returns {object|null}      - Checkpoint object, or null if atAge > result.age
 */
function captureCheckpoint(result, atAge) {
  if (atAge > result.age) return null;

  // History entries up to and including atAge
  const historySlice = result.history.filter(e => e.age <= atAge);

  // ── Conditions at atAge ───────────────────────────────────────────────────
  // conditionsAfter is now written on every history entry (Fix 3).
  // Pick the last entry at exactly atAge for the authoritative snapshot.
  const lastEntry = [...historySlice].reverse().find(e => e.age === atAge);
  const conditionsAtAge = lastEntry?.conditionsAfter
    ? [...lastEntry.conditionsAfter]
    : [...result.conditions]; // fallback if older history lacks the field

  // ── Morality at atAge (Fix 10) ────────────────────────────────────────────
  // moralityAfter is written on every history entry. Use the last entry at
  // atAge, falling back to an estimate from OCEAN scores if unavailable.
  const moralityAtAge = lastEntry?.moralityAfter
    ?? lastEntry?.moralityAfter
    ?? result.morality;

  // ── Attributes at atAge ───────────────────────────────────────────────────
  // Replay attrDeltas from history up to atAge.
  const baseAttrs = { STR:10,STA:10,DEX:10,AGL:10,EYE:10,HRG:10,SML:10,VOI:10,INT:10,AUR:10,WIL:10,CML:10 };
  for (const entry of historySlice) {
    if (entry.attrDeltas) {
      for (const [attr, delta] of Object.entries(entry.attrDeltas)) {
        if (baseAttrs[attr] !== undefined) baseAttrs[attr] = Math.max(1, Math.min(21, baseAttrs[attr] + delta));
      }
    }
  }

  // ── Children at atAge (Fix 1) ─────────────────────────────────────────────
  // Use bornAtPrincipalAge (not birthAge) and match child_dies entries by
  // diedChildId (not crude birth-order matching).
  const childrenAtAge = result.children
    .filter(c => c.bornAtPrincipalAge <= atAge)
    .map(c => {
      const died = historySlice.some(e =>
        e.eventId === 'child_dies' &&
        e.diedChildId === c.id &&
        e.age <= atAge
      );
      return { ...c, status: died ? 'deceased' : 'alive' };
    });

  // ── Spouses at atAge (field name fix) ─────────────────────────────────────
  // Spouse stubs use marriedAtPrincipalAge, not marriageAge.
  const spousesAtAge = result.spouses.filter(s => s.marriedAtPrincipalAge <= atAge);

  // ── Contacts at atAge (field name fix) ────────────────────────────────────
  // Contact stubs use metAtPrincipalAge, not metAge.
  const contactsAtAge = result.contacts.filter(c => c.metAtPrincipalAge <= atAge);

  // ── OP totals at atAge ────────────────────────────────────────────────────
  const opsEarnedAtAge = historySlice.reduce((sum, e) => sum + (e.opsEarned || 0), 0);
  const opsFreeAtAge   = historySlice.reduce((sum, e) => sum + (e.freeOPs   || 0), 0);

  // Reconstruct per-skill OP map up to atAge from skillOPs on history entries
  const skillOPAtAge = {};
  for (const entry of historySlice) {
    if (entry.skillOPs) {
      for (const { skill, ops } of entry.skillOPs) {
        skillOPAtAge[skill] = (skillOPAtAge[skill] || 0) + ops;
      }
    }
  }

  return {
    resumeAge:         atAge + 1,
    // Original character params
    socialClass:       result.socialClass,
    sex:            result.sex,
    birthYear:         result.birthYear,
    gameYear:          result.gameYear,
    birthOrder:        result.birthOrder,
    siblingCount:      result.siblingCount,
    familySize:        result.familySize,
    estrangementLevel: result.estrangementLevel,
    _familyOrigin:     result.upbringing ? { type: result.upbringing, parents: result.parents, siblings: result.siblings, conditions: [] } : null,
    rhPositive:        result.rhPositive,
    archetype:         result.archetype?.id ?? null,
    savedCivilianArchetype: result.savedCivilianArchetype ?? null,
    oceanScores:       { ...result.oceanScores },
    birthSettlement:   result.birthSettlement,
    // State at checkpoint
    conditions:        conditionsAtAge,
    attributes:        { ...baseAttrs },
    phase:             lastEntry?.phase   ?? result.phase,
    rootless:          lastEntry?.rootless ?? result.rootless,
    morality:          moralityAtAge,
    baseMorality:      result.baseMorality,
    publicDeity:       result.publicDeity,
    secretDeity:       result.secretDeity ?? null,
    isSecretWorshipper: result.isSecretWorshipper ?? false,
    birthMonth:        result.birthMonth,
    birthDay:          result.birthDay,
    sunsign:           result.sunsign,
    piety:             result.piety,
    medicalTrait:      result.medicalTrait ?? null,
    settlementType:    result.currentSettlement?.type ?? 'town',
    // Relational records up to checkpoint
    spouses:           spousesAtAge,
    children:          childrenAtAge,
    contacts:          contactsAtAge,
    // Pagaelin household
    heldWomen:         char.socialClass === 'pagaelin' ? heldWomen : [],
    holder:            char.socialClass === 'pagaelin' ? holder    : null,
    retainers:         char.socialClass === 'pagaelin' ? retainers : [],
    // History to preserve
    history:           historySlice,
    classChanges:      result.classChanges.filter(c => c.fromAge <= atAge),
    deityChanges:      result.deityChanges.filter(c => c.fromAge <= atAge),
    archetypeChanges:  (result.archetypeChanges || []).filter(c => c.fromAge <= atAge),
    settlementHistory: (result.settlementHistory || []).filter(s => s.age <= atAge),
    // OP state: totals and per-skill registry (Fix 7)
    totalOPsEarned:    opsEarnedAtAge,
    totalOPsFree:      opsFreeAtAge,
    skillOPMap:        skillOPAtAge,
    // Skill improvement counts let the resumed OP spender start from the
    // correct cost tier rather than re-starting every skill at 0.
    skillImprovements: { ...(result.skillImprovements ?? {}) },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// STUB EXPANSION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Expand a stub (spouse, child, or contact) into a full NPC result.
 *
 * Uses the stub's deterministic seed, birthYear, and sharedEvents to produce
 * a self-consistent NPC whose life includes all events shared with the principal
 * (marriage, births, financial ruin, famine, etc.) at the correct ages.
 *
 * Shared events with pool:'biographical' are injected as forcedEvents so the
 * simulation includes them at the right age. Events with eventId 'parent_departed'
 * or other narrative-only markers are skipped (no LIFE_EVENTS entry).
 *
 * @param {object} stub          Spouse, child, or contact stub from ageCharacter result
 * @param {number} gameYear      Current game year (TR) — used to compute targetAge
 * @param {object} [opts]        Optional overrides passed to ageCharacter
 * @returns {object|null}        Full ageCharacter result, or null if stub lacks expansion data
 */
function expandStub(stub, gameYear, opts = {}) {
  if (!stub.birthYear || !stub.stubSeed) {
    return null;  // stub predates expansion metadata — cannot expand deterministically
  }

  // Compute the stub's current age from its birthYear and the game year
  const targetAge = Math.max(1, gameYear - stub.birthYear);

  // Children and other stubs under 18 are not full NPCs — they remain stubs.
  // Expanding a 12-year-old into a life history makes no sense and would produce
  // a biographical record covering only childhood.
  if (targetAge < 18) {
    return null;
  }

  // Convert sharedEvents to forcedEvents format, skipping narrative-only entries
  const forcedEvents = (stub.sharedEvents || [])
    .filter(e => {
      // Skip narrative markers that have no LIFE_EVENTS definition
      const NARRATIVE_ONLY = new Set(['parent_departed']);
      if (NARRATIVE_ONLY.has(e.eventId)) return false;
      // Skip pre-adulthood events — they occurred before simulation start age (18)
      // and cannot be injected as forced events
      if (e.preHistory) return false;
      return true;
    })
    .map(e => ({
      eventId: e.eventId,
      ageMin:  e.ageMin,
      ageMax:  e.ageMax,
      pool:    e.pool || 'biographical',
    }));

  const expanded = ageCharacter({
    socialClass:  stub.socialClass,
    sex:       stub.sex,
    targetAge,
    seed:         stub.stubSeed,
    birthYear:    stub.birthYear,
    forcedEvents,
    ...opts,
  });

  // Transfer the pre-assigned name from the stub into the expanded NPC.
  // ageCharacter never assigns a name — that's done by generate-full-npc.
  // The stub was named at creation time and that name should persist.
  if (expanded && stub.name) {
    expanded.name    = stub.name;
    expanded.given   = stub.given   || stub.name;
    expanded.surname = stub.surname || '';
  }

  return expanded;
}



module.exports = {
  ageCharacter,
  expandStub,
  captureCheckpoint,
  buildNarrative,
  formatNarrativeCallout,
  formatSkillOPs,
  formatHistorySummary,
  getAgeGroup,
  AGE_GROUPS,
  OP_ANNUAL_BUDGET,
  buildDrawTable,
  _resolvePregnancyOutcome,   // exported for unit testing
  /**
   * Explain why events would or would not be drawn for a given character snapshot.
   *
   * Usage (from Claude Code):
   *   const { explainDrawTable } = require('./aging-engine');
   *   const rows = explainDrawTable({
   *     socialClass: 'merchant', sex: 'female', age: 28,
   *     conditions: ['faith_crisis'], morality: 12,
   *     settlementType: 'town',
   *   }, { pool: 'biographical', filter: 'religious_devotion' });
   *   rows.forEach(r => console.log(r));
   *
   * @param {object} charSnapshot  Partial char object — must include socialClass, sex, age.
   *                               Other fields default to neutral values if omitted.
   * @param {object} opts
   *   pool     {string}  'biographical'|'family'|null  — limit to one pool (default null = all)
   *   filter   {string}  If set, only show rows whose id includes this string
   *   topN     {number}  If set, show only the top N by finalWeight (after filter)
   *   showAll  {bool}    If true, include rejected events in output (default false)
   * @returns {string[]} Formatted lines ready for console.log
   */
  explainDrawTable(charSnapshot, opts = {}) {
    const char = {
      socialClass:    charSnapshot.socialClass || 'peasant',
      sex:         charSnapshot.sex      || 'male',
      age:            charSnapshot.age         || 25,
      conditions:     charSnapshot.conditions  || [],
      phase:          charSnapshot.phase       || 'established',
      rootless:       charSnapshot.rootless    || false,
      morality:       charSnapshot.morality    ?? 10,
      baseMorality:   charSnapshot.baseMorality  ?? charSnapshot.morality ?? 10,
      disgracedAtAge: charSnapshot.disgracedAtAge ?? null,
      settlementType: charSnapshot.settlementType || 'town',
      oceanScores:    charSnapshot.oceanScores || {},
    };
    const ageGroup   = getAgeGroup(char.age);
    const followOns  = new Map();
    const archetype  = null;
    const recentFires = new Map();
    const { table, breakdown } = buildDrawTable(char, ageGroup, followOns, opts.pool || null, archetype, recentFires, true);

    const totalWeight = table.reduce((s, [, w]) => s + w, 0);

    let rows = breakdown;
    if (!opts.showAll) rows = rows.filter(r => !r.rejectedReason);
    if (opts.filter)   rows = rows.filter(r => r.id.includes(opts.filter));
    rows.sort((a, b) => (b.finalWeight || 0) - (a.finalWeight || 0));
    if (opts.topN)     rows = rows.slice(0, opts.topN);

    const lines = [
      `=== Draw table: ${char.socialClass} ${char.sex} age ${char.age} (${ageGroup}) pool=${opts.pool||'all'} ===`,
      `    ${table.length} eligible events, total weight ${totalWeight}`,
      '',
    ];
    for (const r of rows) {
      if (r.rejectedReason) {
        lines.push(`  [SKIP] ${r.id.padEnd(36)} reason: ${r.rejectedReason}`);
      } else {
        const pct  = totalWeight > 0 ? ((r.finalWeight / totalWeight) * 100).toFixed(1) : '0.0';
        const c    = r.components;
        const mods = [
          c.sexMod  !== 0 ? `sex${c.sexMod > 0 ? '+' : ''}${c.sexMod}` : null,
          c.condMod    !== 0 ? `cond+${c.condMod}(${Object.keys(c.condModDetail).join(',')})` : null,
          c.rootlessMod !== 0 ? `rootless${c.rootlessMod > 0 ? '+' : ''}${c.rootlessMod}` : null,
          c.phaseMod   !== 0 ? `phase${c.phaseMod > 0 ? '+' : ''}${c.phaseMod}` : null,
          c.ageTaperMod !== 0 ? `taper${c.ageTaperMod > 0 ? '+' : ''}${c.ageTaperMod}` : null,
          c.followOnMod !== 0 ? `followOn+${c.followOnMod}` : null,
          c.archetypeMod !== 0 ? `archetype${c.archetypeMod > 0 ? '+' : ''}${c.archetypeMod}` : null,
          c.settleMod  !== 0 ? `settle${c.settleMod > 0 ? '+' : ''}${c.settleMod}` : null,
          c.moralityMod !== 0 ? `morality${c.moralityMod > 0 ? '+' : ''}${c.moralityMod}` : null,
          r.settlingClamped ? 'SETTLING_CLAMPED' : null,
        ].filter(Boolean).join(' ');
        lines.push(`  ${String(r.finalWeight).padStart(4)}  ${pct.padStart(5)}%  ${r.id.padEnd(36)} base=${c.base}  ${mods}`);
      }
    }
    return lines;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// QUICK TEST (node aging-engine.js)
// ─────────────────────────────────────────────────────────────────────────────

if (require.main === module) {
  console.log('=== Kaldor Aging Engine — Quick Test ===\n');

  const testCases = [
    { socialClass: 'noble',        sex: 'male',   targetAge: 28, label: 'Young noble male (28)' },
    { socialClass: 'noble',        sex: 'female', targetAge: 30, label: 'Noble female (30)' },
    { socialClass: 'soldier',      sex: 'male',   targetAge: 35, label: 'Soldier male (35)' },
    { socialClass: 'merchant',     sex: 'female', targetAge: 40, label: 'Merchant female (40)' },
    { socialClass: 'peasant',      sex: 'male',   targetAge: 45, label: 'Peasant male (45)' },
    { socialClass: 'clergy',       sex: 'female', targetAge: 55, label: 'Clergy female (55)' },
    { socialClass: 'artisan', sex: 'male',   targetAge: 62, label: 'Craftsperson male (62)' },
  ];

  for (const tc of testCases) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`${tc.label}`);
    console.log('─'.repeat(60));

    const result = ageCharacter(tc);
    console.log(formatHistorySummary(result));

    console.log('\n  Life history:');
    for (const line of result.narrative) {
      console.log(`    ${line}`);
    }
  }

  // ── Distribution test: dominant conditions after aging 200 soldiers to 40 ──
  console.log('\n\n=== Condition distribution: 200 soldiers aged to 40 ===');
  const condCounts = {};
  for (let i = 0; i < 200; i++) {
    const r = ageCharacter({ socialClass: 'soldier', sex: 'male', targetAge: 40 });
    for (const c of r.conditions) {
      condCounts[c] = (condCounts[c] || 0) + 1;
    }
  }
  const sorted = Object.entries(condCounts).sort((a, b) => b[1] - a[1]);
  for (const [cond, n] of sorted) {
    const bar = '█'.repeat(Math.round(n / 4));
    console.log(`  ${cond.padEnd(22)} ${String(n).padStart(3)}  ${bar}`);
  }

  // ── OP budget distribution test ──
  console.log('\n=== OP totals: 200 NPCs per class aged to 35 ===');
  const classes = ['noble','merchant','warrior','soldier','peasant','artisan','clergy'];
  for (const cls of classes) {
    let totalFree = 0, totalSkill = 0;
    for (let i = 0; i < 200; i++) {
      const r = ageCharacter({ socialClass: cls, sex: 'male', targetAge: 35 });
      totalFree  += r.totalOPsFree;
      totalSkill += Object.values(r.skillOPMap).reduce((s,v) => s+v, 0);
    }
    console.log(`  ${cls.padEnd(14)} avg free OPs: ${(totalFree/200).toFixed(1).padStart(5)}   avg skill OPs: ${(totalSkill/200).toFixed(1).padStart(5)}`);
  }
}
