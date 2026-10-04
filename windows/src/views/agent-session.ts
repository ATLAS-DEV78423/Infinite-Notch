import { h } from './dom';
import { State } from '../core/state';
import { contextFraction, monitorStatusText, type MonitorAgent, type MonitorApproval, type SessionKey } from '../core/agent-monitor';
import type { ViewActions, ViewHost } from './views';

const outcomeText = { completed: 'Turn completed', failed: 'Turn failed', interrupted: 'Turn interrupted', incomplete: 'Turn incomplete' };
const activityText = { retry: 'Retrying', rate_limit: 'Rate limited', compaction: 'Compacting context', error: 'Operation failed', session_reset: 'Session reset' };
const reasonText = { permission_required: 'Approval required', policy: 'Agent policy', unknown: 'Reason unavailable' };
const numberText = (n: number | undefined) => n === undefined ? 'Unavailable' : n.toLocaleString('en-US', { maximumSignificantDigits: 17 });
function text(el: HTMLElement, value: string) { if (el.textContent !== value) el.textContent = value; }

/** Persistent controls and keyed rows; only sanitized snapshots enter this DOM. */
export function buildAgentSession(actions: Pick<ViewActions, 'setView'>): ViewHost {
  const back = h('button', { class: 'btn secondary', text: 'Back', 'data-back': true, onclick: () => actions.setView('overview') });
  const who = h('div', { class: 'monitor-who' });
  const selector = h('select', { 'aria-label': 'Agent session' });
  const directory = h('div', { class: 'monitor-directory', tabindex: 0, 'aria-label': 'Selected session directory' });
  const status = h('div', { class: 'monitor-status', role: 'status' });
  const freshness = h('div', { class: 'monitor-caption' });
  const liveRows = h('div', { class: 'monitor-scroll', 'data-live-rows': true, tabindex: 0, 'aria-label': 'Live commands, approvals and files' });
  const usageRows = h('div', { class: 'monitor-scroll', tabindex: 0, 'aria-label': 'Usage and agent status' });
  const context = h('div', { class: 'monitor-caption' });
  const gauge = h('meter', { min: 0, max: 1, value: 0, 'aria-label': 'Context usage' });
  const totals = h('div', { class: 'monitor-caption' });
  const note = h('div', { class: 'monitor-caption' });
  const details = h('div', { class: 'monitor-details' });
  usageRows.append(context, gauge, totals, note, details);
  const el = h('div', { class: 'view agent-session', 'aria-label': 'Passive agent session inspector' },
    h('div', { class: 'card monitor-left' }, h('div', { class: 'monitor-head' }, who, back), selector, directory, status, freshness, liveRows),
    h('div', { class: 'card monitor-right' }, h('div', { class: 'monitor-section', text: 'Usage & status' }), usageRows),
  );
  let agent: MonitorAgent = 'opencode';
  let timer: number | null = null;
  let lastSync = -Infinity;
  let renderedKey = '';
  const options = new Map<string, HTMLOptionElement>();
  const rows = new Map<string, HTMLElement>();
  const statusRows = new Map<string, HTMLElement>();

  function keyed(parent: HTMLElement, retained: Map<string, HTMLElement>, values: [string, string][]) {
    const keys = new Set(values.map(([key]) => key));
    for (const [key, row] of retained) if (!keys.has(key)) { row.textContent = ''; row.remove(); retained.delete(key); }
    values.forEach(([key, value], index) => {
      let row = retained.get(key);
      if (!row) { row = h('div', { class: 'monitor-row' }); retained.set(key, row); }
      text(row, value);
      if (parent.children[index] !== row) parent.insertBefore(row, parent.children[index] ?? null);
    });
  }
  function render() {
    const liveScroll = liveRows.scrollTop;
    const usageScroll = usageRows.scrollTop;
    if (timer !== null) window.clearTimeout(timer); timer = null; lastSync = performance.now();
    const focus = State.focusTask?.id;
    if (focus === 'agent_opencode' || focus === 'agent_hermes') agent = focus === 'agent_opencode' ? 'opencode' : 'hermes';
    const store = State.agentMonitor;
    const sessions = store.sessions(agent);
    const selected = store.selected(agent);
    const m = selected?.packet.monitor;
    const current = selected ? JSON.stringify(selected.key) : '';
    const optionKeys = new Set(sessions.map((s) => JSON.stringify(s.key)));
    for (const [key, option] of options) if (!optionKeys.has(key)) { option.textContent = ''; option.value = ''; option.remove(); options.delete(key); }
    for (const s of sessions) {
      const key = JSON.stringify(s.key);
      let option = options.get(key);
      if (!option) { option = h('option', { value: key }); selector.append(option); options.set(key, option); }
      const label = `${s.packet.session_id} · ${s.packet.monitor.emitter_id}`;
      if (option.textContent !== label) option.textContent = label;
    }
    selector.disabled = !sessions.length; selector.value = current;
    text(who, `${agent === 'opencode' ? 'OpenCode' : 'Hermes'} · ${sessions.length} session${sessions.length === 1 ? '' : 's'}`);
    text(directory, selected?.packet.cwd ?? (selected ? 'Directory unavailable' : 'Session ended — details cleared'));
    text(status, m ? (m.outcome ? outcomeText[m.outcome] : monitorStatusText[m.status]) : 'Session ended — details cleared');
    const age = selected ? performance.now() - selected.received_at_ms : 0;
    text(freshness, age >= 30000 ? `Last update ${Math.floor(age / 1000)}s ago` : '');
    const values: [string, string][] = [];
    const rowKey = (group: string, id: string, emitter = m?.emitter_id ?? '') => JSON.stringify([current, group, emitter, id]);
    const source = agent === 'opencode' ? 'OpenCode' : 'Hermes';
    const approvalText = (a: MonitorApproval, unattributed = false) => `${unattributed ? 'Unattributed approval' : 'Approval'} ${a.state} · ${a.request_id !== undefined ? `Request ID: ${a.request_id}` : `Observation ID: ${a.id} (producer)`} · ${a.command ?? a.target ?? 'Preview unavailable'}${a.cwd ? ` · ${a.cwd}` : ''}${a.reason ? ` · ${reasonText[a.reason]}` : ''} · ${a.state === 'pending' ? `Awaiting approval in ${source}` : `Respond in ${source}`}`;
    for (const a of m?.approvals ?? []) values.push([rowKey('approval', a.id), approvalText(a)]);
    for (const o of store.observations(agent)) values.push([rowKey('observation', o.approval.id, o.emitter_id), approvalText(o.approval, true)]);
    for (const t of m?.tools ?? []) values.push([rowKey('tool', t.id), `${t.name} · ${t.state} · ${t.command ?? t.target ?? 'Preview unavailable'}${t.cwd ? ` · ${t.cwd}` : ''}${t.duration_ms === undefined ? '' : ` · ${numberText(t.duration_ms)} ms`}`]);
    for (const f of m?.files ?? []) values.push([rowKey('file', f.id), `${f.action} · ${f.state} · ${f.path}${f.cwd ? ` · ${f.cwd}` : ''}`]);
    if (!values.length) values.push(['empty', selected ? 'No live paths or commands reported' : 'Session ended — details cleared']);
    keyed(liveRows, rows, values);
    const c = m?.usage?.context;
    text(context, c ? `${c.quality === 'estimated' ? '~ Estimated · ' : 'Reported · '}Context ${numberText(c.tokens)} / ${numberText(c.limit)} tokens · ${c.accounting.replaceAll('_', ' ')}` : 'Context unavailable');
    const fraction = contextFraction(m?.usage ?? {});
    gauge.hidden = fraction === null; gauge.value = fraction ?? 0;
    const t = m?.usage?.totals;
    text(totals, t ? `${t.scope === 'observed' ? 'Since monitoring started' : 'Session totals'}${t.partial ? ' · Partial' : ''} · ${t.accounting.replaceAll('_', ' ')}` : 'Totals unavailable');
    const detail: [string, string][] = [];
    if (t) for (const [key, label] of [['input', 'Input'], ['output', 'Output'], ['reasoning', 'Reasoning'], ['cache_read', 'Cache read'], ['cache_write', 'Cache write'], ['cost_usd', 'Reported cost USD']] as const)
      detail.push([key, `${label} · ${numberText(t[key])}`]);
    for (const child of m?.subagents ?? []) detail.push([rowKey('child', child.id), `Subagent ${child.session_id ?? child.id} · ${child.state}${child.duration_ms === undefined ? '' : ` · ${numberText(child.duration_ms)} ms`}`]);
    for (const a of m?.activity ?? []) detail.push([rowKey('activity', a.id), `${activityText[a.kind]}${a.attempt === undefined ? '' : ` · Attempt ${a.attempt}`}`]);
    if (m?.parent_session_id) detail.push(['parent', `Parent session · ${m.parent_session_id}`]);
    if (m?.model) detail.push(['model', `Model · ${m.model}`]);
    if (m?.provider) detail.push(['provider', `Provider · ${m.provider}`]);
    for (const [key, value] of Object.entries(m?.capabilities ?? {})) if (value === 'unavailable') detail.push([`capability-${key}`, `${key} unavailable`]);
    keyed(details, statusRows, detail);
    const omissions = Object.entries(m?.overflow ?? {}).map(([key, count]) => `${count} ${key}`);
    const capacity = store.overflow(agent);
    if (capacity && !(m?.overflow?.sessions)) omissions.push(`${capacity}+ sessions`);
    text(note, [m?.truncated_fields?.length ? 'Truncated' : '', omissions.length ? `Not shown: ${omissions.join(', ')}` : ''].filter(Boolean).join(' · '));
    liveRows.scrollTop = current === renderedKey ? liveScroll : 0;
    usageRows.scrollTop = current === renderedKey ? usageScroll : 0;
    renderedKey = current;
  }
  function sync() {
    // Never retain a removed session's DOM until the next ordinary update.
    if (performance.now() - lastSync >= 250) render();
    else if (timer === null) timer = window.setTimeout(render, Math.max(0, 250 - (performance.now() - lastSync)));
  }
  State.agentMonitor.subscribe((urgent) => urgent ? render() : sync());
  selector.addEventListener('change', () => {
    const key = selector.value;
    if (options.has(key)) State.agentMonitor.select(agent, JSON.parse(key) as SessionKey);
  });
  el.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); actions.setView('overview'); }
  });
  return { el, sync, focus: () => back.focus(), tick(now) { if (now - lastSync >= 1000) render(); } };
}
