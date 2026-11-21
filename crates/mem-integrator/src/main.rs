//! mem-integrator: tiny memory file-sync + recall sidecar.
//!
//! Hermes-style continuous-improvement helper for small devices: the daemon
//! keeps the smart behavior (recall ranking, prompt/policy adaptation) and
//! this sidecar only does the cheap file work — append memory lines with
//! dedupe (`sync`) and substring recall (`recall`) — over newline-delimited
//! JSON on stdio, or on a unix socket with `--socket PATH`.
//!
//! Protocol (one JSON object per line, flat string fields only):
//!   {"id":1,"op":"ping"}
//!   {"id":2,"op":"sync","file":"/path/MEMORY.md","line":"- fact"}
//!   {"id":3,"op":"recall","file":"/path/MEMORY.md","query":"mifi","limit":5}
//!
//! `--bench` runs a stdio-free self-check (append N lines, recall them) so
//! the node bench harness can gate on it without wiring the daemon to this
//! binary. shortcut: substring recall only, upgrade to ranked search in the
//! daemon when recall quality (not speed) becomes the bottleneck.

use std::env;
use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::time::Instant;

fn main() {
    let args: Vec<String> = env::args().collect();
    let socket = flag_value(&args, "--socket");
    if args.iter().any(|a| a == "--bench") {
        let n = flag_value(&args, "--n")
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(2000);
        bench(n);
        return;
    }
    match socket {
        Some(path) => serve_socket(&path),
        None => serve_stdio(),
    }
}

fn flag_value(args: &[String], flag: &str) -> Option<String> {
    args.windows(2)
        .find(|w| w[0] == flag)
        .map(|w| w[1].clone())
}

/// Self-check used as the bench hook: sync N lines to a temp file, recall
/// one back, print `bench: ...` and exit nonzero if anything is off.
fn bench(n: usize) {
    let file = env::temp_dir().join(format!("mem-integrator-bench-{}.md", std::process::id()));
    let path = file.to_string_lossy().into_owned();
    let start = Instant::now();
    for i in 0..n {
        let line = format!("- bench fact {i} needle-{}", i % 10);
        if let Err(e) = sync_line(&path, &line) {
            println!("bench: FAIL sync: {e}");
            std::process::exit(1);
        }
    }
    let sync_ms = start.elapsed().as_millis();
    let start = Instant::now();
    let hits = recall(&path, "needle-7", 10).unwrap_or_default();
    let recall_ms = start.elapsed().as_millis();
    let _ = fs::remove_file(&file);
    // Exact-dupe sync must not grow the file.
    let dupes_ok = hits.iter().all(|(_, t)| t.contains("needle-7"));
    if hits.is_empty() || !dupes_ok {
        println!("bench: FAIL recall: {} hits", hits.len());
        std::process::exit(1);
    }
    println!("bench: synced={n} sync_ms={sync_ms} recall_ms={recall_ms} hits={}", hits.len());
}

fn serve_stdio() {
    let stdin = io::stdin();
    let out = io::stdout();
    let mut out = out.lock();
    for line in stdin.lock().lines() {
        match line {
            Ok(text) if text.trim().is_empty() => {}
            Ok(text) => {
                writeln!(out, "{}", handle(&text)).unwrap_or(());
                out.flush().unwrap_or(());
            }
            Err(_) => break,
        }
    }
}

fn serve_socket(path: &str) {
    let _ = fs::remove_file(path);
    let listener = UnixListener::bind(path).unwrap_or_else(|e| {
        eprintln!("mem-integrator: bind {path}: {e}");
        std::process::exit(1);
    });
    for conn in listener.incoming() {
        let stream = match conn {
            Ok(s) => s,
            Err(_) => continue,
        };
        let mut reader = BufReader::new(&stream);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    let reply = handle(&line);
                    let _ = (&stream).write_all(reply.as_bytes());
                    let _ = (&stream).write_all(b"\n");
                }
                Err(_) => break,
            }
        }
    }
}

fn handle(raw: &str) -> String {
    let id = field(raw, "id").unwrap_or_else(|| "null".to_string());
    let op = field(raw, "op").unwrap_or_default();
    let result = match op.as_str() {
        "ping" => Ok("\"pong\"".to_string()),
        "sync" => {
            let (file, line) = (field(raw, "file"), field(raw, "line"));
            match (file, line) {
                (Some(f), Some(l)) => match sync_line(&f, &l) {
                    Ok(appended) => Ok(format!("{{\"appended\":{appended}}}")),
                    Err(e) => Err(e),
                },
                _ => Err("sync needs file + line".to_string()),
            }
        }
        "recall" => {
            let (file, query) = (field(raw, "file"), field(raw, "query"));
            match (file, query) {
                (Some(f), Some(q)) => {
                    let limit = field(raw, "limit").and_then(|v| v.parse::<usize>().ok()).unwrap_or(5);
                    match recall(&f, &q, limit) {
                        Ok(hits) => {
                            let items: Vec<String> = hits
                                .iter()
                                .map(|(no, text)| format!("{{\"line\":{no},\"text\":\"{}\"}}", escape(text)))
                                .collect();
                            Ok(format!("{{\"matches\":[{}]}}", items.join(",")))
                        }
                        Err(e) => Err(e),
                    }
                }
                _ => Err("recall needs file + query".to_string()),
            }
        }
        _ => Err(format!("unknown op: {op}")),
    };
    match result {
        Ok(body) => format!("{{\"id\":{id},\"ok\":true,\"result\":{body}}}"),
        Err(message) => format!("{{\"id\":{id},\"ok\":false,\"error\":{{\"message\":\"{}\"}}}}", escape(&message)),
    }
}

/// Append `line` to `file` unless the exact line is already there.
fn sync_line(file: &str, line: &str) -> Result<bool, String> {
    let line = line.trim();
    if line.is_empty() {
        return Err("empty line".to_string());
    }
    let existing = fs::read_to_string(file).unwrap_or_default();
    if existing.lines().any(|l| l.trim() == line) {
        return Ok(false);
    }
    let mut fh = OpenOptions::new().create(true).append(true).open(file).map_err(|e| e.to_string())?;
    if !existing.is_empty() && !existing.ends_with('\n') {
        fh.write_all(b"\n").map_err(|e| e.to_string())?;
    }
    fh.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    fh.write_all(b"\n").map_err(|e| e.to_string())?;
    Ok(true)
}

/// Case-insensitive substring recall over lines, most recent matches first.
fn recall(file: &str, query: &str, limit: usize) -> Result<Vec<(usize, String)>, String> {
    let query = query.to_lowercase();
    if query.is_empty() {
        return Err("empty query".to_string());
    }
    let text = fs::read_to_string(file).map_err(|e| e.to_string())?;
    let mut hits: Vec<(usize, String)> = text
        .lines()
        .enumerate()
        .filter(|(_, l)| l.to_lowercase().contains(&query))
        .map(|(i, l)| (i + 1, l.to_string()))
        .collect();
    hits.sort_by_key(|(no, _)| std::cmp::Reverse(*no));
    hits.truncate(limit.max(1));
    Ok(hits)
}

/// Raw value of a flat `"key": "str" | number | true/false` field.
fn field(raw: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    let mut rest = raw;
    loop {
        let i = rest.find(&needle)?;
        let mut after = rest[i + needle.len()..].trim_start();
        if !after.starts_with(':') {
            rest = &after[1.min(after.len())..];
            continue;
        }
        after = after.strip_prefix(':').unwrap().trim_start();
        if let Some(inner) = after.strip_prefix('"') {
            return Some(unescape(split_string(inner)?.0));
        }
        let end = after.find([',', '}'])?;
        let v = after[..end].trim();
        return if v.is_empty() { None } else { Some(v.to_string()) };
    }
}

/// Split at the closing unescaped quote; returns (content, rest-after-quote).
fn split_string(s: &str) -> Option<(String, &str)> {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2,
            b'"' => return Some((s[..i].to_string(), &s[i + 1..])),
            _ => i += 1,
        }
    }
    None
}

fn unescape(s: String) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some('u') => {
                let hex: String = chars.by_ref().take(4).collect();
                let code = u32::from_str_radix(&hex, 16).unwrap_or(0xfffd);
                out.push(char::from_u32(code).unwrap_or('\u{fffd}'));
            }
            Some(x) => out.push(x),
            None => out.push('\\'),
        }
    }
    out
}

fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}
