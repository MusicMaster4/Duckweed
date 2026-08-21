//! Full-screen red-only color filter for Power Watch.
//!
//! Windows' Magnification API can apply a 5x5 color matrix to the complete
//! desktop without capturing the screen or placing an overlay above it. We
//! keep the color effect that was active before Duckweed touched it and put it
//! back when Power Watch is disarmed or the app exits.

#[cfg(windows)]
mod platform {
    use std::sync::Mutex;

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

    static PREVIOUS_EFFECT: Mutex<Option<MagColorEffect>> = Mutex::new(None);

    #[link(name = "Magnification")]
    extern "system" {
        fn MagInitialize() -> i32;
        fn MagUninitialize() -> i32;
        fn MagGetFullscreenColorEffect(effect: *mut MagColorEffect) -> i32;
        fn MagSetFullscreenColorEffect(effect: *const MagColorEffect) -> i32;
    }

    pub fn set_enabled(enabled: bool) -> Result<(), String> {
        let mut previous = PREVIOUS_EFFECT
            .lock()
            .map_err(|_| "the Redshift state lock was poisoned".to_string())?;

        if enabled {
            if previous.is_some() {
                return Ok(());
            }

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

            *previous = Some(original);
            return Ok(());
        }

        let Some(original) = previous.take() else {
            return Ok(());
        };

        let restored = unsafe { MagSetFullscreenColorEffect(&original) } != 0;
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
