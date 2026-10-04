//! coucou-hook — the relay Claude Code runs on every hook event.
//!
//! Reads the hook JSON on stdin, adds a little terminal context, and hands it to
//! Coucou over the named pipe `\\.\pipe\coucou-<sid>` (Windows) or the Unix
//! socket `$XDG_RUNTIME_DIR/coucou.sock` (Linux).
//!
//! Hard rule (docs/CLAUDE.md): **never block Claude Code.**
//! * If the pipe does not exist — Coucou is closed — we exit 0 immediately with
//!   nothing on stdout, and the session carries on untouched.
//! * Every step runs under a deadline enforced by the main thread, so a pipe that
//!   accepts the connection and then stops reading cannot wedge the session
//!   either: we abandon the worker and exit.
//! * Only `PermissionRequest` waits for an answer, because approving from the
//!   island is the whole point. No answer means empty stdout, and Claude Code
//!   asks in the terminal exactly as if Coucou were not installed.
//!
//! Usage: `coucou-hook <EventName>` (the name is also read from the JSON).

use std::io::{Read, Write};
use std::sync::mpsc;
use std::time::Duration;

/// Budget for getting a pipe connection. Beyond this Claude Code wins, always.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(300);
/// Whole-run budget for an event nobody waits on: connect and write, no more.
const FIRE_AND_FORGET_BUDGET: Duration = Duration::from_secs(2);
/// How long a permission prompt may stay on screen before the terminal takes over.
const DECISION_BUDGET: Duration = Duration::from_secs(110);

/// Fields that are pointless to forward and can be enormous (a whole file read,
/// a full command output). The island never shows them.
const DROPPED_FIELDS: &[&str] = &["tool_response", "transcript_path"];
/// Longest string forwarded for any single field; the island truncates to far
/// less than this anyway.
const MAX_FIELD_LEN: usize = 2_000;

#[cfg(windows)]
mod win;
#[cfg(windows)]
use win::connect;

#[cfg(target_os = "linux")]
mod unix;
#[cfg(target_os = "linux")]
use unix::connect;

fn main() {
    let Some((payload, waits_for_answer)) = read_event() else { std::process::exit(0) };

    let budget = if waits_for_answer { DECISION_BUDGET } else { FIRE_AND_FORGET_BUDGET };

    // The worker owns every blocking call. If it overruns the budget we simply
    // stop listening and exit: the process dying takes the pipe handle with it.
    // (No catch_unwind here — the release profile is panic = "abort", so it would
    // be dead code. `talk` is written to have nothing to panic on instead.)
    let (tx, rx) = mpsc::channel::<Option<String>>();
    std::thread::spawn(move || {
        let _ = tx.send(talk(&payload, waits_for_answer));
    });

    if let Ok(Some(decision)) = rx.recv_timeout(budget) {
        if let Some(json) = decision_json(&decision) {
            let mut out = std::io::stdout();
            let _ = writeln!(out, "{json}");
            let _ = out.flush();
        }
    }
    // Nothing printed: Claude Code asks in the terminal, as if we were not here.
    std::process::exit(0);
}

/// The documented PermissionRequest output. Anything we do not recognise prints
/// nothing at all rather than guessing — silence is the safe answer.
/// See https://code.claude.com/docs/en/hooks
fn decision_json(decision: &str) -> Option<String> {
    let behavior = match decision.trim() {
        // "always" still answers a plain allow; remembering it is the island's
        // business, not Claude Code's.
        "allow" | "always" => r#"{"behavior":"allow"}"#.to_string(),
        "deny" => r#"{"behavior":"deny","message":"Denied from Coucou"}"#.to_string(),
        _ => return None,
    };
    Some(format!(
        r#"{{"hookSpecificOutput":{{"hookEventName":"PermissionRequest","decision":{behavior}}}}}"#
    ))
}

/// Reads stdin and returns the payload plus whether a legacy decision is needed.
fn read_event() -> Option<(String, bool)> {
    let mut raw = Vec::new();
    if std::io::stdin().read_to_end(&mut raw).is_err() || raw.is_empty() {
        return None;
    }
    // Parse argv: "coucou-hook.exe [--agent <name>] [<EventName>]"
    // --agent tags the payload with coucou_agent so the app routes to the right pill.
    // Absent or invalid names are validated and discarded by the app, not here.
    let mut agent = String::new();
    let mut arg_event = String::new();
    {
        let mut it = std::env::args().skip(1);
        while let Some(arg) = it.next() {
            if arg == "--agent" {
                agent = it.next().unwrap_or_default();
            } else if arg_event.is_empty() {
                arg_event = arg;
            }
        }
    }
    prepare_event(&raw, &agent, arg_event)
}

fn prepare_event(raw: &[u8], agent: &str, arg_event: String) -> Option<(String, bool)> {
    // Count the original input before parsing/filtering, excluding only its LF.
    let raw_len = raw.strip_suffix(b"\n").unwrap_or(raw).len();
    // Some shells hand us a UTF-8 BOM; serde_json would choke on it.
    let raw = raw.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(raw);
    let mut payload = serde_json::from_slice::<serde_json::Value>(raw).ok()?;
    let map = payload.as_object_mut()?;
    // Which agent this hook was installed for. Absent means Claude Code,
    // so existing hook commands keep working unchanged.
    if !agent.is_empty()
        && !matches!(map.get("coucou_agent").and_then(|v| v.as_str()), Some("opencode" | "hermes"))
    {
        map.insert("coucou_agent".into(), serde_json::Value::String(agent.into()));
    }
    let event = map
        .get("hook_event_name")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .filter(|s| !s.is_empty())
        .unwrap_or(arg_event);
    map.insert("hook_event_name".into(), serde_json::Value::String(event.clone()));

    if is_private_event(&payload) {
        // Even malformed passive observations must never reach approval waiting.
        if event == "PermissionRequest" || raw_len > 65_536 { return None; }
        retain_private_fields(&mut payload, "envelope");
        // Never turn a malformed private packet into a loggable legacy one.
        if !is_private_event(&payload) { return None; }
        let mut line = payload.to_string();
        if line.len() > 65_536 { return None; }
        line.push('\n');
        return Some((line, false));
    }

    let map = payload.as_object_mut()?;
    for field in DROPPED_FIELDS {
        map.remove(*field);
    }

    let cwd_missing = map
        .get("cwd")
        .and_then(|v| v.as_str())
        .map(str::is_empty)
        .unwrap_or(true);
    if cwd_missing {
        if let Ok(cwd) = std::env::current_dir() {
            map.insert(
                "cwd".into(),
                serde_json::Value::String(cwd.to_string_lossy().to_string()),
            );
        }
    }

    // Which terminal the session runs in. Unlike macOS, Coucou here accepts
    // events from every terminal, so this is context only — never a filter.
    for (key, var) in [
        ("term_program", "TERM_PROGRAM"),
        ("wt_session", "WT_SESSION"),
        ("term_session_id", "TERM_SESSION_ID"),
        ("vscode_pid", "VSCODE_PID"),
        ("session_pid", "CLAUDE_CODE_SSE_PORT"),
    ] {
        if !map.contains_key(key) {
            let value = std::env::var(var).unwrap_or_default();
            map.insert(key.into(), serde_json::Value::String(value));
        }
    }

    truncate_strings(&mut payload);

    let mut line = payload.to_string();
    line.push('\n');
    Some((line, event == "PermissionRequest"))
}

fn is_private_event(payload: &serde_json::Value) -> bool {
    matches!(payload.get("coucou_agent").and_then(|v| v.as_str()), Some("opencode" | "hermes"))
        || matches!(payload.get("hook_event_name").and_then(|v| v.as_str()), Some("AgentDisplayUpdate" | "AgentDisplayAlive"))
        || payload.get("coucou_monitor").is_some()
}

// Transport allowlist only; receivers must still validate bounds, enums and safe previews.
fn retain_private_fields(value: &mut serde_json::Value, group: &str) {
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
    let outcome_valid = matches!((value.get("status").and_then(|v| v.as_str()), value.get("outcome").and_then(|v| v.as_str())),
        (Some("finished"), Some("completed")) | (Some("failed"), Some("failed" | "incomplete"))
        | (Some("interrupted"), Some("interrupted")));
    let tool_event = matches!(value.get("hook_event_name").and_then(|v| v.as_str()),
        Some("PreToolUse" | "PostToolUse" | "PostToolUseFailure"));
    let Some(map) = value.as_object_mut() else { return };
    map.retain(|key, item| {
        if !fields.split_whitespace().any(|field| field == key.as_str()) { return false; }
        match (group, key.as_str()) {
            ("envelope", "tool_name") => return tool_event && item.as_str().map(|label|
                !label.is_empty() && label.len() <= 256 && label.chars().all(private_tool_label_char)).unwrap_or(false),
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
            rows.retain(serde_json::Value::is_object);
            for row in rows { retain_private_fields(row, key); }
        } else if group == "coucou_monitor" && matches!(key.as_str(), "truncated_fields" | "active_session_ids") {
            return item.as_array().map(|items| items.iter().all(serde_json::Value::is_string)).unwrap_or(false);
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

/// Caps every string in the payload. A single Write can carry a whole file.
fn truncate_strings(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(s) => {
            if s.len() > MAX_FIELD_LEN {
                // Cut on a char boundary; a lone byte index can split UTF-8.
                let mut end = MAX_FIELD_LEN;
                while end > 0 && !s.is_char_boundary(end) {
                    end -= 1;
                }
                s.truncate(end);
                s.push('…');
            }
        }
        serde_json::Value::Array(items) => items.iter_mut().for_each(truncate_strings),
        serde_json::Value::Object(map) => map.values_mut().for_each(truncate_strings),
        _ => {}
    }
}

/// Connect, send, and — for a permission request — wait for the island's word.
fn talk(payload: &str, waits_for_answer: bool) -> Option<String> {
    let mut pipe = connect()?;

    if pipe.write_all(payload.as_bytes()).is_err() {
        return None;
    }
    let _ = pipe.flush();

    if !waits_for_answer {
        return None;
    }

    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.contains(&b'\n') {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let answer = String::from_utf8_lossy(&buf).trim().to_string();
    (!answer.is_empty()).then_some(answer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decision_json_matches_the_documented_shape() {
        assert_eq!(
            decision_json("allow").unwrap(),
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#
        );
        assert_eq!(
            decision_json("deny").unwrap(),
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Coucou"}}}"#
        );
        // "always" is an island concept; Claude Code just gets an allow.
        assert!(decision_json("always").unwrap().contains(r#""behavior":"allow""#));
    }

    #[test]
    fn anything_unrecognised_prints_nothing() {
        assert!(decision_json("").is_none());
        assert!(decision_json("maybe").is_none());
        // The shape the app used to send must not be mistaken for a decision.
        assert!(decision_json(r#"{"permissionDecision":"allow"}"#).is_none());
    }

    #[test]
    fn long_strings_are_cut_on_a_char_boundary() {
        let mut v = serde_json::json!({ "tool_input": { "content": "é".repeat(4000) } });
        truncate_strings(&mut v);
        let s = v["tool_input"]["content"].as_str().unwrap();
        assert!(s.len() <= MAX_FIELD_LEN + 4);
        assert!(s.ends_with('…'));
    }

    #[test]
    fn private_envelopes_are_not_enriched_or_truncated() {
        for agent in ["opencode", "hermes"] {
            for cwd in [None, Some(""), Some("/fixture/日本語")] {
                let mut packet = serde_json::json!({
                    "coucou_agent": agent, "hook_event_name": "AgentDisplayUpdate",
                    "session_id": "session-é🦊",
                    "coucou_monitor": {"version": 1, "emitter_id": "emitter-é🦊",
                        "sequence": 7, "scope": "session", "status": "working",
                        "directory_known": cwd == Some("/fixture/日本語"),
                        "approvals": [{"id": "observation", "request_id": "nested-only", "state": "pending"}],
                        "usage": {"totals": {"scope": "session", "input": 96000, "cost_usd": 0.125}}}
                });
                if let Some(cwd) = cwd { packet["cwd"] = serde_json::json!(cwd); }
                let (line, waits) = prepare_event(packet.to_string().as_bytes(), "", "".into()).unwrap();
                assert!(!waits);
                assert!(line.ends_with('\n'));
                assert_eq!(serde_json::from_str::<serde_json::Value>(&line).unwrap(), packet);
            }
        }
        let mut packet = serde_json::json!({
            "coucou_agent": "opencode", "hook_event_name": "AgentDisplayUpdate",
            "session_id": "fixture-session",
            "coucou_monitor": {"version": 1, "emitter_id": "fixture", "sequence": 1,
                "scope": "session", "status": "working", "directory_known": false,
                "files": (0..20).map(|i| serde_json::json!({"id": format!("file-{i}"),
                    "path": "é".repeat(480), "cwd": "x".repeat(960), "action": "read", "state": "completed"})).collect::<Vec<_>>(),
                "tools": (0..8).map(|i| serde_json::json!({"id": format!("tool-{i}"),
                    "name": "read", "state": "completed", "command": "x".repeat(990),
                    "target": "🦊".repeat(240), "cwd": "x".repeat(960)})).collect::<Vec<_>>(),
                "approvals": [{"id": "observation", "state": "pending", "target": "x".repeat(600), "command": ""}]}
        });
        let padding = 65536 - packet.to_string().len();
        assert!(padding <= 1000);
        packet["coucou_monitor"]["approvals"][0]["command"] = serde_json::json!("x".repeat(padding));
        let raw = packet.to_string();
        let (line, waits) = prepare_event(raw.as_bytes(), "", "".into()).unwrap();
        assert!(!waits);
        assert_eq!(line.len(), 65537);
        assert_eq!(serde_json::from_str::<serde_json::Value>(&line).unwrap(), packet);
        assert!(prepare_event(format!("{raw}\n").as_bytes(), "", "".into()).is_some());
        assert!(prepare_event(format!("{raw} ").as_bytes(), "", "".into()).is_none());
        // Adding an agent through argv must not grow a legal input past the cap.
        packet.as_object_mut().unwrap().remove("coucou_agent");
        packet["coucou_monitor"]["approvals"][0]["command"] = serde_json::json!("x".repeat(padding + 26));
        assert_eq!(packet.to_string().len(), 65536);
        assert!(prepare_event(packet.to_string().as_bytes(), "opencode", "".into()).is_none());
    }

    #[test]
    fn private_canonical_tool_labels_survive_without_raw_content() {
        for agent in [Some("opencode"), Some("hermes"), None] {
            for event in ["PreToolUse", "PostToolUse", "PostToolUseFailure"] {
                for label in ["bash".into(), "mcp__server.tool:read-file".into(),
                    "日本語_é9.:-Ⅻ²".into(), "a".repeat(256), "é".repeat(128)] {
                    let mut expected = serde_json::json!({"hook_event_name": event,
                        "session_id": "session-é🦊", "cwd": "/fixture/日本語",
                        "tool_name": label, "coucou_monitor": {"tools": [{"id": "t", "name": "read"}]}});
                    if let Some(agent) = agent { expected["coucou_agent"] = serde_json::json!(agent); }
                    let mut packet = expected.clone();
                    for key in ["tool_input", "tool_output", "tool_response", "error", "body", "diff",
                        "prompt", "response", "credentials", "request_id", "coucou_kind"] {
                        packet[key] = serde_json::json!("PRIVATE_FIXTURE");
                    }
                    packet["coucou_monitor"]["tools"][0]["error"] = serde_json::json!("PRIVATE_FIXTURE");
                    let (line, waits) = prepare_event(packet.to_string().as_bytes(), "", "".into()).unwrap();
                    assert!(!waits);
                    assert_eq!(serde_json::from_str::<serde_json::Value>(&line).unwrap(), expected);
                }
            }
        }
    }

    #[test]
    fn private_tool_labels_reject_malformed_or_content_bearing_values() {
        for event in ["PreToolUse", "PostToolUse", "PostToolUseFailure"] {
            for label in [serde_json::Value::Null, serde_json::json!(false), serde_json::json!(7),
                serde_json::json!({}), serde_json::json!([]), serde_json::json!(""),
                serde_json::json!("a".repeat(257)), serde_json::json!("é".repeat(129)),
                serde_json::json!("bash --token=PRIVATE_FIXTURE"), serde_json::json!("--token=PRIVATE_FIXTURE"),
                serde_json::json!("read file"), serde_json::json!("read/file"), serde_json::json!("read\nfile"),
                serde_json::json!("read\tfile"), serde_json::json!("read\0file"), serde_json::json!("read\u{7f}"),
                serde_json::json!("read\u{85}"), serde_json::json!("🦊"), serde_json::json!("e\u{301}"),
                serde_json::json!("\u{345}"), serde_json::json!("Ⓐ")] {
                let expected = serde_json::json!({"coucou_agent": "hermes", "hook_event_name": event});
                let mut packet = expected.clone();
                packet["tool_name"] = label;
                let (line, waits) = prepare_event(packet.to_string().as_bytes(), "", "".into()).unwrap();
                assert!(!waits);
                assert_eq!(serde_json::from_str::<serde_json::Value>(&line).unwrap(), expected);
            }
        }
        for raw in [br#"{"coucou_agent":"hermes","hook_event_name":"PreToolUse","tool_name":"\ud800"}"#.as_slice(),
            br#"{"coucou_agent":"hermes","hook_event_name":"PreToolUse","tool_name":"\udfff"}"#.as_slice()] {
            assert!(prepare_event(raw, "", "".into()).is_none());
        }
        for event in [serde_json::json!("AgentDisplayUpdate"), serde_json::json!("AgentDisplayAlive"),
            serde_json::json!("SessionStart"), serde_json::json!("Stop"), serde_json::json!("BeforeTool"),
            serde_json::json!("PostToolUseOther"), serde_json::json!(""), serde_json::Value::Null,
            serde_json::json!({}), serde_json::json!([]), serde_json::json!(7)] {
            let packet = serde_json::json!({"coucou_agent": "opencode", "hook_event_name": event, "tool_name": "read"});
            let (line, waits) = prepare_event(packet.to_string().as_bytes(), "", "".into()).unwrap();
            assert!(!waits);
            assert!(serde_json::from_str::<serde_json::Value>(&line).unwrap().get("tool_name").is_none());
        }
    }

    #[test]
    fn private_payloads_drop_raw_fields_and_never_request_decisions() {
        let packet = serde_json::json!({
            "coucou_agent": "hermes", "hook_event_name": "AgentDisplayAlive",
            "prompt": "RAW", "body": "RAW", "diff": "RAW", "response": "RAW",
            "request_id": "RAW", "tool_input": {"content": "RAW"},
            "tool_response": "RAW", "transcript_path": "RAW", "term_program": "RAW",
            "coucou_monitor": {"version": 1, "emitter_id": "fixture", "active_session_ids": [],
                "body": "RAW"}
        });
        let (line, waits) = prepare_event(packet.to_string().as_bytes(), "", "".into()).unwrap();
        assert!(!waits);
        assert_eq!(serde_json::from_str::<serde_json::Value>(&line).unwrap(), serde_json::json!({
            "coucou_agent": "hermes", "hook_event_name": "AgentDisplayAlive",
            "coucou_monitor": {"version": 1, "emitter_id": "fixture", "active_session_ids": []}
        }));
        for agent in ["opencode", "hermes"] {
            assert!(prepare_event(serde_json::json!({"coucou_agent": agent,
                "hook_event_name": "PermissionRequest"}).to_string().as_bytes(), "", "".into()).is_none());
        }
        let (line, waits) = prepare_event(b"{}", "opencode", "AgentDisplayAlive".into()).unwrap();
        assert!(!waits);
        assert_eq!(serde_json::from_str::<serde_json::Value>(&line).unwrap(), serde_json::json!({
            "coucou_agent": "opencode", "hook_event_name": "AgentDisplayAlive"
        }));
        assert!(prepare_event(serde_json::json!({"coucou_monitor": "RAW",
            "hook_event_name": "private-event-text"}).to_string().as_bytes(), "", "".into()).is_none());
    }

    #[test]
    fn legacy_enrichment_truncation_and_permissions_remain() {
        for agent in ["", "codex"] {
            let (line, waits) = prepare_event(serde_json::json!({
                "hook_event_name": "PermissionRequest", "tool_response": "omitted",
                "transcript_path": "omitted", "tool_input": {"content": "é".repeat(4000)}
            }).to_string().as_bytes(), agent, "".into()).unwrap();
            assert!(waits);
            let packet: serde_json::Value = serde_json::from_str(&line).unwrap();
            assert_eq!(packet["cwd"], std::env::current_dir().unwrap().to_string_lossy().as_ref());
            assert!(packet.get("term_program").is_some());
            assert!(packet.get("tool_response").is_none());
            assert!(packet.get("transcript_path").is_none());
            assert!(packet["tool_input"]["content"].as_str().unwrap().ends_with('…'));
        }
    }

    #[test]
    fn private_raw_limit_applies_before_unknown_fields_are_removed() {
        let mut packet = serde_json::json!({"coucou_agent": "hermes", "hook_event_name": "AgentDisplayAlive", "body": ""});
        let padding = 65536 - packet.to_string().len();
        packet["body"] = serde_json::json!("x".repeat(padding));
        let raw = packet.to_string();
        assert!(prepare_event(raw.as_bytes(), "", "".into()).is_some());
        assert!(prepare_event(format!("{raw} ").as_bytes(), "", "".into()).is_none());
        assert!(prepare_event(b"{\"coucou_agent\":\"hermes\",\"body\":\"\xff\"}", "", "".into()).is_none());
    }

    #[test]
    fn former_previews_are_removed_and_enum_outcomes_survive() {
        let mut monitor = serde_json::json!({"status": "finished", "outcome": "completed",
            "title": "RAW", "final_summary": "RAW", "error": "RAW",
            "tools": [{"id": "t", "error": "RAW"}],
            "subagents": [{"id": "s", "role": "RAW", "summary": "RAW", "goal": "RAW"}],
            "activity": [{"id": "a", "kind": "RAW", "text": "RAW"}],
            "approvals": [{"id": "p", "reason": "RAW"}]});
        retain_private_fields(&mut monitor, "coucou_monitor");
        assert_eq!(monitor, serde_json::json!({"status": "finished", "outcome": "completed",
            "tools": [{"id": "t"}], "subagents": [{"id": "s"}],
            "activity": [{"id": "a"}], "approvals": [{"id": "p"}]}));
        monitor["status"] = serde_json::json!("working");
        retain_private_fields(&mut monitor, "coucou_monitor");
        assert!(monitor.get("outcome").is_none());
    }
}
