#!/usr/bin/env node
'use strict';
const { rand } = require('./rng');

/**
 * Kaldor NPC Injury & Disease Tables
 *
 * Resolves the permanent attribute consequences of injury and disease events
 * in the aging engine. This module abstracts the HârnMaster treatment/healing
 * loop into a single roll-at-event-time outcome, consistent with the yearly
 * resolution of life events.
 *
 * DESIGN PRINCIPLES
 * ─────────────────
 * • Location is rolled first (body region), which determines the attribute at risk.
 * • Severity (minor / serious / grievous) determines magnitude of reduction.
 * • Treatment is abstracted as always having occurred — the event firing IS the
 *   outcome. No separate treatment roll.
 * • All reductions are permanent (asterisk injuries from the Treatment Table).
 * • Disease type determines which attribute cluster is at risk; severity still
 *   determines magnitude.
 *
 * INJURY LOCATION → ATTRIBUTE MAPPING
 * ─────────────────────────────────────
 * Based on HârnMaster strike location anatomy and attribute definitions:
 *
 *   Head (skull, face)      → EYE, HRG, or CML  (sensory / appearance damage)
 *   Neck / throat           → VOI or STA         (voice damage, near-fatal)
 *   Shoulder                → STR                (shoulder girdle, lifting)
 *   Upper arm               → STR                (muscle mass)
 *   Elbow / forearm         → DEX                (fine motor control)
 *   Hand / fingers          → DEX                (grip, fine work)
 *   Chest / thorax          → STA                (endurance base, lung capacity)
 *   Abdomen                 → STA or STR         (core, digestive)
 *   Groin / hip             → AGL                (mobility)
 *   Thigh                   → STR or AGL         (major muscle group)
 *   Knee                    → AGL                (joint)
 *   Lower leg / shin        → AGL                (mobility)
 *   Foot / ankle            → AGL                (mobility)
 *
 * SEVERITY → MAGNITUDE
 * ─────────────────────
 *   Minor   → no permanent reduction (heals fully)
 *   Serious → −1 to affected attribute
 *   Grievous→ −1d3 to affected attribute (1, 2, or 3)
 *
 * Source: Physician 3 Treatment Table — asterisk (*) injuries cause
 * "permanent 1d3 reduction of an attribute after the injury has healed."
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// INJURY LOCATION TABLES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Body region definitions.
 * Each region has:
 *   label:      human-readable name for flavour text
 *   attributes: array of attributes that can be affected (one chosen at random)
 *   condition:  condition flag to add if this location is grievously injured
 */
const BODY_REGIONS = {
  head: {
    label:      'head or face',
    attributes: ['EYE', 'HRG', 'CML'],
    condition:  'scarred',
  },
  neck: {
    label:      'neck or throat',
    attributes: ['VOI', 'STA'],
    condition:  'scarred',
  },
  shoulder: {
    label:      'shoulder',
    attributes: ['STR'],
    condition:  'scarred',
  },
  upper_arm: {
    label:      'upper arm',
    attributes: ['STR'],
    condition:  'scarred',
  },
  forearm_hand: {
    label:      'forearm or hand',
    attributes: ['DEX'],
    condition:  'scarred',
  },
  chest: {
    label:      'chest or torso',
    attributes: ['STA'],
    condition:  'scarred',
  },
  abdomen: {
    label:      'abdomen',
    attributes: ['STA', 'STR'],
    condition:  'scarred',
  },
  hip_groin: {
    label:      'hip or groin',
    attributes: ['AGL'],
    condition:  'scarred',
  },
  thigh: {
    label:      'thigh',
    attributes: ['STR', 'AGL'],
    condition:  'scarred',
  },
  knee: {
    label:      'knee',
    attributes: ['AGL'],
    condition:  'lame',   // knee injuries are especially debilitating
  },
  lower_leg: {
    label:      'lower leg or shin',
    attributes: ['AGL'],
    condition:  'lame',
  },
  foot: {
    label:      'foot or ankle',
    attributes: ['AGL'],
    condition:  'lame',
  },
};

/**
 * Location roll tables by injury context.
 * Format: [[regionKey, weight], ...]
 * Weights reflect relative likelihood of being struck at that location
 * in the given context, roughly matching HârnMaster strike location tables.
 */
const LOCATION_TABLES = {

  // General combat / accident — broad distribution
  general: [
    ['chest',        20],
    ['abdomen',      15],
    ['upper_arm',    12],
    ['thigh',        12],
    ['head',         10],
    ['forearm_hand',  8],
    ['lower_leg',     8],
    ['shoulder',      7],
    ['knee',          4],
    ['hip_groin',     3],
    ['neck',          1],
  ],

  // Battle wound — more torso and limb hits from weapons
  battle: [
    ['chest',        18],
    ['upper_arm',    14],
    ['thigh',        14],
    ['abdomen',      12],
    ['head',         10],
    ['shoulder',      8],
    ['forearm_hand',  8],
    ['lower_leg',     6],
    ['knee',          4],
    ['hip_groin',     4],
    ['neck',          2],
  ],

  // Accident / fall — lower body and hands more common
  accident: [
    ['forearm_hand', 20],
    ['lower_leg',    18],
    ['knee',         14],
    ['foot',         12],
    ['chest',         8],
    ['abdomen',       8],
    ['upper_arm',     8],
    ['head',          6],
    ['shoulder',      4],
    ['hip_groin',     2],
  ],

  // Significant injury from long-term wear (overuse, old wound worsening)
  wear: [
    ['knee',         22],
    ['lower_leg',    16],
    ['foot',         12],
    ['shoulder',     12],
    ['forearm_hand', 10],
    ['hip_groin',     8],
    ['thigh',         8],
    ['back',          6],  // mapped to STA
    ['chest',         6],
  ],
};

// Map 'back' (used in wear table) as a region alias
BODY_REGIONS.back = {
  label:      'back',
  attributes: ['STA'],
  condition:  'scarred',
};

// ─────────────────────────────────────────────────────────────────────────────
// SEVERITY TABLES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Severity distributions by injury context.
 * Format: [[severity, weight], ...]
 *
 * Severity values:
 *   'minor'   → no attribute reduction, adds 'scarred' only
 *   'serious' → −1 to affected attribute
 *   'grievous'→ −1d3 to affected attribute
 */
const SEVERITY_TABLES = {
  // Default skew: most injuries are minor
  general: [
    ['minor',    55],
    ['serious',  35],
    ['grievous', 10],
  ],
  // Battle context: more serious and grievous
  battle: [
    ['minor',    35],
    ['serious',  45],
    ['grievous', 20],
  ],
  // Accident context: mostly minor/serious
  accident: [
    ['minor',    60],
    ['serious',  32],
    ['grievous',  8],
  ],
  // Long-term wear: almost never grievous, but serious is common
  wear: [
    ['minor',    30],
    ['serious',  55],
    ['grievous', 15],
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// DISEASE TABLES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Disease type definitions.
 * Each disease type has:
 *   label:      display name
 *   flavour:    { male, female } — description fragments for narrative
 *   attributes: attribute(s) at risk, in priority order
 *   severity:   distribution of outcome magnitude
 *   condition:  condition flag added
 */
const DISEASE_TYPES = {

  fever_plague: {
    label: 'Fever or plague',
    flavour: {
      male:   'A fever took him hard. He recovered, but something of his vigour did not.',
      female: 'A fever took her hard. She recovered, but something of her vigour did not.',
    },
    attributes: ['STA'],
    // Fever: STA reduction only; magnitude same as general injury
    severity: [
      ['minor',    50],
      ['serious',  38],
      ['grievous', 12],
    ],
    condition: 'chronic_illness',
  },

  wasting_disease: {
    label: 'Wasting disease',
    flavour: {
      male:   'A wasting sickness stripped flesh from his bones over months. He never quite recovered his former strength.',
      female: 'A wasting sickness struck her low for months. She recovered, but her strength was not what it had been.',
    },
    // Both STR and STA affected; each rolled independently at reduced magnitude
    attributes: ['STR', 'STA'],
    severity: [
      ['minor',    40],
      ['serious',  42],
      ['grievous', 18],
    ],
    condition: 'chronic_illness',
  },

  pox_disfigurement: {
    label: 'Pox or disfiguring disease',
    flavour: {
      male:   'The pox left its mark on his face. People noticed.',
      female: 'The pox scarred her face. It changed how the world looked at her.',
    },
    attributes: ['CML'],
    severity: [
      ['minor',    35],
      ['serious',  45],
      ['grievous', 20],
    ],
    condition: 'scarred',
  },

  eye_infection: {
    label: 'Eye infection or injury',
    flavour: {
      male:   'An infection or blow left one eye weakened. His vision was never quite the same.',
      female: 'An infection settled in her eye and would not fully clear. Her sight was diminished.',
    },
    attributes: ['EYE'],
    severity: [
      ['minor',    45],
      ['serious',  40],
      ['grievous', 15],
    ],
    condition: 'blind_one_eye',   // grievous only; see resolver
  },

  joint_disease: {
    label: 'Joint disease or arthritis',
    flavour: {
      male:   'His joints swelled and ached. On cold mornings he moved like an old man regardless of his years.',
      female: 'Her joints gave her trouble — swollen, stiff, and unreliable. She adapted.',
    },
    attributes: ['AGL'],
    severity: [
      ['minor',    35],
      ['serious',  48],
      ['grievous', 17],
    ],
    condition: 'lame',   // grievous only; see resolver
  },

  nerve_damage: {
    label: 'Nerve damage or palsy',
    flavour: {
      male:   'Some nerve had been struck or pinched. His fine motor control was impaired thereafter.',
      female: 'A tremor in the hand, a dead patch on the arm — nerve damage that never fully resolved.',
    },
    attributes: ['DEX'],
    severity: [
      ['minor',    45],
      ['serious',  40],
      ['grievous', 15],
    ],
    condition: 'scarred',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

function randomBetween(min, max) {
  return Math.floor(rand() * (max - min + 1)) + min;
}

function weightedPick(table) {
  const total = table.reduce((s, [, w]) => s + w, 0);
  let roll = rand() * total;
  for (const [item, weight] of table) {
    roll -= weight;
    if (roll <= 0) return item;
  }
  return table[table.length - 1][0];
}

function pickRandom(arr) {
  return arr[Math.floor(rand() * arr.length)];
}

// ─────────────────────────────────────────────────────────────────────────────
// RESOLVERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a physical injury event.
 *
 * @param {string} context  - 'general' | 'battle' | 'accident' | 'wear'
 * @returns {InjuryResult}
 *
 * InjuryResult:
 * {
 *   context:      string,
 *   region:       string,      // region key
 *   regionLabel:  string,      // human-readable
 *   attribute:    string,      // attribute reduced (or null if minor)
 *   severity:     string,      // 'minor' | 'serious' | 'grievous'
 *   reduction:    number,      // 0, 1, 2, or 3
 *   conditions:   string[],    // condition flags to add
 *   attributes:   object,      // { [attr]: delta } ready for effects.attributes
 *   flavourNote:  string,      // short narrative fragment describing the wound
 * }
 */
function resolveInjury(context = 'general') {
  const locTable  = LOCATION_TABLES[context]  || LOCATION_TABLES.general;
  const sevTable  = SEVERITY_TABLES[context]  || SEVERITY_TABLES.general;

  const regionKey   = weightedPick(locTable);
  const region      = BODY_REGIONS[regionKey];
  const attribute   = pickRandom(region.attributes);
  const severity    = weightedPick(sevTable);

  let reduction = 0;
  const conditions = [];

  if (severity === 'minor') {
    // Minor: heals fully, no attribute loss, but always adds 'scarred'
    conditions.push('scarred');
    reduction = 0;
  } else if (severity === 'serious') {
    reduction = 1;
    conditions.push('scarred');
    if (region.condition === 'lame') conditions.push('lame');
  } else {
    // Grievous: 1d3 reduction
    reduction = randomBetween(1, 3);
    conditions.push('scarred');
    conditions.push(region.condition);   // may be 'lame' or 'scarred' (deduped)
  }

  // Deduplicate conditions
  const condSet = [...new Set(conditions)];

  const attrDeltas = reduction > 0 ? { [attribute]: -reduction } : null;

  const flavourNote = buildInjuryFlavour(severity, region.label, attribute, reduction);

  return {
    context,
    region: regionKey,
    regionLabel: region.label,
    attribute: reduction > 0 ? attribute : null,
    severity,
    reduction,
    conditions: condSet,
    attributes: attrDeltas,
    flavourNote,
  };
}

/**
 * Resolve a disease event.
 *
 * @param {string} diseaseType  - key of DISEASE_TYPES
 * @returns {DiseaseResult}
 *
 * DiseaseResult:
 * {
 *   diseaseType:  string,
 *   label:        string,
 *   severity:     string,
 *   attributes:   object,      // { [attr]: delta } — null if minor
 *   conditions:   string[],
 *   flavour:      { male, female },
 *   flavourNote:  string,      // extra severity note appended to flavour
 * }
 */
function resolveDisease(diseaseType) {
  const def = DISEASE_TYPES[diseaseType];
  if (!def) throw new Error(`Unknown disease type: ${diseaseType}`);

  const severity = weightedPick(def.severity);
  const attrDeltas = {};
  const conditions = [def.condition];

  if (severity === 'minor') {
    // Minor: condition added, no attribute loss
  } else if (severity === 'serious') {
    // Serious: −1 to each affected attribute
    for (const attr of def.attributes) {
      attrDeltas[attr] = -1;
    }
  } else {
    // Grievous: −1d3 to each affected attribute (rolled independently)
    for (const attr of def.attributes) {
      attrDeltas[attr] = -randomBetween(1, 3);
    }
    // Grievous eye infection → blind_one_eye instead of just chronic
    if (diseaseType === 'eye_infection') {
      conditions.push('blind_one_eye');
    }
    // Grievous joint disease → lame
    if (diseaseType === 'joint_disease') {
      conditions.push('lame');
    }
  }

  const hasReduction = Object.keys(attrDeltas).length > 0;
  const flavourNote  = buildDiseaseFlavourNote(severity, def.attributes, attrDeltas);

  return {
    diseaseType,
    label:      def.label,
    severity,
    attributes: hasReduction ? attrDeltas : null,
    conditions: [...new Set(conditions)],
    flavour:    def.flavour,
    flavourNote,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FLAVOUR NOTE BUILDERS
// ─────────────────────────────────────────────────────────────────────────────

// Attribute → plain English description
const ATTR_NAMES = {
  STR: 'strength',   STA: 'stamina',    DEX: 'dexterity',
  AGL: 'agility',    EYE: 'eyesight',   HRG: 'hearing',
  SML: 'smell',      VOI: 'voice',      INT: 'intellect',
  AUR: 'aura',       WIL: 'willpower',  CML: 'appearance',
};

function buildInjuryFlavour(severity, regionLabel, attribute, reduction) {
  if (severity === 'minor') {
    return `A minor wound to the ${regionLabel} that healed cleanly, leaving only a scar.`;
  }
  if (severity === 'serious') {
    return `A serious wound to the ${regionLabel}. It healed, but left a permanent reduction in ${ATTR_NAMES[attribute] || attribute} (−1).`;
  }
  return `A grievous wound to the ${regionLabel}. The damage was permanent — ${ATTR_NAMES[attribute] || attribute} reduced by ${reduction}.`;
}

function buildDiseaseFlavourNote(severity, attributes, attrDeltas) {
  if (severity === 'minor') {
    return 'The illness passed without lasting harm.';
  }
  const parts = Object.entries(attrDeltas).map(([attr, delta]) =>
    `${ATTR_NAMES[attr] || attr} −${Math.abs(delta)}`
  );
  if (severity === 'serious') {
    return `The illness left a lasting mark: ${parts.join(', ')}.`;
  }
  return `The illness caused serious permanent damage: ${parts.join(', ')}.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONVENIENCE — resolve and merge into a life-event effects object
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve an injury and return a partial effects object suitable for
 * merging into a life event's effects field at draw time.
 *
 * Usage in aging engine:
 *   const injury = resolveInjuryEffects('battle');
 *   // merge injury.attributes, injury.conditions into event effects
 */
function resolveInjuryEffects(context = 'general') {
  const result = resolveInjury(context);
  return {
    attributes:   result.attributes,
    conditionsAdd: result.conditions,
    flavourNote:  result.flavourNote,
    detail:       result,
  };
}

function resolveDiseaseEffects(diseaseType) {
  const result = resolveDisease(diseaseType);
  return {
    attributes:   result.attributes,
    conditionsAdd: result.conditions,
    flavourNote:  result.flavourNote,
    flavour:      result.flavour,
    detail:       result,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LIFE EVENT INJURY/DISEASE BINDINGS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps life event IDs to their injury/disease resolution parameters.
 * The aging engine checks this map when processing an event and calls
 * the appropriate resolver to generate dynamic attribute effects.
 *
 * Format:
 *   eventId → { type: 'injury'|'disease', context?: string, diseaseType?: string }
 *
 * Events NOT in this map use their hardcoded effects.attributes as-is.
 * Events IN this map have their effects.attributes REPLACED by the resolver output.
 */
const EVENT_INJURY_MAP = {
  // Injury events — context determines location/severity distributions
  significant_injury:    { type: 'injury', context: 'general'  },
  war_wound:             { type: 'injury', context: 'battle'   },
  serious_wound:         { type: 'injury', context: 'battle'   },
  old_injury_worsens:    { type: 'injury', context: 'wear'     },
  captured_prisoner:     { type: 'injury', context: 'general'  },
  difficult_birth:       { type: 'injury', context: 'accident' },  // birth trauma → mother

  // Disease events — type determines attribute cluster at risk
  serious_illness:       { type: 'disease', diseaseType: 'fever_plague'      },
  declining_health:      { type: 'disease', diseaseType: 'wasting_disease'   },
  // chronic_illness follow-on events use the same resolver

  // Parish hardship already grants STA +1 (positive) — no injury resolver needed
  // recovery_regimen already grants STA +1 (positive) — no injury resolver needed
};

/**
 * Weighted distribution for disease type selection when a generic
 * "fell ill" event fires without a specific disease type.
 * Used if a future event needs a random disease.
 */
const RANDOM_DISEASE_TABLE = [
  ['fever_plague',       40],
  ['wasting_disease',    18],
  ['pox_disfigurement',  16],
  ['joint_disease',      12],
  ['eye_infection',       8],
  ['nerve_damage',        6],
];

function rollRandomDiseaseType() {
  return weightedPick(RANDOM_DISEASE_TABLE);
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  // Core resolvers
  resolveInjury,
  resolveDisease,
  resolveInjuryEffects,
  resolveDiseaseEffects,
  rollRandomDiseaseType,

  // Tables (for inspection / extension)
  BODY_REGIONS,
  LOCATION_TABLES,
  SEVERITY_TABLES,
  DISEASE_TYPES,
  RANDOM_DISEASE_TABLE,

  // Binding map used by the aging engine
  EVENT_INJURY_MAP,

  // Utilities (re-exported for use in engine)
  weightedPick,
  pickRandom,
  randomBetween,
};

// ─────────────────────────────────────────────────────────────────────────────
// QUICK TEST (node injury-tables.js)
// ─────────────────────────────────────────────────────────────────────────────

if (require.main === module) {
  console.log('=== Injury & Disease Resolution — Quick Test ===\n');

  // --- Sample injuries across all contexts ---
  const contexts = ['general', 'battle', 'accident', 'wear'];
  for (const ctx of contexts) {
    console.log(`\n── ${ctx.toUpperCase()} injuries (10 samples) ──`);
    for (let i = 0; i < 10; i++) {
      const r = resolveInjury(ctx);
      const attrStr = r.attributes
        ? Object.entries(r.attributes).map(([k,v]) => `${k}${v}`).join(' ')
        : 'no reduction';
      const condStr = r.conditions.join(', ');
      console.log(`  ${r.severity.padEnd(8)} ${r.regionLabel.padEnd(20)} ${attrStr.padEnd(14)} [${condStr}]`);
    }
  }

  // --- Sample diseases ---
  console.log('\n── DISEASE samples (2 per type) ──');
  for (const dType of Object.keys(DISEASE_TYPES)) {
    for (let i = 0; i < 2; i++) {
      const r = resolveDisease(dType);
      const attrStr = r.attributes
        ? Object.entries(r.attributes).map(([k,v]) => `${k}${v}`).join(' ')
        : 'no reduction';
      console.log(`  ${dType.padEnd(22)} ${r.severity.padEnd(8)} ${attrStr.padEnd(18)} → ${r.flavourNote}`);
    }
  }

  // --- Distribution test: 1000 battle injuries ---
  console.log('\n── Battle injury distribution (n=1000) ──');
  const regionCounts = {};
  const sevCounts    = { minor: 0, serious: 0, grievous: 0 };
  const attrCounts   = {};
  for (let i = 0; i < 1000; i++) {
    const r = resolveInjury('battle');
    regionCounts[r.regionLabel] = (regionCounts[r.regionLabel] || 0) + 1;
    sevCounts[r.severity]++;
    if (r.attribute) attrCounts[r.attribute] = (attrCounts[r.attribute] || 0) + 1;
  }
  console.log('  Severity:', sevCounts);
  console.log('  Attribute reductions:',
    Object.entries(attrCounts).sort((a,b)=>b[1]-a[1])
      .map(([k,v]) => `${k}:${v}`).join('  '));
  console.log('  Top regions:',
    Object.entries(regionCounts).sort((a,b)=>b[1]-a[1]).slice(0,5)
      .map(([k,v]) => `${k}:${v}`).join('  '));

  // --- Average attribute loss per injury context ---
  console.log('\n── Average attribute loss per context (n=1000 each) ──');
  for (const ctx of contexts) {
    let totalLoss = 0;
    let grievousCount = 0;
    for (let i = 0; i < 1000; i++) {
      const r = resolveInjury(ctx);
      totalLoss += r.reduction;
      if (r.severity === 'grievous') grievousCount++;
    }
    console.log(`  ${ctx.padEnd(10)} avg loss: ${(totalLoss/1000).toFixed(2)}  grievous: ${grievousCount}`);
  }

  // --- Disease distribution (n=500 per type) ---
  console.log('\n── Disease severity distribution (n=500 per type) ──');
  for (const dType of Object.keys(DISEASE_TYPES)) {
    const sevs = { minor: 0, serious: 0, grievous: 0 };
    let totalLoss = 0;
    for (let i = 0; i < 500; i++) {
      const r = resolveDisease(dType);
      sevs[r.severity]++;
      if (r.attributes) {
        totalLoss += Object.values(r.attributes).reduce((s, v) => s + Math.abs(v), 0);
      }
    }
    console.log(`  ${dType.padEnd(22)} minor:${sevs.minor} serious:${sevs.serious} grievous:${sevs.grievous}  avg total loss: ${(totalLoss/500).toFixed(2)}`);
  }
}
