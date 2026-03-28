# Culture modularity audit — NPC project

This document audits how **Kaldorian** (feudal) and **Pagaelin** (tribal) cultures are represented in the codebase, compares that to common software design practice for divergent behavior, and outlines a refactor plan so new cultures can be added without repeatedly editing the core aging loop.

**Scope:** JavaScript sources under the repository root (`aging-engine.js`, `life-events.js`, `archetypes.js`, tests, etc.). Narrative sample data under `literary-corpus/` is excluded from mechanical coupling analysis.

**Note on paths:** The audit was run against the current workspace (this NPC repository). If your “NPC Project” lives in another folder on disk, copy this file there or re-run the same searches against that tree.

---

## 1. Executive summary

- **Kaldor is the implicit default:** Most logic assumes feudal settlement, guilds, levy, and Kaldoric marriage unless explicitly excluded.
- **Pagaelin is a second track** implemented via `socialClass === 'pagaelin'` (and related `walker_shaman`), hundreds of `pagaelin_*` event IDs, and many `excludeClasses: ['pagaelin', …]` entries in shared tables.
- **There is useful infrastructure** (`CLASS_CULTURE_MAP`, `CULTURE_CONFIGS`, non-Kaldoric weight fallback in `buildDrawTable`) that moves in the right direction.
- **The core loop is not culture-agnostic:** `aging-engine.js` contains many Pagaelin-specific branches (family pool, pregnancy follow-ons, child mortality, class-change rules, household serialization, archetype rerolls, life expectancy).
- **Best fit for this domain:** treat each culture as a **strategy / plugin** (culture module) that supplies data and hooks; keep the engine as orchestration + shared mechanics.

---

## 2. How the split is implemented today

### 2.1 Culture identity and mapping

| Mechanism | Location | Role |
|-----------|----------|------|
| `CULTURE_CONFIGS` | `aging-engine.js` | Per-culture settlement types, Pagaelin-only fields (`tribalAlignments`, `oceanBase`, `deities`, life-expectancy hints in comments vs actual roll). |
| `CLASS_CULTURE_MAP` | `aging-engine.js` | Maps **social class** string → culture key (`kaldor` or `pagaelin`). `walker_shaman` shares `pagaelin` culture. |
| `KALDORIC_FALLBACK_CULTURES` | `aging-engine.js` (`buildDrawTable`) | Only cultures in this set may use `unguilded` / `peasant` weight fallbacks. Prevents Kaldoric events bleeding into Pagaelin when an event omits explicit `pagaelin` weights. |

Kaldorian classes are not labeled “kaldor” in event data; they are “everything that is not excluded / not tribal-only.”

### 2.2 Settlement and birth

- **Kaldor:** `SETTLEMENT_TYPES` and `BIRTH_SETTLEMENT_WEIGHTS` drive `rollBirthSettlement(cls)`.
- **Pagaelin:** `birthSettlement` is forced to `'camp'`; `tribalAlignment` is rolled from `CULTURE_CONFIGS.pagaelin` (`rollTribalAlignment`). `BIRTH_SETTLEMENT_WEIGHTS.pagaelin` exists mainly to avoid silent fallback.

### 2.3 Initialization (personality, deity, conditions)

- **OCEAN:** Kaldoric uses `generateOCEANScores(cls, sex)` from `npc-generator.js`. Pagaelin uses `CULTURE_CONFIGS.pagaelin.oceanBase` plus variance in `aging-engine.js`.
- **Deity:** Kaldoric uses `selectDeity` except clergy; Pagaelin uses `CULTURE_CONFIGS.pagaelin.deities[tribalAlignment]`.
- **Starting conditions:** Pagaelin-specific logic sets `tribal_alignment_*`, optional `tribal_alignment_walker`, and `pagaelin_held` for certain female archetype IDs (hardcoded list).

### 2.4 Phase and lifecycle

- `CLASS_PHASE_CONFIGS.pagaelin` and `CLASS_PHASE_CONFIGS.walker_shaman` encode tribal lifecycle phases.
- Additional **event-driven** phase/archetype transitions in `resolveEvent` (e.g. chieftaincy, Raunir ordeal → `walker_shaman`, shaman calling).

### 2.5 Events and conditions

- **`life-events.js`** is the largest coupling surface:
  - Global `CONDITION_REGISTRY` mixes Kaldoric, cross-border, and Pagaelin-specific flags (`pagaelin_*`, `tribal_alignment_*`, `lang_pagaelin_*`, `lang_harnic_*`, etc.).
  - Event definitions use `weights.pagaelin`, `weights.walker_shaman`, `excludeClasses: ['pagaelin', …]`, and Pagaelin-only event IDs (`pagaelin_*`, `colour_pagaelin_*`).
- **Cross-culture content** (e.g. learning Pagaelin as a Kaldoric NPC) is encoded as Kaldoric events with `excludeClasses: ['pagaelin']`.

### 2.6 Archetypes

- **`archetypes.js`** contains a large Pagaelin section: archetype IDs prefixed with `pagaelin_`, `socialClass: 'pagaelin'`, `requireConditions` on tribal alignment, and `eventWeightMods` referencing Pagaelin event IDs.

### 2.7 Engine branches (non-exhaustive but representative)

The following are implemented as **explicit class or event ID checks** inside `aging-engine.js`, not as data on a culture object:

- `rollLifeExpectancy`: special case for `socialClass === 'pagaelin'`.
- `familyPoolActive`: Pagaelin women under 45 always active (no spouse required).
- Pregnancy follow-on ID: `pagaelin_pregnancy` vs `pregnancy`.
- `childMortalityProb`: different curve for `char.socialClass === 'pagaelin'`.
- Class change: Pagaelin swallows generic `classChange` (no casual drift into Kaldoric classes).
- Marriage / spouse handling: multiple blocks keyed on `pagaelin_*` event IDs and `pagaelin` class.
- Archetype rerolls: pass `new Set(char.conditions)` only for Pagaelin in some call sites.
- Serialization / export: `household`, `heldWomen`, `holder`, `retainers`, `tribalAlignment` gated on `socialClass === 'pagaelin'`.

### 2.8 Tests

- `test-edge-cases.js` includes Pagaelin determinism and lists classes including `pagaelin` and `walker_shaman`.
- Snapshots and regression tests will pin behavior; adding cultures will require snapshot updates unless tests are generalized.

---

## 3. Hard-coded references and assumptions

### 3.1 Culture names in code and IDs

- String literals: `'pagaelin'`, `'walker_shaman'`, `'kaldor'` (config key), `CULTURE_CONFIGS.pagaelin`, comments referencing Kaldor/Pagaelin.
- Hundreds of **stable IDs** embed the culture name (`pagaelin_first_kill`, `colour_pagaelin_*`, …). Renaming is costly; new cultures should use a consistent ID prefix or namespace from day one.

### 3.2 “Default culture” assumption

- Kaldoric mechanics are the **baseline path**; Pagaelin is handled by **exceptions**.
- Adding a third culture that is *not* feudal risks either (a) being treated like Kaldor via fallbacks, or (b) requiring another parallel set of `if (cls === 'newculture')` branches unless hooks are introduced.

### 3.3 Shared condition namespace

- All conditions live in one registry. There is no mechanical separation between “universal,” “Kaldoric-only,” and “Pagaelin-only” flags—only naming and documentation.

### 3.4 Sub-class within a culture

- `walker_shaman` is a separate **social class** but shares culture mapping to `pagaelin`. That works for two cultures but scales awkwardly if many cultures have multiple in-culture roles (each becomes a new global class string).

---

## 4. Industry practice for very different code paths

### 4.1 Strategy pattern

Encapsulate a family of algorithms behind a common interface. The “context” (aging engine) delegates questions like “how is birth place determined?” or “is the family pool active?” to a strategy selected by culture (or class → culture).

- Reference: [Strategy pattern](https://en.wikipedia.org/wiki/Strategy_pattern) — interchangeable behaviors without growing central conditionals.

### 4.2 Plugin / registry composition

Register culture modules at startup:

- Each module exports: **id**, **class → culture** contributions (or declares which classes it owns), **merged event tables** (or patch rules), **condition definitions**, **archetype bundles**, and **engine hooks**.

This aligns with **Open/Closed**: add a new culture by adding a module and one registry line, not by editing twenty sites in `aging-engine.js`.

### 4.3 Data-driven rules over scattered `if` chains

Where behavior differs only by numbers or event IDs, prefer tables keyed by `cultureId` (or strategy methods returning those tables). Reserve imperative branches for true orchestration.

### 4.4 Anti-patterns to avoid

- **God object** engine files that know every culture’s special cases.
- **Stringly-typed** event IDs without namespaces (hard to grep, easy to collide).
- **Implicit fallback** to “majority” culture behavior for minority cultures (your `KALDORIC_FALLBACK_CULTURES` fix for weights is the right idea—extend that philosophy to other subsystems).

---

## 5. Evaluation: what works well

1. **`CLASS_CULTURE_MAP` + `CULTURE_CONFIGS`** — clear place to hang per-culture parameters; good documentation comments for adding cultures.
2. **Weighted draw fallback policy** — non-Kaldoric cultures do not inherit `unguilded`/`peasant` weights by accident; this is important for simulation integrity.
3. **Event schema** — `excludeClasses`, `requireConditions`, and per-class weights allow many Kaldoric events to stay generic without runtime branches.
4. **Separation of `walker_shaman`** as a distinct class for a distinct phase ladder while sharing culture config is a pragmatic compromise.

---

## 6. Evaluation: what works poorly for extensibility

1. **Monolithic `life-events.js` and `archetypes.js`** — new cultures will inflate shared files further; merge conflicts and cognitive load increase.
2. **Pagaelin logic in the engine core** — every new tribal culture would copy-paste patterns (`familyPoolActive`, mortality, pregnancy key, serialization).
3. **Kaldor as implicit default** — a third culture may be misclassified unless every gate is audited (`=== 'pagaelin'` is not the same as `culture !== 'kaldor'`).
4. **Condition and event ID coupling** — cross-culture stories (border, slavery, language) are woven into the same registry; harder to reason about ownership.
5. **Testing** — snapshot-heavy workflows will resist parallel culture development unless tests key off culture metadata.

---

## 7. Refactor plan: modular cultures without breaking the core loop

Phases below are ordered to minimize risk; each phase can ship independently behind the same public API (`ageCharacter`, etc.).

### Phase A — Define a culture strategy interface (no behavior change)

Introduce something like `cultures/registry.js`:

```text
getCultureForClass(socialClass) → cultureId
getStrategy(cultureId) → CultureStrategy
```

**`CultureStrategy` responsibilities** (methods or pure functions):

- `resolveBirthContext(ctx)` → `{ birthSettlement, tribalAlignment?, extraFields }`
- `rollOceanScores(ctx)` → scores object
- `resolvePublicDeity(ctx)` → deity
- `buildInitialConditions(ctx)` → patches to conditions
- `isFamilyPoolActive(ctx)` → boolean
- `pregnancyFollowOnEventId(ctx)` → string
- `childMortalityTable(ctx)` → curve or parameters
- `rollLifeExpectancy(sex, ctx)` → number
- `allowsGenericClassChange` / `applyClassChange(ctx, effects)` → optional
- `serializeExtraState(char)` → household / holder / alignment fields for export

**Migration:** Implement `KaldorStrategy` and `PagaelinStrategy`; delegate existing `aging-engine.js` logic into these one function at a time. Keep `CLASS_CULTURE_MAP` as the source of truth for `socialClass → cultureId`.

### Phase B — Split data by culture module

Create directories:

```text
cultures/
  kaldor/
    index.js          # registers strategy + metadata
    events/           # optional: slice of LIFE_EVENTS (see Phase C)
  pagaelin/
    index.js
    events/
    archetypes.js     # or re-export slice
```

**`life-events.js`** becomes either:

- a thin aggregator `module.exports = mergeEvents(kaldorEvents, pagaelinEvents, sharedEvents)`, or
- unchanged temporarily, with **automated extraction** of events whose IDs match `/^pagaelin_|^colour_pagaelin_|tribal_|lang_harnic/` into `cultures/pagaelin/events.js`.

Same for **`archetypes.js`**: Pagaelin archetypes move to `cultures/pagaelin/archetypes.js` and register into the main archetype map at load time.

### Phase C — Namespace and ownership rules

- **Shared events:** truly universal (injury, weather, generic aging) stay in `shared/`.
- **Culture-scoped events:** IDs prefixed by culture key (`pagaelin_` is already good) or `{ culture: 'pagaelin' }` metadata on each event object so the engine can validate that events do not appear in wrong pools.
- **Cross-culture events:** e.g. “learn tribal language” belong in `shared/cross/` or `border/` with explicit `excludeClasses` / `requireCulture` rather than ad hoc class lists.

### Phase D — Replace `=== 'pagaelin'` with culture capabilities

Examples:

- Instead of `if (char.socialClass === 'pagaelin' && isFemale && age < 45)`, use `strategy.familyPool.requiresSpouse === false` or `strategy.familyPool.alwaysActiveForFertileFemale`.
- Instead of branching pregnancy follow-on IDs, `strategy.getPregnancyFollowOnId(char)`.

This makes a third culture a **new strategy object**, not a new chain of `else if`.

### Phase E — Class model vs culture model (optional, larger change)

If more in-culture roles appear:

- Prefer **`cultureId` + `role`** (or keep multiple classes but generate them from culture metadata) so `CLASS_CULTURE_MAP` is data-driven from each culture module’s manifest.

### Phase F — Tests and tooling

- Unit-test each strategy in isolation (birth, family pool, mortality).
- Add a **lint or CI check**: no new `socialClass === 'pagaelin'` outside `cultures/pagaelin/` (grep-based rule).
- Regression: keep existing snapshots; add one **minimal** snapshot per culture when introducing a new culture.

---

## 8. Quick reference: files with strongest culture coupling

| File | Coupling type |
|------|----------------|
| `aging-engine.js` | Culture config, mapping, Pagaelin branches in loop |
| `life-events.js` | Conditions, weights, excludes, tribal event corpus |
| `archetypes.js` | Pagaelin archetypes and event weight mods |
| `test-edge-cases.js`, `test-regression.js`, `test-snapshots.json` | Behavioral locks |

---

## 9. Conclusion

The project already encodes a **partial** cultural abstraction (`CULTURE_CONFIGS`, `CLASS_CULTURE_MAP`, selective weight fallback). The remaining work to **unlock new cultures cleanly** is to move Pagaelin-specific **orchestration** out of the central aging loop into **culture strategies**, split **large data files** by culture (or by shared vs culture-specific), and replace **class-string conditionals** with **capability-driven** calls. That aligns the codebase with standard **strategy / plugin** practice and reduces the risk that a third culture will require invasive edits throughout `aging-engine.js`.
