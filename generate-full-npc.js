'use strict';

/**
 * generate-full-npc.js
 *
 * Integration layer: wires aging-engine.js + npc-generator.js into a single
 * pipeline. Produces a complete CharacterResult enriched with personality,
 * automatic skills, deity, and (where rolled) secret worship.
 *
 * PIPELINE
 * --------
 *   1. ageCharacter()           — life history, OP spending, conditions
 *   2. generateOCEANScores()    — already done inside ageCharacter; reused here
 *   3. generatePersonality()    — OCEAN → personality traits
 *   4. selectDeity()            — class/sex weighted deity selection
 *   5. rollSecretWorship()      — 0.5% chance; Tashal override if location is Tashal
 *   6. generateAutomaticSkills()— recalculated from FINAL attributes (post-injury)
 *      → RITUAL skill uses the public deity
 *   7. rollSunsign()            — sunsign if not provided
 *
 * USAGE (from Claude Code)
 * ─────────────────────────
 *   const { generateFullNPC } = require('./generate-full-npc');
 *
 *   const npc = await generateFullNPC({
 *     socialClass:      'artisan',
 *     sex:           'female',
 *     targetAge:        38,
 *     occupation:       'guilded_innkeeper',
 *     hobbySkill:       'Brewing',
 *     occupationSkills: ['Brewing','Cookery','RHETORIC','INTRIGUE'],
 *     location:         'Tashal',
 *     sunsign:          null,      // null = roll randomly
 *     // All ageCharacter params accepted: conditions, attributes, publicDeity, etc.
 *   });
 *
 *   // Result shape (CharacterResult + extras):
 *   npc.personality          // e.g. "Methodical, quietly ambitious, dislikes waste"
 *   npc.publicDeity          // e.g. "Halea"
 *   npc.secretDeity          // e.g. "Naveh" | null
 *   npc.isSecretWorshipper   // boolean
 *   npc.secretCallout        // GM [!gm] callout markdown | null
 *   npc.sunsign              // e.g. "Tarael"
 *   npc.automaticSkills      // [{name, sb, oml, isRitual, deity?}]
 *   npc.skillsLine           // formatted markdown string
 *   // ... all standard ageCharacter result fields
 *
 * CONSTRAINT-BASED GENERATION
 * ────────────────────────────
 *   For descriptions like "a lame former soldier, married, two children":
 *
 *   const { generateFromDescription } = require('./generate-from-description');
 *   const { normaliseConstraints }    = require('./constraint-extractor');
 *   const { enrichResult }            = require('./generate-full-npc');
 *
 *   const constraints = normaliseConstraints(rawConstraintObject);
 *   const result      = await generateFromDescription(constraints);
 *   const npc         = enrichResult(result, { location: 'Tashal' });
 */

const {
  generatePersonality,
  selectDeity,
  rollSecretWorship,
  generateAutomaticSkills,
  formatAutomaticSkills,
  rollSunsign,
  generateOCEANScores,
} = require('./npc-generator');

const { ageCharacter }          = require('./aging-engine');

// generate-from-description and constraint-extractor are optional AI-powered modules
// not included in the base distribution. Gate their require so the primary entry point
// (generateFullNPC) remains usable without them.
let generateFromDescription = null;
let normaliseConstraints = null;
try {
  ({ generateFromDescription } = require('./generate-from-description'));
  ({ normaliseConstraints }    = require('./constraint-extractor'));
} catch (_) {
  // Optional modules not present — generateFullNPCFromDescription() will throw
  // a descriptive error if called, but generateFullNPC() is unaffected.
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL: build [!gm] secret worship callout block
// ─────────────────────────────────────────────────────────────────────────────

function buildSecretCallout(secretDeity, publicDeity, roll, tashalCell) {
  const facade  = publicDeity
    ? `Outwardly presents as a worshipper of ${publicDeity}.`
    : 'Public faith is a facade.';
  const label   = tashalCell ? `${secretDeity} (Tashal Naveh cell)` : secretDeity;
  return `\n> [!gm] Secret Worship\n> This character secretly worships **${label}**. ${facade}\n> *d200 roll: ${roll}*\n`;
}

// ─────────────────────────────────────────────────────────────────────────────
// enrichResult  — add personality / deity / skills to an existing CharacterResult
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Enrich an existing CharacterResult (from ageCharacter or generateFromDescription)
 * with personality traits, deity, automatic skills, and optional secret worship.
 *
 * Call this if you already have a CharacterResult and just need the npc-generator
 * layer applied on top.
 *
 * @param  {object} result             - CharacterResult from ageCharacter()
 * @param  {object} opts
 * @param  {string|null} opts.location  - Current settlement name (Tashal triggers cell roll)
 * @param  {string|null} opts.sunsign   - Sunsign; null = roll randomly
 * @param  {number}      opts.maxTraitCount - Max OCEAN traits (default null = 1–3)
 * @returns {object}  Enriched CharacterResult
 */
function enrichResult(result, opts = {}) {
  const { location = null, sunsign: sunsignIn = null, maxTraitCount = null } = opts;

  const cls    = result.socialClass;
  const sex = result.sex;
  const attrs  = result.attributes;

  // ── Sunsign ───────────────────────────────────────────────────────────────
  const sunsign = sunsignIn || rollSunsign();

  // ── Deity (use existing publicDeity if already set by aging engine, e.g.
  //    from a deityChange event; otherwise roll fresh) ───────────────────────
  let publicDeity  = result.publicDeity || null;
  let secretDeity  = null;
  let secretRoll   = null;
  let tashalCell   = false;
  let isSecretWorshipper = false;

  if (!publicDeity) {
    const deityResult = selectDeity(cls, sex, location);
    publicDeity       = deityResult.publicDeity;
  }

  // Secret worship — independent roll regardless of whether deity was preset
  const secretResult = rollSecretWorship(cls, location);
  if (secretResult) {
    secretDeity        = secretResult.secretDeity;
    secretRoll         = secretResult.roll;
    tashalCell         = secretResult.tashalCell;
    isSecretWorshipper = true;
  }

  const secretCallout = isSecretWorshipper
    ? buildSecretCallout(secretDeity, publicDeity, secretRoll, tashalCell)
    : null;

  // ── Personality ───────────────────────────────────────────────────────────
  // Use the simulation's own oceanScores so personality descriptors are
  // consistent with the morality score the aging engine derived from them.
  // A low-A (callous) character will never be described as "considerate".
  const personality = generatePersonality(cls, sex, maxTraitCount, result.oceanScores || null);

  // ── Automatic skills — recalculated from FINAL attributes ─────────────────
  // Post-simulation attributes include any injury deltas, so this correctly
  // reflects a lame or weakened character's actual skill bases.
  const automaticSkills = generateAutomaticSkills(attrs, sunsign, publicDeity, result.socialClass);
  const skillsLine      = formatAutomaticSkills(automaticSkills, true);

  return {
    ...result,
    publicDeity,
    secretDeity,
    isSecretWorshipper,
    secretRoll,
    tashalCell,
    secretCallout,
    personality,
    sunsign,
    automaticSkills,
    skillsLine,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// generateFullNPC  — fresh generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a complete NPC from scratch.
 *
 * Accepts all ageCharacter parameters plus:
 *   sunsign      {string|null}  — rolled if null
 *   location     {string|null}  — settlement name, for Tashal secret-worship override
 *   maxTraitCount {number|null} — max OCEAN personality traits
 *
 * @returns {object} Enriched CharacterResult
 */
function generateFullNPC(params = {}) {
  const {
    sunsign:       sunsignIn    = null,
    location:      locationIn   = null,
    maxTraitCount              = null,
    // everything else is passed to ageCharacter
    ...agingParams
  } = params;

  const result = ageCharacter({ location: locationIn, ...agingParams });
  return enrichResult(result, { location: locationIn, sunsign: sunsignIn, maxTraitCount });
}

// ─────────────────────────────────────────────────────────────────────────────
// generateFullNPCFromDescription  — constraint-based generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a constrained NPC from a description, then enrich with personality
 * and skills.
 *
 * @param  {object} constraintsOrRaw   - Raw or normalised constraint object
 * @param  {object} opts
 * @param  {string|null} opts.location
 * @param  {string|null} opts.sunsign
 * @param  {number|null} opts.maxTraitCount
 * @param  {boolean}     opts.verbose    - Log planner progress
 * @param  {number}      opts.maxPasses
 * @returns {Promise<object>} Enriched CharacterResult
 */
async function generateFullNPCFromDescription(constraintsOrRaw, opts = {}) {
  if (!generateFromDescription || !normaliseConstraints) {
    throw new Error(
      'generateFullNPCFromDescription() requires the optional modules ' +
      'generate-from-description.js and constraint-extractor.js, which are ' +
      'not included in the base distribution. Use generateFullNPC() instead.'
    );
  }
  const {
    location     = null,
    sunsign      = null,
    maxTraitCount = null,
    verbose      = false,
    maxPasses,
  } = opts;

  const constraints = constraintsOrRaw._warnings !== undefined
    ? constraintsOrRaw
    : normaliseConstraints(constraintsOrRaw);

  const result = await generateFromDescription(constraints, { verbose, maxPasses });
  return enrichResult(result, { location, sunsign, maxTraitCount });
}

// ─────────────────────────────────────────────────────────────────────────────
// QUICK TEST
// ─────────────────────────────────────────────────────────────────────────────

if (require.main === module) {
  (async () => {
    console.log('=== generateFullNPC — Quick Test ===\n');

    // Free generation
    const npc = generateFullNPC({
      socialClass:      'artisan',
      sex:           'female',
      targetAge:        38,
      hobbySkill:       'Brewing',
      occupationSkills: ['Brewing','Cookery','RHETORIC','INTRIGUE'],
      location:         'Tashal',
    });

    console.log(`Name:         ${npc.name || '(unnamed)'}`);
    console.log(`Class/Sex: ${npc.socialClass} ${npc.sex}, age ${npc.age}`);
    console.log(`Sunsign:      ${npc.sunsign}`);
    console.log(`Deity:        ${npc.publicDeity || '(none)'}`);
    if (npc.isSecretWorshipper) console.log(`SECRET:       ${npc.secretDeity} [roll ${npc.secretRoll}]`);
    console.log(`Personality:  ${npc.personality}`);
    console.log(`Auto skills:  ${npc.skillsLine}`);
    console.log(`Conditions:   ${npc.conditions.join(', ') || '(none)'}`);
    console.log(`History:      ${npc.history.length} entries`);
    console.log();

    // Constrained generation
    console.log('=== generateFullNPCFromDescription — Quick Test ===\n');
    const raw = {
      socialClass:      'artisan',
      sex:           'female',
      targetAge:        40,
      occupation:       'guilded_innkeeper',
      hobbySkill:       'Brewing',
      occupationSkills: ['Brewing','Cookery','RHETORIC','INTRIGUE','Animalcraft'],
      maritalStatus:    'widowed',
      childrenAlive:    2,
      requiredConditions: ['guild_member'],
      requiredEvents:   ['pilgrimage'],
    };

    const npc2 = await generateFullNPCFromDescription(raw, { verbose: true, location: 'Tashal' });
    console.log(`\nResult: ${npc2.socialClass} ${npc2.sex}, age ${npc2.age}`);
    console.log(`Conditions: ${npc2.conditions.join(', ')}`);
    console.log(`Children alive: ${npc2.children.filter(c=>c.status==='alive').length}`);
    console.log(`Constraint log:\n  ${npc2._constraintLog?.join('\n  ') || '—'}`);
  })().catch(e => { console.error(e); process.exit(1); });
}

module.exports = {
  generateFullNPC,
  generateFullNPCFromDescription,
  enrichResult,
};
