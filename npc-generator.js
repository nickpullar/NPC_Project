#!/usr/bin/env node
'use strict';
const { rand } = require('./rng');

/**
 * Kaldor NPC Generator
 * 
 * Generates OCEAN personality profiles and deity affiliations for NPCs.
 * Designed for use with Claude Code + Obsidian MCP server.
 * 
 * Usage:
 *   generatePersonality(socialClass, sex, maxTraitCount)
 *   selectDeity(socialClass, sex)
 *   generateNPCPersonality(filePath, socialClass, sex, maxTraitCount)
 *
 * Social classes: 'noble', 'merchant', 'warrior', 'soldier', 'peasant', 'artisan', 'clergy'
 * Sex:         'male', 'female', null
 */

// ============================================================================
// PART 1: OCEAN PERSONALITY FRAMEWORK
// ============================================================================

const OCEAN_FRAMEWORK = {
  // Score (1–100) maps to personality level (1–5)
  ranges: [
    { min: 1,  max: 5,   level: 1 },
    { min: 6,  max: 30,  level: 2 },
    { min: 31, max: 70,  level: 3 },
    { min: 71, max: 95,  level: 4 },
    { min: 96, max: 100, level: 5 }
  ],

  traits: {
    O: {
      name: 'Openness',
      descriptors: [
        'Inflexible*, Dogmatic*, Closed-minded, Rigid',
        'Practical, Conventional, Realistic, Grounded',
        '-',
        'Creative, Curious, Imaginative, Tolerant',
        'Visionary*, Unconventional, Philosophical, Dreamer*'
      ]
    },
    C: {
      name: 'Conscientiousness',
      descriptors: [
        'Careless*, Irresponsible*, Reckless*, Negligent*',
        'Impulsive, Spontaneous, Lackadaisical, Unreliable',
        '-',
        'Disciplined, Methodical, Responsible, Ambitious',
        'Perfectionist*, Obsessive*, Duty-bound, Meticulous'
      ]
    },
    E: {
      name: 'Extroversion',
      descriptors: [
        'Withdrawn*, Introverted*, Aloof, Solitary',
        'Reserved, Quiet, Composed, Understated',
        '-',
        'Outgoing, Sociable, Confident, Enthusiastic',
        'Charismatic*, Bold, Assertive, Attention-seeking*'
      ]
    },
    A: {
      name: 'Agreeableness',
      descriptors: [
        'Competitive*, Callous*, Confrontational*, Harsh',
        'Critical, Skeptical, Tough-minded, Disagreeable',
        '-',
        'Friendly, Compassionate, Cooperative, Considerate',
        'Empathetic*, Trusting, Self-sacrificing*, Agreeable'
      ]
    },
    N: {
      name: 'Neuroticism',
      descriptors: [
        'Confident, Emotionally stable, Resilient, Unflappable',
        'Calm, Self-assured, Composed, Level-headed',
        '-',
        'Anxious, Worried, Self-doubting, Sensitive',
        'Temperamental*, Volatile*, Paranoid*, Neurotic*'
      ]
    }
  },

  // Class biases applied as score adjustments before level mapping
  // Scale: Small ±5, Medium ±10, Large ±15
  classBiases: {
    noble: {
      O: +5,   // Exposure to culture, history, diplomacy [SMALL]
      C: +10,  // Duty, honour, governance [MEDIUM]
      E: +10,  // Public roles, leadership, court [MEDIUM]
      A: -10,  // Hierarchy, entitlement [MEDIUM]
      N: -10   // Trained composure [MEDIUM]
    },
    merchant: {
      O: +10,  // Adaptability, new markets [MEDIUM]
      C: +10,  // Record-keeping, contracts [MEDIUM]
      E: +5,   // Negotiation, networking [SMALL]
      A: -5,   // Self-interest [SMALL]
      N: +5    // Risk awareness [SMALL]
    },
    warrior: {
      O: -5,   // Pragmatism over curiosity [SMALL]
      C: +10,  // Discipline, training [MEDIUM]
      E: +5,   // Group cohesion, boldness [SMALL]
      A: -10,  // Aggression, competition [MEDIUM]
      N: -10   // Desensitisation [MEDIUM]
    },
    soldier: {  // Alias for warrior
      O: -5,
      C: +10,
      E: +5,
      A: -10,
      N: -10
    },
    clergy: {
      O: +10,  // Theology, philosophy [MEDIUM]
      C: +15,  // Ritual, scripture, devotion [LARGE]
      E: 0,
      A: +15,  // Ministry, compassion [LARGE]
      N: +5    // Moral weight, doubt [SMALL]
    },
    peasant: {
      O: -10,  // Limited exposure [MEDIUM]
      C: +15,  // Survival, reliability [LARGE]
      E: -15,  // Deference, humility [LARGE]
      A: +15,  // Community harmony [LARGE]
      N: +10   // Survival anxiety [MEDIUM]
    },
    artisan: {
      O: +5,   // Problem-solving, technique [SMALL]
      C: +15,  // Precision, mastery [LARGE]
      E: 0,
      A: +10,  // Guild bonds [MEDIUM]
      N: 0
    },
    unguilded: {
      O: +5,   // Mobile, varied experience [SMALL]
      C: +5,   // Self-reliant but not guild-trained [SMALL]
      E: 0,
      A: +5,   // Community ties, mutual aid [SMALL]
      N: +5    // Precarious livelihood [SMALL]
    },
    lia_kavair: {
      O: +5,   // Observant, adaptable, reads situations
      C: +15,  // Survival requires discipline — the guild selects hard for this
      E: 0,    // Split: crowd-workers high E, burglars low E; net neutral
      A: -10,  // Predatory profession; self-interest over cooperation
      N: -15   // Low anxiety is a survival trait; those who panic get caught
    },
    priest_naveh: {
      O: +5,   // Ritual depth and drug-induced perception create unusual range — but directed
      C: +15,  // Discipline is the central Navehan virtue; training selects for self-regulation
      E: -10,  // Inner self intensely private; social performance is cover, not genuine
      A: -15,  // Friendship and love are dangerous luxuries, forsaken; warmth is selected against
      N: -10   // Emotional stability required for the work; volatile members are culled early
    },

    // ── NEW GUILDED CLASSES ──────────────────────────────────────────────────
    performer: {
      O: +10,  // Creative range required; harpers/thespians must inhabit many perspectives
      C: +5,   // Discipline of craft — instrument-making, memorisation, technique
      E: +15,  // Performance selects intensely for social boldness
      A: +5,   // Audience relationship; empathy required for effective performance
      N: -5    // Stage fright kills careers; the profession selects for composure
    },
    courtesan: {
      O: +5,   // Range of clients, interests, arts; education in music and dance
      C: +10,  // Professional discipline; the guild contract demands it
      E: +15,  // Social performance is the entire job
      A: +5,   // Reading people accurately is survival; warmth is professional tool
      N: -10   // Composure is non-negotiable; anxiety is career-ending
    },
    innkeeper: {
      O: 0,    // No particular intellectual range required
      C: +10,  // Running premises requires discipline and organisation
      E: +10,  // Hospitality selects for sociability; the taciturn innkeeper loses custom
      A: +10,  // Warmth and conflict-resolution are daily requirements
      N: -5    // Stress management; things go wrong every day
    },
    miner: {
      O: +3,   // Prospecting requires observational curiosity about rock and landscape
      C: +10,  // Dangerous work selects hard for discipline and attention
      E: -5,   // Underground work; small teams; verbal communication not primary
      A: +3,   // Brotherhood fund culture; strong mutual obligation within teams
      N: -15   // The work kills the anxious; survivors are calm under genuine pressure
    },
    mariner: {
      O: +8,   // Travel, foreign ports, strange cultures; curiosity rewarded
      C: +5,   // Shipboard discipline; watch-keeping; procedure saves lives
      E: +5,   // Confined crew environments; social integration required
      A: 0,    // Mixed — respect for hierarchy but roughness with outsiders
      N: -10   // The sea selects for composure; panic kills the crew
    },
    physician: {
      O: +10,  // Intellectual curiosity is the entire job; diagnosis requires lateral thinking
      C: +5,   // Careful observation and record-keeping
      E: +5,   // Bedside manner; patient management; collecting information
      A: +5,   // Empathy for the patient; the callous physician misses symptoms
      N: 0     // Varied — some grow calm, some are haunted by losses
    },
    litigant: {
      O: +5,   // Legal argument requires finding novel angles
      C: +15,  // Meticulous preparation; a missed clause loses a case
      E: +10,  // Court performance; client management; negotiation
      A: -5,   // Adversarial profession; the agreeable litigant loses
      N: -5    // Composure under attack; opponents try to rattle you
    },
    herald: {
      O: +5,   // Genealogical research; diplomatic reading of situations
      C: +15,  // Record-keeping precision; a wrong blazon is a serious offence
      E: +5,   // Diplomatic function; court presence
      A: +10,  // The herald's neutrality requires genuine cordiality with all parties
      N: -5    // Diplomatic composure; must function between parties at war
    },
    arcanist: {
      O: +20,  // The highest openness of any class — intellectual range is the entire vocation
      C: +8,   // Experimental rigour; alchemical precision; years of focused study
      E: -5,   // 'Too involved in their studies to take notice of outsiders' — RAW
      A: 0,    // Mixed — solitary scholars and engaged teachers in equal measure
      N: +5    // The esoteric arts attract the anxious; obsession and anxiety are linked
    }
  },

  // Sex biases — small (±5 only), stacks additively with class bias.
  // Each bias is applied independently and clamped to [1, 100] — there is no
  // combined ±15 cap. A peasant female gets C: +15 (class) + 5 (sex) = +20
  // effective shift. This is intentional: the clamp at 1/100 prevents overflow.
  sexBiases: {
    male: {
      O: 0,
      C: -5,
      E: -5,
      A: -5,
      N: -5
    },
    female: {
      O: 0,
      C: +5,
      E: +5,
      A: +5,
      N: +5
    }
  }
};

// ============================================================================
// PART 2: DEITY TABLES
// ============================================================================

/**
 * Weighted deity tables by social class.
 *
 * Noble:    90% Larani; remaining 10% split Ilvir/Peoni
 *           Males:   Ilvir 70%, Peoni 30% of the 10%  → Larani 90, Ilvir 7, Peoni 3
 *           Females: Ilvir 30%, Peoni 70% of the 10%  → Larani 90, Ilvir 3, Peoni 7
 *
 * Merchant: Halea 30, Larani 30, Peoni 30, Ilvir 10
 * Soldier:  Larani 60, Halea 20, Peoni 10, Sarajin 10
 * Peasant:  Peoni 70, Larani 30
 *
 * Clergy:   No random table — deity determined by order/assignment
 * Craftsperson: Treated as merchant-adjacent; uses merchant table
 */
const DEITY_TABLES = {
  noble: {
    male:    [['Larani', 90], ['Ilvir', 7],  ['Peoni', 3]],
    female:  [['Larani', 90], ['Ilvir', 3],  ['Peoni', 7]],
    neutral: [['Larani', 90], ['Ilvir', 5],  ['Peoni', 5]]
  },
  merchant:     [['Halea', 30],  ['Larani', 30], ['Peoni', 30], ['Ilvir', 10]],
  artisan: [['Halea', 30],  ['Larani', 30], ['Peoni', 30], ['Ilvir', 10]],
  warrior:      [['Larani', 60], ['Halea', 20],  ['Peoni', 10], ['Sarajin', 10]],
  soldier:      [['Larani', 60], ['Halea', 20],  ['Peoni', 10], ['Sarajin', 10]],
  peasant:      [['Peoni', 70],  ['Larani', 30]],
  unguilded:    [['Peoni', 50],  ['Larani', 30], ['Halea', 15], ['Ilvir', 5]],
  // New guilded classes
  performer:    [['Halea', 40],  ['Larani', 25], ['Peoni', 20], ['Ilvir', 15]],  // Halea: arts, pleasure; Ilvir: creativity
  courtesan:    [['Halea', 80],  ['Peoni', 15],  ['Ilvir', 5]],                  // Halea is patron deity of the guild
  innkeeper:    [['Halea', 35],  ['Larani', 30], ['Peoni', 25], ['Ilvir', 10]],  // Halea: commerce; mixed clientele
  miner:        [['Larani', 40], ['Peoni', 35],  ['Ilvir', 15], ['Sarajin', 10]], // Ilvir: earth/creatures; Larani: protection
  mariner:      [['Sarajin', 30],['Larani', 30], ['Peoni', 25], ['Ilvir', 15]],  // Sarajin: sea/Ivinian influence
  physician:    [['Peoni', 60],  ['Larani', 20], ['Halea', 15], ['Ilvir', 5]],   // Peoni: healing church
  litigant:     [['Larani', 50], ['Halea', 30],  ['Peoni', 15], ['Ilvir', 5]],   // Larani: law/justice; Halea: commerce
  herald:       [['Larani', 70], ['Peoni', 15],  ['Halea', 10], ['Ilvir', 5]],   // Larani: honour/nobility
  arcanist:     [['Ilvir', 30],  ['Halea', 25],  ['Larani', 25], ['Peoni', 20]]  // Ilvir: strange knowledge; mixed
  // clergy: omitted — deity set by NPC's religious order
};

// ============================================================================
// PART 3: BANNED DEITY TABLES (SECRET WORSHIP)
// ============================================================================

/**
 * Weighted tables for which banned deity a secret worshipper follows,
 * by social class.
 *
 * Agrik  — war, conquest, slavery      → soldiers/warriors most likely
 * Naveh  — assassination, thieves      → merchants and nobles (power/money)
 * Morgath — undead, corruption, death  → clergy most susceptible (fallen faith)
 *
 * After the public deity is determined, roll 1d200.
 * On a result of 200 (0.5% chance), the NPC secretly worships a banned god.
 * Their public deity remains unchanged — it is merely a facade.
 */
const BANNED_DEITY_TABLES = {
  noble:        [['Agrik', 30], ['Naveh', 40], ['Morgath', 30]],
  merchant:     [['Agrik', 20], ['Naveh', 50], ['Morgath', 30]],
  warrior:      [['Agrik', 50], ['Naveh', 30], ['Morgath', 20]],
  soldier:      [['Agrik', 50], ['Naveh', 30], ['Morgath', 20]],
  peasant:      [['Agrik', 30], ['Naveh', 30], ['Morgath', 40]],
  artisan: [['Agrik', 20], ['Naveh', 40], ['Morgath', 40]],
  unguilded:    [['Agrik', 25], ['Naveh', 35], ['Morgath', 40]],
  clergy:       [['Agrik', 10], ['Naveh', 10], ['Morgath', 80]],
  // New guilded classes
  performer:    [['Agrik', 15], ['Naveh', 45], ['Morgath', 40]],  // information networks attract Naveh
  courtesan:    [['Agrik', 10], ['Naveh', 50], ['Morgath', 40]],  // powerful clients; information; Naveh
  innkeeper:    [['Agrik', 20], ['Naveh', 45], ['Morgath', 35]],  // Lia-Kavair adjacency; Naveh likely
  miner:        [['Agrik', 30], ['Naveh', 25], ['Morgath', 45]],  // underground darkness; Morgath
  mariner:      [['Agrik', 35], ['Naveh', 30], ['Morgath', 35]],  // violent trade; Agrik possible
  physician:    [['Agrik', 10], ['Naveh', 20], ['Morgath', 70]],  // death proximity; fallen healers → Morgath
  litigant:     [['Agrik', 15], ['Naveh', 55], ['Morgath', 30]],  // power and secrets; Naveh
  herald:       [['Agrik', 20], ['Naveh', 40], ['Morgath', 40]],  // genealogical secrets; Naveh
  arcanist:     [['Agrik', 15], ['Naveh', 25], ['Morgath', 60]],  // esoteric knowledge leads toward Morgath
  default:      [['Agrik', 33], ['Naveh', 33], ['Morgath', 34]]
};

/**
 * Roll for secret worship. Returns result object if triggered (roll === 200), else null.
 *
 * Tashal override: if location is 'Tashal' and the secret worship roll triggers,
 * there is a 90% chance the banned deity is Naveh (the powerful Tashal cell).
 * On the remaining 10%, the normal class-weighted table applies.
 *
 * @param {string|null} socialClass
 * @param {string|null} location     - NPC's home location; 'Tashal' activates override
 * @returns {{
 *   secretDeity:  string,
 *   roll:         number,   // the d200 roll (always 200 when this returns non-null)
 *   tashalCell:   boolean   // true if the Tashal Naveh cell was the reason
 * } | null}
 */
function rollSecretWorship(socialClass, location = null) {
  const roll = randomBetween(1, 200);
  if (roll !== 200) return null;

  const inTashal = (location || '').toLowerCase() === 'tashal';

  // Tashal override: 90% chance → Naveh, 10% → normal class table
  if (inTashal && randomBetween(1, 10) <= 9) {
    return { secretDeity: 'Naveh', roll, tashalCell: true };
  }

  // Normal class-weighted selection
  const cls = (socialClass || '').toLowerCase();
  const table = BANNED_DEITY_TABLES[cls] || BANNED_DEITY_TABLES.default;

  const total = table.reduce((sum, [, w]) => sum + w, 0);
  let pick = Math.floor(rand() * total) + 1;
  for (const [deity, weight] of table) {
    pick -= weight;
    if (pick <= 0) return { secretDeity: deity, roll, tashalCell: false };
  }

  return { secretDeity: table[table.length - 1][0], roll, tashalCell: false }; // safety fallback
}

// ============================================================================
// PART 4: UTILITY FUNCTIONS
// ============================================================================

function randomBetween(min, max) {
  return Math.floor(rand() * (max - min + 1)) + min;
}

function scoreToLevel(score) {
  for (const range of OCEAN_FRAMEWORK.ranges) {
    if (score >= range.min && score <= range.max) return range.level;
  }
  return 3;
}

function selectRandomTrait(traitString) {
  if (traitString === '-') return null;
  const traits = traitString.split(',').map(t => t.trim());
  return traits[randomBetween(0, traits.length - 1)];
}

// ============================================================================
// PART 5: OCEAN PERSONALITY GENERATION
// ============================================================================

/**
 * Generate a single OCEAN attribute with optional class and sex bias.
 * If `preRolledScore` is provided, it is used as-is (no re-roll, no bias applied —
 * the aging engine already baked biases in when it computed oceanScores).
 */
function generateAttribute(oceanKey, socialClass = null, sex = null, preRolledScore = null) {
  let score;

  if (preRolledScore !== null && preRolledScore !== undefined) {
    // Use the simulation's own score — biases already applied by aging engine
    score = preRolledScore;
  } else {
    score = randomBetween(1, 100);

    // Apply class bias
    if (socialClass && OCEAN_FRAMEWORK.classBiases[socialClass]) {
      const bias = OCEAN_FRAMEWORK.classBiases[socialClass][oceanKey] || 0;
      score = Math.max(1, Math.min(100, score + bias));
    }

    // Apply sex bias (stacks additively; each bias independently clamped to [1,100])
    if (sex && OCEAN_FRAMEWORK.sexBiases[sex]) {
      const bias = OCEAN_FRAMEWORK.sexBiases[sex][oceanKey] || 0;
      score = Math.max(1, Math.min(100, score + bias));
    }
  }

  const level = scoreToLevel(score);
  const traitDescriptor = OCEAN_FRAMEWORK.traits[oceanKey].descriptors[level - 1];
  const selectedTrait = selectRandomTrait(traitDescriptor);

  if (!selectedTrait) return null;

  const isExtreme = selectedTrait.endsWith('*');
  const cleanTrait = selectedTrait.replace('*', '');
  const baseWeight = randomBetween(1, 10000);
  const weight = isExtreme ? baseWeight + 10000 : baseWeight;

  return { trait: cleanTrait, weight, isExtreme };
}

/**
 * Generate raw OCEAN scores (1–100 each) with class and sex biases applied.
 * Used by the aging engine to derive HârnMaster Morality.
 *
 * @param {string|null} socialClass
 * @param {string|null} sex
 * @returns {{ O: number, C: number, E: number, A: number, N: number }}
 */
function generateOCEANScores(socialClass = null, sex = null) {
  const result = {};
  for (const key of ['O', 'C', 'E', 'A', 'N']) {
    let score = randomBetween(1, 100);
    if (socialClass && OCEAN_FRAMEWORK.classBiases[socialClass]) {
      score = Math.max(1, Math.min(100, score + (OCEAN_FRAMEWORK.classBiases[socialClass][key] || 0)));
    }
    if (sex && OCEAN_FRAMEWORK.sexBiases[sex]) {
      score = Math.max(1, Math.min(100, score + (OCEAN_FRAMEWORK.sexBiases[sex][key] || 0)));
    }
    result[key] = score;
  }
  return result;
}

/**
 * Generate a full OCEAN personality profile.
 *
 * @param {string|null} socialClass       - 'noble', 'merchant', 'warrior', 'soldier',
 *                                          'peasant', 'artisan', 'clergy'
 * @param {string|null} sex            - 'male', 'female', or null
 * @param {number|null} maxTraitCount     - Max traits to return (1–5); random 1–3 if null
 * @param {object|null} existingOceanScores - { O, C, E, A, N } from aging engine.
 *                                            When provided, these scores are used directly
 *                                            (no re-roll), ensuring personality descriptors
 *                                            match the simulation's morality derivation.
 * @returns {string} Personality description, e.g. "Character is ambitious and disciplined"
 */
function generatePersonality(socialClass = null, sex = null, maxTraitCount = null, existingOceanScores = null) {
  const validClasses = [null, '', 'noble', 'merchant', 'warrior', 'soldier', 'clergy', 'peasant', 'artisan', 'unguilded'];
  const npcClass = validClasses.includes(socialClass) ? (socialClass || null) : null;

  const validSexs = [null, '', 'male', 'female'];
  const npcSex = validSexs.includes(sex) ? (sex || null) : null;

  let maxTraits;
  if (maxTraitCount === null || maxTraitCount === undefined || maxTraitCount === '') {
    maxTraits = randomBetween(1, 3);
  } else {
    maxTraits = Math.max(1, Math.min(5, parseInt(maxTraitCount, 10)));
  }

  const attributes = [];
  for (const key of ['O', 'C', 'E', 'A', 'N']) {
    const preRolled = existingOceanScores ? (existingOceanScores[key] ?? null) : null;
    const attr = generateAttribute(key, npcClass, npcSex, preRolled);
    if (attr) attributes.push(attr);
  }

  const ranked = attributes
    .sort((a, b) => b.weight - a.weight)
    .slice(0, maxTraits);

  if (ranked.length === 0) return 'Character is very boring';

  const traitTexts = ranked.map(a => a.trait.toLowerCase());
  if (traitTexts.length === 1) return `Character is ${traitTexts[0]}`;
  if (traitTexts.length === 2) return `Character is ${traitTexts[0]} and ${traitTexts[1]}`;
  const last = traitTexts.pop();
  return `Character is ${traitTexts.join(', ')} and ${last}`;
}

// ============================================================================
// PART 6: DEITY SELECTION
// ============================================================================

/**
 * Select a deity (public) and check for secret banned-deity worship.
 *
 * Public deity:
 *   - Determined by social class and sex weighted tables.
 *   - Clergy: returns null for publicDeity (set by religious order).
 *
 * Secret worship:
 *   - Roll 1d200. On 200 (0.5%), the NPC secretly worships a banned god.
 *   - Applied to ALL classes including clergy.
 *   - The publicDeity is the facade the NPC presents to the world.
 *   - If location is 'Tashal', 90% chance the secret deity is Naveh.
 *
 * @param {string|null} socialClass
 * @param {string|null} sex       - Matters only for noble public deity split
 * @param {string|null} location     - NPC's home location; 'Tashal' activates Naveh override
 * @returns {{
 *   publicDeity:        string|null,
 *   secretDeity:        string|null,
 *   isSecretWorshipper: boolean,
 *   secretRoll:         number|null,
 *   tashalCell:         boolean
 * }}
 */
function selectDeity(socialClass, sex = null, location = null) {
  const cls = (socialClass || '').toLowerCase();

  // --- Public deity ---
  let publicDeity = null;

  if (cls && cls !== 'clergy') {
    let table;
    if (cls === 'noble') {
      const g = (sex || '').toLowerCase();
      if      (g === 'male')   table = DEITY_TABLES.noble.male;
      else if (g === 'female') table = DEITY_TABLES.noble.female;
      else                     table = DEITY_TABLES.noble.neutral;
    } else {
      table = DEITY_TABLES[cls] || null;
    }

    if (table) {
      const total = table.reduce((sum, [, w]) => sum + w, 0);
      let roll = Math.floor(rand() * total) + 1;
      for (const [deity, weight] of table) {
        roll -= weight;
        if (roll <= 0) { publicDeity = deity; break; }
      }
      if (!publicDeity) publicDeity = table[table.length - 1][0];
    }
  }

  // --- Secret worship (0.5% for all classes, including clergy) ---
  const secret = rollSecretWorship(socialClass, location);

  return {
    publicDeity,
    secretDeity:        secret ? secret.secretDeity : null,
    isSecretWorshipper: !!secret,
    secretRoll:         secret ? secret.roll : null,
    tashalCell:         secret ? secret.tashalCell : false
  };
}

// ============================================================================
// PART 7: AUTOMATIC SKILLS GENERATION
// ============================================================================

/**
 * HârnMaster automatic skills — every character has these regardless of occupation.
 * Source: Skills 3 (capital letters = automatic), Skills 9 (CONDITION), Skills 12 (RITUAL),
 *         Skills 18 (INITIATIVE, UNARMED).
 *
 * SB formula: average the listed attributes (duplicates count twice), add sunsign bonus.
 * OML: SB × multiplier shown.
 *
 * Sunsign codes → short name mapping (see Skills 4 attribute codes)
 * Ahn=Ahnu  Ang=Angberelius  Ara=Aralius  Fen=Feneri  Hir=Hirin  Lad=Lado
 * Mas=Masara  Nad=Nadai  Sko=Skorus  Tai=Tai  Tar=Tarael  Ula=Ulandus
 */

const SUNSIGN_CODES = {
  Ula: 'Ulandus', Ara: 'Aralius', Fen: 'Feneri',  Ahn: 'Ahnu',
  Ang: 'Angberelius', Nad: 'Nadai', Hir: 'Hirin', Tar: 'Tarael',
  Tai: 'Tai',    Sko: 'Skorus',  Mas: 'Masara',   Lad: 'Lado'
};

// Full sunsign list in calendar order
const SUNSIGNS = [
  'Ulandus','Aralius','Feneri','Ahnu','Angberelius','Nadai',
  'Hirin','Tarael','Tai','Skorus','Masara','Lado'
];

/**
 * Automatic skill definitions.
 * attrs:    attribute keys used in SB calculation (duplicates = double-counted)
 * sunsigns: array of { signs: [string,...], bonus: number }
 * oml:      SB multiplier
 *
 * CONDITION uses ENDURANCE (= (STR+STA)/2, rounded) as its SB — handled specially.
 * RITUAL is per-deity and handled separately via RITUAL_SKILL_BASES.
 */
const AUTOMATIC_SKILLS = {
  // Physical
  CLIMBING:   { attrs: ['STR','DEX','AGL'], sunsigns: [{signs:['Ulandus','Aralius'], bonus:2}], oml: 4 },
  CONDITION:  { attrs: ['STR','STA','WIL'], sunsigns: [{signs:['Ulandus','Lado'],    bonus:1}], oml: 5 },
  JUMPING:    { attrs: ['STR','AGL','AGL'], sunsigns: [{signs:['Nadai','Hirin'],      bonus:2}], oml: 4 },
  STEALTH:    { attrs: ['AGL','HRG','WIL'], sunsigns: [{signs:['Hirin','Tarael','Tai'], bonus:2}], oml: 3 },
  THROWING:   { attrs: ['STR','DEX','EYE'], sunsigns: [{signs:['Hirin'], bonus:2}, {signs:['Tarael','Nadai'], bonus:1}], oml: 4 },
  // Communication
  AWARENESS:  { attrs: ['EYE','HRG','SML'], sunsigns: [{signs:['Hirin','Tarael'], bonus:2}], oml: 4 },
  INTRIGUE:   { attrs: ['INT','AUR','WIL'], sunsigns: [{signs:['Tai','Tarael','Skorus'], bonus:1}], oml: 3 },
  ORATORY:    { attrs: ['CML','VOI','INT'], sunsigns: [{signs:['Tarael'], bonus:1}], oml: 2 },
  RHETORIC:   { attrs: ['VOI','INT','WIL'], sunsigns: [{signs:['Tai','Tarael','Skorus'], bonus:1}], oml: 3 },
  SINGING:    { attrs: ['HRG','VOI','VOI'], sunsigns: [{signs:['Masara'], bonus:1}], oml: 3 },
  // Combat
  INITIATIVE: { attrs: ['AGL','WIL','WIL'], sunsigns: [], oml: 4 },
  UNARMED:    { attrs: ['STR','DEX','AGL'], sunsigns: [{signs:['Masara','Lado','Ulandus'], bonus:2}], oml: 4 }
};

/**
 * Ritual skill bases by deity (third attribute varies).
 * Formula: (VOI + INT + thirdAttr) / 3, then add sunsign bonus.
 * OML: SBx1
 */
const RITUAL_SKILL_BASES = {
  Agrik:     { thirdAttr: 'STR', sunsigns: [{signs:['Nadai'], bonus:2}, {signs:['Angberelius','Ahnu'], bonus:1}] },
  Halea:     { thirdAttr: 'CML', sunsigns: [{signs:['Tarael'], bonus:2}, {signs:['Hirin','Masara'], bonus:1}] },
  Ilvir:     { thirdAttr: 'AUR', sunsigns: [{signs:['Skorus'], bonus:2}, {signs:['Tai','Ulandus'], bonus:1}] },
  Larani:    { thirdAttr: 'WIL', sunsigns: [{signs:['Angberelius'], bonus:2}, {signs:['Ahnu','Feneri'], bonus:1}] },
  Morgath:   { thirdAttr: 'AUR', sunsigns: [{signs:['Lado'], bonus:2}, {signs:['Ahnu','Masara'], bonus:1}] },
  Naveh:     { thirdAttr: 'WIL', sunsigns: [{signs:['Masara'], bonus:2}, {signs:['Skorus','Tarael'], bonus:1}] },
  Peoni:     { thirdAttr: 'DEX', sunsigns: [{signs:['Aralius'], bonus:2}, {signs:['Angberelius','Ulandus'], bonus:1}] },
  Sarajin:   { thirdAttr: 'STR', sunsigns: [{signs:['Feneri'], bonus:2}, {signs:['Aralius','Lado'], bonus:1}] },
  'Save-Knor': { thirdAttr: 'INT', sunsigns: [{signs:['Tai'], bonus:2}, {signs:['Skorus','Tarael'], bonus:1}] },
  Siem:      { thirdAttr: 'AUR', sunsigns: [{signs:['Hirin'], bonus:2}, {signs:['Feneri','Ulandus'], bonus:1}] }
};

/**
 * Calculate a skill base from an attribute array and optional sunsign.
 *
 * @param {string[]} attrKeys   - Attribute keys, e.g. ['STR','AGL','AGL']
 * @param {object}   attributes - Character attributes { STR:12, STA:13, ... }
 * @param {string[]} sunsignDefs - Array of {signs:[...], bonus:n} entries
 * @param {string|null} sunsign - Character's sunsign (full name, e.g. 'Hirin')
 * @returns {number} Skill Base
 */
function calcSB(attrKeys, attributes, sunsignDefs, sunsign) {
  const sum = attrKeys.reduce((acc, key) => acc + (attributes[key] || 10), 0);
  let sb = Math.round(sum / attrKeys.length);

  if (sunsign) {
    for (const def of sunsignDefs) {
      if (def.signs.includes(sunsign)) {
        sb += def.bonus;
        break;
      }
    }
  }
  return sb;
}

/**
 * Generate all automatic skills for a character.
 *
 * Returns an array of skill objects: { name, sb, oml, isRitual, deity? }
 * oml = sb × multiplier (the opening mastery level)
 *
 * For RITUAL, only the character's public deity is included.
 * CONDITION uses the Endurance-based SB (STR+STA)/2 rounded.
 *
 * @param {object}      attributes    - { STR, STA, DEX, AGL, EYE, HRG, SML, VOI, INT, AUR, WIL, CML }
 * @param {string|null} sunsign       - Character's sunsign (full name)
 * @param {string|null} publicDeity   - Character's deity (for Ritual skill)
 * @returns {Array<{name:string, sb:number, oml:number, isRitual:boolean, deity?:string}>}
 */
function generateAutomaticSkills(attributes, sunsign = null, publicDeity = null, socialClass = null) {
  const skills = [];

  for (const [skillName, def] of Object.entries(AUTOMATIC_SKILLS)) {
    let sb;

    if (skillName === 'CONDITION') {
      // CONDITION SB = ENDURANCE = (STR + STA) / 2 rounded, then sunsign mod
      const endurance = Math.round(((attributes.STR || 10) + (attributes.STA || 10)) / 2);
      sb = endurance;
      if (sunsign) {
        for (const sd of def.sunsigns) {
          if (sd.signs.includes(sunsign)) { sb += sd.bonus; break; }
        }
      }
    } else {
      sb = calcSB(def.attrs, attributes, def.sunsigns, sunsign);
    }

    skills.push({
      name: skillName,
      sb,
      oml: sb * def.oml,
      isRitual: false
    });
  }

  // RITUAL — only if a deity is known
  if (publicDeity && publicDeity !== 'ORDER_ASSIGNED') {
    const ritualDef = RITUAL_SKILL_BASES[publicDeity] || RITUAL_SKILL_BASES['Save-Knor'];
    if (ritualDef) {
      const sb = calcSB(['VOI', 'INT', ritualDef.thirdAttr], attributes, ritualDef.sunsigns, sunsign);
      skills.push({ name: 'RITUAL', sb, oml: sb * 4, isRitual: true, deity: publicDeity });
    }
  }

  // Clergy professional skills — branched by deity
  if (socialClass === 'clergy') {
    // Shared literacy skills (Emela/Khruni — shared church language of Larani and Peoni)
    const lakiseSB = calcSB(['INT','INT','DEX'], attributes, [], sunsign);
    skills.push({ name: 'Script (Lakise)',   sb: lakiseSB, oml: 70 + lakiseSB, isRitual: false, isProfessional: true });
    skills.push({ name: 'Script (Khruni)',   sb: lakiseSB, oml: 70 + lakiseSB, isRitual: false, isProfessional: true });
    const emelaSB  = calcSB(['VOI','INT','INT'], attributes, [], sunsign);
    skills.push({ name: 'Language (Emela)', sb: emelaSB,  oml: emelaSB * 3,   isRitual: false, isProfessional: true });

    // Shared skills — all ordained clergy
    const mcSB  = calcSB(['WIL','WIL','INT'], attributes, [], sunsign);
    skills.push({ name: 'MENTAL CONFLICT',  sb: mcSB,    oml: mcSB * 4,   isRitual: false, isProfessional: true });
    const embSB = calcSB(['DEX','INT','WIL'], attributes, [], sunsign);
    skills.push({ name: 'EMBALMING',        sb: embSB,   oml: embSB * 2,  isRitual: false, isProfessional: true });
    const lawSB = calcSB(['INT','WIL','INT'], attributes, [], sunsign);
    skills.push({ name: 'LAW',              sb: lawSB,   oml: lawSB * 2,  isRitual: false, isProfessional: true });

    if (publicDeity === 'Peoni') {
      // Peonian ordained skills — Irreproachable Order / Balm of Joy
      // Source: Irreproachable Order PDF ordination skill list
      const physSB = calcSB(['DEX','INT','WIL'], attributes, [], sunsign);
      skills.push({ name: 'PHYSICIAN',      sb: physSB,  oml: physSB * 3, isRitual: false, isProfessional: true });
      const agriSB = calcSB(['STR','WIL','AGL'], attributes, [], sunsign);
      skills.push({ name: 'Agriculture',    sb: agriSB,  oml: agriSB * 4, isRitual: false, isProfessional: true });
      const animSB = calcSB(['AUR','INT','WIL'], attributes, [], sunsign);
      skills.push({ name: 'Animalcraft',    sb: animSB,  oml: animSB * 3, isRitual: false, isProfessional: true });
      const herbSB = calcSB(['INT','WIL','EYE'], attributes, [], sunsign);
      skills.push({ name: 'HERBLORE',       sb: herbSB,  oml: herbSB * 3, isRitual: false, isProfessional: true });
      const weatSB = calcSB(['INT','EYE','WIL'], attributes, [], sunsign);
      skills.push({ name: 'Weatherlore',    sb: weatSB,  oml: weatSB * 4, isRitual: false, isProfessional: true });
      const textSB = calcSB(['DEX','WIL','INT'], attributes, [], sunsign);
      skills.push({ name: 'Textilecraft',   sb: textSB,  oml: textSB * 3, isRitual: false, isProfessional: true });
    } else if (publicDeity === 'Halea') {
      // Halean ordained skills — Order of the Silken Voice / Shenasene
      // Source: HârnMaster Religion (Halea). No combat skills.
      // Intrigue, Rhetoric, Oratory, Musician replace the martial set.
      // Church script/language: Lakise + Emela (shared with other orders on Hârn).
      const intrigSB = calcSB(['INT','WIL','AGL'], attributes, [], sunsign);
      skills.push({ name: 'INTRIGUE',     sb: intrigSB, oml: intrigSB * 4, isRitual: false, isProfessional: true });
      const rhetSB   = calcSB(['VOI','INT','WIL'], attributes, [], sunsign);
      skills.push({ name: 'Rhetoric',     sb: rhetSB,   oml: rhetSB * 4,   isRitual: false, isProfessional: true });
      const oratSB   = calcSB(['VOI','INT','WIL'], attributes, [], sunsign);
      skills.push({ name: 'Oratory',      sb: oratSB,   oml: oratSB * 3,   isRitual: false, isProfessional: true });
      const musSB    = calcSB(['DEX','VOI','INT'], attributes, [], sunsign);
      skills.push({ name: 'Musician',     sb: musSB,    oml: musSB * 3,    isRitual: false, isProfessional: true });
      const physSB   = calcSB(['DEX','INT','WIL'], attributes, [], sunsign);
      skills.push({ name: 'PHYSICIAN',    sb: physSB,   oml: physSB * 2,   isRitual: false, isProfessional: true });
      const herbSB   = calcSB(['INT','WIL','EYE'], attributes, [], sunsign);
      skills.push({ name: 'HERBLORE',     sb: herbSB,   oml: herbSB * 2,   isRitual: false, isProfessional: true });
    } else {
      // Source: HârnMaster Character 23
      const physSB  = calcSB(['DEX','INT','WIL'], attributes, [], sunsign);
      skills.push({ name: 'PHYSICIAN',      sb: physSB,  oml: physSB * 2, isRitual: false, isProfessional: true });
      const herSB   = calcSB(['EYE','INT','INT'], attributes, [], sunsign);
      skills.push({ name: 'HERALDRY',       sb: herSB,   oml: herSB * 3,  isRitual: false, isProfessional: true });
      // Combat skills — Laranian clergy only
      const swordSB = calcSB(['STR','DEX','AGL'], attributes, [], sunsign);
      skills.push({ name: 'SWORD',          sb: swordSB, oml: swordSB * 4, isRitual: false, isProfessional: true });
      skills.push({ name: 'SHIELD',         sb: swordSB, oml: swordSB * 4, isRitual: false, isProfessional: true });
      skills.push({ name: 'DAGGER',         sb: swordSB, oml: swordSB * 4, isRitual: false, isProfessional: true });
    }
  }

  return skills;
}

/**
 * Format automatic skills as a compact markdown list for embedding in an NPC file.
 *
 * Example output:
 *   **Automatic Skills** *(SB / OML)*
 *   CLIMBING 11/44 · CONDITION 12/60 · JUMPING 11/44 · ...
 *
 * @param {Array}  skills     - Output of generateAutomaticSkills()
 * @param {boolean} compact   - If true, single line; if false, one per line
 * @returns {string}
 */
function formatAutomaticSkills(skills, compact = true) {
  const entries = skills.map(s => {
    const label = s.isRitual ? `RITUAL (${s.deity})` : s.name;
    return `${label} ${s.sb}/${s.oml}`;
  });

  if (compact) {
    return `**Automatic Skills** *(SB/OML)*: ${entries.join(' · ')}`;
  }
  return `**Automatic Skills** *(SB/OML)*\n${entries.map(e => `- ${e}`).join('\n')}`;
}

/**
 * Roll a random sunsign. Used when no birthdate is provided.
 * @returns {string}
 */
function rollSunsign() {
  return SUNSIGNS[Math.floor(rand() * SUNSIGNS.length)];
}

// ============================================================================
// PART 8: HOBBY SKILLS
// ============================================================================

/**
 * Curated skill attribute table for hobby candidates.
 * Format: { attrs: [...], omlMultiplier: N, sunsigns: [...] }
 * Sourced directly from the Skill Data table (Skills 3–4).
 */
const HOBBY_SKILL_DATA = {
  // Physical / outdoor
  Acrobatics:  { attrs: ['STR','AGL','AGL'],     oml: 2, sunsigns: [{signs:['Nadai'], bonus:2}, {signs:['Hirin'], bonus:1}] },
  Dancing:     { attrs: ['DEX','AGL','AGL'],     oml: 2, sunsigns: [{signs:['Tarael'], bonus:2}, {signs:['Hirin','Tai'], bonus:1}] },
  Fishing:     { attrs: ['DEX','EYE','WIL'],     oml: 3, sunsigns: [{signs:['Masara','Lado'], bonus:2}] },
  Swimming:    { attrs: ['STA','DEX','AGL'],     oml: 1, sunsigns: [{signs:['Skorus'], bonus:1}, {signs:['Masara','Lado'], bonus:3}] },
  // Communication / performance
  Singing:     { attrs: ['HRG','VOI','VOI'],     oml: 3, sunsigns: [{signs:['Masara'], bonus:1}] },
  Musician:    { attrs: ['DEX','HRG','HRG'],     oml: 1, sunsigns: [{signs:['Masara','Angberelius'], bonus:1}] },
  Oratory:     { attrs: ['CML','VOI','INT'],     oml: 2, sunsigns: [{signs:['Tarael'], bonus:1}] },
  Acting:      { attrs: ['AGL','VOI','INT'],     oml: 2, sunsigns: [{signs:['Tarael','Tai'], bonus:1}] },
  // Lore
  Folklore:    { attrs: ['VOI','INT','INT'],     oml: 3, sunsigns: [{signs:['Tai'], bonus:2}] },
  Astrology:   { attrs: ['EYE','INT','AUR'],     oml: 1, sunsigns: [{signs:['Tarael'], bonus:1}] },
  Herblore:    { attrs: ['EYE','SML','INT'],     oml: 1, sunsigns: [{signs:['Ulandus'], bonus:3}, {signs:['Aralius'], bonus:2}] },
  Weatherlore: { attrs: ['INT','EYE','SML'],     oml: 3, sunsigns: [{signs:['Hirin','Tarael','Masara','Lado'], bonus:1}] },
  Mathematics: { attrs: ['INT','INT','WIL'],     oml: 1, sunsigns: [{signs:['Tai'], bonus:3}, {signs:['Tarael','Skorus'], bonus:1}] },
  // Craft
  Drawing:     { attrs: ['DEX','EYE','EYE'],     oml: 2, sunsigns: [{signs:['Skorus','Tai'], bonus:1}] },
  Cookery:     { attrs: ['DEX','SML','SML'],     oml: 3, sunsigns: [{signs:['Skorus'], bonus:1}] },
  Woodcraft:   { attrs: ['DEX','DEX','WIL'],     oml: 2, sunsigns: [{signs:['Ulandus'], bonus:2}, {signs:['Aralius','Lado'], bonus:1}] },
  Brewing:     { attrs: ['DEX','SML','SML'],     oml: 2, sunsigns: [{signs:['Skorus'], bonus:3}, {signs:['Tai','Masara'], bonus:2}] },
  Animalcraft: { attrs: ['AGL','VOI','WIL'],     oml: 1, sunsigns: [{signs:['Ulandus','Aralius'], bonus:1}] },
  // Noble-flavoured
  Heraldry:    { attrs: ['DEX','EYE','WIL'],     oml: 1, sunsigns: [{signs:['Skorus','Tai'], bonus:1}] },
  Riding:      { attrs: ['DEX','AGL','WIL'],     oml: 1, sunsigns: [{signs:['Ulandus','Aralius'], bonus:1}] },
  // Clergy/scholar
  Physician:   { attrs: ['DEX','EYE','INT'],     oml: 1, sunsigns: [{signs:['Masara'], bonus:2}, {signs:['Skorus','Tai'], bonus:1}] },
  Tarotry:     { attrs: ['INT','AUR','WIL'],     oml: 1, sunsigns: [{signs:['Tarael','Tai'], bonus:2}, {signs:['Skorus','Hirin'], bonus:1}] },
  Runecraft:   { attrs: ['INT','AUR','AUR'],     oml: 1, sunsigns: [{signs:['Tai'], bonus:2}, {signs:['Skorus'], bonus:1}] },
};

/**
 * Weighted hobby tables by social class.
 * Format: [skillName, weight]
 * Weights reflect plausibility for the class — higher = more common.
 * Every class has a small "wildcard" weight (5) on a few unlikely-but-possible skills
 * to occasionally generate surprising results.
 */
const HOBBY_TABLES = {
  noble: [
    ['Dancing',     20], ['Heraldry',    18], ['Musician',    15],
    ['Singing',     15], ['Riding',      15], ['Astrology',   12],
    ['Drawing',     12], ['Folklore',    12], ['Oratory',     10],
    ['Tarotry',      8], ['Mathematics',  8], ['Physician',    5],
    ['Herblore',     5], ['Runecraft',    3]
  ],
  merchant: [
    ['Mathematics', 20], ['Folklore',    18], ['Singing',     15],
    ['Drawing',     15], ['Cookery',     12], ['Musician',    12],
    ['Astrology',   10], ['Heraldry',     8], ['Brewing',      8],
    ['Tarotry',      7], ['Fishing',      5], ['Oratory',      5]
  ],
  warrior: [
    ['Singing',     20], ['Folklore',    18], ['Musician',    15],
    ['Cookery',     12], ['Drawing',     10], ['Herblore',    10],
    ['Acrobatics',  10], ['Animalcraft',  8], ['Fishing',      8],
    ['Weatherlore',  8], ['Brewing',      7], ['Riding',       5],
    ['Swimming',     5]
  ],
  soldier: [
    ['Singing',     20], ['Folklore',    18], ['Musician',    15],
    ['Cookery',     12], ['Drawing',     10], ['Herblore',    10],
    ['Acrobatics',  10], ['Animalcraft',  8], ['Fishing',      8],
    ['Weatherlore',  8], ['Brewing',      7], ['Riding',       5],
    ['Swimming',     5]
  ],
  peasant: [
    ['Singing',     25], ['Cookery',     22], ['Weatherlore', 20],
    ['Fishing',     18], ['Herblore',    15], ['Folklore',    15],
    ['Animalcraft', 12], ['Woodcraft',   10], ['Brewing',     10],
    ['Swimming',     8], ['Dancing',      5]
  ],
  artisan: [
    ['Drawing',     20], ['Singing',     18], ['Folklore',    15],
    ['Cookery',     15], ['Musician',    12], ['Herblore',    10],
    ['Mathematics', 10], ['Brewing',     10], ['Woodcraft',    8],
    ['Astrology',    7], ['Animalcraft',  5]
  ],
  clergy: [
    ['Folklore',    22], ['Singing',     20], ['Drawing',     18],
    ['Herblore',    15], ['Astrology',   15], ['Mathematics', 12],
    ['Cookery',     10], ['Physician',    8], ['Musician',     8],
    ['Tarotry',      8], ['Runecraft',    7], ['Animalcraft',  5]
  ]
};

/**
 * Select a hobby skill for an NPC based on social class.
 * Falls back to a cross-class default if class is unknown.
 *
 * @param {string|null} socialClass
 * @returns {string} Skill name from HOBBY_SKILL_DATA
 */
function selectHobbySkill(socialClass) {
  const cls = (socialClass || '').toLowerCase();
  const table = HOBBY_TABLES[cls] || HOBBY_TABLES.peasant;

  const total = table.reduce((sum, [, w]) => sum + w, 0);
  let roll = Math.floor(rand() * total) + 1;
  for (const [skill, weight] of table) {
    roll -= weight;
    if (roll <= 0) return skill;
  }
  return table[table.length - 1][0];
}

/**
 * Generate a hobby skill, spending OPs from the character's budget.
 *
 * OP cost table (Character 16 — each successive improvement costs more):
 *   1st improvement (+SBx1): costs 1 OP  (cumulative: 1)
 *   2nd improvement (+SBx2): costs 2 OP  (cumulative: 3)
 *
 * For starting characters the hobby spend is capped at 2 OP maximum,
 * so the best possible result is +SBx2 (spending all 2 OPs on 2 improvements).
 *
 * Desired spend is rolled first, then capped at min(opBudget, HOBBY_MAX_OPS).
 * If budget is 0, the skill opens at OML with no further investment.
 *
 * @param {string|null} socialClass
 * @param {object}      attributes  - Character attributes
 * @param {string|null} sunsign     - Character's sunsign
 * @param {number}      opBudget    - OPs available to spend (from rollAge)
 * @returns {{
 *   skill: string, sb: number, oml: number, ml: number,
 *   opsSpent: number, sbImprovement: number, opsRemaining: number
 * }}
 */
const HOBBY_MAX_OPS = 2;  // cap for starting characters

function generateHobby(socialClass, attributes, sunsign = null, opBudget = 0) {
  const skillName = selectHobbySkill(socialClass);
  const def       = HOBBY_SKILL_DATA[skillName];

  const sb  = calcSB(def.attrs, attributes, def.sunsigns, sunsign);
  const oml = sb * def.oml;

  // Roll desired spend, then cap at both the budget and the starting-character limit
  // Desired: 1 OP (60%), 2 OP (40%) — only two tiers available within the 2 OP cap
  const available   = Math.min(opBudget, HOBBY_MAX_OPS);
  const desiredRoll = rand();
  let desiredOps    = desiredRoll < 0.60 ? 1 : 2;
  const opsSpent    = Math.min(desiredOps, available);

  // Translate OP spend to SB improvements
  // 0 OP → no improvement; 1 OP → +SBx1; 2 OP → +SBx2 (1 OP + 1 OP second tier... wait)
  // Correction: 2nd improvement costs 2 OP, so 2 total OPs = 1st improv (1 OP) + can't afford 2nd
  // Actually with cap=2: 1 OP → 1 improvement; 2 OP → still only 1 improvement (2nd costs 2, total would be 3)
  // So within a 2 OP budget: max is always 1 improvement (+SBx1)
  //
  // NOTE: The opsSpent >= 3 branch below is intentionally unreachable given HOBBY_MAX_OPS = 2.
  // This function is only used for initial character creation — ongoing hobby investment during
  // aging is handled separately by op-spending.js. If HOBBY_MAX_OPS is ever raised to 3+,
  // the 2nd improvement branch will activate without further code changes.
  let sbImprovement = 0;
  if      (opsSpent >= 3) sbImprovement = 2;  // 1+2 = 3 OP (unreachable at current HOBBY_MAX_OPS=2)
  else if (opsSpent >= 1) sbImprovement = 1;  // 1 OP

  const ml           = oml + (sb * sbImprovement);
  const opsRemaining = opBudget - opsSpent;

  return { skill: skillName, sb, oml, ml, opsSpent, sbImprovement, opsRemaining };
}

/**
 * Format hobby for frontmatter (compact, skill name + ML only).
 * e.g. "Dancing (ML44)"
 */
function formatHobbyFrontmatter(hobby) {
  return `${hobby.skill} (ML${hobby.ml})`;
}

/**
 * Format hobby for body text (full detail).
 * e.g. "**Hobby:** Dancing SB11/OML22 → ML44 (+SBx2, 3 OP)"
 */
function formatHobbyBody(hobby) {
  return `**Hobby:** ${hobby.skill} SB${hobby.sb}/OML${hobby.oml} → ML${hobby.ml} (+SBx${hobby.sbImprovement}, ${hobby.opsSpent} OP)`;
}

// ============================================================================
// PART 9: AGE & OP BUDGET
// ============================================================================

/**
 * Starting age by class (when OP accumulation begins).
 * Nobles and clergy enter their vocation later.
 */
const STARTING_AGES = {
  noble:        16,
  clergy:       16,
  merchant:     14,
  artisan: 14,
  warrior:      14,
  soldier:      14,
  peasant:      14,
  unguilded:    14,
  lia_kavair:   15,
  priest_naveh: 18,  // Newly ordained Dranatha after surviving the Temple Maze trial
  // New guilded classes
  performer:    14,  // Harpers' Hall audition possible at 12; journeyman wandering from ~18
  courtesan:    15,  // Guild entry as teenager; bonded contract typically starts 15-17
  innkeeper:    14,  // Early apprenticeship as chamber/kitchen servant
  miner:        12,  // Miners' children start young; apprentice wage from 12
  mariner:      14,  // Deck boy from early teens
  physician:    16,  // Longer education required; apprenticeship later than craft guilds
  litigant:     16,  // Legal education requires literacy first
  herald:       14,  // Young nobles learn heraldry at 10-13; formal apprenticeship from 14
  arcanist:     16,  // Guild membership discretionary; most begin serious study in mid-teens
};

const OP_ACCRUAL_RATE = 3;  // OPs per year of experience

/**
 * Roll a game-start age (18 or 19) for a starting character,
 * derive total OPs accumulated since starting age, and return both.
 *
 * OPs = (gameStartAge − startingAge) × OP_ACCRUAL_RATE
 *
 * These OPs represent everything the character has spent to reach their
 * current state — occupation skills, hobby, etc. The generator allocates
 * hobby OPs first; the remainder is available for occupation skills.
 *
 * @param {string|null} socialClass
 * @returns {{ age: number, startingAge: number, totalOPs: number }}
 */
function rollAge(socialClass) {
  const cls         = (socialClass || '').toLowerCase();
  const startingAge = STARTING_AGES[cls] || 14;
  const age         = randomBetween(18, 19);
  const totalOPs    = Math.max(0, (age - startingAge) * OP_ACCRUAL_RATE);
  return { age, startingAge, totalOPs };
}

// ============================================================================
// PART 10: MARKDOWN FILE INTEGRATION
// ============================================================================

/**
 * Update the Personality field in markdown frontmatter.
 */
function updatePersonalityField(content, personality) {
  const regex = /^(Personality:\s*).*$/m;
  if (regex.test(content)) {
    return content.replace(regex, `$1${personality}`);
  }
  return content.replace(/^(---\s*\n)([\s\S]*?)(---\s*\n)/, (match, open, body, close) => {
    return `${open}${body}Personality: ${personality}\n${close}`;
  });
}

/**
 * Update the Deity field (public-facing) in markdown frontmatter.
 */
function updateDeityField(content, deity) {
  if (!deity) return content;
  const regex = /^(Deity:\s*).*$/m;
  if (regex.test(content)) {
    return content.replace(regex, `$1${deity}`);
  }
  return content.replace(/^(---\s*\n)([\s\S]*?)(---\s*\n)/, (match, open, body, close) => {
    return `${open}${body}Deity: ${deity}\n${close}`;
  });
}

/**
 * Build the GM-only [!gm] callout block for a secret worshipper.
 *
 * Records:
 *   - The banned deity (with Tashal cell note if applicable)
 *   - The public facade deity
 *   - The raw d200 roll that triggered secret worship
 *
 * @param {string}      secretDeity  - The banned deity name
 * @param {string|null} publicDeity  - The public facade deity
 * @param {number}      roll         - The d200 roll value (always 200)
 * @param {boolean}     tashalCell   - Whether the Tashal Naveh cell override applied
 * @returns {string}                 - Markdown callout block to append to file body
 */
function buildSecretWorshipCallout(secretDeity, publicDeity, roll, tashalCell = false) {
  const facade = publicDeity
    ? `Outwardly presents as a worshipper of ${publicDeity}.`
    : 'Public faith is a facade.';
  const deityLabel = tashalCell ? `${secretDeity} (in Tashal Naveh)` : secretDeity;
  return `\n> [!gm] Secret Worship\n> This character is a secret worshipper of **${deityLabel}**. ${facade}\n> *d200 roll: ${roll}*\n`;
}

/**
 * Generate personality and deity for an NPC and return all data for MCP file update.
 *
 * Return shape:
 * {
 *   filePath:           string,
 *   personality:        string,
 *   publicDeity:        string|null,
 *   secretDeity:        string|null,
 *   isSecretWorshipper: boolean,
 *   secretRoll:         number|null,
 *   tashalCell:         boolean,
 *   secretCallout:      string|null   // GM [!gm] callout block text, if applicable
 * }
 *
 * Claude Code instructions:
 *   1. Read the NPC file via Obsidian MCP
 *   2. updatePersonalityField(content, personality)
 *   3. updateDeityField(content, publicDeity)        — if publicDeity is set
 *   4. Append secretCallout to the file body         — if isSecretWorshipper is true
 *   5. Write updated content back via MCP
 *
 * @param {string}      filePath      - Vault-relative path
 * @param {string|null} socialClass
 * @param {string|null} sex
 * @param {number|null} maxTraitCount
 * @param {string|null} location      - NPC's home location; pass 'Tashal' to activate cell override
 */
async function generateNPCProfile(
  filePath,
  socialClass   = null,
  sex        = null,
  maxTraitCount = null,
  location      = null,
  attributes    = null,
  sunsign       = null
) {
  const personality = generatePersonality(socialClass, sex, maxTraitCount);
  const { publicDeity, secretDeity, isSecretWorshipper, secretRoll, tashalCell } = selectDeity(socialClass, sex, location);

  const attrs = attributes || {
    STR:10, STA:10, DEX:10, AGL:10, EYE:10,
    HRG:10, SML:10, VOI:10, INT:10, AUR:10, WIL:10, CML:10
  };

  const resolvedSunsign = sunsign || rollSunsign();
  const automaticSkills = generateAutomaticSkills(attrs, resolvedSunsign, publicDeity);
  const skillsLine      = formatAutomaticSkills(automaticSkills, true);

  // Age & OP budget — roll age, derive total OPs, spend on hobby first
  const { age, startingAge, totalOPs } = rollAge(socialClass);
  const hobby            = generateHobby(socialClass, attrs, resolvedSunsign, totalOPs);
  const hobbyFrontmatter = formatHobbyFrontmatter(hobby);
  const hobbyBody        = formatHobbyBody(hobby);
  const opsRemaining     = hobby.opsRemaining;

  const secretCallout = isSecretWorshipper
    ? buildSecretWorshipCallout(secretDeity, publicDeity, secretRoll, tashalCell)
    : null;

  console.log(`NPC: ${filePath}`);
  console.log(`  Personality:    ${personality}`);
  console.log(`  Public deity:   ${publicDeity || '(set by order)'}`);
  console.log(`  Sunsign:        ${resolvedSunsign}`);
  console.log(`  Age:            ${age}  (started ${startingAge}, total OPs ${totalOPs}, remaining ${opsRemaining})`);
  console.log(`  Auto skills:    ${skillsLine}`);
  console.log(`  Hobby:          ${hobbyBody}`);
  if (isSecretWorshipper) {
    const label = tashalCell ? `${secretDeity} (in Tashal Naveh)` : secretDeity;
    console.log(`  *** SECRET:     ${label} [d200 roll: ${secretRoll}] ***`);
  }

  return {
    filePath, personality, publicDeity,
    secretDeity, isSecretWorshipper, secretRoll, tashalCell, secretCallout,
    sunsign: resolvedSunsign, automaticSkills, skillsLine,
    age, startingAge, totalOPs, opsRemaining,
    hobby, hobbyFrontmatter, hobbyBody
  };
}

/**
 * Update hobby in both frontmatter and body text.
 *
 * Frontmatter: sets/creates "Hobby:" field with compact form, e.g. "Dancing (ML44)"
 * Body:        appends or replaces a "**Hobby:**" line after the automatic skills block.
 *              If no skills block is found, appends to end of body (before final ---).
 *
 * @param {string} content        - Full markdown file content
 * @param {string} hobbyFrontmatter - e.g. "Dancing (ML44)"
 * @param {string} hobbyBody        - e.g. "**Hobby:** Dancing SB11/OML22 → ML44 (+SBx2, 3 OP)"
 * @returns {string} Updated content
 */
function updateHobbyFields(content, hobbyFrontmatter, hobbyBody) {
  // --- Frontmatter ---
  const fmRegex = /^(Hobby:\s*).*$/m;
  if (fmRegex.test(content)) {
    content = content.replace(fmRegex, `$1${hobbyFrontmatter}`);
  } else {
    content = content.replace(/^(---\s*\n)([\s\S]*?)(---\s*\n)/, (match, open, body, close) => {
      return `${open}${body}Hobby: ${hobbyFrontmatter}\n${close}`;
    });
  }

  // --- Body text ---
  // Replace existing **Hobby:** line if present
  const bodyRegex = /^\*\*Hobby:\*\*.*$/m;
  if (bodyRegex.test(content)) {
    content = content.replace(bodyRegex, hobbyBody);
  } else {
    // Try to insert after the automatic skills line
    const skillsRegex = /(\*\*Automatic Skills\*\*.*)/m;
    if (skillsRegex.test(content)) {
      content = content.replace(skillsRegex, `$1\n${hobbyBody}`);
    } else {
      // Fallback: append before closing frontmatter isn't applicable here,
      // so just append to end of document
      content = content.trimEnd() + `\n\n${hobbyBody}\n`;
    }
  }

  return content;
}

// ============================================================================
// PART 8: EXPORTS
// ============================================================================

module.exports = {
  // Core generators
  generatePersonality,
  selectDeity,
  rollSecretWorship,
  generateNPCProfile,

  // Age & OP budget
  rollAge,

  // Automatic skills
  generateAutomaticSkills,
  formatAutomaticSkills,
  rollSunsign,

  // Hobby skills
  generateHobby,
  selectHobbySkill,
  formatHobbyFrontmatter,
  formatHobbyBody,

  // Field updaters (for use when MCP provides file content)
  updatePersonalityField,
  updateDeityField,
  updateHobbyFields,
  buildSecretWorshipCallout,

  // Exposed internals (for testing/extension)
  generateAttribute,
  generateOCEANScores,
  calcSB,
  rollAge,
  OCEAN_FRAMEWORK,
  DEITY_TABLES,
  BANNED_DEITY_TABLES,
  AUTOMATIC_SKILLS,
  RITUAL_SKILL_BASES,
  HOBBY_SKILL_DATA,
  HOBBY_TABLES,
  STARTING_AGES,
  SUNSIGNS
};

// ============================================================================
// QUICK-TEST (runs if executed directly: node npc-generator.js)
// ============================================================================

if (require.main === module) {
  console.log('=== Kaldor NPC Generator — Quick Test ===\n');

  // --- Sample NPC generation (non-Tashal) ---
  const testCases = [
    { label: 'Noble male',        class: 'noble',        sex: 'male',   location: null     },
    { label: 'Noble female',      class: 'noble',        sex: 'female', location: null     },
    { label: 'Merchant',          class: 'merchant',     sex: null,     location: null     },
    { label: 'Soldier male',      class: 'soldier',      sex: 'male',   location: null     },
    { label: 'Peasant female',    class: 'peasant',      sex: 'female', location: null     },
    { label: 'Craftsperson',      class: 'artisan', sex: null,     location: null     },
    { label: 'Clergy',            class: 'clergy',       sex: 'female', location: null     },
    { label: 'Merchant (Tashal)', class: 'merchant',     sex: 'male',   location: 'Tashal' },
    { label: 'Clergy (Tashal)',   class: 'clergy',       sex: null,     location: 'Tashal' }
  ];

  for (const tc of testCases) {
    const personality = generatePersonality(tc.class, tc.sex);
    const { publicDeity, secretDeity, isSecretWorshipper, secretRoll, tashalCell } =
      selectDeity(tc.class, tc.sex, tc.location);
    console.log(`${tc.label.padEnd(22)} | ${personality}`);
    console.log(`${''.padEnd(22)} | Public deity:  ${publicDeity || '(set by order)'}`);
    if (isSecretWorshipper) {
      const label = tashalCell ? `${secretDeity} (in Tashal Naveh)` : secretDeity;
      console.log(`${''.padEnd(22)} | *** SECRET:    ${label} [d200 roll: ${secretRoll}] ***`);
    }
    console.log();
  }

  // --- Noble deity distribution (n=1000) ---
  console.log('--- Noble public deity distribution (n=1000) ---');
  const maleCount   = { Larani: 0, Ilvir: 0, Peoni: 0 };
  const femaleCount = { Larani: 0, Ilvir: 0, Peoni: 0 };
  for (let i = 0; i < 1000; i++) {
    const { publicDeity: md } = selectDeity('noble', 'male');
    if (md && maleCount[md]   !== undefined) maleCount[md]++;
    const { publicDeity: fd } = selectDeity('noble', 'female');
    if (fd && femaleCount[fd] !== undefined) femaleCount[fd]++;
  }
  console.log('Male nobles:  ', maleCount);
  console.log('Female nobles:', femaleCount);

  // --- Secret worship: normal distribution (n=10000 per class) ---
  console.log('\n--- Secret worship rate & distribution, non-Tashal (n=10000 per class) ---');
  const classes = ['noble', 'merchant', 'warrior', 'peasant', 'artisan', 'clergy'];
  for (const cls of classes) {
    let secretCount = 0;
    const banned = { Agrik: 0, Naveh: 0, Morgath: 0 };
    for (let i = 0; i < 10000; i++) {
      const result = rollSecretWorship(cls, null);
      if (result) { secretCount++; banned[result.secretDeity]++; }
    }
    const pct = (secretCount / 100).toFixed(1);
    console.log(`${cls.padEnd(14)} | ${pct}% secret  | ${JSON.stringify(banned)}`);
  }

  // --- Tashal override distribution (n=10000 per class) ---
  console.log('\n--- Secret worship in Tashal (n=10000 per class) ---');
  for (const cls of classes) {
    let secretCount = 0;
    const banned = { Agrik: 0, Naveh: 0, Morgath: 0 };
    let tashalCount = 0;
    for (let i = 0; i < 10000; i++) {
      const result = rollSecretWorship(cls, 'Tashal');
      if (result) {
        secretCount++;
        banned[result.secretDeity]++;
        if (result.tashalCell) tashalCount++;
      }
    }
    const pct = (secretCount / 100).toFixed(1);
    console.log(`${cls.padEnd(14)} | ${pct}% secret  | ${JSON.stringify(banned)}  (Tashal cell: ${tashalCount})`);
  }

  // --- Automatic skills sample ---
  console.log('\n--- Automatic skills sample (typical Kaldor knight, sunsign Hirin) ---');
  const knightAttrs = { STR:14, STA:13, DEX:12, AGL:13, EYE:11, HRG:10, SML:9, VOI:11, INT:12, AUR:10, WIL:14, CML:11 };
  const knightSkills = generateAutomaticSkills(knightAttrs, 'Hirin', 'Larani');
  console.log(formatAutomaticSkills(knightSkills, false));

  console.log('\n--- Automatic skills sample (peasant farmer, average attributes, sunsign Ulandus) ---');
  const peasantAttrs = { STR:11, STA:12, DEX:10, AGL:10, EYE:10, HRG:10, SML:10, VOI:9, INT:9, AUR:8, WIL:10, CML:9 };
  const peasantSkills = generateAutomaticSkills(peasantAttrs, 'Ulandus', 'Peoni');
  console.log(formatAutomaticSkills(peasantSkills, false));

  // --- Hobby skill samples with age/OP budget ---
  console.log('\n--- Hobby skill samples with age & OP budget (10 NPCs per class) ---');
  const allClasses = ['noble','merchant','warrior','soldier','peasant','artisan','clergy'];
  for (const cls of allClasses) {
    const attrs = { STR:11, STA:11, DEX:11, AGL:11, EYE:11, HRG:11, SML:11, VOI:11, INT:11, AUR:11, WIL:11, CML:11 };
    console.log(`\n${cls.toUpperCase()}`);
    for (let i = 0; i < 10; i++) {
      const { age, startingAge, totalOPs } = rollAge(cls);
      const h = generateHobby(cls, attrs, 'Tarael', totalOPs);
      console.log(`  age ${age} (start ${startingAge}, ${totalOPs} OPs total, ${h.opsSpent} spent, ${h.opsRemaining} remaining)  ${formatHobbyBody(h)}`);
    }
  }

  // --- Hobby distribution check (n=1000 per class) ---
  console.log('\n--- Hobby distribution (n=1000 per class, top 5 skills) ---');
  for (const cls of allClasses) {
    const counts = {};
    for (let i = 0; i < 1000; i++) {
      const skill = selectHobbySkill(cls);
      counts[skill] = (counts[skill] || 0) + 1;
    }
    const top5 = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k, v]) => `${k}:${v}`)
      .join('  ');
    console.log(`${cls.padEnd(14)} | ${top5}`);
  }
}
