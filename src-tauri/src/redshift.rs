//! Full-screen red-only color filter for Power Watch.
//!
//! Windows' Magnification API can apply a 5x5 color matrix to the complete
//! desktop without capturing the screen or placing an overlay above it. We
//! keep the color effect that was active before Duckweed touched it and put it
//! back when Power Watch is disarmed or the app exits.

#[cfg(windows)]
mod platform {
    use std::ffi::c_void;
    use std::ptr;
    use std::sync::{mpsc, Mutex};
    use std::thread;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct MagColorEffect {
        transform: [[f32; 5]; 5],
    }

    // Convert each pixel's luminance into its red channel, then suppress green
    // and blue. This keeps text and shapes readable while every emitted pixel
    // uses red light only.
    const RED_ONLY: MagColorEffect = MagColorEffect {
        transform: [
            [0.2126, 0.0, 0.0, 0.0, 0.0],
            [0.7152, 0.0, 0.0, 0.0, 0.0],
            [0.0722, 0.0, 0.0, 0.0, 0.0],
            [0.0, 0.0, 0.0, 1.0, 0.0],
            [0.0, 0.0, 0.0, 0.0, 1.0],
        ],
    };

    struct ActiveEffect {
        previous: MagColorEffect,
        _ownership: OwnershipGuard,
    }

    /// A Windows mutex is owned by the thread that acquires it. Keep that
    /// thread alive for the whole effect so any Duckweed process can release
    /// Redshift safely, regardless of which Tauri worker handles the command.
    struct OwnershipGuard {
        release: Option<mpsc::SyncSender<()>>,
        worker: Option<thread::JoinHandle<()>>,
    }

    static ACTIVE_EFFECT: Mutex<Option<ActiveEffect>> = Mutex::new(None);

    const WAIT_OBJECT_0: u32 = 0;
    const WAIT_ABANDONED: u32 = 0x80;
    const WAIT_TIMEOUT: u32 = 0x102;
    const REDSHIFT_OWNER: &str = "Local\\Duckweed.PowerWatch.Redshift.v1";

    #[link(name = "Magnification")]
    extern "system" {
        fn MagInitialize() -> i32;
        fn MagUninitialize() -> i32;
        fn MagGetFullscreenColorEffect(effect: *mut MagColorEffect) -> i32;
        fn MagSetFullscreenColorEffect(effect: *const MagColorEffect) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateMutexW(
            mutex_attributes: *const c_void,
            initial_owner: i32,
            name: *const u16,
        ) -> *mut c_void;
        fn WaitForSingleObject(handle: *mut c_void, milliseconds: u32) -> u32;
        fn ReleaseMutex(handle: *mut c_void) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }

    impl OwnershipGuard {
        fn acquire() -> Result<Self, String> {
            Self::acquire_named(REDSHIFT_OWNER)
        }

        fn acquire_named(name: &str) -> Result<Self, String> {
            let (status_tx, status_rx) = mpsc::sync_channel(1);
            let (release_tx, release_rx) = mpsc::sync_channel(0);
            let name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
            let worker = thread::spawn(move || {
                let handle = unsafe { CreateMutexW(ptr::null(), 0, name.as_ptr()) };
                if handle.is_null() {
                    let _ = status_tx.send(Err(last_error(
                        "Windows could not create the Redshift ownership lock",
                    )));
                    return;
                }

                match unsafe { WaitForSingleObject(handle, 0) } {
                    WAIT_OBJECT_0 | WAIT_ABANDONED => {
                        let _ = status_tx.send(Ok(()));
                        let _ = release_rx.recv();
                        unsafe {
                            ReleaseMutex(handle);
                            CloseHandle(handle);
                        }
                    }
                    WAIT_TIMEOUT => {
                        let _ = status_tx.send(Err(
                            "Redshift is already active in another Duckweed window".into(),
                        ));
                        unsafe { CloseHandle(handle) };
                    }
                    _ => {
                        let _ = status_tx.send(Err(last_error(
                            "Windows could not acquire the Redshift ownership lock",
                        )));
                        unsafe { CloseHandle(handle) };
                    }
                }
            });

            match status_rx.recv() {
                Ok(Ok(())) => Ok(Self {
                    release: Some(release_tx),
                    worker: Some(worker),
                }),
                Ok(Err(error)) => {
                    let _ = worker.join();
                    Err(error)
                }
                Err(_) => {
                    let _ = worker.join();
                    Err("the Redshift ownership worker stopped unexpectedly".into())
                }
            }
        }

        fn finish(&mut self) {
            if let Some(release) = self.release.take() {
                let _ = release.send(());
            }
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
        }
    }

    impl Drop for OwnershipGuard {
        fn drop(&mut self) {
            self.finish();
        }
    }

    pub fn set_enabled(enabled: bool) -> Result<(), String> {
        let mut active = ACTIVE_EFFECT
            .lock()
            .map_err(|_| "the Redshift state lock was poisoned".to_string())?;

        if enabled {
            if active.is_some() {
                return Ok(());
            }

            // Only one process may snapshot and restore the desktop effect.
            // The named mutex becomes abandoned if its owner process crashes,
            // so a later Duckweed window can recover without a stale lock.
            let ownership = OwnershipGuard::acquire()?;

            if unsafe { MagInitialize() } == 0 {
                return Err(last_error(
                    "Windows could not initialize the screen color filter",
                ));
            }

            let mut original = RED_ONLY;
            if unsafe { MagGetFullscreenColorEffect(&mut original) } == 0 {
                let error = last_error("Windows could not read the current screen color filter");
                unsafe { MagUninitialize() };
                return Err(error);
            }

            if unsafe { MagSetFullscreenColorEffect(&RED_ONLY) } == 0 {
                let error = last_error("Windows refused the Redshift screen color filter");
                unsafe { MagUninitialize() };
                return Err(error);
            }

            *active = Some(ActiveEffect {
                previous: original,
                _ownership: ownership,
            });
            return Ok(());
        }

        let Some(active_effect) = active.take() else {
            return Ok(());
        };

        let restored = unsafe { MagSetFullscreenColorEffect(&active_effect.previous) } != 0;
        let restore_error =
            (!restored).then(|| last_error("Windows could not restore the previous screen colors"));
        let uninitialized = unsafe { MagUninitialize() } != 0;

        if let Some(error) = restore_error {
            return Err(error);
        }
        if !uninitialized {
            return Err(last_error(
                "Windows could not release the screen color filter",
            ));
        }
        Ok(())
    }

    fn last_error(context: &str) -> String {
        format!("{context}: {}", std::io::Error::last_os_error())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn only_one_process_owner_can_hold_redshift() {
            let name = format!(
                "Local\\Duckweed.PowerWatch.Redshift.Test.{}",
                std::process::id()
            );
            let first = OwnershipGuard::acquire_named(&name).expect("first owner");
            let error = OwnershipGuard::acquire_named(&name)
                .err()
                .expect("second owner must be rejected");
            assert!(error.contains("already active"));

            drop(first);
            let recovered = OwnershipGuard::acquire_named(&name).expect("released owner");
            drop(recovered);
        }
    }
}

#[cfg(windows)]
pub use platform::set_enabled;

#[cfg(not(windows))]
pub fn set_enabled(enabled: bool) -> Result<(), String> {
    if enabled {
        Err("Redshift is currently available on Windows only".into())
    } else {
        Ok(())
    }
}
