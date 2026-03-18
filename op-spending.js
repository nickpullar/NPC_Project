'use strict';

/**
 * op-spending.js
 *
 * Year-by-year OP allocation for veteran NPC generation.
 *
 * PHILOSOPHY
 * ----------
 * Every year the character has free OPs available (banked + newly earned),
 * they decide whether to invest now or save. The decision is driven by:
 *
 *   1. CRISIS BLOCK     — exiled/outlawed/ruined/captured → survival only,
 *                         no hobby spending, possibly no spending at all
 *   2. LIVELIHOOD       — class-based core skills the character needs to
 *                         function and earn. Highest priority always.
 *   3. EVENT BOOSTS     — recent events temporarily elevate certain skills
 *                         (military_campaign → Initiative; famine → Survival)
 *   4. HOBBY            — spent only when bank has surplus after livelihood
 *                         need is covered AND no crisis/major-negative year
 *   5. BANK             — if nothing affordable or conditions wrong, save
 *
 * OP COST SCHEDULE (HârnMaster CHARACTER 19)
 * -------------------------------------------
 *   Each successive SB improvement doubles the cost:
 *   1st +SBx1 = 1 OP     (cumulative: 1)
 *   2nd +SBx1 = 2 OP     (cumulative: 3)
 *   3rd +SBx1 = 4 OP     (cumulative: 7)
 *   4th +SBx1 = 8 OP     (cumulative: 15)
 *   5th +SBx1 = 16 OP    (cumulative: 31)
 *
 * SKILL REGISTRY
 * --------------
 * Tracks open skills and their current SB-improvement count (not ML).
 * Initialised from occupation skills at simulation start.
 * A skill's improvement count determines the cost of the NEXT improvement.
 *
 * EXPORTED API
 * ------------
 *   createOPSpender(socialClass, hobbySkill, occupationSkills)
 *     → returns a spender object with:
 *       .processYear(freeOPs, conditions, recentEvents, yearIsMajorNegative)
 *         → { spent, skillInvestments: [{skill, ops}], banked, bankTotal }
 *       .getSkillRegistry()  → current skill improvement counts
 *       .getBankTotal()      → current unspent OP bank
 *       .getSummary()        → lifetime allocation summary
 */

// ─────────────────────────────────────────────────────────────────────────────
// OP COST HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cost in OPs of the NEXT single improvement on a skill that has already
 * received `currentImprovements` improvements.
 * 0 improvements → costs 1 OP, 1 → 2 OP, 2 → 4 OP, 3 → 8 OP, ...
 */
function nextImprovementCost(currentImprovements) {
  return Math.pow(2, currentImprovements);
}

/**
 * Cumulative cost to reach targetLevel improvements from zero.
 * nextImprovementCost(0) + … + nextImprovementCost(targetLevel-1)
 * = 2^targetLevel - 1
 */
function cumulativeCost(targetLevel) {
  if (targetLevel <= 0) return 0;
  return Math.pow(2, targetLevel) - 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// CRISIS CONDITIONS
// ─────────────────────────────────────────────────────────────────────────────

const CRISIS_CONDITIONS = new Set([
  'outlawed', 'exiled', 'captured', 'ruined', 'deserter',
  'chronic_illness', 'branded', 'criminal_record', 'landless',
]);

// Conditions that are bad but not fully blocking — hobby is suppressed
// but livelihood spending can proceed
const HARDSHIP_CONDITIONS = new Set([
  'disgraced', 'indebted', 'faith_crisis', 'lame', 'accused',
]);

function isCrisis(conditions) {
  return conditions.some(c => CRISIS_CONDITIONS.has(c));
}

function isHardship(conditions) {
  return conditions.some(c => HARDSHIP_CONDITIONS.has(c));
}

// ─────────────────────────────────────────────────────────────────────────────
// LIVELIHOOD SKILL PRIORITIES BY CLASS
// ─────────────────────────────────────────────────────────────────────────────
// Each entry is a list of skill names in descending priority.
// The spender works down this list looking for the first skill it can improve.
// Skills listed here must match the automatic or occupation skill names used
// in npc-generator.js / AUTOMATIC_SKILLS.
//
// NOTE: These are the skills a character would consciously invest in to improve
// their standing and income. Automatic skills (INITIATIVE etc.) are uppercased
// to match the registry keys.

const LIVELIHOOD_PRIORITIES = {
  noble: [
    'INTRIGUE', 'RHETORIC', 'Riding', 'Heraldry', 'ORATORY',
    'INITIATIVE', 'Law', 'Drawing',
  ],
  merchant: [
    'RHETORIC', 'INTRIGUE', 'Mathematics', 'AWARENESS',
    'Law', 'ORATORY', 'Seamanship',
  ],
  warrior: [
    'INITIATIVE', 'Sword', 'Mace', 'Axe', 'Spear', 'Dagger',
    'Shield', 'CONDITION', 'AWARENESS', 'Riding',
  ],
  soldier: [
    'INITIATIVE', 'Spear', 'Sword', 'Club', 'Dagger',
    'Shield', 'CONDITION', 'AWARENESS',
  ],
  peasant: [
    'Agriculture', 'CONDITION', 'Weatherlore', 'Animalcraft',
    'Survival', 'Herblore', 'Fishing',
  ],
  artisan: [
    // Primary craft skill is registered dynamically from occupation skills.
    // We use a sentinel '__primaryCraft' which the spender resolves at runtime.
    '__primaryCraft',
    'Metalcraft', 'Woodcraft', 'Drawing', 'RHETORIC',
  ],
  clergy: [
    'RITUAL', 'RHETORIC', 'ORATORY', 'INTRIGUE',
    'Folklore', 'Physician', 'Herblore',
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// EVENT BOOST TABLE
// ─────────────────────────────────────────────────────────────────────────────
// Maps event IDs to a list of { skill, priority } boosts.
// Boosts last EVENT_BOOST_DURATION years, inserted at the front of the
// livelihood priority list (above class defaults) for the duration.

const EVENT_BOOSTS = {
  military_campaign:       [{ skill: 'INITIATIVE', priority: 1 }, { skill: 'Sword', priority: 2 }, { skill: 'Spear', priority: 3 }],
  war_wound:               [{ skill: 'CONDITION',  priority: 1 }],
  serious_wound:           [{ skill: 'CONDITION',  priority: 1 }],
  survived_famine:         [{ skill: 'Survival',   priority: 1 }, { skill: 'Herblore', priority: 2 }],
  bad_harvest:             [{ skill: 'Agriculture',priority: 1 }, { skill: 'Weatherlore', priority: 2 }],
  serious_illness:         [{ skill: 'Physician',  priority: 1 }, { skill: 'Herblore', priority: 2 }],
  old_injury_worsens:      [{ skill: 'Physician',  priority: 1 }],
  declining_health:        [{ skill: 'CONDITION',  priority: 1 }, { skill: 'Physician', priority: 2 }],
  pilgrimage:              [{ skill: 'RITUAL',     priority: 1 }, { skill: 'Folklore', priority: 2 }],
  theological_study:       [{ skill: 'RITUAL',     priority: 1 }, { skill: 'Folklore', priority: 2 }],
  successful_trade_venture:[{ skill: 'Mathematics',priority: 1 }, { skill: 'RHETORIC', priority: 2 }],
  long_distance_trade:     [{ skill: 'AWARENESS',  priority: 1 }, { skill: 'INTRIGUE', priority: 2 }],
  masterwork_created:      [{ skill: '__primaryCraft', priority: 1 }],
  established_workshop:    [{ skill: '__primaryCraft', priority: 1 }, { skill: 'RHETORIC', priority: 2 }],
  guild_advancement:       [{ skill: '__primaryCraft', priority: 1 }],
  political_intrigue:      [{ skill: 'INTRIGUE',   priority: 1 }, { skill: 'RHETORIC', priority: 2 }],
  court_appointment:       [{ skill: 'INTRIGUE',   priority: 1 }, { skill: 'ORATORY',  priority: 2 }],
  estate_management:       [{ skill: 'Law',        priority: 1 }, { skill: 'RHETORIC', priority: 2 }],
  military_promotion:      [{ skill: 'ORATORY',    priority: 1 }, { skill: 'INITIATIVE', priority: 2 }],
  promoted_sergeant:       [{ skill: 'ORATORY',    priority: 1 }, { skill: 'INITIATIVE', priority: 2 }],
  knighted:                [{ skill: 'INITIATIVE', priority: 1 }, { skill: 'Riding',   priority: 2 }],
  captured_prisoner:       [{ skill: 'CONDITION',  priority: 1 }],
  feud_involvement:        [{ skill: 'INITIATIVE', priority: 1 }, { skill: 'Dagger',   priority: 2 }],
  journey_abroad:          [{ skill: 'AWARENESS',  priority: 1 }, { skill: 'INTRIGUE', priority: 2 }],
  made_useful_contact:     [{ skill: 'INTRIGUE',   priority: 1 }],
  reputation_restored:     [{ skill: 'RHETORIC',   priority: 1 }],
};

const EVENT_BOOST_DURATION = 3; // years a boost remains active

// ─────────────────────────────────────────────────────────────────────────────
// CRAFT SKILL DETECTION
// ─────────────────────────────────────────────────────────────────────────────
// Craft skills that could be a artisan's primary occupation skill.
// Used to resolve '__primaryCraft' sentinel.

const CRAFT_SKILLS = new Set([
  'Metalcraft', 'Weaponcraft', 'Woodcraft', 'Textilecraft', 'Hidework',
  'Masonry', 'Glassworking', 'Jewelcraft', 'Ceramics', 'Alchemy',
  'Brewing', 'Cookery', 'Shipwright', 'Timbercraft', 'Lockcraft',
  'Herblore', 'Embalming', 'Perfumery', 'Mining', 'Milling',
]);

// ─────────────────────────────────────────────────────────────────────────────
// MAJOR NEGATIVE EVENTS
// ─────────────────────────────────────────────────────────────────────────────
// Events that suppress hobby spending this year AND next year.

// NOTE: Keep in sync with isMajor:true events in life-events.js. These two sets
// serve different purposes: isMajor flags narrative significance, while
// MAJOR_NEGATIVE_EVENTS controls OP hobby-spending suppression. The sets overlap
// but differ (e.g. family grief events like spouse_dies are here but not isMajor).
// When adding new life events, check both lists.
const MAJOR_NEGATIVE_EVENTS = new Set([
  'serious_illness', 'significant_injury', 'war_wound', 'serious_wound',
  'captured_prisoner', 'noble_exile', 'financial_ruin', 'workshop_fire',
  'fire_or_flood', 'outlawed', 'convicted_of_crime', 'deserted',
  'clergy_scandal', 'bad_harvest', 'survived_famine', 'bad_trade_venture',
  'branded_or_mutilated', 'old_injury_worsens', 'declining_health',
  'death_of_parent', 'spouse_dies', 'spouse_dies_childbirth', 'child_dies',
  'miscarriage', 'stillbirth', 'disabled_child_born',
]);

// ─────────────────────────────────────────────────────────────────────────────
// SKILL IMPROVEMENT CAP
// ─────────────────────────────────────────────────────────────────────────────
// Maximum SB improvements the spender will apply to any single skill via OPs.
// Prevents one skill absorbing all OPs as costs double into unreachable territory.
// A character can certainly reach SBx7 (4 improvements) on their best skill
// in 20 years, but SBx9+ is unrealistic for a 35-year-old NPC.
const MAX_SKILL_IMPROVEMENTS = 4;

// ─────────────────────────────────────────────────────────────────────────────
// SKILL NAME NORMALISATION
// ─────────────────────────────────────────────────────────────────────────────
// Automatic skills are stored UPPERCASE in the registry. Hobby skills from
// HOBBY_SKILL_DATA use Title Case. We normalise hobby skills that overlap with
// automatic skills so they resolve to the same registry key.
const AUTOMATIC_SKILL_NAMES = new Set([
  'INITIATIVE','CONDITION','AWARENESS','INTRIGUE','RHETORIC',
  'ORATORY','UNARMED','CLIMBING','JUMPING','STEALTH','THROWING','SINGING',
]);

function normaliseSkillName(skill) {
  if (!skill) return skill;
  const upper = skill.toUpperCase();
  if (AUTOMATIC_SKILL_NAMES.has(upper)) return upper;
  return skill;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN FACTORY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create an OP spender for a character.
 *
 * @param {string}   socialClass       - 'noble' | 'merchant' | 'warrior' | etc.
 * @param {string}   hobbySkill        - Skill name from HOBBY_SKILL_DATA
 * @param {string[]} occupationSkills  - Skill names the character starts with
 *                                       (used to seed the registry and identify
 *                                       primary craft skill)
 * @returns {object} Spender with processYear(), getSkillRegistry(),
 *                   getBankTotal(), getSummary()
 */
function createOPSpender(socialClass, hobbySkill, occupationSkills = [], initialImprovements = {}) {
  const cls            = (socialClass || 'peasant').toLowerCase();
  const basePriorities = LIVELIHOOD_PRIORITIES[cls] || LIVELIHOOD_PRIORITIES.peasant;
  const normHobby      = normaliseSkillName(hobbySkill);

  // ── Skill registry ──────────────────────────────────────────────────────
  // Maps normalised skill name → number of SB improvements applied via OP spending.
  // Seeded with occupation skills at 0 improvements, then overwritten with any
  // saved improvement counts from a checkpoint (initialImprovements). This ensures
  // the cost tiers are correct on a resume — e.g. a skill at improvement 3 costs
  // 8 OP for its next improvement, not 1 OP.
  const skillRegistry = {};
  for (const sk of occupationSkills) {
    skillRegistry[normaliseSkillName(sk)] = 0;
  }
  // Automatic skills always open
  for (const sk of AUTOMATIC_SKILL_NAMES) {
    if (skillRegistry[sk] === undefined) skillRegistry[sk] = 0;
  }
  if (normHobby && skillRegistry[normHobby] === undefined) {
    skillRegistry[normHobby] = 0;
  }
  // Apply saved improvement counts from checkpoint (overrides the 0 defaults)
  for (const [sk, count] of Object.entries(initialImprovements)) {
    const norm = normaliseSkillName(sk);
    if (skillRegistry[norm] !== undefined) {
      skillRegistry[norm] = Math.min(count, MAX_SKILL_IMPROVEMENTS);
    }
  }

  // Identify primary craft skill for artisan sentinel
  const primaryCraft = (() => {
    if (cls !== 'artisan') return null;
    for (const sk of occupationSkills) {
      if (CRAFT_SKILLS.has(sk)) return sk;
    }
    return occupationSkills[0] || null;
  })();

  function resolveSentinel(skill) {
    const resolved = skill === '__primaryCraft' ? (primaryCraft || 'Woodcraft') : skill;
    return normaliseSkillName(resolved);
  }

  // ── OP bank ─────────────────────────────────────────────────────────────
  let bank = 0;

  // ── Active event boosts ──────────────────────────────────────────────────
  // Array of { skill, priority, yearsLeft }
  const activeBoosts = [];

  // ── Suppression tracking ─────────────────────────────────────────────────
  let hobbySupressedNextYear = false;

  // ── Lifetime summary ────────────────────────────────────────────────────
  let totalSpent   = 0;
  let totalBanked  = 0;
  let hobbySpent   = 0;
  const skillTotals = {};  // skill → total ops invested

  // ── Helpers ─────────────────────────────────────────────────────────────

  function canImprove(skill) {
    const resolved = resolveSentinel(skill);
    if (skillRegistry[resolved] === undefined) return false; // skill not open
    if ((skillRegistry[resolved] ?? 0) >= MAX_SKILL_IMPROVEMENTS) return false; // capped
    return true;
  }

  function costToImprove(skill) {
    const resolved = resolveSentinel(skill);
    const current  = skillRegistry[resolved] ?? 0;
    return nextImprovementCost(current);
  }

  function applyImprovement(skill, opsToSpend) {
    const resolved = resolveSentinel(skill);
    let remaining  = opsToSpend;
    const investments = [];

    while (remaining > 0) {
      const cost = nextImprovementCost(skillRegistry[resolved] ?? 0);
      if (remaining < cost) break;
      skillRegistry[resolved] = (skillRegistry[resolved] ?? 0) + 1;
      remaining -= cost;
      investments.push({ skill: resolved, ops: cost });
      totalSpent += cost;
      skillTotals[resolved] = (skillTotals[resolved] || 0) + cost;
    }
    return { investments, remainder: remaining };
  }

  // Build the effective priority list for this year:
  // active boosts (sorted by priority) + base class priorities,
  // deduplicating so a skill doesn't appear twice.
  function buildEffectivePriorities() {
    const boosted = [...activeBoosts]
      .sort((a, b) => a.priority - b.priority)
      .map(b => resolveSentinel(b.skill));

    const result = [...boosted];
    for (const sk of basePriorities) {
      const resolved = resolveSentinel(sk);
      if (!result.includes(resolved)) result.push(resolved);
    }
    return result;
  }

  // ── Tiered spending constants ────────────────────────────────────────────
  // How many top-priority skills are included in the "raise the floor" pass.
  // These are the skills the character wants to be competent at before
  // deepening into their single best skill.
  const FLOOR_SKILL_COUNT = 3;

  // Minimum improvements every floor skill should reach before the character
  // starts deepening. SBx2 improvements = opened skill → SBx(oml+2), which is
  // the difference between "dabbling" and "usable".
  const MIN_FLOOR_LEVEL = 2;

  // ── Main per-year processor ──────────────────────────────────────────────

  /**
   * Process one year of OP spending.
   *
   * Decision sequence each year:
   *   0. Bank incoming free OPs.
   *   1. Crisis block → minimal survival spending only, return early.
   *   2. PASS 1 — Raise the floor: find the highest-priority floor skill still
   *      below MIN_FLOOR_LEVEL. Save toward it and spend when affordable.
   *      This ensures the character becomes broadly competent before specialising.
   *   3. PASS 2 — Deepen: once all floor skills meet MIN_FLOOR_LEVEL, work down
   *      the full priority list, saving toward each in turn up to MAX_SKILL_IMPROVEMENTS.
   *   4. Hobby: spend only if no crisis/hardship/bad year AND bank has surplus
   *      after this year's livelihood investment was made.
   *
   * @param {number}   freeOPs               - OPs earned this year (free/unallocated)
   * @param {string[]} conditions            - Character's conditions at year end
   * @param {string[]} recentEvents          - Event IDs that fired this year
   * @param {boolean}  yearHasMajorNegative  - Whether a major negative event fired
   * @returns {{ spent, skillInvestments, banked, bankTotal }}
   */
  function processYear(freeOPs, conditions, recentEvents, yearHasMajorNegative) {
    // Tick down existing boosts, then register new ones
    for (const boost of activeBoosts) boost.yearsLeft--;
    activeBoosts.splice(0, activeBoosts.length,
      ...activeBoosts.filter(b => b.yearsLeft > 0));

    for (const evId of recentEvents) {
      const boostDefs = EVENT_BOOSTS[evId];
      if (!boostDefs) continue;
      for (const def of boostDefs) {
        const existing = activeBoosts.find(b => resolveSentinel(b.skill) === resolveSentinel(def.skill));
        if (existing) {
          existing.yearsLeft = Math.max(existing.yearsLeft, EVENT_BOOST_DURATION);
        } else {
          activeBoosts.push({ skill: def.skill, priority: def.priority, yearsLeft: EVENT_BOOST_DURATION });
        }
      }
    }

    // Bank incoming OPs
    bank += freeOPs;
    totalBanked += freeOPs;

    const inCrisis     = isCrisis(conditions);
    const inHardship   = isHardship(conditions);
    const hobbyBlocked = inCrisis || inHardship || yearHasMajorNegative || hobbySupressedNextYear;
    hobbySupressedNextYear = yearHasMajorNegative;

    const skillInvestments = [];

    // ── CRISIS: one survival skill only ───────────────────────────────────
    if (inCrisis) {
      for (const sk of ['CONDITION', 'Survival', 'Herblore', 'AWARENESS']) {
        if (!canImprove(sk)) continue;
        const cost = costToImprove(sk);
        if (bank >= cost) {
          skillInvestments.push(...applyImprovement(sk, cost).investments);
          bank -= cost;
          break;
        }
      }
      return { spent: totalOpsThisCall(skillInvestments), skillInvestments, banked: freeOPs, bankTotal: bank };
    }

    // ── Build priority list (boosts first, then class defaults) ───────────
    const priorities = buildEffectivePriorities();
    // Floor skills are the first FLOOR_SKILL_COUNT improvable skills in the list
    const floorSkills = priorities.filter(sk => canImprove(sk) ||
      (skillRegistry[sk] !== undefined && skillRegistry[sk] < MIN_FLOOR_LEVEL)
    ).slice(0, FLOOR_SKILL_COUNT);

    // ── PASS 1: Raise the floor ────────────────────────────────────────────
    // Find the highest-priority floor skill still below MIN_FLOOR_LEVEL.
    // Save toward it; spend when affordable. One investment per year.
    let madeInvestment = false;

    const floorTarget = floorSkills.find(sk =>
      skillRegistry[sk] !== undefined && skillRegistry[sk] < MIN_FLOOR_LEVEL
    );

    if (floorTarget) {
      const cost = costToImprove(floorTarget);
      if (bank >= cost) {
        skillInvestments.push(...applyImprovement(floorTarget, cost).investments);
        bank -= cost;
        madeInvestment = true;
      }
      // If unaffordable, save toward it — don't spend on anything else this pass.
      // Exception: cost is > 4 OPs (i.e. already beyond SBx2), which shouldn't
      // happen for a floor skill, but guard anyway.
    }

    // ── PASS 2: Deepen ────────────────────────────────────────────────────
    // Only if all floor skills have met MIN_FLOOR_LEVEL (or we already spent).
    // Work down the full priority list, saving toward each skill in turn.
    if (!madeInvestment) {
      // Allow a second investment if bank is flush (3+ years accumulated)
      const maxInvestments = bank >= 9 ? 2 : 1;
      let deepenCount = 0;

      for (const sk of priorities) {
        if (deepenCount >= maxInvestments) break;
        if (!canImprove(sk)) continue;

        const cost = costToImprove(sk);
        if (bank >= cost) {
          skillInvestments.push(...applyImprovement(sk, cost).investments);
          bank -= cost;
          deepenCount++;
          madeInvestment = true;
        } else if (deepenCount === 0) {
          // Saving toward the top improvable skill — don't fall to cheaper ones
          break;
        }
      }
    }

    // ── HOBBY ─────────────────────────────────────────────────────────────
    // Fire only when:
    //   • not blocked (no crisis/hardship/bad year)
    //   • an investment was made this year (livelihood satisfied) OR all
    //     livelihood skills are capped/unimprovable
    //   • bank still has enough for the hobby after the year's spending
    const allLivelihoodCapped = priorities.every(sk => !canImprove(sk));

    if (!hobbyBlocked && normHobby && canImprove(normHobby)
        && (madeInvestment || allLivelihoodCapped)) {
      const hobbyCost = costToImprove(normHobby);
      if (bank >= hobbyCost) {
        skillInvestments.push(...applyImprovement(normHobby, hobbyCost).investments);
        bank -= hobbyCost;
        hobbySpent += hobbyCost;
      }
    }

    const spent = totalOpsThisCall(skillInvestments);
    return { spent, skillInvestments, banked: freeOPs, bankTotal: bank };
  }

  function totalOpsThisCall(investments) {
    return investments.reduce((s, i) => s + i.ops, 0);
  }

  // ── Public API ───────────────────────────────────────────────────────────

  function getSkillRegistry() {
    return { ...skillRegistry };
  }

  function getBankTotal() {
    return bank;
  }

  function getSummary() {
    const topSkills = Object.entries(skillTotals)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 8)
      .map(([sk, ops]) => `${sk} ×${ops}`);

    return {
      totalOPsProcessed: totalBanked,
      totalOPsSpent:     totalSpent,
      totalOPsBanked:    bank,          // unspent remainder
      hobbyOPsSpent:     hobbySpent,
      topSkillsByOPs:    topSkills,
      skillTotals:       { ...skillTotals },
    };
  }

  return { processYear, getSkillRegistry, getBankTotal, getSummary };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  createOPSpender,
  nextImprovementCost,
  cumulativeCost,
  CRISIS_CONDITIONS,
  HARDSHIP_CONDITIONS,
  MAJOR_NEGATIVE_EVENTS,
  EVENT_BOOSTS,
  LIVELIHOOD_PRIORITIES,
  MAX_SKILL_IMPROVEMENTS,
  normaliseSkillName,
};
