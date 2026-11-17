'use strict';

/**
 * FreeEats - friends.
 *
 * Friendships are mutual: you send a request by school email, and the other student
 * accepts it (or sends one back, which counts as accepting). Only then can each of
 * you see the other's friends-only posts.
 *
 * Saved in data/friends.json as { email: { friends: {email: since}, incoming: {email: at}, outgoing: {email: at} } }.
 * Sending a request never reveals whether that email has an account: it just waits
 * until they sign in.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const { AppError } = require('./store');

const MAX_FRIENDS = 300;
const MAX_OUTGOING = 50; // pending requests you have sent

class Friends {
  constructor(opts) {
    this.file = path.join(opts.dataDir, 'friends.json');
    this.now = opts.now || Date.now;
    this.people = new Map();
    this.queue = Promise.resolve();
  }

  async load() {
    try {
      const saved = JSON.parse(await fsp.readFile(this.file, 'utf8'));
      for (const [email, r] of Object.entries(saved)) {
        if (r && typeof r === 'object') {
          this.people.set(email, { friends: r.friends || {}, incoming: r.incoming || {}, outgoing: r.outgoing || {} });
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('Could not read friends file; setting it aside and starting fresh.');
        await fsp.rename(this.file, this.file + '.corrupt-' + this.now()).catch(() => {});
      }
    }
  }

  async save() {
    const tmp = this.file + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(Object.fromEntries(this.people), null, 2), { mode: 0o600 });
    await fsp.rename(tmp, this.file);
  }

  exclusive(fn) {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  rec(email) {
    let r = this.people.get(email);
    if (!r) this.people.set(email, (r = { friends: {}, incoming: {}, outgoing: {} }));
    return r;
  }

  /** Emails of your friends. */
  friendsOf(email) {
    const r = this.people.get(email);
    return r ? Object.keys(r.friends) : [];
  }

  /** Your friends and pending requests, newest first. */
  list(email) {
    const r = this.people.get(email) || { friends: {}, incoming: {}, outgoing: {} };
    const rows = (obj, key) => Object.entries(obj)
      .map(([e, at]) => ({ email: e, [key]: at }))
      .sort((a, b) => b[key] - a[key]);
    return { friends: rows(r.friends, 'since'), incoming: rows(r.incoming, 'at'), outgoing: rows(r.outgoing, 'at') };
  }

  /** Send a friend request, or accept theirs if they already sent you one. Returns 'friends' | 'requested' | 'already'. */
  add(me, other) {
    return this.exclusive(async () => {
      if (other === me) throw new AppError(400, 'That is your own email.');
      const mine = this.rec(me);
      if (mine.friends[other]) return 'already';
      const t = this.now();
      if (mine.incoming[other]) {
        if (Object.keys(mine.friends).length >= MAX_FRIENDS) throw new AppError(400, 'You can have up to ' + MAX_FRIENDS + ' friends.');
        const theirs = this.rec(other);
        delete mine.incoming[other];
        delete theirs.outgoing[me];
        mine.friends[other] = t;
        theirs.friends[me] = t;
        await this.save();
        return 'friends';
      }
      if (mine.outgoing[other]) return 'requested';
      if (Object.keys(mine.outgoing).length >= MAX_OUTGOING) {
        throw new AppError(400, 'You have ' + MAX_OUTGOING + ' requests waiting. Cancel some before sending more.');
      }
      mine.outgoing[other] = t;
      this.rec(other).incoming[me] = t;
      await this.save();
      return 'requested';
    });
  }

  /** Unfriend, decline their request, or cancel yours: whichever applies. */
  remove(me, other) {
    return this.exclusive(async () => {
      const mine = this.rec(me);
      const theirs = this.rec(other);
      delete mine.friends[other];
      delete theirs.friends[me];
      delete mine.incoming[other];
      delete theirs.outgoing[me];
      delete mine.outgoing[other];
      delete theirs.incoming[me];
      for (const e of [me, other]) {
        const r = this.people.get(e);
        if (r && !Object.keys(r.friends).length && !Object.keys(r.incoming).length && !Object.keys(r.outgoing).length) {
          this.people.delete(e);
        }
      }
      await this.save();
    });
  }
}

module.exports = { Friends, MAX_FRIENDS, MAX_OUTGOING };
