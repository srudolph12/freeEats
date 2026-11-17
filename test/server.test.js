'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../src/server');

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]);
const JPEG = 'data:image/jpeg;base64,' + JPEG_BYTES.toString('base64');

async function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crumbs-srv-'));
  const outbox = [];
  const lookups = [];
  const geocode = async (q, near) => {
    lookups.push({ q, near });
    if (/nowhere/i.test(q)) return null;
    if (/broken/i.test(q)) throw new Error('service down');
    return { lat: 34.02, lng: -118.285, label: q + ', Los Angeles, CA' };
  };
  const server = createServer({ dataDir: dir, geocode, sendMail: async (m) => { outbox.push(m); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const sessions = {};

  const raw = (method, url, body, cookie, extra) =>
    fetch(base + url, {
      method,
      headers: Object.assign(
        cookie ? { Cookie: cookie } : {},
        body !== undefined ? { 'Content-Type': 'application/json' } : {},
        extra || {}),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  const lastCode = (email) => {
    const m = outbox.filter((x) => x.to === email).pop();
    return m && /\b(\d{6})\b/.exec(m.text)[1];
  };

  async function signIn(email) {
    let res = await raw('POST', '/api/auth/request-code', { email });
    assert.equal(res.status, 200, 'request code for ' + email);
    res = await raw('POST', '/api/auth/verify', { email, code: lastCode(email) });
    assert.equal(res.status, 200, 'verify ' + email);
    return res.headers.get('set-cookie').split(';')[0];
  }

  // call(method, url, body, who): who is a name like 'alice', signed in as alice@school.edu on first use.
  const call = async (method, url, body, who) => {
    const email = (who || 'alice') + '@school.edu';
    if (!sessions[email]) sessions[email] = await signIn(email);
    return raw(method, url, body, sessions[email]);
  };
  return { server, base, call, raw, outbox, lastCode, signIn, lookups };
}

test('full flow: post with photo, browse, check in, cancel, close', async (t) => {
  const { server, base, call } = await start();
  t.after(() => server.close());

  let res = await call('POST', '/api/posts', { title: 'Bagels', servings: 1, building: 'Library', photo: JPEG });
  assert.equal(res.status, 201);
  const { post } = await res.json();

  const photo = await fetch(base + post.photoUrl);
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await photo.arrayBuffer()), JPEG_BYTES);

  res = await call('GET', '/api/posts', undefined, 'bob');
  const list = await res.json();
  assert.equal(list.posts.length, 1);
  assert.equal(typeof list.serverTime, 'number');

  res = await call('POST', '/api/posts/' + post.id + '/claim', undefined, 'bob');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).post.servingsLeft, 0);

  res = await call('POST', '/api/posts/' + post.id + '/claim', undefined, 'cara');
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /every serving/);

  res = await call('DELETE', '/api/posts/' + post.id + '/claim', undefined, 'bob');
  assert.equal((await res.json()).post.servingsLeft, 1);

  res = await call('POST', '/api/posts/' + post.id + '/close', undefined, 'bob');
  assert.equal(res.status, 403);
  res = await call('POST', '/api/posts/' + post.id + '/close');
  assert.equal(res.status, 200);
});

test('rejects bad input with clear errors', async (t) => {
  const { server, base, call, signIn } = await start();
  t.after(() => server.close());

  let res = await call('POST', '/api/posts', { title: 'Cake', servings: 3 });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Building is required/);

  res = await fetch(base + '/api/posts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 401, 'not signed in');

  const cookie = await signIn('alice@school.edu');
  res = await fetch(base + '/api/posts', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{nope',
  });
  assert.equal(res.status, 400);

  res = await fetch(base + '/api/posts', { method: 'POST', headers: { 'Content-Type': 'text/plain', Cookie: cookie }, body: 'hi' });
  assert.equal(res.status, 415);

  res = await call('POST', '/api/posts/00000000-0000-0000-0000-000000000000/claim');
  assert.equal(res.status, 404);

  res = await call('PUT', '/api/posts');
  assert.equal(res.status, 405);
});

test('serves the app with security headers and blocks path tricks', async (t) => {
  const { server, base } = await start();
  t.after(() => server.close());

  const index = await fetch(base + '/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  assert.match(index.headers.get('content-security-policy'), /default-src 'self'/);

  for (const [p, type] of [['/app.js', /javascript/], ['/style.css', /css/]]) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-type'), type);
  }
  for (const p of ['/uploads/../posts.json', '/uploads/posts.json', '/%2e%2e/src/server.js', '/..%2fpackage.json']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 404, p);
  }
});

test('sign-in: only .edu addresses, and only with the emailed code', async (t) => {
  const { server, raw, outbox, lastCode } = await start();
  t.after(() => server.close());

  for (const email of ['me@gmail.com', 'me@school.edu.evil.com', 'me@edu', 'not an email', 'a\r\nb@school.edu', '']) {
    const res = await raw('POST', '/api/auth/request-code', { email });
    assert.equal(res.status, 400, JSON.stringify(email));
  }
  assert.equal(outbox.length, 0, 'no emails sent to bad addresses');

  let res = await raw('POST', '/api/auth/request-code', { email: '  Dana@CS.School.EDU ' });
  assert.equal(res.status, 200);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].to, 'dana@cs.school.edu', 'normalised');
  const code = lastCode('dana@cs.school.edu');

  res = await raw('POST', '/api/auth/request-code', { email: 'dana@cs.school.edu' });
  assert.equal(res.status, 429, 'resend cooldown');

  const wrong = code === '000000' ? '111111' : '000000';
  res = await raw('POST', '/api/auth/verify', { email: 'dana@cs.school.edu', code: wrong });
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('set-cookie'), null);

  res = await raw('POST', '/api/auth/verify', { email: 'dana@cs.school.edu', code });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).user.email, 'dana@cs.school.edu');
  const setCookie = res.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  const cookie = setCookie.split(';')[0];

  res = await raw('POST', '/api/auth/verify', { email: 'dana@cs.school.edu', code });
  assert.equal(res.status, 400, 'a code works only once');

  res = await raw('GET', '/api/auth/me', undefined, cookie);
  assert.equal((await res.json()).user.email, 'dana@cs.school.edu');
  res = await raw('GET', '/api/posts', undefined, cookie);
  assert.equal(res.status, 200);

  res = await raw('POST', '/api/auth/logout', undefined, cookie);
  assert.equal(res.status, 200);
  res = await raw('GET', '/api/posts', undefined, cookie);
  assert.equal(res.status, 401, 'session ended');
  res = await raw('GET', '/api/auth/me', undefined, cookie);
  assert.equal(res.status, 401);
});

test('sign-in: codes are locked after 5 wrong guesses', async (t) => {
  const { server, raw, lastCode } = await start();
  t.after(() => server.close());
  const email = 'eve@school.edu';
  await raw('POST', '/api/auth/request-code', { email });
  const code = lastCode(email);
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) await raw('POST', '/api/auth/verify', { email, code: wrong });
  const res = await raw('POST', '/api/auth/verify', { email, code });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /expired|new code/);
});

test('sign-in: sessions survive a restart', async (t) => {
  const { server, call, signIn } = await start();
  t.after(() => server.close());
  const cookie = await signIn('finn@school.edu');
  await call('GET', '/api/posts'); // make sure the server is warm
  const again = createServer({ dataDir: server.store.dataDir, sendMail: async () => {} });
  await again.ready;
  assert.equal(again.auth.session(cookie.split('=')[1]).email, 'finn@school.edu');
});

test('posts are tied to the signed-in student, and other sites cannot make changes', async (t) => {
  const { server, call, raw, signIn } = await start();
  t.after(() => server.close());

  let res = await call('POST', '/api/posts', { title: 'Donuts', servings: 3, building: 'Gym' }, 'gail');
  const { post } = await res.json();
  assert.equal(post.mine, true);

  // Same student on a second device sees it as theirs.
  const otherDevice = await signIn('gail@school.edu');
  res = await raw('GET', '/api/posts', undefined, otherDevice);
  assert.equal((await res.json()).posts[0].mine, true);

  res = await raw('POST', '/api/posts/' + post.id + '/close', undefined, otherDevice, { Origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  res = await raw('POST', '/api/posts/' + post.id + '/close', undefined, otherDevice, { Origin: 'http://127.0.0.1:' + server.address().port });
  assert.equal(res.status, 200);
});

test('account: history, saved preferences, and sign out everywhere', async (t) => {
  const { server, call, raw, signIn } = await start();
  t.after(() => server.close());

  let res = await call('POST', '/api/posts', { title: 'Wraps', servings: 4, building: 'Union' }, 'hana');
  const { post } = await res.json();
  await call('POST', '/api/posts/' + post.id + '/claim', undefined, 'ivan');

  res = await call('GET', '/api/account', undefined, 'ivan');
  let acct = await res.json();
  assert.equal(acct.user.email, 'ivan@school.edu');
  assert.equal(typeof acct.user.memberSince, 'number');
  assert.deepEqual(acct.user.diet, []);
  assert.equal(acct.checkins.length, 1);
  assert.equal(acct.checkins[0].title, 'Wraps');
  assert.equal(acct.stats.checkins, 1);

  res = await call('GET', '/api/account', undefined, 'hana');
  acct = await res.json();
  assert.equal(acct.posts.length, 1);
  assert.equal(acct.stats.studentsFed, 1);

  res = await call('PUT', '/api/account/preferences', { diet: ['vegan', 'nope'] }, 'ivan');
  assert.equal(res.status, 400);
  res = await call('PUT', '/api/account/preferences', { diet: ['vegan', 'halal', 'vegan'] }, 'ivan');
  assert.deepEqual((await res.json()).user.diet, ['vegan', 'halal']);
  const phone = await signIn('ivan@school.edu');
  res = await raw('GET', '/api/auth/me', undefined, phone);
  assert.deepEqual((await res.json()).user.diet, ['vegan', 'halal'], 'saved on the account, so every device gets it');

  assert.equal((await raw('GET', '/api/account')).status, 401);

  res = await raw('POST', '/api/auth/logout-all', undefined, phone);
  assert.equal((await res.json()).devices, 2);
  assert.equal((await raw('GET', '/api/account', undefined, phone)).status, 401);
  assert.equal((await call('GET', '/api/account', undefined, 'ivan')).status, 401, 'other device signed out too');
  assert.equal((await call('GET', '/api/account', undefined, 'hana')).status, 200, 'other students unaffected');
});

test('food can be listed for at most 2 hours', async (t) => {
  const { server, call } = await start();
  t.after(() => server.close());

  let res = await call('POST', '/api/posts', { title: 'Cake', servings: 4, building: 'Hall', hours: 3 });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /2 hours/);

  for (const hours of [0.5, 1, 1.5, 2]) {
    res = await call('POST', '/api/posts', { title: 'Cake', servings: 4, building: 'Hall', hours });
    assert.equal(res.status, 201, 'hours ' + hours);
    const { post } = await res.json();
    assert.equal(post.expiresAt - post.createdAt, hours * 3600000);
  }

  res = await call('GET', '/api/config');
  assert.deepEqual((await res.json()).durations, [0.5, 1, 1.5, 2]);
});

test('address lookup and posts pinned by address', async (t) => {
  const { server, call, raw, lookups } = await start();
  t.after(() => server.close());

  let res = await raw('GET', '/api/geocode?q=3607+Trousdale+Pkwy');
  assert.equal(res.status, 401, 'needs sign-in');

  res = await call('GET', '/api/geocode?q=3607%20Trousdale%20Pkwy&lat=34.0&lng=-118.3');
  assert.equal(res.status, 200);
  const { result } = await res.json();
  assert.deepEqual(result, { lat: 34.02, lng: -118.285, label: '3607 Trousdale Pkwy, Los Angeles, CA' });
  assert.deepEqual(lookups.pop(), { q: '3607 Trousdale Pkwy', near: { lat: 34, lng: -118.3 } });

  res = await call('GET', '/api/geocode?q=nowhere%20at%20all');
  assert.equal(res.status, 404);
  res = await call('GET', '/api/geocode?q=broken');
  assert.equal(res.status, 502);
  res = await call('GET', '/api/geocode?q=ab');
  assert.equal(res.status, 400);

  res = await call('POST', '/api/posts', {
    title: 'Tacos', servings: 8, building: 'Taco Hall', address: '  3607   Trousdale Pkwy ', lat: result.lat, lng: result.lng,
  });
  assert.equal(res.status, 201);
  const { post } = await res.json();
  assert.equal(post.address, '3607 Trousdale Pkwy');
  assert.equal(post.lat, 34.02);

  res = await call('GET', '/api/posts', undefined, 'bob');
  const seen = (await res.json()).posts[0];
  assert.equal(seen.address, '3607 Trousdale Pkwy');
  assert.equal(seen.lng, -118.285);

  res = await call('POST', '/api/posts', { title: 'Tacos', servings: 8, building: 'Hall', address: 'x'.repeat(161) });
  assert.equal(res.status, 400);
});

test('address lookups are rate limited per student', async (t) => {
  const { server, call } = await start();
  t.after(() => server.close());
  for (let i = 0; i < 15; i++) {
    const res = await call('GET', '/api/geocode?q=street%20' + i);
    assert.equal(res.status, 200);
  }
  assert.equal((await call('GET', '/api/geocode?q=street%2099')).status, 429);
  assert.equal((await call('GET', '/api/geocode?q=street%2099', undefined, 'bob')).status, 200);
});

test('posters can edit their live posts', async (t) => {
  const { server, base, call } = await start();
  t.after(() => server.close());

  let res = await call('POST', '/api/posts', { title: 'Bagels', servings: 3, building: 'Library', hours: 1, photo: JPEG, tags: ['vegan'] });
  const { post } = await res.json();
  assert.equal((await call('POST', '/api/posts/' + post.id + '/claim', undefined, 'bob')).status, 200);
  assert.equal((await call('POST', '/api/posts/' + post.id + '/claim', undefined, 'carol')).status, 200);

  const edit = { title: 'Bagels & cream cheese', servings: 6, building: 'Main Library', details: '2nd floor', description: 'Plain and everything',
    address: '123 College Ave', lat: 34.1, lng: -118.2, tags: ['vegetarian'] };

  res = await call('PATCH', '/api/posts/' + post.id, edit, 'bob');
  assert.equal(res.status, 403, 'only the poster can edit');

  res = await call('PATCH', '/api/posts/' + post.id, Object.assign({}, edit, { servings: 1 }));
  assert.equal(res.status, 400, 'servings can not drop below check-ins');
  assert.match((await res.json()).error, /below 2/);

  res = await call('PATCH', '/api/posts/' + post.id, edit);
  assert.equal(res.status, 200);
  let p = (await res.json()).post;
  assert.equal(p.title, 'Bagels & cream cheese');
  assert.equal(p.servings, 6);
  assert.equal(p.servingsLeft, 4, 'check-ins kept');
  assert.equal(p.address, '123 College Ave');
  assert.deepEqual(p.tags, ['vegetarian']);
  assert.equal(p.expiresAt, post.expiresAt, 'no hours means keep the end time');
  assert.equal(p.photoUrl, post.photoUrl, 'photo kept');
  assert.equal(typeof p.editedAt, 'number');

  res = await call('PATCH', '/api/posts/' + post.id, Object.assign({}, edit, { hours: 2 }));
  p = (await res.json()).post;
  assert.equal(p.expiresAt, post.createdAt + 2 * 3600000, 'hours count from posting');
  res = await call('PATCH', '/api/posts/' + post.id, Object.assign({}, edit, { hours: 3 }));
  assert.equal(res.status, 400, 'still capped at 2 hours');

  res = await call('PATCH', '/api/posts/' + post.id, Object.assign({}, edit, { photo: JPEG }));
  p = (await res.json()).post;
  assert.notEqual(p.photoUrl, post.photoUrl, 'new photo, new url');
  assert.equal((await fetch(base + post.photoUrl)).status, 404, 'old photo deleted');
  assert.equal((await fetch(base + p.photoUrl)).status, 200);

  res = await call('PATCH', '/api/posts/' + post.id, Object.assign({}, edit, { removePhoto: true }));
  const removed = (await res.json()).post;
  assert.equal(removed.photoUrl, null);
  assert.equal((await fetch(base + p.photoUrl)).status, 404);

  res = await call('GET', '/api/posts', undefined, 'bob');
  assert.equal((await res.json()).posts[0].title, 'Bagels & cream cheese', 'others see the edit');

  await call('POST', '/api/posts/' + post.id + '/close');
  res = await call('PATCH', '/api/posts/' + post.id, edit);
  assert.equal(res.status, 410, 'ended posts can not be edited');
});

test('posters can delete posts, live or past', async (t) => {
  const { server, base, call } = await start();
  t.after(() => server.close());

  let res = await call('POST', '/api/posts', { title: 'Pizza', servings: 3, building: 'Union', photo: JPEG });
  const live = (await res.json()).post;
  res = await call('POST', '/api/posts', { title: 'Cookies', servings: 3, building: 'Hall' });
  const past = (await res.json()).post;
  await call('POST', '/api/posts/' + past.id + '/claim', undefined, 'bob');
  await call('POST', '/api/posts/' + past.id + '/close');

  assert.equal((await call('DELETE', '/api/posts/' + live.id, undefined, 'bob')).status, 403);

  assert.equal((await call('DELETE', '/api/posts/' + live.id)).status, 200);
  assert.equal((await fetch(base + live.photoUrl)).status, 404, 'photo deleted');
  assert.equal((await (await call('GET', '/api/posts', undefined, 'bob')).json()).posts.length, 0);

  assert.equal((await call('DELETE', '/api/posts/' + past.id)).status, 200);
  const mine = await (await call('GET', '/api/account')).json();
  assert.equal(mine.posts.length, 0, 'gone from the poster history');
  assert.equal(mine.stats.posts, 0);
  const bobs = await (await call('GET', '/api/account', undefined, 'bob')).json();
  assert.equal(bobs.checkins.length, 0, 'gone from the claimer history');

  assert.equal((await call('DELETE', '/api/posts/' + past.id)).status, 404);
});

test('passwords: set after a code, then sign in without one', async (t) => {
  const { server, raw, signIn, outbox } = await start();
  t.after(() => server.close());
  const email = 'pat@school.edu';
  const cookie = await signIn(email);

  let res = await raw('GET', '/api/auth/me', undefined, cookie);
  assert.equal((await res.json()).user.hasPassword, false);

  res = await raw('POST', '/api/auth/password', { password: 'short' }, cookie);
  assert.equal(res.status, 400);
  res = await raw('POST', '/api/auth/password', { password: 'password' }, cookie);
  assert.equal(res.status, 400);
  res = await raw('POST', '/api/auth/password', { password: 'pat@school.edu' }, cookie);
  assert.equal(res.status, 400);
  res = await raw('POST', '/api/auth/password', { password: 'pizza party 42' });
  assert.equal(res.status, 401, 'must be signed in');

  res = await raw('POST', '/api/auth/password', { password: 'pizza party 42' }, cookie);
  assert.equal(res.status, 200);
  const { user } = await res.json();
  assert.equal(user.hasPassword, true);
  assert.equal(user.passwordHash, undefined, 'hash never sent to the browser');

  const users = JSON.parse(fs.readFileSync(path.join(server.auth.usersFile), 'utf8'));
  assert.match(users[email].passwordHash, /^scrypt\$/);
  assert.ok(!JSON.stringify(users).includes('pizza party'), 'not stored in plain text');

  const mailsBefore = outbox.length;
  res = await raw('POST', '/api/auth/login', { email: 'PAT@School.edu', password: 'pizza party 42' });
  assert.equal(res.status, 200);
  const pwCookie = res.headers.get('set-cookie').split(';')[0];
  assert.equal(outbox.length, mailsBefore, 'no email sent');
  res = await raw('GET', '/api/posts', undefined, pwCookie);
  assert.equal(res.status, 200, 'password session works');

  res = await raw('POST', '/api/auth/login', { email, password: 'wrong password' });
  assert.equal(res.status, 401);
  const wrongMsg = (await res.json()).error;
  res = await raw('POST', '/api/auth/login', { email: 'nobody@school.edu', password: 'whatever123' });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, wrongMsg, 'same message whether or not the account exists');
  res = await raw('POST', '/api/auth/login', { email: 'pat@gmail.com', password: 'pizza party 42' });
  assert.equal(res.status, 400, 'still .edu only');
});

test('passwords: changing needs the old one unless you just used a code; other devices signed out', async (t) => {
  const { server, raw, signIn } = await start();
  t.after(() => server.close());
  const email = 'sam@school.edu';
  const codeCookie = await signIn(email);
  assert.equal((await raw('POST', '/api/auth/password', { password: 'first secret 1' }, codeCookie)).status, 200);

  let res = await raw('POST', '/api/auth/login', { email, password: 'first secret 1' });
  const pwCookie = res.headers.get('set-cookie').split(';')[0];

  res = await raw('POST', '/api/auth/password', { password: 'second secret 2' }, pwCookie);
  assert.equal(res.status, 400, 'password session needs the current password');
  res = await raw('POST', '/api/auth/password', { password: 'second secret 2', currentPassword: 'nope nope nope' }, pwCookie);
  assert.equal(res.status, 400);
  res = await raw('POST', '/api/auth/password', { password: 'second secret 2', currentPassword: 'first secret 1' }, pwCookie);
  assert.equal(res.status, 200);

  assert.equal((await raw('GET', '/api/auth/me', undefined, codeCookie)).status, 401, 'other device signed out');
  assert.equal((await raw('GET', '/api/auth/me', undefined, pwCookie)).status, 200, 'this device stays signed in');
  assert.equal((await raw('POST', '/api/auth/login', { email, password: 'first secret 1' })).status, 401);
  assert.equal((await raw('POST', '/api/auth/login', { email, password: 'second secret 2' })).status, 200);

  // Forgot password: sign in with a code, then set a new one without the old.
  const fresh = await signIn(email);
  res = await raw('POST', '/api/auth/password', { password: 'third secret 3' }, fresh);
  assert.equal(res.status, 200);
  assert.equal((await raw('POST', '/api/auth/login', { email, password: 'third secret 3' })).status, 200);
});

test('passwords: wrong guesses lock the account briefly', async (t) => {
  let clock = Date.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crumbs-pw-'));
  const outbox = [];
  const server = createServer({ dataDir: dir, now: () => clock, sendMail: async (m) => { outbox.push(m); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (url, body, cookie) => fetch(base + url, {
    method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, cookie ? { Cookie: cookie } : {}), body: JSON.stringify(body),
  });

  const email = 'lee@school.edu';
  await post('/api/auth/request-code', { email });
  const code = /\b(\d{6})\b/.exec(outbox[0].text)[1];
  const cookie = (await post('/api/auth/verify', { email, code })).headers.get('set-cookie').split(';')[0];
  assert.equal((await post('/api/auth/password', { password: 'lunch time 99' }, cookie)).status, 200);

  for (let i = 0; i < 5; i++) assert.equal((await post('/api/auth/login', { email, password: 'bad guess ' + i })).status, 401);
  assert.equal((await post('/api/auth/login', { email, password: 'lunch time 99' })).status, 429, 'locked, even with the right one');
  clock += 16 * 60 * 1000;
  assert.equal((await post('/api/auth/login', { email, password: 'lunch time 99' })).status, 200, 'unlocked after 15 minutes');
});

test('friends: requests, accepting, and friends-only posts', async (t) => {
  const { server, call } = await start();
  t.after(() => server.close());
  const json = async (res, status) => { assert.equal(res.status, status || 200); return res.json(); };

  // alice asks bob; bob sees the request; adding her back accepts it.
  let data = await json(await call('POST', '/api/friends', { email: 'Bob@School.edu' }));
  assert.equal(data.result, 'requested');
  assert.deepEqual(data.outgoing.map((r) => r.email), ['bob@school.edu']);
  data = await json(await call('GET', '/api/friends', undefined, 'bob'));
  assert.deepEqual(data.incoming.map((r) => r.email), ['alice@school.edu']);
  data = await json(await call('POST', '/api/friends', { email: 'alice@school.edu' }, 'bob'));
  assert.equal(data.result, 'friends');
  assert.deepEqual(data.friends.map((r) => r.email), ['alice@school.edu']);
  assert.equal(data.incoming.length, 0);
  data = await json(await call('GET', '/api/friends'));
  assert.deepEqual(data.friends.map((r) => r.email), ['bob@school.edu']);
  assert.equal(data.outgoing.length, 0);

  await json(await call('POST', '/api/friends', { email: 'alice@school.edu' }), 400); // yourself
  await json(await call('POST', '/api/friends', { email: 'eve@gmail.com' }), 400); // not .edu

  // A friends-only post: bob (friend) sees it with alice's email; cara (not a friend) can't see or claim it.
  const { post } = await json(await call('POST', '/api/posts', { title: 'Cake', servings: 4, building: 'Dorm', visibility: 'friends' }), 201);
  assert.equal(post.visibility, 'friends');
  await json(await call('POST', '/api/posts', { title: 'Chips', servings: 4, building: 'Dorm' }), 201);
  await json(await call('POST', '/api/posts', { title: 'Bad', servings: 4, building: 'Dorm', visibility: 'secret' }), 400);

  const bobs = (await json(await call('GET', '/api/posts', undefined, 'bob'))).posts;
  assert.deepEqual(bobs.map((p) => p.title).sort(), ['Cake', 'Chips']);
  assert.ok(bobs.every((p) => p.friend === 'alice@school.edu'), 'friends see who posted');
  const caras = (await json(await call('GET', '/api/posts', undefined, 'cara'))).posts;
  assert.deepEqual(caras.map((p) => p.title), ['Chips']);
  assert.equal(caras[0].friend, null, 'strangers do not see who posted');
  await json(await call('POST', '/api/posts/' + post.id + '/claim', undefined, 'cara'), 404);

  // bob checks in, then they unfriend: bob keeps his serving and can still see it; new posts are hidden.
  await json(await call('POST', '/api/posts/' + post.id + '/claim', undefined, 'bob'));
  await json(await call('POST', '/api/friends/remove', { email: 'bob@school.edu' }));
  assert.equal((await json(await call('GET', '/api/friends', undefined, 'bob'))).friends.length, 0);
  const after = (await json(await call('GET', '/api/posts', undefined, 'bob'))).posts;
  assert.deepEqual(after.map((p) => p.title).sort(), ['Cake', 'Chips']);
  assert.ok(after.every((p) => p.friend === null));

  // Editing keeps the visibility unless it is changed.
  let res = await call('PATCH', '/api/posts/' + post.id, { title: 'Cake!', servings: 4, building: 'Dorm' });
  assert.equal((await json(res)).post.visibility, 'friends');
  res = await call('PATCH', '/api/posts/' + post.id, { title: 'Cake!', servings: 4, building: 'Dorm', visibility: 'everyone' });
  assert.equal((await json(res)).post.visibility, 'everyone');
  assert.equal((await json(await call('GET', '/api/posts', undefined, 'cara'))).posts.length, 2);

  // Declining a request and cancelling your own.
  await json(await call('POST', '/api/friends', { email: 'dan@school.edu' }, 'cara'));
  await json(await call('POST', '/api/friends/remove', { email: 'cara@school.edu' }, 'dan'));
  assert.equal((await json(await call('GET', '/api/friends', undefined, 'cara'))).outgoing.length, 0);
});

test('posters see who checked in, in the app and the email; nobody else does', async (t) => {
  const { server, call, outbox } = await start();
  t.after(() => server.close());
  let res = await call('POST', '/api/posts', { title: 'Tamales', servings: 5, building: 'Hall' });
  const { post } = await res.json();
  assert.equal((await call('POST', '/api/posts/' + post.id + '/claim', undefined, 'bob')).status, 200);

  const mine = (await (await call('GET', '/api/posts')).json()).posts[0];
  assert.deepEqual(mine.checkedIn.map((c) => c.email), ['bob@school.edu']);
  assert.equal(typeof mine.checkedIn[0].at, 'number');
  const theirs = (await (await call('GET', '/api/posts', undefined, 'cara')).json()).posts[0];
  assert.equal(theirs.checkedIn, undefined, 'other students do not see who checked in');
  const acct = await (await call('GET', '/api/account')).json();
  assert.deepEqual(acct.posts[0].checkedIn.map((c) => c.email), ['bob@school.edu']);

  await new Promise((r) => setTimeout(r, 30)); // the first check-in email goes out right away
  const mail = outbox.filter((m) => m.to === 'alice@school.edu' && /checked in/.test(m.subject)).pop();
  assert.ok(mail, 'poster got an email');
  assert.equal(mail.subject, 'bob@school.edu checked in for your Tamales');
  assert.match(mail.text, /bob@school\.edu just checked in/);
});

test('a student can hold at most 2 check-ins at a time', async (t) => {
  const { server, call } = await start();
  t.after(() => server.close());
  const ids = [];
  for (const title of ['A', 'B', 'C']) {
    ids.push((await (await call('POST', '/api/posts', { title, servings: 3, building: 'Hall' })).json()).post.id);
  }
  assert.equal((await call('POST', '/api/posts/' + ids[0] + '/claim', undefined, 'bob')).status, 200);
  assert.equal((await call('POST', '/api/posts/' + ids[1] + '/claim', undefined, 'bob')).status, 200);
  let res = await call('POST', '/api/posts/' + ids[2] + '/claim', undefined, 'bob');
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /2 check-ins at a time/);
  // Ended food no longer counts.
  assert.equal((await call('POST', '/api/posts/' + ids[0] + '/close')).status, 200);
  assert.equal((await call('POST', '/api/posts/' + ids[2] + '/claim', undefined, 'bob')).status, 200);
  // Cancelling frees a spot too.
  assert.equal((await call('DELETE', '/api/posts/' + ids[1] + '/claim', undefined, 'bob')).status, 200);
  const cfg = await (await call('GET', '/api/config')).json();
  assert.equal(cfg.maxCheckins, 2);
});
