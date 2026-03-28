# Security & architecture remediation guide

This document breaks down issues identified in a breach-first review of the NPC project (Node.js generator: `aging-engine.js`, `md-writer.js`, `physical-description.js`, scripts, etc.) and suggests concrete mitigations.

**Scope note:** The codebase is primarily a **CLI/library**, not a hosted web application. Several classic OWASP categories (SQLi, CSRF, session hijacking) do not apply *until* this stack is wrapped in a server or fed **untrusted** input.

---

## 1. Critical severity

### 1.1 Path traversal via `location` (and path composition)

**Problem**  
`npcVaultPath` and `stubVaultPath` interpolate `location` directly into the relative path:

```text
Locations/${location}/NPCs/...
```

If `location` contains segments like `..` or absolute-style components, `path.join(vaultRoot, relPath)` can resolve **outside** the intended vault root.

**Risk**  
Any code path that sets `npc.location` from **untrusted** data (web UI, imported markdown, API) can **overwrite arbitrary files** the process can write to.

**Suggested solutions**

1. **Canonicalize and jail paths**  
   - After `path.join(vaultRoot, relPath)`, require  
     `path.resolve(outputPath).startsWith(path.resolve(vaultRoot) + path.sep)`  
     (or use `path.relative` and reject if it starts with `..`).
2. **Whitelist `location`**  
   - Only allow known location strings from a campaign config; reject anything not in the set.
3. **Slug `location` the same way as names**  
   - e.g. `toSlug(location)` and reject empty/suspicious results; never pass raw user strings into path templates.

---

### 1.2 API key exposure and third-party data disclosure (Anthropic)

**Problem**  
`generatePhysicalDescription` reads `ANTHROPIC_API_KEY` from the environment and sends NPC-derived prompts to `api.anthropic.com`. Key material can leak via logs, CI artifacts, crash dumps, or shared developer machines. NPC content (including GM-only narrative) is **disclosed to a third party** on every call.

**Risk**  
Credential theft; compliance / campaign secrecy failure; prompt injection from crafted NPC fields affecting provider-side behavior or billing.

**Suggested solutions**

1. **Secrets management**  
   - Never log env vars; use a secrets manager or local-only `.env` excluded from git; rotate keys if ever committed.
2. **Data minimization**  
   - Strip or redact GM-only blocks and sensitive fields before building the LLM prompt; document what is sent.
3. **Optional feature**  
   - Keep `generatePhysical()` as the default offline path; require explicit opt-in for API calls in CI/production.
4. **Rate limits & timeouts**  
   - Wrap `fetch` with timeouts, retry caps, and structured error handling to avoid hung jobs and runaway cost.
5. **Model/version config**  
   - Move model id to env or config file so deprecation does not require code edits.

---

### 1.3 Destructive in-place file rewrites (scripts)

**Problem**  
Scripts such as `scripts/migrate-fam-pool.js` and `scripts/scale-fam-weights.js` read and write `life-events.js` in place.

**Risk**  
Wrong working directory, partial failure, or concurrent runs → **corrupted** primary data file with no automatic backup.

**Suggested solutions**

1. Write to a **temporary file**, then **atomic rename** (`fs.rename`) after success.  
2. Require explicit `--confirm` or env flag before mutating repo files.  
3. Create a **timestamped backup** copy before overwrite.  
4. Run only in CI with a clean checkout and fail if `git status` is dirty.

---

## 2. Logic & edge cases

### 2.1 Global RNG shared across concurrent work

**Problem**  
`rng.js` uses a single module-level generator. Overlapping async or parallel `ageCharacter` calls interleave `rand()` consumption.

**Risk**  
Nondeterministic results even when callers pass seeds; impossible-to-reproduce bugs under load.

**Suggested solutions**

1. **Instance-based RNG**  
   - Pass a seeded `rng` (or `seedRng` scoped to a closure) into `ageCharacter` and all helpers instead of global state.  
2. **Document thread model**  
   - If staying global, state clearly: “single-threaded, one generation at a time.”  
3. **Worker isolation**  
   - Each worker process gets its own module instance (Node workers) — still avoid async interleaving *within* one process.

---

### 2.2 Unseeded `Math.random()` fallback

**Problem**  
When `seedRng(null)` or never seeded, `rand()` uses `Math.random()`.

**Risk**  
Non-reproducible tests and audits; unsuitable if anything security-sensitive ever used the same RNG (it should not).

**Suggested solutions**

1. In test/CI, **fail fast** if `ageCharacter` runs without an explicit seed (optional strict mode).  
2. Default new CLIs to **require `--seed`** or auto-generate and print seed.  
3. Keep `Math.random()` only behind an explicit `NODE_ENV` or flag for ad-hoc play.

---

### 2.3 Stub / frontmatter parsing fragility

**Problem**  
`parseStubFromMarkdown` uses `JSON.parse` with a catch that leaves malformed JSON as a raw string; YAML is not a real parser (line-based). Crafted or corrupted files produce **partial** objects.

**Risk**  
Silent wrong replays in `expandStub`; hard-to-debug state.

**Suggested solutions**

1. Use a **proper YAML parser** for frontmatter (e.g. `yaml` package) with schema validation.  
2. On `JSON.parse` failure, **reject** the stub or log a high-severity warning instead of storing a string.  
3. Validate `sharedEvents` shape with a small schema (array of objects with required fields).

---

### 2.4 Frontmatter string injection

**Problem**  
Values like `name` are embedded in double-quoted YAML fields without escaping internal quotes or newlines.

**Risk**  
Broken or ambiguous YAML; Obsidian or other tools may misparse; possible confusion attacks in shared vaults.

**Suggested solutions**

1. Use YAML library **dump** with quoting rules instead of string concatenation.  
2. Or escape `"` and newlines in scalar fields per YAML rules.  
3. Add a round-trip test: parse written frontmatter and compare to expected fields.

---

## 3. Architectural debt

### 3.1 Monolithic modules

**Problem**  
`life-events.js` and `aging-engine.js` are very large single files; load-time cost and merge conflict risk are high.

**Suggested solutions**

1. Split **data** (event definitions) from **engine** (loops, resolvers).  
2. Split events by **domain** or **culture** (see culture modularity audit) and merge at load.  
3. Add a **schema validation** step in CI that does not require loading the full engine if possible.

---

### 3.2 No package manifest / lockfile

**Problem**  
No `package.json` in tree means no pinned dependencies, no `engines` field, no `npm audit`.

**Suggested solutions**

1. Add `package.json` with **exact Node version** (`engines`) and any dependencies (e.g. YAML, dotenv).  
2. Use **lockfile** (`package-lock.json` or `pnpm-lock.yaml`).  
3. CI: `node --version` check + `npm ci` + tests.

---

## 4. Dependency & environment risks

### 4.1 Implicit `fetch` requirement

**Problem**  
Global `fetch` assumes **Node 18+** (or polyfill). Older Node fails at runtime.

**Suggested solutions**

1. Document minimum Node in README and `engines`.  
2. Optionally depend on `undici` or use `node-fetch` with a clear version bound.

---

### 4.2 Hard-coded Anthropic model ID

**Problem**  
Model string is fixed in code; provider changes break behavior silently or suddenly.

**Suggested solutions**

1. `ANTHROPIC_MODEL` or config file default.  
2. Integration test that verifies API reachability in a non-secret smoke job (optional).

---

### 4.3 Large fixtures in repository

**Problem**  
Huge JSON snapshots and literary corpus increase clone size and risk of accidental secret paste into generated content.

**Suggested solutions**

1. Git LFS or separate **artifacts** repo for multi-MB JSON.  
2. Pre-commit hook scanning for API key patterns.  
3. `.gitignore` for local experimental outputs.

---

## 5. Quick priority matrix

| Priority | Item | Action |
|----------|------|--------|
| P0 | Path traversal | Normalize + vault-root check before every write |
| P0 | API key / prompt exfil | Redact prompts; secrets hygiene; opt-in API |
| P1 | Global RNG | Per-run RNG instance or documented single-flight |
| P1 | Destructive scripts | Atomic writes + backup + confirmation |
| P2 | package.json + engines | Reproducible runtime and audits |
| P2 | Frontmatter / YAML | Real parser + escaping |
| P3 | Module size | Incremental split of data vs engine |

---

## 6. If you add a web API later

Assume **all** current issues become worse:

- Authenticate and authorize every NPC/stub **by tenant/user** (IDOR).  
- CSRF protection for state-changing routes if using cookies.  
- Never trust `location`, `name`, or markdown from clients without validation.  
- Do not forward raw user text to LLMs without **prompt injection** mitigations (tool allowlists, output filtering, separate system/user roles).  
- Rate limit and cap payload sizes on generation endpoints.

This file should be updated when major surfaces (new writers, new network calls) are added.
