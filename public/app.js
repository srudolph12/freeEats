(function () {
  'use strict';

  var POLL_MS = 20000;
  var PHOTO_MAX_SIDE = 1280;
  var TAG_LABEL = {
    vegetarian: '🥕 Vegetarian',
    vegan: '🌱 Vegan',
    'gluten-free': '🌾 Gluten-free',
    'dairy-free': '🥛 Dairy-free',
    halal: 'Halal',
    kosher: 'Kosher',
  };

  var state = {
    user: null, // { email } once signed in
    authEmail: '',
    config: { tags: Object.keys(TAG_LABEL), durations: [1, 2, 3, 4, 6] },
    posts: [],
    loaded: false,
    clockOffset: 0, // serverTime - local time
    myPos: null, // { lat, lng, accuracy }
    filters: [],
    sort: 'nearest',
    sharePos: null, // { lat, lng } where the new post will be pinned
    pinMode: 'none', // 'none' | 'here' | 'addr'
    addrFound: null, // the address text that sharePos was looked up from
    photoData: null,
    photoUrl: null, // the existing photo, when editing a post
    editing: null, // the post being edited, or null
    editReturn: 'account', // tab to go back to after editing
    view: savedView(), // 'list' or 'map'
    selectedId: null, // post shown beside the map
    seenClaims: null, // { postId: check-ins we have already told the poster about }
  };

  var $ = function (id) { return document.getElementById(id); };

  /* ------------------------------------------------------------ helpers */

  function savedView() {
    try { return localStorage.getItem('freeeats-view') === 'map' ? 'map' : 'list'; } catch (e) { return 'list'; }
  }

  function append(el, kid) {
    if (kid === null || kid === undefined || kid === false) return;
    if (Array.isArray(kid)) { kid.forEach(function (k) { append(el, k); }); return; }
    el.appendChild(typeof kid === 'object' ? kid : document.createTextNode(String(kid)));
  }

  // h('div', { class: 'x', onclick: fn }, children...) - text is always set safely, never as HTML.
  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') el.className = v;
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      });
    }
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }

  // The session is an HttpOnly cookie, which the browser sends with every same-site request.
  function api(method, url, body) {
    var init = { method: method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return fetch(url, init).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          if (res.status === 401 && (url.indexOf('/api/auth/') !== 0 || url === '/api/auth/password') && state.user) signedOut('Your session ended. Sign in again.');
          var err = new Error(data.error || 'Request failed (' + res.status + ')');
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  var toastTimer = null;
  function toast(message, isError) {
    var t = $('toast');
    t.textContent = message;
    t.className = 'toast' + (isError ? ' error' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3500);
  }

  /* ----------------------------------------------- check-in notifications */

  // Pop-ups that stay until closed (or 12 s), so a poster doesn't miss a check-in.
  function notify(title, body, postId) {
    var box = $('notices');
    var card = h('div', { class: 'notice', role: 'status' },
      h('span', { class: 'notice-icon', 'aria-hidden': 'true' }, '🍽️'),
      h('div', { class: 'notice-text' }, h('strong', null, title), h('span', null, body)),
      h('button', { type: 'button', class: 'notice-close', 'aria-label': 'Dismiss' }, '×'));
    function close() { if (card.parentNode) card.parentNode.removeChild(card); }
    card.querySelector('.notice-close').addEventListener('click', close);
    box.appendChild(card);
    while (box.children.length > 3) box.removeChild(box.firstChild);
    setTimeout(close, 12000);
    // Also a system notification when the tab is in the background and the student allowed it.
    if (document.visibilityState !== 'visible' && window.Notification && Notification.permission === 'granted') {
      try {
        var n = new Notification(title, { body: body, icon: '/logo.svg', tag: 'checkin-' + postId });
        n.onclick = function () { window.focus(); n.close(); };
      } catch (e) { /* some browsers only allow notifications from a service worker */ }
    }
  }

  function askNotifyPermission() {
    if (window.Notification && Notification.permission === 'default') {
      try { Notification.requestPermission(); } catch (e) { /* ignore */ }
    }
  }

  // Compare check-ins on your own posts with what we saw last time, and announce new ones.
  function checkNewClaims(posts) {
    var first = !state.seenClaims;
    var seen = state.seenClaims || {};
    var next = {};
    var news = false;
    posts.forEach(function (p) {
      if (!p.mine) return;
      var count = p.servings - p.servingsLeft;
      // On the first load everything is old news. After that, a post we haven't seen yet
      // (say, one posted from another device) counts from zero.
      var before = first ? count : (seen[p.id] === undefined ? 0 : seen[p.id]);
      if (count > before) {
        var added = count - before;
        news = true;
        notify(
          added === 1 ? 'Someone checked in!' : added + ' students checked in!',
          'For your “' + p.title + '”: ' + (p.servingsLeft === 0 ? 'every serving is now claimed.'
            : p.servingsLeft + (p.servingsLeft === 1 ? ' serving' : ' servings') + ' left.'),
          p.id);
      }
      next[p.id] = count; // a cancelled check-in just lowers the baseline
    });
    state.seenClaims = next;
    return news;
  }

  // The server pushes a nudge down this stream the moment someone checks in for (or cancels on)
  // one of your posts; we then reload, and checkNewClaims() shows the pop-up. Polling stays as a backup.
  var events = null;
  function connectEvents() {
    if (events || !window.EventSource) return;
    events = new EventSource('/api/events');
    var refresh = function () { if (state.user) load(); };
    events.addEventListener('checkin', refresh);
    events.addEventListener('cancel', refresh);
  }
  function disconnectEvents() {
    if (events) events.close();
    events = null;
  }

  function now() { return Date.now() + state.clockOffset; }

  function ago(ts) {
    var min = Math.max(0, Math.round((now() - ts) / 60000));
    if (min < 1) return 'just now';
    if (min < 60) return min + ' min ago';
    var hr = Math.floor(min / 60);
    return hr + ' hr ago';
  }

  function endsIn(ts) {
    var min = Math.round((ts - now()) / 60000);
    if (min <= 1) return 'ending now';
    if (min < 60) return 'ends in ' + min + ' min';
    var hr = Math.floor(min / 60);
    var rest = min % 60;
    return 'ends in ' + hr + ' hr' + (rest ? ' ' + rest + ' min' : '');
  }

  // Great-circle distance in meters.
  function distance(a, b) {
    var R = 6371000;
    var rad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * rad;
    var dLng = (b.lng - a.lng) * rad;
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  function formatDistance(m) {
    if (m < 1000) return Math.max(10, Math.round(m / 10) * 10) + ' m away';
    return (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' km away';
  }

  function getPosition() {
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation) return reject(new Error('Your browser cannot share location.'));
      navigator.geolocation.getCurrentPosition(
        function (p) { resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }); },
        function (err) {
          reject(new Error(err.code === 1
            ? 'Location permission was denied. You can allow it in your browser settings.'
            : 'Could not get your location. Try again outside or near a window.'));
        },
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
    });
  }

  /* --------------------------------------------------------------- tabs */

  var TABS = ['find', 'share', 'account'];

  function showTab(name, push) {
    if (!state.user) return;
    if (TABS.indexOf(name) === -1) name = 'find';
    if (name !== 'share' && state.editing) endEdit();
    TABS.forEach(function (t) {
      $('view-' + t).hidden = t !== name;
      $('tab-' + t).setAttribute('aria-pressed', String(t === name));
    });
    if (push) history.replaceState(null, '', '#' + name);
    if (name === 'find') load();
    if (name === 'account') loadAccount();
    window.scrollTo(0, 0);
  }

  /* --------------------------------------------------------------- feed */

  function load() {
    return api('GET', '/api/posts')
      .then(function (data) {
        state.posts = data.posts;
        var fresh = checkNewClaims(data.posts);
        state.clockOffset = data.serverTime - Date.now();
        state.loaded = true;
        if (!$('view-find').hidden) renderFeed();
        else if (fresh && !$('view-account').hidden) loadAccount();
      })
      .catch(function () {
        if (!state.loaded) {
          state.loaded = true;
          renderFeed();
        }
        $('find-hint').textContent = 'Could not reach the server. Showing the last list we had.';
      });
  }

  function visiblePosts() {
    var list = state.posts.filter(function (p) {
      return p.expiresAt > now() && state.filters.every(function (t) { return p.tags.indexOf(t) !== -1; });
    });
    var me = state.myPos;
    list.forEach(function (p) {
      p._dist = me && p.lat !== null ? distance(me, p) : null;
    });
    var by = {
      newest: function (a, b) { return b.createdAt - a.createdAt; },
      ending: function (a, b) { return a.expiresAt - b.expiresAt; },
      servings: function (a, b) { return b.servingsLeft - a.servingsLeft; },
      nearest: function (a, b) {
        if (a._dist === null && b._dist === null) return b.createdAt - a.createdAt;
        if (a._dist === null) return 1;
        if (b._dist === null) return -1;
        return a._dist - b._dist;
      },
    }[state.sort];
    list.sort(function (a, b) {
      // Your own check-ins stay at the top so you can find them again.
      if (a.claimedByMe !== b.claimedByMe) return a.claimedByMe ? -1 : 1;
      return by(a, b);
    });
    return list;
  }

  function renderFeed() {
    var feed = $('feed');
    var list = visiblePosts();
    feed.textContent = '';
    var onMap = state.view === 'map';
    feed.hidden = onMap;
    $('map-layout').hidden = !onMap;
    $('sort-wrap').hidden = onMap;
    if (onMap) {
      $('empty').hidden = true;
      $('find-hint').textContent = state.myPos ? '' : 'Tip: tap "Use my location" to see where you are on the map.';
      renderMap(list);
      return;
    }

    var hint = '';
    if (state.sort === 'nearest' && !state.myPos) hint = 'Tip: tap "Use my location" to see the closest food first.';
    $('find-hint').textContent = hint;

    var empty = state.loaded && list.length === 0;
    $('empty').hidden = !empty;
    if (empty) {
      var filtered = state.filters.length > 0 && state.posts.length > 0;
      $('empty-title').textContent = filtered ? 'Nothing matches those filters.' : 'No free food posted right now.';
      $('empty-text').textContent = filtered
        ? 'Try removing a filter to see everything that is available.'
        : 'Check back soon, or be the hero and share some.';
    }
    if (!state.loaded) {
      for (var i = 0; i < 3; i++) feed.appendChild(h('div', { class: 'card skeleton', 'aria-hidden': 'true' }));
      return;
    }
    list.forEach(function (p) { feed.appendChild(card(p)); });
  }

  function card(p, inMap) {
    var gone = p.servingsLeft <= 0;
    var where = p.building + (p.details ? ' · ' + p.details : '');
    var meta = [p._dist !== null ? formatDistance(p._dist) : null, 'posted ' + ago(p.createdAt), endsIn(p.expiresAt)]
      .filter(Boolean).join(' · ');
    var fill = h('div', { class: 'meter-fill' });
    fill.style.width = Math.round((p.servingsLeft / p.servings) * 100) + '%'; // CSSOM, allowed by the CSP

    var media = p.photoUrl
      ? h('img', { src: p.photoUrl, alt: 'Photo of ' + p.title, loading: 'lazy' })
      : h('div', { class: 'no-photo', 'aria-hidden': 'true' }, '🍽️');

    var badge = gone
      ? h('span', { class: 'badge gone' }, 'All claimed')
      : h('span', { class: 'badge' + (p.servingsLeft <= 3 ? ' low' : '') }, p.servingsLeft + ' left');

    return h('article', { class: 'card' + (gone ? ' is-gone' : '') + (p.claimedByMe ? ' is-claimed' : '') },
      h('div', { class: 'card-media' },
        media,
        badge,
        p.mine ? h('span', { class: 'badge mine' }, 'Your post') : null),
      h('div', { class: 'card-body' },
        h('h3', null, p.title),
        h('p', { class: 'where' }, h('span', { 'aria-hidden': 'true' }, '📍 '), where,
          p.lat !== null
            ? h('a', {
                class: 'dir',
                href: 'https://www.google.com/maps/dir/?api=1&destination=' + p.lat + ',' + p.lng,
                target: '_blank',
                rel: 'noopener noreferrer',
                'aria-label': 'Directions to ' + p.building + ' (opens a map)',
              }, 'Directions ↗')
            : null,
          p.lat !== null && !inMap
            ? h('button', { type: 'button', class: 'linkish', onclick: function () { showOnMap(p.id); } }, 'Show on map')
            : null),
        p.address ? h('p', { class: 'addr' }, p.address) : null,
        h('p', { class: 'meta' }, meta),
        h('div', { class: 'meter', role: 'img', 'aria-label': p.servingsLeft + ' of ' + p.servings + ' servings left' },
          h('div', { class: 'meter-track' }, fill),
          h('span', { class: 'meter-text' }, p.servingsLeft + ' of ' + p.servings + ' servings left')),
        p.tags.length
          ? h('div', { class: 'chips small' }, p.tags.map(function (t) { return h('span', { class: 'chip static' }, TAG_LABEL[t] || t); }))
          : null,
        p.description ? h('p', { class: 'desc' }, p.description) : null,
        actions(p)));
  }

  function actions(p) {
    if (p.mine) {
      var claimed = p.servings - p.servingsLeft;
      return h('div', { class: 'actions' },
        h('p', { class: 'owner-note' }, claimed === 1 ? '1 student checked in' : claimed + ' students checked in'),
        h('button', { type: 'button', class: 'btn quiet', onclick: function () { startEdit(p, 'find'); } }, 'Edit'),
        h('button', { type: 'button', class: 'btn danger', onclick: function (e) { closePost(p, e.currentTarget); } }, 'Mark as gone'));
    }
    if (p.claimedByMe) {
      return h('div', { class: 'actions stack' },
        h('p', { class: 'claimed-note' },
          h('strong', null, "You're checked in!"),
          ' Head to ' + p.building + (p.details ? ', ' + p.details : '') + ' to pick up your serving.'),
        h('div', { class: 'row-actions' },
          h('button', { type: 'button', class: 'btn quiet small', onclick: function (e) { unclaim(p, e.currentTarget); } }, 'Cancel check-in')));
    }
    if (p.servingsLeft <= 0) {
      return h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', disabled: true }, 'All claimed'));
    }
    return h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn primary', onclick: function (e) { claim(p, e.currentTarget); } }, 'Check in for a serving'));
  }

  function replacePost(updated) {
    state.posts = state.posts.map(function (p) { return p.id === updated.id ? updated : p; });
    renderFeed();
  }

  function busy(btn, label) {
    btn.disabled = true;
    btn.textContent = label;
  }

  function claim(p, btn) {
    busy(btn, 'Checking in…');
    api('POST', '/api/posts/' + p.id + '/claim')
      .then(function (data) {
        replacePost(data.post);
        toast('Checked in! One serving is saved for you.');
      })
      .catch(function (e) { toast(e.message, true); load(); });
  }

  function unclaim(p, btn) {
    busy(btn, 'Cancelling…');
    api('DELETE', '/api/posts/' + p.id + '/claim')
      .then(function (data) {
        replacePost(data.post);
        toast('Check-in cancelled. Your serving went back to the pool.');
      })
      .catch(function (e) { toast(e.message, true); load(); });
  }

  function closePost(p, btn) {
    if (!window.confirm('Mark "' + p.title + '" as gone? It will disappear from the list.')) return;
    busy(btn, 'Updating…');
    api('POST', '/api/posts/' + p.id + '/close')
      .then(function () {
        state.posts = state.posts.filter(function (x) { return x.id !== p.id; });
        renderFeed();
        toast('Marked as gone. Thanks for sharing!');
      })
      .catch(function (e) { toast(e.message, true); load(); });
  }

  function locate() {
    var label = $('locate-label');
    label.textContent = 'Finding you…';
    getPosition()
      .then(function (pos) {
        state.myPos = pos;
        state.sort = 'nearest';
        $('sort').value = 'nearest';
        label.textContent = 'Location on';
        $('locate-btn').classList.add('on');
        renderFeed();
        if (map && state.view === 'map') map.setView([pos.lat, pos.lng], Math.max(map.getZoom(), 16));
      })
      .catch(function (e) {
        label.textContent = 'Use my location';
        toast(e.message, true);
      });
  }

  /* ----------------------------------------------------------- dropdown */

  // A button that opens a checklist of dietary tags. Calls onChange(selectedTags) on every change.
  function tagDropdown(box, opts) {
    var selected = (opts.selected || []).slice();
    var menuId = box.id + '-menu';
    var labelEl = h('span', { class: 'dd-label' });
    var btn = h('button', {
      type: 'button', class: 'btn dd-btn', 'aria-expanded': 'false', 'aria-controls': menuId,
      'aria-labelledby': opts.labelledBy ? opts.labelledBy + ' ' + box.id + '-btn' : null, id: box.id + '-btn',
    }, h('span', { 'aria-hidden': 'true' }, '🥗'), labelEl, h('span', { class: 'caret', 'aria-hidden': 'true' }, '▾'));
    var items = state.config.tags.map(function (t) {
      var input = h('input', { type: 'checkbox', value: t, name: opts.name || null, checked: selected.indexOf(t) !== -1 });
      input.addEventListener('change', function () {
        selected = state.config.tags.filter(function (x) {
          return menu.querySelector('input[value="' + x + '"]').checked;
        });
        update();
        opts.onChange(selected.slice());
      });
      return h('label', { class: 'dd-item' }, input, h('span', null, TAG_LABEL[t] || t));
    });
    var clearBtn = h('button', { type: 'button', class: 'btn quiet small' }, 'Clear');
    var doneBtn = h('button', { type: 'button', class: 'btn quiet small' }, 'Done');
    var menu = h('div', { class: 'dd-menu', id: menuId, role: 'group', 'aria-label': opts.title, hidden: true },
      items, h('div', { class: 'dd-foot' }, clearBtn, doneBtn));

    function update() {
      var n = selected.length;
      labelEl.textContent = n === 0 ? opts.placeholder
        : (TAG_LABEL[selected[0]] || selected[0]).replace(/^\S+\s/, '') + (n > 1 ? ' + ' + (n - 1) + ' more' : '');
      btn.classList.toggle('has-value', n > 0);
    }
    function open(yes) {
      menu.hidden = !yes;
      btn.setAttribute('aria-expanded', String(yes));
      if (yes) {
        var first = menu.querySelector('input');
        if (first) first.focus();
      }
    }
    btn.addEventListener('click', function () { open(menu.hidden); });
    doneBtn.addEventListener('click', function () { open(false); btn.focus(); });
    clearBtn.addEventListener('click', function () {
      Array.prototype.forEach.call(menu.querySelectorAll('input'), function (i) { i.checked = false; });
      selected = [];
      update();
      opts.onChange([]);
    });
    menu.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { open(false); btn.focus(); }
    });
    // Close when clicking elsewhere. Replace any listener left by an earlier render of this box.
    if (box._ddOutside) document.removeEventListener('click', box._ddOutside);
    box._ddOutside = function (e) {
      if (!menu.hidden && !box.contains(e.target)) open(false);
    };
    document.addEventListener('click', box._ddOutside);
    box.addEventListener('focusout', function (e) {
      if (e.relatedTarget && !box.contains(e.relatedTarget)) open(false);
    });

    box.textContent = '';
    box.appendChild(btn);
    box.appendChild(menu);
    update();
  }

  function renderFilters() {
    tagDropdown($('filters'), {
      title: 'Dietary preferences',
      placeholder: 'Any diet',
      selected: state.filters,
      onChange: function (tags) {
        state.filters = tags;
        renderFeed();
      },
    });
  }

  /* ---------------------------------------------------------------- map */

  var map = null;
  var tiles = null;
  var markers = {}; // post id -> Leaflet marker
  var meLayer = null;
  var mapFitted = false;

  function setView(view) {
    state.view = view;
    try { localStorage.setItem('freeeats-view', view); } catch (e) { /* fine */ }
    $('view-list').setAttribute('aria-pressed', String(view === 'list'));
    $('view-map').setAttribute('aria-pressed', String(view === 'map'));
    renderFeed();
    if (map && view === 'map') map.invalidateSize(); // the map was hidden, so Leaflet needs to re-measure it
  }

  function showOnMap(id) {
    state.selectedId = id;
    setView('map');
    var p = state.posts.filter(function (x) { return x.id === id; })[0];
    if (map && p && p.lat !== null) map.setView([p.lat, p.lng], Math.max(map.getZoom(), 17));
    window.scrollTo(0, 0);
  }

  // OpenStreetMap's free tiles. Their usage policy asks for attribution and a Referer,
  // so tile requests send our origin even though the page itself sends no referrer.
  // Dark mode darkens the tiles with a CSS filter (see .leaflet-tile-pane in style.css).
  function addTiles() {
    tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      referrerPolicy: 'strict-origin-when-cross-origin',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    }).addTo(map);
  }

  function ensureMap() {
    if (map) return true;
    if (!window.L) return false;
    map = L.map('map', { zoomControl: true, worldCopyJump: true }).setView([20, 0], 2);
    map.attributionControl.setPrefix(false);
    addTiles();
    map.on('click', function () { selectPost(null); });
    return true;
  }

  function pinClass(p) {
    if (p.mine) return 'mine';
    if (p.claimedByMe) return 'claimed';
    if (p.servingsLeft <= 0) return 'gone';
    if (p.servingsLeft <= 3) return 'low';
    return 'available';
  }

  function pinIcon(p, selected) {
    return L.divIcon({
      className: 'pin ' + pinClass(p) + (selected ? ' selected' : ''),
      html: '<span class="pin-body"><span class="pin-label">' + Number(p.servingsLeft) + '</span></span>',
      iconSize: [34, 42],
      iconAnchor: [17, 41],
    });
  }

  function selectPost(id) {
    state.selectedId = id;
    renderFeed();
    if (id && window.matchMedia && window.matchMedia('(max-width: 899px)').matches) {
      $('map-side').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  function renderMap(list) {
    var side = $('map-side');
    if (!ensureMap()) {
      $('map-overlay').hidden = false;
      $('map-overlay').textContent = 'The map could not load. Use the list view instead.';
      side.textContent = '';
      return;
    }
    map.invalidateSize(false); // cheap no-op unless the map's box changed (e.g. it was hidden)
    var pinned = list.filter(function (p) { return p.lat !== null && p.lng !== null; });
    var seen = {};
    pinned.forEach(function (p) {
      seen[p.id] = true;
      var selected = p.id === state.selectedId;
      var key = pinClass(p) + ':' + p.servingsLeft + ':' + selected + ':' + p.lat + ',' + p.lng;
      var m = markers[p.id];
      var label = p.title + ', ' + p.servingsLeft + ' of ' + p.servings + ' servings left, ' + p.building;
      if (!m) {
        m = L.marker([p.lat, p.lng], { icon: pinIcon(p, selected), title: label, alt: label, riseOnHover: true, keyboard: true });
        m.on('click', function (e) {
          L.DomEvent.stopPropagation(e);
          selectPost(p.id);
        });
        m.addTo(map);
        markers[p.id] = m;
      } else if (m._freeeatsKey !== key) {
        m.setLatLng([p.lat, p.lng]);
        m.setIcon(pinIcon(p, selected));
      }
      m._freeeatsKey = key;
      m.setZIndexOffset(selected ? 1000 : 0);
    });
    Object.keys(markers).forEach(function (id) {
      if (!seen[id]) {
        map.removeLayer(markers[id]);
        delete markers[id];
      }
    });

    if (meLayer) map.removeLayer(meLayer);
    meLayer = null;
    if (state.myPos) {
      var ll = [state.myPos.lat, state.myPos.lng];
      meLayer = L.layerGroup([
        L.circle(ll, { radius: Math.min(state.myPos.accuracy || 0, 300), color: '#1c7ed6', weight: 1, fillOpacity: 0.12, interactive: false }),
        L.circleMarker(ll, { radius: 8, color: '#fff', weight: 3, fillColor: '#1c7ed6', fillOpacity: 1, interactive: false }),
      ]).addTo(map);
    }

    if (!mapFitted && state.loaded && (pinned.length || state.myPos)) {
      fitPins(pinned);
      mapFitted = true;
    }

    var overlay = $('map-overlay');
    overlay.hidden = pinned.length > 0 || !state.loaded;
    overlay.textContent = list.length
      ? 'None of this food has a pinned location yet. Switch to the list to see it.'
      : state.filters.length && state.posts.length ? 'Nothing matches those filters.' : 'No free food posted right now.';

    var unpinned = list.length - pinned.length;
    $('map-note').textContent = pinned.length && unpinned
      ? unpinned + (unpinned === 1 ? ' post has' : ' posts have') + ' no pinned location, so ' + (unpinned === 1 ? 'it is' : 'they are') + ' only in the list.'
      : '';
    $('map-fit').hidden = pinned.length === 0;

    var selected = pinned.filter(function (p) { return p.id === state.selectedId; })[0];
    if (!selected) state.selectedId = null;
    side.textContent = '';
    if (selected) {
      var c = card(selected, true);
      c.insertBefore(h('button', {
        type: 'button', class: 'btn quiet small side-close', 'aria-label': 'Close', onclick: function () { selectPost(null); },
      }, '✕ Close'), c.firstChild);
      side.appendChild(c);
    } else {
      side.appendChild(h('div', { class: 'panel side-empty' },
        h('div', { class: 'empty-icon', 'aria-hidden': 'true' }, '📍'),
        h('p', null, h('strong', null, pinned.length ? 'Tap a pin to see the food.' : 'Pins show up here when food is shared with a location.')),
        h('p', { class: 'muted' }, 'The number on each pin is how many servings are left.')));
    }
  }

  function fitPins(pinned) {
    var pts = pinned.map(function (p) { return [p.lat, p.lng]; });
    if (state.myPos) pts.push([state.myPos.lat, state.myPos.lng]);
    if (!pts.length) return;
    if (pts.length === 1) map.setView(pts[0], 17);
    else map.fitBounds(pts, { padding: [48, 48], maxZoom: 17 });
  }

  /* -------------------------------------------------------------- share */

  // Shrink photos in the browser so uploads stay fast on campus wifi.
  function processPhoto(file) {
    return new Promise(function (resolve, reject) {
      if (!file.type || file.type.indexOf('image/') !== 0) return reject(new Error('Please choose an image file.'));
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(img.naturalWidth * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        var data = canvas.toDataURL('image/jpeg', 0.82);
        if (data.length > 3.5 * 1024 * 1024) data = canvas.toDataURL('image/jpeg', 0.6);
        resolve(data);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('That photo could not be read. Try a JPEG or PNG.'));
      };
      img.src = url;
    });
  }

  // data: a newly chosen photo (data URL) to upload. url: the photo a post already has (when editing).
  function setPhoto(data, url) {
    state.photoData = data;
    state.photoUrl = data ? null : url || null;
    var src = data || url;
    $('photo-preview').hidden = !src;
    $('photo-empty').hidden = !!src;
    $('photo-clear').hidden = !src;
    $('photo-drop').classList.toggle('has-photo', !!src);
    if (src) $('photo-preview').src = src;
    else $('photo-preview').removeAttribute('src');
  }

  function onPhotoChosen() {
    var file = $('photo').files[0];
    if (!file) return;
    $('photo-empty').querySelector('strong').textContent = 'Processing photo…';
    processPhoto(file)
      .then(setPhoto)
      .catch(function (e) { toast(e.message, true); setPhoto(null); })
      .then(function () { $('photo-empty').querySelector('strong').textContent = 'Add a photo'; });
  }

  function stepServings(delta) {
    var input = $('servings');
    var n = parseInt(input.value, 10) || 0;
    input.value = Math.min(200, Math.max(1, n + delta));
  }

  /* Where the food is pinned: nowhere, the poster's current location, or a typed address. */

  var shareMap = null;
  var shareMarker = null;

  // preset (when editing): keep the post's current pin instead of asking for GPS or a lookup.
  function setPinMode(mode, preset) {
    state.pinMode = mode;
    state.sharePos = null;
    state.addrFound = null;
    ['none', 'here', 'addr'].forEach(function (m) { $('pin-' + m).setAttribute('aria-pressed', String(m === mode)); });
    $('addr-row').hidden = mode !== 'addr';
    showSharePin(null);
    var hint = $('loc-hint');
    hint.className = 'hint';
    if (preset) {
      if (mode === 'addr') state.addrFound = preset.address;
      showSharePin(preset);
      hint.textContent = mode === 'addr' ? 'Pinned at this address.' : 'Keeping the current pin. Tap "No pin", then "My location", to re-pin where you are now.';
    } else if (mode === 'none') {
      hint.textContent = 'Pinned posts show up on the map so people nearby can find them.';
    } else if (mode === 'addr') {
      hint.textContent = 'Type the address, then tap "Find on map".';
      $('address').focus();
    } else {
      hint.textContent = 'Getting your location…';
      getPosition()
        .then(function (pos) {
          if (state.pinMode !== 'here') return;
          hint.textContent = 'Pinned at your location (accurate to about ' + Math.round(pos.accuracy) + ' m).';
          showSharePin(pos);
        })
        .catch(function (e) {
          if (state.pinMode !== 'here') return;
          setPinMode('none');
          locHint(e.message, true);
        });
    }
  }

  function locHint(message, isError) {
    var hint = $('loc-hint');
    hint.textContent = message;
    hint.className = 'hint' + (isError ? ' error' : '');
  }

  // Resolves once the typed address is on the map; rejects with a message to show if not.
  function findAddress() {
    var q = $('address').value.replace(/\s+/g, ' ').trim();
    if (q.length < 3) return Promise.reject(new Error('Type the street address first.'));
    if (state.addrFound === q && state.sharePos) return Promise.resolve();
    var btn = $('addr-find');
    btn.disabled = true;
    locHint('Looking up the address…');
    var url = '/api/geocode?q=' + encodeURIComponent(q);
    if (state.myPos) url += '&lat=' + state.myPos.lat + '&lng=' + state.myPos.lng; // prefer matches near you
    return api('GET', url)
      .then(function (data) {
        if (state.pinMode !== 'addr' || $('address').value.replace(/\s+/g, ' ').trim() !== q) throw new Error('');
        state.addrFound = q;
        locHint('Found: ' + data.result.label);
        showSharePin({ lat: data.result.lat, lng: data.result.lng });
      })
      .catch(function (err) {
        if (err.message) locHint(err.message, true);
        throw err;
      })
      .then(function () { btn.disabled = false; }, function (err) { btn.disabled = false; throw err; });
  }

  function onAddressEdited() {
    if (state.addrFound === null) return;
    state.addrFound = null;
    showSharePin(null);
    locHint('Address changed. Tap "Find on map" again.');
  }

  // A small map under the form showing the pin; it can be dragged to fix the exact spot.
  function showSharePin(pos) {
    state.sharePos = pos ? { lat: pos.lat, lng: pos.lng } : null;
    $('pin-preview').hidden = !pos;
    if (!pos || !window.L) return;
    var ll = [pos.lat, pos.lng];
    if (!shareMap) {
      shareMap = L.map('share-map', { zoomControl: true, scrollWheelZoom: false, attributionControl: true });
      shareMap.attributionControl.setPrefix(false);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        referrerPolicy: 'strict-origin-when-cross-origin',
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
      }).addTo(shareMap);
      shareMarker = L.marker(ll, {
        draggable: true,
        keyboard: true,
        title: 'Your food (drag to move)',
        alt: 'Your food (drag to move)',
        icon: L.divIcon({ className: 'pin available', html: '<span class="pin-body"><span class="pin-label">🍕</span></span>', iconSize: [34, 42], iconAnchor: [17, 41] }),
      }).addTo(shareMap);
      shareMarker.on('dragend', function () {
        var p = shareMarker.getLatLng();
        state.sharePos = { lat: p.lat, lng: p.lng };
        locHint('Pin moved. It will show up right there on the map.');
      });
    }
    shareMarker.setLatLng(ll);
    shareMap.invalidateSize(false);
    shareMap.setView(ll, 17);
  }

  function renderShareOptions() {
    tagDropdown($('share-tags'), {
      title: 'Dietary info',
      placeholder: 'None selected',
      labelledBy: 'share-tags-label',
      name: 'tag',
      onChange: function () {},
    });
    var hours = $('hours');
    hours.textContent = '';
    var p = state.editing;
    if (p) {
      // When editing, times count from when the food was first posted.
      hours.appendChild(h('option', { value: '', selected: true }, 'Keep the current time (until ' + clock(p.expiresAt) + ')'));
    }
    state.config.durations.forEach(function (n) {
      var label = n < 1 ? n * 60 + ' minutes' : n === 1 ? '1 hour' : n + ' hours';
      if (!p) return hours.appendChild(h('option', { value: String(n), selected: n === 2 }, label));
      var end = p.createdAt + n * 3600000;
      if (end <= now()) return;
      hours.appendChild(h('option', { value: String(n) }, label + ' after posting (until ' + clock(end) + ')'));
    });
  }

  var clockFmt = window.Intl ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }) : null;
  function clock(ts) {
    return clockFmt ? clockFmt.format(new Date(ts)) : new Date(ts).toLocaleTimeString();
  }

  /* ------------------------------------------------- editing your own post */

  var SHARE_TEXT = null;

  function resetShareForm() {
    $('share-form').reset();
    setPhoto(null);
    setPinMode('none');
    formStatus('');
    renderShareOptions();
  }

  function startEdit(p, from) {
    if (!SHARE_TEXT) SHARE_TEXT = { title: $('share-title').textContent, lead: $('share-lead').textContent };
    state.editing = p;
    state.editReturn = from || 'account';
    showTab('share', true);
    resetShareForm(); // also builds the edit-mode time options
    $('share-title').textContent = 'Edit your post';
    $('share-lead').textContent = 'Changes show up for everyone right away. Students who already checked in keep their serving.';
    $('submit-btn').textContent = 'Save changes';
    $('edit-actions').hidden = false;
    $('title').value = p.title;
    $('servings').value = p.servings;
    $('building').value = p.building;
    $('details').value = p.details || '';
    $('description').value = p.description || '';
    $('address').value = p.address || '';
    setPhoto(null, p.photoUrl);
    tagDropdown($('share-tags'), {
      title: 'Dietary info', placeholder: 'None selected', labelledBy: 'share-tags-label', name: 'tag',
      selected: p.tags, onChange: function () {},
    });
    if (p.lat !== null && p.address) setPinMode('addr', { lat: p.lat, lng: p.lng, address: p.address });
    else if (p.lat !== null) setPinMode('here', { lat: p.lat, lng: p.lng });
    else setPinMode('none');
    var claimed = p.servings - p.servingsLeft;
    $('servings-hint').textContent = claimed ? claimed + (claimed === 1 ? ' student has' : ' students have') + ' checked in, so servings can not go below ' + claimed + '.' : '';
  }

  // Leave edit mode and put the Share food form back to normal.
  function endEdit() {
    if (!state.editing) return;
    state.editing = null;
    $('share-title').textContent = SHARE_TEXT.title;
    $('share-lead').textContent = SHARE_TEXT.lead;
    $('submit-btn').textContent = 'Post free food';
    $('edit-actions').hidden = true;
    $('servings-hint').textContent = '';
    resetShareForm();
  }

  function deletePost(p, btn, after) {
    var claimed = p.servings - p.servingsLeft;
    var live = p.status !== 'ended';
    var msg = 'Delete "' + p.title + '" for good?' +
      (live ? ' It will disappear from the list and the map.' : ' It will be removed from your history.') +
      (claimed ? ' It will also leave the history of the ' + (claimed === 1 ? 'student' : claimed + ' students') + ' who checked in.' : '') +
      ' This can not be undone.';
    if (!window.confirm(msg)) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }
    api('DELETE', '/api/posts/' + p.id)
      .then(function () {
        state.posts = state.posts.filter(function (x) { return x.id !== p.id; });
        toast('Post deleted.');
        if (after) after();
      })
      .catch(function (e) {
        toast(e.message, true);
        if (btn) { btn.disabled = false; btn.textContent = 'Delete'; }
      });
  }

  function formStatus(message, isError) {
    var s = $('form-status');
    s.textContent = message || '';
    s.className = 'status' + (isError ? ' error' : '');
  }

  function submitPost(e) {
    e.preventDefault();
    var title = $('title').value.trim();
    var building = $('building').value.trim();
    var servings = parseInt($('servings').value, 10);
    if (!title) { formStatus('Say what the food is.', true); $('title').focus(); return; }
    if (!(servings >= 1 && servings <= 200)) { formStatus('Servings must be from 1 to 200.', true); $('servings').focus(); return; }
    if (!building) { formStatus('Add the building so people can find it.', true); $('building').focus(); return; }
    if (state.pinMode === 'here' && !state.sharePos) { formStatus('Still getting your location. Try again in a second.', true); return; }
    if (state.pinMode === 'addr' && !(state.sharePos && state.addrFound)) {
      // Look the address up first, then post.
      findAddress().then(function () { submitPost(e); }, function (err) {
        formStatus(err.message || 'Find the address on the map first.', true);
        $('address').focus();
      });
      return;
    }

    var editing = state.editing;
    var body = {
      title: title,
      servings: servings,
      building: building,
      details: $('details').value.trim(),
      address: state.pinMode === 'addr' ? state.addrFound : '',
      description: $('description').value.trim(),
      hours: $('hours').value === '' ? undefined : Number($('hours').value),
      tags: Array.prototype.map.call(document.querySelectorAll('#share-tags input:checked'), function (i) { return i.value; }),
      photo: state.photoData || undefined,
    };
    if (editing && editing.photoUrl && !state.photoData && !state.photoUrl) body.removePhoto = true;
    if (state.sharePos) {
      body.lat = state.sharePos.lat;
      body.lng = state.sharePos.lng;
    }

    var btn = $('submit-btn');
    btn.disabled = true;
    btn.textContent = editing ? 'Saving…' : 'Posting…';
    formStatus('');
    if (editing) {
      api('PATCH', '/api/posts/' + editing.id, body)
        .then(function () {
          var back = state.editReturn;
          endEdit();
          toast('Changes saved.');
          showTab(back, true);
        })
        .catch(function (err) { formStatus(err.message, true); })
        .then(function () { btn.disabled = false; btn.textContent = state.editing ? 'Save changes' : 'Post free food'; });
      return;
    }
    api('POST', '/api/posts', body)
      .then(function (data) {
        if (state.seenClaims && data.post) state.seenClaims[data.post.id] = 0;
        askNotifyPermission(); // so we can tell you when someone checks in
        resetShareForm();
        toast('Posted! Thanks for sharing. 🎉');
        state.sort = 'newest';
        $('sort').value = 'newest';
        showTab('find', true);
      })
      .catch(function (err) { formStatus(err.message, true); })
      .then(function () {
        btn.disabled = false;
        btn.textContent = 'Post free food';
      });
  }

  /* ------------------------------------------------------------ account */

  var dateFmt = window.Intl ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
  var monthFmt = window.Intl ? new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }) : null;

  function when(ts) {
    var d = new Date(ts);
    var today = new Date(now());
    var yesterday = new Date(now() - 86400000);
    var time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    if (d.toDateString() === today.toDateString()) return 'today, ' + time;
    if (d.toDateString() === yesterday.toDateString()) return 'yesterday, ' + time;
    return dateFmt ? dateFmt.format(d) : d.toLocaleString();
  }

  function loadAccount() {
    return api('GET', '/api/account')
      .then(function (data) {
        state.clockOffset = data.serverTime - Date.now();
        state.user = data.user;
        renderAccount(data);
      })
      .catch(function (e) { if (e.status !== 401) toast(e.message, true); });
  }

  function stat(n, label) {
    return h('div', { class: 'stat' }, h('span', { class: 'stat-num' }, String(n)), h('span', { class: 'stat-label' }, label));
  }

  function renderAccount(data) {
    var email = data.user.email;
    $('avatar').textContent = email.charAt(0).toUpperCase();
    $('profile-email').textContent = email;
    $('profile-since').textContent = data.user.memberSince && monthFmt
      ? 'Member since ' + monthFmt.format(new Date(data.user.memberSince)) : '';
    renderPasswordSection(data.user);

    var st = $('stats');
    st.textContent = '';
    st.appendChild(stat(data.stats.checkins, data.stats.checkins === 1 ? 'Check-in' : 'Check-ins'));
    st.appendChild(stat(data.stats.posts, data.stats.posts === 1 ? 'Food post' : 'Food posts'));
    st.appendChild(stat(data.stats.servingsShared, 'Servings shared'));
    st.appendChild(stat(data.stats.studentsFed, data.stats.studentsFed === 1 ? 'Student fed' : 'Students fed'));

    renderHistory($('checkins-list'), data.checkins, 'checkin');
    renderHistory($('myposts-list'), data.posts, 'post');

    tagDropdown($('pref-diet'), {
      title: 'Dietary preferences',
      placeholder: 'No preferences',
      labelledBy: 'pref-diet-label',
      selected: data.user.diet,
      onChange: savePrefs,
    });
  }

  var prefsTimer = null;
  function savePrefs(diet) {
    clearTimeout(prefsTimer);
    prefsTimer = setTimeout(function () {
      api('PUT', '/api/account/preferences', { diet: diet })
        .then(function (data) {
          state.user = data.user;
          state.filters = data.user.diet.slice();
          renderFilters();
          toast('Preferences saved.');
        })
        .catch(function (e) { toast(e.message, true); });
    }, 500);
  }

  function isLive(p) {
    return p.status !== 'ended' && p.expiresAt > now();
  }

  function renderHistory(box, items, kind) {
    box.textContent = '';
    if (!items.length) {
      box.appendChild(h('div', { class: 'hist-empty' },
        h('p', null, kind === 'checkin'
          ? "You haven't checked in for any food yet. When you do, it shows up here."
          : "You haven't shared any food yet. Leftovers from a meeting or event? Post them!"),
        h('button', {
          type: 'button', class: 'btn primary small',
          onclick: function () { showTab(kind === 'checkin' ? 'find' : 'share', true); },
        }, kind === 'checkin' ? 'Find food' : 'Share food')));
      return;
    }
    var live = items.filter(isLive);
    var past = items.filter(function (p) { return !isLive(p); });
    if (live.length) {
      box.appendChild(h('p', { class: 'hist-group' }, 'Happening now'));
      live.forEach(function (p) { box.appendChild(historyRow(p, kind, true)); });
    }
    if (past.length) {
      box.appendChild(h('p', { class: 'hist-group' }, 'Past'));
      past.forEach(function (p) { box.appendChild(historyRow(p, kind, false)); });
    }
  }

  function historyRow(p, kind, live) {
    var claimed = p.servings - p.servingsLeft;
    var chip = !live ? h('span', { class: 'status-chip' }, p.closedAt ? 'Marked gone' : 'Ended')
      : kind === 'post' && p.servingsLeft <= 0 ? h('span', { class: 'status-chip full' }, 'All claimed')
      : h('span', { class: 'status-chip live' }, kind === 'checkin' ? 'Ready for pickup' : 'Live');
    var meta2 = kind === 'checkin'
      ? 'Checked in ' + when(p.checkedInAt) + (live ? ' · ' + endsIn(p.expiresAt) : '')
      : 'Posted ' + when(p.createdAt) + ' · ' + claimed + ' of ' + p.servings + ' servings claimed';

    var actions = [];
    if (live && p.lat !== null) {
      actions.push(h('button', { type: 'button', class: 'linkish', onclick: function () { showTab('find', true); showOnMap(p.id); } }, 'Show on map'));
    }
    if (live && kind === 'checkin') {
      actions.push(h('button', { type: 'button', class: 'linkish danger', onclick: function (e) {
        accountAction(e.currentTarget, 'Cancelling…', 'DELETE', '/api/posts/' + p.id + '/claim', 'Check-in cancelled. Your serving went back to the pool.');
      } }, 'Cancel check-in'));
    }
    if (live && kind === 'post') {
      actions.push(h('button', { type: 'button', class: 'linkish', onclick: function () { startEdit(p, 'account'); } }, 'Edit'));
      actions.push(h('button', { type: 'button', class: 'linkish danger', onclick: function (e) {
        if (!window.confirm('Mark "' + p.title + '" as gone? It will disappear from the list.')) return;
        accountAction(e.currentTarget, 'Updating…', 'POST', '/api/posts/' + p.id + '/close', 'Marked as gone. Thanks for sharing!');
      } }, 'Mark as gone'));
    }
    if (kind === 'post') {
      actions.push(h('button', { type: 'button', class: 'linkish danger', onclick: function (e) {
        deletePost(p, e.currentTarget, loadAccount);
      } }, 'Delete'));
    }

    return h('article', { class: 'hist-row' },
      p.photoUrl
        ? h('img', { class: 'hist-thumb', src: p.photoUrl, alt: '', loading: 'lazy' })
        : h('div', { class: 'hist-thumb', 'aria-hidden': 'true' }, '🍽️'),
      h('div', { class: 'hist-main' },
        h('p', { class: 'hist-title' }, h('span', null, p.title), chip),
        h('p', { class: 'hist-meta' }, p.building + (p.details ? ' · ' + p.details : '')),
        h('p', { class: 'hist-meta' }, meta2)),
      actions.length ? h('div', { class: 'hist-actions' }, actions) : null);
  }

  function accountAction(btn, label, method, url, message) {
    btn.disabled = true;
    btn.textContent = label;
    api(method, url)
      .then(function () { toast(message); })
      .catch(function (e) { toast(e.message, true); })
      .then(function () { loadAccount(); });
  }

  function signOutAll() {
    if (!window.confirm('Sign out on every device, including this one?')) return;
    api('POST', '/api/auth/logout-all')
      .then(function (data) {
        signedOut();
        toast('Signed out on ' + data.devices + (data.devices === 1 ? ' device.' : ' devices.'));
      })
      .catch(function (e) { toast(e.message, true); });
  }

  /* ------------------------------------------------------------ sign in */

  function setStatus(id, message, isError) {
    var s = $(id);
    s.textContent = message || '';
    s.className = 'status' + (isError ? ' error' : '');
  }

  function signedIn(user) {
    state.user = user;
    connectEvents();
    state.filters = (user.diet || []).slice(); // saved preferences are the starting filters
    renderFilters();
    $('view-list').setAttribute('aria-pressed', String(state.view === 'list'));
    $('view-map').setAttribute('aria-pressed', String(state.view === 'map'));
    $('view-auth').hidden = true;
    $('tabs').hidden = false;
    $('user-bar').hidden = false;
    $('user-email').textContent = user.email;
    $('user-email').title = user.email;
    showTab(location.hash.slice(1), false);
  }

  function signedOut(message) {
    state.user = null;
    disconnectEvents();
    state.posts = [];
    state.seenClaims = null;
    state.loaded = false;
    $('view-find').hidden = true;
    $('view-share').hidden = true;
    $('view-account').hidden = true;
    $('tabs').hidden = true;
    $('user-bar').hidden = true;
    $('view-auth').hidden = false;
    showEmailStep();
    if (message) toast(message, true);
  }

  function showEmailStep() {
    $('code-form').hidden = true;
    $('setpw-form').hidden = true;
    $('auth-title').textContent = 'Sign in with your school email';
    $('auth-lead').hidden = false;
    $('email-form').hidden = false;
    $('code').value = '';
    $('password').value = '';
    $('setpw-new').value = '';
    updateSignInButton();
    setStatus('code-status', '');
    setStatus('setpw-status', '');
    $('email').focus();
  }

  // The main button signs in with the password when one is typed, otherwise emails a code.
  function updateSignInButton() {
    $('email-btn').textContent = $('password').value ? 'Sign in' : 'Email me a code';
  }

  function isEduEmail(v) {
    return /^[^\s@]+@([a-z0-9-]+\.)+edu$/i.test(v);
  }

  function requestCode(email, btn, statusId, label) {
    btn.disabled = true;
    btn.textContent = 'Sending…';
    setStatus(statusId, '');
    return api('POST', '/api/auth/request-code', { email: email })
      .then(function () {
        state.authEmail = email;
        $('sent-to').textContent = email;
        $('email-form').hidden = true;
        $('code-form').hidden = false;
        $('code').focus();
        return true;
      })
      .catch(function (err) { setStatus(statusId, err.message, true); return false; })
      .then(function (ok) {
        btn.disabled = false;
        btn.textContent = label;
        return ok;
      });
  }

  function readAuthEmail() {
    var email = $('email').value.trim().toLowerCase();
    if (!isEduEmail(email)) {
      setStatus('email-status', 'Use your school email address (it must end in .edu).', true);
      $('email').focus();
      return null;
    }
    return email;
  }

  function submitEmail(e) {
    e.preventDefault();
    var email = readAuthEmail();
    if (!email) return;
    var password = $('password').value;
    if (!password) return requestCode(email, $('email-btn'), 'email-status', 'Email me a code');

    var btn = $('email-btn');
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    setStatus('email-status', '');
    api('POST', '/api/auth/login', { email: email, password: password })
      .then(function (data) {
        $('email-form').reset();
        signedIn(data.user);
        toast('Signed in. Welcome back!');
      })
      .catch(function (err) {
        setStatus('email-status', err.message, true);
        $('password').select();
      })
      .then(function () {
        btn.disabled = false;
        updateSignInButton();
      });
  }

  function forgotPassword() {
    var email = readAuthEmail();
    if (!email) return;
    $('password').value = '';
    updateSignInButton();
    requestCode(email, $('forgot-btn'), 'email-status', 'Forgot your password? Email me a code').then(function (ok) {
      if (ok) setStatus('code-status', 'After you sign in, set a new password on your Account page.');
    });
  }

  function resendCode() {
    requestCode(state.authEmail, $('resend-btn'), 'code-status', 'Send a new code').then(function (ok) {
      if (ok) setStatus('code-status', 'A new code is on its way.');
    });
  }

  function submitCode(e) {
    e.preventDefault();
    var code = $('code').value.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(code)) { setStatus('code-status', 'Enter the 6-digit code from your email.', true); $('code').focus(); return; }
    var btn = $('code-btn');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    setStatus('code-status', '');
    api('POST', '/api/auth/verify', { email: state.authEmail, code: code })
      .then(function (data) {
        $('email-form').reset();
        $('code').value = '';
        if (data.user.hasPassword) {
          signedIn(data.user);
          toast('Signed in. Welcome!');
          return;
        }
        // First time (or never set one): offer a password so next time needs no code.
        state.pendingUser = data.user;
        $('auth-title').textContent = 'Skip the code next time';
        $('auth-lead').hidden = true;
        $('code-form').hidden = true;
        $('setpw-form').hidden = false;
        $('setpw-email').textContent = data.user.email;
        $('setpw-username').value = data.user.email;
        $('setpw-new').focus();
      })
      .catch(function (err) { setStatus('code-status', err.message, true); $('code').select(); })
      .then(function () {
        btn.disabled = false;
        btn.textContent = 'Sign in';
      });
  }

  function submitSetPassword(e) {
    e.preventDefault();
    var pw = $('setpw-new').value;
    if (pw.length < 8) { setStatus('setpw-status', 'Use at least 8 characters for your password.', true); $('setpw-new').focus(); return; }
    var btn = $('setpw-btn');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    setStatus('setpw-status', '');
    api('POST', '/api/auth/password', { password: pw })
      .then(function (data) {
        $('setpw-new').value = '';
        state.pendingUser = null;
        signedIn(data.user);
        toast('Password saved. Next time, sign in with it. No code needed.');
      })
      .catch(function (err) { setStatus('setpw-status', err.message, true); $('setpw-new').select(); })
      .then(function () { btn.disabled = false; btn.textContent = 'Save password'; });
  }

  function skipSetPassword() {
    var user = state.pendingUser;
    state.pendingUser = null;
    $('setpw-new').value = '';
    signedIn(user);
    toast('Signed in. You can set a password any time on your Account page.');
  }

  // Account page: set or change your password.
  function renderPasswordSection(user) {
    state.user = user;
    var has = user.hasPassword;
    $('pw-status').textContent = (has
      ? 'You can sign in with your password' + (user.passwordSetAt ? ' (set ' + when(user.passwordSetAt) + ')' : '') + ' or with an email code.'
      : 'You sign in with a code sent to your school email. Set a password to skip the code next time.') +
      ' Each device stays signed in for 30 days.';
    $('pw-current-wrap').hidden = !has;
    $('pw-username').value = user.email;
    $('pw-new-label').textContent = has ? 'New password' : 'Password';
    $('pw-btn').textContent = has ? 'Change password' : 'Set password';
  }

  function submitAccountPassword(e) {
    e.preventDefault();
    var pw = $('pw-new').value;
    if (pw.length < 8) { setStatus('pw-form-status', 'Use at least 8 characters for your password.', true); $('pw-new').focus(); return; }
    var btn = $('pw-btn');
    var label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Saving…';
    setStatus('pw-form-status', '');
    api('POST', '/api/auth/password', { password: pw, currentPassword: $('pw-current').value || undefined })
      .then(function (data) {
        $('pw-form').reset();
        renderPasswordSection(data.user);
        setStatus('pw-form-status', 'Password saved. Any other devices were signed out.');
      })
      .catch(function (err) { setStatus('pw-form-status', err.message, true); })
      .then(function () { btn.disabled = false; if (btn.textContent === 'Saving…') btn.textContent = label; });
  }

  function signOut() {
    api('POST', '/api/auth/logout')
      .catch(function () { /* signed out locally either way */ })
      .then(function () { signedOut(); });
  }

  /* --------------------------------------------------------------- init */

  $('email-form').addEventListener('submit', submitEmail);
  $('code-form').addEventListener('submit', submitCode);
  $('change-email').addEventListener('click', showEmailStep);
  $('password').addEventListener('input', updateSignInButton);
  $('forgot-btn').addEventListener('click', forgotPassword);
  $('setpw-form').addEventListener('submit', submitSetPassword);
  $('setpw-skip').addEventListener('click', skipSetPassword);
  $('pw-form').addEventListener('submit', submitAccountPassword);
  $('resend-btn').addEventListener('click', resendCode);
  $('signout-btn').addEventListener('click', signOut);

  $('tab-find').addEventListener('click', function () { showTab('find', true); });
  $('tab-share').addEventListener('click', function () { showTab('share', true); });
  $('tab-account').addEventListener('click', function () { showTab('account', true); });
  $('user-email').addEventListener('click', function () { showTab('account', true); });
  $('acct-signout').addEventListener('click', signOut);
  $('acct-signout-all').addEventListener('click', signOutAll);
  $('empty-share').addEventListener('click', function () { showTab('share', true); });
  $('locate-btn').addEventListener('click', locate);
  $('view-list').addEventListener('click', function () { setView('list'); });
  $('view-map').addEventListener('click', function () { setView('map'); });
  $('map-fit').addEventListener('click', function () {
    fitPins(visiblePosts().filter(function (p) { return p.lat !== null; }));
  });
  $('refresh-btn').addEventListener('click', function () { load().then(function () { toast('Up to date.'); }); });
  $('sort').addEventListener('change', function (e) { state.sort = e.target.value; renderFeed(); });
  $('photo').addEventListener('change', onPhotoChosen);
  $('photo-clear').addEventListener('click', function () { $('photo').value = ''; setPhoto(null); });
  $('serv-minus').addEventListener('click', function () { stepServings(-1); });
  $('serv-plus').addEventListener('click', function () { stepServings(1); });
  ['none', 'here', 'addr'].forEach(function (m) {
    $('pin-' + m).addEventListener('click', function () { if (state.pinMode !== m) setPinMode(m); });
  });
  $('addr-find').addEventListener('click', function () { findAddress().catch(function () {}); });
  $('address').addEventListener('input', onAddressEdited);
  $('address').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); findAddress().catch(function () {}); }
  });
  $('share-form').addEventListener('submit', submitPost);
  $('edit-cancel').addEventListener('click', function () {
    var back = state.editReturn;
    endEdit();
    showTab(back, true);
  });
  $('edit-delete').addEventListener('click', function (e) {
    var p = state.editing;
    var back = state.editReturn;
    deletePost(p, e.currentTarget, function () { endEdit(); showTab(back, true); });
  });

  // Keep the list fresh, and keep checking for check-ins on your posts from any tab.
  // (Browsers slow this down in background tabs, which is fine.)
  setInterval(function () {
    if (state.user && (document.visibilityState === 'visible' || state.posts.some(function (p) { return p.mine; }))) load();
  }, POLL_MS);
  document.addEventListener('visibilitychange', function () {
    if (state.user && document.visibilityState === 'visible' && !$('view-find').hidden) load();
  });

  api('GET', '/api/config')
    .then(function (cfg) { state.config = { tags: cfg.tags, durations: cfg.durations }; })
    .catch(function () { /* fall back to built-in defaults */ })
    .then(function () {
      renderFilters();
      renderShareOptions();
    });

  renderFeed();
  api('GET', '/api/auth/me')
    .then(function (data) { signedIn(data.user); })
    .catch(function () { signedOut(); });
})();
