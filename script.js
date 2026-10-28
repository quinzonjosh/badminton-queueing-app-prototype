(() => {
    'use strict';

    // =====================================================================
    // Shared state + helpers
    // =====================================================================
    const STORAGE_KEY = 'qsession.players';
    const SESSION_KEY = 'qsession.session';
    const COURTS_KEY = 'qsession.courts';
    const HISTORY_KEY = 'qsession.history';
    const FEES_KEY = 'qsession.fees';
    const DEFAULT_COURTS = 2;
    const NOTICE_MS = 8000;
    const CURRENCY = '₱';
    const LEVEL_LABELS = {
        beginner: 'Beginner',
        'upper-intermediate': 'Upper Int.',
        intermediate: 'Intermediate',
        advanced: 'Advanced'
    };

    // players: [{ id, name, level, games, wins, losses, draws, payment, addedAt }]
    // payment: null | { method: 'cash' | 'digital', amount, paidAt }
    // session.matches (the queue): [{ id, no, a: [id, id], b: [id, id], createdAt }]
    // courts: [{ number, match: null | { id, no, a, b, startedAt } }]
    // history: [{ id, no, court, startedAt, endedAt, a: [names], b: [names], result: 'a' | 'b' | 'draw' }]
    // fees: { perPlayer, expenses }
    const state = {
        players: [],
        session: {
            started: false,
            matches: [],
            counter: 0
        },
        courts: [],
        history: [],
        fees: {
            perPlayer: 0,
            expenses: 0
        },
    };
    const listeners = [];
    const flashTimers = new WeakMap();

    // Works on http(s) and file:// pages
    const newId = () => crypto.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2);
    const defaultCourts = () => Array.from({
        length: DEFAULT_COURTS
    }, (_, i) => ({
        number: i + 1,
        match: null
    }));
    const makePlayer = (name, level) => ({
        id: newId(),
        name,
        level,
        games: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        payment: null,
        addedAt: Date.now()
    });
    const resetSessionData = p => {
        p.games = 0;
        p.wins = 0;
        p.losses = 0;
        p.draws = 0;
        p.payment = null;
    };

    const onChange = fn => listeners.push(fn);
    const playerById = id => state.players.find(p => p.id === id);
    const nameList = ids => ids.map(id => playerById(id)?.name).filter(Boolean);
    const namesOf = ids => nameList(ids).join(' + ');
    const formatClock = ts => new Date(ts).toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit'
    });
    const round2 = n => Math.round(n * 100) / 100;

    function money(n) {
        const text = Math.abs(n).toLocaleString(undefined, {
            minimumFractionDigits: 0,
            maximumFractionDigits: 2
        });
        return `${n < 0 ? '-' : ''}${CURRENCY}${text}`;
    }

    function loadJSON(key, fallback) {
        try {
            return JSON.parse(localStorage.getItem(key)) ?? fallback;
        } catch {
            return fallback;
        }
    }

    function loadState() {
        state.players = loadJSON(STORAGE_KEY, []);
        const ids = new Set(state.players.map(p => p.id));
        // a match is valid only if all 4 players still exist
        const valid = m => m && Array.isArray(m.a) && Array.isArray(m.b) && [...m.a, ...m.b].every(id => ids.has(id));

        const saved = loadJSON(SESSION_KEY, null);
        if (saved && Array.isArray(saved.matches)) {
            const matches = saved.matches.filter(valid);
            state.session = {
                started: !!saved.started,
                matches,
                counter: saved.counter ?? matches.length
            };
        }

        const courts = loadJSON(COURTS_KEY, null);
        state.courts = Array.isArray(courts) ?
            courts.map(c => ({
                number: c.number,
                match: valid(c.match) ? c.match : null
            })) :
            defaultCourts();

        const history = loadJSON(HISTORY_KEY, []);
        state.history = Array.isArray(history) ? history : [];

        const fees = loadJSON(FEES_KEY, null);
        state.fees = {
            perPlayer: Math.max(0, Number(fees?.perPlayer) || 0),
            expenses: Math.max(0, Number(fees?.expenses) || 0)
        };
    }

    // Save everything, then refresh every screen. One broken screen can't block the others.
    function commit() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state.players));
            localStorage.setItem(SESSION_KEY, JSON.stringify(state.session));
            localStorage.setItem(COURTS_KEY, JSON.stringify(state.courts));
            localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history));
            localStorage.setItem(FEES_KEY, JSON.stringify(state.fees));
        } catch {
            /* storage unavailable */
        }
        listeners.forEach(fn => {
            try {
                fn();
            } catch (err) {
                console.error(err);
            }
        });
    }

    // Shows a message in an element, then hides it after a few seconds
    function flash(el, text) {
        clearTimeout(flashTimers.get(el));
        el.textContent = text;
        el.hidden = false;
        flashTimers.set(el, setTimeout(() => {
            el.hidden = true;
        }, NOTICE_MS));
    }

    // <li> with a player's name, used inside team boxes (queue, courts, history)
    function buildNameLi(name) {
        const li = document.createElement('li');
        const span = document.createElement('span');
        span.className = 'team-name';
        span.textContent = name; // textContent: safe for user input
        li.append(span);
        return li;
    }

    // Same, plus the skill badge
    function buildPlayerLi(player) {
        const li = buildNameLi(player.name);
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = LEVEL_LABELS[player.level];
        badge.dataset.level = player.level;
        li.append(badge);
        return li;
    }

    // Fills the Team A / Team B lists of a queue or court card
    function fillTeams(root, match) {
        const fill = (selector, ids) =>
            root.querySelector(selector).replaceChildren(...ids.map(playerById).filter(Boolean).map(buildPlayerLi));
        fill('.team-a .team-players', match.a);
        fill('.team-b .team-players', match.b);
    }

    // =====================================================================
    // In-app prompts: one reusable overlay for every confirmation and choice.
    //   ask({ title, text, note, icon, choices, cancelLabel }) -> Promise<value | null>
    //   choices: [{ label, sub?, value, kind?: 'primary' | 'danger' | 'team' }]
    //   Resolves null when cancelled (Cancel button, Escape, or tapping outside).
    // =====================================================================
    let promptUI = null; // set by initPrompts()

    const ask = options => promptUI.open(options);

    // Yes/no confirmation -> Promise<boolean>
    async function confirmAction({
        title,
        text = '',
        confirmLabel = 'Confirm',
        cancelLabel = 'Cancel',
        danger = true
    }) {
        const ok = await ask({
            title,
            text,
            cancelLabel,
            choices: [{
                label: confirmLabel,
                value: true,
                kind: danger ? 'danger' : 'primary'
            }],
        });
        return ok === true;
    }

    function initPrompts() {
        const root = document.getElementById('prompt');
        const box = root.querySelector('.prompt');
        const iconEl = document.getElementById('prompt-icon');
        const titleEl = document.getElementById('prompt-title');
        const textEl = document.getElementById('prompt-text');
        const noteEl = document.getElementById('prompt-note');
        const actionsEl = document.getElementById('prompt-actions');

        let active = null; // { resolve, choices, opener }

        function close(value) {
            if (!active) return;
            const {
                resolve,
                opener
            } = active;
            active = null;
            root.hidden = true;
            document.body.classList.remove('prompt-open');
            resolve(value);
            if (opener?.isConnected) opener.focus({
                preventScroll: true
            });
        }

        function open({
            title,
            text = '',
            note = '',
            icon = '',
            choices = [],
            cancelLabel = 'Cancel'
        }) {
            if (active) close(null); // only one prompt at a time

            return new Promise(resolve => {
                active = {
                    resolve,
                    choices,
                    opener: document.activeElement
                };

                box.classList.toggle('has-icon', !!icon);
                iconEl.textContent = icon;
                iconEl.hidden = !icon;
                titleEl.textContent = title;
                textEl.innerHTML = text ? text.replace(/\n/g, '<br>') : '';
                textEl.hidden = !text;
                noteEl.textContent = note;
                noteEl.hidden = !note;

                // choices with a second line (like team names) stack; short ones sit in a row
                const stacked = choices.some(c => c.sub);
                actionsEl.classList.toggle('row', !stacked);

                const buttons = choices.map((c, i) => {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.dataset.choice = i;
                    if (stacked) {
                        btn.className = 'btn result-btn' + (c.kind === 'team' ? ' team' : '');
                        const strong = document.createElement('strong');
                        strong.textContent = c.label;
                        btn.append(strong);
                        if (c.sub) {
                            const sub = document.createElement('span');
                            sub.textContent = c.sub;
                            btn.append(sub);
                        }
                    } else {
                        btn.className = 'btn' + (c.kind ? ` btn-${c.kind}` : '');
                        btn.textContent = c.label;
                    }
                    return btn;
                });

                let cancelBtn = null;
                if (cancelLabel) {
                    cancelBtn = document.createElement('button');
                    cancelBtn.type = 'button';
                    cancelBtn.className = 'btn';
                    cancelBtn.dataset.cancel = '1';
                    cancelBtn.textContent = cancelLabel;
                }

                // Cancel sits first in a row, last in a stack
                actionsEl.replaceChildren(...(stacked ? [...buttons, cancelBtn] : [...buttons, cancelBtn]).filter(Boolean));                root.hidden = false;
                document.body.classList.add('prompt-open');
                (cancelBtn ?? buttons[0])?.focus(); // focus the safe choice first
            });
        }

        root.addEventListener('click', e => {
            if (!active) return;
            if (e.target === root || e.target.closest('[data-cancel]')) {
                close(null);
                return;
            }
            const btn = e.target.closest('[data-choice]');
            if (btn) close(active.choices[Number(btn.dataset.choice)].value);
        });

        document.addEventListener('keydown', e => {
            if (!active) return;
            if (e.key === 'Escape') {
                e.preventDefault();
                close(null);
                return;
            }
            if (e.key !== 'Tab') return;

            // keep keyboard focus inside the prompt
            const items = [...actionsEl.querySelectorAll('button')];
            if (!items.length) return;
            const first = items[0];
            const last = items[items.length - 1];
            if (!actionsEl.contains(document.activeElement)) {
                e.preventDefault();
                first.focus();
            } else if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        });

        promptUI = {
            open
        };
    }

    // =====================================================================
    // Router: shows the view matching the URL hash, highlights the nav item
    // =====================================================================
    const DEFAULT_VIEW = 'court';

    function initRouter() {
        const views = document.querySelectorAll('.view');
        const navItems = document.querySelectorAll('.bottom-nav .nav-item');

        function show() {
            let name = location.hash.slice(1);
            if (![...views].some(v => v.dataset.view === name)) name = DEFAULT_VIEW;

            views.forEach(v => {
                v.hidden = v.dataset.view !== name;
            });
            navItems.forEach(a => {
                const active = a.getAttribute('href') === `#${name}`;
                a.classList.toggle('active', active);
                if (active) a.setAttribute('aria-current', 'page');
                else a.removeAttribute('aria-current');
            });
            window.scrollTo(0, 0);
        }

        window.addEventListener('hashchange', show);
        show();
    }

    // =====================================================================
    // Tabs: generic accessible tabs for any [role="tablist"]
    // =====================================================================
    function initTabs() {
        document.querySelectorAll('[role="tablist"]').forEach(list => {
            const tabs = [...list.querySelectorAll('[role="tab"]')];

            function select(tab) {
                tabs.forEach(t => {
                    const on = t === tab;
                    t.setAttribute('aria-selected', on);
                    t.tabIndex = on ? 0 : -1;
                    document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
                });
            }

            list.addEventListener('click', e => {
                const tab = e.target.closest('[role="tab"]');
                if (tab) select(tab);
            });

            // Arrow-key navigation
            list.addEventListener('keydown', e => {
                const i = tabs.indexOf(document.activeElement);
                if (i < 0 || !['ArrowRight', 'ArrowLeft'].includes(e.key)) return;
                const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
                next.focus();
                select(next);
            });
        });
    }

    // =====================================================================
    // Bulk parser: turns pasted text into players.
    // Accepts numbered lists, bullets, commas, and skill levels.
    // =====================================================================
    const DEFAULT_LEVEL = 'beginner';

    const LEVEL_WORDS = {
        beginner: ['beginners?', 'beg', 'newbies?', 'novices?', 'rookies?', 'basic', 'starter', 'lvl\\s*1', 'level\\s*1'],
        // must come before "intermediate" so "upper intermediate" isn't read as plain "intermediate"
        'upper-intermediate': ['upper\\s*-?\\s*intermediates?', 'upper\\s*-?\\s*intermed', 'upper\\s*-?\\s*inter', 'upper\\s*-?\\s*int', 'upper\\s*-?\\s*mid', 'high\\s*-?\\s*intermediates?', 'upper', 'lvl\\s*3', 'level\\s*3'],
        intermediate: ['intermediates?', 'intermed', 'inter', 'int', 'mid', 'medium', 'average', 'lvl\\s*2', 'level\\s*2'],
        advanced: ['advanced?', 'adv', 'pro', 'experts?', 'lvl\\s*4', 'level\\s*4'],
    };
    const LEVEL_PATTERNS = Object.entries(LEVEL_WORDS).map(([level, words]) => [
        level,
        new RegExp(`(?<![\\p{L}\\d])(?:${words.join('|')})(?![\\p{L}\\d])`, 'iu'),
    ]);

    const PREFIX = /^\s*(?:[-*•·>]+|\d+\s*[.)\]:-])\s*/; // leading bullet or number: "- ", "1. ", "2) "
    const SEPARATORS = /\s*[,;|]\s*|\s+&\s+|\s+and\s+/i; // , ; | & and

    function findLevel(text) {
        for (const [level, re] of LEVEL_PATTERNS) {
            const m = text.match(re);
            if (m) return {
                level,
                match: m[0]
            };
        }
        return null;
    }

    function cleanName(raw) {
        let name = raw
            .replace(/[\p{Extended_Pictographic}\u200d\ufe0f]/gu, '') // emoji
            .replace(/[()\[\]{}"“”<>]/g, ' ') // brackets, quotes
            .replace(/^[\s\-–—:=.•*#@]+|[\s\-–—:=.•*#]+$/g, '') // edge punctuation
            .replace(/\s+/g, ' ')
            .trim();
        // lowercase -> Title Case; LONG ALL CAPS -> Title Case; short caps like "JR" or "AJ" stay as initials
        if (name && (name === name.toLowerCase() || (name === name.toUpperCase() && name.length > 3))) {
            name = name.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());
        }
        return name;
    }

    // One line -> one or more { name, level }
    function parseSegments(content, currentLevel) {
        const entries = [];
        let prev = null;
        for (const seg of content.split(SEPARATORS)) {
            const found = findLevel(seg);
            const name = cleanName(found ? seg.replace(found.match, ' ') : seg);
            if (!/\p{L}/u.test(name)) {
                // a lone skill word ("Maria, beginner") applies to the previous name
                if (found && prev && !prev.explicit) {
                    prev.level = found.level;
                    prev.explicit = true;
                }
                continue;
            }
            prev = {
                name: name.slice(0, 40),
                level: found ? found.level : currentLevel,
                explicit: !!found
            };
            entries.push(prev);
        }
        return entries;
    }

    function extractNumberedRoster(text) {
        const lines = text.split(/\r?\n/);
        const roster = [];
        let rosterStarted = false;

        // Recognizes: "1. Tere", "2) Caryl", "24. Gerry"
        const numberedEntry = /^\s*\d+\s*[.)]\s*(.*?)\s*$/;

        for (const raw of lines) {
            const line = raw.trim();
            if (!line) continue;

            const match = line.match(numberedEntry);

            if (match) {
                const name = cleanName(match[1]);

                // Empty numbered slots are not players.
                if (!name || !/\p{L}/u.test(name)) {
                    // An empty slot after a roster should not end parsing.
                    continue;
                }

                // Avoid interpreting arbitrary numbered event details as names.
                if (name.length > 40) continue;

                rosterStarted = true;

                const found = findLevel(name);
                const playerName = cleanName(
                    found ? name.replace(found.match, " ") : name
                );

                if (!playerName || !/\p{L}/u.test(playerName)) continue;

                roster.push({
                    name: playerName.slice(0, 40),
                    level: found?.level ?? DEFAULT_LEVEL
                });

                continue;
            }

            // Ignore non-roster text once a numbered roster has begun.
            // Keep looking for further numbered players after informational text.
            if (rosterStarted) continue;
        }

        return roster;
    }

    function parseBulkPlayers(text) {
        const out = [];
        let currentLevel = DEFAULT_LEVEL; // default fallback

        for (const raw of text.split(/\r?\n/)) {
            const line = raw.replace(PREFIX, '').trim();
            if (!line) continue;

            let lineLevel = null;
            let namesPart = line;

            // 1. Check if the line has a colon prefix (e.g., "Intermediate: Caryl, John")
            const colonIndex = line.indexOf(':');
            if (colonIndex > 0) {
                const prefix = line.slice(0, colonIndex).trim();
                const foundPrefix = findLevel(prefix);
                if (foundPrefix && !/\p{L}/u.test(prefix.replace(foundPrefix.match, ''))) {
                    lineLevel = foundPrefix.level;
                    currentLevel = foundPrefix.level; // update persistent current level too
                    namesPart = line.slice(colonIndex + 1).trim();
                }
            } else {
                // 2. Check if the line is a standalone category header (e.g., "Advanced")
                const headerCheck = line.replace(/[:\-–—=*#()[\]]+/g, ' ').trim();
                const foundHeader = findLevel(headerCheck);
                if (foundHeader && !/\p{L}/u.test(headerCheck.replace(foundHeader.match, ''))) {
                    currentLevel = foundHeader.level;
                    continue; // Header line only, move to next line
                }
            }

            // 3. Split names by comma, semicolon, pipe, etc., and apply the active level
            const activeLevel = lineLevel || currentLevel;
            for (const seg of namesPart.split(SEPARATORS)) {
                const found = findLevel(seg);
                const cleaned = cleanName(found ? seg.replace(found.match, ' ') : seg);
                if (!/\p{L}/u.test(cleaned)) continue;

                out.push({
                    name: cleaned.slice(0, 40),
                    level: found ? found.level : activeLevel
                });
            }
        }

        return out.map(({
            name,
            level
        }) => ({
            name,
            level: level ?? DEFAULT_LEVEL
        }));
    }

    // Opens an interactive modal to edit/swap players for an auto-generated match with duplicate validation
    function openInteractiveMatchEditor(initialA, initialB, allAvailablePlayers) {
        const root = document.getElementById('prompt');
        const box = root.querySelector('.prompt');
        const iconEl = document.getElementById('prompt-icon');
        const titleEl = document.getElementById('prompt-title');
        const textEl = document.getElementById('prompt-text');
        const noteEl = document.getElementById('prompt-note');
        const actionsEl = document.getElementById('prompt-actions');

        return new Promise(resolve => {
            let currentA = [...initialA];
            let currentB = [...initialB];

            // Eligible players = players currently not busy + players already in this match preview
            const currentMatchIds = new Set([...currentA, ...currentB]);
            const eligiblePlayers = [
                ...allAvailablePlayers,
                ...state.players.filter(p => currentMatchIds.has(p.id) && !allAvailablePlayers.some(ap => ap.id === p.id))
            ];

            function renderEditor(errorMsg = '') {
                titleEl.textContent = '✨ Edit Auto-Generated Matchup';
                iconEl.hidden = true;
                box.classList.remove('has-icon');
                noteEl.textContent = 'Change any player using the dropdowns below, then add to queue.';
                noteEl.hidden = false;

                // Build Team columns with select dropdowns
                const container = document.createElement('div');
                container.className = 'preview-teams';

                const createTeamCol = (teamLabel, teamArray, teamKey) => {
                    const col = document.createElement('div');
                    col.className = 'preview-team';

                    const h = document.createElement('h4');
                    h.textContent = teamLabel;
                    col.append(h);

                    teamArray.forEach((playerId, idx) => {
                        const slotDiv = document.createElement('div');
                        slotDiv.className = 'preview-slot';

                        const label = document.createElement('label');
                        label.textContent = `Player ${idx + 1}`;

                        const select = document.createElement('select');
                        select.dataset.team = teamKey;
                        select.dataset.index = idx;

                        eligiblePlayers.forEach(p => {
                            const opt = document.createElement('option');
                            opt.value = p.id;
                            opt.textContent = `${p.name} (${LEVEL_LABELS[p.level]})`;
                            if (p.id === playerId) opt.selected = true;
                            select.append(opt);
                        });

                        select.addEventListener('change', e => {
                            const val = e.target.value;
                            if (teamKey === 'a') currentA[idx] = val;
                            else currentB[idx] = val;
                        });

                        slotDiv.append(label, select);
                        col.append(slotDiv);
                    });

                    return col;
                };

                container.append(createTeamCol('Team A', currentA, 'a'), createTeamCol('Team B', currentB, 'b'));

                // Wrap container and optional error message
                const wrapper = document.createElement('div');
                wrapper.style.display = 'grid';
                wrapper.style.gap = '8px';
                wrapper.append(container);

                if (errorMsg) {
                    const errP = document.createElement('p');
                    errP.className = 'form-error';
                    errP.style.margin = '0';
                    errP.textContent = errorMsg;
                    wrapper.append(errP);
                }

                textEl.replaceChildren(wrapper);
                textEl.hidden = false;

                // Action buttons
                const confirmBtn = document.createElement('button');
                confirmBtn.type = 'button';
                confirmBtn.className = 'btn btn-primary';
                confirmBtn.textContent = 'Add to queue';
                confirmBtn.onclick = () => {
                    // Validation check: ensure all 4 players are unique
                    const allSelected = [...currentA, ...currentB];
                    const uniquePlayers = new Set(allSelected);

                    if (uniquePlayers.size < 4) {
                        renderEditor('Each player must be unique. You cannot select the same player more than once.');
                        return;
                    }

                    closeModal({
                        a: currentA,
                        b: currentB
                    });
                };

                const cancelBtn = document.createElement('button');
                cancelBtn.type = 'button';
                cancelBtn.className = 'btn';
                cancelBtn.textContent = 'Cancel';
                cancelBtn.onclick = () => {
                    closeModal(null);
                };

                actionsEl.className = 'prompt-actions row';
                actionsEl.replaceChildren(cancelBtn, confirmBtn);
            }

            function closeModal(result) {
                root.hidden = true;
                document.body.classList.remove('prompt-open');
                resolve(result);
            }

            renderEditor();
            root.hidden = false;
            document.body.classList.add('prompt-open');
        });
    }

    // =====================================================================
    // Players: add, bulk add, edit, delete, search + filters.
    // After "Start queueing" the list is locked and cards become selectable:
    // first 2 picks = Team A, next 2 = Team B.
    // =====================================================================
    function initPlayers() {
        const form = document.getElementById('player-form');
        const nameInput = document.getElementById('player-name');
        const errorEl = document.getElementById('player-error');
        const submitBtn = document.getElementById('player-submit');
        const cancelBtn = document.getElementById('player-cancel');
        const list = document.getElementById('player-list');
        const emptyEl = document.getElementById('player-empty');
        const countEl = document.getElementById('player-count');
        const template = document.getElementById('player-item-template');
        const clearBtn = document.getElementById('player-clear');
        const endBtn = document.getElementById('session-end');
        const startBtn = document.getElementById('start-queue');
        const hintEl = document.getElementById('select-hint');
        const bulkEl = document.getElementById('bulk');
        const bulkForm = document.getElementById('bulk-form');
        const bulkText = document.getElementById('bulk-text');
        const bulkResult = document.getElementById('bulk-result');
        const toolbar = document.getElementById('player-toolbar');
        const searchInput = document.getElementById('player-search');
        const levelFilter = document.getElementById('filter-level');
        const statusFilter = document.getElementById('filter-status');
        const noResults = document.getElementById('no-results');
        const filterReset = document.getElementById('filter-reset');
        const autoBtn = document.getElementById('auto-match-btn');

        let editingId = null;
        let selected = []; // player ids in the order they were tapped
        let notice = null; // { text, count } message shown in place of the hint
        const filters = {
            query: '',
            level: 'all',
            status: 'all'
        };

        function resetFilters() {
            Object.assign(filters, {
                query: '',
                level: 'all',
                status: 'all'
            });
            searchInput.value = '';
            levelFilter.value = 'all';
            statusFilter.value = 'all';
        }

        function showError(msg) {
            errorEl.textContent = msg;
            errorEl.hidden = !msg;
        }

        function resetForm() {
            editingId = null;
            form.reset(); // restores "Beginner" as the default radio
            showError('');
            submitBtn.textContent = 'Add player';
            cancelBtn.hidden = true;
        }

        // player id -> null (waiting in the queue) or the court number they're playing on
        function busyMap() {
            const map = new Map();
            state.session.matches.forEach(m => [...m.a, ...m.b].forEach(id => map.set(id, null)));
            state.courts.forEach(c => {
                if (c.match)[...c.match.a, ...c.match.b].forEach(id => map.set(id, c.number));
            });
            return map;
        }

        // 'available' | 'in-queue' | 'in-game'
        const statusOf = (id, busy) => (!busy.has(id) ? 'available' : busy.get(id) ? 'in-game' : 'in-queue');

        function selectionHint() {
            if (notice && notice.count === state.session.matches.length) return notice.text;
            if (!selected.length) return 'Pick 4 players: the first 2 you tap are Team A, the next 2 are their opponents (Team B).';
            const parts = [`Team A: ${namesOf(selected.slice(0, 2))}`];
            if (selected.length > 2) parts.push(`Team B: ${namesOf(selected.slice(2))}`);
            return `${selected.length}/4 selected. ${parts.join('  vs  ')}`;
        }

        function buildItem(player, busy) {
            const li = template.content.firstElementChild.cloneNode(true);
            li.dataset.id = player.id;
            li.classList.toggle('editing', player.id === editingId);
            li.querySelector('.player-name').textContent = player.name;
            li.querySelector('.player-name').title = player.name;
            li.querySelector('.games').textContent = `Games: ${player.games ?? 0}`;
            const badge = li.querySelector('.badge');
            badge.textContent = LEVEL_LABELS[player.level];
            badge.dataset.level = player.level;

            // Always set accessibility labels for edit/delete buttons
            li.querySelector('[data-action="edit"]').setAttribute('aria-label', `Edit ${player.name}`);
            li.querySelector('[data-action="delete"]').setAttribute('aria-label', `Delete ${player.name}`);

            // If session has started, handle busy states and selectable team-picking states
            if (state.session.started) {
                if (busy.has(player.id)) {
                    const court = busy.get(player.id);
                    const status = li.querySelector('.player-status');
                    li.classList.add('busy');
                    li.setAttribute('aria-disabled', 'true');
                    status.textContent = court ? `In game · Court ${court}` : 'In queue';
                    status.classList.add(court ? 'in-game' : 'in-queue');
                    status.hidden = false;
                } else {
                    const i = selected.indexOf(player.id);
                    li.classList.add('selectable');
                    li.tabIndex = 0;
                    li.setAttribute('role', 'button');
                    li.setAttribute('aria-pressed', String(i >= 0));
                    if (i >= 0) {
                        const team = i < 2 ? 'a' : 'b';
                        const slot = li.querySelector('.slot');
                        li.classList.add(`sel-${team}`);
                        slot.textContent = `Team ${team.toUpperCase()}`;
                        slot.hidden = false;
                    }
                }
            }
            return li;
        }

        function render() {
            const started = state.session.started;
            const busy = busyMap();

            selected = selected.filter(id => playerById(id) && !busy.has(id));

            // statuses only mean something once the session has started; no players = no filters
            if (!state.players.length) resetFilters();
            if (!started) filters.status = 'all';
            statusFilter.hidden = !started;
            statusFilter.value = filters.status;

            const query = filters.query.trim().toLowerCase();
            const visible = state.players.filter(p =>
                (!query || p.name.toLowerCase().includes(query)) &&
                (filters.level === 'all' || p.level === filters.level) &&
                (filters.status === 'all' || statusOf(p.id, busy) === filters.status)
            );
            const filtering = !!query || filters.level !== 'all' || filters.status !== 'all';

            list.replaceChildren(...visible.map(p => buildItem(p, busy)));
            emptyEl.hidden = state.players.length > 0;
            toolbar.hidden = state.players.length === 0;
            noResults.hidden = !(filtering && state.players.length > 0 && visible.length === 0);
            countEl.textContent = filtering ? `${visible.length} of ${state.players.length}` : state.players.length;
            clearBtn.hidden = started || state.players.length === 0;
            endBtn.hidden = !started;

            startBtn.textContent = started ? 'Add players to queue' : 'Start queueing';
            startBtn.disabled = started ? selected.length !== 4 : state.players.length === 0;
            hintEl.hidden = !started;

            if (started) hintEl.textContent = selectionHint();

            const availablePlayers = state.players.filter(p => !busy.has(p.id));
            autoBtn.hidden = !started;
            autoBtn.disabled = availablePlayers.length < 4;

            const addPlayersEl = document.getElementById('add-players');
            if (started && !render.collapsedOnce) {
                addPlayersEl.open = false;
                render.collapsedOnce = true;
            }
            if (!started) render.collapsedOnce = false;
        }


        function toggleSelect(id) {
            notice = null;
            const i = selected.indexOf(id);
            if (i >= 0) selected.splice(i, 1);
            else if (selected.length < 4) selected.push(id);
            else notice = {
                text: 'You already picked 4. Tap a selected player to deselect them first.',
                count: state.session.matches.length
            };
            render();
            list.querySelector(`[data-id="${id}"]`)?.focus({
                preventScroll: true
            });
        }

        // Add or save changes
        form.addEventListener('submit', e => {
            e.preventDefault();
            const name = nameInput.value.trim();
            const level = form.elements.level.value;

            if (!name) return showError('Enter a player name.');
            const duplicate = state.players.some(p => p.id !== editingId && p.name.toLowerCase() === name.toLowerCase());
            if (duplicate) return showError(`${name} is already in the list.`);

            if (editingId) {
                state.players = state.players.map(p => (p.id === editingId ? {
                    ...p,
                    name,
                    level
                } : p));
            } else {
                resetFilters(); // so the new card isn't hidden by an old search
                state.players.push(makePlayer(name, level));
            }
            resetForm();
            commit();
            nameInput.focus();
        });

        cancelBtn.addEventListener('click', () => {
            resetForm();
            render();
        });

        // Bulk add
        bulkForm.addEventListener('submit', e => {
            e.preventDefault();
            const entries = parseBulkPlayers(bulkText.value);
            if (!entries.length) {
                bulkResult.textContent = "Couldn't find any player names in that text.";
                return;
            }

            const known = new Set(state.players.map(p => p.name.toLowerCase()));
            const skipped = [];
            let added = 0;
            for (const {
                    name,
                    level
                }
                of entries) {
                const key = name.toLowerCase();
                if (known.has(key)) {
                    skipped.push(name);
                    continue;
                }
                known.add(key);
                state.players.push(makePlayer(name, level));
                added++;
            }

            resetFilters();
            commit();
            if (added) bulkText.value = '';
            bulkResult.textContent =
                `Added ${added} player${added === 1 ? '' : 's'}.` +
                (skipped.length ? ` Skipped ${skipped.length} already in the list: ${skipped.join(', ')}.` : '');
        });

        // Card clicks: pick players after it starts
        list.addEventListener('click', async e => {
            const btn = e.target.closest('[data-action]');
            if (btn) {
                const id = btn.closest('.player').dataset.id;
                const player = playerById(id);
                if (!player) return;

                if (btn.dataset.action === 'edit') {
                    editingId = id;
                    nameInput.value = player.name;
                    form.elements.level.value = player.level;
                    showError('');
                    submitBtn.textContent = 'Save changes';
                    cancelBtn.hidden = false;
                    render();
                    nameInput.focus();
                    nameInput.scrollIntoView({
                        block: 'center',
                        behavior: 'smooth'
                    });
                } else if (btn.dataset.action === 'delete') {
                    const ok = await confirmAction({
                        title: `Delete ${player.name}?`,
                        text: "This can't be undone.",
                        confirmLabel: 'Delete',
                    });
                    if (!ok || !playerById(id)) return;
                    state.players = state.players.filter(p => p.id !== id);
                    if (id === editingId) resetForm();
                    commit();
                }
                return;
            }
            const card = e.target.closest('.player.selectable');
            if (card) toggleSelect(card.dataset.id);
        });

        list.addEventListener('keydown', e => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const card = e.target.closest('.player.selectable');
            if (card) {
                e.preventDefault();
                toggleSelect(card.dataset.id);
            }
        });

        // Delete all (only before the session starts)
        clearBtn.addEventListener('click', async () => {
            const count = state.players.length;
            if (!count) return;
            const ok = await confirmAction({
                title: 'Delete all players?',
                text: `All ${count} players will be removed. This can't be undone.`,
                confirmLabel: 'Delete all',
            });
            if (!ok || state.session.started) return;
            state.players = [];
            resetForm();
            commit();
            bulkResult.textContent = '';
        });

        // Start queueing -> then "Add players to queue"
        startBtn.addEventListener('click', async () => {
            if (!state.session.started) {
                if (!state.players.length) return;
                const ok = await confirmAction({
                    title: 'Start queueing?',
                    confirmLabel: 'Confirm',
                    danger: false,
                });
                if (!ok || state.session.started || !state.players.length) return;
                resetForm();
                selected = [];
                notice = null;
                state.session.started = true;
                document.getElementById('add-players').open = false;   
                commit();
                return;
            }

            if (selected.length !== 4) return;
            const session = state.session;
            const [a1, a2, b1, b2] = selected;
            const match = {
                id: newId(),
                no: ++session.counter,
                a: [a1, a2],
                b: [b1, b2],
                createdAt: Date.now()
            };
            session.matches.push(match);
            selected = [];
            notice = {
                text: `Match ${match.no} added to the queue. Pick 4 more players for the next match, or open the Queue tab.`,
                count: session.matches.length,
            };
            commit(); // stays on the Players page
        });

        // Auto-generate balanced matchup with interactive preview editor
        autoBtn.addEventListener('click', async () => {
            const busy = busyMap();
            const available = state.players.filter(p => !busy.has(p.id));

            if (available.length < 4) {
                flash(hintEl, 'Not enough available players (need at least 4 free players not currently in a game or queue).');
                return;
            }

            // 1. Fairness priority: Sort by games played ascending
            const sortedByGames = [...available].sort((x, y) => (x.games ?? 0) - (y.games ?? 0));
            const candidates = sortedByGames.slice(0, 4);

            // 2. Skill level ranking for fair team balancing
            const skillRanks = {
                beginner: 1,
                intermediate: 2,
                'upper-intermediate': 3,
                advanced: 4
            };
            candidates.sort((x, y) => (skillRanks[x.level] || 1) - (skillRanks[y.level] || 1));

            // 3. Initial balanced pairing (Snake pairing)
            const initialA = [candidates[0].id, candidates[3].id];
            const initialB = [candidates[1].id, candidates[2].id];

            // Open interactive match editor modal
            const editedMatch = await openInteractiveMatchEditor(initialA, initialB, available);
            if (!editedMatch) return; // Cancelled

            const session = state.session;
            const match = {
                id: newId(),
                no: ++session.counter,
                a: editedMatch.a,
                b: editedMatch.b,
                createdAt: Date.now()
            };

            session.matches.push(match);
            selected = [];
            notice = {
                text: `✨ Auto-generated Match ${match.no} added to the queue!`,
                count: session.matches.length,
            };
            commit();
        });

        // End session: clears the queue, courts, history and payments, resets stats, unlocks the player list
        endBtn.addEventListener('click', async () => {
            const ok = await confirmAction({
                title: 'End the session?',
                text: 'The queue, matches on courts, match history, games and payments will be cleared.',
                confirmLabel: 'End session',
            });
            if (!ok) return;
            state.players.forEach(resetSessionData);
            state.courts.forEach(c => {
                c.match = null;
            });
            state.session = {
                started: false,
                matches: [],
                counter: 0
            };
            state.history = [];
            state.fees.expenses = 0;
            selected = [];
            notice = null;
            document.getElementById('add-players').open = true;
            commit();
        });

        // Search + filters
        searchInput.addEventListener('input', () => {
            filters.query = searchInput.value;
            render();
        });
        levelFilter.addEventListener('change', () => {
            filters.level = levelFilter.value;
            render();
        });
        statusFilter.addEventListener('change', () => {
            filters.status = statusFilter.value;
            render();
        });
        filterReset.addEventListener('click', () => {
            resetFilters();
            render();
            searchInput.focus();
        });

        onChange(render);
        render();
    }

    // =====================================================================
    // Queue: lists queued matches. Picking a court moves the match to the Court page.
    // =====================================================================
    function initQueue() {
        const list = document.getElementById('match-list');
        const emptyEl = document.getElementById('queue-empty');
        const countEl = document.getElementById('match-count');
        const noticeEl = document.getElementById('queue-notice');
        const template = document.getElementById('match-template');

        function buildMatch(match, index) {
            const li = template.content.firstElementChild.cloneNode(true);
            li.dataset.id = match.id;
            li.querySelector('.match-title').textContent = `Match ${match.no ?? index + 1}`;
            fillTeams(li, match);

            const buttons = li.querySelector('.court-buttons');
            if (!state.courts.length) buttons.textContent = 'No courts yet. Add one on the Court page.';
            state.courts.forEach(court => {
                const inUse = !!court.match;
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'btn court-btn';
                btn.dataset.action = 'court';
                btn.dataset.court = court.number;
                btn.textContent = inUse ? `Court ${court.number} (in use)` : `Court ${court.number}`;
                btn.disabled = inUse;
                buttons.append(btn);
            });
            return li;
        }

        function render() {
            const matches = state.session.matches;
            list.replaceChildren(...matches.map(buildMatch));
            emptyEl.hidden = matches.length > 0;
            countEl.textContent = matches.length;
        }


        list.addEventListener('click', e => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;

            const card = btn.closest('.match');
            if (!card) return;

            const matches = state.session.matches;
            const index = matches.findIndex(m => m.id === card.dataset.id);

            if (index < 0) return;

            // Remove a match from the queue
            if (btn.dataset.action === 'remove') {
                const [removed] = matches.splice(index, 1);

                commit();

                flash(
                    noticeEl,
                    `Match ${removed.no ?? index + 1} removed from the queue.`
                );
                return;
            }

            // Assign a queued match to a court
            if (btn.dataset.action !== 'court' || btn.disabled) return;

            const court = state.courts.find(
                c => c.number === Number(btn.dataset.court)
            );

            if (!court || court.match) return;

            const [match] = matches.splice(index, 1);

            court.match = {
                id: match.id,
                no: match.no ?? index + 1,
                a: match.a,
                b: match.b,
                startedAt: Date.now()
            };

            commit();

            flash(
                noticeEl,
                `Match ${court.match.no} assigned to Court ${court.number}. Manage it on the Court page.`
            );
        });


        onChange(render);
        render();
    }

    // =====================================================================
    // Courts: status, live match details, and complete / cancel / delete.
    // =====================================================================
    function initCourts() {
        const list = document.getElementById('court-list');
        const template = document.getElementById('court-template');
        const addBtn = document.getElementById('court-add');
        const emptyEl = document.getElementById('court-empty');
        const toast = document.getElementById('court-toast');

        function formatElapsed(ms) {
            const total = Math.max(0, Math.floor(ms / 1000));
            const h = Math.floor(total / 3600);
            const m = Math.floor((total % 3600) / 60);
            const s = total % 60;
            const pad = n => String(n).padStart(2, '0');
            return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
        }

        // Updates every running timer without re-rendering the cards
        function tick() {
            list.querySelectorAll('.elapsed[data-started]').forEach(el => {
                el.textContent = formatElapsed(Date.now() - Number(el.dataset.started));
            });
        }

        function buildCourt(court) {
            const li = template.content.firstElementChild.cloneNode(true);
            li.dataset.number = court.number;
            li.querySelector('.court-title').textContent = `Court ${court.number}`;

            const m = court.match;
            const status = li.querySelector('.court-status');
            status.textContent = m ? 'Occupied' : 'Available';
            status.classList.add(m ? 'occupied' : 'available');

            li.querySelector('.court-empty').hidden = !!m;
            li.querySelector('.court-details').hidden = !m;
            li.querySelector('.court-foot').hidden = !m;
            const delBtn = li.querySelector('[data-action="delete-court"]');
            delBtn.disabled = !!m;
            delBtn.title = m ? 'Complete or cancel the match before deleting this court' : 'Delete court';

            if (m) {
                li.querySelector('.started').textContent = formatClock(m.startedAt);
                li.querySelector('.elapsed').dataset.started = m.startedAt;
                fillTeams(li, m);
            }
            return li;
        }

        function render() {
            list.replaceChildren(...state.courts.map(buildCourt));
            emptyEl.hidden = state.courts.length > 0;
            tick();
        }

        // Step 1: ask who won
        async function completeMatch(court) {
            const m = court.match;
            const result = await ask({
                title: `Complete match on Court ${court.number}`,
                text: 'Who won?',
                cancelLabel: 'Back',
                choices: [{
                        label: 'Team A won',
                        sub: namesOf(m.a),
                        value: 'a',
                        kind: 'team'
                    },
                    {
                        label: 'Team B won',
                        sub: namesOf(m.b),
                        value: 'b',
                        kind: 'team'
                    },
                    {
                        label: 'Draw',
                        value: 'draw'
                    },
                ],
            });
            if (!result || court.match?.id !== m.id) return; // backed out, or the match changed meanwhile
            recordResult(court, result);
        }

        // Step 2: record the result, save it to history, and notify. result: 'a' | 'b' | 'draw'
        function recordResult(court, result) {
            const m = court.match;
            const winners = result === 'a' ? m.a : result === 'b' ? m.b : [];
            [...m.a, ...m.b].forEach(id => {
                const p = playerById(id);
                if (!p) return;
                p.games = (p.games ?? 0) + 1;
                if (result === 'draw') p.draws = (p.draws ?? 0) + 1;
                else if (winners.includes(id)) p.wins = (p.wins ?? 0) + 1;
                else p.losses = (p.losses ?? 0) + 1;
            });

            const summary = result === 'draw' ?
                `It's a draw: ${namesOf(m.a)} vs ${namesOf(m.b)}` :
                `Team ${result.toUpperCase()} won: ${namesOf(winners)}`;

            state.history.push({
                id: newId(),
                no: m.no,
                court: court.number,
                startedAt: m.startedAt,
                endedAt: Date.now(),
                a: nameList(m.a),
                b: nameList(m.b),
                result,
            });

            court.match = null;
            commit();

            ask({
                icon: '✅',
                title: 'Match complete',
                text: summary,
                note: `Match ${m.no} on Court ${court.number} complete!`,
                cancelLabel: null,
                choices: [{
                    label: 'OK',
                    value: true,
                    kind: 'primary'
                }],
            });
            flash(toast, `✅ Match ${m.no} on Court ${court.number} is complete. ${summary}`);
        }

        addBtn.addEventListener('click', () => {
            const next = Math.max(0, ...state.courts.map(c => c.number)) + 1;
            state.courts.push({
                number: next,
                match: null
            });
            commit();
        });

        // Court card buttons: complete / cancel / delete court
        list.addEventListener('click', async e => {
            const btn = e.target.closest('[data-action]');
            if (!btn || btn.disabled) return;
            const court = state.courts.find(c => c.number === Number(btn.closest('.court').dataset.number));
            if (!court) return;
            const action = btn.dataset.action;

            if (action === 'complete' && court.match) {
                completeMatch(court); // the match is only cleared once a result is picked
            } else if (action === 'cancel' && court.match) {
                const matchId = court.match.id;
                const ok = await confirmAction({
                    title: `Cancel the match on Court ${court.number}?`,
                    text: 'No games are counted and the players become available again.',
                    confirmLabel: 'Cancel match',
                    cancelLabel: 'Keep match',
                });
                if (!ok || court.match?.id !== matchId) return;
                court.match = null;
                commit();
            } else if (action === 'delete-court' && !court.match) {
                const ok = await confirmAction({
                    title: `Delete Court ${court.number}?`,
                    text: "This can't be undone.",
                    confirmLabel: 'Delete court',
                });
                if (!ok || court.match || !state.courts.includes(court)) return;
                state.courts.splice(state.courts.indexOf(court), 1);
                commit();
            }
        });

        setInterval(tick, 1000);
        onChange(render);
        render();
    }

    // =====================================================================
    // Match history: finished matches, newest first, with the winner marked 🏆
    // =====================================================================
    function initHistory() {
        const list = document.getElementById('history-list');
        const emptyEl = document.getElementById('history-empty');
        const countEl = document.getElementById('history-count');
        const template = document.getElementById('history-template');

        function fillTeam(li, selector, label, names, won) {
            const team = li.querySelector(selector);
            team.classList.toggle('winner', won);
            team.title = won ? 'Winner' : '';
            team.querySelector('.team-label').textContent = won ? `🏆 ${label}` : label;
            team.querySelector('.team-players').replaceChildren(...names.map(buildNameLi));
        }

        function buildItem(h) {
            const li = template.content.firstElementChild.cloneNode(true);
            li.querySelector('.history-title').textContent = `Match ${h.no}`;
            li.querySelector('.history-time').textContent = `Started ${formatClock(h.startedAt)}`;
            fillTeam(li, '.team-a', 'Team A', h.a, h.result === 'a');
            fillTeam(li, '.team-b', 'Team B', h.b, h.result === 'b');
            li.querySelector('.history-draw').hidden = h.result !== 'draw';
            return li;
        }

        function render() {
            list.replaceChildren(...[...state.history].reverse().map(buildItem));
            emptyEl.hidden = state.history.length > 0;
            countEl.textContent = state.history.length;
        }

        onChange(render);
        render();
    }

    // =====================================================================
    // Rankings: session leaderboard, ranked by wins (then win %, then draws)
    // =====================================================================
    function initLeaderboard() {
        const body = document.getElementById('leaderboard-body');
        const wrap = document.getElementById('leaderboard-wrap');
        const emptyEl = document.getElementById('leaderboard-empty');
        const countEl = document.getElementById('leaderboard-count');

        function rankedRows() {
            const rows = state.players.map(p => {
                const games = p.games ?? 0;
                const wins = p.wins ?? 0;
                return {
                    name: p.name,
                    games,
                    wins,
                    draws: p.draws ?? 0,
                    losses: p.losses ?? 0,
                    pct: games ? wins / games : 0
                };
            });

            // players who have played first, then by wins, win %, draws, name
            rows.sort((a, b) =>
                (b.games > 0) - (a.games > 0) ||
                b.wins - a.wins ||
                b.pct - a.pct ||
                b.draws - a.draws ||
                a.name.localeCompare(b.name));

            // identical records share a rank (1, 2, 2, 4); players with no games are unranked
            rows.forEach((r, i) => {
                const prev = rows[i - 1];
                const tied = prev && prev.games && prev.wins === r.wins && prev.pct === r.pct && prev.draws === r.draws;
                r.rank = !r.games ? null : tied ? prev.rank : i + 1;
            });
            return rows;
        }

        function buildRow(r) {
            const tr = document.createElement('tr');
            const cells = [
                r.rank ?? '–',
                r.name,
                r.wins,
                r.draws,
                r.losses,
                r.games,
                r.games ? `${Math.round(r.pct * 100)}%` : '–',
            ];
            cells.forEach((value, i) => {
                const td = document.createElement('td');
                td.textContent = value; // textContent: safe for player names
                if (i !== 1) td.className = 'num';
                tr.append(td);
            });
            return tr;
        }

        function render() {
            const rows = rankedRows();
            body.replaceChildren(...rows.map(buildRow));
            emptyEl.hidden = rows.length > 0;
            wrap.hidden = rows.length === 0;
            countEl.textContent = rows.length;
        }

        onChange(render);
        render();
    }

    // =====================================================================
    // Payments: court fee per player, summary boxes, and a per-player table
    // with Paid (cash / digital) and Rollback.
    // =====================================================================
    function initPayments() {
        const feeInput = document.getElementById('fee-input');
        const expensesInput = document.getElementById('expenses-input');
        const collectedEl = document.getElementById('stat-collected');
        const outstandingEl = document.getElementById('stat-outstanding');
        const netEl = document.getElementById('stat-net');
        const body = document.getElementById('payments-body');
        const wrap = document.getElementById('payments-wrap');
        const emptyEl = document.getElementById('payments-empty');

        const toAmount = input => Math.max(0, parseFloat(input.value) || 0);
        
        // 1. A paid player keeps the fee they paid; everyone else uses base fee minus their discount
        const feeOf = p => (p.payment ? p.payment.amount : Math.max(0, state.fees.perPlayer - (p.discount ?? 0)));

        // Don't overwrite an input while the user is typing in it
        function syncInput(input, value) {
            if (document.activeElement !== input) input.value = value || '';
        }

        function cell(text, className) {
            const td = document.createElement('td');
            td.textContent = text;
            if (className) td.className = className;
            return td;
        }

        function actionButton(label, className, action) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `btn btn-sm ${className}`;
            btn.dataset.action = action;
            btn.textContent = label;
            return btn;
        }

        function buildRow(p) {
            const tr = document.createElement('tr');
            tr.dataset.id = p.id;
            
            // Display name, games, and net court fee (with discount applied)
            const displayFee = feeOf(p);
            const feeText = p.discount ? `${money(displayFee)} (disc. ${money(p.discount)})` : money(displayFee);
            tr.append(cell(p.name), cell(p.games ?? 0, 'num'), cell(feeText, 'num'));

            const actions = document.createElement('div');
            actions.className = 'pay-actions';
            if (p.payment) {
                const tag = document.createElement('span');
                tag.className = 'pay-tag';
                tag.textContent = `Paid · ${p.payment.method === 'cash' ? 'Cash' : 'Digital'}`;
                actions.append(tag, actionButton('Rollback payment', 'btn-danger', 'rollback'));
            } else {
                const btn = actionButton('Paid', 'btn-primary', 'pay');
                btn.disabled = state.fees.perPlayer <= 0;
                btn.title = btn.disabled ? 'Enter the court fee first' : '';
                actions.append(btn);
            }

            const td = document.createElement('td');
            td.className = 'actions-col';
            td.append(actions);
            tr.append(td);
            return tr;
        }

        function render() {
            const {
                perPlayer,
                expenses
            } = state.fees;
            const paid = state.players.filter(p => p.payment);
            const collected = round2(paid.reduce((sum, p) => sum + p.payment.amount, 0));
            
            // 2. Outstanding calculation sums up individual discounted fees for unpaid players
            const unpaid = state.players.filter(p => !p.payment);
            const outstanding = round2(unpaid.reduce((sum, p) => sum + Math.max(0, perPlayer - (p.discount ?? 0)), 0));
            
            const net = round2(collected - expenses);

            syncInput(feeInput, perPlayer);
            syncInput(expensesInput, expenses);
            collectedEl.textContent = money(collected);
            outstandingEl.textContent = money(outstanding);
            netEl.textContent = money(net);
            netEl.classList.toggle('positive', net > 0);
            netEl.classList.toggle('negative', net < 0);

            body.replaceChildren(...state.players.map(buildRow));
            emptyEl.hidden = state.players.length > 0;
            wrap.hidden = state.players.length === 0;
        }

        // Fee + expenses save as you type; on blur the box is tidied
        feeInput.addEventListener('input', () => {
            state.fees.perPlayer = toAmount(feeInput);
            commit();
        });
        expensesInput.addEventListener('input', () => {
            state.fees.expenses = toAmount(expensesInput);
            commit();
        });
        feeInput.addEventListener('blur', render);
        expensesInput.addEventListener('blur', render);

        const discountBtn = document.getElementById('discount-btn');

        discountBtn.addEventListener('click', async () => {
            if (!state.players.length) return;
            const result = await openDiscountModal(state.players);
            if (!result) return;

            const player = playerById(result.playerId);
            if (!player) return;

            player.discount = result.amount;
            commit();
        });

        // Paid -> choose cash or digital. Rollback -> confirm, then mark unpaid again.
        body.addEventListener('click', async e => {
            const btn = e.target.closest('[data-action]');
            if (!btn || btn.disabled) return;
            const id = btn.closest('tr').dataset.id;
            const player = playerById(id);
            if (!player) return;

            if (btn.dataset.action === 'pay') {
                // 3. Record payment using the player's discounted fee amount
                const baseFee = state.fees.perPlayer;
                const discount = player.discount ?? 0;
                const fee = Math.max(0, baseFee - discount);

                const method = await ask({
                    title: 'Record payment',
                    text: `${player.name} · ${money(fee)}. Select payment method:`,
                    cancelLabel: 'Back',
                    choices: [{
                            label: '💵 Cash',
                            value: 'cash'
                        },
                        {
                            label: '📱 Digital',
                            value: 'digital'
                        },
                    ],
                });
                const current = playerById(id);
                if (!method || !current || current.payment) return;
                current.payment = {
                    method,
                    amount: fee,
                    paidAt: Date.now()
                };
                commit();
            } else if (btn.dataset.action === 'rollback' && player.payment) {
                const {
                    amount,
                    method
                } = player.payment;
                const ok = await confirmAction({
                    title: 'Roll back payment?',
                    text: `${player.name}'s ${money(amount)} ${method} payment will be removed and they'll be marked as unpaid again.`,
                    confirmLabel: 'Roll back',
                    cancelLabel: 'Keep payment',
                });
                const current = playerById(id);
                if (!ok || !current?.payment) return;
                current.payment = null;
                commit();
            }
        });

        onChange(render);
        render();
    }

    function openDiscountModal(players) {
      const root = document.getElementById('prompt');
      const box = root.querySelector('.prompt');
      const iconEl = document.getElementById('prompt-icon');
      const titleEl = document.getElementById('prompt-title');
      const textEl = document.getElementById('prompt-text');
      const noteEl = document.getElementById('prompt-note');
      const actionsEl = document.getElementById('prompt-actions');

      return new Promise(resolve => {
        let selectedPlayerId = players[0]?.id || '';
        let discountAmount = '';

        function renderModal(errorMsg = '') {
          titleEl.textContent = '🏷️ Set Player Discount';
          iconEl.hidden = true;
          box.classList.remove('has-icon');
          noteEl.hidden = true;

          const formDiv = document.createElement('div');
          formDiv.className = 'discount-form';

          // Player Dropdown
          const playerField = document.createElement('div');
          playerField.className = 'discount-field';
          const playerLabel = document.createElement('label');
          playerLabel.textContent = 'Select player';
          const select = document.createElement('select');
          players.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = p.name;
            if (p.id === selectedPlayerId) opt.selected = true;
            select.append(opt);
          });
          select.onchange = e => { selectedPlayerId = e.target.value; };
          playerField.append(playerLabel, select);

          // Amount Input
          const amountField = document.createElement('div');
          amountField.className = 'discount-field';
          const amountLabel = document.createElement('label');
          amountLabel.textContent = 'Discount amount (₱)';
          const input = document.createElement('input');
          input.type = 'number';
          input.inputMode = 'decimal';
          input.min = '0';
          input.step = 'any';
          input.placeholder = '0';
          input.value = discountAmount;
          input.oninput = e => { discountAmount = e.target.value; };
          amountField.append(amountLabel, input);

          formDiv.append(playerField, amountField);

          if (errorMsg) {
            const errP = document.createElement('p');
            errP.className = 'form-error';
            errP.style.margin = '0';
            errP.textContent = errorMsg;
            formDiv.append(errP);
          }

          textEl.replaceChildren(formDiv);
          textEl.hidden = false;

          // Buttons
          const confirmBtn = document.createElement('button');
          confirmBtn.type = 'button';
          confirmBtn.className = 'btn btn-primary';
          confirmBtn.textContent = 'Apply discount';
          confirmBtn.onclick = () => {
            const amt = parseFloat(discountAmount);
            if (isNaN(amt) || amt < 0) {
              renderModal('Please enter a valid discount amount.');
              return;
            }
            closeModal({ playerId: selectedPlayerId, amount: amt });
          };

          const cancelBtn = document.createElement('button');
          cancelBtn.type = 'button';
          cancelBtn.className = 'btn';
          cancelBtn.textContent = 'Cancel';
          cancelBtn.onclick = () => closeModal(null);

          actionsEl.className = 'prompt-actions row';
          actionsEl.replaceChildren(cancelBtn, confirmBtn);
        }

        function closeModal(result) {
          root.hidden = true;
          document.body.classList.remove('prompt-open');
          resolve(result);
        }

        renderModal();
        root.hidden = false;
        document.body.classList.add('prompt-open');
      });
    }

    // =====================================================================
    // Start
    // =====================================================================
    loadState();
    initPrompts();
    initRouter();
    initTabs();
    initPlayers();
    initQueue();
    initCourts();
    initHistory();
    initLeaderboard();
    initPayments();
})();
