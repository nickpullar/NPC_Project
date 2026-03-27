'use strict';

/**
 * extended-family.js
 *
 * Generates a minimal extended family tree for an NPC:
 *   - Grandparents (cosmetic stubs: name, born, died/alive)
 *   - Paternal/maternal aunts & uncles (with their own family units)
 *   - Cousins (children of aunts/uncles)
 *   - Nephews/nieces (children of the principal's siblings)
 *
 * Each family unit (patriarch + wives + children) receives one shared
 * major event per 5 years since the eldest member turned 18.
 *
 * No biographical simulation — all random rolls, deterministic by seed.
 *
 * Relationship bands (principal ↔ each extended member):
 *   close | cordial | distant | estranged | hostile
 *
 * These are used by md-writer to render the extended family section.
 */

const { generateName } = require('./name-tables');

// ─────────────────────────────────────────────────────────────────────────────
// SEEDED RNG  (same LCG used elsewhere in the project)
// ─────────────────────────────────────────────────────────────────────────────
function mkRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = Math.imul(s, 1664525) + 1013904223 >>> 0;
    return s / 0x100000000;
  };
}

// Hash a string to a uint32 for seeding
function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
function pickW(rng, weighted) {
  // weighted: [[item, weight], ...]
  const total = weighted.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [item, w] of weighted) { r -= w; if (r <= 0) return item; }
  return weighted[weighted.length - 1][0];
}

// ─────────────────────────────────────────────────────────────────────────────
// FAMILY EVENTS  (one drawn per 5-year interval since eldest member turned 18)
// ─────────────────────────────────────────────────────────────────────────────
// Each event has a labels array; one is chosen at random when the event fires.
const FAMILY_EVENTS = [
  // Hardship
  { id: 'fire',          labels: ['Fire destroyed the home — rebuilt over two years', 'The workshop burned — a year\'s work gone', 'Fire took the roof; the family slept rough until spring'],         weight: 6 },
  { id: 'flood',         labels: ['Flood ruined the harvest and drove the family from their land for a season', 'The river rose and spoiled the stores', 'High water — no harvest worth speaking of'], weight: 5 },
  { id: 'plague',        labels: ['A fever swept through — one or two members did not survive', 'Sickness took the youngest; the rest recovered slowly', 'Plague year — the family came through, but not unmarked'], weight: 7 },
  { id: 'famine',        labels: ['A poor harvest year — the family went hungry', 'The stores ran short; winter was difficult', 'Lean year — they managed, but only just'],              weight: 8 },
  { id: 'robbery',       labels: ['Robbed on the road or raided at home; considerable loss', 'Brigands took the season\'s earnings', 'A bad road and worse luck — the family lost much'],  weight: 5 },
  { id: 'levy',          labels: ['Eldest son called up for levy service; gone a season', 'The levy took two men from the household for six months', 'War season — the young men went with the lord'],     weight: 6 },
  { id: 'debt',          labels: ['Bad debt forced sale of livestock or land', 'A venture went wrong; property had to be sold to cover it', 'Creditors came — the family shed what it could not keep'],                weight: 5 },
  // Fortune
  { id: 'harvest',       labels: ['Exceptional harvest — the best in years; modest surplus', 'The grain came in heavy — enough to sell and to spare', 'Good year; the stores were full before winter'],  weight: 7 },
  { id: 'inheritance',   labels: ['An unexpected inheritance changed the family\'s circumstances', 'A distant relative died and left something useful', 'Money came from a source no one had expected'],                    weight: 3 },
  { id: 'good_marriage', labels: ['A daughter married well — improved the family\'s connections', 'A good match was made; the family\'s standing improved with it', 'A son or daughter married above their station'],                weight: 4 },
  { id: 'patron',        labels: ['A patron took interest in the family — work and protection for a time', 'A lord\'s favour arrived and lasted several years', 'Patronage: reliable work and a degree of shelter from the usual risks'], weight: 3 },
  { id: 'promotion',     labels: ['A family member rose in guild or service rank', 'The eldest achieved journeyman status; prospects improved', 'Advancement — one of them moved up in their trade'],            weight: 4 },
  // Social
  { id: 'feud',          labels: ['A dispute with a neighbour turned into a lasting feud', 'Words became enmity; the family acquired an enemy', 'A boundary argument that never resolved'],    weight: 4 },
  { id: 'scandal',       labels: ['A family scandal — the particulars are not discussed', 'Something happened that the family prefers not to name', 'Disgrace of some kind; they moved past it eventually'],     weight: 3 },
  { id: 'pilgrimage',    labels: ['The family made a pilgrimage together — bonds renewed', 'They walked to the shrine; it did them good', 'A season of devotion brought the household closer together'],    weight: 4 },
  { id: 'death_father',  labels: ['Patriarch died — the family reorganised around the eldest son', 'The father died and the household changed shape around his absence', 'He died; his sons divided what remained and continued'], weight: 6 },
  { id: 'death_child',   labels: ['A child died — the family never quite recovered from it', 'They lost one of the young ones; the grief stayed a long time', 'A child\'s death — the kind of loss that changes a household permanently'], weight: 7 },
  { id: 'relocation',    labels: ['The family relocated to another settlement for work or opportunity', 'They moved — better prospects elsewhere, or worse prospects where they were', 'The family left their old settlement and began again'],    weight: 4 },
  { id: 'split',         labels: ['A dispute split the household — a branch went their own way', 'A falling-out divided the family permanently', 'Two brothers parted ways; the household became two households'], weight: 3 },
];

// ─────────────────────────────────────────────────────────────────────────────
// RELATIONSHIP BANDS
// ─────────────────────────────────────────────────────────────────────────────
// Probability weights by band. Pulled once per family unit, shared by all
// members of that unit (so all cousins from a given aunt have the same base
// relationship — then individual variation is ±1 step).
const UNIT_RELATIONSHIP_WEIGHTS = [
  ['close',     15],
  ['cordial',   35],
  ['distant',   30],
  ['estranged', 14],
  ['hostile',    6],
];

// One step warmer/cooler for individual members within a unit
const REL_STEPS = ['close', 'cordial', 'distant', 'estranged', 'hostile'];
function shiftRel(rel, rng) {
  const r = rng();
  if (r < 0.15) return REL_STEPS[Math.max(0, REL_STEPS.indexOf(rel) - 1)];  // warmer
  if (r < 0.30) return REL_STEPS[Math.min(4, REL_STEPS.indexOf(rel) + 1)];  // cooler
  return rel;
}

const REL_LABELS = {
  close:     'close',
  cordial:   'cordial',
  distant:   'distant',
  estranged: 'estranged — contact is rare and uncomfortable',
  hostile:   'hostile — active enmity; do not approach without care',
};

// ─────────────────────────────────────────────────────────────────────────────
// MORTALITY HELPERS
// ─────────────────────────────────────────────────────────────────────────────
// gameYear default: 720 TR
function rollStatus(rng, birthYear, gameYear = 720) {
  const age = gameYear - birthYear;
  if (age <= 0) return { status: 'alive', diedAge: null };
  // Rough pre-modern mortality curve
  const pDead = age >= 80 ? 0.98
              : age >= 70 ? 0.80
              : age >= 60 ? 0.55
              : age >= 50 ? 0.32
              : age >= 40 ? 0.18
              : age >= 30 ? 0.10
              :             0.05;
  if (rng() < pDead) {
    // Died somewhere between 18 and age
    const diedAge = Math.max(18, Math.round(18 + rng() * (age - 18)));
    return { status: 'deceased', diedAge };
  }
  return { status: 'alive', diedAge: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// GENERATE ONE FAMILY UNIT
// A unit = patriarch + 0-2 wives + 0-4 children, all minimal stubs
// ─────────────────────────────────────────────────────────────────────────────
function generateFamilyUnit(opts) {
  const {
    rng,
    patriarchName,     // { given, surname, full }
    patriarchBirthYear,
    socialClass,
    role,              // 'paternal_uncle' | 'maternal_uncle' | 'sibling'
    side,              // 'paternal' | 'maternal'
    gameYear = 720,
  } = opts;

  const patriarch = {
    given:     patriarchName.given,
    surname:   patriarchName.surname,
    name:      patriarchName.full,
    sex:       'male',
    birthYear: patriarchBirthYear,
    socialClass,
    role,
    side,
    ...rollStatus(rng, patriarchBirthYear, gameYear),
  };

  // 0-2 wives (sequential — first wife may be deceased)
  const wives = [];
  const nWives = pickW(rng, [[0, 5], [1, 65], [2, 30]]);
  for (let w = 0; w < nWives; w++) {
    const wifeBirthYear = patriarchBirthYear + Math.round((rng() * 10) - 2); // ±5 of patriarch
    const wifeName = generateName('female', socialClass);
    wives.push({
      given:     wifeName.given,
      name:      wifeName.full,
      sex:       'female',
      birthYear: wifeBirthYear,
      ...rollStatus(rng, wifeBirthYear, gameYear),
      isFirst:   w === 0,
    });
  }

  // Children (0-4, born between patriarch age 20-45)
  const nChildren = pickW(rng, [[0, 8], [1, 15], [2, 28], [3, 25], [4, 24]]);
  const children = [];
  for (let c = 0; c < nChildren; c++) {
    const fatherAgeAtBirth = 20 + Math.floor(rng() * 26); // 20-45
    const childBirthYear   = patriarchBirthYear + fatherAgeAtBirth;
    const childSex         = rng() < 0.5 ? 'male' : 'female';
    const childName        = generateName(childSex, socialClass);
    children.push({
      given:     childName.given,
      name:      childName.full,
      sex:       childSex,
      birthYear: childBirthYear,
      ...rollStatus(rng, childBirthYear, gameYear),
    });
  }
  // Sort by birth year
  children.sort((a, b) => a.birthYear - b.birthYear);

  // ── Family events ──────────────────────────────────────────────────────────
  // One event per 5-year interval since eldest member turned 18
  const eldestBirth = Math.min(patriarchBirthYear, ...wives.map(w => w.birthYear));
  const familyStart = eldestBirth + 18;
  const familyEvents = [];
  for (let yr = familyStart; yr < gameYear; yr += 5) {
    // Draw one event from the list, filtered to members alive at that year
    const _evtDef = pickW(rng, FAMILY_EVENTS.map(e => [e, e.weight]));
    // Label is chosen from the synonym array using the unit's seeded rng —
    // each family unit has a distinct derived seed (from patriarch name+birthYear)
    // so label choice varies per unit, preventing repetition in the chronicle.
    const evt = {
      id: _evtDef.id,
      label: _evtDef.labels[Math.floor(rng() * _evtDef.labels.length)],
      weight: _evtDef.weight,
    };
    // Members alive at this year (born before, not yet dead)
    const aliveAtYear = [patriarch, ...wives, ...children].filter(m => {
      if (m.birthYear > yr) return false;
      if (m.status === 'deceased' && m.diedAge != null) {
        const diedYear = m.birthYear + m.diedAge;
        if (diedYear < yr) return false;
      }
      return true;
    });
    if (aliveAtYear.length > 0) {
      familyEvents.push({ year: yr, eventId: evt.id, label: evt.label });
    }
  }

  return { patriarch, wives, children, familyEvents };
}

// ─────────────────────────────────────────────────────────────────────────────
// GENERATE GRANDPARENT PAIR (cosmetic only — name + rough dates)
// ─────────────────────────────────────────────────────────────────────────────
function generateGrandparentPair(rng, parentBirthYear, parentSurname, socialClass, side, gameYear = 720) {
  const gpBirthYear = parentBirthYear - (22 + Math.floor(rng() * 14)); // 22-35 years older than parent
  const gmBirthYear = gpBirthYear + Math.round((rng() * 8) - 4);       // ±4 of grandfather

  const gpName = generateName('male', socialClass);
  const gmName = generateName('female', socialClass);

  const grandfather = {
    given:     gpName.given,
    surname:   parentSurname,
    name:      `${gpName.given} ${parentSurname}`,
    sex:       'male',
    birthYear: gpBirthYear,
    ...rollStatus(rng, gpBirthYear, gameYear),
  };
  const grandmother = {
    given:     gmName.given,
    surname:   parentSurname,
    name:      `${gmName.given} ${parentSurname}`,
    sex:       'female',
    birthYear: gmBirthYear,
    ...rollStatus(rng, gmBirthYear, gameYear),
  };

  return { grandfather, grandmother, side };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate the full extended family for an NPC.
 *
 * @param {object} npc        — result of ageCharacter()
 * @param {object} opts
 *   @param {number} [opts.gameYear=720]
 * @returns {object} extendedFamily
 */
function generateExtendedFamily(npc, opts = {}) {
  const gameYear    = opts.gameYear ?? 720;
  const principalBY = npc.birthYear;
  const socialClass = npc.socialClass;

  // Seed: deterministic from principal's seed + a salt
  const baseSeed = hashStr(`${principalBY}-${npc.name || ''}-${socialClass}-extfam`);
  const rng      = mkRng(baseSeed);

  // ── GRANDPARENTS ────────────────────────────────────────────────────────────
  const father = npc.parents?.find(p => p.role === 'father' || p.role === 'foster_father');
  const mother = npc.parents?.find(p => p.role === 'mother' || p.role === 'foster_mother');

  const fSurname = father?.surname || npc.surname || 'Unknown';
  const mSurname = mother?.surname || npc.surname || 'Unknown';
  const fBY      = father?.birthYear ?? (principalBY - 28);
  const mBY      = mother?.birthYear ?? (principalBY - 26);

  const paternalGP = generateGrandparentPair(rng, fBY, fSurname, socialClass, 'paternal', gameYear);
  const maternalGP = generateGrandparentPair(rng, mBY, mSurname, socialClass, 'maternal', gameYear);

  // ── AUNT/UNCLE FAMILY UNITS (siblings of each parent) ────────────────────
  const nPaternalSibs = pickW(rng, [[0,10],[1,25],[2,30],[3,20],[4,15]]);
  const nMaternalSibs = pickW(rng, [[0,10],[1,25],[2,30],[3,20],[4,15]]);

  function buildUncleUnits(nSibs, parentBY, parentSurname, side) {
    const units = [];
    for (let i = 0; i < nSibs; i++) {
      const offset    = Math.round((rng() * 16) - 8);   // ±8 years of parent
      const uncBY     = parentBY + offset;
      const uncName   = generateName('male', socialClass);
      const unitSeed  = mkRng(hashStr(`${side}-${i}-${uncBY}-${uncName.given}`));
      const unitRel   = pickW(rng, UNIT_RELATIONSHIP_WEIGHTS);

      const unit = generateFamilyUnit({
        rng: unitSeed,
        patriarchName:     { ...uncName, surname: parentSurname, full: `${uncName.given} ${parentSurname}` },
        patriarchBirthYear: uncBY,
        socialClass,
        role:  side === 'paternal' ? 'paternal_uncle' : 'maternal_uncle',
        side,
        gameYear,
      });

      // Assign relationship to principal — unit-level base, then per-member variation
      unit.unitRelationship = unitRel;
      unit.patriarch.relationship = shiftRel(unitRel, rng);
      unit.wives.forEach(w  => { w.relationship  = shiftRel(unitRel, rng); });
      unit.children.forEach(c => { c.relationship = shiftRel(unitRel, rng); c.role = 'cousin'; });

      units.push(unit);
    }
    return units;
  }

  const paternalUnits = buildUncleUnits(nPaternalSibs, fBY, fSurname, 'paternal');
  const maternalUnits = buildUncleUnits(nMaternalSibs, mBY, mSurname, 'maternal');

  // ── NEPHEWS / NIECES (children of the principal's own siblings) ───────────
  const nephewNiece = [];
  for (const sib of (npc.siblings ?? [])) {
    if (sib.status === 'deceased') continue;
    const sibAge   = gameYear - sib.birthYear;
    if (sibAge < 20) continue;                 // too young for children
    const nKids    = pickW(rng, [[0,20],[1,25],[2,28],[3,18],[4,9]]);
    const sibRel   = sib.relationship ?? 'cordial';
    for (let k = 0; k < nKids; k++) {
      const kidAgeAtBirth = 20 + Math.floor(rng() * 18);
      const kidBY         = sib.birthYear + kidAgeAtBirth;
      if (kidBY >= gameYear) continue;          // not born yet
      const kidSex  = rng() < 0.5 ? 'male' : 'female';
      const kidName = generateName(kidSex, socialClass);
      nephewNiece.push({
        given:        kidName.given,
        name:         kidName.full,
        sex:          kidSex,
        birthYear:    kidBY,
        role:         rng() < 0.5 ? 'nephew' : 'niece',  // overwritten below
        parentName:   sib.name,
        relationship: shiftRel(sibRel, rng),
        ...rollStatus(rng, kidBY, gameYear),
      });
    }
  }
  // Correct sex-appropriate role
  nephewNiece.forEach(nn => { nn.role = nn.sex === 'male' ? 'nephew' : 'niece'; });

  return {
    grandparents: { paternal: paternalGP, maternal: maternalGP },
    paternalUnits,
    maternalUnits,
    nephewNiece,
  };
}

module.exports = { generateExtendedFamily };
