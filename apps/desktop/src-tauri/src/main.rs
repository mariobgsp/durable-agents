// Shell desktop Durable Agents: jalankan server Node, tunggu siap, buka jendela.
// BELUM DIKOMPILASI di mesin ini (Rust belum terpasang) — lihat README.md.
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

struct ServerProcess(Mutex<Option<Child>>);

/// Akar repo: dua tingkat di atas src-tauri (apps/desktop/src-tauri → repo).
fn repo_root() -> PathBuf {
    let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    here.parent()
        .and_then(|path| path.parent())
        .and_then(|path| path.parent())
        .map(PathBuf::from)
        .unwrap_or(here)
}

/// Data aplikasi: $XDG_DATA_HOME/durable-agents (bukan folder repo) saat dibundel.
fn data_dir() -> PathBuf {
    let base = std::env::var("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
            PathBuf::from(home).join(".local/share")
        });
    base.join("durable-agents")
}

fn spawn_server(port: u16) -> std::io::Result<Child> {
    let root = repo_root();
    let mut child = Command::new("node")
        .arg("packages/server/src/index.ts")
        .current_dir(&root)
        .env("PI_SERVER_PORT", port.to_string())
        .env("PI_DATA_DIR", data_dir())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    // Tunggu baris handshake; kalau tidak muncul dalam 20 detik, tetap lanjut (UI akan menampilkan error).
    if let Some(stdout) = child.stdout.take() {
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        while Instant::now() < deadline {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    println!("[server] {}", line.trim_end());
                    if line.contains("PI_SERVER_READY") {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    }
    Ok(child)
}

fn main() {
    let port: u16 = std::env::var("PI_SERVER_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(8787);

    let app = tauri::Builder::default()
        .setup(move |app| {
            let child = spawn_server(port)?;
            app.manage(ServerProcess(Mutex::new(Some(child))));

            let url = format!("http://127.0.0.1:{}", port);
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse().unwrap()))
                .title("Durable Agents")
                .inner_size(1280.0, 800.0)
                .min_inner_size(900.0, 600.0)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("gagal membangun aplikasi");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<ServerProcess>() {
                if let Ok(mut guard) = state.0.lock() {
                    if let Some(mut child) = guard.take() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                }
            }
        }
    });
}
