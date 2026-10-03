use serde::{Deserialize, Serialize};
use tauri::WebviewWindow;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlayingPayload {
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub artwork_url: Option<String>,
    pub playback_status: String,
    pub play_enabled: bool,
    pub pause_enabled: bool,
    pub next_enabled: bool,
    pub previous_enabled: bool,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelinePayload {
    pub position_seconds: f64,
    pub duration_seconds: f64,
}

/// SMTC ticks are 100 ns. Returns `None` for unusable input so a bad tick
/// never reaches the OS.
pub fn timeline_ticks(payload: TimelinePayload) -> Option<(i64, i64)> {
    let TimelinePayload {
        position_seconds,
        duration_seconds,
    } = payload;
    if !position_seconds.is_finite() || !duration_seconds.is_finite() || duration_seconds <= 0.0 {
        return None;
    }
    let to_ticks = |seconds: f64| (seconds * 10_000_000.0).round() as i64;
    let position = position_seconds.clamp(0.0, duration_seconds);
    Some((to_ticks(position), to_ticks(duration_seconds)))
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{NowPlayingPayload, TimelinePayload};
    use std::sync::{Mutex, OnceLock};
    use tauri::{Emitter, Manager, WebviewWindow};
    use windows::core::{Ref, HSTRING};
    use windows::Foundation::{TimeSpan, TypedEventHandler, Uri};
    use windows::Media::{
        MediaPlaybackStatus, MediaPlaybackType, SystemMediaTransportControls,
        SystemMediaTransportControlsButton, SystemMediaTransportControlsTimelineProperties,
    };
    use windows::Storage::Streams::RandomAccessStreamReference;
    use windows::Win32::System::WinRT::{
        ISystemMediaTransportControlsInterop, RoGetActivationFactory,
    };

    struct Session {
        controls: SystemMediaTransportControls,
        button_token: i64,
    }

    static SESSION: OnceLock<Mutex<Option<Session>>> = OnceLock::new();

    fn session() -> &'static Mutex<Option<Session>> {
        SESSION.get_or_init(|| Mutex::new(None))
    }

    fn controls_for_window(
        window: &WebviewWindow,
    ) -> windows::core::Result<SystemMediaTransportControls> {
        let hwnd = window.hwnd().map_err(|error| {
            windows::core::Error::new(
                windows::core::HRESULT(0x80004005u32 as i32),
                error.to_string(),
            )
        })?;
        let class_name = HSTRING::from("Windows.Media.SystemMediaTransportControls");
        let factory: ISystemMediaTransportControlsInterop =
            unsafe { RoGetActivationFactory(&class_name)? };
        unsafe { factory.GetForWindow::<SystemMediaTransportControls>(hwnd) }
    }

    fn ensure_session(window: &WebviewWindow) -> Result<SystemMediaTransportControls, String> {
        let mut guard = session()
            .lock()
            .map_err(|_| "Windows media session lock poisoned".to_string())?;
        if let Some(existing) = guard.as_ref() {
            return Ok(existing.controls.clone());
        }
        let controls = controls_for_window(window).map_err(|error| error.to_string())?;
        let app = window.app_handle().clone();
        let handler: TypedEventHandler<
            SystemMediaTransportControls,
            windows::Media::SystemMediaTransportControlsButtonPressedEventArgs,
        > = TypedEventHandler::new(
            move |_sender: Ref<'_, SystemMediaTransportControls>,
                  args: Ref<
                '_,
                windows::Media::SystemMediaTransportControlsButtonPressedEventArgs,
            >| {
                let args = args.ok()?;
                let button = args.Button()?;
                let event = match button {
                    SystemMediaTransportControlsButton::Play => "play",
                    SystemMediaTransportControlsButton::Pause => "pause",
                    SystemMediaTransportControlsButton::Next => "next",
                    SystemMediaTransportControlsButton::Previous => "previous",
                    _ => return Ok(()),
                };
                let _ = app.emit("windows-media-control", event);
                Ok(())
            },
        );
        let button_token = controls
            .ButtonPressed(&handler)
            .map_err(|error| error.to_string())?;
        *guard = Some(Session {
            controls: controls.clone(),
            button_token,
        });
        Ok(controls)
    }

    pub fn update(window: &WebviewWindow, payload: NowPlayingPayload) -> Result<(), String> {
        let controls = ensure_session(window)?;
        controls
            .SetIsEnabled(true)
            .map_err(|error| error.to_string())?;
        controls
            .SetIsPlayEnabled(payload.play_enabled)
            .map_err(|error| error.to_string())?;
        controls
            .SetIsPauseEnabled(payload.pause_enabled)
            .map_err(|error| error.to_string())?;
        controls
            .SetIsNextEnabled(payload.next_enabled)
            .map_err(|error| error.to_string())?;
        controls
            .SetIsPreviousEnabled(payload.previous_enabled)
            .map_err(|error| error.to_string())?;
        let status = match payload.playback_status.as_str() {
            "playing" => MediaPlaybackStatus::Playing,
            "paused" => MediaPlaybackStatus::Paused,
            _ => MediaPlaybackStatus::Stopped,
        };
        controls
            .SetPlaybackStatus(status)
            .map_err(|error| error.to_string())?;
        let display = controls
            .DisplayUpdater()
            .map_err(|error| error.to_string())?;
        display.ClearAll().map_err(|error| error.to_string())?;
        display
            .SetType(MediaPlaybackType::Music)
            .map_err(|error| error.to_string())?;
        let properties = display
            .MusicProperties()
            .map_err(|error| error.to_string())?;
        properties
            .SetTitle(&HSTRING::from(payload.title))
            .map_err(|error| error.to_string())?;
        properties
            .SetArtist(&HSTRING::from(payload.artist))
            .map_err(|error| error.to_string())?;
        if let Some(album) = payload.album.filter(|value| !value.is_empty()) {
            properties
                .SetAlbumTitle(&HSTRING::from(album))
                .map_err(|error| error.to_string())?;
        }
        if let Some(url) = payload
            .artwork_url
            .filter(|value| value.starts_with("https://"))
        {
            if let Ok(uri) = Uri::CreateUri(&HSTRING::from(url)) {
                if let Ok(reference) = RandomAccessStreamReference::CreateFromUri(&uri) {
                    let _ = display.SetThumbnail(&reference);
                }
            }
        }
        display.Update().map_err(|error| error.to_string())
    }

    /// Updates only an existing session; a timeline alone never creates one.
    pub fn timeline(payload: TimelinePayload) -> Result<(), String> {
        let Some((position, duration)) = super::timeline_ticks(payload) else {
            return Ok(());
        };
        let controls = match session()
            .lock()
            .map_err(|_| "Windows media session lock poisoned".to_string())?
            .as_ref()
        {
            Some(existing) => existing.controls.clone(),
            None => return Ok(()),
        };
        let span = |ticks: i64| TimeSpan { Duration: ticks };
        let properties =
            SystemMediaTransportControlsTimelineProperties::new().map_err(|e| e.to_string())?;
        properties
            .SetStartTime(span(0))
            .map_err(|e| e.to_string())?;
        properties
            .SetMinSeekTime(span(0))
            .map_err(|e| e.to_string())?;
        properties
            .SetEndTime(span(duration))
            .map_err(|e| e.to_string())?;
        properties
            .SetMaxSeekTime(span(duration))
            .map_err(|e| e.to_string())?;
        properties
            .SetPosition(span(position))
            .map_err(|e| e.to_string())?;
        controls
            .UpdateTimelineProperties(&properties)
            .map_err(|e| e.to_string())
    }

    pub fn clear(window: &WebviewWindow) -> Result<(), String> {
        let controls = match session()
            .lock()
            .map_err(|_| "Windows media session lock poisoned".to_string())?
            .as_ref()
        {
            Some(existing) => existing.controls.clone(),
            None => match controls_for_window(window) {
                Ok(controls) => controls,
                Err(_) => return Ok(()),
            },
        };
        let display = controls
            .DisplayUpdater()
            .map_err(|error| error.to_string())?;
        display.ClearAll().map_err(|error| error.to_string())?;
        display.Update().map_err(|error| error.to_string())?;
        controls
            .SetPlaybackStatus(MediaPlaybackStatus::Stopped)
            .map_err(|error| error.to_string())?;
        controls
            .SetIsEnabled(false)
            .map_err(|error| error.to_string())
    }

    pub fn dispose() {
        if let Ok(mut guard) = session().lock() {
            if let Some(existing) = guard.take() {
                if let Ok(display) = existing.controls.DisplayUpdater() {
                    let _ = display.ClearAll();
                    let _ = display.Update();
                }
                let _ = existing
                    .controls
                    .SetPlaybackStatus(MediaPlaybackStatus::Stopped);
                let _ = existing.controls.SetIsEnabled(false);
                let _ = existing.controls.RemoveButtonPressed(existing.button_token);
            }
        }
    }
}

#[tauri::command]
pub fn update_windows_media_session(
    window: WebviewWindow,
    payload: NowPlayingPayload,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        platform::update(&window, payload)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window, payload);
        Ok(())
    }
}

#[tauri::command]
pub fn update_windows_media_timeline(payload: TimelinePayload) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        platform::timeline(payload)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = payload;
        Ok(())
    }
}

#[tauri::command]
pub fn clear_windows_media_session(window: WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        platform::clear(&window)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
        Ok(())
    }
}

pub fn dispose() {
    #[cfg(target_os = "windows")]
    platform::dispose();
}

#[cfg(test)]
mod tests {
    use super::{timeline_ticks, NowPlayingPayload, TimelinePayload};

    fn timeline(position_seconds: f64, duration_seconds: f64) -> Option<(i64, i64)> {
        timeline_ticks(TimelinePayload {
            position_seconds,
            duration_seconds,
        })
    }

    // Failure modes: NaN/infinite ticks reach the OS; zero-length tracks
    // publish an empty timeline; position past the end or negative.
    #[test]
    fn timeline_rejects_unusable_values() {
        assert_eq!(timeline(f64::NAN, 10.0), None);
        assert_eq!(timeline(1.0, f64::INFINITY), None);
        assert_eq!(timeline(1.0, 0.0), None);
        assert_eq!(timeline(1.0, -3.0), None);
    }

    #[test]
    fn timeline_clamps_and_converts_to_ticks() {
        assert_eq!(timeline(1.5, 10.0), Some((15_000_000, 100_000_000)));
        assert_eq!(timeline(-2.0, 10.0), Some((0, 100_000_000)));
        assert_eq!(timeline(99.0, 10.0), Some((100_000_000, 100_000_000)));
    }

    #[test]
    fn payload_uses_frontend_wire_keys() {
        let payload = NowPlayingPayload {
            title: "Song".into(),
            artist: "Artist".into(),
            album: Some("Album".into()),
            artwork_url: Some("https://example.test/art.jpg".into()),
            playback_status: "playing".into(),
            play_enabled: false,
            pause_enabled: true,
            next_enabled: true,
            previous_enabled: false,
        };
        let json = serde_json::to_value(payload).expect("payload serializes");
        assert_eq!(json["artworkUrl"], "https://example.test/art.jpg");
        assert_eq!(json["playbackStatus"], "playing");
        assert_eq!(json["pauseEnabled"], true);
        assert!(json.get("artwork_url").is_none());
    }
}
