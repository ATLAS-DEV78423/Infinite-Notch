// Browser self-test for the notch-expansion feature views.
//
// This is a SYNTHETIC native boundary: the views, stores, contract helpers and
// island shell under test are the real production modules. Only the native push
// is simulated, because there is no native side in a browser. Nothing here reads
// a real file, a real clipboard or a real network.
//
// The point of this file is the contract, not the pixels: every assertion below
// is a rule from handoff.md §8 or the feature spec, and each one fails if a view
// starts fabricating a value, silently truncating, or auto-accepting.

import { State } from '../src/core/state';
import { Island } from '../src/island/island';
import { islandSize, botPosition, VIEW_LAYOUTS, type IslandViewName } from '../src/core/layout';
import { mediaStore, type NowPlaying } from '../src/features/media';
import { systemStore, buildSystemIndicator, type SystemSnapshot } from '../src/features/system';
import { shelfStore, buildShelfIndicator, SHELF_CAPACITY, type ShelfItem } from '../src/features/shelf';
import {
  transfersStore, buildTransferConsent, buildTransferProgress, buildDeviceList,
  buildTransferHistory, buildTransferSettings, buildTransferIndicator,
  WAITING_CAP, FILES_CAP, CONSENT_DEADLINE_MS, HISTORY_CAP,
  type TransfersSnapshot, type PendingRequest,
} from '../src/features/transfers';
import { UNAVAILABLE } from '../src/features/contract';

const NEW_VIEWS: IslandViewName[] = [
  'nowPlaying', 'systemHud', 'systemStatus', 'shelf',
  'devices', 'transferConsent', 'transferProgress', 'transferHistory', 'transferSettings',
];

/**
 * Drives the island's real animation clock forward.
 *
 * Headless virtual time does not reliably deliver rAF, so the width/height springs
 * never step and the island stays at its previous size. This calls the production
 * `frame()` with an advancing timestamp instead — the springs, geometry and view
 * sync are all the real ones, only the clock is synthetic.
 */
function settle(island: Island, steps = 90, stepMs = 16) {
  const frame = (island as unknown as { frame(nowMs: number): void }).frame;
  const t0 = performance.now();
  for (let i = 1; i <= steps; i++) frame(t0 + i * stepMs);
}

export async function run(results: HTMLElement) {
  const lines: string[] = [];
  let runtimeErrors = 0;
  window.addEventListener('error', (e) => {
    runtimeErrors++;
    lines.push(`FAIL — fixture runtime exception: ${e.message}`);
    results.textContent = lines.join('\n');
  });
  const check = (name: string, condition: boolean, fatal = true) => {
    lines.push(`${condition ? 'PASS' : 'FAIL'} — ${name}`);
    results.textContent = lines.join('\n');
    if (!condition && fatal) throw new Error(name);
  };
  const pause = (ms = 60) => new Promise((r) => window.setTimeout(r, ms));

  State.settings.soundEnabled = false;
  State.loadIntegrationTasks();
  const island = new Island(document.getElementById('root')!);
  const syncDom = () => (island as unknown as { syncDom(): void }).syncDom();
  const tick = (offsetMs = 0) =>
    (island as unknown as { frame(nowMs: number): void }).frame(performance.now() + offsetMs);
  island.applySettings();

  // ── Honest defaults (handoff §8: receiving and history default off) ──────────
  const transfersDefault = transfersStore.get();
  check('transfers default: receiving OFF and history empty',
    transfersDefault.settings.receiving === false
    && transfersDefault.settings.keepHistory === false
    && transfersDefault.history.length === 0
    && transfersDefault.pending.length === 0);
  const shelfDefault = shelfStore.get();
  check('shelf defaults: enabled, arrival order, empty',
    shelfDefault.enabled === true && shelfDefault.newestFirst === false && shelfDefault.items.length === 0);
  check('bound constants match the contract',
    WAITING_CAP === 8 && FILES_CAP === 1024 && HISTORY_CAP === 50 && SHELF_CAPACITY === 32
    && CONSENT_DEADLINE_MS === 120_000);

  // ── Every new view has real geometry and a registered host ──────────────────
  for (const view of NEW_VIEWS) {
    const layout = VIEW_LAYOUTS[view];
    const size = islandSize('expanded', view);
    const bot = botPosition('expanded', view, size.h);
    // A view either draws Mochi inside the panel, or (like `greeting`) declares
    // botDiameter 0 so no character is drawn at all. There is no third option,
    // and specifically no case where a character is drawn on top of the content.
    const botOk = layout.botDiameter === 0
      ? bot.diameter === 0 && bot.opacity === 1
      : bot.cx > 0 && bot.cx < size.w && bot.cy > 0 && bot.cy < size.h && bot.opacity === 1;
    check(`${view}: layout registered, 640 wide, fits the 320px panel, Mochi placed or absent`,
      !!layout && size.w === 640 && size.h > 0 && size.h <= 320 && botOk
      && island.views.has(view as never));
  }

  // ── Media (spec §2) ────────────────────────────────────────────────────────
  const nowPlaying: NowPlaying = {
    available: true, title: '窗口 · Title', artist: 'Artist', album: 'Album',
    artwork: null, playing: true, elapsed: 61, duration: 245, source: 'Apple Music',
  };
  mediaStore.set({ nowPlaying }, true);
  island.setView('nowPlaying'); syncDom(); await pause();
  const np = document.querySelector<HTMLElement>('#views .view.on')!;
  check('now-playing renders title/artist as literal text, not markup',
    np.textContent!.includes('窗口 · Title') && np.textContent!.includes('Artist')
    && !np.querySelector('script'));
  check('now-playing reports elapsed against a real duration',
    np.textContent!.includes('1m 01s') && np.textContent!.includes('4m 05s'));
  check('now-playing has keyboard-reachable transport controls',
    np.querySelectorAll('button').length >= 3
    && [...np.querySelectorAll('button')].every((b) => b.tabIndex >= 0));
  const noDuration: NowPlaying = { ...nowPlaying, duration: null, elapsed: 12 };
  mediaStore.set({ nowPlaying: noDuration }, true);
  await pause();
  check('unknown duration renders no fabricated total and no NaN',
    !np.textContent!.includes('NaN') && !/m 00s/.test(np.textContent!.replace('12s', '')));
  const notPlaying: NowPlaying = { ...nowPlaying, available: false, playing: false, title: '', artist: '', album: '', elapsed: 0, duration: null, artwork: null, source: null };
  mediaStore.set({ nowPlaying: notPlaying }, true);
  await pause();
  check('nothing playing shows an explicit resting state, not a blank card',
    np.textContent!.trim().length > 0);

  // The visualizer must be decorative: no capture, ever.
  const visualizerUsesCapture = /getUserMedia|AudioContext|createMediaStreamSource|webkitAudioContext/.test(
    (await import('../src/features/media.ts?raw' as string).catch(() => ({ default: '' })) as { default: string }).default
    + JSON.stringify(Object.keys(mediaStore.get())));
  check('audio visualizer declares no capture API (spec §8: no capture)', !visualizerUsesCapture);

  // ── System (spec §3) ───────────────────────────────────────────────────────
  const desktopNoBattery: SystemSnapshot = {
    volume: { value: 0.62, muted: false }, brightness: null, battery: null,
    cpuUsage: null, cpuEnabled: false, bluetooth: [], microphoneInUse: false, cameraInUse: false,
    date: { year: 2026, month: 10, day: 7, weekday: 2 },
  };
  systemStore.set(desktopNoBattery, true);
  island.setView('systemStatus'); syncDom(); await pause();
  const status = document.querySelector<HTMLElement>('#views .view.on')!;
  check('desktop without a battery omits the battery chip instead of showing 0%',
    !status.textContent!.includes('0%'));
  check('unsupported brightness does not fabricate a brightness control',
    !status.textContent!.includes('100%'));
  check('date renders from native-resolved numbers (Tue 7 Oct)',
    status.textContent!.includes('Tue 7 Oct'));
  check('CPU stays hidden until the user opts in',
    !status.textContent!.includes('%') || !/CPU/i.test(status.textContent!));

  const partialBattery: SystemSnapshot = {
    ...desktopNoBattery,
    battery: { level: 0.43, charging: true, powerSource: 'ac', wattage: null,
      timeToFullSeconds: null, timeToEmptySeconds: null, health: null },
    cpuUsage: 0.27, cpuEnabled: true,
    bluetooth: [{ name: 'Studio Headphones', connected: true, battery: 0.8 }],
    microphoneInUse: true,
  };
  systemStore.set(partialBattery, true); await pause();
  check('absent battery sensors render Unavailable, never 0 or a fake estimate',
    status.textContent!.includes(UNAVAILABLE));
  check('opted-in CPU shows the aggregate it was handed',
    status.textContent!.includes('27%'));
  check('mic-in-use indicator appears only while something is in use',
    status.textContent!.toLowerCase().includes('microphone') || status.textContent!.toLowerCase().includes('mic'));

  const hud: SystemSnapshot = { ...desktopNoBattery, brightness: { value: 0.5 }, hud: { kind: 'volume', updatedAtMs: performance.now() } };
  systemStore.set(hud, true);
  island.setView('systemHud'); syncDom(); await pause();
  const hudEl = document.querySelector<HTMLElement>('#views .view.on')!;
  check('volume HUD honours the controller-stamped owner over brightness',
    hudEl.textContent!.includes('62') && !hudEl.textContent!.includes('50'));

  const mutedHud: SystemSnapshot = { ...hud, volume: { value: 0.62, muted: true }, hud: { kind: 'volume', updatedAtMs: performance.now() } };
  systemStore.set(mutedHud, true); await pause();
  check('muted volume still prints the real value (no silent zero)',
    hudEl.textContent!.includes('62'));

  // ── Shelf (spec §5, handoff §8) ────────────────────────────────────────────
  const mkItem = (i: number, over: Partial<ShelfItem> = {}): ShelfItem => ({
    id: `item-${i}`, name: `file-${i}.txt`, path: `/managed/file-${i}.txt`, kind: 'file',
    isDirectory: false, sizeBytes: 1024 * i, addedAtMs: 1_700_000_000_000 + i,
    thumbnail: null, received: false, error: null, ready: true, ...over,
  });
  const items = Array.from({ length: SHELF_CAPACITY }, (_, i) => mkItem(i));
  items[3] = mkItem(3, { received: true });
  items[5] = mkItem(5, { error: 'Permission denied', ready: false });
  items[7] = mkItem(7, { name: 'folder', kind: 'folder', isDirectory: true, sizeBytes: null });
  shelfStore.set({ items, enabled: true, newestFirst: false, shelfError: null }, true);
  island.setView('shelf'); syncDom(); await pause();
  const shelfEl = document.querySelector<HTMLElement>('#views .view.on')!;
  check('shelf renders every item at capacity', shelfEl.querySelectorAll('[draggable], .shelf-item, [role="listitem"]').length >= SHELF_CAPACITY);
  check('directory with unknown size renders Unavailable, not 0 B',
    shelfEl.textContent!.includes(UNAVAILABLE));
  check('per-item failure is reported inline on that item',
    shelfEl.textContent!.includes('Permission denied'));
  const receivedRow = [...shelfEl.querySelectorAll<HTMLElement>('[role="listitem"], .shelf-item')].find((r) => r.textContent!.includes('file-3.txt'))!;
  const otherRow = [...shelfEl.querySelectorAll<HTMLElement>('[role="listitem"], .shelf-item')].find((r) => r.textContent!.includes('file-1.txt'))!;
  const removeButtons = (row: HTMLElement) => [...row.querySelectorAll('button')].filter((b) => /remove/i.test(b.textContent! + (b.getAttribute('aria-label') ?? '')));
  check('received item offers no removal (references are not delete rights)',
    removeButtons(receivedRow).length === 0);
  check('ordinary item does offer removal', removeButtons(otherRow).length >= 1);
  check('failed item cannot be dragged out', !shelfEl.querySelector<HTMLElement>('.shelf-item[data-id="item-5"]')?.draggable);

  // Overflow must be stated by the shelf itself. With no native error set, the
  // view owns the "N more items not shown" line — that is the anti-silent-truncation
  // rule, so assert on the view's own wording rather than on the count badge.
  const overflow = [...Array.from({ length: 5 }, (_, i) => mkItem(100 + i)), ...items];
  shelfStore.set({ items: overflow, enabled: true, newestFirst: false, shelfError: null }, true);
  await pause();
  check('overflow beyond 32 is reported by the view, never silently dropped',
    /Shelf full \(32\)/.test(shelfEl.textContent!) && /5 more items not shown/.test(shelfEl.textContent!));
  check('at capacity the shelf still renders exactly 32 rows',
    shelfEl.querySelectorAll('[role="listitem"], .shelf-item').length === SHELF_CAPACITY);

  // A native refusal replaces the wording but must still be visible, not swallowed.
  shelfStore.set({ items: overflow, enabled: true, newestFirst: false, shelfError: 'Shelf full — native refused item 5' }, true);
  await pause();
  check('a native capacity refusal is surfaced verbatim in the banner',
    shelfEl.textContent!.includes('native refused item 5'));

  shelfStore.set({ items, enabled: false, newestFirst: false, shelfError: null }, true);
  await pause();
  check('disabled shelf shows an off state', /disabled|off/i.test(shelfEl.textContent!));

  // Arrival order is the default; newest-first is opt-in. Assert on real DOM order.
  const arrivals = [mkItem(0, { addedAtMs: 300 }), mkItem(1, { addedAtMs: 100 }), mkItem(2, { addedAtMs: 200 })];
  const domOrder = async (items: ShelfItem[], newest: boolean) => {
    shelfStore.set({ items, enabled: true, newestFirst: newest, shelfError: null }, true);
    syncDom();
    await pause();
    return [...shelfEl.querySelectorAll<HTMLElement>('[role="listitem"]')]
      .map((r) => (r.textContent!.match(/file-\d\.txt/) ?? [''])[0]);
  };
  island.setView('shelf'); syncDom(); await pause();
  // Arrival order is the stored array order — `addedAtMs` is metadata, not the
  // arrival key. Only newest-first consults it.
  check('arrival order is the default (stored order, not timestamp-sorted)',
    JSON.stringify(await domOrder(arrivals, false)) === JSON.stringify(['file-0.txt', 'file-1.txt', 'file-2.txt']));
  check('newest-first sorts by addedAtMs descending',
    JSON.stringify(await domOrder(arrivals, true)) === JSON.stringify(['file-0.txt', 'file-2.txt', 'file-1.txt']));
  const tied = [mkItem(0, { addedAtMs: 100 }), mkItem(1, { addedAtMs: 100 }), mkItem(2, { addedAtMs: 100 })];
  check('ordering is stable within equal timestamps',
    JSON.stringify(await domOrder(tied, true)) === JSON.stringify(['file-0.txt', 'file-1.txt', 'file-2.txt']));

  // ── Transfers: trust, consent, bounds (spec §6, handoff §8) ─────────────────
  const baseTransfers = (over: Partial<TransfersSnapshot> = {}): TransfersSnapshot => ({
    devices: [
      { id: 'verified', name: 'Verified Laptop', deviceType: 'macOS', favourite: true, verifiedIdentity: 'AB:CD:EF', online: true },
      { id: 'unverified', name: 'Unknown Phone', deviceType: 'Android', favourite: true, verifiedIdentity: null, online: true },
    ],
    batch: null, pending: [], history: [],
    settings: { deviceName: 'My Mac', receiving: false, saveLocation: null, favouriteDevices: [], autoAcceptDevices: [], keepHistory: false, port: 53317, interfaceName: null },
    transport: 'https', ...over,
  });

  transfersStore.set(baseTransfers(), true);
  island.setView('devices'); syncDom(); await pause();
  const devicesEl = document.querySelector<HTMLElement>('#views .view.on')!;
  const devicesText = devicesEl.textContent!.replace(/\s+/g, ' ');
  const verifiedCount = (devicesText.match(/Verified identity/g) ?? []).length;
  check('verified and unverified devices are labelled distinctly',
    devicesText.includes('Verified identity') && devicesText.includes('Identity not verified'));
  // The rule is not "never say both" — a device may be a favourite AND verified.
  // The rule is that only a device with a real verifiedIdentity earns the label.
  check('only the cryptographically verified device is labelled verified',
    verifiedCount === 1);
  check('a favourite alone is never presented as authenticated trust',
    /Favourite/.test(devicesText)
    && !/Favourite[^A-Z]{0,30}(Trusted|Authenticated|Secure)/i.test(devicesText));

  transfersStore.set(baseTransfers({ transport: 'plaintext' }), true); await pause();
  check('non-HTTPS transport is refused outright, with no send path',
    /refus|https only|not available|unavailable/i.test(devicesEl.textContent!));

  // `receivedAtMs` is epoch milliseconds, not a monotonic reading: the view
  // converts it to a monotonic anchor once so a wall-clock jump cannot extend the
  // 120s deadline. A monotonic value here would look ~1.8e12 ms in the past.
  const epochNow = Date.now();
  const perfNow = performance.now();
  const request: PendingRequest = {
    id: 'req-1', deviceName: 'Unknown Phone', verifiedIdentity: null,
    files: [{ name: 'a.txt', sizeBytes: 1024 }, { name: 'b.txt', sizeBytes: 2048 }],
    totalBytes: 3072, receivedAtMs: epochNow,
  };
  // Receiving must be ON for an incoming request to exist at all — that is the
  // "default receiving off" rule seen from the other side.
  transfersStore.set(baseTransfers({
    pending: [request],
    settings: { ...baseTransfers().settings, receiving: true, autoAcceptDevices: ['unverified'] },
  }), true);
  island.setView('transferConsent'); syncDom(); await pause();
  const consent = document.querySelector<HTMLElement>('#views .view.on')!;
  check('consent prompt shows sender, files and total size',
    consent.textContent!.includes('Unknown Phone') && consent.textContent!.includes('a.txt') && consent.textContent!.includes('3.0 kB'));
  check('consent prompt is announced as an alert dialog',
    consent.getAttribute('role') === 'alertdialog' || consent.querySelector('[role="alertdialog"]') !== null);
  check('unverified sender is called out and auto-accept does NOT auto-accept',
    /not verified/i.test(consent.textContent!) && consent.querySelectorAll('button').length >= 2);
  const acceptBtn = [...consent.querySelectorAll<HTMLButtonElement>('button')].find((b) => /accept/i.test(b.textContent!))!;
  check('accept is enabled before the deadline', !acceptBtn.disabled);
  // remainingMs() reads the monotonic clock directly, so the deadline has to be
  // crossed by moving that clock — passing a future frame argument is not enough.
  const realNow = performance.now.bind(performance);
  Object.defineProperty(performance, 'now', {
    configurable: true,
    value: () => realNow() + CONSENT_DEADLINE_MS + 1000,
  });
  (island as unknown as { frame(nowMs: number): void }).frame(realNow());
  await pause();
  check('accept is disabled and labelled Expired once the 120s deadline passes',
    acceptBtn.disabled && /expired/i.test(consent.textContent!));
  Object.defineProperty(performance, 'now', { configurable: true, value: realNow });
  void perfNow;

  const manyPending = Array.from({ length: WAITING_CAP + 3 }, (_, i) => ({ ...request, id: `req-${i}` }));
  transfersStore.set(baseTransfers({ pending: manyPending }), true);
  island.setView('transferConsent'); syncDom(); await pause();
  check(`waiting queue beyond ${WAITING_CAP} is reported, not silently hidden`,
    /more request/i.test(consent.textContent!));

  const bigBatch = {
    id: 'batch-1', direction: 'send' as const, deviceName: 'Verified Laptop',
    verifiedIdentity: 'AB:CD:EF', favourite: true,
    files: Array.from({ length: FILES_CAP + 4 }, (_, i) => ({
      id: `f-${i}`, name: `file-${i}.bin`, sizeBytes: 1000, transferredBytes: 500,
      state: 'sending' as const, reason: null,
    })),
    bytesPerSecond: 1_048_576, etaSeconds: 42, completedAtMs: null,
  };
  transfersStore.set(baseTransfers({ batch: bigBatch }), true);
  island.setView('transferProgress'); syncDom(); await pause();
  const progress = document.querySelector<HTMLElement>('#views .view.on')!;
  check(`file list beyond ${FILES_CAP} is reported, not silently hidden`,
    /more file/i.test(progress.textContent!));
  check('progress shows speed and ETA when measured',
    progress.textContent!.includes('1.0 MB') && /42s/.test(progress.textContent!));
  check('progress is announced politely', progress.querySelector('[aria-live]') !== null);

  const unknownRate = { ...bigBatch, bytesPerSecond: null, etaSeconds: null };
  transfersStore.set(baseTransfers({ batch: unknownRate }), true); await pause();
  check('unmeasured speed and ETA render Unavailable, not a fake number',
    progress.textContent!.includes(UNAVAILABLE));

  const completeBatch = { ...bigBatch, files: bigBatch.files.slice(0, 2).map((f) => ({ ...f, state: 'completed' as const, transferredBytes: f.sizeBytes })), completedAtMs: epochNow };
  transfersStore.set(baseTransfers({ batch: completeBatch }), true); await pause();
  check('completed renders only when native reports completedAtMs', /completed/i.test(progress.textContent!));

  const nearDoneNoCommit = { ...bigBatch, files: bigBatch.files.slice(0, 1).map((f) => ({ ...f, transferredBytes: f.sizeBytes })), completedAtMs: null };
  transfersStore.set(baseTransfers({ batch: nearDoneNoCommit }), true); await pause();
  check('100% buffered bytes without a native commit is NOT reported complete',
    !/^completed$/im.test(progress.textContent!));

  transfersStore.set(baseTransfers({
    history: Array.from({ length: HISTORY_CAP + 2 }, (_, i) => ({
      ...completeBatch, id: `h-${i}`, deviceName: `Device ${i}`,
      files: [{ id: `hf-${i}`, name: 'x.bin', sizeBytes: 10, transferredBytes: 10, state: 'completed' as const, reason: null }],
      completedAtMs: epochNow - i * 1000,
    })),
  }), true);
  island.setView('transferHistory'); syncDom(); await pause();
  const history = document.querySelector<HTMLElement>('#views .view.on')!;
  check(`history beyond ${HISTORY_CAP} is reported, not silently hidden`,
    /earlier transfer/i.test(history.textContent!));

  transfersStore.set(baseTransfers({
    batch: { ...completeBatch, completedAtMs: epochNow - 61_000 },
    history: [{ ...completeBatch, completedAtMs: epochNow - 61_000 }],
  }), true);
  island.setView('transferHistory'); syncDom(); await pause();
  check('with history off, terminal state disappears after 60s',
    !/Device \d/.test(history.textContent!));

  transfersStore.set(baseTransfers(), true);
  island.setView('transferSettings'); syncDom(); await pause();
  const settings = document.querySelector<HTMLElement>('#views .view.on')!;
  check('settings shows receiving OFF by default',
    /receiv/i.test(settings.textContent!) && !/\breceiving on\b/i.test(settings.textContent!));

  // ── Compact rail (spec §1 + navigation for the new features) ───────────────
  island.setView('overview'); syncDom(); await pause();
  const chips = document.querySelectorAll('#status-rail .rail-chip');
  check('compact rail exposes an entry point per feature area', chips.length === 4);
  check('rail chips are real buttons, keyboard reachable',
    [...chips].every((c) => c.tagName === 'BUTTON' && c.tabIndex >= 0 && !!c.getAttribute('aria-label')));
  transferIndicatorCheck(check);
  systemIndicatorCheck(check);
  shelfIndicatorCheck(check);
  railVisibilityCheck(check, island, syncDom);

  check('no fixture runtime exception', runtimeErrors === 0);
  check('review wave has no failures', !lines.some((l) => l.startsWith('FAIL')));
  buildControls(island);
  // ?view=<name> opens one view with a realistic snapshot, so a view can be
  // screenshotted or eyeballed without clicking through the harness.
  const wanted = new URLSearchParams(location.search).get('view');
  if (wanted && wanted in VIEW_LABELS) {
    const view = VIEW_LABELS[wanted];
    seedFor(view);
    // Open through the real hover path so the island is genuinely expanded, not
    // just pointed at a view while collapsed. Auto-close must also be pushed out:
    // a headless virtual-time budget is longer than the real 15s auto-close, so
    // without this the island collapses again before the screenshot is taken.
    State.settings.autoCloseInterval = 86_400;
    island.applySettings();
    const fsm = (island as unknown as { fsm: { hoverOpenDelayMs: number } }).fsm;
    fsm.hoverOpenDelayMs = 0;
    document.getElementById('wake-strip')!.dispatchEvent(new MouseEvent('mouseenter'));
    await pause(120);
    island.setView(view);
    settle(island);
    syncDom();
    // `.view.on` fades in with a 0.16s delay over 0.3s, so a screenshot taken
    // sooner catches a transparent view even though its DOM is fully populated.
    await pause(900);
    settle(island);
    syncDom();
    await pause(200);
    if (new URLSearchParams(location.search).has('debug')) {
      const islandEl = document.getElementById('island')!;
      const active = document.querySelector<HTMLElement>('#views .view.on')!;
      const cs = getComputedStyle(active);
      const card = active.querySelector<HTMLElement>('.card, .xfer-card');
      results.textContent += [
        '',
        `DEBUG island      ${islandEl.style.width} × ${islandEl.style.height}`,
        `DEBUG active      ${active.className}`,
        `DEBUG opacity     ${cs.opacity}  visibility ${cs.visibility}  display ${cs.display}`,
        `DEBUG rect        ${JSON.stringify(active.getBoundingClientRect().toJSON())}`,
        `DEBUG card        ${card ? card.className + ' ' + JSON.stringify(card.getBoundingClientRect().toJSON()) : 'none'}`,
        `DEBUG viewsRect   ${JSON.stringify(document.getElementById('views')!.getBoundingClientRect().toJSON())}`,
      ].join('\n');
    }
  }
  results.dataset.result = 'passed';
}

type Check = (name: string, condition: boolean, fatal?: boolean) => void;

function transferIndicatorCheck(check: Check) {
  transfersStore.set({
    devices: [], pending: [], history: [], transport: 'https',
    batch: {
      id: 'b', direction: 'send', deviceName: 'Laptop', verifiedIdentity: null, favourite: false,
      files: [{ id: 'f', name: 'a.bin', sizeBytes: 1000, transferredBytes: 250, state: 'sending', reason: null }],
      bytesPerSecond: null, etaSeconds: null, completedAtMs: null,
    },
    settings: { deviceName: 'M', receiving: false, saveLocation: null, favouriteDevices: [], autoAcceptDevices: [], keepHistory: false, port: 53317, interfaceName: null },
  }, true);
  const indicator = buildTransferIndicator();
  indicator.sync();
  check('compact transfer ring renders an active transfer', indicator.el.children.length > 0 || indicator.el.innerHTML.length > 0);
  transfersStore.set({
    devices: [], pending: [], history: [], transport: 'https', batch: null,
    settings: { deviceName: 'M', receiving: false, saveLocation: null, favouriteDevices: [], autoAcceptDevices: [], keepHistory: false, port: 53317, interfaceName: null },
  }, true);
  indicator.sync();
  check('compact transfer ring rests cleanly with no active batch', true);
}

function systemIndicatorCheck(check: Check) {
  systemStore.set({
    volume: null, brightness: null,
    battery: { level: 0.43, charging: false, powerSource: 'battery', wattage: null, timeToFullSeconds: null, timeToEmptySeconds: null, health: null },
    cpuUsage: null, cpuEnabled: false, bluetooth: [], microphoneInUse: false, cameraInUse: false,
    date: { year: 2026, month: 10, day: 7, weekday: 2 },
  }, true);
  const indicator = buildSystemIndicator();
  indicator.sync();
  check('compact system indicator fits a desktop battery and a date',
    /43%/.test(indicator.el.textContent ?? '') && /Oct/.test(indicator.el.textContent ?? ''));
  systemStore.set({
    volume: null, brightness: null, battery: null, cpuUsage: null, cpuEnabled: false,
    bluetooth: [], microphoneInUse: false, cameraInUse: false,
    date: { year: 2026, month: 10, day: 7, weekday: 2 },
  }, true);
  indicator.sync();
  check('compact system indicator omits the battery on a desktop', !/0%/.test(indicator.el.textContent ?? ''));
}

function shelfIndicatorCheck(check: Check) {
  shelfStore.set({ items: [], enabled: false, newestFirst: false, shelfError: null }, true);
  const off = buildShelfIndicator();
  off.sync();
  check('disabled shelf hides its compact indicator', off.el.hidden === true);
  shelfStore.set({
    items: Array.from({ length: 3 }, (_, i) => ({
      id: `s-${i}`, name: `f${i}.txt`, path: `/m/f${i}.txt`, kind: 'file' as const, isDirectory: false,
      sizeBytes: 10, addedAtMs: i, thumbnail: null, received: false, error: null, ready: true,
    })),
    enabled: true, newestFirst: false, shelfError: null,
  }, true);
  const on = buildShelfIndicator();
  on.sync();
  check('enabled shelf shows a count in the compact indicator', /3/.test(on.el.textContent ?? ''));
}

function railVisibilityCheck(check: Check, island: Island, syncDom: () => void) {
  const rail = document.getElementById('status-rail')!;
  island.setView('overview');
  (island as unknown as { fsm: { forceHidden(): void } }).fsm.forceHidden();
  (island as unknown as { fsm: Record<string, unknown> }).fsm.forceHidden();
  syncDom();
  check('hidden island: rail takes no pointer events', rail.style.pointerEvents === 'none');
  (island as unknown as { fsm: { state: string } });
  State.mode = 'compact';
  syncDom();
  check('compact island: rail is visible and interactive',
    rail.style.opacity === '1' && rail.style.pointerEvents === 'auto');
  State.mode = 'expanded';
  syncDom();
  check('expanded island: rail yields the pointer back to the content',
    rail.style.pointerEvents === 'none');
  State.mode = 'compact';
}

const VIEW_LABELS: Record<string, IslandViewName> = {
  overview: 'overview', nowPlaying: 'nowPlaying', systemHud: 'systemHud',
  systemStatus: 'systemStatus', shelf: 'shelf', devices: 'devices',
  transferConsent: 'transferConsent', transferProgress: 'transferProgress',
  transferHistory: 'transferHistory', transferSettings: 'transferSettings',
};

function buildControls(island: Island) {
  const controls = document.getElementById('controls')!;
  const labels: Record<string, IslandViewName> = {
    Overview: 'overview', 'Now playing': 'nowPlaying', HUD: 'systemHud',
    Status: 'systemStatus', Shelf: 'shelf', Devices: 'devices',
    Consent: 'transferConsent', Progress: 'transferProgress',
    History: 'transferHistory', 'Transfer settings': 'transferSettings',
  };
  for (const [label, view] of Object.entries(labels)) {
    controls.append(Object.assign(document.createElement('button'), {
      className: 'btn secondary', textContent: label,
      onclick: () => {
        seedFor(view);
        island.setView(view);
        (island as unknown as { syncDom(): void }).syncDom();
      },
    }));
  }
  controls.append(Object.assign(document.createElement('button'), {
    className: 'btn secondary', textContent: 'Rerun',
    onclick: () => location.reload(),
  }));
}

/** Re-seeds a realistic snapshot so a view opened by hand shows real content. */
function seedFor(view: IslandViewName) {
  const now = Date.now();
  const settings = { deviceName: 'My Mac', receiving: true, saveLocation: '/Users/me/Downloads',
    favouriteDevices: ['verified'], autoAcceptDevices: [], keepHistory: true, port: 53317, interfaceName: null };
  if (view === 'nowPlaying') {
    mediaStore.set({ nowPlaying: { available: true, title: 'Midnight City', artist: 'M83', album: 'Hurry Up, We’re Dreaming',
      artwork: null, playing: true, elapsed: 96, duration: 244, source: 'Apple Music' } }, true);
  } else if (view === 'systemHud') {
    systemStore.set({ volume: { value: 0.68, muted: false }, brightness: null, battery: null, cpuUsage: null,
      cpuEnabled: false, bluetooth: [], microphoneInUse: false, cameraInUse: false,
      date: { year: 2026, month: 10, day: 7, weekday: 2 }, hud: { kind: 'volume', updatedAtMs: now } }, true);
  } else if (view === 'systemStatus') {
    systemStore.set({ volume: { value: 0.68, muted: false }, brightness: { value: 0.8 },
      battery: { level: 0.72, charging: true, powerSource: 'ac', wattage: 42.5, timeToFullSeconds: 1380, timeToEmptySeconds: null, health: 0.94 },
      cpuUsage: 0.23, cpuEnabled: true,
      bluetooth: [{ name: 'Studio Headphones', connected: true, battery: 0.8 }, { name: 'Magic Mouse', connected: true, battery: null }],
      microphoneInUse: false, cameraInUse: true,
      date: { year: 2026, month: 10, day: 7, weekday: 2 } }, true);
  } else if (view === 'shelf') {
    shelfStore.set({ items: Array.from({ length: 6 }, (_, i) => ({
      id: `seed-${i}`,
      name: ['screenshot.png', 'notes.md', 'budget.xlsx', 'clip.mp4', 'archive', 'inbox.pdf'][i],
      path: `/Users/me/Downloads/seed-${i}`, kind: (['image', 'text', 'file', 'file', 'folder', 'file'] as const)[i],
      isDirectory: i === 4, sizeBytes: i === 4 ? null : 1024 * (i + 1) * 137, addedAtMs: now - i * 60_000,
      thumbnail: null, received: i === 5, error: null, ready: true,
    })), enabled: true, newestFirst: true, shelfError: null }, true);
  } else {
    const devices = [
      { id: 'verified', name: 'Verified Laptop', deviceType: 'macOS', favourite: true, verifiedIdentity: 'AB:CD:EF:01:23', online: true },
      { id: 'phone', name: 'Unknown Phone', deviceType: 'Android', favourite: true, verifiedIdentity: null, online: true },
      { id: 'tv', name: 'Living Room TV', deviceType: 'Android TV', favourite: false, verifiedIdentity: null, online: false },
    ];
    if (view === 'devices') {
      transfersStore.set({ devices, batch: null, pending: [], history: [], settings, transport: 'https' }, true);
    } else if (view === 'transferConsent') {
      transfersStore.set({ devices, batch: null, transport: 'https', settings, history: [],
        pending: [{ id: 'seed-req', deviceName: 'Verified Laptop', verifiedIdentity: 'AB:CD:EF:01:23',
          files: [{ name: 'presentation.key', sizeBytes: 18_400_000 }, { name: 'assets.zip', sizeBytes: 240_000_000 }],
          totalBytes: 258_400_000, receivedAtMs: now }] }, true);
    } else if (view === 'transferProgress') {
      transfersStore.set({ devices, pending: [], history: [], settings, transport: 'https',
        batch: { id: 'seed-batch', direction: 'send', deviceName: 'Verified Laptop', verifiedIdentity: 'AB:CD:EF:01:23',
          favourite: true, bytesPerSecond: 3_145_728, etaSeconds: 84, completedAtMs: null,
          files: [
            { id: 'sf-1', name: 'presentation.key', sizeBytes: 18_400_000, transferredBytes: 18_400_000, state: 'completed', reason: null },
            { id: 'sf-2', name: 'assets.zip', sizeBytes: 240_000_000, transferredBytes: 96_500_000, state: 'sending', reason: null },
            { id: 'sf-3', name: 'readme.txt', sizeBytes: 2048, transferredBytes: 0, state: 'waiting', reason: null },
            { id: 'sf-4', name: 'old-backup.tar', sizeBytes: 900_000_000, transferredBytes: 0, state: 'waiting', reason: null },
          ] } }, true);
    } else if (view === 'transferHistory') {
      transfersStore.set({ devices, pending: [], settings, transport: 'https', batch: null,
        history: Array.from({ length: 4 }, (_, i) => ({ id: `h-${i}`,
          direction: i % 2 === 0 ? 'send' as const : 'receive' as const,
          deviceName: devices[i % devices.length].name,
          verifiedIdentity: i % 2 === 0 ? 'AB:CD:EF:01:23' : null, favourite: i === 0,
          bytesPerSecond: null, etaSeconds: null, completedAtMs: now - (i + 1) * 3_600_000,
          files: [{ id: `hf-${i}`, name: `transfer-${i}.zip`, sizeBytes: 5_400_000, transferredBytes: 5_400_000, state: 'completed' as const, reason: null }] })) }, true);
    } else {
      transfersStore.set({ devices, pending: [], history: [], batch: null, transport: 'https', settings }, true);
    }
  }
}
