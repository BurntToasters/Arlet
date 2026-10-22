use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{Manager, WebviewWindow};

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
    /// Defaults keep payloads from callers without mode state valid.
    #[serde(default)]
    pub shuffle: bool,
    /// `"off" | "all" | "one"`, as MusicKit reports it.
    #[serde(default = "default_repeat")]
    pub repeat: String,
}

/// Longest title, artist, or album passed to the OS overlay, in characters.
pub const MAX_TEXT_CHARS: usize = 1024;
/// Longest artwork URL accepted; longer ones are dropped, not truncated,
/// because a cut URL is never a valid artwork address.
pub const MAX_ARTWORK_URL_BYTES: usize = 2048;

fn clamp_chars(value: String, max: usize) -> String {
    match value.char_indices().nth(max) {
        Some((index, _)) => value[..index].to_string(),
        None => value,
    }
}

impl NowPlayingPayload {
    /// Caps the text the webview sends. The caller is treated as hostile: a
    /// huge string must not reach the OS overlay or the change-detection key.
    pub fn bounded(mut self) -> Self {
        self.title = clamp_chars(self.title, MAX_TEXT_CHARS);
        self.artist = clamp_chars(self.artist, MAX_TEXT_CHARS);
        self.album = self.album.map(|album| clamp_chars(album, MAX_TEXT_CHARS));
        self.artwork_url = self
            .artwork_url
            .filter(|url| url.len() <= MAX_ARTWORK_URL_BYTES);
        self
    }
}

fn default_repeat() -> String {
    "off".to_owned()
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelinePayload {
    pub position_seconds: f64,
    pub duration_seconds: f64,
}

/// Repeat state shared with the frontend wire format.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RepeatMode {
    Off,
    All,
    One,
}

impl RepeatMode {
    /// Unknown values read as `Off`, the safe default.
    pub fn from_wire(value: &str) -> Self {
        match value {
            "all" => Self::All,
            "one" => Self::One,
            _ => Self::Off,
        }
    }

    pub fn to_wire(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::All => "all",
            Self::One => "one",
        }
    }
}

/// Converts an SMTC seek request (100 ns ticks) to seconds. Requests that are
/// negative or non-finite, or that arrive before a usable duration is known,
/// are dropped. Positions past the end are clamped to the duration.
pub fn seek_seconds(ticks: i64, duration_seconds: f64) -> Option<f64> {
    if !duration_seconds.is_finite() || duration_seconds <= 0.0 {
        return None;
    }
    let seconds = ticks as f64 / 10_000_000.0;
    if !seconds.is_finite() || seconds < 0.0 {
        return None;
    }
    Some(seconds.min(duration_seconds))
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

/// Duration of the last valid timeline, as f64 bits; 0 means unknown. Seek
/// requests are checked against it on the SMTC callback thread.
static DURATION_BITS: AtomicU64 = AtomicU64::new(0);
/// Last playback status sent by the frontend; the tray uses it to pick the
/// Play or Pause command for its toggle item.
static PLAYING: AtomicBool = AtomicBool::new(false);

fn known_duration() -> f64 {
    f64::from_bits(DURATION_BITS.load(Ordering::SeqCst))
}

fn set_known_duration(seconds: f64) {
    DURATION_BITS.store(seconds.to_bits(), Ordering::SeqCst);
}

pub fn is_playing() -> bool {
    PLAYING.load(Ordering::SeqCst)
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{NowPlayingPayload, RepeatMode, TimelinePayload};
    use std::sync::{Mutex, OnceLock};
    use tauri::{Emitter, Manager, WebviewWindow};
    use windows::core::{Ref, HSTRING};
    use windows::Foundation::{TimeSpan, TypedEventHandler, Uri};
    use windows::Media::{
        AutoRepeatModeChangeRequestedEventArgs, MediaPlaybackAutoRepeatMode, MediaPlaybackStatus,
        MediaPlaybackType, PlaybackPositionChangeRequestedEventArgs,
        ShuffleEnabledChangeRequestedEventArgs, SystemMediaTransportControls,
        SystemMediaTransportControlsButton, SystemMediaTransportControlsTimelineProperties,
    };
    use windows::Storage::Streams::RandomAccessStreamReference;
    use windows::Win32::System::WinRT::{
        ISystemMediaTransportControlsInterop, RoGetActivationFactory,
    };

    struct Session {
        controls: SystemMediaTransportControls,
        button_token: i64,
        position_token: i64,
        shuffle_token: i64,
        repeat_token: i64,
        /// Title, artist, album, and artwork last shown. A pause or a mode
        /// change leaves them alone, so Windows is not made to clear the
        /// overlay and fetch the artwork again.
        display_key: Option<String>,
    }

    /// True when the display text or artwork differs from what is shown.
    fn display_changed(key: &str) -> Result<bool, String> {
        let guard = session()
            .lock()
            .map_err(|_| "Windows media session lock poisoned".to_string())?;
        Ok(guard
            .as_ref()
            .is_none_or(|existing| existing.display_key.as_deref() != Some(key)))
    }

    /// Records the key once Windows accepted the display, so a failed update
    /// is retried by the next one instead of being skipped as unchanged.
    fn record_display(key: String) -> Result<(), String> {
        let mut guard = session()
            .lock()
            .map_err(|_| "Windows media session lock poisoned".to_string())?;
        if let Some(existing) = guard.as_mut() {
            existing.display_key = Some(key);
        }
        Ok(())
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

    fn to_windows_repeat(mode: RepeatMode) -> MediaPlaybackAutoRepeatMode {
        match mode {
            RepeatMode::Off => MediaPlaybackAutoRepeatMode::None,
            RepeatMode::All => MediaPlaybackAutoRepeatMode::List,
            RepeatMode::One => MediaPlaybackAutoRepeatMode::Track,
        }
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
        let button_app = app.clone();
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
                let _ = button_app.emit_to(
                    crate::auth_popup::MAIN_WINDOW_LABEL,
                    "windows-media-control",
                    event,
                );
                Ok(())
            },
        );
        let button_token = controls
            .ButtonPressed(&handler)
            .map_err(|error| error.to_string())?;

        let position_app = app.clone();
        let position_handler: TypedEventHandler<
            SystemMediaTransportControls,
            PlaybackPositionChangeRequestedEventArgs,
        > = TypedEventHandler::new(
            move |_sender: Ref<'_, SystemMediaTransportControls>,
                  args: Ref<'_, PlaybackPositionChangeRequestedEventArgs>| {
                let args = args.ok()?;
                let ticks = args.RequestedPlaybackPosition()?.Duration;
                if let Some(seconds) = super::seek_seconds(ticks, super::known_duration()) {
                    let _ = position_app.emit_to(
                        crate::auth_popup::MAIN_WINDOW_LABEL,
                        "windows-media-seek",
                        seconds,
                    );
                }
                Ok(())
            },
        );
        let position_token = controls
            .PlaybackPositionChangeRequested(&position_handler)
            .map_err(|error| error.to_string())?;

        let shuffle_app = app.clone();
        let shuffle_handler: TypedEventHandler<
            SystemMediaTransportControls,
            ShuffleEnabledChangeRequestedEventArgs,
        > = TypedEventHandler::new(
            move |_sender: Ref<'_, SystemMediaTransportControls>,
                  args: Ref<'_, ShuffleEnabledChangeRequestedEventArgs>| {
                let args = args.ok()?;
                let enabled = args.RequestedShuffleEnabled()?;
                let _ = shuffle_app.emit_to(
                    crate::auth_popup::MAIN_WINDOW_LABEL,
                    "windows-media-shuffle",
                    enabled,
                );
                Ok(())
            },
        );
        let shuffle_token = controls
            .ShuffleEnabledChangeRequested(&shuffle_handler)
            .map_err(|error| error.to_string())?;

        let repeat_app = app.clone();
        let repeat_handler: TypedEventHandler<
            SystemMediaTransportControls,
            AutoRepeatModeChangeRequestedEventArgs,
        > = TypedEventHandler::new(
            move |_sender: Ref<'_, SystemMediaTransportControls>,
                  args: Ref<'_, AutoRepeatModeChangeRequestedEventArgs>| {
                let args = args.ok()?;
                let mode = match args.RequestedAutoRepeatMode()? {
                    MediaPlaybackAutoRepeatMode::Track => RepeatMode::One,
                    MediaPlaybackAutoRepeatMode::List => RepeatMode::All,
                    _ => RepeatMode::Off,
                };
                let _ = repeat_app.emit_to(
                    crate::auth_popup::MAIN_WINDOW_LABEL,
                    "windows-media-repeat",
                    mode.to_wire(),
                );
                Ok(())
            },
        );
        let repeat_token = controls
            .AutoRepeatModeChangeRequested(&repeat_handler)
            .map_err(|error| error.to_string())?;

        *guard = Some(Session {
            controls: controls.clone(),
            button_token,
            position_token,
            shuffle_token,
            repeat_token,
            display_key: None,
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
        controls
            .SetShuffleEnabled(payload.shuffle)
            .map_err(|error| error.to_string())?;
        controls
            .SetAutoRepeatMode(to_windows_repeat(RepeatMode::from_wire(&payload.repeat)))
            .map_err(|error| error.to_string())?;
        let status = match payload.playback_status.as_str() {
            "playing" => MediaPlaybackStatus::Playing,
            "paused" => MediaPlaybackStatus::Paused,
            _ => MediaPlaybackStatus::Stopped,
        };
        controls
            .SetPlaybackStatus(status)
            .map_err(|error| error.to_string())?;
        let artwork_url = payload
            .artwork_url
            .filter(|value| super::is_trusted_artwork_url(value));
        // Unit separators keep field boundaries unambiguous.
        let key = format!(
            "{}\u{1f}{}\u{1f}{}\u{1f}{}",
            payload.title,
            payload.artist,
            payload.album.as_deref().unwrap_or(""),
            artwork_url.as_deref().unwrap_or("")
        );
        if !display_changed(&key)? {
            return Ok(());
        }
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
        if let Some(url) = artwork_url {
            if let Ok(uri) = Uri::CreateUri(&HSTRING::from(url)) {
                if let Ok(reference) = RandomAccessStreamReference::CreateFromUri(&uri) {
                    let _ = display.SetThumbnail(&reference);
                }
            }
        }
        display.Update().map_err(|error| error.to_string())?;
        record_display(key)
    }

    /// Updates only an existing session; a timeline alone never creates one.
    pub fn timeline(payload: TimelinePayload) -> Result<(), String> {
        let Some((position, duration)) = super::timeline_ticks(payload) else {
            return Ok(());
        };
        super::set_known_duration(payload.duration_seconds);
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
        // The seek range is what lets Windows offer the timeline scrubber;
        // the PlaybackPositionChangeRequested handler answers it.
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
        super::set_known_duration(0.0);
        let controls = match session()
            .lock()
            .map_err(|_| "Windows media session lock poisoned".to_string())?
            .as_mut()
        {
            Some(existing) => {
                // The overlay is emptied below; the next update must refill it.
                existing.display_key = None;
                existing.controls.clone()
            }
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
        super::set_known_duration(0.0);
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
                let _ = existing
                    .controls
                    .RemovePlaybackPositionChangeRequested(existing.position_token);
                let _ = existing
                    .controls
                    .RemoveShuffleEnabledChangeRequested(existing.shuffle_token);
                let _ = existing
                    .controls
                    .RemoveAutoRepeatModeChangeRequested(existing.repeat_token);
            }
        }
    }
}

#[tauri::command]
pub fn update_windows_media_session(
    window: WebviewWindow,
    payload: NowPlayingPayload,
) -> Result<(), String> {
    let payload = payload.bounded();
    let playing = payload.playback_status == "playing";
    PLAYING.store(playing, Ordering::SeqCst);
    let app = window.app_handle().clone();
    crate::tray::set_now_playing(&app, &payload.title, &payload.artist);
    crate::thumbbar::update(
        &app,
        playing,
        payload.previous_enabled,
        payload.play_enabled || payload.pause_enabled,
        payload.next_enabled,
    );
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
    // Nothing plays after a clear: the tray toggle must send Play next.
    PLAYING.store(false, Ordering::SeqCst);
    let app = window.app_handle().clone();
    crate::tray::clear_now_playing(&app);
    crate::thumbbar::update(&app, false, false, false, false);
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

/// Windows fetches the thumbnail itself, so only Apple's artwork hosts are
/// passed on; any other host would learn the user's IP address.
fn is_trusted_artwork_url(value: &str) -> bool {
    url::Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && url
                .host_str()
                .is_some_and(|host| host.ends_with(".mzstatic.com") || host.ends_with(".apple.com"))
    })
}

#[cfg(test)]
mod tests {
    use super::{
        seek_seconds, timeline_ticks, NowPlayingPayload, RepeatMode, TimelinePayload,
        MAX_ARTWORK_URL_BYTES, MAX_TEXT_CHARS,
    };

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

    // Failure modes: a seek from the system flyout outside the timeline, or
    // a NaN/negative position, reaches MusicKit.
    #[test]
    fn seek_drops_negative_and_unknown_duration_requests() {
        assert_eq!(seek_seconds(-10_000_000, 180.0), None);
        assert_eq!(seek_seconds(10_000_000, 0.0), None);
        assert_eq!(seek_seconds(10_000_000, f64::NAN), None);
    }

    #[test]
    fn seek_converts_ticks_and_clamps_to_duration() {
        assert_eq!(seek_seconds(15_000_000, 180.0), Some(1.5));
        assert_eq!(seek_seconds(0, 180.0), Some(0.0));
        assert_eq!(seek_seconds(9_000_000_000_000, 180.0), Some(180.0));
    }

    #[test]
    fn repeat_wire_values_round_trip() {
        for mode in [RepeatMode::Off, RepeatMode::All, RepeatMode::One] {
            assert_eq!(RepeatMode::from_wire(mode.to_wire()), mode);
        }
        assert_eq!(RepeatMode::from_wire("loop"), RepeatMode::Off);
    }

    fn payload_with_text(text: &str, artwork_url: Option<String>) -> NowPlayingPayload {
        NowPlayingPayload {
            title: text.into(),
            artist: text.into(),
            album: Some(text.into()),
            artwork_url,
            playback_status: "paused".into(),
            play_enabled: true,
            pause_enabled: false,
            next_enabled: true,
            previous_enabled: true,
            shuffle: false,
            repeat: "off".into(),
        }
    }

    // Failure modes: a hostile caller sends megabyte strings that reach the
    // OS overlay; a cut artwork URL is requested as a broken address; a
    // multi-byte character split panics.
    #[test]
    fn bounded_caps_text_by_characters_and_drops_long_artwork() {
        let long = "é".repeat(MAX_TEXT_CHARS + 5);
        let url = format!(
            "https://a.mzstatic.com/{}",
            "x".repeat(MAX_ARTWORK_URL_BYTES)
        );
        let bounded = payload_with_text(&long, Some(url)).bounded();
        assert_eq!(bounded.title.chars().count(), MAX_TEXT_CHARS);
        assert_eq!(bounded.artist.chars().count(), MAX_TEXT_CHARS);
        assert_eq!(
            bounded.album.as_deref().map(|value| value.chars().count()),
            Some(MAX_TEXT_CHARS)
        );
        assert_eq!(bounded.artwork_url, None);
    }

    #[test]
    fn bounded_keeps_ordinary_values() {
        let bounded =
            payload_with_text("Song", Some("https://a.mzstatic.com/x.jpg".into())).bounded();
        assert_eq!(bounded.title, "Song");
        assert_eq!(
            bounded.artwork_url.as_deref(),
            Some("https://a.mzstatic.com/x.jpg")
        );
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
            shuffle: true,
            repeat: "all".into(),
        };
        let json = serde_json::to_value(payload).expect("payload serializes");
        assert_eq!(json["artworkUrl"], "https://example.test/art.jpg");
        assert_eq!(json["playbackStatus"], "playing");
        assert_eq!(json["pauseEnabled"], true);
        assert_eq!(json["shuffle"], true);
        assert_eq!(json["repeat"], "all");
        assert!(json.get("artwork_url").is_none());
    }
}
