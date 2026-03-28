'use strict';

/**
 * constraint-injector.js
 *
 * Verifies a CharacterResult against a constraint object and injects any
 * missing hard pins. Called by generate-from-description.js after the
 * retry loop has done as much as it can through natural simulation.
 *
 * INJECTION STRATEGIES
 * --------------------
 * 1. Attributes        — set directly on result.attributes (pinned from start, so
 *                        this should already be satisfied; this is a safety net)
 * 2. Conditions        — find the most appropriate event that adds the condition,
 *                        inject it at a plausible age by replacing an uneventful_year
 * 3. Required events   — inject the event at a plausible age if not already present
 * 4. Children          — inject first_child_born / child_dies events in family pool
 * 5. Marital status    — inject married / spouse_dies events
 * 6. Forbidden conds   — if present, find the event that added them and remove it
 *                        (limited: only works if the condition came from a single event)
 *
 * PLAUSIBLE AGE RANGES
 * --------------------
 * Each injectable event has a plausible age window per social class.
 * The injector picks the earliest uneventful_year within that window.
 * If no uneventful year exists in range, it targets the least consequential year.
 */

const LIFE_EVENTS = require('./life-events').LIFE_EVENTS;

// ── Deterministic RNG for injection ─────────────────────────────────────────
// Math.random() was used for child sex rolls, making injected children
// non-reproducible. We derive a seed from the result object so that the
// same NPC always gets the same injected children.
function _injHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
function _injMkRng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };
}

// ─────────────────────────────────────────────────────────────────────────────
// PLAUSIBLE AGE WINDOWS FOR EVENT INJECTION
// Keys are event IDs. Values are { min, max } age ranges.
// Class-specific overrides are in CLASS_AGE_OVERRIDES.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_AGE_WINDOWS = {
  // Military
  military_campaign:   { min: 18, max: 40 },
  war_wound:           { min: 18, max: 40 },
  serious_wound:       { min: 18, max: 40 },
  captured_prisoner:   { min: 18, max: 40 },
  promoted_sergeant:   { min: 22, max: 45 },
  commendation_received: { min: 20, max: 50 },
  deserted:            { min: 18, max: 35 },
  // Religious
  pilgrimage:          { min: 20, max: 55 },
  religious_devotion:  { min: 18, max: 60 },
  faith_crisis:        { min: 25, max: 55 },
  clergy_scandal:      { min: 25, max: 55 },
  // Noble / political
  knighted:            { min: 20, max: 40 },
  enfeoffed:           { min: 25, max: 50 },
  noble_exile:         { min: 20, max: 50 },
  political_intrigue:  { min: 20, max: 55 },
  court_appointment:   { min: 22, max: 50 },
  father_dies_heir_inherits: { min: 25, max: 55 },
  // Craft / trade
  joined_guild:        { min: 18, max: 30 },
  guild_advancement:   { min: 25, max: 50 },
  masterwork_created:  { min: 22, max: 55 },
  established_workshop:{ min: 22, max: 45 },
  successful_trade_venture: { min: 20, max: 55 },
  long_distance_trade: { min: 20, max: 50 },
  bad_trade_venture:   { min: 20, max: 55 },
  financial_ruin:      { min: 22, max: 55 },
  workshop_fire:       { min: 22, max: 55 },
  // Life
  survived_famine:     { min: 18, max: 60 },
  bad_harvest:         { min: 18, max: 60 },
  outlawed:            { min: 18, max: 50 },
  serious_illness:     { min: 18, max: 60 },
  significant_injury:  { min: 18, max: 55 },
  journey_abroad:      { min: 18, max: 45 },
  // Family
  married:             { min: 18, max: 35 },
  first_child_born:    { min: 19, max: 38 },
  child_dies:          { min: 20, max: 50 },
  spouse_dies:         { min: 22, max: 55 },
};

// Class-specific overrides where the default range doesn't fit
const CLASS_AGE_OVERRIDES = {
  noble: {
    knighted:    { min: 18, max: 28 },
    enfeoffed:   { min: 20, max: 40 },
  },
  warrior: {
    knighted:    { min: 20, max: 35 },
    military_campaign: { min: 18, max: 45 },
  },
  craftsperson: {
    joined_guild:     { min: 18, max: 25 },
    guild_advancement:{ min: 26, max: 50 },
  },
  clergy: {
    pilgrimage:  { min: 22, max: 60 },
    faith_crisis:{ min: 28, max: 55 },
  },
};

// Condition → event that adds it (prefer the most targeted event)
const CONDITION_TO_EVENT = {
  knighted:        'knighted',
  enfeoffed:       'enfeoffed',
  guild_member:    'joined_guild',
  guild_master:    'guild_advancement',
  veteran:         'military_campaign',
  sergeant:        'promoted_sergeant',
  outlawed:        'outlawed',
  exiled:          'noble_exile',
  branded:         'branded_or_mutilated',
  criminal_record: 'theft',
  disgraced:       'public_humiliation',
  ruined:          'financial_ruin',
  lame:            'serious_wound',
  scarred:         'significant_injury',
  chronic_illness: 'serious_illness',
  orphaned:        'death_of_parent',
  devout:          'religious_devotion',
  prosperous:      'successful_trade_venture',
  indebted:        'bad_trade_venture',
  landless:        'lord_dismissed_service',
  captured:        'captured_prisoner',
  pilgrim:         'pilgrimage',
  married:         'married',
  widowed:         'spouse_dies',
  robust:          'physical_training_regimen',
  faith_crisis:    'faith_crisis',
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function getAgeWindow(eventId, socialClass) {
  const classOverrides = CLASS_AGE_OVERRIDES[socialClass] || {};
  return classOverrides[eventId] || DEFAULT_AGE_WINDOWS[eventId] || { min: 20, max: 45 };
}

/**
 * Find the best history entry to replace for injection.
 * Prefers uneventful_year entries in the age window.
 * Falls back to the entry in-range with the least narrative weight.
 */
function findInjectionTarget(history, eventId, socialClass, pool = 'biographical') {
  const { min, max } = getAgeWindow(eventId, socialClass);

  const inRange = history.filter(e => e.pool === pool && e.age >= min && e.age <= max);
  if (inRange.length === 0) {
    // Extend range to full history for this pool
    return history.find(e => e.pool === pool) || null;
  }

  // Prefer uneventful years
  const uneventful = inRange.find(e => e.eventId === 'uneventful_year');
  if (uneventful) return uneventful;

  // Fall back to first in-range entry
  return inRange[0];
}

/**
 * Look up an event definition by ID from LIFE_EVENTS.
 */
function getEventDef(eventId) {
  return LIFE_EVENTS.find(e => e.id === eventId) || null;
}

/**
 * Apply an event's conditions.add to a conditions array (in-place).
 */
function applyConditionAdds(conditions, eventDef) {
  if (!eventDef?.effects?.conditions?.add) return;
  for (const c of eventDef.effects.conditions.add) {
    if (!conditions.includes(c)) conditions.push(c);
  }
}

/**
 * Apply an event's conditions.remove from a conditions array (in-place).
 */
function applyConditionRemoves(conditions, eventDef) {
  if (!eventDef?.effects?.conditions?.remove) return;
  const toRemove = new Set(eventDef.effects.conditions.remove);
  const idx = conditions.findIndex(c => toRemove.has(c));
  if (idx !== -1) conditions.splice(idx, 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// VERIFICATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check which constraints are not yet satisfied by a CharacterResult.
 *
 * @param  {object} result       - CharacterResult from ageCharacter()
 * @param  {object} constraints  - Normalised constraint object
 * @returns {object}             - { satisfied: string[], missing: string[], forbidden: string[] }
 */
function verifyConstraints(result, constraints) {
  const satisfied = [];
  const missing   = [];
  const forbidden = [];

  const finalConds = new Set(result.conditions || []);
  const eventIds  = new Set((result.history || []).map(e => e.eventId));
  const aliveChildren = (result.children || []).filter(c => c.status === 'alive').length;
  const totalChildren = (result.children || []).length;

  // Required conditions
  for (const c of constraints.requiredConditions || []) {
    if (finalConds.has(c)) satisfied.push(`condition:${c}`);
    else missing.push(`condition:${c}`);
  }

  // Forbidden conditions
  for (const c of constraints.forbiddenConditions || []) {
    if (!finalConds.has(c)) satisfied.push(`!condition:${c}`);
    else forbidden.push(`condition:${c}`);
  }

  // Required events
  for (const e of constraints.requiredEvents || []) {
    if (eventIds.has(e)) satisfied.push(`event:${e}`);
    else missing.push(`event:${e}`);
  }

  // Children alive
  if (constraints.childrenAlive != null) {
    if (aliveChildren === constraints.childrenAlive) satisfied.push(`childrenAlive:${constraints.childrenAlive}`);
    else missing.push(`childrenAlive:${constraints.childrenAlive} (have ${aliveChildren})`);
  }

  // Children total
  if (constraints.childrenTotal != null) {
    if (totalChildren >= constraints.childrenTotal) satisfied.push(`childrenTotal:${constraints.childrenTotal}`);
    else missing.push(`childrenTotal:${constraints.childrenTotal} (have ${totalChildren})`);
  }

  // Attributes
  for (const [attr, val] of Object.entries(constraints.attributes || {})) {
    const actual = result.attributes?.[attr];
    if (actual === val) satisfied.push(`attr:${attr}=${val}`);
    else missing.push(`attr:${attr}=${val} (have ${actual})`);
  }

  return { satisfied, missing, forbidden };
}

// ─────────────────────────────────────────────────────────────────────────────
// INJECTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Inject missing constraints into a CharacterResult, mutating it in-place.
 *
 * @param  {object} result       - CharacterResult (mutated)
 * @param  {object} constraints  - Normalised constraint object
 * @returns {string[]}           - Log of injections performed
 */
function injectConstraints(result, constraints) {
  const log = [];
  const cls = result.socialClass || 'peasant';

  // Deterministic RNG seeded from result identity — same NPC → same child sexes
  const _injSeed = _injHash(
    String(result.birthYear ?? 0) + '_' +
    (typeof result.name === 'object' ? result.name?.full : result.name) + '_' +
    String(result.history?.length ?? 0) + '_' +
    String(result.children?.length ?? 0)
  );
  const rng = _injMkRng(_injSeed);

  // ── 1. Attributes — set directly ────────────────────────────────────────
  for (const [attr, val] of Object.entries(constraints.attributes || {})) {
    if (result.attributes[attr] !== val) {
      result.attributes[attr] = val;
      log.push(`SET attributes.${attr} = ${val}`);
    }
  }

  // ── 1b. Prerequisite chaining — inject precondition events first ─────────
  // Some conditions require an earlier condition to have been acquired.
  // Inject the prerequisite event before the dependent one if missing.
  const CONDITION_PREREQUISITES = {
    guild_master: { prereqCond: 'guild_member', prereqEvent: 'joined_guild', pool: 'biographical' },
    // Add more dependency pairs here as needed, e.g.:
    // knighted: { prereqCond: 'veteran', prereqEvent: 'military_campaign', pool: 'biographical' },
  };

  for (const cond of constraints.requiredConditions || []) {
    const prereq = CONDITION_PREREQUISITES[cond];
    if (!prereq) continue;

    const prereqAlreadyMet = result.conditions.includes(prereq.prereqCond) ||
      result.history.some(e => e.eventId === prereq.prereqEvent);
    if (prereqAlreadyMet) continue;

    // Find a slot that comes before the window for the dependent event
    const { min: depMin } = getAgeWindow(CONDITION_TO_EVENT[cond] || cond, cls);
    const prereqWindow    = getAgeWindow(prereq.prereqEvent, cls);
    const prereqTarget    = findInjectionTarget(
      result.history,
      prereq.prereqEvent,
      cls,
      prereq.pool
    );

    if (prereqTarget && prereqTarget.age < depMin) {
      const evDef = getEventDef(prereq.prereqEvent);
      const oldId = prereqTarget.eventId;
      prereqTarget.eventId    = prereq.prereqEvent;
      prereqTarget.eventLabel = evDef?.label || prereq.prereqEvent;
      prereqTarget.flavour    = (result.sex === 'female' ? evDef?.flavour?.female : evDef?.flavour?.male) || '';
      applyConditionAdds(result.conditions, evDef);
      applyConditionRemoves(result.conditions, evDef);
      _replayConditionsFrom(result.history, result.history.indexOf(prereqTarget));
      log.push(`INJECT prerequisite '${prereq.prereqEvent}' at age ${prereqTarget.age} (replaced '${oldId}') for '${cond}'`);
    } else {
      log.push(`SKIP prerequisite '${prereq.prereqEvent}' — no suitable slot before age ${depMin}`);
    }
  }

  // ── 2. Required conditions (and events that imply them) ──────────────────
  for (const cond of constraints.requiredConditions || []) {
    if (result.conditions.includes(cond)) continue;

    const eventId = CONDITION_TO_EVENT[cond];
    if (!eventId) {
      // Can't inject — add condition directly as a fallback
      result.conditions.push(cond);
      log.push(`DIRECT-ADD condition '${cond}' (no injection event known)`);
      continue;
    }

    const pool   = ['married','widowed','first_child_born','child_dies','spouse_dies'].includes(eventId)
      ? 'family' : 'biographical';
    const target = findInjectionTarget(result.history, eventId, cls, pool);
    if (!target) {
      result.conditions.push(cond);
      log.push(`DIRECT-ADD condition '${cond}' (no injection target found)`);
      continue;
    }

    const evDef = getEventDef(eventId);
    const oldId = target.eventId;
    target.eventId    = eventId;
    target.eventLabel = evDef?.label || eventId;
    target.flavour    = (result.sex === 'female' ? evDef?.flavour?.female : evDef?.flavour?.male) || '';

    // Apply condition changes from the injected event
    applyConditionAdds(result.conditions, evDef);
    applyConditionRemoves(result.conditions, evDef);

    // Update conditionsAfter for this entry and all subsequent ones
    _replayConditionsFrom(result.history, result.history.indexOf(target));

    log.push(`INJECT '${eventId}' at age ${target.age} (replaced '${oldId}') → adds condition '${cond}'`);
  }

  // ── 3. Required events (those not already covered by condition injection) ─
  for (const eventId of constraints.requiredEvents || []) {
    const alreadyPresent = result.history.some(e => e.eventId === eventId);
    if (alreadyPresent) continue;

    const pool   = ['married','first_child_born','child_dies','spouse_dies'].includes(eventId)
      ? 'family' : 'biographical';
    const target = findInjectionTarget(result.history, eventId, cls, pool);
    if (!target) {
      log.push(`SKIP event '${eventId}' — no injection target found`);
      continue;
    }

    const evDef = getEventDef(eventId);
    const oldId = target.eventId;
    target.eventId    = eventId;
    target.eventLabel = evDef?.label || eventId;
    target.flavour    = (result.sex === 'female' ? evDef?.flavour?.female : evDef?.flavour?.male) || '';

    applyConditionAdds(result.conditions, evDef);
    applyConditionRemoves(result.conditions, evDef);
    _replayConditionsFrom(result.history, result.history.indexOf(target));

    log.push(`INJECT event '${eventId}' at age ${target.age} (replaced '${oldId}')`);
  }

  // ── 4. Children ───────────────────────────────────────────────────────────
  const aliveNow  = () => result.children.filter(c => c.status === 'alive').length;
  const usedSlots = new Set();
  let   childIdx  = 0;

  // Inject alive children until count is met
  while (aliveNow() < (constraints.childrenAlive ?? 0)) {
    const target = result.history.find(e =>
      e.pool === 'family' && !usedSlots.has(e.age) && e.age >= 19 && e.age <= 38
    ) || result.history.find(e => e.pool === 'family' && !usedSlots.has(e.age));

    if (!target) { log.push('SKIP child injection — no unused family pool target'); break; }
    usedSlots.add(target.age);

    const evDef = getEventDef('first_child_born');
    const oldId = target.eventId;
    target.eventId    = 'first_child_born';
    target.eventLabel = evDef?.label || 'Child born';
    target.flavour    = (result.sex === 'female' ? evDef?.flavour?.female : evDef?.flavour?.male) || '';

    const childSex = rng() < 0.5 ? 'male' : 'female';
    const childName   = childSex === 'male'
      ? ['Aldric','Bram','Cavan','Donal','Edric'][childIdx % 5]
      : ['Aine','Brea','Ciara','Dana','Erin'][childIdx % 5];
    result.children.push({
      id:                  `child_injected_${childIdx}`,
      name:                childName,
      sex:              childSex,
      bornAtPrincipalAge:  target.age,
      status:              'alive',
      sourceEventId:       'first_child_born',
    });
    childIdx++;

    if (!result.conditions.includes('has_children')) result.conditions.push('has_children');
    // Can't be childless if we have children
    const clIdx = result.conditions.indexOf('childless');
    if (clIdx !== -1) result.conditions.splice(clIdx, 1);

    log.push(`INJECT first_child_born at age ${target.age} (replaced '${oldId}') + child '${childName}'`);
  }

  // If we have too MANY alive children, kill the excess via child_dies injection
  while (aliveNow() > (constraints.childrenAlive ?? aliveNow())) {
    // Find the most recently born alive child to mark as deceased
    const excess = [...result.children]
      .filter(c => c.status === 'alive')
      .sort((a, b) => (b.bornAtPrincipalAge ?? 0) - (a.bornAtPrincipalAge ?? 0))[0];
    if (!excess) break;

    excess.status             = 'deceased';
    excess.diedAtPrincipalAge = (excess.bornAtPrincipalAge ?? 0) + 2;

    // Find or create a family history entry for the child_dies event
    const killTarget = result.history.find(e =>
      e.pool === 'family' &&
      e.age  === excess.diedAtPrincipalAge &&
      !usedSlots.has(e.age)
    ) || result.history.find(e =>
      e.pool === 'family' &&
      e.age  >= (excess.bornAtPrincipalAge ?? 0) &&
      !usedSlots.has(e.age)
    );

    if (killTarget) {
      const evDef = getEventDef('child_dies');
      usedSlots.add(killTarget.age);
      killTarget.eventId      = 'child_dies';
      killTarget.eventLabel   = evDef?.label || 'Child dies';
      killTarget.flavour      = (result.sex === 'female' ? evDef?.flavour?.female : evDef?.flavour?.male) || '';
      killTarget.diedChildId  = excess.id;
      excess.diedAtPrincipalAge = killTarget.age;
      _replayConditionsFrom(result.history, result.history.indexOf(killTarget));
      log.push(`INJECT child_dies at age ${killTarget.age} for excess child '${excess.name}'`);
    } else {
      // No target slot — just mark dead silently
      log.push(`DIRECT-MARK '${excess.name}' deceased (no injection target for child_dies)`);
    }

    // Update has_children / childless based on remaining alive count
    if (aliveNow() === 0) {
      const idx = result.conditions.indexOf('has_children');
      if (idx !== -1) result.conditions.splice(idx, 1);
      if (!result.conditions.includes('childless')) result.conditions.push('childless');
    }
  }

  // Inject dead children if childrenTotal requires more births than we have
  const totalNow    = result.children.length;
  const totalDeficit = (constraints.childrenTotal ?? totalNow) - totalNow;
  for (let i = 0; i < totalDeficit; i++) {
    const target = result.history.find(e =>
      e.pool === 'family' && !usedSlots.has(e.age)
    );
    if (!target) { log.push('SKIP dead child injection — no unused family pool target'); continue; }
    usedSlots.add(target.age);

    const evDef = getEventDef('child_dies');
    const oldId = target.eventId;
    target.eventId    = 'child_dies';
    target.eventLabel = evDef?.label || 'Child dies';
    target.flavour    = (result.sex === 'female' ? evDef?.flavour?.female : evDef?.flavour?.male) || '';

    const childSex = rng() < 0.5 ? 'male' : 'female';
    const childName   = childSex === 'male'
      ? ['Fynn','Gareth','Hewn'][i % 3]
      : ['Fiona','Gwen','Hilde'][i % 3];
    result.children.push({
      id:                  `child_dead_injected_${i}`,
      name:                childName,
      sex:              childSex,
      bornAtPrincipalAge:  target.age - 1,
      diedAtPrincipalAge:  target.age,
      status:              'deceased',
      sourceEventId:       'child_dies',
    });

    log.push(`INJECT child_dies at age ${target.age} (replaced '${oldId}') + dead child '${childName}'`);
  }

  // ── 5. Marital status ────────────────────────────────────────────────────
  const hasMar    = result.conditions.includes('married');
  const hasWid    = result.conditions.includes('widowed');

  if (constraints.maritalStatus === 'married' && !hasMar) {
    const target = findInjectionTarget(result.history, 'married', cls, 'biographical');
    if (target) {
      const evDef = getEventDef('married');
      const oldId = target.eventId;
      target.eventId    = 'married';
      target.eventLabel = evDef?.label || 'Married';
      target.flavour    = (result.sex === 'female' ? evDef?.flavour?.female : evDef?.flavour?.male) || '';
      if (!result.conditions.includes('married')) result.conditions.push('married');
      log.push(`INJECT married at age ${target.age} (replaced '${oldId}')`);
    }
  }

  if (constraints.maritalStatus === 'widowed' && !hasWid) {
    // First ensure married exists and comes before any spouse_dies
    const existingMarried = result.history.find(e => e.eventId === 'married');
    if (!hasMar || !existingMarried) {
      const marTarget = findInjectionTarget(result.history, 'married', cls, 'biographical');
      if (marTarget) {
        const evDef = getEventDef('married');
        marTarget.eventId    = 'married';
        marTarget.eventLabel = evDef?.label || 'Married';
        marTarget.flavour    = (result.sex === 'female' ? evDef?.flavour?.female : evDef?.flavour?.male) || '';
        if (!result.conditions.includes('married')) result.conditions.push('married');
        log.push(`INJECT married at age ${marTarget.age} (prerequisite for widowed)`);
      }
    }

    // Inject spouse_dies at an age AFTER the married event
    const marAge  = result.history.find(e => e.eventId === 'married')?.age ?? 22;
    const widTarget = result.history.find(e =>
      (e.pool === 'family' || e.pool === 'biographical') &&
      (e.eventId === 'uneventful_year' || e.eventId === 'spouse_dies') &&
      e.age > marAge
    ) || result.history.find(e => e.age > marAge && e.pool === 'family');

    if (widTarget) {
      const evDef = getEventDef('spouse_dies');
      const oldId = widTarget.eventId;
      widTarget.eventId    = 'spouse_dies';
      widTarget.eventLabel = evDef?.label || 'Spouse dies';
      widTarget.flavour    = (result.sex === 'female' ? evDef?.flavour?.female : evDef?.flavour?.male) || '';
      result.conditions    = result.conditions.filter(c => c !== 'married');
      if (!result.conditions.includes('widowed')) result.conditions.push('widowed');
      log.push(`INJECT spouse_dies at age ${widTarget.age} (replaced '${oldId}')`);
    }
  }

  // ── 6. Forbidden conditions — remove if present ──────────────────────────
  for (const cond of constraints.forbiddenConditions || []) {
    const idx = result.conditions.indexOf(cond);
    if (idx !== -1) {
      result.conditions.splice(idx, 1);
      // Remove the event that added it from history (best-effort)
      const adderEvent = Object.entries(CONDITION_TO_EVENT).find(([c]) => c === cond)?.[1];
      if (adderEvent) {
        const histEntry = result.history.findLast?.(e => e.eventId === adderEvent)
          || [...result.history].reverse().find(e => e.eventId === adderEvent);
        if (histEntry) {
          histEntry.eventId    = 'uneventful_year';
          histEntry.eventLabel = 'Uneventful year';
          histEntry.flavour    = 'Nothing of note disturbed the rhythm of the year.';
          log.push(`REMOVE condition '${cond}': replaced '${adderEvent}' at age ${histEntry.age} with uneventful_year`);
        }
      } else {
        log.push(`REMOVE condition '${cond}' directly (no source event found)`);
      }
    }
  }

  return log;
}

/**
 * After injecting an event at a given history index, replay all subsequent
 * conditionsAfter snapshots so they accurately reflect the new state.
 * (Best-effort — full replay would require re-running resolveEvent.)
 */
function _replayConditionsFrom(history, fromIdx) {
  // Simplified: just update the entry at fromIdx and leave later entries
  // as-is. A full replay would need to re-execute all event effects,
  // which is out of scope for injection. The final result.conditions
  // is what's authoritative.
  if (fromIdx < 0 || fromIdx >= history.length) return;
  // Mark entry as injected for debugging
  history[fromIdx]._injected = true;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  verifyConstraints,
  injectConstraints,
  getAgeWindow,
  CONDITION_TO_EVENT,
  DEFAULT_AGE_WINDOWS,
};
