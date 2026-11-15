'use strict';

/**
 * FreeEats - post storage.
 *
 * Keeps posts in memory, persists them to a JSON file, and stores photos as files.
 * All changes run one at a time through a queue, so two students checking in for
 * the last serving at the same moment cannot both get it.
 *
 * Each change comes with the signed-in student's id (see auth.js); we store only a
 * hash of it, and never send owner or claimer ids back to anyone.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const TAGS = ['vegetarian', 'vegan', 'gluten-free', 'dairy-free', 'halal', 'kosher'];
const DURATIONS_HOURS = [0.5, 1, 1.5, 2]; // food can be listed for at most 2 hours
const LIMITS = {
  title: 80,
  description: 300,
  building: 80,
  address: 160,
  details: 120,
  servingsMax: 200,
  photoBytes: 3 * 1024 * 1024,
};
const HOUR = 60 * 60 * 1000;
const PHOTO_KEEP_MS = 24 * HOUR; // photos of ended posts are deleted after this
const HISTORY_KEEP_MS = 180 * 24 * HOUR; // ended posts stay in account history this long, then are deleted
const HISTORY_LIMIT = 100; // most items returned per history list

const PHOTO_TYPES = {
  'image/jpeg': { ext: 'jpg', ok: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': { ext: 'png', ok: (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) },
  'image/webp': {
    ext: 'webp',
    ok: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
};
const PHOTO_NAME = /^[0-9a-f-]{36}\.(jpg|png|webp)$/;
const CLIENT_ID = /^[A-Za-z0-9-]{8,64}$/;

function hashClient(clientId) {
  return crypto.createHash('sha256').update('crumbs:' + clientId).digest('hex').slice(0, 32);
}

function isValidClientId(id) {
  return typeof id === 'string' && CLIENT_ID.test(id);
}

/* ------------------------------------------------------------- validation */

function text(value, field, max, required) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw new AppError(400, field + ' must be text.');
  const clean = value.replace(/\s+/g, ' ').trim();
  if (required && !clean) throw new AppError(400, field + ' is required.');
  if (clean.length > max) throw new AppError(400, field + ' must be ' + max + ' characters or fewer.');
  return clean;
}

function coordinate(value, min, max) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new AppError(400, 'Location coordinates are invalid.');
  return Math.round(n * 1e6) / 1e6;
}

function decodePhoto(dataUrl) {
  if (dataUrl === undefined || dataUrl === null || dataUrl === '') return null;
  const m = typeof dataUrl === 'string' && /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  const type = m && PHOTO_TYPES[m[1]];
  if (!type) throw new AppError(400, 'Photo must be a JPEG, PNG, or WebP image.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > LIMITS.photoBytes) throw new AppError(413, 'Photo is too large (3 MB max).');
  if (buf.length < 12 || !type.ok(buf)) throw new AppError(400, 'Photo file is not a valid image.');
  return { buf, ext: type.ext };
}

function validatePost(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError(400, 'Send the post as a JSON object.');

  const servings = Number(input.servings);
  if (!Number.isInteger(servings) || servings < 1 || servings > LIMITS.servingsMax) {
    throw new AppError(400, 'Servings must be a whole number from 1 to ' + LIMITS.servingsMax + '.');
  }
  const hours = Number(input.hours === undefined ? 2 : input.hours);
  if (DURATIONS_HOURS.indexOf(hours) === -1) {
    throw new AppError(400, 'Available-for must be 30 minutes, 1 hour, 1.5 hours, or 2 hours (the most).');
  }
  const tags = input.tags === undefined ? [] : input.tags;
  if (!Array.isArray(tags) || tags.some((t) => TAGS.indexOf(t) === -1)) {
    throw new AppError(400, 'Dietary tags must be from: ' + TAGS.join(', ') + '.');
  }
  const lat = coordinate(input.lat, -90, 90);
  const lng = coordinate(input.lng, -180, 180);
  if ((lat === null) !== (lng === null)) throw new AppError(400, 'Send both latitude and longitude, or neither.');

  return {
    title: text(input.title, 'What the food is', LIMITS.title, true),
    description: text(input.description, 'Description', LIMITS.description, false),
    building: text(input.building, 'Building', LIMITS.building, true),
    details: text(input.details, 'Room or spot', LIMITS.details, false),
    address: text(input.address, 'Address', LIMITS.address, false),
    servings,
    hours,
    tags: TAGS.filter((t) => tags.indexOf(t) !== -1), // de-duplicated, stable order
    lat,
    lng,
    photo: decodePhoto(input.photo),
  };
}

/* ------------------------------------------------------------------ store */

class Store {
  constructor(opts) {
    this.dataDir = opts.dataDir;
    this.file = path.join(this.dataDir, 'posts.json');
    this.uploadsDir = path.join(this.dataDir, 'uploads');
    this.now = opts.now || Date.now;
    this.posts = [];
    this.queue = Promise.resolve();
  }

  async load() {
    await fsp.mkdir(this.uploadsDir, { recursive: true });
    try {
      const parsed = JSON.parse(await fsp.readFile(this.file, 'utf8'));
      this.posts = Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Keep the unreadable file for inspection and start fresh.
        await fsp.rename(this.file, this.file + '.corrupt-' + this.now()).catch(() => {});
      }
      this.posts = [];
    }
    await this.exclusive(() => this.prune());
  }

  // Run one change at a time.
  exclusive(fn) {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async save() {
    const tmp = this.file + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(this.posts, null, 2));
    await fsp.rename(tmp, this.file);
  }

  photoPath(name) {
    return PHOTO_NAME.test(name) ? path.join(this.uploadsDir, name) : null;
  }

  left(p) {
    return p.servings - p.claims.length;
  }

  isActive(p) {
    return !p.closedAt && p.expiresAt > this.now();
  }

  view(p, me) {
    return {
      id: p.id,
      title: p.title,
      description: p.description,
      building: p.building,
      details: p.details,
      address: p.address || '',
      servings: p.servings,
      servingsLeft: this.left(p),
      tags: p.tags.slice(),
      lat: p.lat,
      lng: p.lng,
      photoUrl: p.photo ? '/uploads/' + p.photo : null,
      createdAt: p.createdAt,
      expiresAt: p.expiresAt,
      closedAt: p.closedAt || null,
      editedAt: p.editedAt || null,
      status: !this.isActive(p) ? 'ended' : this.left(p) > 0 ? 'available' : 'gone',
      mine: !!me && p.ownerId === me,
      claimedByMe: !!me && p.claims.indexOf(me) !== -1,
    };
  }

  /** Live posts, newest first. Fully claimed posts are only shown to their owner and claimers. */
  list(clientId) {
    const me = isValidClientId(clientId) ? hashClient(clientId) : null;
    return this.posts
      .filter((p) => this.isActive(p) && (this.left(p) > 0 || p.ownerId === me || p.claims.indexOf(me) !== -1))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((p) => this.view(p, me));
  }

  find(id) {
    const p = this.posts.find((x) => x.id === id);
    if (!p) throw new AppError(404, 'That post no longer exists.');
    return p;
  }

  create(input, clientId) {
    return this.exclusive(async () => {
      const me = this.requireClient(clientId);
      const clean = validatePost(input);
      const id = crypto.randomUUID();
      let photo = null;
      if (clean.photo) {
        photo = id + '.' + clean.photo.ext;
        await fsp.writeFile(path.join(this.uploadsDir, photo), clean.photo.buf);
      }
      const now = this.now();
      const post = {
        id,
        title: clean.title,
        description: clean.description,
        building: clean.building,
        details: clean.details,
        address: clean.address,
        servings: clean.servings,
        tags: clean.tags,
        lat: clean.lat,
        lng: clean.lng,
        photo,
        createdAt: now,
        expiresAt: now + clean.hours * HOUR,
        closedAt: null,
        ownerId: me,
        claims: [],
        claimTimes: {},
      };
      this.posts.push(post);
      await this.prune();
      await this.save();
      return this.view(post, me);
    });
  }

  claim(id, clientId) {
    return this.exclusive(async () => {
      const me = this.requireClient(clientId);
      const p = this.find(id);
      if (!this.isActive(p)) throw new AppError(410, 'This food is no longer available.');
      if (p.ownerId === me) throw new AppError(400, 'You posted this one, so there is no need to check in.');
      if (p.claims.indexOf(me) !== -1) throw new AppError(409, 'You already checked in for this one.');
      if (this.left(p) <= 0) throw new AppError(409, 'Sorry, every serving has been claimed.');
      p.claims.push(me);
      if (!p.claimTimes) p.claimTimes = {};
      p.claimTimes[me] = this.now();
      await this.save();
      return this.view(p, me);
    });
  }

  unclaim(id, clientId) {
    return this.exclusive(async () => {
      const me = this.requireClient(clientId);
      const p = this.find(id);
      const i = p.claims.indexOf(me);
      if (i === -1) throw new AppError(409, 'You have not checked in for this one.');
      if (!this.isActive(p)) throw new AppError(410, 'This post has already ended.');
      p.claims.splice(i, 1);
      if (p.claimTimes) delete p.claimTimes[me];
      await this.save();
      return this.view(p, me);
    });
  }

  close(id, clientId) {
    return this.exclusive(async () => {
      const me = this.requireClient(clientId);
      const p = this.find(id);
      if (p.ownerId !== me) throw new AppError(403, 'Only the person who posted this can mark it as gone.');
      if (!p.closedAt) {
        p.closedAt = this.now();
        await this.save();
      }
      return this.view(p, me);
    });
  }

  /**
   * The poster edits a live post. `input` has the same fields as create(). For the photo:
   * a new data URL replaces it, `removePhoto: true` deletes it, and leaving both out keeps it.
   * `hours` counts from when the food was first posted (still 2 hours at most); leave it out
   * to keep the current end time.
   */
  update(id, input, clientId) {
    return this.exclusive(async () => {
      const me = this.requireClient(clientId);
      const p = this.find(id);
      if (p.ownerId !== me) throw new AppError(403, 'Only the person who posted this can edit it.');
      if (!this.isActive(p)) throw new AppError(410, 'This post has already ended, so it can no longer be edited.');
      const keepTime = !input || input.hours === undefined;
      const clean = validatePost(input);
      if (clean.servings < p.claims.length) {
        throw new AppError(400, p.claims.length + ' students already checked in, so servings can not go below ' + p.claims.length + '.');
      }
      const expiresAt = keepTime ? p.expiresAt : p.createdAt + clean.hours * HOUR;
      if (expiresAt <= this.now()) {
        throw new AppError(400, 'That time has already passed. Pick a longer time, or mark the food as gone.');
      }

      let photo = p.photo;
      if (clean.photo || input.removePhoto === true) {
        photo = null;
        if (clean.photo) {
          photo = crypto.randomUUID() + '.' + clean.photo.ext; // new name, so cached copies of the old photo are not reused
          await fsp.writeFile(path.join(this.uploadsDir, photo), clean.photo.buf);
        }
        if (p.photo && PHOTO_NAME.test(p.photo)) await fsp.unlink(path.join(this.uploadsDir, p.photo)).catch(() => {});
      }

      Object.assign(p, {
        title: clean.title,
        description: clean.description,
        building: clean.building,
        details: clean.details,
        address: clean.address,
        servings: clean.servings,
        tags: clean.tags,
        lat: clean.lat,
        lng: clean.lng,
        photo,
        expiresAt,
        editedAt: this.now(),
      });
      await this.save();
      return this.view(p, me);
    });
  }

  /** The poster deletes a post for good, live or past. It also leaves everyone's history. */
  remove(id, clientId) {
    return this.exclusive(async () => {
      const me = this.requireClient(clientId);
      const p = this.find(id);
      if (p.ownerId !== me) throw new AppError(403, 'Only the person who posted this can delete it.');
      if (p.photo && PHOTO_NAME.test(p.photo)) await fsp.unlink(path.join(this.uploadsDir, p.photo)).catch(() => {});
      this.posts = this.posts.filter((x) => x !== p);
      await this.save();
      return { ok: true };
    });
  }

  /** Everything one student has checked in for or posted (live and past), newest first, plus totals. */
  history(clientId) {
    const me = this.requireClient(clientId);
    const checkins = [];
    const posts = [];
    for (const p of this.posts) {
      if (p.ownerId === me) posts.push(this.view(p, me));
      if (p.claims.indexOf(me) !== -1) {
        const v = this.view(p, me);
        v.checkedInAt = (p.claimTimes && p.claimTimes[me]) || p.createdAt;
        checkins.push(v);
      }
    }
    checkins.sort((a, b) => b.checkedInAt - a.checkedInAt);
    posts.sort((a, b) => b.createdAt - a.createdAt);
    return {
      stats: {
        checkins: checkins.length,
        posts: posts.length,
        servingsShared: posts.reduce((n, p) => n + p.servings, 0),
        studentsFed: posts.reduce((n, p) => n + (p.servings - p.servingsLeft), 0),
      },
      checkins: checkins.slice(0, HISTORY_LIMIT),
      posts: posts.slice(0, HISTORY_LIMIT),
    };
  }

  requireClient(clientId) {
    if (!isValidClientId(clientId)) throw new AppError(400, 'Missing or invalid client id.');
    return hashClient(clientId);
  }

  // A day after a post ends, delete its photo. After HISTORY_KEEP_MS, delete the post itself
  // (it stays until then so it can show in account history). Call inside exclusive().
  async prune() {
    const t = this.now();
    const keep = [];
    let changed = false;
    for (const p of this.posts) {
      const endedAt = p.closedAt ? Math.min(p.closedAt, p.expiresAt) : p.expiresAt;
      if (p.photo && endedAt < t - PHOTO_KEEP_MS) {
        if (PHOTO_NAME.test(p.photo)) await fsp.unlink(path.join(this.uploadsDir, p.photo)).catch(() => {});
        p.photo = null;
        changed = true;
      }
      if (endedAt < t - HISTORY_KEEP_MS) changed = true;
      else keep.push(p);
    }
    if (changed) {
      this.posts = keep;
      await this.save();
    }
  }
}

module.exports = { Store, AppError, TAGS, DURATIONS_HOURS, LIMITS, isValidClientId };
