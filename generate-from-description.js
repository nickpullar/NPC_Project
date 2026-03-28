'use strict';

/**
 * generate-from-description.js
 *
 * Iterative constrained NPC generator. Takes a normalised constraint object
 * (built by Claude Code from a free-text description) and produces a
 * CharacterResult satisfying all hard pins via checkpoint-and-resume passes.
 *
 * PIPELINE
 * --------
 *   Pass 1: Run ageCharacter() freely with pre-seeded conditions.
 *   Analyse: For each unmet constraint, find the earliest age it should have
 *            resolved. That becomes the checkpoint for the next pass.
 *   Pass N: captureCheckpoint(result, checkpointAge) → resume from there with
 *           forcedEvents targeting the remaining missing constraints.
 *   Repeat until all constraints met or MAX_PASSES exhausted.
 *   Final:  Surgical injection for anything still unmet (last resort).
 *
 * CLAUDE CODE USAGE
 * -----------------
 *   const { generateFromDescription } = require('./generate-from-description');
 *   const { normaliseConstraints, summariseConstraints } = require('./constraint-extractor');
 *
 *   // Claude Code builds this from the description:
 *   const raw = {
 *     socialClass: 'craftsperson', sex: 'female', targetAge: 40,
 *     occupation: 'guilded_innkeeper', hobbySkill: 'Brewing',
 *     occupationSkills: ['Brewing','Cookery','RHETORIC','INTRIGUE','Animalcraft'],
 *     maritalStatus: 'widowed', childrenAlive: 2,
 *     requiredConditions: ['guild_member'],
 *     requiredEvents: ['pilgrimage'],
 *   };
 *
 *   const constraints = normaliseConstraints(raw);
 *   console.log(summariseConstraints(constraints));
 *   const result = await generateFromDescription(constraints, { verbose: true });
 */

const { ageCharacter, captureCheckpoint } = require('./aging-engine');
const { normaliseConstraints }            = require('./constraint-extractor');
const { verifyConstraints, injectConstraints } = require('./constraint-injector');

const MAX_PASSES = 8;

// ─────────────────────────────────────────────────────────────────────────────
// EXPECTED RESOLUTION AGES
// When should each constraint type have resolved naturally?
// Used to find the earliest checkpoint age when something is missing.
// ─────────────────────────────────────────────────────────────────────────────

const CONSTRAINT_RESOLUTION = {
  'condition:knighted':        { latest: 35, buffer: 5 },
  'condition:guild_member':    { latest: 28, buffer: 5 },
  'condition:guild_master':    { latest: 38, buffer: 6 },
  'condition:veteran':         { latest: 32, buffer: 5 },
  'condition:married':         { latest: 30, buffer: 5 },
  'condition:widowed':         { latest: 38, buffer: 4 },
  'condition:pilgrim':         { latest: 36, buffer: 5 },
  'condition:devout':          { latest: 30, buffer: 4 },
  'condition:prosperous':      { latest: 35, buffer: 5 },
  'condition:exiled':          { latest: 35, buffer: 5 },
  'condition:outlawed':        { latest: 35, buffer: 5 },
  'condition:lame':            { latest: 38, buffer: 5 },
  'condition:scarred':         { latest: 38, buffer: 5 },
  'condition:orphaned':        { latest: 30, buffer: 4 },
  'event:military_campaign':   { latest: 32, buffer: 5 },
  'event:pilgrimage':          { latest: 36, buffer: 5 },
  'event:knighted':            { latest: 32, buffer: 5 },
  'event:guild_advancement':   { latest: 38, buffer: 6 },
  'event:joined_guild':        { latest: 25, buffer: 4 },
  'event:noble_exile':         { latest: 35, buffer: 5 },
  'event:survived_famine':     { latest: 38, buffer: 5 },
  'event:war_wound':           { latest: 35, buffer: 5 },
  'event:captured_prisoner':   { latest: 35, buffer: 5 },
  'childrenAlive':             { latest: 36, buffer: 5 },
  'childrenTotal':             { latest: 36, buffer: 5 },
};

function getResolutionAge(key, targetAge) {
  const def = CONSTRAINT_RESOLUTION[key];
  if (!def) return Math.round(targetAge * 0.7);
  return Math.min(def.latest, targetAge - 2);
}

function getBuffer(key) {
  return CONSTRAINT_RESOLUTION[key]?.buffer ?? 5;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTRAINT → FORCED EVENT MAPPING
// ─────────────────────────────────────────────────────────────────────────────

const CONSTRAINT_TO_FORCED = {
  'condition:knighted':       { eventId: 'knighted',                pool: 'biographical' },
  'condition:guild_member':   { eventId: 'joined_guild',            pool: 'biographical' },
  'condition:guild_master':   { eventId: 'guild_advancement',       pool: 'biographical' },
  'condition:veteran':        { eventId: 'military_campaign',       pool: 'biographical' },
  'condition:pilgrim':        { eventId: 'pilgrimage',              pool: 'biographical' },
  'condition:devout':         { eventId: 'religious_devotion',      pool: 'biographical' },
  'condition:prosperous':     { eventId: 'successful_trade_venture',pool: 'biographical' },
  'condition:exiled':         { eventId: 'noble_exile',             pool: 'biographical' },
  'condition:outlawed':       { eventId: 'outlawed',                pool: 'biographical' },
  'condition:lame':           { eventId: 'serious_wound',           pool: 'biographical' },
  'condition:scarred':        { eventId: 'significant_injury',      pool: 'biographical' },
  'condition:orphaned':       { eventId: 'death_of_parent',         pool: 'biographical' },
  'condition:married':        { eventId: 'married',                 pool: 'biographical' },
  'condition:widowed':        { eventId: 'spouse_dies',             pool: 'family'       },
  'event:military_campaign':  { eventId: 'military_campaign',       pool: 'biographical' },
  'event:pilgrimage':         { eventId: 'pilgrimage',              pool: 'biographical' },
  'event:knighted':           { eventId: 'knighted',                pool: 'biographical' },
  'event:guild_advancement':  { eventId: 'guild_advancement',       pool: 'biographical' },
  'event:joined_guild':       { eventId: 'joined_guild',            pool: 'biographical' },
  'event:noble_exile':        { eventId: 'noble_exile',             pool: 'biographical' },
  'event:survived_famine':    { eventId: 'survived_famine',         pool: 'biographical' },
  'event:war_wound':          { eventId: 'war_wound',               pool: 'biographical' },
  'event:captured_prisoner':  { eventId: 'captured_prisoner',       pool: 'biographical' },
};

// ─────────────────────────────────────────────────────────────────────────────
// STARTING CONDITIONS
// ─────────────────────────────────────────────────────────────────────────────

function buildStartingConditions(constraints) {
  const conds = [];

  // Marital status
  if (constraints.maritalStatus === 'married' || constraints.maritalStatus === 'widowed') {
    conds.push('married');
  }

  // Children — seed both has_children AND married so the family pool activates
  // from the very first year of the simulation
  if ((constraints.childrenAlive ?? 0) > 0 || (constraints.childrenTotal ?? 0) > 0) {
    conds.push('has_children');
    if (!conds.includes('married')) conds.push('married');
  }

  // Background conditions plausibly present from birth/early life
  const BACKGROUND = new Set(['devout','prosperous','indebted','orphaned','rh_negative']);
  for (const c of constraints.requiredConditions ?? []) {
    if (BACKGROUND.has(c)) conds.push(c);
  }

  return [...new Set(conds)];
}

// ─────────────────────────────────────────────────────────────────────────────
// PLANNER: analyse result → plan for next pass
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analyse a result and produce the plan for the next pass.
 *
 * Returns null if all constraints are satisfied (done).
 * Returns { checkpointAge, forcedEvents, startingConditions } otherwise.
 */
function planNextPass(result, constraints, targetAge, passLog, previousCheckpoints) {
  const { missing, forbidden } = verifyConstraints(result, constraints);
  if (missing.length === 0 && forbidden.length === 0) return null;

  let earliestCheckpoint = targetAge - 1;
  const forcedEvents     = [];
  const extraConditions  = [];

  // ── Re-include forced events for constraints already satisfied ──────────────
  // When re-planning, protect constraints that were satisfied in the previous run
  // by re-injecting their forced events so they don't vanish in the new pass.
  if (result) {
    for (const [key, def] of Object.entries(CONSTRAINT_TO_FORCED)) {
      // Skip if this constraint is still missing (it gets handled below)
      if (missing.some(m => m === key)) continue;
      // Skip if this constraint isn't in the constraint set at all
      const isCond  = key.startsWith('condition:');
      const isEvent = key.startsWith('event:');
      if (isCond) {
        const condName = key.slice('condition:'.length);
        if (!(constraints.requiredConditions ?? []).includes(condName)) continue;
      } else if (isEvent) {
        const evName = key.slice('event:'.length);
        if (!(constraints.requiredEvents ?? []).includes(evName)) continue;
      } else continue;
      // This constraint was satisfied — pin its event so it survives the new pass
      const resAge    = getResolutionAge(key, targetAge);
      const buf       = getBuffer(key);
      const windowEnd = Math.min(resAge, targetAge - 1);
      const wStart    = Math.max(18, windowEnd - 8);
      // Only add if there's no existing forced entry for this event
      if (!forcedEvents.some(fe => fe.eventId === def.eventId)) {
        forcedEvents.push({
          eventId: def.eventId,
          pool:    def.pool,
          ageMin:  wStart,
          ageMax:  windowEnd,
          _fired:  false,
          _reason: `protect satisfied: ${key}`,
        });
      }
    }
  }

  // ── Compute forced events and checkpoint age for each missing constraint ──
  for (const m of missing) {
    const resAge      = getResolutionAge(m, targetAge);
    const buf         = getBuffer(m);
    const windowEnd   = Math.min(resAge, targetAge - 1);
    const windowStart = Math.max(18, windowEnd - 8);
    const cpAge       = Math.max(18, resAge - buf);

    if (cpAge < earliestCheckpoint) earliestCheckpoint = cpAge;

    // Special case: childrenAlive deficit
    if (m.startsWith('childrenAlive:')) {
      const need    = constraints.childrenAlive;
      const have    = result.children.filter(c => c.status === 'alive').length;
      const deficit = need - have;
      // Ensure married is seeded so family pool is active at resume
      extraConditions.push('married', 'has_children');
      // Suppress child_dies events while alive count is below required:
      // inject a weight-zero override for child_dies during the birth window.
      forcedEvents.push({
        eventId:     '__suppress_child_dies',
        pool:        'family',
        ageMin:      18,
        ageMax:      Math.min(36, targetAge - 2),
        _fired:      false,
        _suppressChildDies: true,
        _reason:     'prevent child deaths while deficit unresolved',
      });
      for (let i = 0; i < deficit; i++) {
        const ageMin = Math.min(19 + i * 3, targetAge - 4);
        const ageMax = Math.min(ageMin + 8, targetAge - 2);
        forcedEvents.push({
          eventId: 'first_child_born',
          pool:    'family',
          ageMin,
          ageMax,
          _fired:  false,
          _reason: `childrenAlive deficit (need ${need}, have ${have})`,
        });
      }
      if (cpAge < earliestCheckpoint) earliestCheckpoint = Math.max(18, 18);
      continue;
    }

    // childrenTotal deficit
    if (m.startsWith('childrenTotal:')) {
      const need    = constraints.childrenTotal;
      const have    = result.children.length;
      const deficit = need - have;
      extraConditions.push('married', 'has_children');
      for (let i = 0; i < deficit; i++) {
        forcedEvents.push({
          eventId: 'first_child_born',
          pool:    'family',
          ageMin:  Math.min(19 + i * 3, targetAge - 4),
          ageMax:  Math.min(28 + i * 3, targetAge - 2),
          _fired:  false,
          _reason: `childrenTotal deficit`,
        });
      }
      continue;
    }

    const forcedDef = CONSTRAINT_TO_FORCED[m];
    if (forcedDef) {
      forcedEvents.push({
        eventId: forcedDef.eventId,
        pool:    forcedDef.pool,
        ageMin:  windowStart,
        ageMax:  windowEnd,
        _fired:  false,
        _reason: m,
      });

      // guild_master requires guild_member to appear earlier in the history
      if (m === 'condition:guild_master') {
        const gmCondKey = 'condition:guild_member';
        const alreadySatisfied = !missing.some(x => x === gmCondKey);
        const alreadyForced    = forcedEvents.some(fe => fe.eventId === 'joined_guild');
        if (!alreadySatisfied && !alreadyForced) {
          const gmAge = Math.max(18, windowStart - 6);
          forcedEvents.push({
            eventId: 'joined_guild',
            pool:    'biographical',
            ageMin:  gmAge,
            ageMax:  Math.min(gmAge + 5, windowStart - 1),
            _fired:  false,
            _reason: 'prerequisite for guild_master',
          });
        }
      }

      // widowed requires married to exist first — ensure married is forced earlier
      if (m === 'condition:widowed') {
        extraConditions.push('married');
        // Add a married forced event if not already present and married isn't in conditions
        if (!result.conditions.includes('married') &&
            !forcedEvents.some(fe => fe.eventId === 'married')) {
          const marAge = Math.max(18, windowStart - 5);
          forcedEvents.push({
            eventId: 'married',
            pool:    'biographical',
            ageMin:  marAge,
            ageMax:  Math.min(marAge + 6, windowStart - 1),
            _fired:  false,
            _reason: 'prerequisite for widowed',
          });
        }
      }
    }
  }

  // ── Detect oscillation: same (checkpoint, missing-set) pair twice in a row ──
  // The crude version (same age twice) fired for legitimate different problems at
  // the same age. We now track the full (checkpointAge + sorted missing keys) tuple
  // so we only escalate when there is genuinely no progress at all.
  const thisKey  = `${earliestCheckpoint}|${[...missing].sort().join(',')}`;
  const lastKeys = previousCheckpoints.slice(-2);
  if (lastKeys.length === 2 && lastKeys[0] === thisKey && lastKeys[1] === thisKey) {
    passLog.push(`  Oscillation detected (${thisKey}) — escalating to injection`);
    return 'inject';
  }

  // Ensure checkpoint is before the earliest forced event window
  for (const fe of forcedEvents) {
    if (fe.ageMin - 1 < earliestCheckpoint) {
      earliestCheckpoint = Math.max(18, fe.ageMin - 1);
    }
  }

  const detail = forcedEvents.map(fe =>
    `${fe.eventId}@${fe.ageMin}-${fe.ageMax}`).join(', ');
  passLog.push(`  Checkpoint age ${earliestCheckpoint}${detail ? ', forcing: ' + detail : ''}`);

  return {
    checkpointAge:      earliestCheckpoint,
    forcedEvents,
    extraConditions:    [...new Set(extraConditions)],
    _stateKey:          thisKey,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN GENERATOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a CharacterResult satisfying all constraints via iterative
 * checkpoint-and-resume passes.
 *
 * @param  {object}  constraintsOrRaw  - Normalised or raw constraint object
 * @param  {object}  options
 * @param  {number}  options.maxPasses - Max refinement passes (default 8)
 * @param  {boolean} options.verbose   - Log pass-by-pass progress
 * @returns {object} CharacterResult with _constraintLog and _constraintsMet
 */
async function generateFromDescription(constraintsOrRaw, options = {}) {
  const maxPasses = options.maxPasses ?? MAX_PASSES;
  const verbose   = options.verbose   ?? false;

  const constraints = constraintsOrRaw._warnings !== undefined
    ? constraintsOrRaw
    : normaliseConstraints(constraintsOrRaw);

  const targetAge = constraints.targetAge ?? 35;
  const startingConditions = buildStartingConditions(constraints);

  // Map 'craftsperson' to the engine's canonical class name 'artisan'.
  // The engine has no 'craftsperson' class; callers may use either term.
  const _rawClass = constraints.socialClass ?? 'craftsperson';
  const _socialClass = (_rawClass === 'craftsperson') ? 'artisan' : _rawClass;

  const baseParams = {
    socialClass:      _socialClass,
    sex:           constraints.sex           ?? 'female',
    targetAge,
    hobbySkill:       constraints.hobbySkill       ?? null,
    occupationSkills: constraints.occupationSkills ?? [],
    conditions:       startingConditions,
    attributes:       Object.keys(constraints.attributes ?? {}).length > 0
      ? { STR:10,STA:10,DEX:10,AGL:10,EYE:10,HRG:10,SML:10,VOI:10,INT:10,AUR:10,WIL:10,CML:10,
          ...constraints.attributes }
      : null,
    forcedEvents: [],
  };

  const passLog            = [];
  const previousCheckpoints = [];
  let   result             = null;

  for (let pass = 1; pass <= maxPasses; pass++) {

    if (pass === 1) {
      // First pass: free run with pre-seeded conditions
      result = ageCharacter(baseParams);
    } else {
      const plan = planNextPass(result, constraints, targetAge, passLog, previousCheckpoints);

      if (plan === null) break;               // all done
      if (plan === 'inject') break;           // oscillation — go straight to injection

      previousCheckpoints.push(plan._stateKey);

      const checkpoint = captureCheckpoint(result, plan.checkpointAge);
      if (!checkpoint) {
        passLog.push(`  Pass ${pass}: checkpoint capture failed at age ${plan.checkpointAge}`);
        break;
      }

      // Merge any extra conditions the plan needs (e.g. married for children)
      const resumeConditions = [...new Set([
        ...checkpoint.conditions,
        ...plan.extraConditions,
      ])];
      checkpoint.conditions = resumeConditions;

      result = ageCharacter({
        ...baseParams,
        checkpoint,
        forcedEvents: plan.forcedEvents,
      });
    }

    const { missing, forbidden } = verifyConstraints(result, constraints);
    const totalPins =
      (constraints.requiredConditions?.length  ?? 0) +
      (constraints.requiredEvents?.length       ?? 0) +
      (constraints.childrenAlive  != null ? 1 : 0)   +
      (constraints.childrenTotal  != null ? 1 : 0);
    const satisfied = totalPins - missing.length;

    if (verbose) {
      const forbStr = forbidden.length ? `, forbidden=[${forbidden.join(', ')}]` : '';
      console.log(`[gfd] Pass ${pass}: ${satisfied}/${totalPins} satisfied, missing=[${missing.join(', ')}]${forbStr}`);
    }
    passLog.push(`Pass ${pass}: missing=[${missing.join(', ')}]`);

    if (missing.length === 0 && forbidden.length === 0) {
      passLog.push(`✓ All constraints satisfied after ${pass} pass${pass > 1 ? 'es' : ''}`);
      result._constraintLog  = passLog;
      result._constraintsMet = true;
      return result;
    }
  }

  // ── Surgical injection fallback ───────────────────────────────────────────
  const { missing: stillMissing } = verifyConstraints(result, constraints);
  if (stillMissing.length > 0) {
    if (verbose) console.log(`[gfd] Injection fallback for: ${stillMissing.join(', ')}`);
    passLog.push(`Injection fallback for: ${stillMissing.join(', ')}`);
    const injLog = injectConstraints(result, constraints);
    passLog.push(...injLog);
  }

  const finalCheck = verifyConstraints(result, constraints);
  const allMet     = finalCheck.missing.length === 0 && finalCheck.forbidden.length === 0;
  passLog.push(allMet
    ? '✓ All constraints satisfied'
    : `⚠ Still unmet after injection: ${finalCheck.missing.join(', ')}`);

  result._constraintLog  = passLog;
  result._constraintsMet = allMet;
  return result;
}

module.exports = { generateFromDescription };
