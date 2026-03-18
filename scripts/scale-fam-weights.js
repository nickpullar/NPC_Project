'use strict';
const fs = require('fs');
let src = fs.readFileSync('life-events.js', 'utf8');

// Scale all weight values inside colour_fam blocks.
// Strategy: find each colour_fam event's weights block and divide each number by ~1.7,
// floor to 1 minimum, round to integer.
// We do this by finding the weights: { ... } block for each event and transforming
// only the numeric values within it.

const famIds = [
  'colour_fam_child_river','colour_fam_spouse_burned_dinner','colour_fam_child_phrase',
  'colour_fam_got_lost_together','colour_fam_stray_kept','colour_fam_sick_night',
  'colour_fam_spouse_hidden_skill','colour_fam_parent_advice_right','colour_fam_child_misunderstood',
  'colour_fam_laughed_together','colour_fam_spouse_snoring','colour_fam_taught_child_trade',
  'colour_fam_argument_trivial','colour_fam_child_first_task','colour_fam_old_parent_repeated_story',
  'colour_fam_child_asked_about_death','colour_fam_spouse_found_old_thing','colour_fam_walk_together',
  'colour_fam_parent_worked_hard','colour_fam_child_scared_harmless','colour_fam_spouse_old_habit',
];

const SCALE = 1.8;

let totalChanged = 0;

for (const id of famIds) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match the weights block: from 'weights: {' up to the first closing '  },'
  // that ends a top-level weights object (i.e., indented with 4 spaces).
  const blockRe = new RegExp(
    "(id: '" + escaped + "'[\\s\\S]*?weights:\\s*\\{)([\\s\\S]*?)(\\s*\\},\\s*\\n\\s*sexWeightMod)",
    'm'
  );

  src = src.replace(blockRe, (match, pre, weightsBlock, post) => {
    // Replace every numeric value in the weights block
    const scaled = weightsBlock.replace(/:\s*(\d+)/g, (m, n) => {
      const orig = parseInt(n, 10);
      const scaled = Math.max(3, Math.round(orig / SCALE));
      return ': ' + scaled;
    });
    totalChanged++;
    return pre + scaled + post;
  });
}

fs.writeFileSync('life-events.js', src);
console.log('Weight blocks scaled on', totalChanged, '/ 21 events');
