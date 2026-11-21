//! Minimum supported version, published as `min_ver.txt` beside the hosted
//! MusicKit token file. Its one version string is the oldest Arlet allowed to
//! run and to receive the token. Every failure to read it means no
//! requirement, so an outage or a missing file never blocks anyone.

use semver::Version;
use tauri::{AppHandle, Manager};

use crate::hosted_token::{self, SourceError};
use crate::logging;

/// Replaces the token file's last path segment to name the minimum-version file.
const MINIMUM_FILE_NAME: &str = "min_ver.txt";
/// The file is one short version string; anything larger is refused unread.
const MAX_MINIMUM_BYTES: usize = 64;

/// Fetched once per launch. Concurrent callers wait on the same download.
#[derive(Default)]
pub struct MinVersionState {
    minimum: tokio::sync::OnceCell<Option<Version>>,
}

/// What the frontend reads: whether this build must update, and to what.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct MinVersionStatus {
    pub required: bool,
    pub minimum: Option<String>,
    pub current: String,
}

/// Why the file could not be used. Only the category is logged.
enum Skip {
    Source(SourceError),
    Body,
}

impl Skip {
    fn label(&self) -> String {
        match self {
            Self::Source(error) => format!("{error:?}"),
            Self::Body => "Body".to_string(),
        }
    }
}

/// Started from setup so the fetch overlaps webview load. `token()` then
/// usually finds the result ready, and shares the in-flight fetch otherwise.
pub async fn prefetch(app: AppHandle) {
    let _ = status(&app).await;
}

pub async fn status(app: &AppHandle) -> MinVersionStatus {
    let state = app.state::<MinVersionState>();
    let minimum = state
        .minimum
        .get_or_init(|| load_minimum(app))
        .await
        .clone();
    let current = app.package_info().version.clone();
    let required = minimum.as_ref().is_some_and(|minimum| *minimum > current);
    MinVersionStatus {
        required,
        minimum: minimum.map(|version| version.to_string()),
        current: current.to_string(),
    }
}

async fn load_minimum(app: &AppHandle) -> Option<Version> {
    // Debug builds read `.env` and make no network calls, as in hosted_token.
    if cfg!(debug_assertions) {
        return None;
    }
    match fetch_minimum(app).await {
        Ok(version) => Some(version),
        Err(skip) => {
            if crate::settings::debug_mode() {
                logging::write_native_log(&format!(
                    "Minimum version check skipped: {}",
                    skip.label()
                ));
            }
            None
        }
    }
}

async fn fetch_minimum(app: &AppHandle) -> Result<Version, Skip> {
    let (token_url, allow_loopback_http) = hosted_token::token_source(app).map_err(Skip::Source)?;
    let url = minimum_url(&token_url).map_err(Skip::Source)?;
    hosted_token::validate_url(&url, allow_loopback_http).map_err(Skip::Source)?;
    hosted_token::ensure_tls_provider();
    let mut builder = reqwest::Client::builder()
        .https_only(!allow_loopback_http)
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .timeout(hosted_token::FETCH_TIMEOUT)
        .user_agent(hosted_token::USER_AGENT);
    if allow_loopback_http {
        builder = builder.no_proxy();
    }
    let client = builder
        .build()
        .map_err(|_| Skip::Source(SourceError::Network))?;
    let mut response = client
        .get(&url)
        .send()
        .await
        .map_err(|_| Skip::Source(SourceError::Network))?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(Skip::Source(SourceError::Status));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_MINIMUM_BYTES as u64)
    {
        return Err(Skip::Source(SourceError::TooLarge));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| Skip::Source(SourceError::Interrupted))?
    {
        if body.len() + chunk.len() > MAX_MINIMUM_BYTES {
            return Err(Skip::Source(SourceError::TooLarge));
        }
        body.extend_from_slice(&chunk);
    }
    let text = std::str::from_utf8(&body).map_err(|_| Skip::Body)?;
    Version::parse(text.trim()).map_err(|_| Skip::Body)
}

/// The token URL with its last path segment replaced by `min_ver.txt`, so the
/// file sits in the same directory on the same scheme and host.
fn minimum_url(token_url: &str) -> Result<String, SourceError> {
    let mut url = url::Url::parse(token_url).map_err(|_| SourceError::InsecureUrl)?;
    let (directory, _) = url
        .path()
        .rsplit_once('/')
        .ok_or(SourceError::InsecureUrl)?;
    let path = format!("{directory}/{MINIMUM_FILE_NAME}");
    url.set_path(&path);
    url.set_query(None);
    Ok(url.into())
}

#[tauri::command]
pub async fn min_version_status(app: AppHandle) -> MinVersionStatus {
    status(&app).await
}
