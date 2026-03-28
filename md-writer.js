#!/usr/bin/env node
'use strict';

/**
 * Kaldor NPC Markdown Writer
 *
 * Renders a character object (output of ageCharacter / generateNPCProfile)
 * into an Obsidian-compatible .md file.
 *
 * OUTPUT STRUCTURE
 * ────────────────
 * Each NPC gets:
 *   {location}/NPCs/{slug}.md          ← full NPC file
 *
 * Each lightweight stub (spouse, child) that hasn't been promoted gets:
 *   {location}/NPCs/stubs/{slug}.md    ← stub file (minimal, wikilink-safe)
 *
 * CALLOUT CONVENTION
 * ──────────────────
 *   [!gm]         GM-only information (Rh status, free OPs, sensitisation)
 *   [!background] Player-visible life history narrative
 *   [!family]     Spouse and children records
 *
 * PROMOTION
 * ─────────
 * Any stub file contains a `type: lightweight` frontmatter field.
 * Promoting a stub: call generateNPCProfile({ seed: stub, ... }) and
 * re-render with this writer. The stub file is replaced with a full file.
 */

const path = require('path');
const fs   = require('fs');

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const ATTR_LABELS = {
  STR: 'Strength',  STA: 'Stamina',    DEX: 'Dexterity',
  AGL: 'Agility',   EYE: 'Eyesight',   HRG: 'Hearing',
  SML: 'Smell',     VOI: 'Voice',      INT: 'Intellect',
  AUR: 'Aura',      WIL: 'Willpower',  CML: 'Appearance',
};

const ATTR_ORDER = ['STR','STA','DEX','AGL','EYE','HRG','SML','VOI','INT','AUR','WIL','CML'];

// Conditions that should NOT appear in player-visible frontmatter
const GM_ONLY_CONDITIONS = new Set([
  'rh_negative', 'sensitised', 'father_absent',
]);

// ─────────────────────────────────────────────────────────────────────────────
// SLUG / PATH HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function toSlug(str) {
  return (str || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Build the vault-relative path for an NPC file.
 * e.g. 'Tashal' + 'Marta Meleken' → 'Locations/Tashal/NPCs/marta-meleken.md'
 */
function npcVaultPath(location, fullName) {
  const loc  = location  ? `Locations/${location}/NPCs` : 'NPCs';
  const slug = toSlug(fullName);
  return `${loc}/${slug}.md`;
}

function stubVaultPath(location, fullName) {
  const loc  = location ? `Locations/${location}/NPCs/stubs` : 'NPCs/stubs';
  const slug = toSlug(fullName);
  return `${loc}/${slug}.md`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION RENDERERS
// ─────────────────────────────────────────────────────────────────────────────

function renderFrontmatter(npc) {
  // Safely resolve name regardless of whether it's a string or legacy object
  const _npcFullName = typeof npc.name === 'string'
    ? npc.name
    : (npc.name?.full ?? (npc.given && npc.surname ? `${npc.given} ${npc.surname}` : null))
    ?? 'Unknown';
  const playerConditions = (npc.conditions || [])
    .filter(c => !GM_ONLY_CONDITIONS.has(c));

  const tags = [
    'npc',
    npc.socialClass,
    npc.sex,
    ...(npc.location ? [toSlug(npc.location)] : []),
    ...(npc.conditions.includes('veteran')  ? ['veteran']  : []),
    ...(npc.conditions.includes('knighted') ? ['knighted'] : []),
    ...(npc.conditions.includes('clergy')   ? ['clergy']   : []),
  ].filter((v, i, a) => a.indexOf(v) === i);  // dedupe

  const lines = [
    '---',
    `id: ${toSlug(_npcFullName || 'unknown')}${npc.location ? '-' + toSlug(npc.location) : ''}`,
    `type: full`,
    `name: "${_npcFullName}"`,
    `given: "${npc.given || ''}"`,
    `surname: "${npc.surname || ''}"`,
    `sex: ${npc.sex}`,
    `socialClass: ${npc.socialClass}`,
    `age: ${npc.age}`,
    `birthYear: ${npc.birthYear ?? ''}`,
    `gameYear: ${npc.gameYear ?? 720}`,
    ...(npc.location ? [`location: "[[${npc.location}]]"`] : []),
    `deity: ${npc.publicDeity ? `"[[${npc.publicDeity}]]"` : 'unknown'}`,
    `conditions: [${playerConditions.join(', ')}]`,
    ...(npc.archetype ? [`archetype: "${npc.archetype.id}"`] : []),
    ...(npc.birthSettlement   ? [`birthSettlement: ${npc.birthSettlement}`]   : []),
    ...(npc.currentSettlement ? [`currentSettlement: ${npc.currentSettlement}`] : []),
    ...(npc.morality !== undefined ? [`morality: ${npc.morality}`] : []),
    `tags: [${tags.join(', ')}]`,
    '---',
  ];
  return lines.join('\n');
}

function renderTitle(npc) {
  const _titleName = typeof npc.name === 'string'
    ? npc.name
    : (npc.name?.full ?? (npc.given && npc.surname ? `${npc.given} ${npc.surname}` : 'Unknown'));
  return `# ${_titleName}`;
}

function renderGMCallout(npc) {
  const lines = ['> [!gm] GM Notes'];

  // Settlement history
  if (npc.birthSettlement) {
    if (!npc.settlementHistory || npc.settlementHistory.length === 0) {
      const originPlace = npc.location ? `[[${npc.location}]]` : `a ${npc.birthSettlement}`;
      lines.push(`> **Origin:** Born in ${originPlace} — has not moved.`);
    } else {
      const firstMove   = npc.settlementHistory[0];
      const birthPlace  = firstMove.fromName ? `[[${firstMove.fromName}]]` : `a ${npc.birthSettlement}`;
      let trail = `Born in ${birthPlace}.`;
      for (const m of npc.settlementHistory) {
        const reason    = m.reason || 'moved on';
        const destPlace = m.toName ? `[[${m.toName}]]` : `a ${m.to}`;
        trail += ` Age ${m.age}: ${reason} (${destPlace}).`;
      }
      lines.push(`> **Origin:** ${trail}`);
    }
    lines.push('>');
  }

  // Birth profile — sunsign, piety, birthdate
  const birthParts = [];
  if (npc.sunsign) birthParts.push(`**Sunsign:** ${npc.sunsign}`);
  if (npc.piety != null) {
    const pietyScale = npc.socialClass === 'clergy' ? ' (WIL×5)' : '';
    birthParts.push(`**Piety:** ${npc.piety}${pietyScale}`);
  }
  if (npc.birthMonth != null && npc.birthDay != null) {
    const MONTHS = ['Nuzyael','Peonu','Kelen','Nolus','Larane','Agrazhar',
                    'Azura','Halane','Savor','Ilvin','Navek','Morgat'];
    birthParts.push(`**Born:** ${npc.birthDay} ${MONTHS[npc.birthMonth] || npc.birthMonth}`);
  }
  if (birthParts.length) { lines.push('> ' + birthParts.join('  |  ')); lines.push('>'); }

  // Naveh clergy rank — cover identity and temple standing
  if (npc.socialClass === 'priest_naveh') {
    const NAVEH_RANK_LABELS = {
      naveh_navas_kara:    'Dranatha (Navas-Kara — has killed)',
      naveh_is_master:     'Master (holds a temple office)',
      naveh_is_garana:     'Garana (High Priest)',
      naveh_be_ara_tulna:  'Be\'ara Tulna (Holy Office)',
      naveh_expelled:      'Expelled — outside the order',
      naveh_independent:   'Independent operator (former member)',
    };
    const rankCond = Object.keys(NAVEH_RANK_LABELS).find(c => (npc.conditions||[]).includes(c));
    const rankLabel = rankCond ? NAVEH_RANK_LABELS[rankCond]
      : (npc.conditions||[]).includes('naveh_initiated') ? 'Dranatha (initiated)'
      : 'Dranatha (newly ordained)';
    const coverNote = (npc.conditions||[]).includes('naveh_cover_embedded') ? ' — cover deeply embedded'
      : (npc.conditions||[]).includes('naveh_has_cover') ? ' — cover established'
      : (npc.conditions||[]).includes('naveh_cover_compromised') ? ' — COVER BLOWN'
      : '';
    const sleepNote = (npc.conditions||[]).includes('naveh_sleeper') ? ' (sleeper placement)' : '';
    lines.push(`> **Temple standing:** ${rankLabel}${coverNote}${sleepNote}`);
    lines.push('>');
  }

  // Lia-Kavair rank — guild standing
  if (npc.socialClass === 'lia_kavair') {
    const LK_RANK_LABELS = {
      lk_footpad_rank:     'Brother/Sister (footpad)',
      lk_thief_rank:       'Journeyman',
      lk_journeyman_rank:  'Master',
      lk_master_rank:      'Senior Master',
      lk_guildmaster_rank: 'Guildmaster (Patron)',
      lk_expelled:         'Expelled (cast out)',
      lk_independent:      'Independent operator (former member)',
    };
    const rankCond = Object.keys(LK_RANK_LABELS).find(c => (npc.conditions||[]).includes(c));
    const rankLabel = rankCond ? LK_RANK_LABELS[rankCond]
      : (npc.conditions||[]).includes('lk_initiated') ? 'Brother/Sister (footpad)'
      : 'Recruit (uninitiated)';
    const coverNote = (npc.conditions||[]).includes('lk_has_cover') ? ' — cover established' : '';
    lines.push(`> **Guild standing:** ${rankLabel}${coverNote}`);
    lines.push('>');
  }

  // Clergy rank — canonical title, deity-aware
  if (npc.socialClass === 'clergy') {
    const isPeoni = npc.publicDeity === 'Peoni';
    const isHalea = npc.publicDeity === 'Halea';
    const RANK_LABELS = isPeoni ? {
      // Peonian titles — Irreproachable Order / Balm of Joy
      clergy_postulant:     'Postulant',
      clergy_acolyte:       'Esolani (acolyte)',
      clergy_priest:        'Ebasethe',
      clergy_vicar:         'Reslava (mendicant)',
      clergy_canon:         'Pelnala (High Priest)',
      clergy_prior:         'Pelnala (abbey)',
      clergy_bishop:        'Sulaplyn (bishop)',
      clergy_archbishop:    'Mepeleh (primate)',
      clergy_excommunicated:'Denied Valon (disgraced)',
    } : isHalea ? {
      // Halean titles — Order of the Silken Voice
      clergy_postulant:     'Corathar (acolyte)',
      clergy_acolyte:       'Corathar (senior acolyte)',
      clergy_priest:        'Shenasene',
      clergy_vicar:         'Shenasene (specialist)',
      clergy_canon:         'Mistress (temple officer)',
      clergy_prior:         'Aramia (High Priestess)',
      clergy_bishop:        'Ensala (deputy primate)',
      clergy_archbishop:    'Salara (primate)',
      clergy_excommunicated:'Cast out of the order',
    } : {
      // Laranian titles — Order of the Spear of Shattered Sorrow
      clergy_postulant:     'Ashesa (postulant)',
      clergy_acolyte:       'Ashesa (senior acolyte)',
      clergy_priest:        'Matakea',
      clergy_vicar:         'Matakea (named posting)',
      clergy_canon:         'Serolan (temple)',
      clergy_prior:         'Serolan (abbey)',
      clergy_bishop:        'Rekela',
      clergy_archbishop:    'Serekela',
      clergy_excommunicated:'Excommunicated',
    };
    const rankCond = Object.keys(RANK_LABELS).find(c => (npc.conditions||[]).includes(c));
    const rankLabel = rankCond ? RANK_LABELS[rankCond] : (isPeoni ? 'Postulant' : isHalea ? 'Corathar (acolyte)' : 'Ashesa (postulant)');
    const militaryNote = !isPeoni && !isHalea && (npc.conditions||[]).includes('military_posting') ? ' — military posting' : '';
    lines.push(`> **Rank:** ${rankLabel}${militaryNote}`);
    lines.push('>');
  }
  if (npc.archetype) {
    lines.push(`> **Archetype: ${npc.archetype.label}** — ${npc.archetype.description}`);
    lines.push('>');
  }

  // OCEAN personality scores
  if (npc.oceanScores) {
    const o = npc.oceanScores;
    const fmt = (k, v) => `${k}:${v}`;
    lines.push(`> **Personality (OCEAN):** ${['O','C','E','A','N'].map(k => fmt(k, o[k])).join('  ')}`);
    lines.push('>');
  }

  // Morality
  if (npc.morality !== undefined) {
    const band = npc.moralityBand || 'situational';
    lines.push(`> **Morality:** ${npc.morality} (${band})`);
    lines.push('>');
  }

  // Family background
  const famParts = [];
  if (npc.siblingCount != null) {
    famParts.push(npc.siblingCount === 0 ? 'only child'
      : `${npc.siblingCount} sibling${npc.siblingCount > 1 ? 's' : ''}`);
  }
  if (npc.estrangementLevel === 2) famParts.push('estranged from family');
  else if (npc.estrangementLevel === 1) famParts.push('distant family ties');
  if (famParts.length) { lines.push(`> **Family background:** ${famParts.join(', ')}.`); lines.push('>'); }

  // Deity
  if (npc.publicDeity && npc.publicDeity !== 'ORDER_ASSIGNED') {
    let deityLine = `> **Deity:** ${npc.publicDeity}`;
    if (npc.secretDeity) deityLine += `  *(secretly worships ${npc.secretDeity})*`;
    lines.push(deityLine);
    lines.push('>');
  } else if (npc.publicDeity === 'ORDER_ASSIGNED') {
    lines.push('> **Deity:** Assigned by order.');
    lines.push('>');
  }

  // Relationship status flags
  const relFlags = [];
  if (npc.conditions.includes('affair'))          relFlags.push('secret affair');
  if (npc.conditions.includes('open_affair'))     relFlags.push('open affair');
  if (npc.conditions.includes('abandoned_family'))relFlags.push('abandoned family');
  if (relFlags.length) { lines.push(`> **Relationship flags:** ${relFlags.join(', ')}.`); lines.push('>'); }

  // Rh status
  if (!npc.rhPositive) {
    lines.push(`> **Rh-negative.** ${npc.conditions.includes('sensitised')
      ? 'Sensitised after a previous Rh-incompatible pregnancy. Subsequent pregnancies with Rh-positive fathers carry ~75% risk of miscarriage or stillbirth.'
      : 'Not yet sensitised. First pregnancy with an Rh-positive father will proceed normally but will sensitise her.'}`);
  }

  // Father absent children
  const fatherAbsentChildren = (npc.children || []).filter(c => c.fatherId === null);
  if (fatherAbsentChildren.length > 0) {
    lines.push(`> **Illegitimate children:** ${fatherAbsentChildren.map(c => c.name).join(', ')}.`);
  }

  // Free OPs
  lines.push(`> **Free OPs available:** ${npc.totalOPsFree} — allocate before play.`);
  if (Object.keys(npc.skillOPMap).length > 0) {
    const skillStr = Object.entries(npc.skillOPMap)
      .sort((a,b) => b[1]-a[1])
      .map(([sk, ops]) => `${sk} ×${ops}`)
      .join(', ');
    lines.push(`> **Skill OPs from history:** ${skillStr}`);
  }

  // Class changes
  if (npc.classChanges?.length > 0) {
    for (const cc of npc.classChanges) {
      lines.push(`> **Class changed** at age ${cc.fromAge}: ${cc.from} → ${cc.to}. ${cc.note || ''}`);
    }
  }

  return lines.join('\n');
}

function renderAttributes(npc) {
  const rows = [
    '## Attributes\n',
    '| ' + ATTR_ORDER.join(' | ') + ' |',
    '| ' + ATTR_ORDER.map(() => '---').join(' | ') + ' |',
    '| ' + ATTR_ORDER.map(a => {
      const v = npc.attributes[a] || 10;
      if (v > 10) return `**${v}**`;
      if (v < 10) return `*${v}*`;
      return `${v}`;
    }).join(' | ') + ' |',
  ];
  return rows.join('\n');
}

// ── Condition categorisation ─────────────────────────────────────────────────
// Active conditions describe the character's current state and affect how they
// behave, are perceived, or can act. Historical conditions record past events.
// GMs scan active conditions first; historical provides backstory context.
const HISTORICAL_CONDITIONS = new Set([
  // Events survived
  'bereaved_child', 'second_parent_gone', 'orphaned', 'orphaned_at_birth',
  'widowed', 'divorced',
  // Training / study completed
  'studied_with_master_done', 'masterwork_achieved', 'pilgrimage_done',
  'long_service_recognised',
  // Past relationship states
  'father_absent', 'stepchild', 'fostered', 'adopted', 'illegitimate',
  'estranged_family', 'abandoned_family',
  // Past crimes / punishments
  'criminal_record', 'branded', 'convicted',
  // Military history
  'veteran', 'old_soldier', 'captured_once', 'discharged',
  // Clergy history
  'clergy_excommunicated',
  // Class markers that are backstory
  'naveh_initiated', 'naveh_navas_kara', 'naveh_augur_returned',
  'naveh_be_ara_tulna', 'naveh_is_master', 'naveh_is_garana',
  'lk_initiated', 'lk_thief_rank', 'lk_journeyman_rank',
  'lk_master_rank', 'lk_guildmaster_rank',
]);

function renderConditions(npc) {
  const allConds = (npc.conditions || []).filter(c => !GM_ONLY_CONDITIONS.has(c));
  if (allConds.length === 0) return '';

  const active     = allConds.filter(c => !HISTORICAL_CONDITIONS.has(c));
  const historical = allConds.filter(c =>  HISTORICAL_CONDITIONS.has(c));

  const fmt = c => `- ${c.replace(/_/g, ' ')}`;
  const lines = ['## Conditions'];

  if (active.length > 0) {
    lines.push('**Current**');
    lines.push(...active.map(fmt));
  }
  if (historical.length > 0) {
    if (active.length > 0) lines.push('');
    lines.push('**History**');
    lines.push(...historical.map(fmt));
  }

  return lines.join('\n');
}

function renderSkills(npc) {
  if (!Object.keys(npc.skillOPMap).length) return '';
  const entries = Object.entries(npc.skillOPMap)
    .sort((a,b) => b[1]-a[1])
    .map(([sk, ops]) => `- **${sk}** — ${ops} OP${ops !== 1 ? 's' : ''} from history`);
  return `## Skills (from History)\n${entries.join('\n')}`;
}

function renderFamily(npc) {
  const lines = ['> [!family] Family'];

  // Naveh clergy note: family exists as cover; children may be temple assets
  if (npc.socialClass === 'priest_naveh' && npc.spouses?.length === 0 && !npc.children?.length) {
    lines.push('>');
    lines.push('> **Upbringing:** Temple-raised from infancy. Birth parents unknown.');
    lines.push('> **Spouse / children:** None recorded. Deep-cover Dranatha sometimes maintain');
    lines.push('> cover families; this NPC has not, or has kept them completely separate.');
    if (npc.relationships?.length > 0) {
      lines.push('>');
      lines.push('> *See Relationships section for contacts.*');
    }
    return lines.join('\n');
  }

  // Naveh upbringing note (shown even when family exists)
  if (npc.socialClass === 'priest_naveh') {
    lines.push('>');
    lines.push('> **Upbringing:** Temple-raised. Birth parents unknown — taken as an infant.');
    lines.push('> Any family shown below exists as cover. They do not know what this person is.');
  }

  // Lia-Kavair cover note
  if (npc.socialClass === 'lia_kavair' && (npc.spouses?.length > 0 || npc.children?.length)) {
    lines.push('>');
    lines.push('> **Note:** Family provides cover and domestic credibility. They know nothing of guild work.');
  }

  // ── Upbringing and parents ─────────────────────────────────────────────────
  const ROLE_LABELS = {
    father:          'Father',      mother:          'Mother',
    foster_father:   'Foster father', foster_mother: 'Foster mother',
    adoptive_father: 'Adoptive father', adoptive_mother: 'Adoptive mother',
    step_father:     'Step-father', step_mother:     'Step-mother',
  };
  if (npc.upbringing && npc.upbringing !== 'offspring') {
    const label = { fostered: 'Fostered', adopted: 'Adopted', bastard: 'Illegitimate', orphan: 'Orphaned' }[npc.upbringing] ?? npc.upbringing;
    lines.push(`> **Upbringing:** ${label}`);
  }
  if (npc.parents?.length > 0) {
    lines.push('>');
    lines.push('> **Parents:**');
    for (const p of npc.parents) {
      const roleLabel = ROLE_LABELS[p.role] ?? p.role;
      const link      = `[[${toSlug(p.name)}|${p.name}]]`;
      const ageNote   = p.ageAtPrincipalBirth != null ? `, age ${p.ageAtPrincipalBirth} at your birth` : '';
      let statusStr;
      if      (p.status === 'alive')    statusStr = 'alive';
      else if (p.status === 'deceased') statusStr = p.diedAge != null ? `died age ${p.diedAge}` : 'deceased';
      else if (p.status === 'absent')   statusStr = 'absent';
      else                              statusStr = 'whereabouts unknown';
      const remarriedNote = p.remarried ? ' *(remarried)*' : '';
      lines.push(`> - **${roleLabel}:** ${link} (${p.socialClass}${ageNote}, ${statusStr})${remarriedNote}`);
    }
  }

  // ── Siblings ───────────────────────────────────────────────────────────────
  if (npc.siblings?.length > 0) {
    lines.push('>');
    const rank     = npc.birthOrder;
    const famSize  = npc.familySize ?? (npc.siblingCount + 1);
    lines.push(`> **Siblings:** ${rank} of ${famSize}`);
    // Sort by position (elder first)
    const sorted = [...npc.siblings].sort((a, b) => a.birthOrderOffset - b.birthOrderOffset);
    for (const s of sorted) {
      const link       = `[[${toSlug(s.name)}|${s.name}]]`;
      const pos        = rank + s.birthOrderOffset;
      const elderNote  = s.birthOrderOffset < 0 ? 'elder' : 'younger';
      const statusStr  = s.status === 'alive' ? 'alive' : `died age ${s.diedAge ?? '?'}`;
      const relNote    = s.relationship !== 'close' ? ` *(${s.relationship})*` : '';
      lines.push(`> - ${link} (${s.sex}, ${elderNote}, position ${pos}, ${statusStr})${relNote}`);
    }
  } else if (npc.siblingCount === 0) {
    lines.push('>');
    lines.push('> **Siblings:** None — only child.');
  }

  // ── Spouses ────────────────────────────────────────────────────────────────
  const allSpouses = npc.spouses ?? [];
  if (allSpouses.length > 0) {
    lines.push('>');
    for (const s of allSpouses) {
      const statusStr = s.status === 'alive'
        ? `alive, married at age ${s.ageAtMarriage}`
        : `deceased at approx. age ${s.diedAge ?? '?'}`;
      const link = `[[${toSlug(s.name)}|${s.name}]]`;
      lines.push(`> **${s.status === 'alive' ? 'Spouse' : 'Late spouse'}:** ${link} (${s.socialClass}, ${statusStr})`);
    }
  } else {
    lines.push('>');
    lines.push('> No recorded spouse.');
  }

  // Children
  if (npc.children?.length > 0) {
    lines.push('>');
    lines.push('> **Children:**');
    for (const c of npc.children) {
      const ageNow   = npc.age - c.bornAtPrincipalAge;
      const statusStr = c.status === 'alive'
        ? `alive, age ${ageNow}`
        : `died age ${c.diedAge ?? '?'}`;
      const link     = `[[${toSlug(c.name)}|${c.name}]]`;
      const illegit  = c.fatherId === null ? ' *(father absent)*' : '';
      const flags    = [];
      if (c.fostered)    flags.push(`fostered age ${c.fosteredAtChildAge}`);
      if (c.inMonastery) flags.push(`placed in monastery age ${c.monasteryAtChildAge}`);
      if (c.leftHome && !c.fostered && !c.inMonastery) flags.push(`left home age ${c.leftHomeAtChildAge}`);
      const flagStr  = flags.length ? ` *(${flags.join(', ')})*` : '';
      lines.push(`> - ${link} (${c.sex}, ${statusStr})${illegit}${flagStr}`);

      // Current spouse
      if (c.spouse) {
        const spLink = `[[${toSlug(c.spouse.name)}|${c.spouse.name}]]`;
        const spStatus = c.spouse.status === 'alive' ? '' : ' *(deceased)*';
        const remar = c.spouse.isRemarriage ? ' *(remarriage)*' : '';
        lines.push(`>   - married ${spLink} (${c.spouse.socialClass}, age ${c.spouse.ageAtMarriage})${spStatus}${remar}`);
      }
      // Previous spouses
      if (c.previousSpouses?.length > 0) {
        for (const ps of c.previousSpouses) {
          lines.push(`>   - previously married [[${toSlug(ps.name)}|${ps.name}]] (${ps.socialClass}, died age ${ps.diedAtChildAge ?? '?'})`);
        }
      }
      // Grandchildren
      const gcAlive = (c.children || []).filter(gc => gc.status === 'alive');
      const gcDead  = (c.children || []).filter(gc => gc.status === 'deceased');
      if (gcAlive.length > 0 || gcDead.length > 0) {
        const gcParts = [];
        if (gcAlive.length) gcParts.push(`${gcAlive.length} living`);
        if (gcDead.length)  gcParts.push(`${gcDead.length} deceased`);
        const bastards = (c.children || []).filter(gc => gc.isBastard).length;
        const bastardNote = bastards ? ` (${bastards} illegitimate)` : '';
        lines.push(`>   - *${gcParts.join(', ')} grandchild${gcAlive.length + gcDead.length > 1 ? 'ren' : ''}${bastardNote}*`);
      }
    }
  }

  return lines.join('\n');
}

function renderBackground(npc) {
  if (!npc.narrative?.length) return '';
  const body = npc.narrative.filter(Boolean).map(l => `> ${l || ''}`).join('\n');
  return `> [!background] Background\n${body}`;
}

function renderLocation(npc) {
  if (!npc.location) return '';
  return `## Location\n[[${npc.location}]]`;
}

function renderRelationships(npc) {
  if (!npc.relationships?.length) return '';
  const lines = ['## Relationships'];
  for (const r of npc.relationships) {
    const link = `[[${toSlug(r.targetName || r.targetId)}|${r.targetName || r.targetId}]]`;
    lines.push(`- **${r.type}:** ${link}${r.note ? ` — ${r.note}` : ''}`);
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// FULL NPC RENDERER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render a full NPC character object to markdown string.
 * Does not write to disk — returns the markdown text.
 *
 * @param {object} npc  — output of ageCharacter / generateNPCProfile
 * @returns {string}    — full markdown content
 */
function renderExtendedFamily(npc) {
  const ext = npc.extendedFamily;
  if (!ext) return '';

  const lines = ['> [!family] Extended Family'];
  const REL_ICON = { close:'★', cordial:'◆', distant:'◇', estranged:'⚠', hostile:'✖' };

  // ── Helper: status string ──────────────────────────────────────────────────
  const statusStr = (m, gameYear = 720) => {
    if (m.status === 'alive') {
      const age = gameYear - m.birthYear;
      return `alive, ~${age}`;
    }
    return m.diedAge ? `d. age ${m.diedAge}` : 'deceased';
  };

  // ── GRANDPARENTS ───────────────────────────────────────────────────────────
  lines.push('>');
  lines.push('> **Grandparents**');
  const { paternal, maternal } = ext.grandparents;
  for (const side of [paternal, maternal]) {
    const label = side.side === 'paternal' ? 'Paternal' : 'Maternal';
    const gf = side.grandfather, gm = side.grandmother;
    lines.push(`> - *${label}:* ${gf.name} (${statusStr(gf)}) & ${gm.name} (${statusStr(gm)})`);
  }

  // ── UNCLE/AUNT UNITS ───────────────────────────────────────────────────────
  const allUnits = [...ext.paternalUnits, ...ext.maternalUnits];
  if (allUnits.length > 0) {
    lines.push('>');
    lines.push('> **Aunts & Uncles — Family Units**');
    lines.push('> ');
    lines.push('> | Uncle | Status | Wives | Relationship | Notable events |');
    lines.push('> |---|---|---|---|---|');
    for (const unit of allUnits) {
      const u   = unit.patriarch;
      const rel = u.relationship;
      const icon = REL_ICON[rel] ?? '◇';
      const wivesSummary = unit.wives.map(w => w.given + (w.status === 'deceased' ? ' †' : '')).join(', ') || '—';
      const lastEvt = unit.familyEvents.length
        ? `${unit.familyEvents[unit.familyEvents.length-1].year} TR: ${unit.familyEvents[unit.familyEvents.length-1].label.split('—')[0].trim()}`
        : '—';
      const sideLabel = u.role === 'paternal_uncle' ? 'Pat.' : 'Mat.';
      lines.push(`> | **${u.name}** *(${sideLabel}, ${statusStr(u)})* | ${u.status} | ${wivesSummary} | ${icon} ${rel} | ${lastEvt} |`);
    }

    // ── COUSINS ───────────────────────────────────────────────────────────────
    const allCousins = allUnits.flatMap(u => u.children).filter(c => c.status === 'alive');
    if (allCousins.length > 0) {
      lines.push('>');
      lines.push(`> **Cousins** (${allCousins.length} living)`);
      lines.push('> ');
      lines.push('> | Name | Sex | ~Age | Relationship |');
      lines.push('> |---|---|---|---|');
      for (const c of allCousins) {
        const age  = Math.max(0, (npc.gameYear ?? 720) - c.birthYear);
        const icon = REL_ICON[c.relationship] ?? '◇';
        lines.push(`> | ${c.name} | ${c.sex} | ${age} | ${icon} ${c.relationship} |`);
      }
    }
  }

  // ── NEPHEWS / NIECES ───────────────────────────────────────────────────────
  const living = ext.nephewNiece.filter(nn => nn.status === 'alive');
  if (living.length > 0) {
    lines.push('>');
    lines.push(`> **Nephews & Nieces** (${living.length} living)`);
    lines.push('> ');
    lines.push('> | Name | Role | ~Age | Via | Relationship |');
    lines.push('> |---|---|---|---|---|');
    for (const nn of living) {
      const age  = Math.max(0, (npc.gameYear ?? 720) - nn.birthYear);
      const icon = REL_ICON[nn.relationship] ?? '◇';
      lines.push(`> | ${nn.name} | ${nn.role} | ${age} | ${nn.parentName} | ${icon} ${nn.relationship} |`);
    }
  }

  // ── FAMILY EVENTS SUMMARY (all units) ─────────────────────────────────────
  if (allUnits.some(u => u.familyEvents.length > 0)) {
    lines.push('>');
    lines.push('> **Extended Family Chronicle** *(significant events, by branch)*');
    for (const unit of allUnits.filter(u => u.familyEvents.length > 0)) {
      const sideLabel = unit.patriarch.role === 'paternal_uncle' ? 'Paternal' : 'Maternal';
      lines.push(`> - **${unit.patriarch.given}\'s family** *(${sideLabel}):*`);
      // Show last 3 events only — keeps it readable
      const shown = unit.familyEvents.slice(-3);
      for (const evt of shown) {
        lines.push(`>   - ${evt.year} TR — ${evt.label}`);
      }
    }
  }

  // ── MERMAID FAMILY TREE ───────────────────────────────────────────────────
  const mLines = ['```mermaid', 'graph TD'];

  // Grandparents
  const pgf = paternal.grandfather, pgm = paternal.grandmother;
  const mgf = maternal.grandfather, mgm = maternal.grandmother;
  mLines.push(`  PGF["${pgf.given}${pgf.status==='deceased'?' †':''}"]`);
  mLines.push(`  PGM["${pgm.given}${pgm.status==='deceased'?' †':''}"]`);
  mLines.push(`  MGF["${mgf.given}${mgf.status==='deceased'?' †':''}"]`);
  mLines.push(`  MGM["${mgm.given}${mgm.status==='deceased'?' †':''}"]`);

  // Parents
  const father = npc.parents?.find(p=>p.role==='father');
  const mother = npc.parents?.find(p=>p.role==='mother');
  if (father) {
    mLines.push(`  DAD["${father.given||father.name}${father.status==='deceased'?' †':''}"]`);
    mLines.push(`  PGF --- DAD`);
    mLines.push(`  PGM --- DAD`);
  }
  if (mother) {
    mLines.push(`  MOM["${mother.given||mother.name}${mother.status==='deceased'?' †':''}"]`);
    mLines.push(`  MGF --- MOM`);
    mLines.push(`  MGM --- MOM`);
  }

  // Principal
  const pName = npc.given || npc.name || 'Principal';
  mLines.push(`  PC(["**${pName}** ← you"])`);
  if (father) mLines.push(`  DAD --- PC`);
  if (mother) mLines.push(`  MOM --- PC`);

  // Siblings (up to 4)
  for (const [i, sib] of (npc.siblings ?? []).slice(0,4).entries()) {
    const sid = `SIB${i}`;
    const rel = sib.relationship === 'hostile' ? '✖' : sib.relationship === 'estranged' ? '⚠' : '';
    mLines.push(`  ${sid}["${sib.given||sib.name}${sib.status==='deceased'?' †':''} ${rel}"]`);
    if (father) mLines.push(`  DAD --- ${sid}`);
    if (mother) mLines.push(`  MOM --- ${sid}`);
  }

  // Uncle units (up to 4 to keep diagram readable)
  for (const [i, unit] of allUnits.slice(0,4).entries()) {
    const u   = unit.patriarch;
    const uid = `UNC${i}`;
    const rel = u.relationship === 'hostile' ? '✖' : u.relationship === 'estranged' ? '⚠' : '';
    mLines.push(`  ${uid}["${u.given} ${rel}${u.status==='deceased'?' †':''}"]`);
    const parentNode = u.role === 'paternal_uncle' ? 'PGF' : 'MGF';
    mLines.push(`  ${parentNode} --- ${uid}`);
    // Cousins (up to 2 per uncle)
    for (const [j, c] of unit.children.slice(0,2).entries()) {
      const cid = `COU${i}_${j}`;
      mLines.push(`  ${cid}["${c.given}${c.status==='deceased'?' †':''}"]`);
      mLines.push(`  ${uid} --- ${cid}`);
    }
  }

  // Principal's children (up to 4)
  for (const [i, c] of (npc.children ?? []).filter(c=>c.status==='alive').slice(0,4).entries()) {
    const cid = `CHI${i}`;
    mLines.push(`  ${cid}["${c.given||c.name}"]`);
    mLines.push(`  PC --- ${cid}`);
  }

  mLines.push('```');
  lines.push('>');
  lines.push('> **Family Tree**');
  lines.push('>');
  // Indent mermaid block inside callout
  mLines.forEach(ml => lines.push('> ' + ml));

  return lines.join('\n');
}

function renderNPC(npc) {
  const sections = [
    renderFrontmatter(npc),
    renderTitle(npc),
    renderGMCallout(npc),
    renderAttributes(npc),
    renderConditions(npc),
    renderSkills(npc),
    renderFamily(npc),
    renderExtendedFamily(npc),
    renderBackground(npc),
    renderRelationships(npc),
    renderLocation(npc),
  ].filter(Boolean);

  return sections.join('\n\n') + '\n';
}

// ─────────────────────────────────────────────────────────────────────────────
// STUB RENDERER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render a lightweight stub (spouse or child) to a minimal markdown file.
 * The stub is wikilink-safe and contains enough information to promote later.
 *
 * @param {object} stub       — LightweightSpouse or LightweightChild
 * @param {string} location   — vault location string
 * @returns {string}          — markdown content
 */
function renderStub(stub, location = null) {
  const tags = ['npc', 'stub', stub.socialClass || 'unknown', stub.sex || 'unknown'];
  if (location) tags.push(toSlug(location));

  // Serialise sharedEvents for round-trip recovery by parseStubFromMarkdown / expandStub.
  // Filters out preHistory entries (pre-age-18) — same filter expandStub applies.
  const serialisedSharedEvents = (stub.sharedEvents || [])
    .filter(e => !e.preHistory)
    .map(e => ({
      eventId:  e.eventId,
      ageMin:   e.ageMin,
      ageMax:   e.ageMax,
      pool:     e.pool || 'family',
      ...(e.principalAge != null ? { principalAge: e.principalAge } : {}),
    }));

  const frontmatter = [
    '---',
    `id: ${toSlug(stub.name)}`,
    `type: lightweight`,
    `role: ${stub.role}`,
    `name: "${stub.name}"`,
    `sex: ${stub.sex}`,
    `socialClass: ${stub.socialClass || 'unknown'}`,
    ...(stub.birthYear  ? [`birthYear: ${stub.birthYear}`]  : []),
    ...(stub.stubSeed   ? [`stubSeed: ${stub.stubSeed}`]    : []),
    ...(location ? [`location: "[[${location}]]"`] : []),
    `status: ${stub.status}`,
    `tags: [${tags.join(', ')}]`,
    ...(serialisedSharedEvents.length > 0
      ? [`sharedEvents: ${JSON.stringify(serialisedSharedEvents)}`]
      : []),
    '---',
    '',
    `# ${stub.name}`,
  ];

  const gmLines = [`> [!gm] Stub — not yet fully generated`];
  gmLines.push(`> **Role:** ${stub.role}  |  **Status:** ${stub.status}  |  **Sex:** ${stub.sex}  |  **Class:** ${stub.socialClass || 'unknown'}`);

  if (stub.role === 'spouse') {
    gmLines.push(`> **Married at principal age:** ${stub.marriedAtPrincipalAge}  |  **Spouse age at marriage:** ${stub.ageAtMarriage}`);
    if (stub.diedAge) gmLines.push(`> **Died:** age ${stub.diedAge}`);
  } else if (stub.role === 'child' || stub.role === 'grandchild') {
    gmLines.push(`> **Born at principal age:** ${stub.bornAtPrincipalAge}`);
    if (stub.diedAge) gmLines.push(`> **Died:** age ${stub.diedAge}`);
    if (stub.disability) gmLines.push(`> **Disability:** ${stub.disability}`);
    if (stub.fostered)    gmLines.push(`> **Fostered** at child age ${stub.fosteredAtChildAge}`);
    if (stub.inMonastery) gmLines.push(`> **Placed in monastery** at child age ${stub.monasteryAtChildAge}`);
    if (stub.leftHome && !stub.fostered && !stub.inMonastery)
      gmLines.push(`> **Left home** at child age ${stub.leftHomeAtChildAge}`);
    if (stub.isBastard) gmLines.push(`> **Illegitimate** (father absent)`);

    // Current spouse
    if (stub.spouse) {
      const spStatus = stub.spouse.status === 'alive' ? 'alive' : `deceased age ${stub.spouse.diedAtChildAge ?? '?'}`;
      const remar = stub.spouse.isRemarriage ? ' *(remarriage)*' : '';
      gmLines.push(`> **Spouse:** [[${toSlug(stub.spouse.name)}|${stub.spouse.name}]] (${stub.spouse.socialClass}, age ${stub.spouse.ageAtMarriage}, ${spStatus})${remar}`);
    }
    // Previous spouses
    if (stub.previousSpouses?.length > 0) {
      for (const ps of stub.previousSpouses) {
        gmLines.push(`> **Previous spouse:** [[${toSlug(ps.name)}|${ps.name}]] (died age ${ps.diedAtChildAge ?? '?'})`);
      }
    }
    // Grandchildren summary
    const gcAlive = (stub.children || []).filter(gc => gc.status === 'alive').length;
    const gcDead  = (stub.children || []).filter(gc => gc.status === 'deceased').length;
    if (gcAlive + gcDead > 0) {
      const gcParts = [];
      if (gcAlive) gcParts.push(`${gcAlive} living`);
      if (gcDead)  gcParts.push(`${gcDead} deceased`);
      gmLines.push(`> **Grandchildren (of principal):** ${gcParts.join(', ')}`);
    }
  }

  gmLines.push(`>`);
  gmLines.push(`> Promote with \`expandStub(stub, gameYear)\` to generate a full history.`);

  // FIX-006: surface sharedEvents count so GMs know the stub carries family history
  if (serialisedSharedEvents.length > 0) {
    gmLines.push(`> **Shared family events:** ${serialisedSharedEvents.length} recorded`);
    gmLines.push(`> (stored in YAML frontmatter; replayed on promotion)`);
  }

  return [...frontmatter, '', ...gmLines].join('\n') + '\n';
}

// ─────────────────────────────────────────────────────────────────────────────
// FILE WRITERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write an NPC to the vault.
 *
 * @param {object} npc         — character object
 * @param {string} vaultRoot   — absolute path to the vault root on disk
 * @returns {{ npcPath, stubPaths }}
 */
function writeNPCToVault(npc, vaultRoot) {
  const fullName   = npc.name || 'Unknown';
  const location   = npc.location  || null;
  const relPath    = npcVaultPath(location, fullName);
  const absPath    = path.join(vaultRoot, relPath);

  // Ensure directory exists
  fs.mkdirSync(path.dirname(absPath), { recursive: true });

  // Write main NPC file
  const content = renderNPC(npc);
  fs.writeFileSync(absPath, content, 'utf8');

  const stubPaths = [];

  // Write stub files for all lightweight records
  const stubs = [
    ...(npc.spouses  || []),
    ...(npc.children || []),
  ];

  for (const stub of stubs) {
    const stubRel = stubVaultPath(location, stub.name);
    const stubAbs = path.join(vaultRoot, stubRel);
    fs.mkdirSync(path.dirname(stubAbs), { recursive: true });
    fs.writeFileSync(stubAbs, renderStub(stub, location), 'utf8');
    stubPaths.push(stubRel);
  }

  return { npcPath: relPath, stubPaths };
}

/**
 * Promote a lightweight stub to a full NPC.
 * Accepts the stub object and the full generated character from ageCharacter.
 * Overwrites the stub file with the full file.
 *
 * @param {object} stub        — original lightweight stub
 * @param {object} fullNPC     — output of ageCharacter with stub data as seed
 * @param {string} vaultRoot   — absolute path to vault root
 * @returns {string}           — relative path of the written file
 */
function promoteStubToFull(stub, fullNPC, vaultRoot) {
  const location  = fullNPC.location || null;
  const fullName  = fullNPC.name || stub.name;

  // Remove old stub file if it exists
  const oldStubAbs = path.join(vaultRoot, stubVaultPath(location, stub.name));
  if (fs.existsSync(oldStubAbs)) fs.unlinkSync(oldStubAbs);

  // Write full NPC file
  const { npcPath } = writeNPCToVault(fullNPC, vaultRoot);
  return npcPath;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * FIX-007: parseStubFromMarkdown(markdownString)
 *
 * Parses a stub Markdown file back into a stub object suitable for
 * passing directly to expandStub(stub, gameYear).
 *
 * Reads the YAML frontmatter block between the opening and closing '---'
 * lines. Handles the sharedEvents JSON array written by renderStub (FIX-006)
 * so that expandStub can replay the genuine shared family history.
 *
 * Returns null if the string is not a recognisable stub document (missing
 * frontmatter, missing required fields, or type !== 'lightweight').
 *
 * @param  {string} markdownString — raw content of a stub .md file
 * @returns {object|null}           — stub object ready for expandStub, or null
 */
function parseStubFromMarkdown(markdownString) {
  if (typeof markdownString !== 'string') return null;

  // ── Extract frontmatter block ──────────────────────────────────────────────
  // The block is delimited by the first and second '---' lines (YAML front matter).
  const lines = markdownString.split(/\r?\n/);
  let fmStart = -1, fmEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      if (fmStart === -1)      { fmStart = i; }
      else if (fmEnd === -1)   { fmEnd   = i; break; }
    }
  }
  if (fmStart === -1 || fmEnd === -1 || fmEnd <= fmStart + 1) return null;

  const fmLines = lines.slice(fmStart + 1, fmEnd);

  // ── Parse key: value pairs ─────────────────────────────────────────────────
  // Handles:
  //   scalar:   key: value
  //   quoted:   key: "value"
  //   JSON:     sharedEvents: [{...}, ...]
  const fm = {};
  for (const line of fmLines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key   = line.slice(0, colonIdx).trim();
    const raw   = line.slice(colonIdx + 1).trim();
    if (!key) continue;

    // JSON array or object value (sharedEvents, tags-as-array)
    if (raw.startsWith('[') || raw.startsWith('{')) {
      try   { fm[key] = JSON.parse(raw); }
      catch { fm[key] = raw; }           // leave as string if parse fails
    } else {
      // Strip surrounding quotes if present
      fm[key] = raw.replace(/^["']|["']$/g, '');
    }
  }

  // ── Validate ───────────────────────────────────────────────────────────────
  if (fm.type !== 'lightweight') return null;
  if (!fm.name || !fm.sex || !fm.socialClass) return null;

  // ── Build stub object ──────────────────────────────────────────────────────
  // Mirror the shape that ageCharacter / expandStub expects.
  const stub = {
    name:        fm.name,
    given:       fm.name.split(' ')[0] || fm.name,
    surname:     fm.name.split(' ').slice(1).join(' ') || '',
    sex:         fm.sex,
    socialClass: fm.socialClass,
    role:        fm.role || 'unknown',
    status:      fm.status || 'alive',
    birthYear:   fm.birthYear  != null ? Number(fm.birthYear)  : null,
    stubSeed:    fm.stubSeed   != null ? Number(fm.stubSeed)   : null,
    // sharedEvents: written as JSON array by renderStub (FIX-006)
    // Restored verbatim; expandStub will apply its own preHistory/narrative filter.
    sharedEvents: Array.isArray(fm.sharedEvents) ? fm.sharedEvents : [],
  };

  // Role-specific fields
  if (fm.marriedAtPrincipalAge != null) stub.marriedAtPrincipalAge = Number(fm.marriedAtPrincipalAge);
  if (fm.ageAtMarriage         != null) stub.ageAtMarriage         = Number(fm.ageAtMarriage);
  if (fm.bornAtPrincipalAge    != null) stub.bornAtPrincipalAge    = Number(fm.bornAtPrincipalAge);
  if (fm.diedAge               != null) stub.diedAge               = Number(fm.diedAge);
  if (fm.disability            != null) stub.disability            = fm.disability;
  if (fm.rhPositive            != null) stub.rhPositive            = fm.rhPositive === 'true';

  return stub;
}

module.exports = {
  renderNPC,
  renderExtendedFamily,
  renderStub,
  parseStubFromMarkdown,
  writeNPCToVault,
  promoteStubToFull,
  npcVaultPath,
  stubVaultPath,
  toSlug,
};

// ─────────────────────────────────────────────────────────────────────────────
// QUICK TEST
// ─────────────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const { ageCharacter }  = require('./aging-engine');
  const { generateName }  = require('./name-tables');

  console.log('=== md-writer quick test ===\n');

  // Generate a noble female aged 40
  const npcName = generateName('female', 'noble');
  const npc = ageCharacter({
    socialClass: 'noble',
    sex:      'female',
    targetAge:   40,
    name:        npcName,
    location:    'Tashal',
  });

  const md = renderNPC(npc);
  console.log(md.slice(0, 2000));
  console.log('\n...(truncated for display)');
  console.log(`\nTotal length: ${md.length} chars`);
  console.log(`Spouses: ${npc.spouses.length}, Children: ${npc.children.length}`);
  if (npc.spouses.length) {
    console.log('\n── Stub preview ──');
    console.log(renderStub(npc.spouses[0], 'Tashal'));
  }
}
