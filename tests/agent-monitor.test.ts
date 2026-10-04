import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { AgentMonitorStore, contextFraction, compareKeys } from '../windows/src/core/agent-monitor.ts';

const fixtures = new URL('./fixtures/agent-monitor/', import.meta.url);
const wire = JSON.parse(readFileSync(new URL('wire.json', fixtures), 'utf8'));
const replays = JSON.parse(readFileSync(new URL('replay.json', fixtures), 'utf8'));
const healthy = wire.find((c) => c.name === 'healthy-session').packet;
const copy = () => structuredClone(healthy);
const agents = ['opencode', 'hermes'];

for (const c of wire) test(`wire: ${c.name}`, () => {
  const store = new AgentMonitorStore();
  const result = store.apply(c.packet, 0);
  assert.equal(result.disposition === 'accepted', c.valid);
  if (c.name === 'invalid-canonical-monitor-legacy') assert.equal(result.disposition, 'legacy');
});

function projection(store, now, canonical, last_result) {
  return {
    sessions: agents.flatMap((a) => store.sessions(a)).sort((a, b) => compareKeys(a.key, b.key)).map((s) => ({
      key: s.key, ...(s.packet.cwd === undefined ? {} : { cwd: s.packet.cwd }), monitor: s.packet.monitor,
      received_at_ms: s.received_at_ms, context_fraction: contextFraction(s.packet.monitor.usage ?? {}),
      content_stale: now - s.received_at_ms >= 30000,
    })),
    observations: agents.flatMap((agent) => store.observations(agent).map((o) => ({ agent, ...o })))
      .sort((a, b) => compareKeys([a.agent, a.emitter_id, a.approval.id], [b.agent, b.emitter_id, b.approval.id])),
    counts: Object.fromEntries(agents.map((a) => [a, store.sessions(a).length])),
    selected: Object.fromEntries(agents.map((a) => [a, store.selected(a)?.key ?? null])),
    badges: Object.fromEntries(agents.map((a) => [a, store.badge(a)])),
    overflow: Object.fromEntries(agents.map((a) => [a, store.overflow(a)])),
    canonical, last_result, generation: store.generation, paused: store.paused,
  };
}
function pointer(object, path) {
  return path.slice(1).split('/').reduce((value, key) => value?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], object);
}
for (const c of replays) test(`replay: ${c.name}`, () => {
  const store = new AgentMonitorStore();
  const canonical = [];
  let last = null;
  c.events.forEach(({ packet, at_ms }, index) => {
    let disposition;
    if (packet === null) { store.prune(at_ms); disposition = 'pruned'; }
    else if (packet.$fixture === 'select') { store.select(packet.agent, packet.key); disposition = 'selected'; }
    else if (packet.$fixture === 'clear') { store.clear(at_ms); disposition = 'cleared'; }
    else if (packet.$fixture === 'pause' || packet.$fixture === 'resume') {
      store.setPaused(packet.$fixture === 'pause', at_ms); disposition = packet.$fixture === 'pause' ? 'paused' : 'resumed';
    } else if (packet.$fixture === 'finish') {
      // Monitor snapshots never schedule legacy finish/removal callbacks.
      disposition = 'animation_ignored';
    } else {
      const p = packet.$fixture === 'deliver' ? packet.packet : packet;
      last = store.deliver(p, at_ms, packet.$fixture === 'deliver' ? packet.generation : store.generation);
      disposition = last.disposition;
      if (['accepted', 'legacy'].includes(disposition) && !p.hook_event_name.startsWith('AgentDisplay')) canonical.push(p.hook_event_name);
    }
    assert.equal(disposition, c.expected.results[index], `event ${index}`);
    for (const cp of c.expected.checkpoints.filter((cp) => cp.after === index)) {
      const state = projection(store, at_ms, canonical, last);
      for (const check of cp.checks) assert.deepEqual(pointer(state, check.path), check.absent ? undefined : check.equals, check.path);
    }
  });
});

test('UTF-8 boundaries, optional omissions, finite usage and detached allowlist', () => {
  const apply = (mutate) => { const p = copy(); mutate(p); const s = new AgentMonitorStore(); const r = s.apply(p, 0); return { p, s, r, m: s.selected('opencode')?.packet.monitor }; };
  assert.equal(contextFraction(healthy.coucou_monitor.usage), .25);
  assert.equal(contextFraction({ context: { tokens: 1, limit: 2, quality: 'reported' } }), null);
  assert.equal(contextFraction({ context: { tokens: 300, limit: 200, quality: 'estimated', accounting: 'excludes_cache' } }), 1);
  assert.equal(apply((p) => p.session_id = 'é'.repeat(128)).r.disposition, 'accepted');
  assert.equal(apply((p) => p.session_id = 'é'.repeat(129)).r.disposition, 'legacy');
  assert.equal(apply((p) => p.coucou_monitor.files[0].path = '界'.repeat(341) + 'a').m.files[0].path.length, 342);
  assert.equal(apply((p) => p.coucou_monitor.files[0].path = '界'.repeat(342)).m.files, undefined);
  assert.equal(apply((p) => p.coucou_monitor.tools[0].command = 'é'.repeat(500)).m.tools[0].command.length, 500);
  assert.equal(apply((p) => p.coucou_monitor.tools[0].command = 'é'.repeat(501)).m.tools[0].command, undefined);
  assert.equal(apply((p) => p.padding = 'x'.repeat(65536)).r.disposition, 'ignored');
  for (const value of [null, false, -1, 1.5, 'Infinity', NaN, Infinity]) {
    const { m } = apply((p) => p.coucou_monitor.usage.context.tokens = value);
    assert.equal(m.usage.context, undefined); assert.equal(m.usage.totals.input, 96000);
  }
  assert.equal(apply((p) => p.session_id = '\ud800').r.disposition, 'ignored');
  const { p, s } = apply(() => {}); p.coucou_monitor.tools[0].target = 'MUTATED';
  assert.equal(s.selected('opencode').packet.monitor.tools[0].target, 'src/main.ts');
  for (const text of ['TOKEN=synthetic curl', 'curl --password synthetic', 'curl -H "Cookie: synthetic"', 'curl https://user:secret@example.invalid/?key=synthetic', 'line\nfree text'])
    assert.equal(apply((p) => p.coucou_monitor.tools[0].command = text).m.tools[0].command, undefined);
});

test('short credential options are suppressed in tools and session/agent approvals', () => {
  for (const command of [
    'curl -ualice:FAKE_SECRET https://example.invalid',
    'sshpass -pFAKE_SECRET ssh example.invalid',
    'curl "-ualice:FAKE_SECRET" https://example.invalid',
    "sshpass '-pFAKE_SECRET' ssh example.invalid",
    'curl -u"alice:FAKE_SECRET" https://example.invalid',
    'sshpass -p=FAKE_SECRET ssh example.invalid',
    'curl -u alice:FAKE_SECRET https://example.invalid',
    'sshpass -p "FAKE_SECRET" ssh example.invalid',
    'curl --password="FAKE_SECRET" https://example.invalid',
  ]) {
    const p = copy();
    p.coucou_monitor.tools[0].command = command;
    p.coucou_monitor.approvals = [{ id: 'credential-option', state: 'pending', command }];
    const s = new AgentMonitorStore();
    assert.equal(s.apply(p, 0).disposition, 'accepted');
    const m = s.selected('opencode').packet.monitor;
    assert.ok(m.tools[0].command === undefined, 'tool credential preview must be absent');
    assert.ok(m.approvals[0].command === undefined, 'approval credential preview must be absent');
    const shelf = { hook_event_name: 'AgentDisplayUpdate', coucou_agent: 'hermes', coucou_monitor: {
      version: 1, emitter_id: 'credential-shelf', sequence: 1, scope: 'agent', status: 'awaiting_approval', directory_known: false,
      approvals: [{ id: 'credential-option', state: 'pending', command }],
    } };
    assert.equal(s.apply(shelf, 1).disposition, 'accepted');
    assert.ok(s.observations('hermes')[0].approval.command === undefined, 'shelf credential preview must be absent');
  }
  const p = copy(); p.coucou_monitor.tools[0].command = 'curl --url https://example.invalid';
  const s = new AgentMonitorStore(); s.apply(p, 0);
  assert.equal(s.selected('opencode').packet.monitor.tools[0].command, 'curl --url https://example.invalid/');
});

test('agent shelf bounded across emitters; tuple identities never collide', () => {
  const s = new AgentMonitorStore();
  for (let i = 0; i < 10; i++) s.apply({ hook_event_name: 'AgentDisplayUpdate', coucou_agent: 'hermes', coucou_monitor: {
    version: 1, emitter_id: `e${i}`, sequence: 1, scope: 'agent', status: 'awaiting_approval', directory_known: false,
    approvals: [{ id: 'a', state: 'pending' }],
  } }, i);
  assert.equal(s.observations('hermes').length, 8);
  assert.equal(s.badge('hermes'), 'approval');
  assert.equal(s.observations('hermes').some((o) => o.emitter_id === 'e0'), false);
  for (const [emitter, id] of [['a|b', 'c'], ['a', 'b|c']]) { const p = copy(); p.coucou_monitor.emitter_id = emitter; p.session_id = id; s.apply(p, 20); }
  assert.equal(s.sessions('opencode').length, 2);
});

test('retired emitter rejects first delayed receipt after clear and pause/resume', () => {
  const s = new AgentMonitorStore();
  s.apply(healthy, 0); s.clear(10);
  assert.equal(s.deliver(healthy, 11, 0).disposition, 'ignored');
  assert.equal(s.deliver(healthy, 12, s.generation).disposition, 'ignored');
  assert.equal(s.apply(alive(), 13).disposition, 'ignored');
  s.setPaused(true, 20); s.setPaused(false, 30);
  assert.equal(s.deliver(healthy, 40, s.generation).disposition, 'ignored');
  assert.equal(s.sessions('opencode').length, 0);
  assert.equal(s.apply(healthy, 30009).disposition, 'ignored');
  s.prune(30010);
  assert.equal(s['retired'].size, 0); // Identifiers/deadlines only; no marker history after TTL.
  assert.equal(s.apply(healthy, 30010).disposition, 'accepted'); // Delays beyond the bounded window remain unqualified.
});

function alive(emitter = 'e1', ids = ['s1'], agent = 'opencode') {
  return { hook_event_name: 'AgentDisplayAlive', coucou_agent: agent, coucou_monitor: { version: 1, emitter_id: emitter, active_session_ids: ids } };
}
function ended(emitter = 'e1', id = 's1', agent = 'opencode') {
  return { hook_event_name: 'AgentDisplayUpdate', coucou_agent: agent, ...(id === null ? {} : { session_id: id }),
    coucou_monitor: { version: 1, emitter_id: emitter, sequence: 100, scope: id === null ? 'agent' : 'session', status: 'ended', directory_known: false } };
}
for (const scope of ['session', 'emitter']) test(`valid unseen ${scope}-end rejects first delayed content and heartbeat`, () => {
  const s = new AgentMonitorStore();
  assert.equal(s.apply(ended('e1', scope === 'session' ? 's1' : null), 10).disposition, 'accepted');
  assert.equal(s.apply(healthy, 11).disposition, 'ignored');
  assert.equal(s.apply(alive(), 12).disposition, 'ignored');
  if (scope === 'emitter') {
    const shelf = structuredClone(wire.find((c) => c.name === 'agent-level-passive-approval').packet);
    shelf.coucou_agent = 'opencode'; shelf.coucou_monitor.emitter_id = 'e1';
    assert.equal(s.apply(shelf, 13).disposition, 'ignored');
    assert.equal(s.apply(alive('e1', []), 14).disposition, 'ignored');
  }
  assert.equal(s.sessions('opencode').length, 0);
  assert.equal(s.observations('opencode').length, 0);
  assert.equal(s['retired'].size, 1);
  assert.equal([...s['retired'].values()][0], 30010);
  assert.equal(s.apply(ended('e1', scope === 'session' ? 's1' : null), 29000).disposition, 'ignored');
  assert.equal([...s['retired'].values()][0], 30010);
  s.prune(30010); assert.equal(s['retired'].size, 0);
});

test('unseen session-end preserves admitted siblings and unknown empty roster remains content-free', () => {
  const s = new AgentMonitorStore(); const sibling = copy(); sibling.session_id = 'sibling';
  s.apply(sibling, 0); const selected = s.selected('opencode');
  assert.equal(s.apply(ended(), 1).disposition, 'accepted');
  assert.equal(s.apply(healthy, 2).disposition, 'ignored');
  assert.equal(s.apply(alive('e1', ['sibling']), 3).disposition, 'accepted');
  assert.equal(s.selected('opencode'), selected);
  assert.equal(s.apply(alive('never-seen', []), 4).disposition, 'accepted');
  assert.equal(s['retired'].has(JSON.stringify(['opencode', 'never-seen'])), false);
  const fresh = copy(); fresh.coucou_monitor.emitter_id = 'never-seen';
  assert.equal(s.apply(fresh, 5).disposition, 'accepted'); // Empty roster is not an emitter-end.
});

test('unknown ended-control pressure caps identifiers and uses a fixed per-agent fail-closed window', () => {
  const s = new AgentMonitorStore();
  for (let i = 0; i < 64; i++) assert.equal(s.apply(ended(`control-${i}`, null), 0).disposition, 'accepted');
  assert.equal(s['retired'].size, 64);
  const protection = [...s['retired']];
  assert.equal(s.apply(ended('overflow-first', 'never-seen'), 100).disposition, 'ignored');
  assert.equal(s['closedUntil'].opencode, 30100);
  for (let i = 0; i < 1000; i++) assert.equal(s.apply(ended(`overflow-${i}`, i % 2 ? null : 'never-seen'), 200).disposition, 'ignored');
  assert.deepEqual([...s['retired']], protection);
  assert.equal(s['closedUntil'].opencode, 30100);
  assert.equal(s.apply(healthy, 29000).disposition, 'ignored');
  assert.equal(s.apply(alive(), 29001).disposition, 'ignored');
  const independent = copy(); independent.coucou_agent = 'hermes';
  assert.equal(s.apply(independent, 29002).disposition, 'accepted');
  s.prune(30000); assert.equal(s['retired'].size, 0);
  assert.equal(s.apply(healthy, 30099).disposition, 'ignored');
  s.prune(30100); assert.equal(s['closedUntil'].opencode, 0);
  assert.equal(s.apply(healthy, 30100).disposition, 'accepted'); // Bounded fallback, not permanent shutdown.
});

test('control pressure reserves live cleanup slots and still processes known ends and empty rosters', () => {
  const s = new AgentMonitorStore();
  s.apply(healthy, 0);
  for (let i = 0; i < 63; i++) assert.equal(s.apply(ended(`pressure-${i}`, null), 1).disposition, 'accepted');
  assert.equal(s.apply(ended('pressure-overflow', 'unknown'), 2).disposition, 'ignored');
  assert.equal(s['retired'].size, 63);
  assert.equal(s['closedUntil'].opencode, 30002);
  assert.equal(s.apply(alive('e1', []), 3).disposition, 'accepted');
  assert.equal(s.sessions('opencode').length, 0);
  assert.equal(s['retired'].size, 64);
  assert.equal(s['retired'].has(JSON.stringify(['opencode', 'e1', 'session', 's1'])), true);
  assert.equal(s.apply(healthy, 4).disposition, 'ignored');
  assert.equal(s['closedUntil'].opencode, 30002);
  const other = new AgentMonitorStore(); other.apply(healthy, 0);
  for (let i = 0; i < 63; i++) other.apply(ended(`pressure-${i}`, null), 1);
  other.apply(ended('pressure-overflow', null), 2);
  assert.equal(other.apply(ended(), 3).disposition, 'accepted');
  assert.equal(other.sessions('opencode').length, 0);
  assert.equal(other['retired'].size, 64);
});

test('malformed teardown never arms retirement or cap-pressure windows', () => {
  const s = new AgentMonitorStore();
  for (let i = 0; i < 64; i++) s.apply(ended(`known-${i}`, null), 0);
  const bad = ended('bad-control', null); bad.coucou_monitor.tools = [{ id: 'body', name: 'read', state: 'running' }];
  assert.equal(s.apply(bad, 1).disposition, 'ignored');
  assert.equal(s['closedUntil'].opencode, 0);
  assert.equal(s['retired'].size, 64);
  assert.equal(s['retired'].has(JSON.stringify(['opencode', 'bad-control'])), false);
});
test('retired identities reject held content and liveness after end, agent-end, roster and expiry', () => {
  for (const control of ['ended', 'agent-ended', 'roster', 'expiry']) {
    const s = new AgentMonitorStore(); const held = copy();
    s.apply(healthy, 0);
    const cleanup = control === 'expiry' ? 30000 : 1;
    if (control === 'expiry') s.prune(cleanup);
    else assert.equal(s.apply(control === 'roster' ? alive('e1', []) : ended('e1', control === 'agent-ended' ? null : 's1'), cleanup).disposition, 'accepted');
    assert.equal(s.sessions('opencode').length, 0);
    assert.equal(s.apply(held, cleanup + 1).disposition, 'ignored', control);
    assert.equal(s.apply(alive(), cleanup + 2).disposition, 'ignored', control);
    held.coucou_monitor.sequence = 900;
    assert.equal(s.apply(held, cleanup + 29999).disposition, 'ignored'); // Stale arrivals never extend retirement.
    s.prune(cleanup + 30000);
    assert.equal(s['retired'].size, 0);
  }
});

test('session retirement is isolated; rejected roster cannot clear or refresh another session', () => {
  const s = new AgentMonitorStore(); const next = copy(); next.session_id = 'new';
  s.apply(healthy, 0); s.apply(next, 1); s.apply(ended(), 2);
  const other = s.selected('opencode');
  assert.equal(s.apply(alive(), 29000).disposition, 'ignored');
  assert.equal(s.selected('opencode'), other);
  s.prune(30000); assert.equal(s.sessions('opencode').length, 0); // Rejected heartbeat did not renew e1.
  const separate = copy(); separate.coucou_agent = 'hermes';
  assert.equal(s.apply(separate, 30001).disposition, 'accepted');
});

test('observed approval shelves retire without retaining request, preview, usage or outcome', () => {
  const p = structuredClone(wire.find((c) => c.name === 'agent-level-passive-approval').packet);
  p.coucou_monitor.approvals[0].request_id = 'PRIVATE_REQUEST_MARKER';
  p.coucou_monitor.approvals[0].target = 'PRIVATE_PATH_MARKER';
  for (const cleanup of ['clear', 'agent-end', 'expiry', 'pause']) {
    const s = new AgentMonitorStore(); s.apply(p, 0);
    const at = cleanup === 'expiry' ? 30000 : 10;
    if (cleanup === 'clear') s.clear(at);
    else if (cleanup === 'pause') { s.setPaused(true, at); s.setPaused(false, at + 1); }
    else if (cleanup === 'expiry') s.prune(at);
    else s.apply(ended('h1', null, 'hermes'), at);
    assert.equal(s.apply(p, at + 2).disposition, 'ignored');
    assert.equal(s.apply(alive('h1', [], 'hermes'), at + 3).disposition, 'ignored');
    assert.equal(s.observations('hermes').length, 0);
    for (const [key, deadline] of s['retired']) {
      assert.deepEqual(JSON.parse(key), ['hermes', 'h1']);
      assert.equal(deadline, at + 30000);
    }
    assert.equal(JSON.stringify([...s['retired']]).includes('PRIVATE_'), false);
  }
});

test('64 retirement markers per agent reserve cleanup space and fail closed during cap storms', () => {
  const s = new AgentMonitorStore();
  for (let i = 0; i < 64; i++) {
    const p = copy(); p.coucou_monitor.emitter_id = `storm-${i}`;
    assert.equal(s.apply(p, i * 2).disposition, 'accepted');
    s.clear(i * 2 + 1);
  }
  assert.equal(s['retired'].size, 64);
  const firstDeadline = s['retired'].get(JSON.stringify(['opencode', 'storm-0']));
  for (let i = 64; i < 200; i++) {
    const p = copy(); p.coucou_monitor.emitter_id = `storm-${i}`;
    assert.equal(s.apply(p, 1000).disposition, 'ignored');
    s.clear(1001);
  }
  assert.equal(s['retired'].size, 64);
  assert.equal(s['retired'].get(JSON.stringify(['opencode', 'storm-0'])), firstDeadline);
  const old = copy(); old.coucou_monitor.emitter_id = 'storm-0';
  assert.equal(s.apply(old, 29999).disposition, 'ignored');
  const independent = copy(); independent.coucou_agent = 'hermes';
  assert.equal(s.apply(independent, 29999).disposition, 'accepted');
  s.prune(30001); // One reservation frees at the exact first-marker deadline.
  const fresh = copy(); fresh.coucou_monitor.emitter_id = 'fresh';
  assert.equal(s.apply(fresh, 30001).disposition, 'accepted');
  s.clear(30002);
  assert.equal([...s['retired'].keys()].filter((k) => JSON.parse(k)[0] === 'opencode').length, 64);
  assert.equal(s.apply(fresh, 30003).disposition, 'ignored');
});

test('approval shelf pressure retires discarded sources and bounds previously known emitters', () => {
  const s = new AgentMonitorStore();
  const first = structuredClone(wire.find((c) => c.name === 'agent-level-passive-approval').packet);
  s.apply(first, 0);
  let refused = 0;
  for (let i = 1; i < 100; i++) {
    const p = structuredClone(first); p.coucou_monitor.emitter_id = `shelf-${i}`;
    if (s.apply(p, i).disposition === 'ignored') refused++;
  }
  assert.ok(refused > 0);
  assert.ok(s['retired'].size <= 64);
  s.clear(200);
  assert.equal(s['retired'].size, 64);
  assert.equal(s.apply(first, 201).disposition, 'ignored');
});

test('discarded shelf does not invalidate sibling live sessions; no heartbeat renews its retirement marker', () => {
  const s = new AgentMonitorStore();
  const shelf = structuredClone(wire.find((c) => c.name === 'agent-level-passive-approval').packet);
  s.apply(shelf, 0);
  const live = copy(); live.coucou_agent = 'hermes'; live.coucou_monitor.emitter_id = 'h1';
  s.apply(live, 1);
  for (let i = 1; i <= 8; i++) { const p = structuredClone(shelf); p.coucou_monitor.emitter_id = `other-${i}`; s.apply(p, i + 1); }
  assert.equal(s.apply(shelf, 10).disposition, 'ignored');
  live.coucou_monitor.sequence++;
  assert.equal(s.apply(live, 11).disposition, 'accepted');
  const key = JSON.stringify(['hermes', 'h1', 'agent', null]);
  const deadline = s['retired'].get(key);
  assert.equal(deadline, 30009);
  assert.equal(s.apply(alive('h1', ['s1'], 'hermes'), 29999).disposition, 'accepted');
  assert.equal(s['retired'].get(key), deadline);
  s.prune(30009);
  assert.equal(s['retired'].has(key), false);
  assert.equal(s.sessions('hermes').length, 1);
});

test('agent-end still clears sibling sessions after scoped shelf retirement', () => {
  const s = new AgentMonitorStore();
  const shelf = structuredClone(wire.find((c) => c.name === 'agent-level-passive-approval').packet);
  s.apply(shelf, 0);
  const live = copy(); live.coucou_agent = 'hermes'; live.coucou_monitor.emitter_id = 'h1'; s.apply(live, 1);
  for (let i = 1; i <= 8; i++) { const p = structuredClone(shelf); p.coucou_monitor.emitter_id = `other-${i}`; s.apply(p, i + 1); }
  assert.equal(s.apply(ended('h1', null, 'hermes'), 10).disposition, 'accepted');
  assert.equal(s.sessions('hermes').length, 0);
  assert.equal(s.apply(live, 11).disposition, 'ignored');
  assert.equal(s.apply(alive('h1', ['s1'], 'hermes'), 12).disposition, 'ignored');
});

test('injected clock timestamps clear at cleanup receipt, not last content, and malformed delayed monitor stays rejected', () => {
  let now = 100;
  const s = new AgentMonitorStore(() => now); s.apply(healthy, 0); s.clear();
  assert.equal(s['retired'].get(JSON.stringify(['opencode', 'e1'])), 30100);
  const invalid = copy(); invalid.coucou_monitor.version = 9;
  assert.equal(s.apply(invalid, 200).disposition, 'ignored');
  now = 30099; s.setPaused(true); s.setPaused(false);
  assert.equal(s.apply(healthy, now).disposition, 'ignored');
  s.prune(30100); assert.equal(s['retired'].size, 0);
});

test('replacement clears unknowns; only consistent outcomes; oversized nested IDs reject atomically', () => {
  const s = new AgentMonitorStore(); const p = copy();
  s.apply(p, 0); const initial = s.selected('opencode');
  const invalid = copy(); invalid.coucou_monitor.sequence++;
  invalid.coucou_monitor.tools[0].id = 'é'.repeat(129);
  assert.equal(s.apply(invalid, 1).disposition, 'legacy'); assert.equal(s.selected('opencode'), initial);
  const overcap = copy(); overcap.coucou_monitor.sequence++;
  overcap.coucou_monitor.tools = Array.from({ length: 9 }, (_, i) => ({ id: i === 8 ? 'é'.repeat(129) : `id-${i}`, name: 'read', state: 'running' }));
  assert.equal(s.apply(overcap, 1).disposition, 'legacy'); assert.equal(s.selected('opencode'), initial);
  const next = { hook_event_name: 'AgentDisplayUpdate', coucou_agent: 'opencode', session_id: 's1', coucou_monitor: {
    version: 1, emitter_id: 'e1', sequence: 7, scope: 'session', status: 'working', directory_known: false, outcome: 'completed',
  } };
  s.apply(next, 2);
  const m = s.selected('opencode').packet.monitor;
  for (const key of ['files', 'tools', 'approvals', 'usage', 'model', 'provider', 'outcome']) assert.equal(m[key], undefined);
  assert.equal(s.selected('opencode').packet.cwd, undefined);
  for (const raw of ['{', new Uint8Array([0xff]), null, false]) assert.equal(s.apply(raw, 3).disposition, 'ignored');
});

test('heartbeat renews at exact prune boundary; malformed controls cannot clear; repeated shelf details are not status changes', () => {
  const s = new AgentMonitorStore(); s.apply(healthy, 0);
  const alive = { hook_event_name: 'AgentDisplayAlive', coucou_agent: 'opencode', coucou_monitor: { version: 1, emitter_id: 'e1', active_session_ids: ['s1'] } };
  assert.equal(s.apply(alive, 30000).disposition, 'accepted'); s.prune(30000);
  assert.equal(s.sessions('opencode').length, 1);
  s.apply({ ...alive, coucou_monitor: { ...alive.coucou_monitor, active_session_ids: null } }, 30001);
  assert.equal(s.sessions('opencode').length, 1);
  const p = structuredClone(wire.find((c) => c.name === 'agent-level-passive-approval').packet);
  assert.equal(s.apply(p, 0).status_changed, true); p.coucou_monitor.sequence++;
  assert.equal(s.apply(p, 10).status_changed, false);
});
