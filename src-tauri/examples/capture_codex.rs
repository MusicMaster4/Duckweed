use std::fs::File;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};

fn main() {
    let executable = std::env::args()
        .nth(1)
        .expect("usage: capture_codex <codex.exe> <capture-prefix>");
    let prefix = std::env::args()
        .nth(2)
        .unwrap_or_else(|| "target/codex-capture".to_string());

    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 41,
            cols: 76,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();

    let mut command = CommandBuilder::new(executable);
    command.arg("--no-alt-screen");
    command.arg("--cd");
    command.arg(std::env::current_dir().unwrap());
    command.arg("Reply with exactly OK, then wait for the next instruction.");
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "Duckweed");
    command.env("TERM_PROGRAM_VERSION", "0.1.0");

    let mut child = pair.slave.spawn_command(command).unwrap();
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().unwrap();
    let writer = Arc::new(Mutex::new(pair.master.take_writer().unwrap()));
    let reply_writer = writer.clone();
    let (sender, receiver) = std::sync::mpsc::channel::<(u128, Vec<u8>)>();
    let start = Instant::now();

    std::thread::spawn(move || {
        let mut buffer = vec![0u8; 16 * 1024];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    let bytes = buffer[..count].to_vec();
                    if bytes.windows(4).any(|window| window == b"\x1b[6n") {
                        let mut output = reply_writer.lock().unwrap();
                        let _ = output.write_all(b"\x1b[1;1R");
                        let _ = output.flush();
                    }
                    if bytes
                        .windows(9)
                        .any(|window| window == b"\x1b[?2026$p")
                    {
                        let mut output = reply_writer.lock().unwrap();
                        let _ = output.write_all(b"\x1b[?2026;2$y");
                        let _ = output.flush();
                    }
                    if sender.send((start.elapsed().as_micros(), bytes)).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let deadline = Instant::now() + Duration::from_secs(12);
    let mut raw = File::create(format!("{prefix}.bin")).unwrap();
    let mut events = File::create(format!("{prefix}.events")).unwrap();

    while Instant::now() < deadline {
        match receiver.recv_timeout(Duration::from_millis(100)) {
            Ok((micros, bytes)) => {
                raw.write_all(&bytes).unwrap();
                writeln!(events, "{micros}\t{}", bytes.len()).unwrap();
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    {
        let mut output = writer.lock().unwrap();
        let _ = output.write_all(b"\x03\x03");
        let _ = output.flush();
    }
    std::thread::sleep(Duration::from_millis(300));
    let _ = child.kill();
    let _ = child.wait();
}
