import { State } from '../src/core/state';
import { Bridge } from '../src/core/bridge';
import { Island } from '../src/island/island';
import { handleHook } from '../src/island/hooks';
import { buildAgentSession } from '../src/views/agent-session';
import { buildOverview } from '../src/views/views';
import { islandSize, botPosition } from '../src/core/layout';
import { UploadSeq } from '../src/upload/sequence';
import { Sound } from '../src/core/sound';
import { buildChoose, buildUploading } from '../src/views/upload';
import type { UploadCanvas } from '../src/upload/canvas';

export async function run(results: HTMLElement) {
  const lines: string[] = [];
  let runtimeErrors = 0;
  window.addEventListener('error', () => { runtimeErrors++; lines.push('FAIL — fixture runtime exception'); results.textContent = lines.join('\n'); });
  const check = (name: string, condition: boolean, fatal = true) => {
    lines.push(`${condition ? 'PASS' : 'FAIL'} — ${name}`); results.textContent = lines.join('\n');
    if (!condition && fatal) throw new Error(name);
  };
  let forbiddenCalls = 0;
  for (const key of ['approvalAck', 'approvalDecline', 'approvalDecision', 'log', 'openUrl', 'openInVSCode'] as const)
    Object.assign(Bridge, { [key]: () => { forbiddenCalls++; return Promise.resolve(null); } });
  State.settings.soundEnabled = false;
  State.loadIntegrationTasks();
  const island = new Island(document.getElementById('root')!);
  // Explicitly drive the production dirty-frame boundary: headless virtual time
  // does not reliably deliver rAF. This is not a native animation check.
  const syncDom = () => (island as unknown as { syncDom(): void }).syncDom();
  const frame = () => (island as unknown as { frame(nowMs: number): void }).frame(performance.now());
  island.applySettings();
  let sequence = 0;
  let emitter = 'fixture-emitter';
  const packet = (id = 'fixture-a', extra = {}) => ({ hook_event_name: 'AgentDisplayUpdate', coucou_agent: 'opencode', session_id: id,
    coucou_monitor: { version: 1, emitter_id: emitter, sequence: ++sequence, scope: 'session', status: 'working', directory_known: false, ...extra } });
  const send = (p: unknown, generation = State.agentMonitor.generation) => handleHook(island, p, performance.now(), generation);
  send(packet()); State.setFocus('agent_opencode'); island.setView('agentSession');
  const fixture = buildAgentSession({ setView: (v) => island.setView(v) });
  const noop = () => {};
  const overviewFixture = buildOverview({ setView: (v) => island.setView(v), setFocus: (id) => State.setFocus(id),
    collapse: noop, openTerminal: noop, openTarget: noop, openUrl: noop, decide: noop, toggleSound: noop, setVolume: noop,
    setAutoClose: noop, openSettingsWindow: noop, blip: noop });
  overviewFixture.el.inert = true;
  document.body.append(overviewFixture.el);
  // A hidden second production view specifically verifies synchronous hidden-DOM cleanup.
  fixture.el.inert = true;
  document.body.append(fixture.el); fixture.sync();
  const live = document.querySelector('#views .agent-session')!;
  const pause = (ms = 300) => new Promise((resolve) => window.setTimeout(resolve, ms));
  await pause();
  check('missing directory and context stay unavailable', live.textContent!.includes('Directory unavailable') && live.textContent!.includes('Context unavailable'));
  check('640 × 280; existing Mochi placement; one canvas', islandSize('expanded', 'agentSession').h === 280 && botPosition('expanded', 'agentSession', 280).cx === 42 && document.querySelectorAll('#bot-canvas').length === 1);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches)
    check('reduced motion uses final inspector geometry and no view transition', document.getElementById('island')!.style.height === '280px' && getComputedStyle(live).transitionDuration === '0s');
  const back = live.querySelector<HTMLButtonElement>('[data-back]')!;
  const selector = live.querySelector<HTMLSelectElement>('select')!;
  const scroll = live.querySelector<HTMLElement>('[data-live-rows]')!;
  const beforeStop = sequence;
  const staleStop = packet('fixture-a', { sequence: beforeStop, status: 'finished', outcome: 'completed' });
  staleStop.hook_event_name = 'Stop';
  send(staleStop);
  check('stale Stop skips actual hook lifecycle effects', State.tasks.find((t) => t.id === 'agent_opencode')?.state === 'working' && State.view === 'agentSession');
  send(packet('fixture-a', { status: 'awaiting_approval', approvals: [{ id: 'approval', request_id: '<request-exact-🦊>', state: 'pending', command: "printf '%s' '<b>literal</b>; $(ignored)'" }, { id: 'observation-only', state: 'unknown' }],
    files: Array.from({ length: 20 }, (_, i) => ({ id: `f${i}`, path: `src/日本語-${i}.ts`, action: 'read', state: 'running' })) }));
  await pause(); fixture.sync();
  check('exact request identity and producer fallback labels', live.textContent!.includes('Request ID: <request-exact-🦊>') && live.textContent!.includes('Observation ID: observation-only'));
  check('passive source-specific approval wording, no Allow/Deny', live.textContent!.includes('Awaiting approval in OpenCode') && live.textContent!.includes('Respond in OpenCode') && ![...live.querySelectorAll('button')].some((b) => /^(Allow|Deny)$/.test(b.textContent!)));
  check('markup is literal text', live.textContent!.includes('<b>literal</b>') && !live.querySelector('b.literal') && live.querySelectorAll('script').length === 0);
  check('observations never touch native decisions, logging or paths', forbiddenCalls === 0 && State.pendingApproval === null);
  selector.focus(); scroll.scrollTop = 60;
  const oldScroll = scroll.scrollTop;
  for (let i = 0; i < 30; i++) send(packet('fixture-a', { files: Array.from({ length: 20 }, (_, j) => ({ id: `f${j}`, path: `src/日本語-${j}.ts`, action: 'read', state: 'running' })) }));
  await pause();
  check('burst retains buttons, selector, scroll and focus', live.querySelector('[data-back]') === back && live.querySelector('select') === selector && document.activeElement === selector && scroll.scrollTop === oldScroll);
  island.onCursor(360, 0); island.onCursor(-10_000, -10_000); await pause(350);
  check('focused inspector survives hover churn and ordinary data updates', island.fsm.state === 'home' && document.activeElement === selector && live.querySelector('select') === selector && scroll.scrollTop === oldScroll);
  send(packet('fixture-b', { status: 'awaiting_approval', approvals: [{ id: 'other', state: 'pending' }] })); await pause();
  check('background approval keeps selection and aggregates badge', State.agentMonitor.selected('opencode')?.packet.session_id === 'fixture-a' && State.tasks.find((t) => t.id === 'agent_opencode')?.pillBadge === 'approval');
  selector.value = JSON.stringify(['opencode', 'fixture-emitter', 'session', 'fixture-b']); selector.dispatchEvent(new Event('change')); await pause();
  check('keyboard-compatible session switch', State.agentMonitor.selected('opencode')?.packet.session_id === 'fixture-b');
  back.click(); check('Back returns overview', State.view === 'overview');
  island.setView('agentSession'); await pause();
  live.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); check('Escape returns overview', State.view === 'overview');
  island.setView('agentSession'); await pause(); selector.focus();
  State.pendingApproval = { requestId: 'claude-real-fixture', sessionId: 'claude', tool: 'Read', command: 'Read' }; State.isPinned = true; State.notify();
  check('inspector hold is separate from real approval', State.inspectorHold && State.isPinned);
  back.click(); check('Back works with a background approval and preserves its ownership', State.view === 'overview' && State.isPinned && State.pendingApproval?.requestId === 'claude-real-fixture');
  selector.blur(); live.dispatchEvent(new MouseEvent('mouseleave'));
  State.fileDragOver = true; State.notify(); State.fileDragOver = false; State.notify();
  island.onCursor(360, 0); island.onCursor(-10_000, -10_000); await pause(350);
  check('approval stays pinned after inspector, keyboard and drag release', island.fsm.pinned && island.fsm.state === 'home' && State.isPinned && State.pendingApproval?.requestId === 'claude-real-fixture');
  const approvalView = State.view;
  island.collapse(); island.alert('confused');
  check('explicit collapse and competing alerts cannot release a real approval', island.fsm.state === 'home' && State.view === approvalView && island.fsm.pinned && State.isPinned && State.pendingApproval?.requestId === 'claude-real-fixture');
  State.pendingApproval = null; State.isPinned = false;
  State.notify(); syncDom();
  const headerControl = document.querySelector<HTMLButtonElement>('#header button')!;
  headerControl.focus(); island.fsm.homeToPetitDelay = 0.05;
  island.onCursor(360, 0); island.onCursor(-10_000, -10_000); State.notify(); await pause(350);
  check('focus in ordinary island controls independently holds the panel', island.fsm.state === 'home' && document.activeElement === headerControl && !State.inspectorHold && !State.isPinned);
  headerControl.blur(); await pause(350);
  check('releasing the final keyboard hold resumes actual auto-close', island.fsm.state === 'petit');
  island.applySettings(); island.setView('agentSession'); await pause();
  send(packet('fixture-b', { tools: [{ id: 'secret', name: 'terminal', state: 'running', command: 'TOKEN=FAKE_SECRET_MARKER curl --password FAKE_SECRET_MARKER' }] })); await pause();
  check('secret command preview suppressed', !live.textContent!.includes('FAKE_SECRET_MARKER'));
  const privatePacket = { ...packet('fixture-b'), cwd: '/fixture/PRIVATE_CLEAR_MARKER', coucou_monitor: { ...packet('fixture-b').coucou_monitor, directory_known: true, tools: [{ id: 'private', name: 'read', state: 'running', target: 'PRIVATE_CLEAR_MARKER' }] } };
  send(privatePacket);
  await pause(); fixture.sync(); const generation = State.agentMonitor.generation;
  const detached = live.querySelector('.monitor-row')!;
  State.setPaused(true);
  check('pause synchronously clears hidden DOM and task copies', !document.body.textContent!.includes('PRIVATE_CLEAR_MARKER') && State.agentMonitor.sessions('opencode').length === 0 && !State.tasks.some((t) => t.sessionCwd?.includes('PRIVATE_CLEAR_MARKER') || t.steps.some((s) => s.includes('PRIVATE_CLEAR_MARKER'))));
  check('removed keyed nodes are scrubbed before detachment', !detached.textContent!.includes('PRIVATE_CLEAR_MARKER') && ![...document.querySelectorAll('[title]')].some((n) => n.getAttribute('title')!.includes('PRIVATE_CLEAR_MARKER')));
  State.setPaused(false); send(packet(), generation);
  check('old locally captured generation cannot repopulate', State.agentMonitor.sessions('opencode').length === 0);
  send(privatePacket);
  check('first delayed receipt in current generation cannot restore cleared emitter content', State.agentMonitor.sessions('opencode').length === 0 && !document.body.textContent!.includes('PRIVATE_CLEAR_MARKER'));
  send({ hook_event_name: 'SessionStart', coucou_agent: 'hermes', prompt: 'LEGACY_BODY_MARKER', cwd: '/fixture/LEGACY_BODY_MARKER' });
  send({ hook_event_name: 'Stop', coucou_agent: 'hermes', message: 'LEGACY_BODY_MARKER' });
  send({ hook_event_name: 'UserPromptSubmit', coucou_agent: 'hermes', session_id: 'hermes-turn', coucou_monitor: {
    version: 1, emitter_id: 'hermes-new', sequence: 1, scope: 'session', status: 'thinking', directory_known: false, turn_id: 'new-turn',
  } });
  await pause(5300);
  check('actual old legacy finish timer cannot remove a new monitor turn', State.tasks.find((t) => t.id === 'agent_hermes')?.state === 'thinking' && State.agentMonitor.selected('hermes')?.packet.monitor.turn_id === 'new-turn');
  check('legacy fallback discards adapter bodies and directory', !document.body.textContent!.includes('LEGACY_BODY_MARKER') && !State.tasks.some((t) => t.steps.some((s) => s.includes('LEGACY_BODY_MARKER')) || t.sessionCwd?.includes('LEGACY_BODY_MARKER')));
  const hermesApproval = { hook_event_name: 'AgentDisplayUpdate', coucou_agent: 'hermes', coucou_monitor: {
    version: 1, emitter_id: 'hermes-source-check', sequence: 1, scope: 'agent', status: 'awaiting_approval', directory_known: false,
    approvals: [{ id: 'hermes-observation', request_id: '<hermes-request-exact>', state: 'pending' }],
  } };
  send(hermesApproval); State.setFocus('agent_hermes'); hermesApproval.coucou_monitor.sequence++; send(hermesApproval); await pause();
  check('unattributed pending approval identifies Hermes and exact request', live.textContent!.includes('Awaiting approval in Hermes') && live.textContent!.includes('Request ID: <hermes-request-exact>'));
  send({ ...hermesApproval, coucou_monitor: { ...hermesApproval.coucou_monitor, sequence: 3, status: 'unknown', approvals: [{ id: 'hermes-observation', state: 'unknown' }] } }); await pause();
  check('unattributed unknown approval labels producer identity and source response', live.textContent!.includes('Observation ID: hermes-observation (producer)') && live.textContent!.includes('Respond in Hermes'));
  State.agentMonitor.clear();
  emitter = 'fixture-emitter-after-clear';
  State.setFocus('agent_opencode'); send(packet()); island.setView('agentSession'); await pause();
  const heldEnd = { ...packet(), cwd: '/fixture/ENDED_DELAY_MARKER', coucou_monitor: { ...packet().coucou_monitor, directory_known: true } };
  send({ ...packet(), coucou_monitor: { version: 1, emitter_id: emitter, sequence: ++sequence, scope: 'session', status: 'ended', directory_known: false } });
  check('ended clears immediately while Details held', State.agentMonitor.sessions('opencode').length === 0 && live.textContent!.includes('details cleared'));
  send(heldEnd);
  check('ended session rejects held first-receipt content in actual hook', State.agentMonitor.sessions('opencode').length === 0 && !document.body.textContent!.includes('ENDED_DELAY_MARKER'));
  const heldRoster = { ...packet('roster-session'), cwd: '/fixture/ROSTER_DELAY_MARKER', coucou_monitor: { ...packet('roster-session').coucou_monitor, directory_known: true } };
  send(heldRoster);
  send({ hook_event_name: 'AgentDisplayAlive', coucou_agent: 'opencode', coucou_monitor: { version: 1, emitter_id: emitter, active_session_ids: [] } });
  send(heldRoster);
  check('roster cleanup rejects replay and scrubs active and hidden overview metadata', State.agentMonitor.sessions('opencode').length === 0 && !document.body.textContent!.includes('ROSTER_DELAY_MARKER'));
  send(packet('ttl', { tools: [{ id: 'ttl-file', name: 'read', state: 'running', target: 'TTL_CLEAR_MARKER' }] }));
  const ttl = State.agentMonitor.selected('opencode')!;
  fixture.sync(); State.agentMonitor.prune(ttl.received_at_ms + 30000);
  check('expiry clears held and hidden inspector text', !document.body.textContent!.includes('TTL_CLEAR_MARKER') && State.agentMonitor.sessions('opencode').length === 0);
  emitter = 'fixture-emitter-after-expiry';
  send(packet('fixture-show', { usage: { context: { tokens: 32000, limit: 128000, quality: 'reported', accounting: 'includes_cache' }, totals: { scope: 'observed', input: 96000, accounting: 'includes_cache' } } }));
  State.setFocus('agent_opencode'); island.setView('agentSession'); await pause();
  check('context gauge uses whole input, distinct cumulative total', live.textContent!.includes('32,000 / 128,000') && live.textContent!.includes('96,000'));
  back.click(); await pause();
  // Headless virtual-time budgets do not consistently advance rAF. Exercise the
  // real ViewHost.sync directly, exactly like the isolated hidden inspector.
  overviewFixture.sync();
  check('overview navigation from current inspector', State.view === 'overview');
  check('overview Details control remains available', overviewFixture.el.querySelector<HTMLButtonElement>('.monitor-open')?.hidden === false);
  check('overview context hint reflects reported whole-input usage', overviewFixture.el.querySelector('.monitor-hint')?.textContent === 'Reported · 25% context');
  const longDirectory = '/fixture/' + '日本語-long-project/'.repeat(20) + 'DIRECTORY_END';
  send({ ...packet('fixture-show'), cwd: longDirectory, coucou_monitor: { ...packet('fixture-show').coucou_monitor, directory_known: true,
    tools: [{ id: 'current', name: 'read', state: 'running', target: 'src/CURRENT_FILE_MARKER.ts' }],
    usage: { context: { tokens: 1, limit: 4, quality: 'estimated', accounting: 'includes_cache' } } } });
  await pause(); overviewFixture.sync(); fixture.sync();
  check('overview shows selected source, directory and current tool/file', overviewFixture.el.textContent!.includes('OpenCode') && overviewFixture.el.textContent!.includes(longDirectory) && overviewFixture.el.textContent!.includes('read') && overviewFixture.el.textContent!.includes('CURRENT_FILE_MARKER.ts'));
  check('overview distinguishes estimated context', overviewFixture.el.querySelector('.monitor-hint')?.textContent === '~ Estimated · 25% context');
  const overviewDir = overviewFixture.el.querySelector<HTMLElement>('.monitor-directory')!;
  overviewDir.scrollLeft = overviewDir.scrollWidth;
  check('overview exposes the complete directory through keyboard scrolling', overviewDir.textContent === longDirectory && overviewDir.tabIndex === 0 && getComputedStyle(overviewDir).overflowX === 'auto' && overviewDir.scrollLeft > 0);
  island.setView('agentSession'); await pause();
  const dir = live.querySelector<HTMLElement>('.monitor-directory')!;
  dir.scrollLeft = dir.scrollWidth;
  check('complete long directory is keyboard-accessible and scrollable', dir.textContent === longDirectory && dir.tabIndex === 0 && getComputedStyle(dir).overflowX === 'auto' && dir.scrollLeft > 0);
  send(packet('fixture-show', { files: [{ id: 'file-only', path: 'src/FILE_ONLY_CURRENT_MARKER.ts', action: 'edit', state: 'running' }], usage: { context: { tokens: 100, quality: 'estimated', accounting: 'unknown' } } })); await pause(); overviewFixture.sync();
  check('file-only snapshot replaces omitted tool and directory in overview', overviewFixture.el.textContent!.includes('edit · running · src/FILE_ONLY_CURRENT_MARKER.ts') && !overviewFixture.el.textContent!.includes('CURRENT_FILE_MARKER') && !overviewFixture.el.textContent!.includes(longDirectory));
  check('unknown context ratio retains its declared estimated quality without inventing a gauge', overviewFixture.el.querySelector('.monitor-hint')?.textContent === '~ Estimated · Context unavailable' && live.querySelector<HTMLMeterElement>('meter')!.hidden);
  State.agentMonitor.clear();
  check('overview and hidden ticker metadata cleared synchronously', !overviewFixture.el.textContent!.includes(longDirectory) && !overviewFixture.el.textContent!.includes('FILE_ONLY_CURRENT_MARKER') && !document.body.textContent!.includes('DIRECTORY_END') && !document.body.textContent!.includes('FILE_ONLY_CURRENT_MARKER'));
  emitter = 'ended-before-content-session';
  const unknownSessionEnd = packet('never-delivered', { status: 'ended' });
  send(unknownSessionEnd);
  send({ ...packet('never-delivered'), cwd: '/fixture/UNKNOWN_SESSION_END_MARKER', coucou_monitor: { ...packet('never-delivered').coucou_monitor, directory_known: true } });
  const unknownSessionAlive = send({ hook_event_name: 'AgentDisplayAlive', coucou_agent: 'opencode', coucou_monitor: { version: 1, emitter_id: emitter, active_session_ids: ['never-delivered'] } });
  check('valid session-end before first content blocks real hook and heartbeat without hidden DOM resurrection', State.agentMonitor.sessions('opencode').length === 0 && unknownSessionAlive?.disposition === 'ignored' && !document.body.textContent!.includes('UNKNOWN_SESSION_END_MARKER'));
  emitter = 'ended-before-content-emitter';
  send({ hook_event_name: 'AgentDisplayUpdate', coucou_agent: 'opencode', coucou_monitor: { version: 1, emitter_id: emitter, sequence: ++sequence, scope: 'agent', status: 'ended', directory_known: false } });
  send({ ...packet('never-delivered'), cwd: '/fixture/UNKNOWN_EMITTER_END_MARKER', coucou_monitor: { ...packet('never-delivered').coucou_monitor, directory_known: true } });
  const unknownEmitterAlive = send({ hook_event_name: 'AgentDisplayAlive', coucou_agent: 'opencode', coucou_monitor: { version: 1, emitter_id: emitter, active_session_ids: [] } });
  check('valid emitter-end before first content blocks real hook and empty heartbeat without hidden DOM resurrection', State.agentMonitor.sessions('opencode').length === 0 && unknownEmitterAlive?.disposition === 'ignored' && !document.body.textContent!.includes('UNKNOWN_EMITTER_END_MARKER'));
  for (const cleanup of ['clear', 'end', 'pause'] as const) for (const syncSwitch of [true, false]) {
    emitter = `detached-${cleanup}-${syncSwitch}`;
    send({ ...packet('detached'), cwd: '/fixture/DETACHED_DIRECTORY_MARKER', coucou_monitor: { ...packet('detached').coucou_monitor,
      directory_known: true, tools: [{ id: 'detached-tool', name: 'read', state: 'running', target: 'DETACHED_ROW_MARKER' }] } });
    State.setFocus('agent_opencode'); island.setView('overview'); await pause(); overviewFixture.sync(); syncDom();
    const savedTicker = overviewFixture.el.querySelector<HTMLElement>('.ticker')!;
    const savedRows = [...savedTicker.querySelectorAll<HTMLElement>('.tick-text')];
    const savedDirectory = overviewFixture.el.querySelector<HTMLElement>('.monitor-directory')!;
    check(`detached ${cleanup}/${syncSwitch} starts with private synthetic text`, savedTicker.textContent!.includes('DETACHED_ROW_MARKER') && savedDirectory.textContent!.includes('DETACHED_DIRECTORY_MARKER'));
    send(packet('detached', { tools: [{ id: 'detached-tool', name: 'read', state: 'running', target: 'DETACHED_QUEUED_MARKER' }] }));
    State.setFocus('integration_github');
    if (syncSwitch) {
      overviewFixture.sync(); syncDom();
      check(`leaving monitor scrubs retained ticker before ${cleanup}`, !savedTicker.isConnected && !savedTicker.textContent!.includes('DETACHED_') && savedRows.every((r) => !r.textContent!.includes('DETACHED_')) && savedDirectory.textContent === '', false);
    }
    if (cleanup === 'clear') State.agentMonitor.clear();
    else if (cleanup === 'end') send(packet('detached', { status: 'ended' }));
    else State.setPaused(true);
    overviewFixture.tick?.(performance.now()); overviewFixture.tick?.(performance.now() + 500);
    check(`urgent ${cleanup} scrubs saved nodes regardless focus (${syncSwitch})`, !savedTicker.isConnected && !savedTicker.textContent!.includes('DETACHED_') && savedRows.every((r) => !r.textContent!.includes('DETACHED_')) && savedDirectory.textContent === '' && State.agentMonitor.sessions('opencode').length === 0, false);
    await pause(); overviewFixture.tick?.(performance.now() + 1000);
    check(`pending ${cleanup} callbacks cannot restore detached content (${syncSwitch})`, !savedTicker.textContent!.includes('DETACHED_') && savedRows.every((r) => !r.textContent!.includes('DETACHED_')) && savedDirectory.textContent === '', false);
    if (cleanup === 'pause') State.setPaused(false);
  }
  emitter = 'dirty-frame-gate';
  const framePacket = (target: string) => ({ ...packet('frame-turn'), cwd: `/fixture/${target}`, coucou_monitor: { ...packet('frame-turn').coucou_monitor,
    directory_known: true, tools: [{ id: 'frame-tool', name: 'read', state: 'running', target }] } });
  send(framePacket('FRAME_SEED')); State.setFocus('agent_opencode'); island.setView('overview'); syncDom();
  State.agentMonitor.select('opencode', State.agentMonitor.selected('opencode')!.key);
  const actualOverview = document.querySelector<HTMLElement>('#views .overview')!;
  const detailsControl = actualOverview.querySelector<HTMLButtonElement>('.monitor-open')!;
  const actualTicker = actualOverview.querySelector<HTMLElement>('.ticker')!;
  const actualDirectory = actualOverview.querySelector<HTMLElement>('.monitor-directory')!;
  detailsControl.focus();
  const displayed = new Set([actualTicker.textContent]);
  const started = performance.now();
  for (let i = 1; i <= 6; i++) {
    await pause(20); send(framePacket(`FRAME_DETAIL_${i}`)); syncDom(); displayed.add(actualTicker.textContent);
  }
  check('production dirty-frame calls at 20ms coalesce ordinary ticker/directory updates', performance.now() - started < 250 && displayed.size === 1 && actualTicker.textContent!.includes('FRAME_SEED') && actualDirectory.textContent!.includes('FRAME_SEED'), false);
  await pause(); syncDom();
  check('shared timer flush renders latest snapshot with stable overview controls/focus', actualTicker.textContent!.includes('FRAME_DETAIL_6') && actualDirectory.textContent!.includes('FRAME_DETAIL_6') && actualOverview.querySelector('.monitor-open') === detailsControl && document.activeElement === detailsControl, false);
  send(framePacket('FRAME_NAVIGATION')); syncDom();
  island.setView('agentSession'); syncDom(); island.setView('overview'); syncDom();
  check('overview navigation bypasses pending ordinary gate', actualTicker.textContent!.includes('FRAME_NAVIGATION'), false);
  send(packet('frame-other', { tools: [{ id: 'other', name: 'read', state: 'running', target: 'FRAME_SELECTION' }] }));
  State.agentMonitor.select('opencode', State.agentMonitor.sessions('opencode').find((s) => s.packet.session_id === 'frame-other')!.key);
  check('session selection bypasses overview gate', actualTicker.textContent!.includes('FRAME_SELECTION'), false);
  send(packet('frame-other', { status: 'awaiting_approval', tools: [{ id: 'other', name: 'read', state: 'blocked', target: 'FRAME_APPROVAL' }], approvals: [{ id: 'frame-approval', state: 'pending' }] }));
  check('approval change bypasses overview gate', actualTicker.textContent!.includes('FRAME_APPROVAL'), false);
  send(packet('frame-other', { status: 'failed', outcome: 'failed', tools: [{ id: 'other', name: 'read', state: 'failed', target: 'FRAME_FAILURE' }] }));
  check('terminal change bypasses overview gate', actualTicker.textContent!.includes('FRAME_FAILURE'), false);
  send(framePacket('FRAME_PENDING_CLEAR')); State.agentMonitor.select('opencode', State.agentMonitor.sessions('opencode').find((s) => s.packet.session_id === 'frame-turn')!.key);
  send(framePacket('FRAME_PENDING_CLEAR_LATER')); syncDom(); State.agentMonitor.clear();
  check('urgent cleanup clears actual overview before deferred text flush', !actualTicker.textContent!.includes('FRAME_') && !actualDirectory.textContent!.includes('FRAME_'), false);
  await pause(); syncDom();
  check('deferred overview callback cannot resurrect cleared text', !actualTicker.textContent!.includes('FRAME_') && !actualDirectory.textContent!.includes('FRAME_'), false);
  State.setFocus('integration_claude'); State.appendStep('integration_claude', 'LEGACY_TICKER_SEED'); overviewFixture.sync();
  const legacyTicker = overviewFixture.el.querySelector<HTMLElement>('.ticker')!;
  State.appendStep('integration_claude', 'LEGACY_TICKER_NEXT'); overviewFixture.sync();
  const legacyStart = performance.now(); overviewFixture.tick?.(legacyStart); State.agentMonitor.clear(); overviewFixture.tick?.(legacyStart + 400);
  check('legacy ticker remains immediate and preserves its queued transition during monitor cleanup', legacyTicker.textContent!.includes('LEGACY_TICKER_NEXT'), false);
  island.setView('agentSession'); await pause();
  check('all observation bridge checks remain clean', forbiddenCalls === 0);
  check('no fixture runtime exception', runtimeErrors === 0);
  selector.blur(); headerControl.blur();
  island.setView('overview'); syncDom(); island.fsm.forceHidden();
  const wakeStrip = document.getElementById('wake-strip')!;
  wakeStrip.dispatchEvent(new MouseEvent('mouseenter'));
  check('wake strip opens full immediately without reentrant leave', island.fsm.state === 'home' && island.fsm.homeCollapseAt === null);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    // Exercise the real frame branch directly; virtual-time rAF is not a clock.
    frame();
    check('reduced-motion full hover snaps geometry and stops decorative frame loops', document.getElementById('island')!.style.height === `${islandSize('expanded', 'overview').h}px` && !(island as unknown as { running: boolean }).running);
  }
  wakeStrip.dispatchEvent(new MouseEvent('mouseleave')); await pause(350);
  check('wake strip leaving uses the hover collapse deadline', island.fsm.state === 'petit');
  wakeStrip.dispatchEvent(new MouseEvent('mouseenter'));
  check('wake strip also expands an already compact island', island.fsm.state === 'home');
  wakeStrip.dispatchEvent(new MouseEvent('mouseleave'));
  island.fsm.forceHidden(); island.fsm.hoverOpenDelayMs = 1000;
  document.getElementById('island')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  check('hidden click bypasses configured hover delay', island.fsm.state === 'home');
  island.fsm.forceHidden();
  wakeStrip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  check('wake strip has a keyboard equivalent for explicit opening', wakeStrip.tabIndex === 0 && island.fsm.state === 'home');
  island.fsm.forceHidden(); wakeStrip.dispatchEvent(new MouseEvent('mouseenter'));
  State.setPaused(true); await pause(1100);
  check('pause invalidates pending hover and prevents new opening', island.fsm.state === 'hidden');
  wakeStrip.dispatchEvent(new MouseEvent('mouseenter')); await pause(1100);
  check('paused wake strip stays hidden', island.fsm.state === 'hidden');
  State.setPaused(false); wakeStrip.dispatchEvent(new MouseEvent('mouseenter'));
  const previousScreen = State.settings.screen;
  State.settings.screen = previousScreen === 'primary' ? 'cursor' : 'primary'; island.applySettings(); await pause(1100);
  check('screen setting change invalidates pending hover', island.fsm.state === 'hidden');
  State.settings.screen = previousScreen; island.applySettings();
  document.getElementById('island')!.blur();
  island.launch(); syncDom(); headerControl.focus();
  island.onCursor(360, 0); island.onCursor(-10_000, -10_000);
  check('focused control survives greeting pointer leave', island.fsm.state === 'coucou' && island.fsm.held && document.activeElement === headerControl);
  island.fsm.greetComplete(); await pause(700);
  check('focused control survives greeting completion', island.fsm.state === 'coucou' && document.activeElement === headerControl);
  headerControl.blur(); await pause(700);
  check('greeting resumes collapse after its final focus hold releases', island.fsm.state === 'petit');
  await preparationChecks(island, check);
  island.setView('agentSession');
  const longFiles = () => Array.from({ length: 20 }, (_, i) => ({ id: `manual-${i}`, path: `src/日本語 project/long-component-directory/é🦊-${i}.ts`, action: 'edit', state: 'running' }));
  let enable = 0;
  const show = (extra = {}) => { State.agentMonitor.clear(); emitter = `fixture-manual-${++enable}`; send(packet('fixture-show', extra)); State.setFocus('agent_opencode'); island.setView('agentSession'); };
  const controls: [string, () => void][] = [
    ['Missing values', () => show()],
    ['Approvals / paths', () => show({ status: 'awaiting_approval', approvals: [{ id: 'manual-approval', state: 'pending', command: "printf '%s' '<b>literal</b>; $(ignored)'" }, { id: 'manual-unknown', state: 'unknown' }], files: longFiles() })],
    ['Burst', () => { for (let i = 0; i < 30; i++) send(packet('fixture-show', { files: longFiles() })); }],
    ['Clear', () => State.agentMonitor.clear()],
    ['Overview', () => island.setView('overview')],
    ['Details', () => island.setView('agentSession')],
    ['Replay checks', () => location.reload()],
  ];
  for (const [label, onclick] of controls) document.getElementById('controls')!.append(Object.assign(document.createElement('button'), { className: 'btn secondary', textContent: label, onclick }));
  check('review regression wave has no failures', !lines.some((line) => line.startsWith('FAIL')));
  results.dataset.result = 'passed';
}

// Synthetic native boundary only: production drop handlers, views, sequence,
// canvas and callback ownership stay real. No files or native receipts are made.
async function preparationChecks(island: Island, check: (name: string, condition: boolean, fatal?: boolean) => void) {
  const internals = island as unknown as { onDragDrop(e: { type: string; paths?: string[] }): void; stepSequence(): void; clearPreparation(): void };
  const canvas = (island as unknown as { uploadCanvas: UploadCanvas }).uploadCanvas;
  const deferred = <T,>() => {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };
  const copies: { path: string; id: string; receipt: ReturnType<typeof deferred<{ name: string; path: string; size: number }>> }[] = [];
  const cancellations: string[] = [];
  const sent: { query: string; context: Parameters<typeof Bridge.chatSend>[1] }[] = [];
  let heldCancel: ReturnType<typeof deferred<void>> | null = null;
  const played: string[] = [];
  const play = Sound.play;
  Sound.play = (name) => { played.push(name); };
  Object.assign(Bridge, {
    log: () => Promise.resolve(null), chatReset: () => Promise.resolve(null),
    chatSend: (query: string, context: Parameters<typeof Bridge.chatSend>[1]) => { sent.push({ query, context }); return Promise.resolve({ text: 'synthetic reply' }); },
    ingestFile: (path: string, id: string) => { const receipt = deferred<{ name: string; path: string; size: number }>(); copies.push({ path, id, receipt }); return receipt.promise; },
    cancelFileCopy: (id: string) => { cancellations.push(id); return heldCancel?.promise ?? Promise.resolve(); },
  });
  const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
  const drop = (name: string) => { internals.onDragDrop({ type: 'enter' }); internals.onDragDrop({ type: 'drop', paths: [`/synthetic-original/${name}`] }); };
  const ready = (name: string) => ({ name, path: `/synthetic-managed/${name}`, size: 9 });
  State.pendingApproval = { requestId: 'copy-real-approval', sessionId: 'claude', tool: 'Read', command: 'Read' };
  State.isPinned = true; island.alert('approval'); drop('blocked.txt');
  check('synthetic drop cannot swallow/setView over a real approval', State.view === 'approval' && !State.droppedFile && copies.length === 0);
  State.pendingApproval = null; State.isPinned = false; State.notify();
  drop('a.txt'); await flush();
  check('synthetic pending copy publishes no original path or prompt context', State.droppedFile === null && State.promptContext === null);
  const first = copies.at(-1)!;
  const clock = performance.now.bind(performance);
  const start = clock();
  Object.defineProperty(performance, 'now', { configurable: true, value: () => start + 10_000 });
  internals.stepSequence(); const pending = UploadSeq.frame();
  const painted: string[] = [];
  const fillText = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) { painted.push(text); if (maxWidth === undefined) fillText.call(this, text, x, y); else fillText.call(this, text, x, y, maxWidth); };
  canvas.draw(pending, (start + 10_000) / 1000);
  CanvasRenderingContext2D.prototype.fillText = fillText;
  Reflect.deleteProperty(performance, 'now');
  const uploading = buildUploading(); uploading.sync();
  check('synthetic ten-second unresolved copy has no check, percentage, success sound or choose controls', pending.check === 0 && pending.progress === 0 && pending.chooseAlpha === 0 && !played.includes('approve') && !uploading.el.textContent!.includes('%') && uploading.el.textContent!.includes('Preparing file') && painted.includes('Preparing file…') && !painted.some((text) => /%|Uploading|ready/i.test(text)) && document.getElementById('upload-overlay')!.style.display === 'none');
  const choose = buildChoose({ setView: (v) => island.setView(v) } as Parameters<typeof buildChoose>[0]); choose.sync();
  check('synthetic pending Ask is disabled in legacy choose and guarded at the header', choose.el.querySelector<HTMLButtonElement>('button')!.disabled);
  island.setView('prompt'); check('synthetic pending Ask cannot navigate to prompt', State.view === 'uploading');
  heldCancel = deferred<void>(); drop('b.txt'); await flush();
  check('synthetic replacement cancels A and waits for worker settlement before native B admission', cancellations.includes(first.id) && copies.length === 1 && State.droppedFile === null);
  first.receipt.resolve(ready('a.txt')); await flush();
  check('synthetic late A cannot become ready while cancellation is outstanding', State.droppedFile === null && copies.length === 1);
  heldCancel.resolve(); heldCancel = null; await flush();
  const second = copies.at(-1)!;
  check('synthetic latest selection admitted only after both old copy and cancel settle', copies.length === 2 && second.path.endsWith('b.txt') && second.id !== first.id);
  second.receipt.resolve(ready('b.txt')); await flush();
  check('synthetic only current native ready result exposes managed Ask context', State.droppedFile?.path === '/synthetic-managed/b.txt' && State.promptContext === null);
  const completeAt = performance.now();
  Object.defineProperty(performance, 'now', { configurable: true, value: () => completeAt + 2000 });
  internals.stepSequence(); internals.stepSequence(); canvas.draw(UploadSeq.frame(), (completeAt + 2000) / 1000); Reflect.deleteProperty(performance, 'now');
  check('synthetic current success grows/chooses and chimes exactly once', State.view === 'choose' && played.filter((name) => name === 'approve').length === 1);
  const selectedOwner = State.filePreparation.current;
  const selectedFile = State.droppedFile;
  const beforePreviewCancel = cancellations.length, beforePreviewSend = sent.length;
  Object.defineProperty(performance, 'now', { configurable: true, value: () => completeAt + 2000 });
  for (const start of ['enter', 'over'] as const) for (const end of ['leave', 'drop'] as const) {
    internals.onDragDrop({ type: start }); internals.onDragDrop({ type: 'over' });
    check(`synthetic ready Choose owner/view survives ${start}/${end} preview without cancellation or send`, State.filePreparation.current === selectedOwner && State.droppedFile === selectedFile && State.view === 'choose' && cancellations.length === beforePreviewCancel && sent.length === beforePreviewSend);
    internals.onDragDrop({ type: end });
    (island as unknown as { syncDom(): void }).syncDom(); canvas.draw(UploadSeq.frame(), (completeAt + 2000) / 1000);
    check(`synthetic aborted ${start}/${end} preview leaves existing managed Ask actions usable`, State.filePreparation.current === selectedOwner && State.view === 'choose' && !State.fileDragOver && !document.getElementById('upload-overlay')!.inert && !document.querySelector<HTMLButtonElement>('#views .view.on .btn.primary')!.disabled && copies.length === 2 && cancellations.length === beforePreviewCancel);
  }
  Reflect.deleteProperty(performance, 'now');
  document.querySelector<HTMLButtonElement>('#upload-overlay .upload-hit')!.click();
  check('synthetic explicit Ask uses only prepared copy without sending', State.view === 'prompt' && State.promptContext?.kind === 'file' && State.promptContext.path === '/synthetic-managed/b.txt' && sent.length === 0);
  check('synthetic leaving choose removes invisible canvas hit areas from chat', document.getElementById('upload-overlay')!.inert && document.getElementById('upload-overlay')!.style.display === 'none');
  (island as unknown as { syncDom(): void }).syncDom();
  document.querySelector<HTMLInputElement>('#views .chat-input')!.value = 'synthetic question';
  document.querySelector<HTMLButtonElement>('#views .send-btn')!.click(); await flush();
  check('synthetic explicit chat send consumes only the managed ready receipt', sent.length === 1 && sent[0].context?.kind === 'file' && sent[0].context.path === '/synthetic-managed/b.txt');
  const contextBeforePreview = State.promptContext, chatBeforePreview = State.chatHistory;
  const inputBeforePreview = document.querySelector<HTMLInputElement>('#views .chat-input')!;
  inputBeforePreview.value = 'synthetic unsent draft';
  for (const start of ['enter', 'over'] as const) for (const end of ['leave', 'drop'] as const) {
    internals.onDragDrop({ type: start }); internals.onDragDrop({ type: 'over' }); internals.onDragDrop({ type: end });
    (island as unknown as { syncDom(): void }).syncDom();
    check(`synthetic aborted ${start}/${end} preview preserves ready chat/context/draft and usable send`, State.filePreparation.current === selectedOwner && State.droppedFile === selectedFile && State.promptContext === contextBeforePreview && State.chatHistory === chatBeforePreview && State.chatHistory.length === 2 && State.view === 'prompt' && inputBeforePreview.value === 'synthetic unsent draft' && !inputBeforePreview.disabled && document.querySelector('#views .chip')!.textContent!.includes('b.txt') && sent.length === 1 && cancellations.length === beforePreviewCancel && copies.length === 2);
  }
  internals.onDragDrop({ type: 'enter' });
  internals.onDragDrop({ type: 'drop', paths: ['/synthetic/a', '/synthetic/b'] });
  (island as unknown as { syncDom(): void }).syncDom();
  check('synthetic unsupported replacement drop visibly rejects new data without evicting ready chat/context', State.view === 'note' && document.querySelector('#views .view.on')!.textContent!.includes('one file') && State.filePreparation.current === selectedOwner && State.droppedFile === selectedFile && State.promptContext === contextBeforePreview && State.chatHistory === chatBeforePreview && State.chatHistory.length === 2 && copies.length === 2 && cancellations.length === beforePreviewCancel && sent.length === 1);
  island.setView('prompt');
  check('synthetic rejected multi-drop keeps the previous prepared Ask context usable', State.view === 'prompt' && State.droppedFile === selectedFile && State.promptContext?.kind === 'file' && State.promptContext.path === '/synthetic-managed/b.txt' && State.chatHistory.length === 2);
  drop('accepted-replacement.txt'); await flush();
  check('synthetic accepted single drop supersedes the preserved ready selection only at admission', State.filePreparation.current?.id !== selectedOwner?.id && State.filePreparation.current?.name === 'accepted-replacement.txt' && State.filePreparation.current.state === 'preparing' && State.droppedFile === null && State.promptContext === null && State.chatHistory.length === 0 && copies.length === 3 && sent.length === 1);
  copies.at(-1)!.receipt.resolve(ready('accepted-replacement.txt')); await flush();
  check('synthetic accepted replacement exposes only its new managed receipt', State.droppedFile?.path === '/synthetic-managed/accepted-replacement.txt' && State.droppedFile !== selectedFile && State.promptContext === null && sent.length === 1);
  island.setView('overview');
  check('synthetic leaving file chat clears attachment content', State.droppedFile === null && State.promptContext === null);
  drop('busy-worker.txt'); await flush(); const busyWorker = copies.at(-1)!;
  const busyCount = copies.length;
  heldCancel = deferred<void>();
  drop('queued-1.txt'); drop('queued-2.txt'); drop('latest.txt'); await flush();
  check('synthetic burst retains only the latest pending selection without parallel native work', copies.length === busyCount && State.filePreparation.current?.name === 'latest.txt' && State.filePreparation.current.state === 'preparing' && State.droppedFile === null);
  busyWorker.receipt.reject(new Error('PRIVATE_RAW_PATH_ERROR')); await flush();
  check('synthetic late worker failure cannot fail a newer queued selection', State.view === 'uploading' && State.filePreparation.current?.name === 'latest.txt' && State.filePreparation.current.state === 'preparing' && State.noteMessage === null);
  heldCancel.resolve(); heldCancel = null; await flush();
  check('synthetic burst admits only the last selected file after old work drains', copies.length === busyCount + 1 && copies.at(-1)!.path.endsWith('latest.txt'));
  copies.at(-1)!.receipt.reject('Another file is still preparing.'); await flush();
  check('synthetic native busy refusal is honest failure rather than readiness', State.filePreparation.current?.state === 'failed' && State.droppedFile === null && State.noteMessage!.includes('still preparing'));
  internals.clearPreparation(); island.setView('overview');
  drop('old-failure.txt'); await flush(); const oldFailure = copies.at(-1)!;
  island.setView('agentSession'); oldFailure.receipt.reject(new Error('PRIVATE_RAW_PATH_ERROR')); await flush();
  check('synthetic stale failure cannot replace inspector or leak its raw error', State.view === 'agentSession' && !document.body.textContent!.includes('PRIVATE_RAW_PATH_ERROR') && State.droppedFile === null);
  drop('failure.txt'); await flush(); copies.at(-1)!.receipt.reject(new Error('/PRIVATE_RAW_PATH_ERROR')); await flush();
  check('synthetic current failure is controlled and has no prompt path', State.view === 'note' && State.droppedFile === null && State.promptContext === null && !State.noteMessage!.includes('PRIVATE_RAW_PATH_ERROR'));
  island.setView('agentSession'); await new Promise((resolve) => window.setTimeout(resolve, 2500));
  check('synthetic old recovery timeout cannot steal a newer inspector view', State.view === 'agentSession');
  for (const terminal of ['success', 'failure'] as const) {
    drop(`approval-${terminal}.txt`); await flush(); const copy = copies.at(-1)!;
    State.pendingApproval = { requestId: 'copy-real-approval', sessionId: 'claude', tool: 'Read', command: 'Read' }; State.isPinned = true;
    // Model approval acquisition independently of normal navigation cleanup, so
    // this specifically reaches the live native terminal callback owner guard.
    State.view = 'approval'; State.notify();
    if (terminal === 'success') copy.receipt.resolve(ready('approval-success.txt'));
    else copy.receipt.reject(new Error('PRIVATE_RAW_PATH_ERROR'));
    await flush(); internals.stepSequence();
    check(`synthetic live copy ${terminal} preserves real approval view and ownership`, State.view === 'approval' && State.pendingApproval?.requestId === 'copy-real-approval' && State.isPinned);
    State.pendingApproval = null; State.isPinned = false; internals.clearPreparation(); island.setView('overview');
  }
  for (const cleanup of ['clear', 'pause', 'pagehide'] as const) for (const terminal of ['success', 'failure'] as const) {
    drop(`${cleanup}.txt`); await flush(); const copy = copies.at(-1)!;
    if (cleanup === 'clear') internals.clearPreparation();
    else if (cleanup === 'pause') State.setPaused(true);
    else window.dispatchEvent(new Event('pagehide'));
    if (terminal === 'success') copy.receipt.resolve(ready(`${cleanup}.txt`));
    else copy.receipt.reject(new Error('PRIVATE_RAW_PATH_ERROR'));
    await flush();
    check(`synthetic ${cleanup} cancels native work and rejects late ${terminal}`, cancellations.includes(copy.id) && State.droppedFile === null && State.promptContext === null && !UploadSeq.isActive);
    State.setPaused(false); island.setView('overview');
  }
  State.mouseInIsland = { x: 520, y: 96 };
  internals.onDragDrop({ type: 'enter' });
  const followingAt = performance.now();
  Object.defineProperty(performance, 'now', { configurable: true, value: () => followingAt + 450 });
  const followed = UploadSeq.frame().x;
  internals.onDragDrop({ type: 'drop', paths: ['/synthetic-original/followed.txt'] });
  check('synthetic drop preserves the existing cursor-follow spring choreography', followed > 400 && Math.abs(UploadSeq.frame().x - followed) < 1);
  Reflect.deleteProperty(performance, 'now');
  internals.clearPreparation(); copies.at(-1)!.receipt.resolve(ready('followed.txt')); await flush();
  const beforeMultiple = copies.length;
  internals.onDragDrop({ type: 'drop', paths: ['/synthetic/a', '/synthetic/b'] }); await flush();
  check('synthetic multiple drops are rejected honestly without preparing the first item', copies.length === beforeMultiple && State.view === 'note' && State.noteMessage!.includes('one file'));
  internals.clearPreparation(); island.setView('overview'); Sound.play = play;
}
