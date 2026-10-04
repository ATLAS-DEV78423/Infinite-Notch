// Passive, bounded, memory-only wire consumer. No host or native dependencies.
export type MonitorAgent = 'opencode' | 'hermes';
export type SessionKey = [MonitorAgent, string, 'session', string];
export type MonitorStatus = 'idle' | 'thinking' | 'working' | 'awaiting_approval' | 'retrying' | 'ratelimited' | 'compacting' | 'finished' | 'failed' | 'interrupted' | 'ended' | 'unknown';
export interface MonitorUsage {
  context?: { tokens?: number; limit?: number; quality: 'reported' | 'estimated'; accounting: Accounting };
  totals?: { scope: 'session' | 'observed'; partial?: boolean; input?: number; output?: number; reasoning?: number; cache_read?: number; cache_write?: number; cost_usd?: number; accounting: Accounting };
}
type Accounting = 'includes_cache' | 'excludes_cache' | 'unknown';
export interface MonitorFile { id: string; tool_call_id?: string; path: string; action: 'read' | 'write' | 'edit' | 'reference'; state: 'pending' | 'running' | 'completed' | 'failed'; cwd?: string }
export interface MonitorTool { id: string; name: string; state: 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'cancelled'; command?: string; target?: string; cwd?: string; duration_ms?: number }
export interface MonitorApproval { id: string; request_id?: string; tool_call_id?: string; state: 'pending' | 'approved' | 'denied' | 'cancelled' | 'unknown'; command?: string; target?: string; reason?: 'permission_required' | 'policy' | 'unknown'; cwd?: string }
export interface MonitorSubagent { id: string; session_id?: string; state: 'running' | 'finished' | 'failed' | 'interrupted' | 'unknown'; duration_ms?: number }
export interface MonitorActivity { id: string; kind: 'retry' | 'rate_limit' | 'compaction' | 'error' | 'session_reset'; attempt?: number }
export interface MonitorSnapshot {
  version: 1; emitter_id: string; sequence: number; scope: 'session' | 'agent'; status: MonitorStatus; directory_known: boolean;
  turn_id?: string; parent_session_id?: string; model?: string; provider?: string;
  files?: MonitorFile[]; tools?: MonitorTool[]; approvals?: MonitorApproval[]; subagents?: MonitorSubagent[]; activity?: MonitorActivity[];
  usage?: MonitorUsage; outcome?: 'completed' | 'failed' | 'interrupted' | 'incomplete';
  capabilities?: Partial<Record<'files' | 'context' | 'approvals' | 'subagents' | 'compaction', 'reported' | 'unavailable'>>;
  overflow?: Partial<Record<'files' | 'tools' | 'approvals' | 'subagents' | 'activity' | 'sessions' | 'observations', number>>;
  truncated_fields?: string[];
}
export interface MonitorPacket { agent: MonitorAgent; session_id?: string; cwd?: string; monitor: MonitorSnapshot }
export interface MonitorSession { key: SessionKey; packet: MonitorPacket; received_at_ms: number }
export interface MonitorObservation { emitter_id: string; approval: MonitorApproval; received_at_ms: number }
export interface MonitorApply { disposition: 'legacy' | 'accepted' | 'stale' | 'ignored'; key?: SessionKey; status_changed: boolean }
type Obj = Record<string, unknown>;
const encoder = new TextEncoder();
const obj = (v: unknown): Obj | undefined => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Obj : undefined;
const has = (o: Obj, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const scalarText = (s: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s);
const text = (v: unknown, max: number, nonempty = false): v is string => typeof v === 'string' && scalarText(v) && (!nonempty || v.length > 0) && encoder.encode(v).length <= max;
const number = (v: unknown, integer = true): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER && (!integer || Number.isInteger(v));
const member = <T extends string>(v: unknown, values: readonly T[]): v is T => typeof v === 'string' && values.includes(v as T);
const statuses: MonitorStatus[] = ['idle', 'thinking', 'working', 'awaiting_approval', 'retrying', 'ratelimited', 'compacting', 'finished', 'failed', 'interrupted', 'ended', 'unknown'];
const canonical = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'StopFailure', 'SessionEnd', 'SubagentStart', 'SubagentStop']);
const result = (disposition: MonitorApply['disposition'], key?: SessionKey, status_changed = false): MonitorApply => ({ disposition, ...(key ? { key } : {}), status_changed });

/** Scalar-order tuple comparison, with exact identities (no normalization). */
export function compareKeys(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const aa = Array.from(a[i] ?? '', (c) => c.codePointAt(0)!);
    const bb = Array.from(b[i] ?? '', (c) => c.codePointAt(0)!);
    for (let j = 0; j < Math.max(aa.length, bb.length); j++) {
      if (aa[j] === bb[j]) continue;
      return (aa[j] ?? -1) < (bb[j] ?? -1) ? -1 : 1;
    }
  }
  return 0;
}
export function contextFraction(usage: MonitorUsage): number | null {
  const c = usage.context;
  return c && number(c.tokens) && number(c.limit) && c.limit > 0 && member(c.accounting, ['includes_cache', 'excludes_cache'])
    ? Math.min(1, c.tokens / c.limit) : null;
}

// Suppress ambiguous commands rather than trying to parse an arbitrary shell.
function preview(v: unknown, max: number, command = false): string | undefined {
  if (!text(v, max) || /[\x00-\x1f\x7f]/.test(v)) return;
  if (/(?:authorization|cookie)\s*:|(?:password|passwd|secret|token|api[-_]?key|credential|private[-_]?key)\b\s*(?:=|:)|--?(?:password|passwd|pass|token|secret|api[-_]?key|authorization|cookie|credential|user)(?:\b|=)|\b[A-Za-z_][\w]*=|[a-z][a-z\d+.-]*:\/\/[^\s]*[@?#]/i.test(v)) return;
  // A sentence/free-text payload is not an isolated command preview.
  if (command && /(?:^|\s)["']?-(?:u|p)|(?:^|\s)(?:sh|bash|zsh|powershell|pwsh)\s+.*(?:-c|-[Ee]ncodedCommand)\b|<<|\b(?:password|passwd|secret|token|api[-_]?key|credential)\s+["'\w]/i.test(v)) return;
  return v.replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s'"<>]+/gi, (url) => {
    try { const u = new URL(url); u.username = ''; u.password = ''; u.search = ''; u.hash = ''; return u.toString(); }
    catch { return '[redacted]'; }
  });
}
function identity(v: unknown): string | undefined {
  if (typeof v === 'string' && (!scalarText(v) || encoder.encode(v).length > 256)) throw new Error('identity');
  return text(v, 256, true) ? v : undefined;
}
function optionalIdentity(o: Obj, target: Obj, key: string): boolean {
  if (!has(o, key)) return true;
  const v = identity(o[key]); if (v === undefined) return false;
  target[key] = v; return true;
}
function optionalPreview(o: Obj, target: Obj, key: string, max = 1024) {
  const v = preview(o[key], max, key === 'command'); if (v !== undefined) target[key] = v;
}
function rows(v: unknown, limit: number, parse: (o: Obj) => Obj | undefined): Obj[] | undefined {
  if (!Array.isArray(v) || v.length > limit) return;
  const parsed: Obj[] = []; const ids = new Set<string>();
  for (const raw of v) {
    const o = obj(raw); if (!o) return;
    const id = identity(o.id); if (!id || ids.has(id)) return;
    const row = parse(o); if (!row) return;
    ids.add(id); parsed.push({ id, ...row });
  }
  return parsed;
}
function parseUsage(v: unknown): MonitorUsage | undefined {
  const raw = obj(v); if (!raw) return;
  const usage: MonitorUsage = {};
  for (const key of ['context', 'totals'] as const) {
    const o = obj(raw[key]); if (!o || !member(o.accounting, ['includes_cache', 'excludes_cache', 'unknown'])) continue;
    if (key === 'context' && !member(o.quality, ['reported', 'estimated'])) continue;
    if (key === 'totals' && (!member(o.scope, ['session', 'observed']) || (has(o, 'partial') && typeof o.partial !== 'boolean'))) continue;
    const fields = key === 'context' ? ['tokens', 'limit'] : ['input', 'output', 'reasoning', 'cache_read', 'cache_write', 'cost_usd'];
    if (fields.some((f) => has(o, f) && !number(o[f], f !== 'cost_usd'))) continue;
    const group: Obj = { accounting: o.accounting };
    if (key === 'context') group.quality = o.quality;
    else { group.scope = o.scope; if (has(o, 'partial')) group.partial = o.partial; }
    for (const f of fields) if (has(o, f)) group[f] = o[f];
    Object.assign(usage, { [key]: group });
  }
  return Object.keys(usage).length ? usage : undefined;
}
function noBadUnicode(v: unknown): boolean {
  if (typeof v === 'string') return scalarText(v);
  return !v || typeof v !== 'object' || Object.entries(v).every(([k, value]) => scalarText(k) && noBadUnicode(value));
}
function parsePacket(p: Obj): MonitorPacket | undefined {
  const m = obj(p.coucou_monitor);
  if (!m || !member(p.coucou_agent, ['opencode', 'hermes']) || !(canonical.has(String(p.hook_event_name)) || p.hook_event_name === 'AgentDisplayUpdate')) return;
  const emitter = identity(m.emitter_id);
  if (m.version !== 1 || !emitter || !number(m.sequence) || m.sequence === 0 || !member(m.scope, ['session', 'agent']) || !member(m.status, statuses) || typeof m.directory_known !== 'boolean') return;
  const id = m.scope === 'session' ? identity(p.session_id) : undefined;
  if ((m.scope === 'session' && !id) || (m.scope === 'agent' && has(p, 'session_id'))) return;
  if (m.directory_known ? !text(p.cwd, 1024, true) : has(p, 'cwd') && p.cwd !== '') return;
  const required = ['version', 'emitter_id', 'sequence', 'scope', 'status', 'directory_known'];
  if (m.scope === 'agent' && (m.directory_known || has(p, 'cwd') || Object.keys(m).some((k) => ![...required, 'approvals', 'overflow'].includes(k)))) return;
  if (m.status === 'ended' && (m.directory_known || has(p, 'cwd') || Object.keys(m).some((k) => !required.includes(k)) || Object.keys(p).some((k) => !['hook_event_name', 'coucou_agent', 'session_id', 'coucou_monitor'].includes(k)))) return;
  const monitor: MonitorSnapshot = { version: 1, emitter_id: emitter, sequence: m.sequence, scope: m.scope, status: m.status, directory_known: m.directory_known };
  const out = monitor as unknown as Obj;
  // Identity errors reject atomically even when another row would omit its group.
  for (const [group, fields] of Object.entries({ files: ['id', 'tool_call_id'], tools: ['id'], approvals: ['id', 'request_id', 'tool_call_id'], subagents: ['id', 'session_id'], activity: ['id'] })) {
    if (!Array.isArray(m[group])) continue;
    for (const raw of m[group]) {
      const row = obj(raw);
      if (row) for (const field of fields) if (typeof row[field] === 'string') identity(row[field]);
    }
  }
  for (const key of ['turn_id', 'parent_session_id']) if (!optionalIdentity(m, out, key)) return;
  for (const key of ['model', 'provider']) optionalPreview(m, out, key, 256);
  const parsers: Record<string, [number, (o: Obj) => Obj | undefined]> = {
    files: [20, (o) => {
      const path = preview(o.path, 1024);
      if (path === undefined || !path || !member(o.action, ['read', 'write', 'edit', 'reference']) || !member(o.state, ['pending', 'running', 'completed', 'failed'])) return;
      const r: Obj = { path, action: o.action, state: o.state };
      if (!optionalIdentity(o, r, 'tool_call_id')) return;
      optionalPreview(o, r, 'cwd'); return r;
    }],
    tools: [8, (o) => {
      if (!text(o.name, 256, true) || !member(o.state, ['pending', 'running', 'completed', 'failed', 'blocked', 'cancelled'])) return;
      const name = preview(o.name, 256); if (name === undefined) return;
      const r: Obj = { name, state: o.state };
      for (const k of ['command', 'target', 'cwd']) optionalPreview(o, r, k, k === 'command' ? 1000 : 1024);
      if (number(o.duration_ms, false)) r.duration_ms = o.duration_ms;
      return r;
    }],
    approvals: [8, (o) => {
      if (!member(o.state, ['pending', 'approved', 'denied', 'cancelled', 'unknown'])) return;
      const r: Obj = { state: o.state };
      for (const k of ['request_id', 'tool_call_id']) if (!optionalIdentity(o, r, k)) return;
      for (const k of ['command', 'target', 'cwd']) optionalPreview(o, r, k, k === 'command' ? 1000 : 1024);
      if (member(o.reason, ['permission_required', 'policy', 'unknown'])) r.reason = o.reason;
      return r;
    }],
    subagents: [8, (o) => {
      if (!member(o.state, ['running', 'finished', 'failed', 'interrupted', 'unknown'])) return;
      const r: Obj = { state: o.state }; if (!optionalIdentity(o, r, 'session_id')) return;
      if (number(o.duration_ms, false)) r.duration_ms = o.duration_ms; return r;
    }],
    activity: [20, (o) => {
      if (!member(o.kind, ['retry', 'rate_limit', 'compaction', 'error', 'session_reset'])) return;
      const r: Obj = { kind: o.kind }; if (number(o.attempt) && o.attempt > 0) r.attempt = o.attempt; return r;
    }],
  };
  for (const [key, [limit, parser]] of Object.entries(parsers)) {
    if (!has(m, key)) continue;
    const value = rows(m[key], limit, parser); if (value !== undefined) out[key] = value;
  }
  const usage = parseUsage(m.usage); if (usage) monitor.usage = usage;
  if ((m.status === 'finished' && m.outcome === 'completed') || (m.status === 'failed' && member(m.outcome, ['failed', 'incomplete'])) || (m.status === 'interrupted' && m.outcome === 'interrupted')) monitor.outcome = m.outcome as MonitorSnapshot['outcome'];
  const capabilities = obj(m.capabilities);
  if (capabilities) {
    const safe: Obj = {};
    for (const k of ['files', 'context', 'approvals', 'subagents', 'compaction']) if (member(capabilities[k], ['reported', 'unavailable'])) safe[k] = capabilities[k];
    if (Object.keys(safe).length) out.capabilities = safe;
  }
  const overflow = obj(m.overflow);
  if (overflow) {
    const safe: Obj = {};
    for (const k of ['files', 'tools', 'approvals', 'subagents', 'activity', 'sessions', 'observations']) if (number(overflow[k]) && overflow[k] > 0) safe[k] = overflow[k];
    if (Object.keys(safe).length) out.overflow = safe;
  }
  if (Array.isArray(m.truncated_fields) && m.truncated_fields.length <= 64 && m.truncated_fields.every((v) => text(v, 256) && /^(?:cwd|model|provider|(?:files\[(?:[0-9]|1[0-9])\]\.(?:path|cwd)|(?:tools|approvals)\[[0-7]\]\.(?:command|target|cwd)|tools\[[0-7]\]\.name))$/.test(v))) monitor.truncated_fields = [...m.truncated_fields];
  const cwd = m.directory_known ? preview(p.cwd, 1024) : undefined;
  // A reported directory which cannot safely be displayed becomes unavailable.
  if (m.directory_known && cwd === undefined) monitor.directory_known = false;
  return { agent: p.coucou_agent, ...(id ? { session_id: id } : {}), ...(cwd !== undefined ? { cwd } : {}), monitor };
}

export class AgentMonitorStore {
  private live = new Map<string, MonitorSession>();
  private picks = new Map<string, string>();
  private shelves = new Map<string, { packet: MonitorPacket; rows: MonitorObservation[] }>();
  private deadlines = new Map<string, number>();
  private capacity = new Set<string>();
  // User-approved replay protection: opaque keys + cleanup deadlines only.
  private retired = new Map<string, number>();
  private closedUntil: Record<MonitorAgent, number> = { opencode: 0, hermes: 0 };
  private lastReceiptMs = 0;
  private clock: () => number;
  private listeners = new Set<(urgent: boolean) => void>();
  constructor(clock: () => number = () => performance.now()) { this.clock = clock; }
  generation = 0;
  paused = false;
  subscribe(fn: (urgent: boolean) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private changed(urgent: boolean) { for (const fn of this.listeners) fn(urgent); }
  private emitter(agent: string, emitter: string) { return JSON.stringify([agent, emitter]); }
  private shelfKey(agent: string, emitter: string) { return JSON.stringify([agent, emitter, 'agent', null]); }
  private receipt(now: number): number {
    this.lastReceiptMs = Math.max(this.lastReceiptMs, now);
    for (const [key, expires] of this.retired) if (this.lastReceiptMs >= expires) this.retired.delete(key);
    for (const agent of ['opencode', 'hermes'] as const) if (this.lastReceiptMs >= this.closedUntil[agent]) this.closedUntil[agent] = 0;
    return this.lastReceiptMs;
  }
  private blocked(agent: string, emitter: string, session?: string): boolean {
    return this.retired.has(this.emitter(agent, emitter)) || (session !== undefined && this.retired.has(JSON.stringify([agent, emitter, 'session', session])));
  }
  private room(agent: string): boolean {
    // Reserve each live identity's eventual cleanup slot. Never evict protection.
    return [...this.retired.keys()].filter((key) => JSON.parse(key)[0] === agent).length + this.sessions(agent).length
      + [...this.shelves.values()].filter((s) => s.packet.agent === agent).length < 64;
  }
  private closeAtCapacity(agent: MonitorAgent, now: number) {
    // One fixed pressure window; refused/stale arrivals never renew it.
    if (!this.closedUntil[agent]) this.closedUntil[agent] = now + 30000;
  }
  private retireEmitter(e: string, now: number): boolean {
    if (this.retired.has(e)) return true; // Repeated clears/stale arrivals do not renew TTL.
    const [agent, emitter] = JSON.parse(e) as [MonitorAgent, string];
    const children = [...this.retired.keys()].filter((key) => { const k = JSON.parse(key); return k.length === 4 && k[0] === agent && k[1] === emitter; });
    const reserved = this.deadlines.has(e) || this.shelves.has(e) || children.length > 0 || this.sessions(agent).some((s) => s.packet.monitor.emitter_id === emitter);
    if (!reserved && !this.room(agent)) { this.closeAtCapacity(agent, now); return false; }
    for (const key of children) this.retired.delete(key);
    this.retired.set(e, now + 30000);
    return true;
  }
  private removeSession(id: string, now: number): SessionKey | undefined {
    const session = this.live.get(id);
    const [agent] = JSON.parse(id) as SessionKey;
    if (!session && !this.retired.has(id) && !this.room(agent)) { this.closeAtCapacity(agent, now); return; }
    if (!this.retired.has(id)) this.retired.set(id, now + 30000);
    this.live.delete(id);
    return session?.key;
  }
  private retireShelf(e: string, now: number) {
    const [agent, emitter] = JSON.parse(e) as [string, string];
    if (!this.sessions(agent).some((s) => s.packet.monitor.emitter_id === emitter)) this.retireEmitter(e, now);
    else {
      const key = this.shelfKey(agent, emitter);
      if (!this.retired.has(key)) this.retired.set(key, now + 30000);
    }
  }
  sessions(agent: string): MonitorSession[] { return [...this.live.values()].filter((s) => s.packet.agent === agent); }
  selected(agent: string): MonitorSession | undefined { const key = this.picks.get(agent); return key ? this.live.get(key) : undefined; }
  select(agent: string, key: SessionKey): void {
    const id = JSON.stringify(key); if (key[0] === agent && this.live.has(id)) { this.picks.set(agent, id); this.changed(true); }
  }
  observations(agent: string): MonitorObservation[] { return [...this.shelves.values()].filter((s) => s.packet.agent === agent).flatMap((s) => s.rows); }
  overflow(agent: string): number {
    return Math.max(this.capacity.has(agent) ? 1 : 0, ...this.sessions(agent).map((s) => s.packet.monitor.overflow?.sessions ?? 0), ...[...this.shelves.values()].filter((s) => s.packet.agent === agent).map((s) => s.packet.monitor.overflow?.sessions ?? 0));
  }
  badge(agent: string): 'approval' | 'error' | 'finished' | null {
    const ms = this.sessions(agent).map((s) => s.packet.monitor);
    if (this.observations(agent).some((o) => o.approval.state === 'pending') || ms.some((m) => m.status === 'awaiting_approval' || m.approvals?.some((a) => a.state === 'pending'))) return 'approval';
    if (ms.some((m) => m.status === 'failed')) return 'error';
    return ms.some((m) => m.status === 'finished') ? 'finished' : null;
  }
  clear(nowMs = this.clock()): void {
    const now = this.receipt(nowMs);
    const emitters = new Set([...this.deadlines.keys(), ...[...this.retired.keys()].map((key) => { const k = JSON.parse(key); return this.emitter(k[0], k[1]); })]);
    for (const e of emitters) this.retireEmitter(e, now);
    this.generation++; this.live.clear(); this.picks.clear(); this.shelves.clear(); this.deadlines.clear(); this.capacity.clear(); this.changed(true);
  }
  setPaused(paused: boolean, nowMs = this.clock()): void { this.paused = paused; this.clear(nowMs); }
  deliver(payload: unknown, nowMs: number, generation = this.generation): MonitorApply {
    if (!number(nowMs, false)) return result('ignored');
    nowMs = this.receipt(nowMs);
    return this.paused || generation !== this.generation ? result('ignored') : this.apply(payload, nowMs);
  }
  private tidy(): void {
    for (const a of ['opencode', 'hermes']) {
      const sessions = this.sessions(a);
      if (!this.selected(a)) {
        sessions.sort((x, y) => y.received_at_ms - x.received_at_ms || compareKeys(x.key, y.key));
        if (sessions[0]) this.picks.set(a, JSON.stringify(sessions[0].key)); else this.picks.delete(a);
      }
      if (sessions.length < 16) this.capacity.delete(a);
    }
    for (const e of this.deadlines.keys()) if (![...this.live.values()].some((s) => this.emitter(s.packet.agent, s.packet.monitor.emitter_id) === e) && !this.shelves.has(e)) this.deadlines.delete(e);
  }
  private removeEmitter(e: string, now: number): SessionKey[] {
    this.retireEmitter(e, now);
    const removed: SessionKey[] = [];
    for (const [id, s] of this.live) if (this.emitter(s.packet.agent, s.packet.monitor.emitter_id) === e) { removed.push(s.key); this.live.delete(id); }
    this.shelves.delete(e); this.deadlines.delete(e); return removed;
  }
  prune(nowMs: number): SessionKey[] {
    if (!number(nowMs, false)) return [];
    nowMs = this.receipt(nowMs);
    const removed: SessionKey[] = []; let changed = false;
    for (const [e, deadline] of this.deadlines) if (nowMs >= deadline) { removed.push(...this.removeEmitter(e, nowMs)); changed = true; }
    if (changed) { this.tidy(); this.changed(true); } return removed;
  }
  apply(payload: unknown, nowMs: number): MonitorApply {
    if (!number(nowMs, false)) return result('ignored');
    nowMs = this.receipt(nowMs);
    if (this.paused) return result('ignored');
    const p = obj(payload); if (!p) return result('ignored');
    try {
      const serialized = JSON.stringify(p);
      if (encoder.encode(serialized).length > 65536 || !noBadUnicode(p)) return result('ignored');
      const raw = obj(p.coucou_monitor);
      const closed = member(p.coucou_agent, ['opencode', 'hermes']) && this.closedUntil[p.coucou_agent] > 0;
      if (closed && raw?.status !== 'ended' && p.hook_event_name !== 'AgentDisplayAlive') return result('ignored');
      // Also guard canonical legacy fallback from a previously retired source.
      if (member(p.coucou_agent, ['opencode', 'hermes']) && raw && text(raw.emitter_id, 256, true)
        && (this.blocked(p.coucou_agent, raw.emitter_id, text(p.session_id, 256, true) ? p.session_id : undefined)
          || (raw.scope === 'agent' && raw.status !== 'ended' && this.retired.has(this.shelfKey(p.coucou_agent, raw.emitter_id))))) return result('ignored');
      if (p.hook_event_name === 'AgentDisplayAlive') return this.alive(p, nowMs);
      let packet: MonitorPacket | undefined;
      try { packet = parsePacket(p); } catch { /* Invalid opaque identity rejects the monitor. */ }
      if (!packet) return result(!closed && canonical.has(String(p.hook_event_name)) ? 'legacy' : 'ignored');
      const m = packet.monitor; const e = this.emitter(packet.agent, m.emitter_id);
      if (m.scope === 'agent') {
        const old = this.shelves.get(e);
        if (old && m.sequence <= old.packet.monitor.sequence) return result('stale');
        if (m.status === 'ended') {
          const changed = this.shelves.has(e) || this.sessions(packet.agent).some((s) => s.packet.monitor.emitter_id === m.emitter_id);
          if (!this.retireEmitter(e, nowMs)) return result('ignored');
          this.removeEmitter(e, nowMs); this.tidy(); this.changed(true); return result('accepted', undefined, changed);
        }
        if (!old && !this.room(packet.agent)) return result('ignored');
        const before = JSON.stringify(this.observations(packet.agent).map(({ emitter_id, approval }) => ({ emitter_id, approval })));
        if (!this.deadlines.has(e)) this.deadlines.set(e, nowMs + 30000);
        const rows = (m.approvals ?? []).map((approval) => ({ emitter_id: m.emitter_id, approval, received_at_ms: nowMs }));
        this.shelves.set(e, { packet, rows });
        const retained = this.observations(packet.agent).sort((a, b) => b.received_at_ms - a.received_at_ms || compareKeys([a.emitter_id, a.approval.id], [b.emitter_id, b.approval.id])).slice(0, 8);
        for (const [key, shelf] of this.shelves) if (shelf.packet.agent === packet.agent) {
          const known = shelf.rows.length > 0 || (key === e && old !== undefined);
          shelf.rows = shelf.rows.filter((row) => retained.includes(row));
          // Never retain discarded observations in the sanitized packet either.
          if (shelf.rows.length) shelf.packet.monitor.approvals = shelf.rows.map((r) => r.approval);
          else { if (known) this.retireShelf(key, nowMs); this.shelves.delete(key); }
        }
        this.tidy(); this.changed(true);
        return result('accepted', undefined, before !== JSON.stringify(this.observations(packet.agent).map(({ emitter_id, approval }) => ({ emitter_id, approval }))) || (this.shelves.has(e) && old?.packet.monitor.status !== m.status));
      }
      const key: SessionKey = [packet.agent, m.emitter_id, 'session', packet.session_id!]; const id = JSON.stringify(key);
      const old = this.live.get(id);
      if (old && m.sequence <= old.packet.monitor.sequence) return result('stale', key);
      if (m.status === 'ended') {
        this.removeSession(id, nowMs);
        if (!this.retired.has(id)) return result('ignored');
        this.tidy(); this.changed(true); return result('accepted', key, !!old);
      }
      if (!old && (this.sessions(packet.agent).length >= 16 || !this.room(packet.agent))) { this.capacity.add(packet.agent); this.changed(true); return result('ignored'); }
      const newTurn = p.hook_event_name === 'UserPromptSubmit' || (m.turn_id !== undefined && m.turn_id !== old?.packet.monitor.turn_id);
      if (p.hook_event_name === 'UserPromptSubmit') { delete m.outcome; delete m.activity; }
      if (old && !newTurn && m.turn_id === old.packet.monitor.turn_id && m.status === 'idle' && member(old.packet.monitor.status, ['failed', 'interrupted'])) {
        m.status = old.packet.monitor.status;
        if (old.packet.monitor.outcome) m.outcome = old.packet.monitor.outcome;
      }
      if (!this.deadlines.has(e)) this.deadlines.set(e, nowMs + 30000);
      this.live.set(id, { key, packet, received_at_ms: nowMs }); this.tidy();
      const changed = !old || old.packet.monitor.status !== m.status;
      const urgent = ['awaiting_approval', 'finished', 'failed', 'interrupted'].includes(m.status) || JSON.stringify(old?.packet.monitor.approvals) !== JSON.stringify(m.approvals);
      this.changed(urgent); return result('accepted', key, changed);
    } catch { return result('ignored'); }
  }
  private alive(p: Obj, now: number): MonitorApply {
    const m = obj(p.coucou_monitor);
    if (!member(p.coucou_agent, ['opencode', 'hermes']) || Object.keys(p).some((k) => !['hook_event_name', 'coucou_agent', 'coucou_monitor'].includes(k)) || !m || Object.keys(m).some((k) => !['version', 'emitter_id', 'active_session_ids'].includes(k)) || m.version !== 1) return result('ignored');
    const emitter = identity(m.emitter_id); const ids = m.active_session_ids;
    if (!emitter || !Array.isArray(ids) || ids.length > 16 || !ids.every((id) => identity(id)) || new Set(ids).size !== ids.length) return result('ignored');
    const e = this.emitter(p.coucou_agent, emitter); let changed = false;
    if (this.retired.has(this.shelfKey(p.coucou_agent, emitter)) && !this.sessions(p.coucou_agent).some((s) => s.packet.monitor.emitter_id === emitter)) return result('ignored');
    if (ids.some((id) => this.blocked(p.coucou_agent as string, emitter, id))) return result('ignored');
    const closed = this.closedUntil[p.coucou_agent] > 0;
    // Existing empty rosters still clear their admitted sessions; nothing renews.
    if (closed && (ids.length > 0 || !this.deadlines.has(e))) return result('ignored');
    if (!this.deadlines.has(e)) return result('accepted');
    if (!closed) this.deadlines.set(e, now + 30000);
    for (const [key, s] of this.live) if (this.emitter(s.packet.agent, s.packet.monitor.emitter_id) === e && !ids.includes(s.packet.session_id)) { this.removeSession(key, now); changed = true; }
    this.tidy(); if (changed) this.changed(true); return result('accepted', undefined, changed);
  }
}

export const monitorStatusText: Record<MonitorStatus, string> = {
  idle: 'Idle', thinking: 'Thinking', working: 'Working', awaiting_approval: 'Approval observed', retrying: 'Retrying', ratelimited: 'Rate limited', compacting: 'Compacting context', finished: 'Turn completed', failed: 'Turn failed', interrupted: 'Turn interrupted', ended: 'Session ended — details cleared', unknown: 'Status unavailable',
};
