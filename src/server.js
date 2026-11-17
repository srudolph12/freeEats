'use strict';

/**
 * FreeEats - HTTP server. Zero dependencies (Node built-ins only).
 *
 *   GET    /api/health
 *   POST   /api/auth/request-code      body: { email }  emails a 6-digit code (.edu addresses only)
 *   POST   /api/auth/verify            body: { email, code }  signs in (sets a session cookie)
 *   POST   /api/auth/login             body: { email, password }  signs in with a password
 *   POST   /api/auth/password          body: { password, currentPassword }  set or change your password
 *   GET    /api/auth/me                the signed-in student, or 401
 *   POST   /api/auth/logout            signs out
 *   POST   /api/auth/logout-all        signs out on every device
 *
 *   Everything below needs a signed-in student:
 *   GET    /api/account                profile, totals, check-in history, own posts
 *   PUT    /api/account/preferences    body: { diet: [tags] }  saved dietary preferences
 *   GET    /api/posts                  live posts
 *   POST   /api/posts                  share food   body: { title, servings, building, details,
 *                                                          address, description, tags[], hours (max 2),
 *                                                          lat, lng, photo }
 *   GET    /api/geocode?q=address      map coordinates for an address  (&lat=&lng= to prefer nearby)
 *   PATCH  /api/posts/:id              poster edits a live post (same fields as POST, plus removePhoto)
 *   DELETE /api/posts/:id              poster deletes a post (live or past)
 *   POST   /api/posts/:id/claim        check in for one serving
 *   DELETE /api/posts/:id/claim        cancel a check-in
 *   POST   /api/posts/:id/close        poster marks the food as gone
 *   GET    /api/friends                your friends and pending requests
 *   POST   /api/friends                body: { email }  send a friend request (or accept theirs)
 *   POST   /api/friends/remove         body: { email }  unfriend, decline, or cancel a request
 *   GET    /api/events                 live updates (Server-Sent Events) for the signed-in student
 *   GET    /uploads/:file              photos
 *
 * Sessions are an HttpOnly, SameSite=Lax cookie. Changes from other sites are refused
 * by checking the Origin header.
 * By default it listens on 127.0.0.1 only; set HOST=0.0.0.0 to share it on your network.
 */

const http = require('node:http');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Store, AppError, TAGS, DURATIONS_HOURS, LIMITS, MAX_ACTIVE_CHECKINS, hashClient } = require('./store');
const { Auth, normalizeEmail } = require('./auth');
const { Friends } = require('./friends');
const { createMailer } = require('./mailer');
const { createGeocoder } = require('./geocode');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const MAX_BODY_BYTES = 6 * 1024 * 1024; // a 3 MB photo grows ~33% as base64
const SESSION_COOKIE = 'crumbs_session';
const CHECKIN_MAIL_GAP_MS = 5 * 60 * 1000; // at most one check-in email per post every 5 minutes

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob: https://tile.openstreetmap.org; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'Permissions-Policy': 'camera=(self), geolocation=(self)',
};

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({}, SECURITY_HEADERS, headers));
  res.end(body);
}

function sendJson(res, status, data) {
  send(res, status, JSON.stringify(data), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] || '');
    if (!type.startsWith('application/json')) {
      reject(new AppError(415, 'Send JSON (Content-Type: application/json).'));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (c) => {
      if (failed) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        failed = true;
        reject(new AppError(413, 'Request is too large. Try a smaller photo.'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (failed) return;
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (e) {
        reject(new AppError(400, 'Request body is not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function getCookie(req, name) {
  const header = String(req.headers.cookie || '');
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i !== -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function sessionCookie(req, value, maxAgeSeconds) {
  const secure = process.env.COOKIE_SECURE === '1' || req.headers['x-forwarded-proto'] === 'https';
  return SESSION_COOKIE + '=' + value + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAgeSeconds + (secure ? '; Secure' : '');
}

// Refuse changes sent from another website (CSRF). Browsers always send Origin on these.
function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let host;
  try {
    host = new URL(origin).host;
  } catch (e) {
    host = null;
  }
  if (host !== req.headers.host) throw new AppError(403, 'Request came from another site.');
}

async function serveFile(res, filePath, headOnly, cacheControl) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch (e) {
    throw new AppError(404, 'Not found');
  }
  if (!stat.isFile()) throw new AppError(404, 'Not found');
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': cacheControl || 'no-cache' };
  if (headOnly) return send(res, 200, undefined, headers);
  send(res, 200, await fsp.readFile(filePath), headers);
}

async function serveStatic(req, res, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (e) {
    throw new AppError(400, 'Bad path');
  }
  if (decoded === '/') decoded = '/index.html';
  const target = path.resolve(PUBLIC_DIR, '.' + decoded);
  if (!target.startsWith(PUBLIC_DIR + path.sep)) throw new AppError(404, 'Not found');
  await serveFile(res, target, req.method === 'HEAD');
}

function createServer(opts) {
  opts = opts || {};
  const dataDir = opts.dataDir || process.env.DATA_DIR || path.resolve(__dirname, '..', 'data');
  const store = new Store({ dataDir, now: opts.now });
  const auth = new Auth({ dataDir, now: opts.now, sendMail: opts.sendMail || createMailer(process.env) });
  const geocode = opts.geocode || createGeocoder(process.env);
  const lookups = new Map(); // user id -> times of recent address lookups
  const friends = new Friends({ dataDir, now: opts.now });
  const ready = Promise.all([store.load(), auth.load(), friends.load()]);
  const idOf = (email) => hashClient(Auth.userId(email)); // how posts refer to a student

  // Your friends as hashed id -> email, which the store uses for friends-only posts.
  function friendMap(email) {
    return new Map(friends.friendsOf(email).map((e) => [idOf(e), e]));
  }

  /* ---- live updates: each signed-in browser keeps one /api/events stream open ---- */
  const streams = new Map(); // hashed user id (as in post.ownerId) -> Set of open responses
  function pushTo(ownerId, event, data) {
    const set = streams.get(ownerId);
    if (!set) return;
    const msg = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
    for (const res of set) res.write(msg);
  }
  // A comment line now and then keeps proxies and sleepy laptops from dropping the stream.
  const heartbeat = setInterval(() => {
    for (const set of streams.values()) for (const res of set) res.write(': ping\n\n');
  }, 25000);
  heartbeat.unref();

  /* ---- check-in emails to the poster, bundled so a rush of check-ins is one email ---- */
  // Hashed user id (as stored on posts) -> email. Rebuilt when someone new has signed up.
  const emails = new Map();
  let emailsBuiltFor = -1;
  function emailForId(id) {
    if (!emails.has(id) && emailsBuiltFor !== auth.users.size) {
      for (const email of auth.users.keys()) emails.set(idOf(email), email);
      emailsBuiltFor = auth.users.size;
    }
    return emails.get(id) || null;
  }
  const ownerEmail = emailForId;

  // Posters see who checked in to their own posts: [{ email, at }], oldest first.
  // `email` is null for check-ins by accounts we have no email for (e.g. made-up demo students).
  function withCheckins(views) {
    for (const v of views) {
      if (!v.mine) continue;
      const p = store.posts.find((x) => x.id === v.id);
      if (!p) continue;
      v.checkedIn = p.claims
        .map((h) => ({ email: emailForId(h), at: (p.claimTimes && p.claimTimes[h]) || null }))
        .sort((a, b) => (a.at || 0) - (b.at || 0));
    }
    return views;
  }

  // "maya@usc.edu", "maya@usc.edu and omar@usc.edu", "a, b and 2 others"
  function names(list, unknown) {
    const parts = list.slice(0, 3);
    const rest = list.length - parts.length + (unknown || 0);
    if (!parts.length) return rest > 1 ? rest + ' students' : 'A student';
    if (rest > 0) parts.push(rest + (rest === 1 ? ' other student' : ' other students'));
    return parts.length === 1 ? parts[0] : parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
  }
  const checkinMail = new Map(); // post id -> { lastSent, pending, timer, link }
  function queueCheckinEmail(postId, link, who) {
    let s = checkinMail.get(postId);
    if (!s) {
      if (checkinMail.size > 1000) for (const [k, v] of checkinMail) if (!v.timer) checkinMail.delete(k);
      s = { lastSent: 0, pending: 0, timer: null, link, who: [] };
      checkinMail.set(postId, s);
    }
    s.pending++;
    if (who) s.who.push(who);
    if (link) s.link = link;
    if (s.timer) return; // already waiting; this check-in joins that email
    const wait = Math.max(0, s.lastSent + CHECKIN_MAIL_GAP_MS - Date.now());
    s.timer = setTimeout(() => sendCheckinEmail(postId, s), wait);
    s.timer.unref();
  }
  function sendCheckinEmail(postId, s) {
    const p = store.posts.find((x) => x.id === postId);
    // Only the students who are still checked in (someone may have cancelled in the meantime).
    const still = p ? s.who.filter((e, i, a) => a.indexOf(e) === i && p.claims.includes(idOf(e))) : [];
    const count = Math.max(still.length, s.pending - s.who.length);
    s.timer = null;
    s.pending = 0;
    s.who = [];
    s.lastSent = Date.now();
    if (!p || !count) return;
    const to = ownerEmail(p.ownerId);
    if (!to || to.endsWith('@demo.edu')) return; // demo posters are not real inboxes
    const left = store.left(p);
    const who = names(still, count - still.length);
    const lines = [
      'Hi!',
      '',
      who + ' just checked in for your free food "' + p.title + '" at ' + p.building + (p.details ? ' (' + p.details + ')' : '') + '.',
      '',
      left > 0
        ? p.claims.length + ' of ' + p.servings + ' servings are claimed, ' + left + ' left.'
        : 'Every serving is now claimed. Nice!',
      store.isActive(p) ? 'If the food runs out early, open FreeEats and tap "Mark as gone" so nobody makes a wasted trip.' : '',
    ];
    if (s.link) lines.push('', s.link + '/#account');
    lines.push('', 'Thanks for sharing!', 'FreeEats');
    auth.sendMail({
      to,
      subject: (still.length === 1 && count === 1 ? still[0] : count === 1 ? 'Someone' : count + ' students') + ' checked in for your ' + p.title,
      text: lines.filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n'),
    }).catch((err) => console.error('Could not send check-in email:', err.message));
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    const method = req.method;
    if (method !== 'GET' && method !== 'HEAD') checkOrigin(req);
    const token = getCookie(req, SESSION_COOKIE);

    if (pathname === '/api/health') {
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/config') {
      return sendJson(res, 200, { tags: TAGS, durations: DURATIONS_HOURS, limits: LIMITS, maxCheckins: MAX_ACTIVE_CHECKINS });
    }

    if (pathname.startsWith('/api/auth/')) {
      if (pathname === '/api/auth/me' && method === 'GET') {
        const user = auth.session(token);
        if (!user) throw new AppError(401, 'Not signed in.');
        return sendJson(res, 200, { user: auth.profile(user.email) });
      }
      if (method !== 'POST') throw new AppError(405, 'Method not allowed');
      if (pathname === '/api/auth/request-code') {
        const body = await readJson(req);
        return sendJson(res, 200, await auth.requestCode(body.email, req.socket.remoteAddress));
      }
      if (pathname === '/api/auth/verify') {
        const body = await readJson(req);
        const s = await auth.verifyCode(body.email, body.code);
        res.setHeader('Set-Cookie', sessionCookie(req, s.token, s.maxAgeSeconds));
        return sendJson(res, 200, { user: auth.profile(s.email) });
      }
      if (pathname === '/api/auth/login') {
        const body = await readJson(req);
        auth.sweep();
        const s = await auth.login(body.email, body.password, req.socket.remoteAddress);
        res.setHeader('Set-Cookie', sessionCookie(req, s.token, s.maxAgeSeconds));
        return sendJson(res, 200, { user: auth.profile(s.email) });
      }
      if (pathname === '/api/auth/password') {
        const user = auth.session(token);
        if (!user) throw new AppError(401, 'Not signed in.');
        const body = await readJson(req);
        return sendJson(res, 200, { user: await auth.setPassword(user, body.password, body.currentPassword, token) });
      }
      if (pathname === '/api/auth/logout-all') {
        const user = auth.session(token);
        if (!user) throw new AppError(401, 'Not signed in.');
        const devices = await auth.logoutAll(user.email);
        res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
        return sendJson(res, 200, { ok: true, devices });
      }
      if (pathname === '/api/auth/logout') {
        await auth.logout(token);
        res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
        return sendJson(res, 200, { ok: true });
      }
      throw new AppError(404, 'Unknown API route');
    }

    let user = null;
    let userId = null;
    if (pathname.startsWith('/api/posts') || pathname.startsWith('/api/account') || pathname === '/api/geocode' || pathname === '/api/events' || pathname.startsWith('/api/friends')) {
      user = auth.session(token);
      if (!user) throw new AppError(401, 'Sign in with your school email to continue.');
      userId = user.id;
    }

    if (pathname === '/api/events') {
      if (method !== 'GET') throw new AppError(405, 'Method not allowed');
      const me = hashClient(userId);
      let set = streams.get(me);
      if (!set) streams.set(me, (set = new Set()));
      if (set.size >= 10) set.values().next().value.end(); // one student, too many tabs: drop the oldest
      res.writeHead(200, Object.assign({}, SECURITY_HEADERS, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      }));
      res.write('retry: 3000\n\n');
      set.add(res);
      const drop = () => {
        set.delete(res);
        if (!set.size && streams.get(me) === set) streams.delete(me);
      };
      req.on('close', drop);
      res.on('close', drop);
      return;
    }

    if (pathname === '/api/account') {
      if (method !== 'GET') throw new AppError(405, 'Method not allowed');
      await auth.ensureUser(user.email); // students who signed in before profiles existed
      const history = store.history(userId, friendMap(user.email));
      withCheckins(history.posts);
      return sendJson(res, 200, Object.assign({ user: auth.profile(user.email), serverTime: store.now() },
        history, { friends: friends.list(user.email) }));
    }

    if (pathname === '/api/friends') {
      if (method === 'GET') return sendJson(res, 200, friends.list(user.email));
      if (method !== 'POST') throw new AppError(405, 'Method not allowed');
      const other = normalizeEmail((await readJson(req)).email);
      const result = await friends.add(user.email, other);
      pushTo(idOf(other), 'friends', {});
      return sendJson(res, 200, Object.assign({ result }, friends.list(user.email)));
    }
    if (pathname === '/api/friends/remove') {
      if (method !== 'POST') throw new AppError(405, 'Method not allowed');
      const other = normalizeEmail((await readJson(req)).email);
      await friends.remove(user.email, other);
      pushTo(idOf(other), 'friends', {});
      return sendJson(res, 200, friends.list(user.email));
    }
    if (pathname === '/api/account/preferences') {
      if (method !== 'PUT') throw new AppError(405, 'Method not allowed');
      const body = await readJson(req);
      return sendJson(res, 200, { user: await auth.setDiet(user.email, body.diet) });
    }

    if (pathname === '/api/geocode') {
      if (method !== 'GET') throw new AppError(405, 'Method not allowed');
      const q = (url.searchParams.get('q') || '').replace(/\s+/g, ' ').trim();
      if (q.length < 3) throw new AppError(400, 'Type a street address to look up.');
      if (q.length > LIMITS.address) throw new AppError(400, 'Address must be ' + LIMITS.address + ' characters or fewer.');
      const t = Date.now();
      const recent = (lookups.get(userId) || []).filter((x) => t - x < 60000);
      if (recent.length >= 15) throw new AppError(429, 'Too many address lookups. Wait a minute and try again.');
      recent.push(t);
      if (lookups.size > 5000) lookups.clear(); // keep memory bounded
      lookups.set(userId, recent);
      const lat = Number(url.searchParams.get('lat'));
      const lng = Number(url.searchParams.get('lng'));
      const near = url.searchParams.has('lat') && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
      let result;
      try {
        result = await geocode(q, near);
      } catch (err) {
        console.error('Address lookup failed:', err.message);
        throw new AppError(502, 'Could not look up addresses right now. Try again in a moment.');
      }
      if (!result) throw new AppError(404, 'We could not find that address. Try adding the city, or check the spelling.');
      return sendJson(res, 200, { result });
    }

    if (pathname === '/api/posts') {
      if (method === 'GET') return sendJson(res, 200, { posts: withCheckins(store.list(userId, friendMap(user.email))), serverTime: store.now() });
      if (method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 201, { post: await store.create(body, userId) });
      }
      throw new AppError(405, 'Method not allowed');
    }

    const one = /^\/api\/posts\/([0-9a-f-]{36})$/.exec(pathname);
    if (one) {
      if (method === 'PATCH') {
        const body = await readJson(req);
        return sendJson(res, 200, { post: await store.update(one[1], body, userId) });
      }
      if (method === 'DELETE') return sendJson(res, 200, await store.remove(one[1], userId));
      throw new AppError(405, 'Method not allowed');
    }

    const action = /^\/api\/posts\/([0-9a-f-]{36})\/(claim|close)$/.exec(pathname);
    if (action) {
      const [, id, verb] = action;
      if (verb === 'claim' && (method === 'POST' || method === 'DELETE')) {
        const mine = friendMap(user.email);
        const post = method === 'POST' ? await store.claim(id, userId, mine) : await store.unclaim(id, userId, mine);
        const ownerId = store.posts.find((p) => p.id === id).ownerId;
        pushTo(ownerId, method === 'POST' ? 'checkin' : 'cancel', { postId: id });
        if (method === 'POST') queueCheckinEmail(id, typeof req.headers.origin === 'string' && /^https?:\/\/[^\s/]+$/.test(req.headers.origin) ? req.headers.origin : null, user.email);
        return sendJson(res, 200, { post });
      }
      if (verb === 'close' && method === 'POST') return sendJson(res, 200, { post: await store.close(id, userId) });
      throw new AppError(405, 'Method not allowed');
    }

    if (pathname.startsWith('/api/')) throw new AppError(404, 'Unknown API route');

    if (method !== 'GET' && method !== 'HEAD') throw new AppError(405, 'Method not allowed');

    if (pathname.startsWith('/uploads/')) {
      const file = store.photoPath(pathname.slice('/uploads/'.length));
      if (!file) throw new AppError(404, 'Not found');
      // Photo names are unique ids, so they never change and can be cached.
      return serveFile(res, file, method === 'HEAD', 'public, max-age=86400, immutable');
    }

    return serveStatic(req, res, pathname);
  }

  const server = http.createServer(async (req, res) => {
    try {
      await ready;
      await route(req, res);
    } catch (err) {
      const status = err instanceof AppError ? err.status : 500;
      if (status === 500) console.error(err);
      if (res.headersSent) return res.end();
      const message = status === 500 ? 'Something went wrong on the server.' : err.message;
      if (req.url.startsWith('/api/')) sendJson(res, status, { error: message });
      else send(res, status, message, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
  });
  server.store = store;
  server.auth = auth;
  server.friends = friends;
  server.ready = ready;
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '127.0.0.1';
  createServer().listen(port, host, () => {
    console.log('FreeEats is running at http://' + (host === '0.0.0.0' ? 'localhost' : host) + ':' + port);
    if (!process.env.SMTP_HOST) console.log('SMTP is not set up, so sign-in codes will be printed here instead of emailed.');
  });
}

module.exports = { createServer };
