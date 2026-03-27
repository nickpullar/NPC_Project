# Kaldor NPC Aging Engine — v1.1.2

A biographical simulation engine for HârnWorld Kaldor. Generates fully realised non-player characters who feel like they have actually lived — with plausible life histories, distinct personalities, family connections, and the specific texture of Kaldorian society.

---

## Scale

| | Count |
|---|---|
| Life events | **753** |
| Archetypes | **315** |
| Social classes | **22** |
| Cultures | **2** (Kaldorian, Pagaelin) |
| Test suite | **150 fast + 8 heavy = 158 tests, 0 failing** |

---

## What You Get

Running the generator against a social class, sex, and target age produces a complete character document containing:

**A full life history.** The character was born, grew up, had a social class, made contacts, suffered setbacks, accumulated skills, and arrived at the present day having experienced a plausible sequence of events drawn from 753 modelled life events. Major events — ordination, military service, financial ruin, marriage, the death of a child — sit alongside small colour moments that make a character feel remembered rather than generated.

**A personality derived from experience.** Each character has OCEAN personality scores that influence which events they attract and which they avoid. A high-Agreeableness artisan apprentice is less likely to be beaten by her master than a combative, low-Agreeableness one. A high-Neuroticism soldier is more likely to be rattled by a near-miss with the watch. The personality is expressed in plain language alongside the numerical scores.

**Morality with memory.** Every character has a constitutional moral baseline — who they were born as. Life pushes them away from it; stability pulls them back. A decade of destitution erodes a principled man. A decade in a monastery recovers most of what it took. The baseline is stored and the reversion is modelled year by year.

**A physical description.** Height, build, colouring, distinctive features — generated consistently with social background, sex, and age.

**HârnMaster skills.** What the character can actually do, in game terms, grounded in what their life history makes plausible.

**Family and social connections.** Spouse, children, grandchildren, and key contacts — each named, with their own brief profiles and relationship to the character. Child stubs can be expanded into full NPCs.

**GM-only context.** Flagged separately so the document can be handed to a player without editing.

---

## Social Classes

### Kaldorian Culture (20 classes)

**Noble** — heirs, lords, ladies, and the political class. Lives shaped by inheritance, feudal obligation, court intrigue, and estate management. 19 archetype variants including the reluctant lord, the ambitious spare, the political match, and the estate manager.

**Warrior** — professional fighters from household knights to veteran mercenaries. Campaign, wound, commendation, and service under different lords. Scout, huntress, outrider, hedge-witch, scarred veteran — 16 variants.

**Soldier** — levy troops and garrison soldiers. Compulsory service, garrison duty, campaign violence, the pressed man who hated every day of it, the spy who found she was good at not being noticed, the sutler who ran the camp economy. 12 variants.

**Merchant** — traders, factors, and commercial families. Long-distance trade, guild disputes, financial ruin and recovery, the social mobility that wealth permits. 8 variants.

**Artisan** — guild-trained craftspeople from apprentice to master. Slow accumulation of skill, guild politics, the masterwork delayed by perfectionism, the restless journeyman who cannot stay in one workshop, the female apprentice navigating what the guild costs her. 13 variants, differentiated by OCEAN personality scoring.

**Peasant** — from comfortable freeholders to serfs on the edge. Harvest, hardship, levy service, serfdom, the village social world. 12 variants.

**Unguilded** — the urban margins: servants, labourers, itinerant pedlars, the chronically poor. 7 variants.

**Clergy** — ordained priests of three distinct orders:
- *Laranian* — the warrior church: martial, administratively powerful, non-celibate, running hospitals and arbitrating disputes alongside holy war. 12 variants.
- *Peonian* — the mercy church: healing, agricultural, celibate, female-dominant. 8 variants.
- *Halean* — commerce and pleasure: urban, female-only, blessing trade ventures. 5 variants.

**Lia-Kavair** — the thieves' guild. Street cutpurses through to journeymen with established cover identities. Entry by invitation. 13 variants including the fence, the enforcer, the information broker, the gone-legitimate master who still gets calls.

**Priest of Naveh** — the hidden temple. Raised from infancy, double lives behind civilian cover. Cover establishment, compromise, the Herth-Akan trial. 4 variants.

**Destitute** — genuine homelessness. Below ruination. Survival-mode poverty. The only way out is charity, crime, or the church. Three variants: urban street, rural vagrant, under church shelter.

**Ten guilded specialist classes:**
- `guilded_arcanist` — Shek-Pvar practitioners; the first working, the convocation, church tension
- `guilded_courtesan` — bonded and free; house politics, the difficult patron, training, the contract
- `guilded_herald` — blazon, genealogy, the circuit, contested arms cases
- `guilded_innkeeper` — rural inn to Tashal townhouse; the notable guest, death on premises
- `guilded_litigant` — assize courts, writs, bribed courts, the significant case
- `guilded_mariner` — deck boy to master pilot; storm, cargo loss, crew trouble, weather reading
- `guilded_miner` — seam strikes, underground accidents, the camp economy, roof falls
- `guilded_performer` — harper guild training, the significant role, the piece that changed things
- `guilded_physician` — case saved, case lost, guild politics
- `guilded_physician` — rural healer to noble-bonded physician; ethics, politics, reputation

### Pagaelin Culture (2 classes)

**Pagaelin** — nomadic tribal society at 720 TR, under increasing Walker (Naveh) lodge pressure. Male lifecycle: youth → warrior → dominant → chieftain. Female lifecycle: girl → held woman → widow. All births modelled with tribal alignment (traditional 25%, syncretist 60%, walker-dominated 15%). 15 archetype variants.

**Walker Shaman** — Pagaelin who crossed the Raunir threshold; Naveh lodge asset. Lodge assignments, administered Tegal, the lodge leverage condition, the specific texture of being simultaneously part of tribal life and answerable to an external authority. 2 variants.

---

## Key Systems

### Biographical Simulation

Each NPC is simulated year by year from age 18 to target age. Each year:

1. A biographical event is drawn from a weighted pool — major life events, minor events, and colour moments — with weights modified by social class, phase, archetype, OCEAN scores, conditions, morality, and settlement type.
2. A family event runs in parallel — spouse, children, grandchildren aging independently.
3. Conditions are updated, morality drifts, disgrace fades, phase transitions fire.

The pool contains 753 events. Many events fire as follow-ons from others, creating chains. A first kill may immediately create the conditions for marriage; a financial ruin may trigger a settlement shift; a Peonian pilgrimage may soften morality after years of hardship.

### Personality (OCEAN)

Five-factor personality scores (Openness, Conscientiousness, Extraversion, Agreeableness, Neuroticism) are generated at birth from class and sex distributions, then biased by archetype. They influence event probability via `oceanWeightMod` on individual events — the high-Openness artisan is more likely to wander between workshops; the high-Neuroticism soldier is more likely to be rattled and to have been beaten as an apprentice.

### Morality & Baseline Reversion

Morality runs from 3 (predatory) to 18 (principled) across five bands. It drifts from specific events (betrayal, outlawing, pilgrimage, finding purpose) and from circumstance (destitution erodes; monastery life restores).

Every character stores `baseMorality` — their constitutional baseline. When circumstances stabilise, morality is pulled back toward baseline at a rate proportional to the gap. Clergy class, prosperity, and devout conditions accelerate the pull. Ongoing adversity suppresses it. Destitution blocks it entirely until the cause is removed.

### Disgrace System

`disgraced` is not permanent. After 4-7 years (20% chance at year 4, 35% at year 5, 55% at year 6+) it fades naturally. `ever_disgraced` is set as a permanent biographical record. Communities forget; the NPC does not.

`shame_fades` and `reputation_restored` events accelerate recovery and also set `ever_disgraced`. `breach_of_rank_incident` and `public_humiliation` cannot fire while already disgraced — you cannot be further publicly shamed when you are already at the bottom.

Events like `estranged_from_child`, `feud_involvement`, and `outlawed` respond to `ever_disgraced` at reduced weight — the historical stigma outlasts the active shame.

### Midwife Access

Skilled birth attendance reduces difficult birth probability by 45%. Access is modelled separately for urban and rural settings:

- **Urban:** wealth-gated. Ruination or indebtedness significantly reduces access — the Peonian asks for a donation, the physician charges a fee.
- **Rural:** proximity-gated, largely class-blind. Peonian Esolani sisters attend births as a religious duty regardless of ability to pay. What limits access is distance and isolation.

`skilled_herbalist`, `devout Peoni`, and settlement type all modify access probability.

### Pregnancy Complications

Risk scales smoothly from age 35: +2.5%/year miscarriage age 35-40, +4%/year thereafter. Stillbirth and difficult birth follow the same curve. A 44-year-old who becomes pregnant faces ~54% miscarriage rate — pregnancies that late are rare and high-risk.

### Destitution

The `destitute` class sits below ruination. Entry via `fallen_to_destitution` (requires `ruined` condition). While destitute:
- Petty theft fires regardless of morality (`moralityWeighted: false`) — survival overrides ethics
- Morality erodes at 20%/year for principled/honest characters, 12% for situational
- Morality baseline reversion is blocked entirely
- LK initiation weight +40 — the guild recruits from the desperate

Exit requires external agency: Peonian rescue, monastery admission, LK recruitment, or 18 months of day labour. Most people stay there.

---

## Monte Carlo Population Calibration (v1.0, n=1000)

Weighted class distribution matching Kaldorian demography.

| Metric | Rate | Notes |
|---|---|---|
| No archetype | 0.2% | Down from ~10% in guilded classes |
| Disgraced (active) | 13.4% | Down from 20.5%; fade system working |
| ever_disgraced | 38.7% | Lifetime biographical exposure |
| Outlawed | 6.6% | LK 33%, peasant 8% |
| Criminal record | 25.8% | LK 70%, unguilded 31% |
| Ever married | 66.5% | |
| Has children | 63.3% | |
| Lost a child | 41.9% | Pre-modern child mortality |
| Avg events/NPC | 40.3 | Range 1–119 |
| Errors | 0 | |

Morality distribution: predatory 7.8%, corruptible 12.8%, situational 23.3%, honest 27.5%, principled 28.6%.

---

## Output Format

Each character is produced as a Markdown document ready for Obsidian, Notion, or any text editor. GM-only content is flagged in callout blocks (`[!gm]`) and can be filtered for player-facing handouts.

A typical document is 100–200 lines and generates in under a second.

---

## Files

| File | Purpose |
|---|---|
| `aging-engine.js` | Core simulation engine — year loop, pregnancy resolver, morality, disgrace fade |
| `life-events.js` | All 753 life events with weights, conditions, effects, and flavour text |
| `archetypes.js` | All 315 archetypes with OCEAN biases, phase coverage, settlement biases |
| `npc-generator.js` | HârnMaster attribute and skill generation |
| `md-writer.js` | Markdown output renderer |
| `generate-full-npc.js` | Entry point — generates a single complete NPC |
| `generate-from-description.js` | Constraint-based generation from a character description |
| `test-regression.js` | 158-test regression suite |

---

## Usage

```js
const { ageCharacter } = require('./aging-engine');

// Generate a peasant woman aged 42
const npc = ageCharacter({
  socialClass: 'peasant',
  sex:         'female',
  targetAge:   42,
  seed:        12345,   // omit for random
});

console.log(npc.archetype.id);       // e.g. 'peasant_wise_woman'
console.log(npc.morality);           // 3-18
console.log(npc.baseMorality);       // constitutional baseline
console.log(npc.conditions);         // current condition array
console.log(npc.history.length);     // biographical events count

// Render to Markdown
const { renderNPC } = require('./md-writer');
const md = renderNPC(npc);
```

---

## What It Is Not

This engine does not produce adventurers or player characters. It produces the people who live in Kaldor — the innkeeper, the sheriff's sergeant, the merchant's widow, the disgraced cleric, the old soldier who found religion late, the Lia-Kavair fence who presents as a respectable cloth dealer, the Navehan priest who has been a journeyman dyer in the Medrik district for nine years and does not yet know what she is being positioned for.

It is for GMs who want the world to feel populated by real people rather than named statistics.
