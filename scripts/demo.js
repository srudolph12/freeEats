'use strict';

/**
 * FreeEats - fill the app with demo posts for a presentation.
 *
 *   npm run demo                       add ~12 live posts from made-up students around USC
 *   npm run demo -- --me you@usc.edu   also give your account a history (check-ins and a past post)
 *   npm run demo -- --clear            remove every demo post (real posts are never touched)
 *
 * Stop the server first: it keeps posts in memory and would not see (or would overwrite)
 * the demo posts. Running it again replaces the old demo posts with fresh ones, so run it
 * shortly before you present. Posts last at most 2 hours, like real ones.
 *
 * Photos: put images in scripts/demo-photos/ named after the post's `photo` below
 * (e.g. pizza.jpg, boba.png, cookies.webp). Posts without one show the plate placeholder.
 *
 * The posters are fake accounts (name@demo.edu). Nobody is emailed, and they can not sign in.
 * To use another campus, change the coordinates in PLACES below.
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Store } = require('../src/store');
const { Auth } = require('../src/auth');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// Buildings around USC's University Park campus.
const PLACES = {
  taper: { building: 'Taper Hall (THH)', lat: 34.022229, lng: -118.284616, address: '3501 Trousdale Pkwy, Los Angeles' },
  leavey: { building: 'Leavey Library', lat: 34.02172, lng: -118.28281 },
  doheny: { building: 'Doheny Library', lat: 34.02018, lng: -118.28373 },
  tutor: { building: 'Ronald Tutor Campus Center', lat: 34.02035, lng: -118.28636, address: '3607 Trousdale Pkwy, Los Angeles' },
  sal: { building: 'Salvatori Computer Science Center', lat: 34.01953, lng: -118.28941 },
  rth: { building: 'Ronald Tutor Hall (RTH)', lat: 34.02013, lng: -118.28990 },
  annenberg: { building: 'Annenberg (ANN)', lat: 34.02216, lng: -118.28670 },
  village: { building: 'USC Village', lat: 34.02545, lng: -118.28528, address: '3201 S Hoover St, Los Angeles' },
  lyon: { building: 'Lyon Center', lat: 34.02436, lng: -118.28843 },
  marshall: { building: 'Fertitta Hall (JFF)', lat: 34.01862, lng: -118.28260 },
  bovard: { building: 'Bovard Auditorium', lat: 34.02060, lng: -118.28551 },
};

// minutesAgo: when it was posted. claims: how many demo students already checked in.
const POSTS = [
  { by: 'maya', at: 'tutor', minutesAgo: 8, hours: 2, servings: 24, claims: 5, photo: 'pizza', title: 'Pepperoni & cheese pizza',
    details: '2nd floor, room 227', description: 'Leftover from our club meeting. About 6 boxes. Grab a plate by the door.', tags: [] },
  { by: 'jordan', at: 'sal', minutesAgo: 22, hours: 1.5, servings: 15, claims: 11, photo: 'burrito-bowls', title: 'Chipotle burrito bowls',
    details: 'Lobby, by the elevators', description: 'Catering from a tech talk. Chicken and sofritas.', tags: ['gluten-free'] },
  { by: 'priya', at: 'leavey', minutesAgo: 5, hours: 1, servings: 30, claims: 2, photo: 'donuts', title: 'Assorted donuts',
    details: 'Front entrance tables', description: 'Study break! Glazed, chocolate and sprinkles.', tags: ['vegetarian'] },
  { by: 'alex', at: 'annenberg', minutesAgo: 35, hours: 2, servings: 12, claims: 4, photo: 'wraps', title: 'Veggie wraps & hummus',
    details: 'Room 207 (Wallis Annenberg Hall)', description: 'Hummus, falafel and veggie wraps. Some have feta.', tags: ['vegetarian'] },
  { by: 'sam', at: 'village', minutesAgo: 14, hours: 1, servings: 40, claims: 9, photo: 'boba', title: 'Boba from the club fair',
    details: 'Outside Trader Joe\'s, under the blue tent', description: 'Milk tea and taro. Bring your own straw if you can!', tags: ['vegetarian', 'gluten-free'] },
  { by: 'nina', at: 'doheny', minutesAgo: 50, hours: 2, servings: 20, claims: 17, photo: 'bagels', title: 'Bagels & cream cheese',
    details: 'Room 240, grad lounge', description: 'Plain, everything and cinnamon raisin. Almost gone!', tags: ['vegetarian'] },
  { by: 'omar', at: 'lyon', minutesAgo: 3, hours: 1.5, servings: 18, claims: 0, photo: 'halal', title: 'Halal chicken over rice',
    details: 'Front desk patio', description: 'From the MSA event. White sauce and hot sauce on the side.', tags: ['halal'] },
  { by: 'grace', at: 'rth', minutesAgo: 40, hours: 2, servings: 10, claims: 3, photo: 'curry', title: 'Vegan curry & rice',
    details: '1st floor kitchen', description: 'Chickpea and spinach curry. Bring a container if you have one.', tags: ['vegan', 'gluten-free', 'dairy-free'] },
  { by: 'leo', at: 'marshall', minutesAgo: 18, hours: 1, servings: 25, claims: 6, photo: 'sandwiches', title: 'Sandwich platters',
    details: 'Room 102, after the recruiting session', description: 'Turkey, ham and a few veggie ones. Chips too.', tags: [] },
  { by: 'hana', at: 'bovard', minutesAgo: 27, hours: 1.5, servings: 16, claims: 8, photo: 'cookies', title: 'Cookies & brownies',
    details: 'Side entrance', description: 'Left over from the concert reception.', tags: ['vegetarian', 'kosher'] },
  { by: 'diego', at: 'taper', minutesAgo: 12, hours: 2, servings: 14, claims: 1, photo: 'tacos', title: 'Tacos al pastor & veggie tacos',
    details: 'Courtyard benches', description: 'Taco truck catering from a department lunch. Salsa verde included.', tags: ['dairy-free'] },
  { by: 'ruth', at: null, building: 'Mudd Hall (MHP)', minutesAgo: 9, hours: 1, servings: 8, claims: 2, photo: 'fruit', title: 'Fruit cups & granola bars',
    details: 'Philosophy lounge, 1st floor', description: 'Not pinned on the map, so it only shows in the list.', tags: ['vegan', 'gluten-free', 'dairy-free'] },
];

// History for --me: ended posts the presenter checked in for, and one they posted.
const PAST_CHECKINS = [
  { by: 'maya', at: 'doheny', hoursAgo: 26, servings: 20, claims: 12, title: 'Pad thai trays', details: 'Room 233', tags: [] },
  { by: 'omar', at: 'tutor', hoursAgo: 50, servings: 30, claims: 22, title: 'Mediterranean platters', details: 'Ballroom foyer', tags: ['halal'] },
];
const PAST_POSTS = [
  { at: 'sal', hoursAgo: 28, servings: 12, claims: 9, title: 'Leftover hackathon pizza', details: 'Room 101', tags: ['vegetarian'] },
];
const LIVE_CHECKIN_TITLE = 'Pepperoni & cheese pizza';

const PHOTO_DIR = path.join(__dirname, 'demo-photos');
const PHOTO_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const PHOTO_SPELLINGS = { sandwiches: ['sandwhiches'], pizza: ['pizza1'] }; // other names accepted for the same photo

/** The photo for a post as a data URL (what the app's upload expects), or undefined. */
function demoPhoto(name, missing) {
  if (!name) return undefined;
  let files = [];
  try {
    files = fs.readdirSync(PHOTO_DIR);
  } catch (e) {
    missing.push(name);
    return undefined;
  }
  const wanted = [name].concat(PHOTO_SPELLINGS[name] || []);
  const file = files.find((f) => {
    const ext = path.extname(f).toLowerCase();
    return PHOTO_TYPES[ext] && wanted.includes(path.basename(f, path.extname(f)).toLowerCase());
  });
  if (!file) {
    missing.push(name);
    return undefined;
  }
  const buf = fs.readFileSync(path.join(PHOTO_DIR, file));
  return 'data:' + PHOTO_TYPES[path.extname(file).toLowerCase()] + ';base64,' + buf.toString('base64');
}

const DEMO_STUDENTS = 60; // made-up students who "check in" to make the meters look real

function args() {
  const a = process.argv.slice(2);
  const out = { clear: a.includes('--clear'), me: null };
  const i = a.indexOf('--me');
  if (i !== -1) out.me = (a[i + 1] || '').trim().toLowerCase();
  return out;
}

// Is the FreeEats server running? If so, the demo posts would be lost.
function serverRunning(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

const userId = (name) => Auth.userId(name + '@demo.edu');

async function main() {
  const opts = args();
  if (opts.me !== null && !/^[^\s@]+@([a-z0-9-]+\.)+edu$/.test(opts.me)) {
    console.error('--me needs your school email, e.g. npm run demo -- --me you@usc.edu');
    process.exit(1);
  }
  const port = Number(process.env.PORT) || 3000;
  if (await serverRunning(port)) {
    console.error('FreeEats is running on port ' + port + '. Stop it first (Ctrl+C), run this again, then start it back up.');
    process.exit(1);
  }

  const realNow = Date.now();
  let clock = realNow;
  const dataDir = process.env.DATA_DIR || path.resolve(__dirname, '..', 'data');
  const store = new Store({ dataDir, now: () => clock });
  await store.load();

  // Remove earlier demo posts (marked with demo: true).
  const before = store.posts.length;
  for (const p of store.posts) {
    if (p.demo && p.photo) await fsp.unlink(path.join(store.uploadsDir, p.photo)).catch(() => {});
  }
  store.posts = store.posts.filter((p) => !p.demo);
  const removed = before - store.posts.length;
  await store.exclusive(() => store.save());
  if (opts.clear) {
    console.log('Removed ' + removed + ' demo post' + (removed === 1 ? '' : 's') + '. Real posts were not touched.');
    return;
  }

  const students = Array.from({ length: DEMO_STUDENTS }, (_, i) => userId('student' + (i + 1)));
  let next = 0;
  const me = opts.me ? Auth.userId(opts.me) : null;
  const missingPhotos = [];

  async function make(spec, owner, postedAt, hours) {
    const place = spec.at ? PLACES[spec.at] : { building: spec.building };
    clock = postedAt;
    const view = await store.create({
      title: spec.title,
      servings: spec.servings,
      building: place.building,
      details: spec.details || '',
      description: spec.description || '',
      address: place.address || '',
      tags: spec.tags,
      hours,
      lat: place.lat,
      lng: place.lng,
      photo: demoPhoto(spec.photo, missingPhotos),
    }, owner);
    const post = store.posts.find((p) => p.id === view.id);
    post.demo = true;
    // Check-ins spread out after it was posted.
    const span = Math.max(1, Math.min(realNow, postedAt + hours * HOUR) - postedAt);
    for (let i = 0; i < spec.claims; i++) {
      clock = postedAt + Math.round(((i + 1) / (spec.claims + 1)) * span);
      await store.claim(post.id, students[next++ % students.length]);
    }
    return post;
  }

  for (const spec of POSTS) {
    await make(spec, userId(spec.by), realNow - spec.minutesAgo * MIN, spec.hours);
  }

  if (me) {
    for (const spec of PAST_CHECKINS) {
      const post = await make(spec, userId(spec.by), realNow - spec.hoursAgo * HOUR, 2);
      clock = post.createdAt + 20 * MIN;
      await store.claim(post.id, me);
    }
    for (const spec of PAST_POSTS) {
      const post = await make(spec, me, realNow - spec.hoursAgo * HOUR, 2);
      clock = post.createdAt + 90 * MIN;
      await store.close(post.id, me);
    }
    const live = store.posts.find((p) => p.demo && p.title === LIVE_CHECKIN_TITLE && p.ownerId !== me);
    clock = realNow - 2 * MIN;
    if (live) await store.claim(live.id, me);
  }

  clock = realNow;
  await store.exclusive(() => store.save());

  const soonest = Math.min(...store.posts.filter((p) => p.demo && p.expiresAt > realNow).map((p) => p.expiresAt));
  console.log('Added ' + POSTS.length + ' live demo posts around USC' + (removed ? ' (replaced ' + removed + ' old ones)' : '') + '.');
  const withPhotos = POSTS.length - missingPhotos.length;
  console.log(withPhotos + ' of them have photos.' + (missingPhotos.length
    ? ' No photo found for: ' + missingPhotos.join(', ') + ' (add e.g. ' + missingPhotos[0] + '.jpg to scripts/demo-photos/).' : ''));
  if (me) console.log('Gave ' + opts.me + ' a history: ' + PAST_CHECKINS.length + ' past check-ins, 1 past post, and 1 live check-in.');
  console.log('The first one ends at ' + new Date(soonest).toLocaleTimeString() + '. Run this again any time for fresh ones.');
  console.log('Now start the server: npm run dev:mail');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
