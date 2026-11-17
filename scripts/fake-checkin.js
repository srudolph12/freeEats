'use strict';

/**
 * FreeEats - have a fake student check in to your post, to test check-in pop-ups.
 *
 *   npm run fake-checkin -- --setup you@usc.edu     once, with the server STOPPED: creates the sign-ins it needs
 *   npm run fake-checkin -- you@usc.edu             with the server running: one fake check-in on your newest live post
 *   npm run fake-checkin -- you@usc.edu --count 3   three fake students check in
 *   npm run fake-checkin -- you@usc.edu --title pizza   pick your live post whose title contains "pizza"
 *
 * Works for posts shared with everyone and for friends-only posts. For a friends-only post, each
 * fake student becomes your friend, checks in, then unfriends you again, so your friend list ends
 * up as it was (a check-in is kept after an unfriend). That needs a sign-in for your account too,
 * which is why --setup takes your email.
 *
 * Why two steps: the server keeps sign-ins in memory and only reads data/sessions.json when it
 * starts, so the sign-ins have to be added while it is stopped. After that, everything goes
 * through the running server like a real student's, so your open browser sees it.
 *
 * The fake students are tester1..tester10@demo.edu. Nobody is emailed. The sign-in tokens are kept
 * in data/fake-checkin-tokens.json (git-ignored; anyone with that file can act as these accounts,
 * and "Sign out on all devices" on your Account page cancels the one for your account). Each fake
 * student can check in to a post once.
 */

const http = require('node:http');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Auth } = require('../src/auth');

const FAKES = 10;
const port = Number(process.env.PORT) || 3000;
const dataDir = process.env.DATA_DIR || path.resolve(__dirname, '..', 'data');
const tokensFile = path.join(dataDir, 'fake-checkin-tokens.json');

// Same as hashClient() in src/store.js: how posts store owner and claimer ids.
const hashClient = (id) => crypto.createHash('sha256').update('crumbs:' + id).digest('hex').slice(0, 32);
const fakeEmail = (i) => 'tester' + i + '@demo.edu';

function request(method, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const headers = { Origin: 'http://127.0.0.1:' + port };
    if (token) headers.Cookie = 'crumbs_session=' + token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers, timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        let data = {};
        try { data = JSON.parse(body); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const serverRunning = () => request('GET', '/api/health').then((r) => r.status === 200, () => false);

// { testers: { email: token }, owners: { email: token } }. Older files held only the testers.
async function readTokens() {
  try {
    const saved = JSON.parse(await fsp.readFile(tokensFile, 'utf8'));
    return saved.testers ? { testers: saved.testers, owners: saved.owners || {} } : { testers: saved, owners: {} };
  } catch (e) {
    return null;
  }
}

async function setup(ownerEmail) {
  if (await serverRunning()) {
    console.error('FreeEats is running on port ' + port + '. Stop it (Ctrl+C), run --setup, then start it again.');
    process.exit(1);
  }
  if (ownerEmail && !/^[^\s@]+@([a-z0-9-]+\.)+edu$/.test(ownerEmail)) {
    console.error('Give your school email, e.g. npm run fake-checkin -- --setup you@usc.edu');
    process.exit(1);
  }
  const auth = new Auth({ dataDir, sendMail: async () => {} });
  await auth.load();
  const saved = (await readTokens()) || { testers: {}, owners: {} };
  // Reuse sign-ins that still work; make new ones for the rest.
  const fresh = async (email, old) =>
    old && auth.session(old) ? old : (await auth.exclusive(() => auth.startSessionLocked(email, 'code'))).token;
  const tokens = { testers: {}, owners: saved.owners };
  for (let i = 1; i <= FAKES; i++) tokens.testers[fakeEmail(i)] = await fresh(fakeEmail(i), saved.testers[fakeEmail(i)]);
  if (ownerEmail) tokens.owners[ownerEmail] = await fresh(ownerEmail, saved.owners[ownerEmail]);
  await fsp.writeFile(tokensFile, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  console.log('Ready: ' + FAKES + ' fake students (tester1..tester' + FAKES + '@demo.edu)' +
    (ownerEmail ? ', plus a sign-in for ' + ownerEmail + ' so they can check in to your friends-only posts too.' : '.'));
  if (!ownerEmail) console.log('Add your email (--setup you@school.edu) to also test friends-only posts.');
  console.log('Now start the server (npm run dev or npm run dev:mail), post some food, and run:');
  console.log('  npm run fake-checkin -- ' + (ownerEmail || 'you@yourschool.edu'));
}

// Make a fake student your friend through the running server. Returns true if we made the friendship
// (so we should undo it), false if you were already friends.
async function befriend(ownerToken, ownerEmail, fake, fakeToken) {
  const list = await request('GET', '/api/friends', ownerToken);
  if (list.status === 401) throw new Error('The sign-in for ' + ownerEmail + ' has expired or was signed out. Stop the server and run --setup ' + ownerEmail + ' again.');
  if (list.data.friends && list.data.friends.some((r) => r.email === fake)) return false;
  let r = await request('POST', '/api/friends', ownerToken, { email: fake }); // your request (or accepting theirs)
  if (r.status !== 200) throw new Error('Could not add ' + fake + ': ' + (r.data.error || 'HTTP ' + r.status));
  if (r.data.result !== 'friends') {
    r = await request('POST', '/api/friends', fakeToken, { email: ownerEmail }); // they accept
    if (r.status !== 200 || r.data.result !== 'friends') throw new Error(fake + ' could not accept: ' + (r.data.error || 'HTTP ' + r.status));
  }
  return true;
}

async function checkIn(email, title, count) {
  const tokens = await readTokens();
  if (!tokens) {
    console.error('No fake sign-ins yet. Stop the server and run: npm run fake-checkin -- --setup ' + email);
    process.exit(1);
  }
  if (!(await serverRunning())) {
    console.error('FreeEats is not running on port ' + port + '. Start it first (npm run dev).');
    process.exit(1);
  }

  // The posts file is saved on every change, so it shows who owns what (only hashed ids are in it).
  const posts = JSON.parse(await fsp.readFile(path.join(dataDir, 'posts.json'), 'utf8'));
  const me = hashClient(Auth.userId(email));
  const t = Date.now();
  const live = posts
    .filter((p) => p.ownerId === me && !p.closedAt && p.expiresAt > t)
    .filter((p) => !title || p.title.toLowerCase().includes(title.toLowerCase()))
    .sort((a, b) => b.createdAt - a.createdAt);
  if (!live.length) {
    console.error('No live post by ' + email + (title ? ' with "' + title + '" in the title' : '') + '. Post some food first.');
    process.exit(1);
  }
  const post = live[0];
  const friendsOnly = post.visibility === 'friends';
  const ownerToken = tokens.owners[email];
  if (friendsOnly && !ownerToken) {
    console.error('"' + post.title + '" is friends only, so the fake students have to become your friends first,');
    console.error('which needs a sign-in for your account. Stop the server, run this once, then start it again:');
    console.error('  npm run fake-checkin -- --setup ' + email);
    process.exit(1);
  }
  console.log('Post: "' + post.title + '"' + (friendsOnly ? ' (friends only)' : '') + ', ' +
    (post.servings - post.claims.length) + ' of ' + post.servings + ' servings left');

  let done = 0;
  for (const [fake, token] of Object.entries(tokens.testers)) {
    if (done >= count) break;
    if (post.claims.includes(hashClient(Auth.userId(fake)))) continue; // already checked in
    const madeFriend = friendsOnly && (await befriend(ownerToken, email, fake, token));
    let r;
    try {
      r = await request('POST', '/api/posts/' + post.id + '/claim', token);
    } finally {
      // Unfriend again so your friend list is unchanged. The check-in stays.
      if (madeFriend) await request('POST', '/api/friends/remove', token, { email });
    }
    if (r.status === 200) {
      done++;
      console.log('  ' + fake + ' checked in' + (madeFriend ? ' (as a friend for a moment)' : '') + '. ' + r.data.post.servingsLeft + ' servings left.');
    } else if (r.status === 401) {
      console.error('The fake sign-ins have expired or were cleared. Stop the server and run --setup ' + email + ' again.');
      process.exit(1);
    } else if (r.status !== 409 || /every serving/.test(r.data.error || '')) {
      console.error('  ' + fake + ': ' + (r.data.error || 'HTTP ' + r.status));
      if (r.status !== 409) process.exit(1);
      break;
    }
  }
  if (done < count) console.log('Only ' + done + ' of ' + count + ' could check in (each fake student checks in once per post, and to at most 2 live posts at a time).');
  else console.log('Done. The pop-up should show in your browser right away, and the poster gets an email.');
}

function main() {
  const a = process.argv.slice(2);
  const email = a.find((x) => x.includes('@'));
  if (a.includes('--setup')) return setup(email ? email.trim().toLowerCase() : null);
  if (!email) {
    console.error('Usage: npm run fake-checkin -- --setup you@school.edu   (once, server stopped)');
    console.error('       npm run fake-checkin -- you@school.edu [--count N] [--title words]');
    process.exit(1);
  }
  const opt = (name) => { const i = a.indexOf(name); return i === -1 ? null : a[i + 1]; };
  const count = Math.max(1, Math.min(FAKES, Number(opt('--count')) || 1));
  return checkIn(email.trim().toLowerCase(), opt('--title'), count);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
