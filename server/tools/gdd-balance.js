import { writeFileSync } from 'node:fs';
import { FISH } from '../src/config/fish.config.js';
import { RODS } from '../src/config/rods.config.js';
import { RISK_BANDS, STAKE_LEVELS } from '../src/config/game.config.js';
import { ASSAY_FEE_RATE, CHEST_KEY_COST, CHEST_TIERS, GEM_TIERS, APPRAISAL_GRADES } from '../src/config/rewards.config.js';
import { SHOP_ITEMS } from '../src/config/economy.config.js';
import { CHEST_EV, GEM_MEAN_GOLD, castExpectation } from '../src/game/balanceModel.js';
import { upgradeCost } from '../src/game/progression.js';
const out=['# Current-build balance tables','','Generated from active configuration with `node server/tools/gdd-balance.js --write`. No player data is changed.','','Odds assume no buffs and available bag space. Species percentages are per successful catch; chest tier percentages are per chest drop. EV means long-run expected value, not a guaranteed payout.','','Stake is the only risk lever: every table below is a function of rod level and Stake alone. A higher Stake costs more Bait and bites less often, and pays for it in rarer fish and better chests -- see the Stake ladder table.','','Hourly figures assume continuous fishing, supplied bait, immediate fish cash-in, all chests opened and gems appraised. No stock shortages, regeneration, animation delays, Gold upgrades or bag pauses. Regular 250 ms ticks round cast durations upward and the 400 ms recast delay to 500 ms. Real timing can be slower.',''];
const n=x=>x.toFixed(2), pct=x=>n(x*100)+'%';
function table(title,heads,rows){out.push('## '+title,'','| '+heads.join(' | ')+' |','| '+heads.map(()=> '---').join(' | ')+' |',...rows.map(r=>'| '+r.join(' | ')+' |'),'');}
// EV maths lives in src/game/balanceModel.js so the live emission monitor and
// these tables cannot drift apart. This tool only formats what it returns.
const gems=GEM_MEAN_GOLD, chestEv=CHEST_EV;
// One axis now. Dial modes are gone, so every grid that used to be
// modes x stakes collapses to a list keyed by Stake alone.
const STAKES=STAKE_LEVELS.map(l=>l.stake);
const stats=(r,s)=>castExpectation({rodLevel:r.level,stake:s});
const tiersOf=l=>l.chestTiers.map(t=>CHEST_TIERS.find(c=>c.id===t).name.replace(/ Chest$/,'')).join(', ');
// Bait prices are read off the shop rather than pinned here: re-pricing the
// shelf has to move the net-Gold column with it, not leave it quoting a dead
// number. With one item on the shelf, cheapest and dearest are the same row.
const tin=SHOP_ITEMS[0], crate=SHOP_ITEMS.at(-1);
const tinRate=tin.cost.amount/tin.grants.bait, crateRate=crate.cost.amount/crate.grants.bait;
const netGold=(r,s)=>{const v=stats(r,s),h=3600/v.seconds;return (v.ev.gold-v.keyGold-Math.max(0,s-v.ev.bait)*crateRate)*h;};
let cumulative=0;
table('Rod progression',['Level / rod','XP to next','Total XP to enter','Cast seconds','Base catch','Rarity bias','Chest per catch','Gold skip (empty bar)'],RODS.map(r=>{const row=[r.level+' / '+r.name,r.xpToNext??'MAX',cumulative,n(r.castMs/1000),pct(r.catchRate),r.rarityBias,pct(r.chestChance),upgradeCost(r.level)?.gold??'—'];cumulative+=r.xpToNext??0;return row;}));
table('Stake ladder',['Stake / bait per cast','Risk Dial','Name','Catch multiplier','Rarity bias','XP multiplier','Chest multiplier','Chest tiers reachable'],STAKE_LEVELS.map(l=>[l.stake,RISK_BANDS.find(b=>b.id===l.band).name,l.name,l.catchRateMult,l.rarityBias,l.xpMult,l.chestChanceMult,tiersOf(l)]));
table('Species and cash-in',['Fish','Tier','Unlock','Index','Weight','Base XP',...STAKES.map(s=>s+'x XP')],FISH.map(f=>[f.name,f.tier,f.unlockLevel,f.rarityIndex,f.weight,f.baseXp,...STAKE_LEVELS.map(l=>Math.round(f.baseXp*l.xpMult))]));
table('Chest reward odds',['Chest','Outcome','Weight / total','Probability','Amount'],CHEST_TIERS.flatMap(t=>t.rewardTable.map(e=>[t.name,e.gemTier??e.type,e.weight+' / '+t.rewardTable.reduce((s,e)=>s+e.weight,0),pct(e.weight/t.rewardTable.reduce((s,e)=>s+e.weight,0)),e.type==='uncut_gem'?'1 gem':e.min+'–'+e.max])));
table('Appraisal grades per independent trait',['Grade','Score','Probability'],APPRAISAL_GRADES.map((g,i)=>[g.id,i,pct(g.weight/100)]));
table('Gem appraisal',['Gem','Gold range','Fictional dollar quote','Mean Gold including rounding'],GEM_TIERS.map(g=>[g.name,g.gold.min+'–'+g.gold.max,'$'+g.gold.min*.1+'–$'+g.gold.max*.1,n(gems[g.id])]));
table('Expected value per opened chest',['Chest','XP','Bait','Pearl','Gold after gem appraisal'],CHEST_TIERS.map(t=>[t.name,...['xp','bait','pearls','gold'].map(k=>n(chestEv[t.id][k]))]));
table('Shop',['Item','Gold','Bait','Gold / bait','Discount vs tin'],SHOP_ITEMS.map(i=>[i.name,i.cost.amount,i.grants.bait,n(i.cost.amount/i.grants.bait),pct(1-i.cost.amount/i.grants.bait/tinRate)]));
table('Catch and chest odds: all rods and stakes',['Rod',...STAKES.map(s=>s+'x catch / chest per cast')],RODS.map(r=>[r.level,...STAKES.map(s=>{const v=stats(r,s);return pct(v.hit)+' / '+pct(v.chest);})]));
table('Species composition: all rods and stakes',['Rod','Stake',...FISH.map(f=>f.name)],RODS.flatMap(r=>STAKES.map(s=>{const v=stats(r,s);return [r.level,s,...FISH.map(f=>pct(v.species[f.id]))];})));
table('Chest tier composition: all rods and stakes',['Rod','Stake',...CHEST_TIERS.map(t=>t.name)],RODS.flatMap(r=>STAKES.map(s=>{const v=stats(r,s);return [r.level,s,...CHEST_TIERS.map(t=>pct(v.tiers[t.id]))];})));
table('Hourly economy: every rod and stake',['Rod','Stake','Catches','Chests','XP','Gold','Pearl','Bait spent','Chest bait','Chest keys','Net Gold after bait and keys'],RODS.flatMap(r=>STAKES.map(s=>{const v=stats(r,s),h=3600/v.seconds;return [r.level,s,n(v.hit*h),n(v.chest*h),n(v.ev.xp*h),n(v.ev.gold*h),n(v.ev.pearls*h),n(s*h),n(v.ev.bait*h),n(v.keyGold*h),n(netGold(r,s))];})));
out.push('Gold is what appraisals pay after the '+Math.round(ASSAY_FEE_RATE*100)+'% assay fee. Chest keys are the Gold spent opening Epic ('+CHEST_KEY_COST.epic+') and Legendary ('+CHEST_KEY_COST.legendary+') chests.','');
out.push('Net Gold uses the shelf price, '+crateRate.toFixed(2)+' Gold/bait, and fractional-pack accounting. It assumes sufficient cash and stock; it does not establish new-player solvency. At rod 10, XP has no further rod benefit.','');
table('The spread the lever is worth: Stake 1 against Stake 40',['Rod','Gold/hour at 1x','Gold/hour at 40x','Ratio','Net Gold/hour at 1x','Net Gold/hour at 40x'],RODS.map(r=>{const g=s=>{const v=stats(r,s);return v.ev.gold*3600/v.seconds;};const lo=g(1),hi=g(40);return [r.level,n(lo),n(hi),n(hi/lo)+'x',n(netGold(r,1)),n(netGold(r,40))];}));
out.push('The ratio is the headline number the design sells: what turning the one lever from the bottom of the ladder to the top is worth per hour. It is quoted on **gross** Gold because that is a property of the fishing loop alone.','','The two net columns are quoted separately because net Gold also depends on the Bait price, which is set on the shelf rather than here: the shop sells 100 Bait for 3 Gold, so bait costs '+crateRate.toFixed(2)+' Gold each. The rest of `design/gold-value-anchor-rebalance-plan.md` (cast cost, gem values, drop rates) is still open. Stake 1 here reproduces the old Steady-at-Stake-1 economy to the coin. See the note on SHOP_ITEMS in `server/src/config/economy.config.js`.','');
table('Approximate L1 to L10 progression',['Stake','Fish XP only (hours)','Fish + chest XP (hours)'],STAKES.map(s=>{let fish=0,all=0;for(const r of RODS.slice(0,-1)){const v=stats(r,s);fish+=r.xpToNext/v.fishXp*v.seconds;all+=r.xpToNext/v.ev.xp*v.seconds;}return [s,n(fish/3600),n(all/3600)];}));
out.push('Times sum XP threshold / XP EV for each level. They are rate approximations, not simulated mean completion times: chest bursts can skip levels and fish banking delays unlocks. They exclude buying rod upgrades.','');
table('Expected time to fill an empty 80-fish bag',['Rod','Stake','Minutes'],[RODS[0],RODS.at(-1)].flatMap(r=>[1,10,40].map(s=>{const v=stats(r,s);return [r.level,s,n(80/v.hit*v.seconds/60)];})));
const report=out.join('\n')+'\n';
if(process.argv.includes('--write'))writeFileSync(new URL('../../design/balance-tables.md',import.meta.url),report);else console.log(report);
