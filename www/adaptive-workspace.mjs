// Shared presentation layer for the web client and Android shell.
// No transport or database ownership: all writes stay in the host app.
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const ICONS = {
  sun: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></svg>',
  moon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 14A9 9 0 0 1 10 3.5 9 9 0 1 0 20.5 14Z"/></svg>',
};
export function workspaceTheme(stored) {
  try { const chosen = localStorage.getItem('workspace-theme'); if (chosen) return chosen; } catch {}
  return stored?.startsWith('adaptive-') ? stored : 'adaptive-light';
}
export function dailyHeading(date, today) {
  const parsed = new Date(date + 'T12:00:00');
  return { eyebrow: date === today ? 'YOUR DAILY SPACE' : 'DAILY JOURNAL',
    title: parsed.toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' }),
    description: date === today ? 'A little clarity. A good place to begin.' : 'Your priorities, plans, and notes for this day.' };
}
let callbacks, mounted = false, syncObserver;
export function mountWorkspace(actions) {
  callbacks = actions;
  if (mounted) return;
  mounted = true;
  $('#workspace-theme-toggle')?.addEventListener('click', () => callbacks.theme(document.documentElement.dataset.theme === 'adaptive-dark' ? 'adaptive-light' : 'adaptive-dark'));
  $('#workspace-capture')?.addEventListener('click', () => callbacks.capture());
  $('#menu-btn')?.addEventListener('click', () => {
    const open = $('#sidebar')?.classList.contains('open');
    $('#menu-btn').setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('workspace-nav-open', open);
  });
  // One delegated listener covers both the existing Android bar and web bar.
  $('#bottom-nav')?.addEventListener('click', e => {
    const button = e.target.closest('[data-tab]');
    if (button && !button.dataset.workspaceBound) callbacks.navigate(button.dataset.tab);
  });
  // Existing host listeners bind Android bottom tabs. Mark them to avoid
  // a second navigation; the new web tabs are bound by the host too.
  $$('#bottom-nav [data-tab]').forEach(b => {
    b.dataset.workspaceBound = 'true';
    if (!b.querySelector('svg')) { const icon = document.querySelector(`#sidebar [data-tab="${b.dataset.tab}"] svg`); if (icon) b.prepend(icon.cloneNode(true)); }
  });
  document.addEventListener('click', e => {
    if (e.target.closest('#sidebar .tab-btn')) closeNavigation();
    if (document.body.classList.contains('workspace-nav-open') && !e.target.closest('#sidebar, #menu-btn')) closeNavigation();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeNavigation(); });
  const status = $('#sync-status');
  if (status) { syncObserver = new MutationObserver(updateSaveIndicator); syncObserver.observe(status, { childList: true, characterData: true, subtree: true }); }
  updateSaveIndicator();
}
function closeNavigation() {
  $('#sidebar')?.classList.remove('open'); document.body.classList.remove('workspace-nav-open');
  $('#menu-btn')?.setAttribute('aria-expanded', 'false');
}
function updateSaveIndicator() {
  const status = $('#sync-status'), badge = $('#workspace-save-indicator');
  if (!badge || !status) return;
  const text = status.textContent || '';
  const error = /ERROR:|not saved/i.test(text), conflicts = /conflicts [1-9]|[1-9]\d* edits? needs? review/i.test(text);
  const queued = /outbox ([1-9]\d*)/.exec(text);
  badge.textContent = error ? 'Needs attention' : conflicts ? 'Review edits' : queued ? `${queued[1]} waiting to sync` : /last sync/.test(text) ? 'Up to date' : 'On this device';
  badge.dataset.state = error || conflicts ? 'attention' : queued ? 'pending' : 'ready';
  badge.title = text || 'Local workspace ready';
  $('#workspace-sync-detail')?.classList.toggle('has-alert', error || conflicts);
}
function node(tag, cls, text) { const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; }
const descriptions = {
  dashboard: 'A clear view of what matters.', tasks: 'Make room for the next good thing.',
  notes: 'Thoughts, ideas, and things worth keeping.', projects: 'Turn your intentions into next steps.',
  reading: 'Good things to come back to.', people: 'The people connected to your work and life.',
  inbox: 'Capture now. Find the right place later.', search: 'Pick up a thread. Find something useful.',
  calendar: 'A little perspective on the days ahead.', review: 'Close the loops. Set a direction.',
  feed: 'A quieter place to catch up.', management: 'Make this workspace yours.',
};
export function decorateWorkspace(info) {
  const main = $('#main'); if (!main) return;
  document.body.dataset.workspaceView = info.item ? 'document' : info.tab;
  $('#workspace-section').textContent = info.item ? 'Document' : info.label;
  const dark = document.documentElement.dataset.theme === 'adaptive-dark';
  const themeButton = $('#workspace-theme-toggle');
  if (themeButton) { themeButton.innerHTML = dark ? ICONS.sun : ICONS.moon; themeButton.setAttribute('aria-label', dark ? 'Switch to warm light' : 'Switch to soft dark'); themeButton.title = themeButton.getAttribute('aria-label'); }
  $$('.tab-btn[data-tab]').forEach(b => {
    b.setAttribute('aria-current', b.dataset.tab === info.tab ? 'page' : 'false');
    if (!b.title) b.title = b.textContent.trim();
  });
  if (!info.item) {
    const heading = info.tab === 'daily' ? dailyHeading(info.date, info.today) : { eyebrow: 'PERSONAL WORKSPACE', title: info.label, description: descriptions[info.tab] || 'Your information, connected.' };
    const hero = node('section', 'workspace-page-heading'); hero.setAttribute('aria-label', heading.title);
    const copy = node('div', 'workspace-page-copy'); copy.append(node('p', 'workspace-eyebrow', heading.eyebrow), node('h1', '', heading.title), node('p', 'workspace-description', heading.description)); hero.append(copy);
    if (info.tab === 'daily' || info.tab === 'dashboard') {
      const metrics = node('div', 'workspace-metrics');
      for (const [label, value] of [['focus', info.focus], ['due today', info.due], ['commitments', info.commitments]]) {
        const item = node('div', 'workspace-metric'); item.append(node('strong', '', String(value)), node('span', '', label)); metrics.append(item);
      }
      hero.append(metrics);
    }
    main.prepend(hero);
    if (info.tab === 'daily') arrangeDaily(main);
    if (info.tab === 'dashboard') {
      // Overview opens on primary work; weather becomes secondary.
      const weather = $('[data-panel-id="dash-weather"]', main); if (weather) main.append(weather);
    }
    // Avoid repeating the page title when a legacy view already supplies one.
    for (const h of $$(':scope > h2', main)) if (h.textContent.trim() === info.label) h.classList.add('workspace-visually-hidden');
  }
  labelControls(main);
  updateSaveIndicator();
}
function arrangeDaily(main) {
  const nav = $('[data-daily-nav]', main); nav?.classList.add('workspace-date-nav');
  const panels = $$(':scope > .panel', main).filter(el => el.tagName !== 'DETAILS');
  const find = prefix => panels.find(el => /^h3$/i.test(el.firstElementChild?.tagName || '') && el.firstElementChild.textContent.startsWith(prefix));
  const focus = find('Focus today'), due = find('Due Today'), schedule = find('Schedule'), notes = find('Notes');
  focus?.classList.add('workspace-focus'); due?.classList.add('workspace-due'); schedule?.classList.add('workspace-schedule'); notes?.classList.add('workspace-journal');
  if (notes) { notes.querySelector('h3').textContent = 'Daily note'; notes.querySelector('textarea')?.setAttribute('placeholder', 'Make a little space for your thoughts…'); }
  if (due || schedule || notes) {
    const grid = node('div', 'workspace-daily-grid');
    const work = node('div', 'workspace-daily-work'), journal = node('div', 'workspace-daily-journal');
    if (focus) { main.insertBefore(grid, focus); work.append(focus); }
    else main.insertBefore(grid, due || schedule || notes);
    if (due) work.append(due); if (schedule) journal.append(schedule); if (notes) journal.append(notes);
    grid.append(work, journal);
    // Move the existing full-note action with the journal, without rebinding it.
    const edit = $$(':scope > p', main).find(p => p.querySelector('[data-open^="notes:"]'));
    if (edit) journal.append(edit);
  }
  for (const el of $$(':scope > details[data-panel-id]', main)) el.classList.add('workspace-secondary');
}
function labelControls(root) {
  let i = 0;
  for (const control of $$('input:not([type="hidden"]),select,textarea', root)) {
    if (!control.id) control.id = `workspace-field-${root.id || 'editor'}-${i++}`;
    const label = control.closest('.cf-field')?.querySelector('label');
    if (label && !label.htmlFor) label.htmlFor = control.id;
    if (!control.getAttribute('aria-label') && !label && !control.labels?.length) control.setAttribute('aria-label', control.getAttribute('placeholder') || control.name || 'Value');
  }
}
export function decorateWorkspaceEditor(root, { ref, close, fullPage = false } = {}) {
  if (!root) return;
  const card = fullPage ? root.querySelector('.notebook') || root : $('.popup-card', root);
  if (!card) return;
  if (!fullPage) {
    const backdrop = $('.popup-backdrop', root);
    backdrop.classList.toggle('workspace-detail', !!ref);
    card.setAttribute('aria-modal', 'true'); card.tabIndex = -1;
    document.body.classList.add('workspace-editor-open');
    const actions = $('.popup-head-actions', root);
    const expand = node('button', 'ghost-btn workspace-expand', 'Expand'); expand.type = 'button'; expand.setAttribute('aria-label', 'Expand editor'); expand.setAttribute('aria-pressed', 'false');
    expand.onclick = () => { const on = backdrop.classList.toggle('workspace-expanded'); expand.textContent = on ? 'Compact' : 'Expand'; expand.setAttribute('aria-pressed', String(on)); };
    if (actions) actions.prepend(expand);
    if (close && !actions?.querySelector('button[type="submit"]')) {
      const dismiss = node('button', 'ghost-btn', 'Close'); dismiss.type = 'button'; dismiss.onclick = close; actions?.append(dismiss);
    }
    const status = node('p', 'workspace-editor-status', 'Changes apply when you save.'); status.setAttribute('role', 'status');
    $('.popup-head', root)?.after(status);
    if (root.workspaceInputListener) root.removeEventListener('input', root.workspaceInputListener);
    root.workspaceInputListener = () => { status.textContent = 'Unsaved changes · Save & close when ready'; status.dataset.dirty = 'true'; };
    root.addEventListener('input', root.workspaceInputListener, { once: true });
    // There is already a save action in the sticky header.
    if (actions?.querySelector('button[type="submit"]')) $$('.popup-actions button[type="submit"]', root).forEach(b => b.classList.add('workspace-duplicate-save'));
    const open = actions?.querySelector('[data-open-page]'); if (open) open.textContent = 'Full page';
  }
  for (const form of $$('form[data-edit-note], form[data-create-note-popup]', card)) {
    if (form.querySelector('.workspace-properties')) continue;
    form.classList.add('workspace-document-form');
    const metadata = [...form.children].filter(el => {
      if (el.classList.contains('cf-field')) return !el.querySelector('[name="title"], textarea[name="body"], .md-editor');
      return el.matches('h4') && el.textContent === 'Tags' || el.matches('[data-tag-input]');
    });
    if (metadata.length) {
      const details = node('details', 'workspace-properties'); details.append(node('summary', '', 'Properties & tags'));
      metadata[0].before(details); metadata.forEach(el => details.append(el));
    }
  }
  labelControls(card);
}
export function restoreWorkspaceEditor() { document.body.classList.remove('workspace-editor-open'); }
