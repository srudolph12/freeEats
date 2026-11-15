'use strict';

/**
 * FreeEats - sign-in with a school email.
 *
 * 1. The student enters an address ending in .edu and we email them a 6-digit code.
 * 2. They type the code back; if it matches we start a session (a random token kept
 *    in an HttpOnly cookie).
 *
 * Codes live in memory only, expire after 10 minutes, allow 5 guesses, and are
 * stored as hashes. Sessions are saved (also hashed) to data/sessions.json so a
 * restart does not sign everyone out.
 *
 * Each student also has a small profile in data/users.json: when they joined and
 * their saved dietary preferences.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { AppError, TAGS } = require('./store');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const CODE_TTL_MS = 10 * MINUTE;
const RESEND_AFTER_MS = MINUTE;
const MAX_ATTEMPTS = 5;
const CODES_PER_IP_PER_HOUR = 10;
const SESSION_TTL_MS = 30 * 24 * HOUR;

// A plain local part (no quotes or spaces) at a domain ending in .edu, e.g. tommy@usc.edu or a@cs.ucla.edu.
const EDU_EMAIL = /^[a-z0-9._%+-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+edu$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function normalizeEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!email) throw new AppError(400, 'Enter your school email address.');
  if (email.length > 254 || !EDU_EMAIL.test(email)) {
    throw new AppError(400, 'Use your school email address (it must end in .edu).');
  }
  return email;
}

class Auth {
  constructor(opts) {
    this.file = path.join(opts.dataDir, 'sessions.json');
    this.usersFile = path.join(opts.dataDir, 'users.json');
    this.users = new Map(); // email -> { createdAt, diet: [] }
    this.now = opts.now || Date.now;
    this.sendMail = opts.sendMail;
    this.codes = new Map(); // email -> { hash, expiresAt, sentAt, attempts }
    this.ipLog = new Map(); // ip -> [timestamps of codes sent]
    this.sessions = new Map(); // sha(token) -> { email, expiresAt }
    this.queue = Promise.resolve();
  }

  async load() {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const saved = JSON.parse(await fsp.readFile(this.file, 'utf8'));
      const t = this.now();
      for (const [key, s] of Object.entries(saved || {})) {
        if (s && typeof s.email === 'string' && s.expiresAt > t) this.sessions.set(key, s);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('Could not read sessions file; everyone will need to sign in again.');
    }
    try {
      const saved = JSON.parse(await fsp.readFile(this.usersFile, 'utf8'));
      for (const [email, u] of Object.entries(saved || {})) {
        if (u && typeof u.createdAt === 'number') {
          this.users.set(email, { createdAt: u.createdAt, diet: Array.isArray(u.diet) ? u.diet.filter((t) => TAGS.includes(t)) : [] });
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('Could not read users file; setting it aside and starting fresh.');
        await fsp.rename(this.usersFile, this.usersFile + '.corrupt-' + this.now()).catch(() => {});
      }
    }
  }

  exclusive(fn) {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async save() {
    const tmp = this.file + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(Object.fromEntries(this.sessions)));
    await fsp.rename(tmp, this.file);
  }

  async saveUsers() {
    const tmp = this.usersFile + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(Object.fromEntries(this.users), null, 2));
    await fsp.rename(tmp, this.usersFile);
  }

  /** Create the profile on first sign-in. Call inside exclusive(). */
  async ensureUserLocked(email) {
    if (this.users.has(email)) return;
    this.users.set(email, { createdAt: this.now(), diet: [] });
    await this.saveUsers();
  }

  ensureUser(email) {
    return this.exclusive(() => this.ensureUserLocked(email));
  }

  profile(email) {
    const u = this.users.get(email) || { createdAt: null, diet: [] };
    return { email, memberSince: u.createdAt, diet: u.diet.slice() };
  }

  setDiet(email, diet) {
    if (!Array.isArray(diet) || diet.some((t) => !TAGS.includes(t))) {
      throw new AppError(400, 'Dietary preferences must be from: ' + TAGS.join(', ') + '.');
    }
    return this.exclusive(async () => {
      await this.ensureUserLocked(email);
      this.users.get(email).diet = TAGS.filter((t) => diet.includes(t));
      await this.saveUsers();
      return this.profile(email);
    });
  }

  /** Sign this student out on every device. */
  logoutAll(email) {
    return this.exclusive(async () => {
      let n = 0;
      for (const [key, s] of this.sessions) {
        if (s.email === email) {
          this.sessions.delete(key);
          n += 1;
        }
      }
      if (n) await this.save();
      return n;
    });
  }

  /** Stable id for a student, used as the owner / claimer id on posts. */
  static userId(email) {
    return 'u-' + sha('crumbs-user:' + email).slice(0, 40);
  }

  sweep() {
    const t = this.now();
    for (const [email, c] of this.codes) if (c.expiresAt <= t) this.codes.delete(email);
    for (const [ip, times] of this.ipLog) {
      const recent = times.filter((x) => t - x < HOUR);
      if (recent.length) this.ipLog.set(ip, recent);
      else this.ipLog.delete(ip);
    }
  }

  async requestCode(rawEmail, ip) {
    const email = normalizeEmail(rawEmail);
    this.sweep();
    const t = this.now();

    const pending = this.codes.get(email);
    if (pending && t - pending.sentAt < RESEND_AFTER_MS) {
      throw new AppError(429, 'We just sent a code to that address. Wait a minute before asking for another.');
    }
    const sent = this.ipLog.get(ip) || [];
    if (sent.length >= CODES_PER_IP_PER_HOUR) {
      throw new AppError(429, 'Too many codes requested from this device. Try again in an hour.');
    }
    sent.push(t);
    this.ipLog.set(ip, sent);

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const entry = { hash: sha(email + ':' + code), expiresAt: t + CODE_TTL_MS, sentAt: t, attempts: 0 };
    this.codes.set(email, entry);

    try {
      await this.sendMail({
        to: email,
        subject: 'Your FreeEats sign-in code: ' + code,
        text:
          'Your FreeEats sign-in code is:\n\n    ' + code + '\n\n' +
          'It expires in 10 minutes. If you did not try to sign in, you can ignore this email.\n',
      });
    } catch (err) {
      if (this.codes.get(email) === entry) this.codes.delete(email);
      console.error('Could not send sign-in email:', err.message);
      throw new AppError(502, 'We could not send the email right now. Try again in a moment.');
    }
    return { email };
  }

  async verifyCode(rawEmail, rawCode) {
    const email = normalizeEmail(rawEmail);
    const code = typeof rawCode === 'string' || typeof rawCode === 'number' ? String(rawCode).replace(/\s+/g, '') : '';
    if (!/^\d{6}$/.test(code)) throw new AppError(400, 'Enter the 6-digit code from your email.');

    const entry = this.codes.get(email);
    if (!entry || entry.expiresAt <= this.now()) {
      this.codes.delete(email);
      throw new AppError(400, 'That code has expired. Request a new one.');
    }
    entry.attempts += 1;
    const ok = crypto.timingSafeEqual(Buffer.from(entry.hash, 'hex'), Buffer.from(sha(email + ':' + code), 'hex'));
    if (!ok) {
      if (entry.attempts >= MAX_ATTEMPTS) {
        this.codes.delete(email);
        throw new AppError(400, 'Too many wrong tries. Request a new code.');
      }
      throw new AppError(400, 'That code is not right. Check your email and try again.');
    }
    this.codes.delete(email);

    const token = crypto.randomBytes(32).toString('base64url');
    return this.exclusive(async () => {
      const t = this.now();
      for (const [key, s] of this.sessions) if (s.expiresAt <= t) this.sessions.delete(key);
      this.sessions.set(sha(token), { email, expiresAt: t + SESSION_TTL_MS });
      await this.save();
      await this.ensureUserLocked(email);
      return { token, email, maxAgeSeconds: SESSION_TTL_MS / 1000 };
    });
  }

  /** The signed-in student for a session token, or null. */
  session(token) {
    if (typeof token !== 'string' || !TOKEN.test(token)) return null;
    const s = this.sessions.get(sha(token));
    if (!s || s.expiresAt <= this.now()) return null;
    return { email: s.email, id: Auth.userId(s.email) };
  }

  logout(token) {
    if (typeof token !== 'string' || !TOKEN.test(token)) return Promise.resolve();
    return this.exclusive(async () => {
      if (this.sessions.delete(sha(token))) await this.save();
    });
  }
}

module.exports = { Auth, normalizeEmail };
