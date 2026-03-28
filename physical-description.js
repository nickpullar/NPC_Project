'use strict';
/**
 * physical-description.js
 *
 * Derives physical appearance from NPC attribute scores, conditions, and
 * history using the canonical HârnMaster character generation tables
 * (Character_Generation.pdf, page 6).
 *
 * Tables used verbatim from the rulebook:
 *   HEIGHT    54+4d6" male / 52+4d6" female (+ nobility +2", urban poor –2")
 *   FRAME     3d6 → Scant/Light/Medium/Heavy/Massive (affects weight, STR, AGL)
 *   WEIGHT    height/weight table + frame modifier (±10–20%)
 *   COMPLEXION  1d100: 01–27 Fair, 28–74 Medium, 75–00 Dark  (Hârnic human)
 *   HAIR COLOR  1d100: 01–40 Brown, 41–55 Black, 56–65 Red, 66–70 Silver, 71–00 Blond
 *               modified +25 for Fair complexion, –25 for Dark complexion
 *   EYE COLOR   1d100: 01–40 Hazel, 41–55 Gray, 56 Violet, 57–70 Green, 71–00 Blue
 *               modified +25 for Fair complexion, –25 for Dark complexion
 *
 * The NPC output contains no height/weight/hair/eye fields, so this module
 * generates them deterministically from the NPC seed with a distinct salt
 * (never touching the engine's global RNG state).
 *
 * Public API:
 *   generatePhysical(npc, seed)             → PhysicalProfile
 *   buildPhysicalPrompt(npc, profile)        → string
 *   generatePhysicalDescription(npc, seed)  → Promise<{ profile, description }>
 */

// ─────────────────────────────────────────────────────────────────────────────
// LOCAL SEEDED RNG  (xorshift32, salted to avoid collision with engine RNG)
// ─────────────────────────────────────────────────────────────────────────────

function makeRng(seed) {
  let s = ((seed || 0) ^ 0xf00dcafe) >>> 0;
  return function rand() {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

// Roll 1–100
function d100(rand) { return Math.floor(rand() * 100) + 1; }

// Roll NdX, return sum
function roll(rand, n, x) {
  let t = 0;
  for (let i = 0; i < n; i++) t += Math.floor(rand() * x) + 1;
  return t;
}

// ─────────────────────────────────────────────────────────────────────────────
// FRAME  [3d6]
// 01–05 Scant, 06–08 Light, 09–12 Medium, 13–15 Heavy, 16+ Massive
// Modifiers (to the 3d6 roll): Human Female –3
// ─────────────────────────────────────────────────────────────────────────────

function rollFrame(rand, sex) {
  let r = roll(rand, 3, 6);
  if (sex === 'female') r -= 3;
  if      (r <= 5)  return 'Scant';
  else if (r <= 8)  return 'Light';
  else if (r <= 12) return 'Medium';
  else if (r <= 15) return 'Heavy';
  else              return 'Massive';
}

const FRAME_WEIGHT_MOD = { Scant: -0.20, Light: -0.10, Medium: 0, Heavy: +0.10, Massive: +0.20 };
const FRAME_LABEL = {
  Scant:   'slight',
  Light:   'lean',
  Medium:  'medium',
  Heavy:   'stocky',
  Massive: 'heavily built',
};

// ─────────────────────────────────────────────────────────────────────────────
// HEIGHT  [54+4d6" male / 52+4d6" female]
// Class modifier: nobility +2", urban poor –2"
// ─────────────────────────────────────────────────────────────────────────────

const CLASS_HEIGHT_MOD_INCHES = {
  noble: +2, merchant: 0, warrior: 0, soldier: 0,
  artisan: 0, peasant: -1, clergy: 0,
};

// HârnMaster height/weight lookup table (inches → optimal weight in pounds)
// Reproduced from rulebook table (40"→75 lb through 89"→255 lb, 1" steps)
const HGT_WGT = {
  40:75,  41:77,  42:79,  43:81,  44:83,  45:85,  46:87,  47:89,  48:91,  49:93,
  50:95,  51:97,  52:100, 53:103, 54:106, 55:109, 56:112, 57:115, 58:118, 59:121,
  60:124, 61:127, 62:130, 63:133, 64:137, 65:141, 66:145, 67:149, 68:153, 69:157,
  70:160, 71:165, 72:170, 73:175, 74:180, 75:185, 76:190, 77:195, 78:200, 79:205,
  80:210, 81:215, 82:220, 83:225, 84:230, 85:235, 86:240, 87:245, 88:250, 89:255,
};

function deriveHeight(rand, sex, socialClass) {
  const base    = sex === 'male' ? 54 : 52;
  const dice    = roll(rand, 4, 6);
  const classMod = CLASS_HEIGHT_MOD_INCHES[socialClass] || 0;
  const inches  = base + dice + classMod;

  // Convert to cm (1" = 2.54 cm)
  const cm = Math.round(inches * 2.54);

  // Descriptive band (in inches)
  let band;
  if (sex === 'male') {
    if      (inches <= 63) band = 'short';
    else if (inches <= 66) band = 'below average height';
    else if (inches <= 70) band = 'average height';
    else if (inches <= 74) band = 'tall';
    else                   band = 'very tall';
  } else {
    if      (inches <= 61) band = 'short';
    else if (inches <= 64) band = 'below average height';
    else if (inches <= 67) band = 'average height';
    else if (inches <= 71) band = 'tall';
    else                   band = 'very tall';
  }

  return { inches, cm, band };
}

function deriveWeight(heightInches, frame) {
  const clampedH  = Math.max(40, Math.min(89, heightInches));
  const base      = HGT_WGT[clampedH] || 153;
  const mod       = FRAME_WEIGHT_MOD[frame] || 0;
  const lbs       = Math.round(base * (1 + mod));
  const kg        = Math.round(lbs * 0.4536);
  return { lbs, kg };
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPLEXION  [1d100, Hârnic human]
// 01–27 Fair, 28–74 Medium, 75–00 Dark
// ─────────────────────────────────────────────────────────────────────────────

function rollComplexion(rand) {
  const r = d100(rand);
  if (r <= 27) return 'Fair';
  if (r <= 74) return 'Medium';
  return 'Dark';
}

// ─────────────────────────────────────────────────────────────────────────────
// HAIR COLOR  [1d100, modified ±25 for complexion]
// Base: 01–40 Brown, 41–55 Black, 56–65 Red, 66–70 Silver, 71–00 Blond
// +25 for Fair complexion, –25 for Dark complexion
// ─────────────────────────────────────────────────────────────────────────────

function rollHairColour(rand, complexion, age) {
  let r = d100(rand);
  if (complexion === 'Fair') r = Math.min(100, r + 25);
  if (complexion === 'Dark') r = Math.max(1,   r - 25);

  let colour;
  if      (r <= 40) colour = 'brown';
  else if (r <= 55) colour = 'black';
  else if (r <= 65) colour = 'red';
  else if (r <= 70) colour = 'silver';
  else              colour = 'blond';

  // Age greying — the table gives "colour of youth"; add grey for older NPCs
  if (age >= 62 && colour !== 'silver' && rand() < 0.80) colour = 'white';
  else if (age >= 52 && colour !== 'silver' && rand() < 0.55) colour = 'grey';
  else if (age >= 44 && colour !== 'silver' && rand() < 0.30) colour = `greying ${colour}`;

  return colour;
}

// ─────────────────────────────────────────────────────────────────────────────
// HAIR LENGTH  (not in rulebook — GM/NPC convention)
// ─────────────────────────────────────────────────────────────────────────────

const HAIR_LENGTH_TABLE = {
  male:   [[20,'close-cropped'],[38,'short'],[28,'collar-length'],[10,'shoulder-length'],[4,'long']],
  female: [[8,'short'],[14,'collar-length'],[30,'shoulder-length'],[34,'long'],[14,'braided']],
};

function rollHairLength(rand, sex) {
  const table = HAIR_LENGTH_TABLE[sex] || HAIR_LENGTH_TABLE.male;
  const total = table.reduce((n, [w]) => n + w, 0);
  let r = rand() * total;
  for (const [weight, label] of table) {
    r -= weight;
    if (r <= 0) return label;
  }
  return table[table.length - 1][1];
}

// ─────────────────────────────────────────────────────────────────────────────
// EYE COLOR  [1d100, modified ±25 for complexion]
// Base: 01–40 Hazel, 41–55 Gray, 56 Violet, 57–70 Green, 71–00 Blue
// +25 for Fair complexion, –25 for Dark complexion
// ─────────────────────────────────────────────────────────────────────────────

function rollEyeColour(rand, complexion) {
  let r = d100(rand);
  if (complexion === 'Fair') r = Math.min(100, r + 25);
  if (complexion === 'Dark') r = Math.max(1,   r - 25);

  if      (r <= 40) return 'hazel';
  else if (r <= 55) return 'grey';
  else if (r === 56) return 'violet';
  else if (r <= 70) return 'green';
  else              return 'blue';
}

// ─────────────────────────────────────────────────────────────────────────────
// APPARENT AGE  (from conditions)
// ─────────────────────────────────────────────────────────────────────────────

function deriveApparentAge(actualAge, conditions) {
  let offset = 0;
  if (conditions.includes('chronic_illness')) offset += 6;
  if (conditions.includes('robust'))          offset -= 3;
  if (conditions.includes('lame'))            offset += 2;
  if (conditions.includes('scarred'))         offset += 1;
  const apparent = actualAge + offset;
  if (Math.abs(apparent - actualAge) <= 2) return null;
  return apparent > actualAge ? 'looks older than their years' : 'looks younger than their years';
}

// ─────────────────────────────────────────────────────────────────────────────
// SCARS AND MARKS  (from history and conditions)
// ─────────────────────────────────────────────────────────────────────────────

const INJURY_IDS = new Set([
  'significant_injury', 'serious_wound', 'war_wound',
  'old_injury_worsens',  'branded_or_mutilated',
]);

function collectMarks(history, conditions) {
  const marks = [];

  for (const h of history) {
    if (INJURY_IDS.has(h.eventId) && h.flavourNote) {
      // Strip mechanical notation like "(−1 to CML)" or "(approx. −1)"
      marks.push(h.flavourNote.replace(/\s*[([{][^)\]}]*[)\]}]/g, '').trim());
    }
  }

  // Condition fallbacks when no injury events recorded the flavourNote
  if (!marks.some(m => /scar/i.test(m)) && conditions.includes('scarred')) {
    marks.push('carries a visible scar');
  }
  if (!marks.some(m => /limp|leg|foot|knee/i.test(m)) && conditions.includes('lame')) {
    marks.push('walks with a permanent limp');
  }
  if (conditions.includes('branded')) {
    marks.push('bears a criminal brand on the ear or cheek');
  }

  return marks;
}

// ─────────────────────────────────────────────────────────────────────────────
// CML → appearance note  (only call out the extremes)
// ─────────────────────────────────────────────────────────────────────────────

function appearanceNote(cml, sex) {
  // Rulebook: 01–05 Ugly, 06–08 Plain, 09–12 Average, 13–15 Attractive, 16+ Handsome
  if (cml >= 16) return sex === 'female' ? 'markedly attractive' : 'markedly good-looking';
  if (cml >= 14) return 'good-looking';
  if (cml <= 5)  return 'notably plain-featured';
  if (cml <= 8)  return 'plain-featured';
  return null;  // 9–13: say nothing, let the prose carry it
}

// ─────────────────────────────────────────────────────────────────────────────
// resolveHeightBand — convert engine-rolled inches to { inches, cm, band }
// ─────────────────────────────────────────────────────────────────────────────

function resolveHeightBand(inches, sex) {
  const cm = Math.round(inches * 2.54);
  const maleBands   = [[63,'short'],[66,'below average height'],[70,'average height'],[74,'tall'],[999,'very tall']];
  const femaleBands = [[61,'short'],[64,'below average height'],[67,'average height'],[71,'tall'],[999,'very tall']];
  const bands = sex === 'male' ? maleBands : femaleBands;
  let band = 'average height';
  for (const [threshold, label] of bands) {
    if (inches <= threshold) { band = label; break; }
  }
  return { inches, cm, band };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN: generatePhysical
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a full physical profile for an NPC.
 *
 * @param {object} npc    — ageCharacter() output
 * @param {number} seed   — same seed used to generate the NPC
 * @returns {PhysicalProfile}
 */
function generatePhysical(npc, seed) {
  const rand = makeRng(seed);
  const { attributes: attrs, sex, socialClass, age, conditions, history } = npc;

  // Frame, height, and weight are rolled by aging-engine.js at creation and
  // stored as private fields on attrs (_frame, _heightIn, _weightLbs).
  // Use them directly when present; fall back to re-rolling for NPCs generated
  // without attribute rolling (e.g. tests passing attributes: null).
  const frame  = attrs._frame  || rollFrame(rand, sex);
  const height = attrs._heightIn
    ? resolveHeightBand(attrs._heightIn, sex)
    : deriveHeight(rand, sex, socialClass);
  const weight = attrs._weightLbs
    ? { lbs: attrs._weightLbs, kg: Math.round(attrs._weightLbs * 0.4536) }
    : deriveWeight(height.inches, frame);

  const complexion = rollComplexion(rand);
  const hairColour = rollHairColour(rand, complexion, age);
  const hairLength = rollHairLength(rand, sex);
  const eyeColour  = rollEyeColour(rand, complexion);
  const apparent   = deriveApparentAge(age, conditions);
  const marks      = collectMarks(history || [], conditions);
  const appearance = appearanceNote(attrs.CML, sex);

  return {
    frame,
    heightInches: height.inches,
    heightCm:     height.cm,
    heightBand:   height.band,
    weightLbs:    weight.lbs,
    weightKg:     weight.kg,
    complexion,
    hairColour,
    hairLength,
    eyeColour,
    apparentAge:  apparent,    // string | null
    marks,                     // string[]
    appearance,                // string | null
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// buildPhysicalPrompt
// ─────────────────────────────────────────────────────────────────────────────

function buildPhysicalPrompt(npc, profile) {
  const name = npc.name?.full || `a ${npc.sex} ${npc.socialClass}`;
  const lines = [
    `NAME: ${name}`,
    `AGE: ${npc.age}  |  SEX: ${npc.sex}  |  CLASS: ${npc.socialClass}`,
    ``,
    `HEIGHT:     ${profile.heightBand} (${profile.heightInches}", ${profile.heightCm} cm)`,
    `FRAME:      ${profile.frame}  (${FRAME_LABEL[profile.frame]})`,
    `WEIGHT:     ${profile.weightLbs} lbs / ${profile.weightKg} kg`,
    `COMPLEXION: ${profile.complexion}`,
    `HAIR:       ${profile.hairLength}, ${profile.hairColour}`,
    `EYES:       ${profile.eyeColour}`,
  ];
  if (profile.apparentAge)  lines.push(`APPARENT AGE: ${profile.apparentAge}`);
  if (profile.appearance)   lines.push(`APPEARANCE:   ${profile.appearance}`);
  if (profile.marks.length) {
    lines.push(`SCARS / MARKS:`);
    profile.marks.forEach(m => lines.push(`  - ${m}`));
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM PROMPT
// ─────────────────────────────────────────────────────────────────────────────

const PHYSICAL_SYSTEM_PROMPT = `You write physical descriptions of NPCs for a HârnWorld tabletop RPG campaign set in the Kingdom of Kaldor — a grounded medieval fantasy world with no magic in everyday life.

Write exactly one paragraph. Target 95–110 words. Nothing else — no preamble, no heading, no sign-off.

RULES:
- Third person, present tense throughout ("She is...", "He has...")
- Begin with the single most immediately noticeable thing — height, build, or a dominant feature
- Work from there to face, colouring, then any marks or scars
- Scars and marks MUST be included if provided — weave them into the prose naturally, do not list them at the end
- Do not infer personality, mood, or character from physical appearance
- Do not mention clothing, occupation, or social class
- Do not use these words: striking, piercing, weathered, rugged, notable, formidable, intense
- Count your words carefully — stay within 95–110`;

// ─────────────────────────────────────────────────────────────────────────────
// API CALL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} npc
 * @param {number} seed
 * @returns {Promise<{ profile: PhysicalProfile, description: string }>}
 */
async function generatePhysicalDescription(npc, seed) {
  const profile = generatePhysical(npc, seed);
  const prompt  = buildPhysicalPrompt(npc, profile);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY environment variable is required for generatePhysicalDescription. ' +
      'Set it before calling this function, or use generatePhysical() for the non-AI path.'
    );
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':    'application/json',
      'x-api-key':       apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 250,
      system:     PHYSICAL_SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: `Write a physical description for:\n\n${prompt}` }],
    }),
  });

  if (!response.ok) throw new Error(`API error ${response.status}: ${await response.text()}`);
  const data = await response.json();

  return {
    profile,
    description: data.content.filter(b => b.type === 'text').map(b => b.text).join(''),
  };
}

module.exports = {
  generatePhysical,
  buildPhysicalPrompt,
  generatePhysicalDescription,
  PHYSICAL_SYSTEM_PROMPT,
  FRAME_LABEL,
};
