import assert from 'node:assert/strict';
import test from 'node:test';
import { IslandStateMachine } from '../windows/src/island/fsm.ts';

// Fake only the external clock/window timer boundary; exercise the real FSM.
function clock(t: test.TestContext) {
  let now = 0;
  let nextId = 0;
  const pending = new Map<number, { at: number; run: () => void }>();
  const captured: (() => void)[] = [];
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousPerformance = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    setTimeout(run: () => void, delay: number) {
      captured.push(run);
      pending.set(++nextId, { at: now + delay, run });
      return nextId;
    },
    clearTimeout(id: number) { pending.delete(id); },
  } });
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => now } });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (previousPerformance) Object.defineProperty(globalThis, 'performance', previousPerformance);
  });
  return {
    captured,
    advance(ms: number) {
      const end = now + ms;
      while (true) {
        const due = [...pending].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = end;
    },
  };
}

test('hover_opens_full_after_delay', (t) => {
  const time = clock(t);
  const fsm = new IslandStateMachine();
  fsm.mouseEntered(); time.advance(0);
  assert.equal(fsm.state, 'home', 'default hover must open full, not compact');
  fsm.forceHidden();
  fsm.hoverOpenDelayMs = 250;
  fsm.mouseEntered(); time.advance(249);
  assert.equal(fsm.state, 'hidden');
  time.advance(1);
  assert.equal(fsm.state, 'home');
  fsm.forceHidden(); fsm.reveal(); fsm.mouseEntered(); time.advance(250);
  assert.equal(fsm.state, 'home', 'compact work reveal also expands on hover');
});

test('leave_cancels_delayed_open', (t) => {
  const time = clock(t);
  const fsm = new IslandStateMachine(); fsm.hoverOpenDelayMs = 250;
  const transitions: string[] = [];
  fsm.onTransition = (_, to) => transitions.push(to);
  fsm.mouseEntered(); time.advance(249); fsm.mouseLeft(); time.advance(60_000);
  assert.equal(fsm.state, 'hidden', 'leaving before the delay must never open');
  assert.deepEqual(transitions, [], 'no intermediate compact or expanded opening is allowed');
});

test('reenter_cancels_300ms_collapse', (t) => {
  const time = clock(t);
  const fsm = new IslandStateMachine();
  fsm.mouseEntered(); time.advance(0); fsm.mouseLeft(); time.advance(299);
  assert.equal(fsm.state, 'home');
  fsm.mouseEntered(); time.advance(1000);
  assert.equal(fsm.state, 'home');
  fsm.mouseLeft(); time.advance(299);
  assert.equal(fsm.state, 'home');
  time.advance(1);
  assert.equal(fsm.state, 'petit', 'hover folds exactly 300 ms after the latest leave');
  time.advance(59_999); assert.equal(fsm.state, 'petit');
  time.advance(1); assert.equal(fsm.state, 'hidden');
});

test('explicit_open_keeps_autoclose', (t) => {
  const time = clock(t);
  const fsm = new IslandStateMachine();
  fsm.forceHome(); time.advance(14_999);
  assert.equal(fsm.state, 'home');
  time.advance(1);
  assert.equal(fsm.state, 'petit', 'explicit open outside the island auto-closes after 15 s');
  fsm.homeToPetitDelay = 30;
  fsm.forceHome(); fsm.mouseEntered(); time.advance(60_000);
  assert.equal(fsm.state, 'home');
  fsm.mouseLeft(); time.advance(29_999); assert.equal(fsm.state, 'home');
  time.advance(1); assert.equal(fsm.state, 'petit');
});

test('holds_are_independent', (t) => {
  const time = clock(t);
  const fsm = new IslandStateMachine();
  fsm.mouseEntered(); time.advance(0);
  fsm.setHold('approval', true); fsm.setHold('inspector', true); fsm.setHold('drag', true);
  fsm.setHold('keyboard', true); fsm.setHold('menu', true); fsm.mouseLeft();
  fsm.setHold('inspector', false); fsm.setHold('drag', false);
  fsm.setHold('keyboard', false); fsm.setHold('menu', false);
  time.advance(60_000);
  assert.equal(fsm.state, 'home', 'approval survives clearing every other owner');
  fsm.setHold('approval', false); time.advance(300);
  assert.equal(fsm.state, 'petit');
  for (const owner of ['inspector', 'keyboard', 'drag', 'menu'] as const) {
    fsm.forceHome(); fsm.setHold(owner, true); fsm.pinned = true; fsm.pinned = false;
    time.advance(60_000); assert.equal(fsm.state, 'home', `${owner} survives approval release`);
    fsm.setHold(owner, false); time.advance(15_000); assert.equal(fsm.state, 'petit');
  }
});

test('cancel_invalidates_queued_callback', (t) => {
  const time = clock(t);
  const fsm = new IslandStateMachine();
  fsm.hoverOpenDelayMs = 250;
  fsm.mouseEntered();
  assert.ok(time.captured.length, 'delayed opening schedules a real timer');
  const open = time.captured.at(-1)!;
  fsm.cancelTimers(); open(); assert.equal(fsm.state, 'hidden');
  fsm.forceHome(); fsm.mouseLeft(); const close = time.captured.at(-1)!;
  fsm.cancelTimers(); close(); assert.equal(fsm.state, 'home', 'a queued canceled collapse must not run');
  fsm.mouseLeft(); const oldClose = time.captured.at(-1)!;
  fsm.mouseEntered(); fsm.mouseLeft(); oldClose();
  assert.equal(fsm.state, 'home', 'replaced collapse cannot win over its successor');
  fsm.forcePetit(); fsm.mouseLeft(); const hide = time.captured.at(-1)!;
  fsm.forceHidden(); fsm.reveal(); hide(); assert.equal(fsm.state, 'petit');
  fsm.launch(); fsm.greetComplete(); const greet = time.captured.at(-1)!;
  fsm.forceHome(); greet(); assert.equal(fsm.state, 'home');
});

test('hidden_click_bypasses_delay_and_hover_click_becomes_explicit', (t) => {
  const time = clock(t);
  const fsm = new IslandStateMachine(); fsm.hoverOpenDelayMs = 1000;
  fsm.click(); assert.equal(fsm.state, 'home');
  fsm.forceHidden(); fsm.hoverOpenDelayMs = 0;
  fsm.mouseEntered(); time.advance(0); fsm.click(); fsm.mouseLeft(); time.advance(300);
  assert.equal(fsm.state, 'home', 'clicked hover-open uses explicit auto-close');
  time.advance(14_700); assert.equal(fsm.state, 'petit');
});

test('entry_bookkeeping_precedes_transition_and_deadlines_follow_holds', (t) => {
  const time = clock(t);
  const fsm = new IslandStateMachine();
  fsm.onTransition = (_, to) => {
    if (to === 'home') { fsm.setInteractionHold(true); fsm.setInteractionHold(false); }
  };
  fsm.mouseEntered(); time.advance(60_000); assert.equal(fsm.state, 'home');
  assert.equal(fsm.homeCollapseAt, null);
  fsm.mouseLeft(); assert.equal(fsm.homeCollapseAt, 60_300);
  fsm.setHold('keyboard', true); assert.equal(fsm.homeCollapseAt, null);
  time.advance(50); fsm.setHold('keyboard', false); assert.equal(fsm.homeCollapseAt, 60_350);
  time.advance(300); assert.equal(fsm.state, 'petit');
});

test('held_greeting_leave_waits_for_the_last_owner_then_resumes_collapse', (t) => {
  const time = clock(t);
  const fsm = new IslandStateMachine();
  fsm.launch(); fsm.setHold('keyboard', true); fsm.mouseEntered(); fsm.mouseLeft();
  assert.equal(fsm.state, 'coucou', 'pointer leave cannot fold a keyboard-held greeting');
  fsm.pinned = true; fsm.setHold('drag', true);
  fsm.setHold('keyboard', false); fsm.setHold('drag', false); time.advance(60_000);
  assert.equal(fsm.state, 'coucou'); assert.equal(fsm.pinned, true);
  fsm.pinned = false; time.advance(599); assert.equal(fsm.state, 'coucou');
  time.advance(1); assert.equal(fsm.state, 'petit');
});

test('held_greeting_completion_preserves_hover_delay_and_invalidates_queued_collapse', (t) => {
  const time = clock(t);
  const fsm = new IslandStateMachine();
  fsm.launch(); fsm.greetComplete(); const completion = time.captured.at(-1)!;
  fsm.setHold('inspector', true); completion(); time.advance(1000);
  assert.equal(fsm.state, 'coucou', 'held completion invalidates an already queued auto-collapse');
  fsm.setHold('inspector', false); completion(); time.advance(599); assert.equal(fsm.state, 'coucou');
  time.advance(1); assert.equal(fsm.state, 'petit');
  fsm.launch(); fsm.mouseEntered(); const hover = time.captured.at(-1)!;
  fsm.setHold('menu', true); fsm.greetComplete(); hover(); time.advance(20_000);
  assert.equal(fsm.state, 'coucou', 'completion cannot fold a held, hovered greeting');
  fsm.setHold('menu', false); time.advance(9999); assert.equal(fsm.state, 'coucou');
  time.advance(1); assert.equal(fsm.state, 'petit', 'release resumes the 10 s hover intent, not the 600 ms completion timer');
});

test('held_compact_hide_resumes_only_after_the_last_owner_releases', (t) => {
  const time = clock(t);
  const fsm = new IslandStateMachine();
  fsm.reveal(); const hide = time.captured.at(-1)!;
  fsm.pinned = true; fsm.setHold('drag', true); hide(); time.advance(60_000);
  assert.equal(fsm.state, 'petit', 'compact approval cannot disappear behind another owner');
  fsm.setHold('drag', false); time.advance(60_000);
  assert.equal(fsm.state, 'petit'); assert.equal(fsm.pinned, true);
  fsm.pinned = false; hide(); time.advance(59_999); assert.equal(fsm.state, 'petit');
  time.advance(1); assert.equal(fsm.state, 'hidden');
});

test('hold_release_does_not_revive_a_canceled_greeting_or_hide_a_newer_view', (t) => {
  const time = clock(t);
  const fsm = new IslandStateMachine();
  fsm.launch(); fsm.greetComplete(); const greeting = time.captured.at(-1)!;
  fsm.setHold('keyboard', true); fsm.cancelTimers(); fsm.setHold('keyboard', false);
  greeting(); time.advance(20_000);
  assert.equal(fsm.state, 'coucou', 'cancel invalidates deferred greeting intent as well as queued callbacks');
  fsm.forcePetit(); const hide = time.captured.at(-1)!;
  fsm.setHold('drag', true); fsm.forceHome(); fsm.pinned = true; fsm.setHold('drag', false);
  greeting(); hide(); time.advance(60_000);
  assert.equal(fsm.state, 'home'); assert.equal(fsm.pinned, true);
  fsm.pinned = false; time.advance(14_999); assert.equal(fsm.state, 'home');
  time.advance(1); assert.equal(fsm.state, 'petit', 'final release uses only the current explicit view timer');
});

test('every_owner_blocks_greeting_completion_and_compact_hide', (t) => {
  const time = clock(t);
  const fsm = new IslandStateMachine();
  for (const owner of ['approval', 'inspector', 'keyboard', 'drag', 'menu'] as const) {
    fsm.launch(); fsm.setHold(owner, true); fsm.greetComplete(); time.advance(60_000);
    assert.equal(fsm.state, 'coucou', `${owner} protects completion even when acquired before the timer`);
    fsm.setHold(owner, false); time.advance(599); assert.equal(fsm.state, 'coucou');
    time.advance(1); assert.equal(fsm.state, 'petit');
    fsm.setHold(owner, true); fsm.mouseLeft(); time.advance(60_000);
    assert.equal(fsm.state, 'petit', `${owner} protects compact hide and pointer leave`);
    fsm.setHold(owner, false); time.advance(59_999); assert.equal(fsm.state, 'petit');
    time.advance(1); assert.equal(fsm.state, 'hidden');
  }
});
