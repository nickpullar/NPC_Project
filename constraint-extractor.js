'use strict';

/**
 * constraint-extractor.js
 *
 * Schema definition, validation, and normalisation for NPC generation constraints.
 *
 * Claude Code is the semantic parser — it reads the free-text description and
 * constructs a raw constraint object. This module validates and normalises that
 * object before passing it to generate-from-description.js.
 *
 * CLAUDE CODE USAGE
 * -----------------
 * When called from Claude Code with a description, Claude Code should:
 *
 *   1. Read the description and build a raw constraint object (see schema below).
 *   2. Call: const constraints = normaliseConstraints(rawObject)
 *   3. Optionally print: console.log(summariseConstraints(constraints))
 *   4. Call: const result = await generateFromDescription(constraints)
 *
 * CONSTRAINT SCHEMA
 * -----------------
 * {
 *   // Core identity — all optional; null means "simulate freely"
 *   socialClass:      'noble'|'merchant'|'warrior'|'soldier'|'peasant'|'craftsperson'|'clergy'|null
 *   sex:           'male'|'female'|null
 *   targetAge:        number|null
 *   occupation:       string|null     // free-text label, e.g. 'guilded_innkeeper'
 *   hobbySkill:       string|null     // e.g. 'Brewing', 'Astrology'
 *   occupationSkills: string[]        // skills the occupation provides
 *
 *   // Family — hard-pinned if set
 *   maritalStatus:  'married'|'widowed'|'single'|null
 *   childrenAlive:  number|null       // exact count of living children
 *   childrenTotal:  number|null       // total ever born (>= childrenAlive)
 *
 *   // Conditions present at END of simulation
 *   requiredConditions:  string[]     // must be in char.conditions at end
 *   forbiddenConditions: string[]     // must NOT be in char.conditions
 *
 *   // Life events that must appear somewhere in the history
 *   requiredEvents: string[]          // event IDs from life-events.js
 *
 *   // Explicit attribute values
 *   attributes: { STR?, STA?, DEX?, AGL?, EYE?, HRG?, SML?, VOI?, INT?, AUR?, WIL?, CML? }
 *
 *   // Notes Claude Code couldn't map to a specific constraint
 *   unmappedNotes: string[]
 * }
 *
 * MAPPING GUIDE FOR CLAUDE CODE
 * ------------------------------
 * "two children" / "has two kids"         → childrenAlive: 2
 * "three children, one died"              → childrenAlive: 2, childrenTotal: 3
 * "widowed" / "husband died"              → maritalStatus: 'widowed'
 * "married"                               → maritalStatus: 'married'
 * "never married" / "single"              → maritalStatus: 'single'
 * "lame" / "bad leg" / "walks with limp"  → requiredConditions: ['lame']
 * "scarred"                               → requiredConditions: ['scarred']
 * "guild master" / "master craftsman"     → requiredConditions: ['guild_master']
 * "guild member"                          → requiredConditions: ['guild_member']
 * "served in army" / "was a soldier"      → requiredEvents: ['military_campaign']
 * "went on pilgrimage"                    → requiredEvents: ['pilgrimage']
 * "knighted"                              → requiredConditions: ['knighted'], requiredEvents: ['knighted']
 * "exiled" / "banished"                   → requiredConditions: ['exiled'], requiredEvents: ['noble_exile']
 * "outlaw" / "outlawed"                   → requiredConditions: ['outlawed']
 * "devout" / "deeply religious"           → requiredConditions: ['devout']
 * "prosperous" / "wealthy"                → requiredConditions: ['prosperous']
 * "in debt" / "heavily indebted"          → requiredConditions: ['indebted']
 * "branded" / "mutilated as punishment"   → requiredConditions: ['branded']
 * "criminal record"                       → requiredConditions: ['criminal_record']
 * "survived a famine"                     → requiredEvents: ['survived_famine']
 * "war wound" / "wounded in battle"       → requiredEvents: ['war_wound']
 * "captured" / "taken prisoner"           → requiredConditions: ['captured'], requiredEvents: ['captured_prisoner']
 * "orphaned"                              → requiredConditions: ['orphaned']
 * "tavern owner" / "innkeeper"            → occupation: 'guilded_innkeeper', socialClass: 'craftsperson'
 * "STR 14" / "very strong (STR 14)"       → attributes: { STR: 14 }
 * "veteran soldier"                       → requiredConditions: ['veteran']
 */

// ─────────────────────────────────────────────────────────────────────────────
// VALID VALUE SETS
// ─────────────────────────────────────────────────────────────────────────────

const VALID_SOCIAL_CLASSES = new Set([
  'noble','merchant','warrior','soldier','peasant','craftsperson','clergy',
]);

const VALID_MARITAL_STATUSES = new Set(['married','widowed','single']);

const VALID_CONDITIONS = new Set([
  'knighted','enfeoffed','guild_member','guild_master','veteran','sergeant',
  'outlawed','exiled','branded','criminal_record','disgraced','ruined',
  'lame','scarred','chronic_illness','orphaned','devout','prosperous',
  'indebted','landless','captured','pilgrim','married','widowed',
  'has_children','robust','faith_crisis','rh_negative','accused',
]);

const VALID_PINNABLE_EVENTS = new Set([
  // Military
  'military_campaign','war_wound','serious_wound','captured_prisoner',
  'promoted_sergeant','commendation_received','plunder_windfall','deserted',
  // Religious
  'pilgrimage','religious_devotion','faith_crisis','clergy_scandal',
  // Noble / political
  'knighted','enfeoffed','noble_exile','political_intrigue','court_appointment',
  'father_dies_heir_inherits',
  // Craft / trade
  'joined_guild','guild_advancement','masterwork_created','established_workshop',
  'successful_trade_venture','long_distance_trade','bad_trade_venture',
  'financial_ruin','workshop_fire',
  // Life events
  'survived_famine','bad_harvest','outlawed','serious_illness',
  'significant_injury','journey_abroad',
  // Family (family pool — injected differently)
  'married','first_child_born','child_dies','spouse_dies',
]);

const VALID_ATTRIBUTES = new Set([
  'STR','STA','DEX','AGL','EYE','HRG','SML','VOI','INT','AUR','WIL','CML',
]);

// Occupation → socialClass inference table
const OCCUPATION_CLASS_MAP = {
  innkeeper: 'craftsperson', blacksmith: 'craftsperson', weaponsmith: 'craftsperson',
  armorer: 'craftsperson',   brewer: 'craftsperson',     baker: 'craftsperson',
  potter: 'craftsperson',    weaver: 'craftsperson',     tanner: 'craftsperson',
  jeweler: 'craftsperson',   carpenter: 'craftsperson',  mason: 'craftsperson',
  miller: 'craftsperson',    chandler: 'craftsperson',   apothecary: 'craftsperson',
  physician: 'craftsperson', shipwright: 'craftsperson', glassblower: 'craftsperson',
  mercantyler: 'merchant',   trader: 'merchant',         merchant: 'merchant',
  moneylender: 'merchant',   banker: 'merchant',
  herald: 'noble',           bailiff: 'noble',           steward: 'noble',
  lord: 'noble',             lady: 'noble',              baron: 'noble',
  knight: 'warrior',         squire: 'warrior',
  priest: 'clergy',          cleric: 'clergy',           monk: 'clergy',
  nun: 'clergy',             abbot: 'clergy',            bishop: 'clergy',
  friar: 'clergy',
  soldier: 'soldier',        mercenary: 'soldier',       guard: 'soldier',
  sergeant: 'soldier',       legionnaire: 'soldier',
  farmer: 'peasant',         herdsman: 'peasant',        fisherman: 'peasant',
  hunter: 'peasant',         serf: 'peasant',            villager: 'peasant',
};

// ─────────────────────────────────────────────────────────────────────────────
// NORMALISE & VALIDATE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalise a raw constraint object built by Claude Code into a clean,
 * validated constraint object ready for generate-from-description.js.
 *
 * Non-fatal warnings are issued for unrecognised values rather than throwing,
 * so a partial description still produces a useful character.
 *
 * @param  {object} raw  - Raw constraint object from Claude Code
 * @returns {object}     - Normalised constraints + _warnings[]
 */
function normaliseConstraints(raw = {}) {
  const warnings = [];

  // ── socialClass ───────────────────────────────────────────────────────────
  let socialClass = raw.socialClass ? String(raw.socialClass).toLowerCase() : null;
  if (socialClass && !VALID_SOCIAL_CLASSES.has(socialClass)) {
    warnings.push(`Unknown socialClass '${socialClass}' — ignored`);
    socialClass = null;
  }
  // Infer from occupation
  if (!socialClass && raw.occupation) {
    const key = raw.occupation.toLowerCase().replace(/[\s-]+/g, '_');
    socialClass = OCCUPATION_CLASS_MAP[key]
      || OCCUPATION_CLASS_MAP[raw.occupation.toLowerCase()]
      || null;
    if (socialClass) warnings.push(`socialClass inferred as '${socialClass}' from occupation '${raw.occupation}'`);
  }

  // ── sex ────────────────────────────────────────────────────────────────
  let sex = raw.sex ? String(raw.sex).toLowerCase() : null;
  if (sex && sex !== 'male' && sex !== 'female') {
    warnings.push(`Unknown sex '${sex}' — ignored`);
    sex = null;
  }

  // ── targetAge ─────────────────────────────────────────────────────────────
  const targetAge = (raw.targetAge != null && Number.isFinite(Number(raw.targetAge)))
    ? Math.round(Number(raw.targetAge))
    : null;

  // ── family ────────────────────────────────────────────────────────────────
  let maritalStatus = raw.maritalStatus ? String(raw.maritalStatus).toLowerCase() : null;
  if (maritalStatus && !VALID_MARITAL_STATUSES.has(maritalStatus)) {
    warnings.push(`Unknown maritalStatus '${maritalStatus}' — ignored`);
    maritalStatus = null;
  }

  const childrenAlive = (raw.childrenAlive != null && Number.isFinite(Number(raw.childrenAlive)))
    ? Math.round(Number(raw.childrenAlive))
    : null;

  let childrenTotal = (raw.childrenTotal != null && Number.isFinite(Number(raw.childrenTotal)))
    ? Math.round(Number(raw.childrenTotal))
    : null;
  if (childrenTotal != null && childrenAlive != null && childrenTotal < childrenAlive) {
    warnings.push(`childrenTotal (${childrenTotal}) < childrenAlive (${childrenAlive}) — raising to match`);
    childrenTotal = childrenAlive;
  }

  // ── conditions ────────────────────────────────────────────────────────────
  const requiredConditions = (Array.isArray(raw.requiredConditions) ? raw.requiredConditions : [])
    .filter(c => {
      if (!VALID_CONDITIONS.has(c)) { warnings.push(`Unknown condition '${c}' — ignored`); return false; }
      return true;
    });

  const forbiddenConditions = (Array.isArray(raw.forbiddenConditions) ? raw.forbiddenConditions : [])
    .filter(c => {
      if (!VALID_CONDITIONS.has(c)) { warnings.push(`Unknown forbiddenCondition '${c}' — ignored`); return false; }
      return true;
    });

  // Sync marital status into conditions so the injector only needs to check one place
  if (maritalStatus === 'widowed' && !requiredConditions.includes('widowed')) {
    requiredConditions.push('widowed');
  }
  if (maritalStatus === 'married' && !requiredConditions.includes('married')) {
    requiredConditions.push('married');
  }
  // single = absence of both married and widowed
  if (maritalStatus === 'single') {
    if (!forbiddenConditions.includes('married'))  forbiddenConditions.push('married');
    if (!forbiddenConditions.includes('widowed'))  forbiddenConditions.push('widowed');
  }

  // ── required events ───────────────────────────────────────────────────────
  const requiredEvents = (Array.isArray(raw.requiredEvents) ? raw.requiredEvents : [])
    .filter(e => {
      if (!VALID_PINNABLE_EVENTS.has(e)) { warnings.push(`Unknown/unpinnable event '${e}' — ignored`); return false; }
      return true;
    });

  // ── attributes ────────────────────────────────────────────────────────────
  const attributes = {};
  if (raw.attributes && typeof raw.attributes === 'object') {
    for (const [key, val] of Object.entries(raw.attributes)) {
      if (!VALID_ATTRIBUTES.has(key)) {
        warnings.push(`Unknown attribute '${key}' — ignored`);
        continue;
      }
      const n = Number(val);
      if (!Number.isFinite(n) || n < 1 || n > 20) {
        warnings.push(`Attribute ${key} = ${val} is out of range 1–20 — ignored`);
        continue;
      }
      attributes[key] = Math.round(n);
    }
  }

  // ── occupation skills ─────────────────────────────────────────────────────
  const occupationSkills = Array.isArray(raw.occupationSkills) ? raw.occupationSkills : [];

  return {
    socialClass,
    sex,
    targetAge,
    occupation:       raw.occupation  || null,
    hobbySkill:       raw.hobbySkill  || null,
    occupationSkills,
    maritalStatus,
    childrenAlive,
    childrenTotal,
    requiredConditions,
    forbiddenConditions,
    requiredEvents,
    attributes,
    unmappedNotes: Array.isArray(raw.unmappedNotes) ? raw.unmappedNotes : [],
    _warnings: warnings,
  };
}

/**
 * Print a human-readable summary of extracted constraints.
 * Claude Code should log this before generating so the user can verify.
 *
 * @param  {object} c  - Normalised constraint object
 * @returns {string}
 */
function summariseConstraints(c) {
  const lines = ['=== Extracted constraints ==='];
  if (c.socialClass)  lines.push(`  Class:             ${c.socialClass}`);
  if (c.sex)       lines.push(`  Sex:            ${c.sex}`);
  if (c.targetAge)    lines.push(`  Age:               ${c.targetAge}`);
  if (c.occupation)   lines.push(`  Occupation:        ${c.occupation}`);
  if (c.hobbySkill)   lines.push(`  Hobby skill:       ${c.hobbySkill}`);
  if (c.occupationSkills.length) lines.push(`  Occ. skills:       ${c.occupationSkills.join(', ')}`);
  if (c.maritalStatus)           lines.push(`  Marital status:    ${c.maritalStatus}`);
  if (c.childrenAlive != null)   lines.push(`  Children (alive):  ${c.childrenAlive}`);
  if (c.childrenTotal != null)   lines.push(`  Children (total):  ${c.childrenTotal}`);
  if (c.requiredConditions.length)  lines.push(`  Must have:         ${c.requiredConditions.join(', ')}`);
  if (c.forbiddenConditions.length) lines.push(`  Must lack:         ${c.forbiddenConditions.join(', ')}`);
  if (c.requiredEvents.length)      lines.push(`  Required events:   ${c.requiredEvents.join(', ')}`);
  if (Object.keys(c.attributes).length) {
    lines.push(`  Attributes:        ${Object.entries(c.attributes).map(([k,v]) => `${k}=${v}`).join(', ')}`);
  }
  if (c.unmappedNotes.length) lines.push(`  Unmapped notes:    ${c.unmappedNotes.join('; ')}`);
  if (c._warnings.length)     lines.push(`  Warnings:          ${c._warnings.join('; ')}`);
  return lines.join('\n');
}

module.exports = {
  normaliseConstraints,
  summariseConstraints,
  OCCUPATION_CLASS_MAP,
  VALID_CONDITIONS,
  VALID_PINNABLE_EVENTS,
  VALID_SOCIAL_CLASSES,
};
