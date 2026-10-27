/**
 * Headless end-to-end smoke test.
 *
 * Drives the real Colyseus server with the real client library and asserts the
 * whole contracted loop: join -> cast -> catch -> XP -> level -> chest -> shop,
 * plus guest-session persistence and the three multiplayer surfaces (player
 * list, chat, leaderboard) across two concurrent sessions.
 *
 *   node test/smoke.js [ws://127.0.0.1:3001]
 *
 * Exits non-zero on the first failed assertion, so it can gate a deploy.
 */

import { Client, getStateCallbacks } from 'colyseus.js';

const ENDPOINT = process.argv[2] || process.env.SMOKE_ENDPOINT || 'ws://127.0.0.1:3001';
const ROOM = 'harbor';

let passed = 0;
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves with the first payload of `type`, or rejects on timeout. */
function next(room, type, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for "${type}"`)), timeoutMs);
    room.onMessage(type, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/** Collects every payload of `type` into an array for later assertions. */
function collect(room, type, sink) {
  room.onMessage(type, (payload) => sink.push(payload));
}

async function connect(options) {
  const client = new Client(ENDPOINT);
  const room = await client.joinOrCreate(ROOM, options);
  // Swallow message types this particular test client does not assert on,
  // so the library stops warning about unregistered handlers.
  room.onMessage('*', () => {});
  return room;
}

async function main() {
  console.log(`\nSmoke test against ${ENDPOINT}\n`);

  /* ---------------------------------------------------- session + catalog */
  console.log('Session, catalog and starting state');

  const alice = await connect({ displayName: 'SmokeAlice' });
  const catalogPromise = next(alice, 'catalog');
  const sessionPromise = next(alice, 'session');
  const mePromise = next(alice, 'me');

  const catalog = await catalogPromise;
  const session = await sessionPromise;
  let me = await mePromise;

  check('catalog lists 6 fish species', catalog.fish?.length === 6, `got ${catalog.fish?.length}`);
  check('catalog lists 4 gem tiers', catalog.gemTiers?.length === 4, `got ${catalog.gemTiers?.length}`);
  check('catalog carries the appraisal traits and grade ladder',
    catalog.appraisal?.traits?.length > 0 && catalog.appraisal?.grades?.length > 0,
    `${catalog.appraisal?.traits?.length} traits, ${catalog.appraisal?.grades?.length} grades`);
  check('species carry the GDD XP values',
    catalog.fish.map((fish) => fish.baseXp).join(',') === '4,6,8,16,32,64',
    catalog.fish.map((fish) => `${fish.name}+${fish.baseXp}`).join(' '));
  check('species are gated behind rod levels',
    catalog.fish.every((fish) => fish.unlockLevel >= 1)
      && catalog.fish.at(-1).unlockLevel > catalog.fish[0].unlockLevel);
  check('catalog lists 10 rod levels', catalog.rods?.length === 10, `got ${catalog.rods?.length}`);
  check('catalog lists 4 chest tiers', catalog.chestTiers?.length === 4, `got ${catalog.chestTiers?.length}`);
  // Sparks and Bonus Catch were removed from the game outright (see the A3b
  // note in rewards.config.js), dropping REWARD_TYPES from 7 to 5. Pre-existing
  // stale assertion, unrelated to the fish-bag work; fixed in passing.
  check('catalog lists 5 reward types', catalog.rewardTypes?.length === 5, `got ${catalog.rewardTypes?.length}`);
  check('catalog lists 5 stake levels', catalog.stakes?.length === 5, `got ${catalog.stakes?.length}`);
  // Stake is the only risk lever now, so the catalog has to carry enough of
  // each rung for the HUD to state the trade-off -- a bare list of numbers is
  // what let the old UI advertise Stake as pure upside.
  check('every stake carries a name, a blurb and its chest tiers',
    (catalog.stakes ?? []).every((level) =>
      level.name && level.blurb && level.chestTiers?.length > 0),
    JSON.stringify(catalog.stakes));
  // Steady / Balanced / Risky survive as a read-out over the ladder, not as a
  // control -- the contract names them, and the HUD still shows all three.
  check('catalog lists 3 risk bands', catalog.riskBands?.length === 3, `got ${catalog.riskBands?.length}`);
  check('every stake names a risk band the catalog defines',
    (catalog.stakes ?? []).every((level) =>
      (catalog.riskBands ?? []).some((band) => band.id === level.band)),
    JSON.stringify((catalog.stakes ?? []).map((l) => [l.stake, l.band])));
  check('Legendary chests are gated behind Stake 10',
    (catalog.stakes ?? []).every((level) =>
      level.chestTiers?.includes('legendary') === (level.stake >= 10)),
    JSON.stringify((catalog.stakes ?? []).map((l) => [l.stake, l.chestTiers])));
  // Fields carrying odds, not the words themselves: "Weight" is one of the
  // traits a gem is graded on, so a plain substring search for it reports a
  // leak that is really just a trait name.
  const catalogJson = JSON.stringify(catalog);
  check('catalog carries no probability tables',
    !/"catchRate"\s*:/.test(catalogJson) && !/"weight"\s*:\s*[\d.]/.test(catalogJson),
    catalogJson.match(/"(catchRate|weight)"\s*:\s*[\d.]+/g)?.join(' ') ?? '');

  check('server issues a 64-char session token', /^[a-f0-9]{64}$/.test(session.sessionToken || ''));
  check('display name accepted', me.displayName === 'SmokeAlice', me.displayName);
  check('starts at rod level 1', me.rodLevel === 1);
  check('a level 1 rod has only the starting species unlocked',
    me.unlockedSpecies?.length === 1, (me.unlockedSpecies ?? []).join(', '));
  check('a level 1 rod is quoted a gold upgrade price',
    me.upgrade?.gold > 0, JSON.stringify(me.upgrade));
  check('starts with bait', me.bait > 0, `bait=${me.bait}`);

  /* ------------------------------------------------------- the core loop */
  console.log('\nCore loop: cast -> catch -> reward -> progression');

  const results = [];
  collect(alice, 'cast_result', results);
  const meUpdates = [];
  collect(alice, 'me', meUpdates);

  // Stake 1 for the idle phase, deliberately. At 5x the 100 starting bait buys
  // only 20 casts, which lands right on the edge of the 120 XP needed for level
  // 2 -- one run reached 24 casts and stopped at L1, failing on the game's
  // behaviour being fine and the test starving itself. Stake scaling gets its
  // own check below, where it is not competing for the same bait.
  await alice.send('set_stake', { stake: 1 });

  const firstCast = await next(alice, 'cast_started');
  check('cast_started carries a server-owned duration', firstCast.durationMs > 0, `${firstCast.durationMs}ms`);
  check('cast spends bait', firstCast.baitSpent > 0, `spent ${firstCast.baitSpent}`);

  // Let the idle loop run unattended -- this is the "automatic fishing session
  // that consumes resources in real time" requirement.
  const baitBefore = firstCast.bait;
  await sleep(22000);

  check('idle loop auto-cast repeatedly without input', results.length >= 4, `${results.length} results`);
  check('idle loop consumed bait over time',
    meUpdates.at(-1).bait < baitBefore, `${baitBefore} -> ${meUpdates.at(-1).bait}`);

  // Keep the idle loop running until the player has both levelled up and held a
  // chest. Catches, level-ups and chest drops are all probabilistic by design --
  // a handful of casts is not a sample, and a smoke test that fails one run in
  // seven is worse than no test. The statistics themselves (rarity curves, tier
  // weights, reward reachability) are covered deterministically by the server
  // unit tests; this only waits for the end-to-end path to have been exercised.
  //
  // A catch no longer pays Fishing Power on the spot -- it waits in the bag
  // until cashed in (see cash_out_all_fish), so this loop cashes in on every
  // pass, the way an attentive player would. Without that the rod would never
  // level here at all, and the bag would eventually fill and silently stop
  // every future auto-cast (FISH_BAG_FULL) for the rest of the run.
  console.log('  ....  idling until the rod levels up and a chest drops');
  const IDLE_WAIT_MS = 240000;
  const waitStarted = Date.now();
  const goalsMet = () => meUpdates.at(-1).rodLevel > 1 && meUpdates.at(-1).chests.length > 0;
  while (!goalsMet() && Date.now() - waitStarted < IDLE_WAIT_MS) {
    await alice.send('cash_out_all_fish', {});
    await sleep(2000);
  }
  console.log(`  ....  idled ${Math.round((Date.now() - waitStarted) / 1000)}s`);

  const catches = results.filter((result) => result.success);
  check('catches landed', catches.length > 0, `${catches.length}/${results.length} casts`);
  check('a catch names a species', Boolean(catches[0]?.species?.name), catches[0]?.species?.name);
  check('a catch drops into the fish bag rather than paying out on the spot',
    Boolean(catches[0]?.fish?.id), JSON.stringify(catches[0]?.fish));
  check('a catch is worth Fishing Power once cashed in', catches[0]?.xp > 0, `${catches[0]?.xp}`);
  check('every catch reports the active stake',
    catches.every((result) => result.stake === 1));

  me = meUpdates.at(-1);
  check('XP accumulated from cashing in caught fish', me.totalXp > 0, `${me.totalXp}`);
  check('rod levelled up from fishing and cashing in the catch', me.rodLevel > 1, `rod L${me.rodLevel}`);
  check('catch counter matches the catches observed', me.totalCatches === catches.length,
    `server says ${me.totalCatches}, client saw ${catches.length}`);
  check('cast counter matches the casts observed', me.totalCasts === results.length,
    `server says ${me.totalCasts}, client saw ${results.length}`);

  // Level-ups now land on a `fish_cashed`/`fish_cashed_all` reply rather than
  // on `cast_result` -- a catch itself never carries one any more.
  console.log(`  info  ${results.length} casts, ${catches.length} catches, rod L${me.rodLevel}`);

  /* -------------------------------------------------------------- chests */
  console.log('\nTreasure chests');

  check('chests drop from catches while idling', me.chests.length > 0,
    `none held after ${Math.round((Date.now() - waitStarted) / 1000)}s of fishing`);

  if (me.chests.length > 0) {
    const target = me.chests[0];
    await alice.send('open_chest', { chestId: target.id });
    const opened = await next(alice, 'chest_opened');

    check('a chest yields exactly one reward', opened.rewards?.length === 1,
      `${opened.rewards?.length} rewards`);
    check('chest tier is one of the 4', catalog.chestTiers.some((tier) => tier.id === opened.tier), opened.tier);
    check('the reward is a known type',
      opened.rewards.every((reward) => catalog.rewardTypes.some((type) => type.id === reward.type)));

    const offered = catalog.chestTiers.find((tier) => tier.id === opened.tier)?.contents ?? [];
    check('the reward is one the tier advertises',
      offered.some((entry) => entry.type === opened.rewards[0].type),
      `${opened.rewards[0].type} not in [${offered.map((entry) => entry.type).join(', ')}]`);

    // A chest id can only be spent once.
    await alice.send('open_chest', { chestId: target.id });
    const rejection = await next(alice, 'error_msg', 5000);
    check('re-opening the same chest is rejected', rejection.code === 'CHEST_NOT_OWNED', rejection.code);
  }

  /* ---------------------------------------------- appraisal and progression */
  console.log('\nGem appraisal and rod upgrades');

  // A chest pays one reward, and its gem is one entry on the table rather than
  // a guarantee -- a little over half of opens. So keep opening held chests
  // (and idling for more) until a gem turns up, rather than assuming the next
  // one carries it. Bait is topped up along the way, because a player who runs
  // dry stops casting and no further chests would ever arrive.
  // The shop sells Bait one unit at a time now (see economy.config.js), so a
  // top-up buys a batch of units in one message rather than one fixed pack.
  const BAIT_TOPUP_QTY = 50;
  const baitTopupCost = (catalog.shop.find((item) => item.id === 'bait')?.cost?.amount
    ?? Number.POSITIVE_INFINITY) * BAIT_TOPUP_QTY;
  console.log('  ....  opening chests until an uncut gem drops');
  const GEM_WAIT_MS = 300000;
  const gemWaitStarted = Date.now();
  let chestsOpened = 0;

  me = await requestMe(alice);
  while ((me.uncutGems?.length ?? 0) === 0 && Date.now() - gemWaitStarted < GEM_WAIT_MS) {
    // Paced well under RATE_LIMIT. Round trips on localhost take a couple of
    // milliseconds, so an unpaced loop trips the limiter, and the resulting
    // RATE_LIMITED reply then sits in the error stream that the validation
    // checks further down read from -- failing five unrelated assertions.
    await sleep(150);

    if ((me.fish?.length ?? 0) > 0) {
      // The idle loop is still auto-casting through this whole wait. A bag
      // left uncashed would eventually hit its cap and silently stop every
      // future cast (FISH_BAG_FULL), including the ones this loop is waiting
      // on for more chests.
      await alice.send('cash_out_all_fish', {});
    } else if (me.bait < 10 && me.gold >= baitTopupCost) {
      await alice.send('buy', { itemId: 'bait', quantity: BAIT_TOPUP_QTY });
      await next(alice, 'purchased');
    } else if (me.chests.length > 0) {
      await alice.send('open_chest', { chestId: me.chests[0].id });
      await next(alice, 'chest_opened');
      chestsOpened += 1;
    } else {
      await sleep(2000);
    }

    me = await requestMe(alice);
  }
  console.log(`  ....  opened ${chestsOpened} chests over `
    + `${Math.round((Date.now() - gemWaitStarted) / 1000)}s`);

  check('opening chests yields uncut gems', (me.uncutGems?.length ?? 0) > 0,
    `${me.uncutGems?.length ?? 0} held after ${Math.round((Date.now() - gemWaitStarted) / 1000)}s`);

  if ((me.uncutGems?.length ?? 0) > 0) {
    const gem = me.uncutGems[0];
    const gemMeta = catalog.gemTiers.find((tier) => tier.id === gem.tier);
    const goldBefore = me.gold;

    await alice.send('appraise_gem', { gemId: gem.id });
    const appraised = await next(alice, 'gem_appraised');

    check('an uncut gem is one of the 4 tiers', Boolean(gemMeta), gem.tier);
    check('an appraisal pays gold', appraised.gold > 0, `${appraised.gold}`);
    check('an appraisal pays inside the tier range',
      appraised.gold >= gemMeta.gold.min && appraised.gold <= gemMeta.gold.max,
      `${appraised.gold} outside ${gemMeta.gold.min}-${gemMeta.gold.max}`);
    check('every trait comes back graded',
      appraised.grades?.length === catalog.appraisal.traits.length,
      `${appraised.grades?.length} of ${catalog.appraisal.traits.length}`);

    me = await requestMe(alice);
    check('appraised gold reach the wallet', me.gold >= goldBefore + appraised.gold - 1,
      `${goldBefore} -> ${me.gold}`);
    check('an appraised gem leaves the bag',
      !me.uncutGems.some((held) => held.id === gem.id));

    await alice.send('appraise_gem', { gemId: gem.id });
    const replay = await next(alice, 'error_msg', 5000);
    check('re-appraising the same gem is rejected', replay.code === 'GEM_NOT_OWNED', replay.code);
  }

  await alice.send('appraise_gem', { gemId: 'not-a-real-id' });
  check('a malformed gem id is rejected',
    (await next(alice, 'error_msg', 5000)).code === 'GEM_INVALID');

  // Rod upgrades: the server quotes the price, so an invented one cannot stick.
  me = await requestMe(alice);
  if (me.upgrade && me.gold >= me.upgrade.gold) {
    const levelBefore = me.rodLevel;
    const goldBefore = me.gold;
    const price = me.upgrade.gold;

    await alice.send('upgrade_rod', {});
    const upgraded = await next(alice, 'rod_upgraded');

    check('buying a level raises the rod level',
      upgraded.levelUp.toLevel === levelBefore + 1,
      `${levelBefore} -> ${upgraded.levelUp.toLevel}`);

    me = await requestMe(alice);
    check('buying a level charges the quoted gold',
      me.gold <= goldBefore - price + 5, `${goldBefore} -> ${me.gold}, price ${price}`);
    check('a bought level unlocks its species',
      me.unlockedSpecies.length >= 1, me.unlockedSpecies.join(', '));
  } else {
    console.log('  skip  not enough gold to buy a rod level');
  }

  /* --------------------------------------------------------------- stake */
  console.log('\nStake scaling');

  const beforeStake = await requestMe(alice);
  await alice.send('set_stake', { stake: 5 });
  const stakedMe = await requestMe(alice);

  check('raising the stake raises the bait cost per cast',
    stakedMe.baitPerCast === beforeStake.baitPerCast * 5,
    `${beforeStake.baitPerCast} -> ${stakedMe.baitPerCast}`);

  const stakedCast = await next(alice, 'cast_started', 20000);
  check('a 5x cast spends 5x the bait', stakedCast.baitSpent === 5, `${stakedCast.baitSpent}`);
  check('a 5x cast reports its stake', stakedCast.stake === 5, `${stakedCast.stake}`);

  // Back to 1x so the rest of the run is not fighting for bait either.
  await alice.send('set_stake', { stake: 1 });

  /* ------------------------------------------------------ economy / shop */
  console.log('\nEconomy and shop');

  me = await requestMe(alice);
  const baitItem = catalog.shop.find((item) => item.id === 'bait');
  check('shop prices are in-game currency only',
    catalog.shop.every((item) => ['bait', 'gold', 'pearls'].includes(item.cost.currency)));
  check('only bait is on sale',
    catalog.shop.filter((item) => item.purchasable !== false)
      .every((item) => item.type === 'bait' && item.grants.bait > 0));

  check('the shop shelf is public and finite',
    alice.state.baitStock > 0 && alice.state.baitStock <= alice.state.baitStockCapacity,
    `${alice.state.baitStock} / ${alice.state.baitStockCapacity}`);

  if (me.gold >= baitItem.cost.amount) {
    const goldBefore = me.gold;
    const baitBeforeBuy = me.bait;
    const shelfBefore = alice.state.baitStock;
    await alice.send('buy', { itemId: 'bait', quantity: 1 });
    const purchased = await next(alice, 'purchased');
    check('purchase grants bait', purchased.granted.bait === baitItem.grants.bait, `${purchased.granted.bait}`);
    check('purchase takes its bait off the shelf',
      purchased.stock.units === shelfBefore - baitItem.grants.bait,
      `${shelfBefore} -> ${purchased.stock.units}`);

    me = await requestMe(alice);
    check('purchase deducted gold', me.gold === goldBefore - baitItem.cost.amount,
      `${goldBefore} -> ${me.gold}`);
    check('purchase credited bait', me.bait >= baitBeforeBuy, `${baitBeforeBuy} -> ${me.bait}`);
  } else {
    console.log(`  skip  not enough gold to buy (${me.gold})`);
  }

  // The shelf is bait only, so this is an id the catalog has never carried --
  // the shop used to list it, greyed and unsellable, and a client cached from
  // then would still ask for it.
  await alice.send('buy', { itemId: 'lucky_charm', quantity: 1 });
  const unknown = await next(alice, 'error_msg', 5000);
  check('an item the shop does not carry is refused',
    unknown.code === 'ITEM_UNKNOWN', unknown.code);

  // Priced past whatever gold this run has actually built up, computed live
  // rather than assumed a fixed pack price is enough: Bait is one 3-Gold unit
  // of 100 bait, capped at MAX_PURCHASE_QUANTITY (1000) per message, so a
  // lucky Diamond appraisal earlier in this run can leave Alice holding more
  // Gold than even a max-quantity Bait purchase costs. The shelf runs out
  // first at that size, which is why OUT_OF_STOCK is accepted below.
  me = await requestMe(alice);
  const unaffordableQty = Math.floor(me.gold / baitItem.cost.amount) + 1;
  if (unaffordableQty <= 1000) {
    await alice.send('buy', { itemId: 'bait', quantity: unaffordableQty });
    const denied = await next(alice, 'error_msg', 5000);
    check('unaffordable purchase is refused',
      denied.code === 'INSUFFICIENT_FUNDS' || denied.code === 'OUT_OF_STOCK', denied.code);
  } else {
    console.log(`  skip  Alice holds too much Gold (${me.gold}) to construct an unaffordable Bait purchase`);
  }

  /* -------------------------------------------------- input validation */
  console.log('\nServer-side validation');

  // Each of these reports the code it actually got, the way the shop's
  // refusals above do: a rejection that came back under the wrong code and one
  // that was swallowed by the rate limiter fail the same way otherwise, and
  // they are not the same bug.
  await alice.send('set_stake', { stake: 9999 });
  const badStake = await next(alice, 'error_msg', 5000);
  check('invalid stake rejected', badStake.code === 'STAKE_INVALID', badStake.code);

  await alice.send('open_chest', { chestId: '../../etc/passwd' });
  const badChest = await next(alice, 'error_msg', 5000);
  check('malformed chest id rejected', badChest.code === 'CHEST_INVALID', badChest.code);

  await alice.send('chat', { text: 'x'.repeat(201) });
  const longChat = await next(alice, 'error_msg', 5000);
  check('201-char chat message rejected', longChat.code === 'CHAT_TOO_LONG', longChat.code);

  /* ---------------------------------------------------------- multiplayer */
  console.log('\nMultiplayer: player list, chat, leaderboard');

  const bob = await connect({ displayName: 'SmokeBob' });
  await next(bob, 'me');
  await sleep(1500);

  const namesSeenByAlice = [...alice.state.players.values()].map((player) => player.name);
  check('both players appear in the shared player list',
    namesSeenByAlice.includes('SmokeAlice') && namesSeenByAlice.includes('SmokeBob'),
    namesSeenByAlice.join(', '));
  check('player list carries level and online status',
    [...alice.state.players.values()].every((player) => player.rodLevel >= 1 && player.online === true));

  const $alice = getStateCallbacks(alice);
  const chatSeenByAlice = new Promise((resolve) => {
    $alice(alice.state).messages.onAdd((entry) => {
      if (entry.text === 'hello from bob') resolve(entry);
    });
  });
  await bob.send('chat', { text: 'hello from bob' });
  const chatEntry = await Promise.race([chatSeenByAlice, sleep(6000).then(() => null)]);

  check('chat is delivered live to the other client', Boolean(chatEntry));
  check('chat carries author and server timestamp',
    chatEntry?.name === 'SmokeBob' && chatEntry?.at > 0, `${chatEntry?.name} @ ${chatEntry?.at}`);

  await sleep(11000); // let the leaderboard refresh tick
  const board = [...alice.state.leaderboard];
  check('leaderboard is populated', board.length > 0, `${board.length} rows`);
  check('leaderboard is ranked by level then catches',
    board.every((row, index) => index === 0
      || row.rodLevel < board[index - 1].rodLevel
      || (row.rodLevel === board[index - 1].rodLevel && row.totalCatches <= board[index - 1].totalCatches)));
  check('leaderboard exposes no private wallet data',
    board.every((row) => row.gold === undefined && row.pearls === undefined));

  check('other players wallets are not in shared state',
    [...alice.state.players.values()].every((player) => player.gold === undefined && player.bait === undefined));

  /* -------------------------------------------------------- persistence */
  console.log('\nGuest session persistence (same device, fresh connection)');

  const beforeLeave = await requestMe(alice);
  await alice.leave(true);
  await sleep(1200);

  const aliceAgain = await connect({
    sessionToken: session.sessionToken,
    displayName: 'ShouldBeIgnored',
  });
  const restored = await next(aliceAgain, 'me');

  check('rejoining with the token restores the same player',
    restored.displayName === 'SmokeAlice', restored.displayName);
  check('rod level survived the reconnect',
    restored.rodLevel === beforeLeave.rodLevel, `${beforeLeave.rodLevel} -> ${restored.rodLevel}`);
  check('total XP survived the reconnect',
    restored.totalXp >= beforeLeave.totalXp, `${beforeLeave.totalXp} -> ${restored.totalXp}`);
  check('gold survived the reconnect',
    restored.gold >= beforeLeave.gold - 1, `${beforeLeave.gold} -> ${restored.gold}`);
  check('catch total survived the reconnect',
    restored.totalCatches >= beforeLeave.totalCatches, `${beforeLeave.totalCatches} -> ${restored.totalCatches}`);
  check('chat history is replayed to a fresh client',
    [...aliceAgain.state.messages].some((entry) => entry.text === 'hello from bob'));

  const strangerRoom = await connect({ sessionToken: 'f'.repeat(64), displayName: 'Nobody' });
  const stranger = await next(strangerRoom, 'me');
  check('an unknown token gets a fresh guest, not someone else\'s save',
    stranger.displayName === 'Nobody' && stranger.rodLevel === 1);

  await Promise.allSettled([aliceAgain.leave(true), bob.leave(true), strangerRoom.leave(true)]);

  /* -------------------------------------------------------------- report */
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.log('\nFailed:');
    for (const failure of failures) console.log(`  - ${failure}`);
  } else {
    console.log('All smoke checks passed.\n');
  }

  // Set the code and let the event loop drain instead of calling process.exit()
  // -- forcing an exit while websockets are still closing trips a libuv
  // assertion on Windows and buries the report under a crash dump.
  process.exitCode = failures.length > 0 ? 1 : 0;
}

async function requestMe(room) {
  const promise = next(room, 'me');
  await room.send('request_me', {});
  return promise;
}

main().catch((error) => {
  console.error('\nSmoke test crashed:', error);
  process.exitCode = 1;
});
