/**
 * Guest page behaviour. No framework, no build step.
 *
 * Three jobs: debounced search, a confirmation sheet, and a live queue over
 * SSE with polling as a fallback. Everything degrades to "still usable" rather
 * than breaking — a phone on bad venue Wi-Fi is the expected case.
 */
(function () {
  'use strict';

  var config = JSON.parse(document.getElementById('jb-config').textContent);

  var els = {
    q: document.getElementById('q'),
    results: document.getElementById('results'),
    status: document.getElementById('search-status'),
    spinner: document.getElementById('spinner'),
    nowPlaying: document.getElementById('now-playing'),
    upNext: document.getElementById('up-next'),
    sheet: document.getElementById('sheet'),
    sheetBody: document.getElementById('sheet-body'),
    sheetTrack: document.getElementById('sheet-track'),
    sheetPrice: document.getElementById('sheet-price'),
    sheetPosition: document.getElementById('sheet-position'),
    sheetError: document.getElementById('sheet-error'),
    confirm: document.getElementById('confirm'),
  };

  var selected = null;
  var searchTimer = null;
  var inFlight = null;
  var submitting = false;

  function text(value) {
    return document.createTextNode(value == null ? '' : String(value));
  }

  function el(tag, className, child) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (child != null) node.appendChild(typeof child === 'string' ? text(child) : child);
    return node;
  }

  /** Album art, or a neutral placeholder so rows never jump as images land. */
  function artwork(url, size) {
    if (!url) return el('div', 'art art--empty');
    var img = document.createElement('img');
    img.className = 'art';
    img.src = url;
    img.alt = '';
    img.loading = 'lazy';
    img.width = size;
    img.height = size;
    return img;
  }

  // --- search ---------------------------------------------------------------

  function runSearch(query) {
    if (inFlight) inFlight.abort();
    var controller = new AbortController();
    inFlight = controller;
    els.spinner.hidden = false;

    fetch('/api/search?q=' + encodeURIComponent(query), { signal: controller.signal })
      .then(function (res) {
        return res.json().then(function (body) {
          return { ok: res.ok, body: body };
        });
      })
      .then(function (result) {
        if (controller.signal.aborted) return;
        els.spinner.hidden = true;
        if (!result.ok) {
          renderResults([]);
          els.status.textContent = result.body.error || 'Search is unavailable right now.';
          return;
        }
        renderResults(result.body.results || []);
        els.status.textContent = result.body.results.length ? '' : 'Nothing found. Try another spelling.';
      })
      .catch(function (err) {
        if (err.name === 'AbortError') return;
        els.spinner.hidden = true;
        els.status.textContent = 'Could not search. Check your connection.';
      });
  }

  function renderResults(tracks) {
    els.results.textContent = '';
    tracks.forEach(function (track) {
      var button = el('button', 'result');
      button.type = 'button';
      button.appendChild(artwork(track.albumArtUrl, 48));

      var body = el('span', 'result__body');
      body.appendChild(el('span', 'result__name', track.name));
      var meta = el('span', 'result__meta', track.artist + ' · ' + track.duration);
      if (track.explicit) {
        meta.appendChild(text(' '));
        meta.appendChild(el('span', 'tag', 'E'));
      }
      body.appendChild(meta);
      button.appendChild(body);

      button.addEventListener('click', function () {
        openSheet(track);
      });
      els.results.appendChild(el('li', null, button));
    });
  }

  if (els.q) {
    els.q.addEventListener('input', function () {
      var query = els.q.value.trim();
      clearTimeout(searchTimer);

      if (query.length < 2) {
        if (inFlight) inFlight.abort();
        els.spinner.hidden = true;
        renderResults([]);
        els.status.textContent = '';
        return;
      }
      // Long enough that typing a title does not fire six searches.
      searchTimer = setTimeout(function () {
        runSearch(query);
      }, 280);
    });
  }

  // --- confirmation sheet ---------------------------------------------------

  function openSheet(track) {
    selected = track;
    els.sheetError.hidden = true;
    els.sheetError.textContent = '';
    els.confirm.disabled = false;
    els.confirm.textContent = config.isPaid ? 'Pay and play' : 'Yes, play it';

    els.sheetTrack.textContent = '';
    els.sheetTrack.appendChild(artwork(track.albumArtUrl, 64));
    var body = el('div', 'sheet__track-text');
    body.appendChild(el('strong', null, track.name));
    body.appendChild(el('span', 'hint', track.artist));
    body.appendChild(el('span', 'hint', track.duration));
    els.sheetTrack.appendChild(body);

    els.sheetPrice.textContent = config.priceLabel;
    els.sheetPosition.textContent = describePosition(lastSnapshot);

    els.sheet.hidden = false;
    document.body.classList.add('is-locked');
    els.confirm.focus();
  }

  function closeSheet() {
    els.sheet.hidden = true;
    document.body.classList.remove('is-locked');
    selected = null;
  }

  function describePosition(snapshot) {
    if (!snapshot) return 'Next up';
    var waiting = snapshot.upNext ? snapshot.upNext.length : 0;
    if (waiting === 0) return 'Next up';
    if (waiting === 1) return 'After 1 other song';
    return 'After ' + waiting + ' other songs';
  }

  els.sheet.addEventListener('click', function (event) {
    if (event.target.hasAttribute('data-close')) closeSheet();
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !els.sheet.hidden) closeSheet();
  });

  els.confirm.addEventListener('click', function () {
    if (!selected || submitting) return;
    submitting = true;
    els.confirm.disabled = true;
    els.confirm.textContent = 'Sending…';
    els.sheetError.hidden = true;

    fetch('/api/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trackId: selected.id }),
    })
      .then(function (res) {
        return res.json().then(function (body) {
          return { ok: res.ok, body: body };
        });
      })
      .then(function (result) {
        submitting = false;
        if (!result.ok) {
          els.confirm.disabled = false;
          els.confirm.textContent = config.isPaid ? 'Pay and play' : 'Yes, play it';
          els.sheetError.textContent = result.body.error || 'That did not work. Try again.';
          els.sheetError.hidden = false;
          return;
        }
        // Paid mode: Stripe hosts the card form. Nothing sensitive is ever
        // typed into this page.
        if (result.body.checkoutUrl) {
          els.confirm.textContent = 'Taking you to checkout…';
          window.location.assign(result.body.checkoutUrl);
          return;
        }
        showSuccess(result.body);
        refreshQueue();
      })
      .catch(function () {
        submitting = false;
        els.confirm.disabled = false;
        els.confirm.textContent = config.isPaid ? 'Pay and play' : 'Yes, play it';
        els.sheetError.textContent = 'Could not send that. Check your connection.';
        els.sheetError.hidden = false;
      });
  });

  function showSuccess(result) {
    els.sheetBody.textContent = '';
    els.sheetBody.appendChild(el('h2', 'sheet__done', "You're in"));

    var line = el('p', null, null);
    line.appendChild(el('strong', null, result.track.name));
    line.appendChild(text(' is '));
    line.appendChild(
      text(result.position === 1 ? 'up next.' : 'number ' + result.position + ' in the queue.'),
    );
    els.sheetBody.appendChild(line);

    var done = el('button', 'btn btn--primary', 'Done');
    done.type = 'button';
    done.addEventListener('click', function () {
      window.location.reload();
    });
    els.sheetBody.appendChild(done);
  }

  // --- live queue -----------------------------------------------------------

  var lastSnapshot = null;

  function renderQueue(snapshot) {
    lastSnapshot = snapshot;

    els.nowPlaying.textContent = '';
    if (!snapshot.nowPlaying) {
      els.nowPlaying.appendChild(el('p', 'hint', 'Nothing playing.'));
    } else {
      var row = el('div', 'now-row');
      row.appendChild(artwork(snapshot.nowPlaying.albumArtUrl, 56));
      var body = el('div', 'now-row__body');
      body.appendChild(el('strong', null, snapshot.nowPlaying.name));
      body.appendChild(el('span', 'hint', snapshot.nowPlaying.artist));
      if (snapshot.nowPlaying.requested) {
        body.appendChild(el('span', 'tag tag--request', 'Requested'));
      }
      row.appendChild(body);
      els.nowPlaying.appendChild(row);
    }

    els.upNext.textContent = '';
    if (!snapshot.upNext.length) {
      els.upNext.appendChild(el('li', 'hint', 'Nothing queued — the playlist is running.'));
      return;
    }
    snapshot.upNext.forEach(function (item) {
      var li = el('li', 'up-next__item');
      li.appendChild(artwork(item.albumArtUrl, 40));
      var body = el('span', 'up-next__body');
      body.appendChild(el('span', 'up-next__name', item.name));
      body.appendChild(el('span', 'hint', item.artist));
      li.appendChild(body);
      els.upNext.appendChild(li);
    });
  }

  function refreshQueue() {
    fetch('/api/queue')
      .then(function (res) {
        return res.json();
      })
      .then(renderQueue)
      .catch(function () {
        /* the stream or the next poll will catch up */
      });
  }

  function connectStream() {
    if (!window.EventSource) {
      setInterval(refreshQueue, 5000);
      refreshQueue();
      return;
    }

    var source = new EventSource('/api/queue/stream');
    var pollFallback = null;

    source.onmessage = function (event) {
      if (pollFallback) {
        clearInterval(pollFallback);
        pollFallback = null;
      }
      try {
        renderQueue(JSON.parse(event.data));
      } catch (err) {
        /* ignore a malformed frame; the next one will be fine */
      }
    };

    source.onerror = function () {
      // EventSource reconnects on its own; poll meanwhile so the page is
      // never stale for long on a flaky connection.
      if (!pollFallback) pollFallback = setInterval(refreshQueue, 5000);
    };
  }

  refreshQueue();
  connectStream();
})();
