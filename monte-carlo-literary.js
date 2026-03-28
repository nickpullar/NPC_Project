#!/usr/bin/env node
'use strict';

/**
 * Monte Carlo Literary Corpus — generates 10,000 NPC profiles and stores
 * stratified samples for Professor Hawthorne's literary evaluation.
 *
 * Run: node monte-carlo-literary.js
 */

const fs = require('fs');
const path = require('path');
const { generateFullNPC } = require('./generate-full-npc');

const N = 10_000;
const CLASSES = [
  'noble', 'merchant', 'warrior', 'soldier', 'peasant', 'artisan',
  'unguilded', 'clergy', 'lia_kavair', 'guilded_innkeeper',
];
const SEXES = ['male', 'female'];
const MIN_AGE = 18;
const MAX_AGE = 75;

function run() {
  console.log(`\n=== Monte Carlo Literary Corpus (N=${N.toLocaleString()}) ===\n`);

  const allNarratives = [];
  const allMarkdown = [];
  const stratified = []; // one per class/sex combo for deep review
  const seen = new Set();

  const start = Date.now();

  for (let i = 0; i < N; i++) {
    const seed = i;
    const socialClass = CLASSES[i % CLASSES.length];
    const sex = SEXES[i % 2];
    const targetAge = MIN_AGE + (i % (MAX_AGE - MIN_AGE + 1));

    try {
      const npc = generateFullNPC({
        socialClass,
        sex,
        targetAge,
        seed,
      });

      const narrative = npc.narrative || [];
      const narrativeText = narrative.join(' ');
      const { renderNPC } = require('./md-writer');
      const md = renderNPC(npc);

      allNarratives.push({
        seed, socialClass, sex, targetAge,
        narrative,
        narrativeText,
        name: npc.name?.full || npc.name,
      });

      // Stratified: ensure diversity for qualitative review
      const key = `${socialClass}_${sex}`;
      if (!seen.has(key) || stratified.filter(s => s.key === key).length < 5) {
        seen.add(key);
        stratified.push({
          key,
          seed, socialClass, sex, targetAge,
          fullMarkdown: md,
          narrative,
          personality: npc.personality,
          conditions: npc.conditions,
        });
      }

      if ((i + 1) % 2000 === 0) {
        console.log(`  ... ${(i + 1).toLocaleString()} / ${N.toLocaleString()}`);
      }
    } catch (e) {
      console.error(`  Error at seed ${seed}: ${e.message}`);
    }
  }

  const elapsed = Date.now() - start;
  console.log(`\nCompleted in ${(elapsed / 1000).toFixed(1)}s\n`);

  // Save stratified sample (500 profiles: 50 per class for analysis)
  const analysisSample = [];
  for (const cls of CLASSES) {
    for (const sex of SEXES) {
      const matching = allNarratives.filter(n => n.socialClass === cls && n.sex === sex);
      const take = Math.min(25, matching.length);
      for (let j = 0; j < take; j++) {
        const idx = Math.floor((j / take) * matching.length);
        if (matching[idx]) analysisSample.push(matching[idx]);
      }
    }
  }

  // Deep review sample: 50 representative profiles (full markdown)
  const deepReview = stratified.slice(0, 50);

  const outputDir = path.join(__dirname, 'literary-corpus');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  fs.writeFileSync(
    path.join(outputDir, 'analysis-sample-500.json'),
    JSON.stringify(analysisSample.slice(0, 500), null, 0),
    'utf8'
  );
  fs.writeFileSync(
    path.join(outputDir, 'deep-review-50.json'),
    JSON.stringify(deepReview, null, 2),
    'utf8'
  );
  fs.writeFileSync(
    path.join(outputDir, 'all-narratives-10k.json'),
    JSON.stringify(allNarratives.map(n => ({ ...n, narrative: undefined })), null, 0), // narrativeText only for size
    'utf8'
  );

  // Also write 50 full markdown files for human reading
  const samplesDir = path.join(outputDir, 'sample-profiles');
  if (!fs.existsSync(samplesDir)) fs.mkdirSync(samplesDir, { recursive: true });
  deepReview.forEach((s, i) => {
    fs.writeFileSync(
      path.join(samplesDir, `profile-${i + 1}-${s.socialClass}-${s.sex}-seed${s.seed}.md`),
      s.fullMarkdown,
      'utf8'
    );
  });

  console.log(`  Wrote ${outputDir}`);
  console.log(`  - analysis-sample-500.json (${analysisSample.length} narratives)`);
  console.log(`  - deep-review-50.json (50 full profiles)`);
  console.log(`  - sample-profiles/ (50 .md files for reading)\n`);
}

run();
