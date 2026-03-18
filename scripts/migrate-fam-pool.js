'use strict';
const fs = require('fs');
let src = fs.readFileSync('life-events.js', 'utf8');

const famIds = [
  'colour_fam_child_river','colour_fam_spouse_burned_dinner','colour_fam_child_phrase',
  'colour_fam_got_lost_together','colour_fam_stray_kept','colour_fam_sick_night',
  'colour_fam_spouse_hidden_skill','colour_fam_parent_advice_right','colour_fam_child_misunderstood',
  'colour_fam_laughed_together','colour_fam_spouse_snoring','colour_fam_taught_child_trade',
  'colour_fam_argument_trivial','colour_fam_child_first_task','colour_fam_old_parent_repeated_story',
  'colour_fam_child_asked_about_death','colour_fam_spouse_found_old_thing','colour_fam_walk_together',
  'colour_fam_parent_worked_hard','colour_fam_child_scared_harmless','colour_fam_spouse_old_habit',
];

let changed = 0;
for (const id of famIds) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    "(id: '" + escaped + "',\\s*\\n\\s*label: [^\\n]+\\n\\s*pool: )'colour'",
    'g'
  );
  const before = src;
  src = src.replace(re, "$1'family'");
  if (src !== before) changed++;
  else console.warn('NO MATCH for', id);
}

fs.writeFileSync('life-events.js', src);
console.log('Pool changed on', changed, '/ 21 events');
