// Relay server for coucou-hook.
//
// Windows: the named pipe `\\.\pipe\coucou-<sid>`, one instance per connection.
// Linux: the Unix socket `$XDG_RUNTIME_DIR/coucou.sock`. Every hook event is
// forwarded to the island as a `hook` event. `PermissionRequest` is the only one
// that keeps its connection open: it waits for the island's decision and writes
// it back on the same connection, which is how approving from the island works.
//
// Claude Code is never blocked by us. Three things guarantee it:
//   * coucou-hook gives the connection 300 ms and exits cleanly if we are closed;
//   * we only wait for a human once the island has *confirmed* the card is on
//     screen, so a paused island or a webview that is not listening costs a few
//     hundred milliseconds, not two minutes;
//   * whatever happens we drop the connection after the decision timeout, and
//     the terminal takes over.
//
// What we write back is the bare word `allow` or `deny`. Turning that into the
// documented hookSpecificOutput JSON is coucou-hook's job, so the wire format
// Claude Code expects lives in exactly one place.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
#[cfg(windows)]
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use tokio::sync::mpsc;

use crate::island::WINDOW_LABEL;
use crate::log;

/// Slightly under coucou-hook's own 110 s wait, so we always answer first.
const DECISION_TIMEOUT: Duration = Duration::from_secs(108);
/// How long the island gets to say "the card is up". This is the whole of B4:
/// without it, an island that is paused, hidden behind a crashed webview or
/// simply not listening would leave Claude Code staring at a prompt nobody can
/// see for nearly two minutes.
const ACK_TIMEOUT: Duration = Duration::from_millis(800);
const MAX_PAYLOAD: usize = 1 << 20;

/// What the island can say about a permission request.
pub enum Reply {
    /// The card is on screen and a human can act on it.
    Ack,
    /// A human clicked: `allow` or `deny`.
    Decision(String),
    /// Nobody can act on it — paused, or another request already holds the card.
    Decline,
}

/// Permission requests the island has been told about.
#[derive(Default)]
pub struct Pending(pub Mutex<HashMap<String, mpsc::Sender<Reply>>>);

static COUNTER: AtomicU64 = AtomicU64::new(1);

/// `\\.\pipe\coucou-<sid>` — must match coucou-hook's `pipe_path()` exactly.
#[cfg(windows)]
pub fn pipe_name() -> String {
    let key = crate::platform::current_user_sid()
        .unwrap_or_else(|| std::env::var("USERNAME").unwrap_or_else(|_| "user".into()));
    format!(r"\\.\pipe\coucou-{key}")
}

#[cfg(windows)]
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let name = pipe_name();
        // first_pipe_instance also means we refuse to join a pipe somebody else
        // already owns under our name, rather than serving on top of it.
        let mut server = match ServerOptions::new().first_pipe_instance(true).create(&name) {
            Ok(s) => s,
            Err(err) => {
                log::line(format!("cannot open the relay pipe: {err}"));
                return;
            }
        };
        loop {
            if server.connect().await.is_err() {
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            }
            // Hand the connected instance to a task and listen on a fresh one.
            let next = match ServerOptions::new().create(&name) {
                Ok(s) => s,
                Err(err) => {
                    log::line(format!("cannot reopen the relay pipe: {err}"));
                    return;
                }
            };
            let connected = std::mem::replace(&mut server, next);
            let app = app.clone();
            tauri::async_runtime::spawn(async move { handle(app, connected).await });
        }
    });
}

#[cfg(target_os = "linux")]
pub fn start(app: AppHandle) {
    use std::os::unix::fs::PermissionsExt;
    use tokio::net::UnixListener;

    tauri::async_runtime::spawn(async move {
        let Some(path) = crate::platform::relay_socket_path() else {
            log::line("no private runtime directory ($XDG_RUNTIME_DIR) — Claude Code hooks are inactive");
            return;
        };
        // A socket file left behind by a crash answers nothing and can go. One
        // that answers belongs to a Coucou that is still running: like
        // first_pipe_instance on Windows, we refuse to serve on top of it.
        if path.exists() {
            if std::os::unix::net::UnixStream::connect(&path).is_ok() {
                log::line("another Coucou already serves the relay socket");
                return;
            }
            let _ = std::fs::remove_file(&path);
        }
        let listener = match UnixListener::bind(&path) {
            Ok(l) => l,
            Err(err) => {
                log::line(format!("cannot open the relay socket: {err}"));
                return;
            }
        };
        // The runtime directory is already 0700; this is belt and braces.
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        let uid = unsafe { libc::getuid() };
        loop {
            let stream = match listener.accept().await {
                Ok((stream, _)) => stream,
                Err(_) => {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    continue;
                }
            };
            // Only the relay run by our own user may drive the island.
            if !matches!(stream.peer_cred(), Ok(c) if c.uid() == uid) {
                log::line("refused a relay connection from another user");
                continue;
            }
            let app = app.clone();
            tauri::async_runtime::spawn(async move { handle(app, stream).await });
        }
    });
}

/// One accepted relay connection, whatever carries it.
trait Relay: AsyncRead + AsyncWrite + Unpin {
    /// Ends the conversation once everything has been written.
    fn finish(&mut self) {}
}

#[cfg(windows)]
impl Relay for NamedPipeServer {
    fn finish(&mut self) {
        let _ = self.disconnect();
    }
}

/// Dropping the stream closes it; the relay reads up to our newline first.
#[cfg(target_os = "linux")]
impl Relay for tokio::net::UnixStream {}

async fn handle(app: AppHandle, mut pipe: impl Relay) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match pipe.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.contains(&b'\n') || buf.len() > MAX_PAYLOAD {
                    break;
                }
            }
            Err(_) => return,
        }
    }
    let line = match buf.iter().position(|b| *b == b'\n') {
        Some(i) => &buf[..i],
        None => &buf[..],
    };
    let Ok(mut payload) = serde_json::from_slice::<Value>(line) else { return };
    if !payload.is_object() {
        return;
    }

    let event = payload
        .get("hook_event_name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    // Classify before logging or creating request_id, including malformed monitors.
    if is_private_event(&payload) {
        if line.len() > 65_536 {
            pipe.finish();
            return;
        }
        if event != "PermissionRequest" {
            retain_private_fields(&mut payload, "envelope");
            if payload.to_string().len() <= 65_536 {
                let _ = app.emit_to(WINDOW_LABEL, "hook", payload);
            }
        }
        pipe.finish();
        return;
    }

    if event != "PermissionRequest" {
        log::line(format!("hook {}", safe_event_name(&event)));
        let _ = app.emit_to(WINDOW_LABEL, "hook", payload);
        pipe.finish();
        return;
    }

    let id = format!("{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed));
    let (tx, mut rx) = mpsc::channel::<Reply>(4);
    {
        let pending = app.state::<Pending>();
        pending.0.lock().unwrap().insert(id.clone(), tx);
    }
    payload["request_id"] = json!(id);
    log::line(format!("hook PermissionRequest id={id}"));
    let _ = app.emit_to(WINDOW_LABEL, "hook", payload);

    let decision = wait_for_decision(&id, &mut rx).await;
    app.state::<Pending>().0.lock().unwrap().remove(&id);

    // No decision: say nothing at all. coucou-hook then writes nothing to stdout
    // and Claude Code asks in the terminal, exactly as if Coucou were closed.
    if let Some(d) = decision {
        let _ = pipe.write_all(format!("{d}\n").as_bytes()).await;
        let _ = pipe.flush().await;
    }
    pipe.finish();
}

fn is_private_event(payload: &Value) -> bool {
    matches!(payload.get("coucou_agent").and_then(Value::as_str), Some("opencode" | "hermes"))
        || matches!(payload.get("hook_event_name").and_then(Value::as_str), Some("AgentDisplayUpdate" | "AgentDisplayAlive"))
        || payload.get("coucou_monitor").is_some()
}

/// `hook_event_name` is agent-authored. A packet can opt out of the private
/// filter by declaring another agent, so this value must never be logged or
/// rendered unbounded: it is the only agent-controlled text that persists.
fn safe_event_name(event: &str) -> &str {
    let plain = !event.is_empty()
        && event.len() <= 48
        && event.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_');
    if plain { event } else { "?" }
}

// Direct IPC clients need the same allowlist as coucou-hook. This is not full
// monitor validation: bounds, enums and preview scrubbing belong to the consumer.
fn retain_private_fields(value: &mut Value, group: &str) {
    let fields = match group {
        "envelope" => "hook_event_name coucou_agent session_id cwd tool_name coucou_monitor",
        "coucou_monitor" => "version emitter_id sequence scope status directory_known turn_id parent_session_id model provider capabilities files tools approvals subagents activity usage outcome overflow truncated_fields active_session_ids",
        "files" => "id tool_call_id path action state cwd",
        "tools" => "id name state command target cwd duration_ms",
        "approvals" => "id request_id tool_call_id state command target reason cwd",
        "subagents" => "id session_id state duration_ms",
        "activity" => "id kind attempt",
        "usage" => "context totals",
        "context" => "tokens limit quality accounting",
        "totals" => "scope partial input output reasoning cache_read cache_write cost_usd accounting",
        "capabilities" => "files context approvals subagents compaction",
        "overflow" => "files tools approvals subagents activity sessions observations",
        _ => "",
    };
    let outcome_valid = matches!((value.get("status").and_then(Value::as_str), value.get("outcome").and_then(Value::as_str)),
        (Some("finished"), Some("completed")) | (Some("failed"), Some("failed" | "incomplete"))
        | (Some("interrupted"), Some("interrupted")));
    let tool_event = matches!(value.get("hook_event_name").and_then(Value::as_str),
        Some("PreToolUse" | "PostToolUse" | "PostToolUseFailure"));
    let Some(map) = value.as_object_mut() else { return };
    map.retain(|key, item| {
        if !fields.split_whitespace().any(|field| field == key.as_str()) { return false; }
        match (group, key.as_str()) {
            ("envelope", "tool_name") => return tool_event && item.as_str().map(|label|
                !label.is_empty() && label.len() <= 256 && label.chars().all(private_tool_label_char)).unwrap_or(false),
            // Bounds the consumer already applies on Windows, but macOS has no
            // bounded consumer today, so the transport must reject outright.
            ("envelope", "session_id") => return item.as_str().is_some_and(|id| id.len() <= 256),
            ("envelope", "cwd") => return item.as_str().is_some_and(|cwd| cwd.len() <= 1024),
            ("approvals", "reason") => return matches!(item.as_str(), Some("permission_required" | "policy" | "unknown")),
            ("activity", "kind") => return matches!(item.as_str(), Some("retry" | "rate_limit" | "compaction" | "error" | "session_reset")),
            ("coucou_monitor", "outcome") => return outcome_valid,
            _ => {}
        }
        if matches!((group, key.as_str()), ("envelope", "coucou_monitor")
            | ("coucou_monitor", "usage" | "capabilities" | "overflow") | ("usage", "context" | "totals"))
        {
            if !item.is_object() { return false; }
            retain_private_fields(item, key);
        } else if group == "coucou_monitor" && matches!(key.as_str(), "files" | "tools" | "approvals" | "subagents" | "activity") {
            let Some(rows) = item.as_array_mut() else { return false };
            rows.retain(Value::is_object);
            for row in rows { retain_private_fields(row, key); }
        } else if group == "coucou_monitor" && matches!(key.as_str(), "truncated_fields" | "active_session_ids") {
            return item.as_array().map(|items| items.iter().all(Value::is_string)).unwrap_or(false);
        } else {
            return !item.is_object() && !item.is_array();
        }
        true
    });
}

fn private_tool_label_char(c: char) -> bool {
    // Rust Alphabetic includes marks/symbols: exclude Unicode 17 non-L/N ranges.
    // ponytail: stdlib-only Unicode 17 grammar; refresh ranges when its Unicode version changes.
    matches!(c, '_' | '.' | ':' | '-') || (c.is_alphanumeric() && !matches!(c as u32,
        0x345 | 0x363..=0x36f | 0x5b0..=0x5bd | 0x5bf | 0x5c1..=0x5c2 |
        0x5c4..=0x5c5 | 0x5c7 | 0x610..=0x61a | 0x64b..=0x657 | 0x659..=0x65f |
        0x670 | 0x6d6..=0x6dc | 0x6e1..=0x6e4 | 0x6e7..=0x6e8 | 0x6ed |
        0x711 | 0x730..=0x73f | 0x7a6..=0x7b0 | 0x816..=0x817 | 0x81b..=0x823 |
        0x825..=0x827 | 0x829..=0x82c | 0x897 | 0x8d4..=0x8df | 0x8e3..=0x8e9 |
        0x8f0..=0x903 | 0x93a..=0x93b | 0x93e..=0x94c | 0x94e..=0x94f | 0x955..=0x957 |
        0x962..=0x963 | 0x981..=0x983 | 0x9be..=0x9c4 | 0x9c7..=0x9c8 | 0x9cb..=0x9cc |
        0x9d7 | 0x9e2..=0x9e3 | 0xa01..=0xa03 | 0xa3e..=0xa42 | 0xa47..=0xa48 |
        0xa4b..=0xa4c | 0xa51 | 0xa70..=0xa71 | 0xa75 | 0xa81..=0xa83 |
        0xabe..=0xac5 | 0xac7..=0xac9 | 0xacb..=0xacc | 0xae2..=0xae3 | 0xafa..=0xafc |
        0xb01..=0xb03 | 0xb3e..=0xb44 | 0xb47..=0xb48 | 0xb4b..=0xb4c | 0xb56..=0xb57 |
        0xb62..=0xb63 | 0xb82 | 0xbbe..=0xbc2 | 0xbc6..=0xbc8 | 0xbca..=0xbcc |
        0xbd7 | 0xc00..=0xc04 | 0xc3e..=0xc44 | 0xc46..=0xc48 | 0xc4a..=0xc4c |
        0xc55..=0xc56 | 0xc62..=0xc63 | 0xc81..=0xc83 | 0xcbe..=0xcc4 | 0xcc6..=0xcc8 |
        0xcca..=0xccc | 0xcd5..=0xcd6 | 0xce2..=0xce3 | 0xcf3 | 0xd00..=0xd03 |
        0xd3e..=0xd44 | 0xd46..=0xd48 | 0xd4a..=0xd4c | 0xd57 | 0xd62..=0xd63 |
        0xd81..=0xd83 | 0xdcf..=0xdd4 | 0xdd6 | 0xdd8..=0xddf | 0xdf2..=0xdf3 |
        0xe31 | 0xe34..=0xe3a | 0xe4d | 0xeb1 | 0xeb4..=0xeb9 |
        0xebb..=0xebc | 0xecd | 0xf71..=0xf83 | 0xf8d..=0xf97 | 0xf99..=0xfbc |
        0x102b..=0x1036 | 0x1038 | 0x103b..=0x103e | 0x1056..=0x1059 | 0x105e..=0x1060 |
        0x1062..=0x1064 | 0x1067..=0x106d | 0x1071..=0x1074 | 0x1082..=0x108d | 0x108f |
        0x109a..=0x109d | 0x1712..=0x1713 | 0x1732..=0x1733 | 0x1752..=0x1753 | 0x1772..=0x1773 |
        0x17b6..=0x17c8 | 0x1885..=0x1886 | 0x18a9 | 0x1920..=0x192b | 0x1930..=0x1938 |
        0x1a17..=0x1a1b | 0x1a55..=0x1a5e | 0x1a61..=0x1a74 | 0x1abf..=0x1ac0 | 0x1acc..=0x1ace |
        0x1b00..=0x1b04 | 0x1b35..=0x1b43 | 0x1b80..=0x1b82 | 0x1ba1..=0x1ba9 | 0x1bac..=0x1bad |
        0x1be7..=0x1bf1 | 0x1c24..=0x1c36 | 0x1dd3..=0x1df4 | 0x24b6..=0x24e9 | 0x2de0..=0x2dff |
        0xa674..=0xa67b | 0xa69e..=0xa69f | 0xa802 | 0xa80b | 0xa823..=0xa827 |
        0xa880..=0xa881 | 0xa8b4..=0xa8c3 | 0xa8c5 | 0xa8ff | 0xa926..=0xa92a |
        0xa947..=0xa952 | 0xa980..=0xa983 | 0xa9b4..=0xa9bf | 0xa9e5 | 0xaa29..=0xaa36 |
        0xaa43 | 0xaa4c..=0xaa4d | 0xaa7b..=0xaa7d | 0xaab0 | 0xaab2..=0xaab4 |
        0xaab7..=0xaab8 | 0xaabe | 0xaaeb..=0xaaef | 0xaaf5 | 0xabe3..=0xabea |
        0xfb1e | 0x10376..=0x1037a | 0x10a01..=0x10a03 | 0x10a05..=0x10a06 | 0x10a0c..=0x10a0f |
        0x10d24..=0x10d27 | 0x10d69 | 0x10eab..=0x10eac | 0x10efa..=0x10efc | 0x11000..=0x11002 |
        0x11038..=0x11045 | 0x11073..=0x11074 | 0x11080..=0x11082 | 0x110b0..=0x110b8 | 0x110c2 |
        0x11100..=0x11102 | 0x11127..=0x11132 | 0x11145..=0x11146 | 0x11180..=0x11182 | 0x111b3..=0x111bf |
        0x111ce..=0x111cf | 0x1122c..=0x11234 | 0x11237 | 0x1123e | 0x11241 |
        0x112df..=0x112e8 | 0x11300..=0x11303 | 0x1133e..=0x11344 | 0x11347..=0x11348 | 0x1134b..=0x1134c |
        0x11357 | 0x11362..=0x11363 | 0x113b8..=0x113c0 | 0x113c2 | 0x113c5 |
        0x113c7..=0x113ca | 0x113cc..=0x113cd | 0x11435..=0x11441 | 0x11443..=0x11445 | 0x114b0..=0x114c1 |
        0x115af..=0x115b5 | 0x115b8..=0x115be | 0x115dc..=0x115dd | 0x11630..=0x1163e | 0x11640 |
        0x116ab..=0x116b5 | 0x1171d..=0x1172a | 0x1182c..=0x11838 | 0x11930..=0x11935 | 0x11937..=0x11938 |
        0x1193b..=0x1193c | 0x11940 | 0x11942 | 0x119d1..=0x119d7 | 0x119da..=0x119df |
        0x119e4 | 0x11a01..=0x11a0a | 0x11a35..=0x11a39 | 0x11a3b..=0x11a3e | 0x11a51..=0x11a5b |
        0x11a8a..=0x11a97 | 0x11b60..=0x11b67 | 0x11c2f..=0x11c36 | 0x11c38..=0x11c3e | 0x11c92..=0x11ca7 |
        0x11ca9..=0x11cb6 | 0x11d31..=0x11d36 | 0x11d3a | 0x11d3c..=0x11d3d | 0x11d3f..=0x11d41 |
        0x11d43 | 0x11d47 | 0x11d8a..=0x11d8e | 0x11d90..=0x11d91 | 0x11d93..=0x11d96 |
        0x11ef3..=0x11ef6 | 0x11f00..=0x11f01 | 0x11f03 | 0x11f34..=0x11f3a | 0x11f3e..=0x11f40 |
        0x1611e..=0x1612e | 0x16f4f | 0x16f51..=0x16f87 | 0x16f8f..=0x16f92 | 0x16ff0..=0x16ff1 |
        0x1bc9e | 0x1e000..=0x1e006 | 0x1e008..=0x1e018 | 0x1e01b..=0x1e021 | 0x1e023..=0x1e024 |
        0x1e026..=0x1e02a | 0x1e08f | 0x1e6e3 | 0x1e6e6 | 0x1e6ee..=0x1e6ef |
        0x1e6f5 | 0x1e947 | 0x1f130..=0x1f149 | 0x1f150..=0x1f169 | 0x1f170..=0x1f189
    ))
}

/// Two waits: a short one for "the card is up", then the long one for a human.
async fn wait_for_decision(id: &str, rx: &mut mpsc::Receiver<Reply>) -> Option<String> {
    match tokio::time::timeout(ACK_TIMEOUT, rx.recv()).await {
        Ok(Some(Reply::Ack)) => {}
        // A click that beats the ack is still a click.
        Ok(Some(Reply::Decision(d))) => {
            log::line(format!("hook id={id} answered {d}"));
            return Some(d);
        }
        Ok(Some(Reply::Decline)) => {
            log::line(format!("hook id={id} not shown — terminal takes over"));
            return None;
        }
        Ok(None) => return None,
        Err(_) => {
            log::line(format!("hook id={id} island never acknowledged — terminal takes over"));
            return None;
        }
    }

    match tokio::time::timeout(DECISION_TIMEOUT, rx.recv()).await {
        Ok(Some(Reply::Decision(d))) => {
            log::line(format!("hook id={id} answered {d}"));
            Some(d)
        }
        Ok(Some(Reply::Decline)) => {
            log::line(format!("hook id={id} released without a decision"));
            None
        }
        _ => {
            log::line(format!("hook id={id} timed out — terminal takes over"));
            None
        }
    }
}

fn send(app: &AppHandle, request_id: &str, reply: Reply, keep: bool) {
    let sender = {
        let pending = app.state::<Pending>();
        let mut map = pending.0.lock().unwrap();
        if keep { map.get(request_id).cloned() } else { map.remove(request_id) }
    };
    match sender {
        Some(tx) => {
            let _ = tx.try_send(reply);
        }
        None => log::line(format!("reply for id={request_id} — no pending request")),
    }
}

/// The island has the card on screen; the long wait may begin.
pub fn acknowledge(app: &AppHandle, request_id: &str) {
    send(app, request_id, Reply::Ack, true);
}

/// Nobody can act on this one — paused, or another card already holds the view.
pub fn decline(app: &AppHandle, request_id: &str) {
    log::line(format!("decline id={request_id}"));
    send(app, request_id, Reply::Decline, false);
}

/// Called by the island's Allow / Deny buttons. Only ever a bare word: turning
/// it into Claude Code's JSON is coucou-hook's job.
pub fn answer(app: &AppHandle, request_id: &str, decision: &str) {
    let word = match decision {
        "allow" | "always" => "allow",
        _ => "deny",
    };
    log::line(format!("decision id={request_id} {word}"));
    send(app, request_id, Reply::Decision(word.to_string()), false);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_private_routes_even_when_malformed_without_changing_legacy_routes() {
        for packet in [
            json!({"coucou_agent": "opencode", "hook_event_name": "PermissionRequest"}),
            json!({"coucou_agent": "hermes", "hook_event_name": "SessionStart", "coucou_monitor": null}),
            json!({"hook_event_name": "AgentDisplayUpdate", "coucou_agent": 42}),
            json!({"hook_event_name": "AgentDisplayAlive"}),
            json!({"coucou_monitor": "malformed", "hook_event_name": "private event text"}),
        ] {
            assert!(is_private_event(&packet));
        }
        for packet in [
            json!({"hook_event_name": "PermissionRequest"}),
            json!({"coucou_agent": "codex", "hook_event_name": "PermissionRequest"}),
            json!({"coucou_agent": "gemini", "hook_event_name": "SessionStart"}),
        ] {
            assert!(!is_private_event(&packet));
        }
    }

    #[test]
    fn private_canonical_tool_labels_survive_without_raw_content() {
        for agent in [Some("opencode"), Some("hermes"), None] {
            for event in ["PreToolUse", "PostToolUse", "PostToolUseFailure"] {
                for label in ["bash".into(), "mcp__server.tool:read-file".into(),
                    "日本語_é9.:-Ⅻ²".into(), "a".repeat(256), "é".repeat(128)] {
                    let mut expected = json!({"hook_event_name": event,
                        "session_id": "session-é🦊", "cwd": "/fixture/日本語",
                        "tool_name": label, "coucou_monitor": {"tools": [{"id": "t", "name": "read"}]}});
                    if let Some(agent) = agent { expected["coucou_agent"] = json!(agent); }
                    let mut packet = expected.clone();
                    for key in ["tool_input", "tool_output", "tool_response", "error", "body", "diff",
                        "prompt", "response", "credentials", "request_id", "coucou_kind"] {
                        packet[key] = json!("PRIVATE_FIXTURE");
                    }
                    packet["coucou_monitor"]["tools"][0]["error"] = json!("PRIVATE_FIXTURE");
                    assert!(is_private_event(&packet));
                    retain_private_fields(&mut packet, "envelope");
                    assert_eq!(packet, expected);
                }
            }
        }
    }

    #[test]
    fn private_tool_labels_reject_malformed_or_content_bearing_values() {
        for event in ["PreToolUse", "PostToolUse", "PostToolUseFailure"] {
            for label in [Value::Null, json!(false), json!(7), json!({}), json!([]), json!(""),
                json!("a".repeat(257)), json!("é".repeat(129)), json!("bash --token=PRIVATE_FIXTURE"),
                json!("--token=PRIVATE_FIXTURE"), json!("read file"), json!("read/file"), json!("read\nfile"),
                json!("read\tfile"), json!("read\0file"), json!("read\u{7f}"), json!("read\u{85}"),
                json!("🦊"), json!("e\u{301}"), json!("\u{345}"), json!("Ⓐ")] {
                let expected = json!({"coucou_agent": "hermes", "hook_event_name": event});
                let mut packet = expected.clone();
                packet["tool_name"] = label;
                retain_private_fields(&mut packet, "envelope");
                assert_eq!(packet, expected);
            }
        }
        for event in [json!("AgentDisplayUpdate"), json!("AgentDisplayAlive"), json!("SessionStart"),
            json!("Stop"), json!("BeforeTool"), json!("PostToolUseOther"), json!(""), Value::Null,
            json!({}), json!([]), json!(7)] {
            let mut packet = json!({"coucou_agent": "opencode", "hook_event_name": event, "tool_name": "read"});
            retain_private_fields(&mut packet, "envelope");
            assert!(packet.get("tool_name").is_none());
        }
    }

    #[test]
    fn direct_private_packets_keep_nested_identity_but_drop_raw_fields() {
        let mut packet = json!({
            "coucou_agent": "hermes", "hook_event_name": "AgentDisplayUpdate",
            "request_id": "no-decision", "prompt": "RAW", "response": "RAW",
            "coucou_monitor": {"version": 1, "emitter_id": "fixture-é", "sequence": 7,
                "scope": "agent", "status": "awaiting_approval", "directory_known": false,
                "approvals": [{"id": "observation", "request_id": "nested-only", "state": "pending",
                    "body": "RAW", "diff": "RAW"}]}
        });
        retain_private_fields(&mut packet, "envelope");
        assert_eq!(packet, json!({
            "coucou_agent": "hermes", "hook_event_name": "AgentDisplayUpdate",
            "coucou_monitor": {"version": 1, "emitter_id": "fixture-é", "sequence": 7,
                "scope": "agent", "status": "awaiting_approval", "directory_known": false,
                "approvals": [{"id": "observation", "request_id": "nested-only", "state": "pending"}]}
        }));
        assert!(is_private_event(&packet));
    }

    #[test]
    fn former_previews_and_non_enum_reason_kind_outcome_are_removed() {
        let mut monitor = json!({"status": "finished", "outcome": "completed",
            "title": "RAW", "final_summary": "RAW", "error": "RAW",
            "tools": [{"id": "t", "error": "RAW"}],
            "subagents": [{"id": "s", "role": "RAW", "summary": "RAW", "goal": "RAW"}],
            "activity": [{"id": "a", "kind": "message", "text": "RAW"}],
            "approvals": [{"id": "p", "reason": "RAW"}]});
        retain_private_fields(&mut monitor, "coucou_monitor");
        assert_eq!(monitor, json!({"status": "finished", "outcome": "completed",
            "tools": [{"id": "t"}], "subagents": [{"id": "s"}],
            "activity": [{"id": "a"}], "approvals": [{"id": "p"}]}));
        monitor["outcome"] = json!("RAW");
        retain_private_fields(&mut monitor, "coucou_monitor");
        assert!(monitor.get("outcome").is_none());
    }
}
