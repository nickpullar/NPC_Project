#!/usr/bin/env node
'use strict';

const { rand } = require('./rng');

/**
 * Kaldor NPC Name Tables
 *
 * Generates culturally appropriate names for the Kingdom of Kaldor.
 * Names are drawn from HârnWorld sources — Hârnic/Lythian naming conventions
 * with class-weighted surname patterns.
 *
 * NAMING CONVENTIONS
 * ──────────────────
 * Noble:        Given + family surname  (e.g. Aldric Meleken)
 * Merchant:     Given + trade/place surname (e.g. Koris Tannersworth)
 * Clergy:       Given + epithet or order suffix (e.g. Beren of Larani)
 * Warrior:      Given + patronymic or nickname (e.g. Tavin Ironhand)
 * Soldier:      Given + patronymic (e.g. Wulf Erikson)
 * Peasant:      Given only, or Given + village/father (e.g. Tam, or Tam Millerson)
 * Craftsperson: Given + craft surname (e.g. Mira Weaver)
 */

// ─────────────────────────────────────────────────────────────────────────────
// GIVEN NAMES
// ─────────────────────────────────────────────────────────────────────────────

const MALE_NAMES = [
  // Common Hârnic
  'Aldric','Alric','Arnam','Arven','Beren','Borik','Brand','Bram',
  'Cade','Cador','Corin','Davin','Deric','Dorin','Durst','Edric',
  'Erek','Erlan','Evan','Fenric','Garan','Gareth','Gerin','Gorin',
  'Hadric','Halden','Halric','Horic','Hrolf','Idris','Jorin','Kael',
  'Kavan','Kelan','Kern','Kuric','Laric','Loran','Lothar','Lucan',
  'Mael','Malik','Marek','Meric','Morin','Noric','Orin','Osric',
  'Perin','Ranulf','Rhoric','Rodric','Ronan','Rorik','Ruald','Seric',
  'Stevan','Tavin','Theric','Torin','Tovan','Trovan','Ulric','Uther',
  'Varen','Vorin','Warin','Wulf','Yorin','Zoric',
  // Kaldoric variants
  'Antor','Balar','Cavan','Dalric','Elric','Fardan','Gotar','Harlan',
  'Iric','Joran','Koral','Levan','Morak','Noral','Orlan','Pedar',
  'Roric','Soran','Talar','Ulan','Voran','Woran','Xarin','Yoric',
];

const FEMALE_NAMES = [
  // Common Hârnic
  'Aela','Aerin','Alara','Alda','Aldis','Aleth','Alura','Amara',
  'Andar','Annis','Arden','Arith','Arwen','Beira','Belyn','Berith',
  'Branna','Breda','Britta','Calla','Caris','Carith','Celyn','Ceris',
  'Dalla','Dara','Delia','Delyn','Dera','Deva','Disa','Eara',
  'Edda','Edris','Elara','Elda','Elith','Elora','Elva','Emra',
  'Erith','Estra','Fara','Farath','Gara','Garith','Geda','Geira',
  'Halla','Helda','Helra','Ida','Idra','Inda','Irda','Ista',
  'Kara','Karith','Kela','Kelyn','Lara','Larith','Leda','Leira',
  'Mara','Marath','Marta','Melda','Melyn','Mira','Mora','Morath',
  'Nara','Narith','Neda','Neira','Nora','Norath','Orla','Orith',
  'Rara','Rarith','Reda','Rira','Rora','Rorath','Sara','Sarath',
  'Selda','Selyn','Sera','Sira','Sirath','Tala','Talith','Tara',
  'Tarath','Teda','Tera','Terath','Ulda','Ulra','Vala','Valith',
  'Vara','Varath','Wela','Welith','Yara','Yarath','Zara','Zarath',
];

// ─────────────────────────────────────────────────────────────────────────────
// SURNAME COMPONENTS BY CLASS
// ─────────────────────────────────────────────────────────────────────────────

// Noble family names — ancient, often place-linked
const NOBLE_SURNAMES = [
  'Abriel','Aldane','Alendyl','Amble','Aramin','Arend','Arensten',
  'Balendi','Baramin','Barend','Belekar','Blaine','Brannek',
  'Caldane','Calendi','Carveth','Casendi','Chelkar',
  'Dalendi','Darekar','Darkend','Delamere','Denkar',
  'Edanel','Elendyl','Elenkar','Elenshen',
  'Falendi','Falekar','Faramin','Farekar',
  'Gaelend','Galenkar','Galenshen','Garekar',
  'Halendi','Halekar','Haramin','Harekar',
  'Ilendi','Ilenkar','Ilenshen',
  'Jalendi','Jalekar',
  'Kalendi','Kalekar','Karamin','Karekar',
  'Lalendi','Lalekar','Laramin',
  'Malendi','Malekar','Maramin','Marekar','Meleken',
  'Nalendi','Nalekar','Naramin',
  'Olendi','Olekar','Oramin',
  'Palendi','Palekar','Paramin',
  'Ralendi','Ralekar','Raramin',
  'Salendi','Salekar','Saramin','Sarenkar',
  'Talendi','Talekar','Taramin',
  'Ulendi','Ulekar','Uramin',
  'Valendi','Valekar','Varamin',
  'Walendi','Walekar',
  'Yaramin','Yarekar',
  'Zaramin','Zarekar',
];

// Merchant surnames — trade and origin based
const MERCHANT_SURNAMES = [
  'Amberton','Barrelworth','Brightcoin','Broadsale',
  'Cargoham','Coinsworth','Coppergate',
  'Deepsack','Dustmantle',
  'Fairmarket','Fartrader','Finecoin',
  'Goldcloak','Goodbarrel','Greatscale',
  'Harborside','Heavypurse',
  'Ironworth',
  'Keenscale',
  'Longhaul','Longmarket',
  'Marketham','Millworth',
  'Oakbarrel','Oldcoin',
  'Packworth','Plaintrader',
  'Richgate','Rivergate',
  'Saltworth','Silverscale','Strongpurse',
  'Tannersworth','Thickpurse','Tradesworth',
  'Wainworth','Wealthgate','Westmarket',
];

// Patronymic suffixes for soldier/warrior/peasant
const PATRONYMIC_SUFFIXES = [
  'son','sen','kin','ing','man',
];

// Male roots for patronymics
const PATRONYMIC_ROOTS = [
  'Al','Ar','Bor','Bran','Cor','Dal','Dor','Ed',
  'El','Er','Gar','Gon','Hal','Har','Hor','Id',
  'Kal','Kar','Kor','Lan','Lor','Mal','Mar','Mor',
  'Nor','Or','Par','Ral','Ror','Sal','Sor','Tar',
  'Tor','Ul','Val','Vor','Wal','War','Wol','Yor',
];

// Craft surnames
const CRAFT_SURNAMES = [
  'Blacksmith','Bowyer','Brewer','Butcher',
  'Carpenter','Carter','Cooper','Cordwainer',
  'Dyer',
  'Fletcher','Fuller',
  'Glazier','Grinder',
  'Harper','Hayward',
  'Joiner',
  'Mason','Miller','Millward',
  'Potter',
  'Sawyer','Shoemaker','Skinner','Slater','Smith',
  'Tanner','Thatcher','Turner',
  'Weaver','Wheeler','Wright',
];

// ─────────────────────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

function pickRandom(arr) {
  return arr[Math.floor(rand() * arr.length)];
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

// ─────────────────────────────────────────────────────────────────────────────
// SURNAME GENERATORS BY CLASS
// ─────────────────────────────────────────────────────────────────────────────

function nobleSurname()       { return pickRandom(NOBLE_SURNAMES); }
function merchantSurname()    { return pickRandom(MERCHANT_SURNAMES); }
function craftSurname()       { return pickRandom(CRAFT_SURNAMES); }

function patronymic(sex) {
  const root   = pickRandom(PATRONYMIC_ROOTS);
  const suffix = pickRandom(PATRONYMIC_SUFFIXES);
  // Female patronymics: -dottir / -daughter variants exist but are rare in Kaldor
  // Default to same form for simplicity
  return root + suffix;
}

/**
 * Generate a surname appropriate to the social class.
 * @param {string} socialClass
 * @param {string} sex  'male' | 'female'
 * @returns {string}
 */
function generateSurname(socialClass, sex) {
  switch (socialClass) {
    case 'noble':        return nobleSurname();
    case 'merchant':     return merchantSurname();
    case 'artisan': return craftSurname();
    case 'clergy':       return null;   // clergy use epithet/order, not surname
    case 'warrior':
    case 'soldier':
    case 'peasant':
    default:             return patronymic(sex);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN GENERATOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a full name for an NPC.
 *
 * @param {string}      sex       'male' | 'female'
 * @param {string}      socialClass  one of the seven classes
 * @param {object|null} opts
 *   opts.surname  {string}  Override surname (e.g. for spouse taking family name)
 *   opts.noSurname {bool}   Force given-name only
 *
 * @returns {{ given: string, surname: string|null, full: string }}
 */
function generateName(sex, socialClass, opts = {}) {
  const given = sex === 'female'
    ? pickRandom(FEMALE_NAMES)
    : pickRandom(MALE_NAMES);

  let surname = null;

  if (!opts.noSurname) {
    surname = opts.surname
      ? opts.surname
      : generateSurname(socialClass, sex);
  }

  const full = surname ? `${given} ${surname}` : given;

  return { given, surname, full };
}

/**
 * Generate a spouse name.
 * Noble spouses share the principal's surname.
 * Other classes get their own surname.
 *
 * @param {string} sex
 * @param {string} socialClass
 * @param {string|null} principalSurname  — passed for noble spouses
 * @returns {{ given, surname, full }}
 */
function generateSpouseName(sex, socialClass, principalSurname = null) {
  if (socialClass === 'noble' && principalSurname) {
    return generateName(sex, socialClass, { surname: principalSurname });
  }
  return generateName(sex, socialClass);
}

/**
 * Generate a child name, inheriting the family surname.
 *
 * @param {string} sex
 * @param {string} socialClass
 * @param {string|null} familySurname
 * @returns {{ given, surname, full }}
 */
function generateChildName(sex, socialClass, familySurname = null) {
  return generateName(sex, socialClass, {
    surname:   familySurname,
    noSurname: !familySurname,
  });
}

/**
 * Generate a slug-safe vault ID from a name and location.
 * e.g. 'Marta Kendarson' + 'Tashal' → 'marta-kendarson-tashal'
 */
function generateVaultId(fullName, location = '') {
  const base = [fullName, location]
    .filter(Boolean)
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base;
}

/**
 * Generate a lightweight stub record for a spouse.
 *
 * @param {object} opts
 *   sex              {string}
 *   socialClass         {string}
 *   principalSurname    {string|null}
 *   principalAge        {number}      — principal's current age at time of marriage
 *   ageOffset           {number}      — spouse age relative to principal (default random ±8)
 *
 * @returns {object} LightweightSpouse
 */
function generateSpouseStub(opts) {
  const {
    sex,
    socialClass,
    principalSurname = null,
    principalAge,
    ageOffset        = null,
  } = opts;

  // Spouse age: within ±8 years of principal, biased slightly younger for females
  const offset = ageOffset !== null
    ? ageOffset
    : (sex === 'female'
        ? -Math.floor(rand() * 8)          // female spouses tend younger
        : Math.floor((rand() - 0.3) * 10)  // male spouses cluster near same age
      );

  const ageAtMarriage = Math.max(16, principalAge + offset);
  const name          = generateSpouseName(sex, socialClass, principalSurname);
  const rhPositive    = rand() < 0.85;

  return {
    id:                  generateVaultId(name.full),
    type:                'lightweight',
    role:                'spouse',
    name:                name.full,
    given:               name.given,
    surname:             name.surname,
    sex,
    socialClass,
    rhPositive,
    ageAtMarriage,
    marriedAtPrincipalAge: principalAge,
    status:              'alive',
    diedAge:             null,
    diedAtPrincipalAge:  null,
  };
}

/**
 * Generate a lightweight stub record for a child.
 *
 * @param {object} opts
 *   motherRhPositive   {bool}
 *   fatherRhPositive   {bool}
 *   familySurname      {string|null}
 *   socialClass        {string}
 *   bornAtPrincipalAge {number}
 *   motherId           {string}
 *   fatherId           {string|null}
 *
 * @returns {object} LightweightChild
 */
function generateChildStub(opts) {
  const {
    motherRhPositive,
    fatherRhPositive,
    familySurname      = null,
    socialClass,
    bornAtPrincipalAge,
    motherId,
    fatherId           = null,
    existingGivenNames = [],   // Fix I: collision guard
    disability         = null, // null | 'lame' | 'blind' | 'deaf' | 'simple'
  } = opts;

  const sex = rand() < 0.5 ? 'male' : 'female';

  // Fix I: retry up to 5 times to avoid duplicate given names among siblings
  let name;
  for (let attempt = 0; attempt < 5; attempt++) {
    name = generateChildName(sex, socialClass, familySurname);
    if (!existingGivenNames.includes(name.given)) break;
  }

  // Rh type inheritance:
  //   Both parents Rh-negative  → child always Rh-negative
  //   Mother Rh-neg, Father Rh-pos → 50% chance child Rh-positive
  //   Either parent Rh-positive (homozygous likely) → high chance Rh-positive
  //   Simplified: if father Rh-pos, 50/50; if father Rh-neg, child Rh-neg
  let rhPositive;
  if (!fatherRhPositive) {
    rhPositive = false;
  } else if (!motherRhPositive) {
    rhPositive = rand() < 0.5;
  } else {
    rhPositive = rand() < 0.9;  // both positive → almost certainly positive
  }

  return {
    id:                  generateVaultId(name.full) + '-child',
    type:                'lightweight',
    role:                'child',
    name:                name.full,
    given:               name.given,
    surname:             name.surname,
    sex,
    socialClass,
    rhPositive,
    bornAtPrincipalAge,
    status:              'alive',
    diedAge:             null,
    diedAtPrincipalAge:  null,
    motherId,
    fatherId,
    disability,          // null or 'lame'|'blind'|'deaf'|'simple'
  };
}

/**
 * Generate a lightweight stub for a named third party implied by a life event.
 * Used for comrades, enemies, contacts, masters, dependents, etc.
 *
 * @param {object} opts
 *   role              {string}  e.g. 'comrade', 'enemy', 'contact', 'master', 'apprentice', 'dependent'
 *   sex            {string}  'male'|'female'|null (null → random)
 *   socialClass       {string}  social class of the contact
 *   principalAge      {number}  age of the principal at time of event
 *   ageOffsetMin      {number}  min age offset from principal (default -10)
 *   ageOffsetMax      {number}  max age offset from principal (default +10)
 *   eventId           {string}  the triggering event ID
 *   metAtPrincipalAge {number}  principal's age when they met (same as principalAge usually)
 *   status            {string}  'alive'|'deceased' (default 'alive')
 *   note              {string|null} optional free-text context
 *
 * @returns {object} LightweightContact
 */
function generateContactStub(opts) {
  const {
    role,
    sex:          sexIn     = null,
    socialClass,
    principalAge,
    ageOffsetMin     = -10,
    ageOffsetMax     = +10,
    eventId,
    metAtPrincipalAge,
    status           = 'alive',
    note             = null,
  } = opts;

  const sex  = sexIn || (rand() < 0.5 ? 'male' : 'female');
  const offset  = Math.floor(rand() * (ageOffsetMax - ageOffsetMin + 1)) + ageOffsetMin;
  const ageAtMeeting = Math.max(12, principalAge + offset);
  const name    = generateName(sex, socialClass);

  // relationshipBand: initial quality of the relationship.
  // 'close' = trusted ally/friend, 'neutral' = professional acquaintance,
  // 'strained' = uneasy, 'hostile' = enemy. Defaults to role-appropriate value.
  const defaultBands = {
    comrade:    'close',
    enemy:      'hostile',
    contact:    'neutral',
    master:     'neutral',
    apprentice: 'neutral',
    dependent:  'close',
  };
  const relationshipBand = opts.relationshipBand ?? defaultBands[role] ?? 'neutral';

  return {
    id:                  generateVaultId(name.full) + `-${role}`,
    type:                'lightweight',
    role,
    name:                name.full,
    given:               name.given,
    surname:             name.surname,
    sex,
    socialClass,
    ageAtMeeting,
    metAtPrincipalAge,
    sourceEventId:       eventId,
    status,
    diedAge:             null,
    diedAtPrincipalAge:  null,
    note,
    relationshipBand,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PARENT STUB GENERATOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a lightweight stub for a parent (biological, foster, adoptive, or step).
 *
 * @param {object} opts
 *   role            {string}  'father'|'mother'|'foster_father'|'foster_mother'|
 *                             'adoptive_father'|'adoptive_mother'|
 *                             'step_father'|'step_mother'
 *   socialClass     {string}
 *   principalBirthYear {number}
 *   principalSurname   {string|null}
 *   status          {string}  'alive'|'deceased'|'absent'|'unknown'
 *   ageAtPrincipalBirth {number|null}  generated if null
 *   remarried       {bool}    true if this parent has remarried
 *
 * @returns {object} LightweightParent
 */
function generateParentStub(opts) {
  const {
    role,
    socialClass,
    principalBirthYear,
    principalSurname = null,
    status           = 'alive',
    ageAtPrincipalBirth = null,
    remarried        = false,
  } = opts;

  const isFather   = role.includes('father');
  const sex     = isFather ? 'male' : 'female';
  const isNatural  = role === 'father' || role === 'mother';

  // Age at principal's birth: fathers 22-45, mothers 18-35
  const ageAtBirth = ageAtPrincipalBirth !== null
    ? ageAtPrincipalBirth
    : isFather
      ? Math.floor(rand() * 24) + 22   // 22–45
      : Math.floor(rand() * 18) + 18;  // 18–35

  // Name: natural parents share the family surname; others have their own
  const name = isNatural
    ? generateSpouseName(sex, socialClass, principalSurname)
    : generateName(sex, socialClass);

  const rhPositive = rand() < 0.85;

  return {
    id:                  generateVaultId(name.full) + '-parent',
    type:                'lightweight',
    role,
    name:                name.full,
    given:               name.given,
    surname:             name.surname,
    sex,
    socialClass,
    rhPositive,
    ageAtPrincipalBirth: ageAtBirth,
    birthYear:           principalBirthYear - ageAtBirth,
    status,
    diedAge:             null,
    remarried,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SIBLING STUB GENERATOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a lightweight stub for a sibling.
 *
 * @param {object} opts
 *   socialClass        {string}
 *   principalBirthYear {number}
 *   familySurname      {string|null}
 *   birthOrderOffset   {number}  negative = elder, positive = younger
 *   existingGivenNames {string[]}
 *   estrangementLevel  {number}  0=close, 1=distant, 2=estranged
 *
 * @returns {object} LightweightSibling
 */
function generateSiblingStub(opts) {
  const {
    socialClass,
    principalBirthYear,
    familySurname      = null,
    birthOrderOffset   = 0,
    existingGivenNames = [],
    estrangementLevel  = 0,
  } = opts;

  const sex = rand() < 0.5 ? 'male' : 'female';

  let name;
  for (let attempt = 0; attempt < 5; attempt++) {
    name = generateChildName(sex, socialClass, familySurname);
    if (!existingGivenNames.includes(name.given)) break;
  }

  // Birth year: each sibling ~2 years apart, offset from principal
  const birthYear = principalBirthYear - (birthOrderOffset * 2);

  // Relationship quality from estrangement level
  const relationship = estrangementLevel === 2 ? 'estranged'
                     : estrangementLevel === 1 ? 'distant'
                     : 'close';

  const rhPositive = rand() < 0.85;

  return {
    id:              generateVaultId(name.full) + '-sibling',
    type:            'lightweight',
    role:            'sibling',
    name:            name.full,
    given:           name.given,
    surname:         name.surname,
    sex,
    socialClass,
    rhPositive,
    birthYear,
    birthOrderOffset,  // negative = elder than principal, positive = younger
    status:          'alive',
    diedAge:         null,
    relationship,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  generateName,
  generateSpouseName,
  generateChildName,
  generateSpouseStub,
  generateChildStub,
  generateContactStub,
  generateParentStub,
  generateSiblingStub,
  generateChildName,
  generateVaultId,
  generateSurname,
  // Raw tables for reference
  MALE_NAMES,
  FEMALE_NAMES,
  NOBLE_SURNAMES,
  MERCHANT_SURNAMES,
  CRAFT_SURNAMES,
  PATRONYMIC_ROOTS,
  PATRONYMIC_SUFFIXES,
};

// ─────────────────────────────────────────────────────────────────────────────
// QUICK TEST
// ─────────────────────────────────────────────────────────────────────────────

if (require.main === module) {
  console.log('=== Kaldor Name Generator — Quick Test ===\n');

  const classes = ['noble','merchant','warrior','soldier','peasant','artisan','clergy'];
  for (const cls of classes) {
    const m = generateName('male',   cls);
    const f = generateName('female', cls);
    console.log(`  ${cls.padEnd(14)} M: ${m.full.padEnd(28)} F: ${f.full}`);
  }

  console.log('\n── Spouse stubs ──');
  const principal = { socialClass: 'noble', surname: 'Meleken', age: 25 };
  for (let i = 0; i < 5; i++) {
    const s = generateSpouseStub({
      sex: 'female', socialClass: 'noble',
      principalSurname: principal.surname, principalAge: principal.age,
    });
    console.log(`  ${s.name.padEnd(30)} age@marriage:${s.ageAtMarriage}  Rh+:${s.rhPositive}`);
  }

  console.log('\n── Child stubs ──');
  for (let i = 0; i < 5; i++) {
    const c = generateChildStub({
      motherRhPositive: false, fatherRhPositive: true,
      familySurname: 'Meleken', socialClass: 'noble',
      bornAtPrincipalAge: 27, motherId: 'principal', fatherId: 'spouse_001',
    });
    console.log(`  ${c.name.padEnd(30)} Rh+:${c.rhPositive}  sex:${c.sex}`);
  }

  console.log('\n── Vault IDs ──');
  console.log(' ', generateVaultId('Marta Meleken', 'Tashal'));
  console.log(' ', generateVaultId('Wulf Erikson', 'Olokand'));
}
