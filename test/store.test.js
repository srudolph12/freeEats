'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');

const HOUR = 3600 * 1000;
const ALICE = 'alice-client-0001';
const BOB = 'bob-client-00002';
const CARA = 'cara-client-0003';
// Smallest buffers that pass the image signature checks.
const JPEG = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]).toString('base64');

async function makeStore(startAt) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crumbs-'));
  const clock = { t: startAt || Date.UTC(2026, 10, 14, 12) };
  const store = new Store({ dataDir: dir, now: () => clock.t });
  await store.load();
  return { store, clock, dir };
}

const pizza = (extra) => Object.assign({ title: 'Pizza', servings: 2, building: 'Student Union' }, extra);

test('create returns a public view and hides owner ids', async () => {
  const { store } = await makeStore();
  const p = await store.create(pizza({ details: ' Room  210 ', tags: ['vegan', 'vegetarian'], lat: 34.02, lng: -118.28 }), ALICE);
  assert.equal(p.title, 'Pizza');
  assert.equal(p.details, 'Room 210', 'whitespace is collapsed');
  assert.deepEqual(p.tags, ['vegetarian', 'vegan'], 'tags come back in a stable order');
  assert.equal(p.servingsLeft, 2);
  assert.equal(p.status, 'available');
  assert.equal(p.mine, true);
  assert.equal(p.ownerId, undefined);
  assert.equal(p.claims, undefined);
  const forBob = store.list(BOB)[0];
  assert.equal(forBob.mine, false);
});

test('create validates required fields and limits', async () => {
  const { store } = await makeStore();
  const bad = [
    [{ title: '' }, /required/],
    [{ building: '   ' }, /required/],
    [{ servings: 0 }, /Servings/],
    [{ servings: 2.5 }, /Servings/],
    [{ servings: 201 }, /Servings/],
    [{ hours: 5 }, /Available-for/],
    [{ hours: 3 }, /Available-for/],
    [{ tags: ['pizza'] }, /Dietary/],
    [{ lat: 34 }, /both latitude and longitude/],
    [{ lat: 95, lng: 0 }, /coordinates/],
    [{ title: 'x'.repeat(81) }, /80 characters/],
    [{ photo: 'data:image/gif;base64,R0lGOD' }, /JPEG, PNG, or WebP/],
    [{ photo: 'data:image/jpeg;base64,' + Buffer.from('not an image').toString('base64') }, /not a valid image/],
  ];
  for (const [extra, msg] of bad) {
    await assert.rejects(store.create(pizza(extra), ALICE), msg, JSON.stringify(extra));
  }
  await assert.rejects(store.create(pizza(), 'bad id!'), /client id/);
});

test('photos are saved to disk and linked from the post', async () => {
  const { store, dir } = await makeStore();
  const p = await store.create(pizza({ photo: JPEG }), ALICE);
  assert.match(p.photoUrl, /^\/uploads\/[0-9a-f-]{36}\.jpg$/);
  assert.ok(fs.existsSync(path.join(dir, 'uploads', p.photoUrl.split('/').pop())));
});

test('check-in takes one serving, once per student, and never goes below zero', async () => {
  const { store } = await makeStore();
  const p = await store.create(pizza({ servings: 2 }), ALICE);
  const afterBob = await store.claim(p.id, BOB);
  assert.equal(afterBob.servingsLeft, 1);
  assert.equal(afterBob.claimedByMe, true);
  await assert.rejects(store.claim(p.id, BOB), /already checked in/);
  await assert.rejects(store.claim(p.id, ALICE), /You posted this one/);
  await store.claim(p.id, CARA);
  await assert.rejects(store.claim(p.id, 'dave-client-0004'), /every serving has been claimed/);
});

test('simultaneous check-ins for the last serving: exactly one wins', async () => {
  const { store } = await makeStore();
  const p = await store.create(pizza({ servings: 1 }), ALICE);
  const results = await Promise.allSettled([store.claim(p.id, BOB), store.claim(p.id, CARA)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
});

test('cancelling a check-in gives the serving back', async () => {
  const { store } = await makeStore();
  const p = await store.create(pizza({ servings: 1 }), ALICE);
  await store.claim(p.id, BOB);
  const back = await store.unclaim(p.id, BOB);
  assert.equal(back.servingsLeft, 1);
  assert.equal(back.claimedByMe, false);
  await assert.rejects(store.unclaim(p.id, BOB), /not checked in/);
});

test('fully claimed posts are hidden, except from the poster and claimers', async () => {
  const { store } = await makeStore();
  const p = await store.create(pizza({ servings: 1 }), ALICE);
  await store.claim(p.id, BOB);
  assert.equal(store.list(CARA).length, 0);
  assert.equal(store.list(undefined).length, 0);
  assert.equal(store.list(ALICE)[0].status, 'gone');
  assert.equal(store.list(BOB)[0].claimedByMe, true);
});

test('only the poster can mark food as gone', async () => {
  const { store } = await makeStore();
  const p = await store.create(pizza(), ALICE);
  await assert.rejects(store.close(p.id, BOB), /Only the person who posted/);
  const closed = await store.close(p.id, ALICE);
  assert.equal(closed.status, 'ended');
  assert.equal(store.list(ALICE).length, 0);
  await assert.rejects(store.claim(p.id, BOB), /no longer available/);
});

test('posts expire; photos go after a day, the record stays for history, then is deleted', async () => {
  const { store, clock, dir } = await makeStore();
  const p = await store.create(pizza({ hours: 1, photo: JPEG }), ALICE);
  clock.t += 59 * 60 * 1000;
  assert.equal(store.list(BOB).length, 1);
  clock.t += 2 * 60 * 1000;
  assert.equal(store.list(BOB).length, 0, 'expired');
  await assert.rejects(store.claim(p.id, BOB), /no longer available/);

  clock.t += 25 * HOUR;
  await store.create(pizza(), ALICE); // any write prunes
  assert.equal(fs.readdirSync(path.join(dir, 'uploads')).length, 0, 'old photo deleted');
  const kept = store.history(ALICE).posts.find((x) => x.id === p.id);
  assert.ok(kept, 'still in history');
  assert.equal(kept.photoUrl, null);
  assert.equal(kept.status, 'ended');

  clock.t += 181 * 24 * HOUR;
  await store.create(pizza(), ALICE);
  assert.equal(store.history(ALICE).posts.some((x) => x.id === p.id), false, 'gone after 180 days');
});

test('history lists check-ins and own posts, live and past, with totals', async () => {
  const { store, clock } = await makeStore();
  const a = await store.create(pizza({ title: 'Tacos', servings: 5, hours: 1 }), ALICE);
  const b = await store.create(pizza({ title: 'Sushi', servings: 3 }), ALICE);
  clock.t += 1000;
  await store.claim(a.id, BOB);
  clock.t += 1000;
  await store.claim(b.id, BOB);
  await store.claim(b.id, CARA);
  await store.unclaim(b.id, CARA); // cancelled check-ins do not count

  clock.t += 90 * 60 * 1000; // Tacos (1 hr) has ended, Sushi (2 hr) is still live
  const bob = store.history(BOB);
  assert.deepEqual(bob.checkins.map((x) => x.title), ['Sushi', 'Tacos'], 'newest check-in first');
  assert.deepEqual(bob.checkins.map((x) => x.status), ['available', 'ended']);
  assert.ok(bob.checkins[0].checkedInAt > bob.checkins[1].checkedInAt);
  assert.equal(bob.posts.length, 0);
  assert.equal(bob.stats.checkins, 2);

  const alice = store.history(ALICE);
  assert.equal(alice.posts.length, 2);
  assert.equal(alice.posts.every((x) => x.mine), true);
  assert.deepEqual(alice.stats, { checkins: 0, posts: 2, servingsShared: 8, studentsFed: 2 });
  assert.equal(store.history(CARA).checkins.length, 0);
  assert.equal(alice.posts[0].ownerId, undefined, 'no ids leak');
});

test('data survives a restart, and a corrupt file is set aside', async () => {
  const { store, dir, clock } = await makeStore();
  await store.create(pizza(), ALICE);
  const again = new Store({ dataDir: dir, now: () => clock.t });
  await again.load();
  assert.equal(again.list(BOB).length, 1);

  fs.writeFileSync(path.join(dir, 'posts.json'), '{oops');
  const fresh = new Store({ dataDir: dir, now: () => clock.t });
  await fresh.load();
  assert.equal(fresh.posts.length, 0);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('posts.json.corrupt-')));
});
