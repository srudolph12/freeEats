# FreeEats: free food on campus

An app to help students find available food around their campus, and to cut down on the food universities waste by connecting the supply with the demand.

Students post leftover food (a photo, how many servings, and where it is). Others browse what's available nearby and **check in** to save a serving. Students sign in with their school (.edu) email and a 6-digit code we email them, and can then set a password so they don't need a code next time. No npm packages; it only needs Node 18 or newer.

## Run it

```
npm start            # http://localhost:3000
npm run dev          # restarts on file changes
npm test
```

### Sending the sign-in emails
Without any setup, sign-in codes are **printed in the terminal** where the server is running, so you can test locally. To actually email them, give the server an SMTP account that supports TLS on port 465 (Gmail, Outlook, SendGrid, Mailgun, etc. all do):

```
SMTP_HOST=smtp.gmail.com SMTP_USER=you@gmail.com SMTP_PASS=your-app-password npm start
```

Or copy `.env.example` to `.env`, fill it in, and run `npm run start:mail` (or `npm run dev:mail`). `.env` is git-ignored.

| Variable | Meaning |
|---|---|
| `SMTP_HOST` | Mail server, e.g. `smtp.gmail.com` |
| `SMTP_PORT` | Default `465` (TLS). STARTTLS on 587 is not supported. |
| `SMTP_USER` / `SMTP_PASS` | Login. For Gmail, use an [app password](https://myaccount.google.com/apppasswords), not your normal password. |
| `MAIL_FROM` | Sender address (defaults to `SMTP_USER`) |
| `GEOCODE_URL` | Optional. A Nominatim-compatible address lookup server (default: OpenStreetMap's public one) |
| `COOKIE_SECURE=1` | Mark the session cookie Secure (set this when serving over HTTPS) |

To try it from your phone on the same wifi, run `HOST=0.0.0.0 npm start` and open `http://<your-computer's-IP>:3000`.
Note: browsers only allow location ("Use my location", "My location" pin) on `localhost` or HTTPS, so on a plain `http://` network address those buttons won't work. Everything else will.

## Demo data

To show the app off, fill it with made-up posts around USC:

```bash
# stop the server first (Ctrl+C), then:
npm run demo -- --me you@usc.edu   # 12 live posts, plus a check-in history for your account
npm run dev:mail                   # start it again
```

- The posts come from fake students (`name@demo.edu`). Nobody is emailed, and they can not sign in.
- Some servings are already claimed, so you get a mix of full, half-gone and almost-gone pins.
- `--me` is optional. It gives your account two past check-ins and one past post, so the Account page has something to show, but no live check-ins, so you start with your full 2. It also signs that account out on every device, so the app opens at the sign-in screen (sign in again with your password or an emailed code). The fake check-in script's sign-in is kept. It also makes you friends with maya, omar, grace and diego (`@demo.edu`), adds 3 **friends-only** posts from them (banana bread, biryani, birthday cake; add `banana-bread`, `biryani` and `cake` photos to `scripts/demo-photos/` if you like), and leaves a friend request from priya for you to accept.
- Posts end within 2 hours like real ones, so run it shortly before you present. Running it again replaces the old demo posts.
- `npm run demo -- --clear` removes every demo post and demo friendship. Real posts and friends are never touched.
- Photos come from `scripts/demo-photos/`, named after each post (`pizza.jpg`, `boba.png`, `cookies.webp`, ...; see `photo:` in `scripts/demo.js`). Posts without one show a plate placeholder. JPEG, PNG or WebP, under 3 MB.
- For another campus, edit `PLACES` in `scripts/demo.js`.

To test the check-in pop-up, have a fake student check in to your own post:

```bash
npm run fake-checkin -- --setup you@usc.edu  # once, with the server stopped
npm run fake-checkin -- you@usc.edu          # server running: one check-in on your newest live post
npm run fake-checkin -- you@usc.edu --count 3 --title pizza
```

It works on public and friends-only posts. For a friends-only post, each fake student briefly becomes your friend, checks in, and unfriends you again, so your friend list ends up unchanged.

## What it does

**Find food**
- Live list of food that's still available, refreshed every 20 seconds
- **Map view**: every post with a pinned location is a pin showing how many servings are left, colored by status (available, almost gone, you're checked in), with a green outline for friends' food, plus a blue dot for you. Click a pin to see the food and check in right there. "Show on map" on any list card jumps to its pin.
- Sort by nearest (after "Use my location"; click it again to turn location off), newest, ending soon, or most servings left
- Filter by dietary tags: vegetarian, vegan, gluten-free, dairy-free, halal, kosher
- **Everyone / Friends** switch: Everyone shows food shared with everyone; friends-only posts are only under Friends, which shows food your friends posted plus friends-only posts (including your own), in the list and on the map. Posts from friends say who shared them; other posts stay anonymous.
- **Check in for a serving**: holds one serving for you. Once per student per post, and at most **2 check-ins at a time** (a check-in stops counting once that food ends). You can cancel to give it back. Change `MAX_ACTIVE_CHECKINS` in `src/store.js` to adjust the limit.
- Fully claimed posts disappear from everyone else's list.
- Your own posts are not listed in Find food; you manage them from your Account page.

**Your account** (the Account tab, or tap your email in the header)
- Your totals: check-ins, food posts, servings shared, and students fed
- Your check-ins and your food posts, split into "Happening now" and "Past", with Cancel / Mark as gone / Show on map for live ones
- Saved dietary preferences: Find food starts with these filters on, on any device
- **Friends**: add a friend by school email. They accept the request on their Account page (or add you back), and then you're friends. You can decline requests, cancel your own, or remove a friend. New requests show as a badge on the Account tab and pop up live.
- Sign out, or sign out on all devices

**Share food**
- Take or choose a photo (resized in the browser to keep uploads small)
- What it is, number of servings (1-200), building, room or spot, optional notes
- Optionally pin it on the map, either at your current GPS location or at a **street address** you type. Addresses are looked up with OpenStreetMap's free Nominatim service (no API key), and you can drag the pin on the preview map to the exact spot. Pinned posts show on the map and work with "nearest" sorting and Directions.
- **Who can see it**: Everyone, or **Friends only**. Friends-only food is hidden from everyone except your friends, and only they can check in. Someone who already checked in keeps their serving even if you unfriend them.
- Choose how long it's available: 30 minutes, 1 hour, 1.5 hours, or 2 hours (the most). The poster can **Mark as gone** at any time.
- **Edit** your own live post (from its card or your Account page): change the text, servings (not below how many have checked in), photo, pin, dietary info, or time (still at most 2 hours from when it was first posted).
- **Check-in alerts**: while the app is open (on any tab), a pop-up appears the moment someone checks in for your food, saying who (their school email) and how many servings are left. The server pushes it over a live connection (`/api/events`), with the 20-second refresh as a backup. After you post, the browser asks whether it may also send system notifications, which show up when FreeEats is in a background tab. You also get an **email**: the first check-in is emailed right away, and any more within 5 minutes are bundled into one follow-up email. The email names who checked in too, and your Account page lists who checked in to each of your posts. Only the poster sees these names, and students are told when they check in. Demo (`@demo.edu`) posters are never emailed.
- **Delete** your own post, live or past, from your Account page. It is removed for good, including from the history of anyone who checked in.

## How it's built

```
src/store.js     posts, photos, check-ins, expiry, persistence
src/auth.js      .edu email sign-in: codes, sessions
src/friends.js   friend requests and friendships
src/mailer.js    sends the code emails over SMTP (or prints them)
src/server.js    web server + JSON API
public/          index.html, app.js, style.css (the whole front end)
public/vendor/   Leaflet 1.9.4 map library (BSD-2) and the DM Sans + Graduate fonts (SIL OFL), copied in so there is still no npm install
test/            node:test suites for the store and the API
data/            created at runtime: posts.json, sessions.json, users.json, friends.json, uploads/ (git-ignored)
```

### API
| Method | Path | What it does |
|---|---|---|
| POST | `/api/auth/request-code` | `{ email }`: emails a 6-digit code (.edu only) |
| POST | `/api/auth/verify` | `{ email, code }`: signs in, sets the session cookie |
| POST | `/api/auth/login` | `{ email, password }`: signs in with a password |
| POST | `/api/auth/password` | `{ password, currentPassword }`: set or change your password (signs out your other devices) |
| GET | `/api/auth/me` | Who is signed in (401 if nobody) |
| POST | `/api/auth/logout` | Signs out |
| POST | `/api/auth/logout-all` | Signs out on every device |
| GET | `/api/account` | Profile, totals, check-in history, your posts |
| PUT | `/api/account/preferences` | `{ diet: [tags] }`: saved dietary preferences |
| GET | `/api/posts` | Live posts (all `/api/posts` routes need a signed-in student) |
| POST | `/api/posts` | Share food: `{ title, servings, building, details, address, description, tags, hours, lat, lng, photo, visibility }`. `visibility` is `everyone` (default) or `friends`. `hours` is 0.5, 1, 1.5, or 2. |
| GET | `/api/geocode?q=address` | Map coordinates for an address (signed in; 15 lookups a minute). Add `&lat=&lng=` to prefer matches near there. |
| PATCH | `/api/posts/:id` | Poster edits a live post (same fields as POST; leave out `hours` to keep the end time, `removePhoto: true` to drop the photo) |
| DELETE | `/api/posts/:id` | Poster deletes a post, live or past |
| POST | `/api/posts/:id/claim` | Check in for one serving |
| DELETE | `/api/posts/:id/claim` | Cancel your check-in |
| POST | `/api/posts/:id/close` | Poster marks the food as gone |
| GET | `/api/friends` | Your friends, incoming requests and sent requests |
| POST | `/api/friends` | `{ email }`: send a friend request, or accept theirs. Returns `result`: `requested`, `friends` or `already` |
| POST | `/api/friends/remove` | `{ email }`: unfriend, decline their request, or cancel yours |
| GET | `/api/events` | Live updates for the signed-in student (Server-Sent Events): `checkin` / `cancel` when someone checks in to or cancels on one of their posts |
| GET | `/uploads/:file` | Photos |

### Design decisions
- **School email sign-in.** Only addresses ending in `.edu` can sign in. We email a 6-digit code that expires in 10 minutes and allows 5 guesses; one code per address per minute and 10 per device per hour. Codes and session tokens are stored only as hashes. Sessions last 30 days in an HttpOnly cookie, and changes sent from other websites are refused. Posts and check-ins are tied to the email, so one student gets one serving per post on any device. 
- **Passwords (optional).** After confirming their email with a code, students can set a password (at least 8 characters) right away or later on the Account page, then sign in with email + password instead. Passwords are stored only as salted scrypt hashes in `data/users.json`. The same "email or password is not right" message is shown whether or not an account exists. 5 wrong tries lock that account's password sign-in for 15 minutes (codes still work), and each device gets 30 wrong tries an hour. Changing a password needs the current one, unless you just signed in with an email code (that's the "forgot password" path), and signs out your other devices.
- Any `.edu` address works; to limit it to one school, change the `EDU_EMAIL` pattern in `src/auth.js`.
- **Check-ins are processed one at a time**, so two people grabbing the last serving at the same moment can't both get it.
- **Photos** are checked by file signature (JPEG, PNG, or WebP only; 3 MB max), saved under random names, and deleted with their post.
- **Cleanup**: posts disappear from Find food when they expire or are marked gone. Their photo is deleted 24 hours later; the rest of the record stays in the poster's and claimers' account history for 180 days, then is deleted.
- **Strict security headers**: the page can only load its own scripts, styles, and images, plus map tiles from OpenStreetMap.
- **Map tiles** come from OpenStreetMap's free tile server, which is fine for a class project or small pilot. For heavy real-world traffic their [usage policy](https://operations.osmfoundation.org/policies/tiles/) asks you to switch to a tile provider (MapTiler, Stadia, etc.); change the URL in `addTiles()` in `public/app.js` and the `img-src` entry in `src/server.js`.

## Ideas for next steps
- Limit sign-in to your own school's domain, and reporting of bad posts
- Push notifications when food is posted near you
- A building picker for your campus instead of free text
