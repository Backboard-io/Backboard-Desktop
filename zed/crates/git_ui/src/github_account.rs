use anyhow::{Context as _, Result, anyhow, bail};
use askpass::EncryptedPassword;
use client::Client;
use futures::AsyncReadExt as _;
use gpui::{AsyncApp, Context, SharedString, Task};
use http_client::{AsyncBody, HttpClient, Method, Request, Response, StatusCode};
use serde::Deserialize;
use std::sync::Arc;
use std::time::Duration;
use url::form_urlencoded;
use util::ResultExt;

const DEFAULT_GITHUB_OAUTH_CLIENT_ID: &str = "Ov23liepbvyEF8BpG4Tb";
const GITHUB_OAUTH_CLIENT_ID_ENV: &str = "BACKBOARD_GITHUB_OAUTH_CLIENT_ID";
const GITHUB_CREDENTIALS_URL: &str = "backboard://github/oauth";
const GITHUB_SCOPES: &str = "repo read:org";
const GITHUB_USER_AGENT: &str = "Backboard";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct GitHubRepository {
    pub(crate) name_with_owner: SharedString,
    pub(crate) clone_url: SharedString,
    pub(crate) is_private: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct GitHubCredentials {
    pub(crate) login: String,
    token: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GitHubPromptKind {
    Username,
    Password,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum GitHubAccountState {
    Checking,
    SignedOut,
    SigningIn {
        user_code: SharedString,
        verification_uri: SharedString,
        status: SharedString,
    },
    SignedIn {
        login: SharedString,
        repositories: Vec<GitHubRepository>,
        loading_repositories: bool,
    },
    Error {
        message: SharedString,
        sso_url: Option<SharedString>,
    },
}

pub(crate) struct GitHubAccountStore {
    client: Arc<Client>,
    state: GitHubAccountState,
    task: Option<Task<()>>,
}

#[derive(Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: Option<u64>,
}

#[derive(Deserialize)]
struct AccessTokenResponse {
    access_token: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Deserialize)]
struct UserResponse {
    login: String,
}

#[derive(Deserialize)]
struct RepositoryResponse {
    full_name: String,
    clone_url: String,
    private: bool,
}

impl GitHubPromptKind {
    pub(crate) fn parse(prompt: &str) -> Option<Self> {
        let prompt = prompt.to_ascii_lowercase();
        if !prompt.contains("github.com") {
            return None;
        }

        if prompt.contains("username") {
            Some(Self::Username)
        } else if prompt.contains("password") {
            Some(Self::Password)
        } else {
            None
        }
    }

    pub(crate) fn response(self, credentials: &GitHubCredentials) -> Result<EncryptedPassword> {
        let text = match self {
            GitHubPromptKind::Username => credentials.login.as_str(),
            GitHubPromptKind::Password => credentials.token.as_str(),
        };
        EncryptedPassword::try_from(text)
            .map_err(|_| anyhow!("failed to encrypt GitHub credential"))
    }
}

impl GitHubAccountStore {
    pub(crate) fn new(client: Arc<Client>, cx: &mut Context<Self>) -> Self {
        let mut this = Self {
            client,
            state: GitHubAccountState::Checking,
            task: None,
        };
        this.check_credentials(cx);
        this
    }

    pub(crate) fn state(&self) -> &GitHubAccountState {
        &self.state
    }

    pub(crate) fn sign_in(&mut self, cx: &mut Context<Self>) {
        let client = self.client.clone();
        self.state = GitHubAccountState::SigningIn {
            user_code: SharedString::from(""),
            verification_uri: SharedString::from("https://github.com/login/device"),
            status: SharedString::from("Starting GitHub sign-in..."),
        };
        cx.notify();

        self.task = Some(cx.spawn(async move |this, cx| {
            let result = sign_in_with_device_flow(client.clone(), this.clone(), cx).await;
            this.update(cx, |this, cx| {
                match result {
                    Ok(credentials) => {
                        this.state = GitHubAccountState::SignedIn {
                            login: SharedString::from(credentials.login),
                            repositories: Vec::new(),
                            loading_repositories: true,
                        };
                        this.refresh_repositories(cx);
                    }
                    Err(error) => {
                        this.state = GitHubAccountState::Error {
                            message: SharedString::from(error.to_string()),
                            sso_url: None,
                        };
                    }
                }
                cx.notify();
            })
            .ok();
        }));
    }

    pub(crate) fn sign_out(&mut self, cx: &mut Context<Self>) {
        let client = self.client.clone();
        self.state = GitHubAccountState::SignedOut;
        self.task = Some(cx.spawn(async move |_, cx| {
            delete_credentials(client, cx).await.log_err();
        }));
        cx.notify();
    }

    pub(crate) fn refresh_repositories(&mut self, cx: &mut Context<Self>) {
        let client = self.client.clone();
        self.task = Some(cx.spawn(async move |this, cx| {
            let result = async {
                let credentials = load_valid_credentials(client.clone(), cx)
                    .await?
                    .context("Sign in with GitHub to list repositories")?;
                fetch_repositories(client.http_client(), &credentials.token).await
            }
            .await;

            this.update(cx, |this, cx| {
                match result {
                    Ok(repositories) => {
                        let login = match &this.state {
                            GitHubAccountState::SignedIn { login, .. } => login.clone(),
                            _ => SharedString::from("GitHub"),
                        };
                        this.state = GitHubAccountState::SignedIn {
                            login,
                            repositories,
                            loading_repositories: false,
                        };
                    }
                    Err(error) => {
                        this.state = GitHubAccountState::Error {
                            message: SharedString::from(error.to_string()),
                            sso_url: github_sso_url_from_error(&error.to_string())
                                .map(SharedString::from),
                        };
                    }
                }
                cx.notify();
            })
            .ok();
        }));
    }

    fn check_credentials(&mut self, cx: &mut Context<Self>) {
        let client = self.client.clone();
        self.task = Some(cx.spawn(async move |this, cx| {
            let result = load_valid_credentials(client.clone(), cx).await;
            this.update(cx, |this, cx| {
                match result {
                    Ok(Some(credentials)) => {
                        this.state = GitHubAccountState::SignedIn {
                            login: SharedString::from(credentials.login),
                            repositories: Vec::new(),
                            loading_repositories: true,
                        };
                        this.refresh_repositories(cx);
                    }
                    Ok(None) => {
                        this.state = GitHubAccountState::SignedOut;
                    }
                    Err(error) => {
                        this.state = GitHubAccountState::Error {
                            message: SharedString::from(error.to_string()),
                            sso_url: None,
                        };
                    }
                }
                cx.notify();
            })
            .ok();
        }));
    }
}

pub(crate) async fn load_credentials(
    client: Arc<Client>,
    cx: &mut AsyncApp,
) -> Result<Option<GitHubCredentials>> {
    let Some((login, token)) = client
        .credentials_provider()
        .read_credentials(GITHUB_CREDENTIALS_URL, cx)
        .await?
    else {
        return Ok(None);
    };

    let token = String::from_utf8(token).context("GitHub credentials are not valid UTF-8")?;
    Ok(Some(GitHubCredentials { login, token }))
}

pub(crate) async fn load_valid_credentials(
    client: Arc<Client>,
    cx: &mut AsyncApp,
) -> Result<Option<GitHubCredentials>> {
    let Some(mut credentials) = load_credentials(client.clone(), cx).await? else {
        return Ok(None);
    };

    match fetch_login(client.http_client(), &credentials.token).await {
        Ok(login) => {
            if login != credentials.login {
                credentials.login = login;
                store_credentials(client, &credentials, cx).await?;
            }
            Ok(Some(credentials))
        }
        Err(error) if error.to_string().contains("authorization expired") => {
            delete_credentials(client, cx).await?;
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

pub(crate) async fn delete_credentials(client: Arc<Client>, cx: &mut AsyncApp) -> Result<()> {
    client
        .credentials_provider()
        .delete_credentials(GITHUB_CREDENTIALS_URL, cx)
        .await
}

async fn store_credentials(
    client: Arc<Client>,
    credentials: &GitHubCredentials,
    cx: &mut AsyncApp,
) -> Result<()> {
    client
        .credentials_provider()
        .write_credentials(
            GITHUB_CREDENTIALS_URL,
            &credentials.login,
            credentials.token.as_bytes(),
            cx,
        )
        .await
}

async fn sign_in_with_device_flow(
    client: Arc<Client>,
    this: gpui::WeakEntity<GitHubAccountStore>,
    cx: &mut AsyncApp,
) -> Result<GitHubCredentials> {
    let http_client = client.http_client();
    let client_id = github_client_id();
    let device_code = request_device_code(http_client.clone(), &client_id).await?;

    let verification_uri = device_code.verification_uri.clone();
    cx.update(|cx| cx.open_url(&verification_uri));
    this.update(cx, |this, cx| {
        this.state = GitHubAccountState::SigningIn {
            user_code: SharedString::from(device_code.user_code.clone()),
            verification_uri: SharedString::from(device_code.verification_uri.clone()),
            status: SharedString::from("Authorize Backboard in the GitHub browser window."),
        };
        cx.notify();
    })
    .ok();

    let token =
        poll_for_access_token(http_client.clone(), &client_id, device_code, this, cx).await?;
    let login = fetch_login(http_client, &token).await?;
    let credentials = GitHubCredentials { login, token };
    store_credentials(client, &credentials, cx).await?;
    Ok(credentials)
}

fn github_client_id() -> String {
    std::env::var(GITHUB_OAUTH_CLIENT_ID_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_GITHUB_OAUTH_CLIENT_ID.to_string())
}

async fn request_device_code(
    http_client: Arc<dyn HttpClient>,
    client_id: &str,
) -> Result<DeviceCodeResponse> {
    let body = form_urlencoded::Serializer::new(String::new())
        .append_pair("client_id", client_id)
        .append_pair("scope", GITHUB_SCOPES)
        .finish();
    let mut response = post_form(http_client, "https://github.com/login/device/code", body).await?;
    ensure_success(&mut response).await?;
    read_json_response(response).await
}

async fn poll_for_access_token(
    http_client: Arc<dyn HttpClient>,
    client_id: &str,
    device_code: DeviceCodeResponse,
    this: gpui::WeakEntity<GitHubAccountStore>,
    cx: &mut AsyncApp,
) -> Result<String> {
    let mut interval = Duration::from_secs(device_code.interval.unwrap_or(5).max(1));
    let expires_after = Duration::from_secs(device_code.expires_in);
    let started = std::time::Instant::now();

    loop {
        if started.elapsed() >= expires_after {
            bail!("GitHub sign-in code expired. Try signing in again.");
        }

        cx.background_executor().timer(interval).await;

        let body = form_urlencoded::Serializer::new(String::new())
            .append_pair("client_id", client_id)
            .append_pair("device_code", &device_code.device_code)
            .append_pair("grant_type", "urn:ietf:params:oauth:grant-type:device_code")
            .finish();
        let mut response = post_form(
            http_client.clone(),
            "https://github.com/login/oauth/access_token",
            body,
        )
        .await?;
        ensure_success(&mut response).await?;
        let token_response: AccessTokenResponse = read_json_response(response).await?;

        if let Some(token) = token_response.access_token {
            return Ok(token);
        }

        let error = token_response.error.as_deref().unwrap_or("unknown");
        match error {
            "authorization_pending" => {
                this.update(cx, |this, cx| {
                    this.state = GitHubAccountState::SigningIn {
                        user_code: SharedString::from(device_code.user_code.clone()),
                        verification_uri: SharedString::from(device_code.verification_uri.clone()),
                        status: SharedString::from("Waiting for GitHub authorization..."),
                    };
                    cx.notify();
                })
                .ok();
            }
            "slow_down" => {
                interval += Duration::from_secs(5);
            }
            "expired_token" => bail!("GitHub sign-in code expired. Try signing in again."),
            "access_denied" => bail!("GitHub sign-in was cancelled."),
            "device_flow_disabled" => bail!(
                "GitHub Device Flow is disabled for this OAuth app. Enable it in the GitHub OAuth app settings."
            ),
            _ => bail!(
                "{}",
                token_response
                    .error_description
                    .unwrap_or_else(|| format!("GitHub sign-in failed: {error}"))
            ),
        }
    }
}

async fn fetch_login(http_client: Arc<dyn HttpClient>, token: &str) -> Result<String> {
    let mut response = github_api_get(http_client, "https://api.github.com/user", token).await?;
    ensure_success(&mut response).await?;
    let user: UserResponse = read_json_response(response).await?;
    Ok(user.login)
}

async fn fetch_repositories(
    http_client: Arc<dyn HttpClient>,
    token: &str,
) -> Result<Vec<GitHubRepository>> {
    let mut repositories = Vec::new();
    for page in 1..=10 {
        let url = format!(
            "https://api.github.com/user/repos?per_page=100&page={page}&affiliation=owner,collaborator,organization_member&sort=full_name"
        );
        let mut response = github_api_get(http_client.clone(), &url, token).await?;
        ensure_success(&mut response).await?;
        let page_repositories: Vec<RepositoryResponse> = read_json_response(response).await?;
        if page_repositories.is_empty() {
            break;
        }

        repositories.extend(
            page_repositories
                .into_iter()
                .map(|repository| GitHubRepository {
                    name_with_owner: SharedString::from(repository.full_name),
                    clone_url: SharedString::from(repository.clone_url),
                    is_private: repository.private,
                }),
        );
    }

    repositories.sort_by_key(|repository| repository.name_with_owner.to_ascii_lowercase());
    Ok(repositories)
}

async fn post_form(
    http_client: Arc<dyn HttpClient>,
    uri: &str,
    body: String,
) -> Result<Response<AsyncBody>> {
    let request = Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Accept", "application/json")
        .header("User-Agent", GITHUB_USER_AGENT)
        .body(AsyncBody::from(body.into_bytes()))?;
    http_client.send(request).await
}

async fn github_api_get(
    http_client: Arc<dyn HttpClient>,
    uri: &str,
    token: &str,
) -> Result<Response<AsyncBody>> {
    let request = Request::builder()
        .method(Method::GET)
        .uri(uri)
        .header("Accept", "application/vnd.github+json")
        .header("Authorization", format!("Bearer {token}"))
        .header("User-Agent", GITHUB_USER_AGENT)
        .header("X-GitHub-Api-Version", "2022-11-28")
        .body(AsyncBody::default())?;
    http_client.send(request).await
}

async fn ensure_success(response: &mut Response<AsyncBody>) -> Result<()> {
    if response.status().is_success() {
        return Ok(());
    }

    let status = response.status();
    let sso_url = response
        .headers()
        .get("X-GitHub-SSO")
        .and_then(|header| header.to_str().ok())
        .and_then(github_sso_url_from_error);
    let mut body = String::new();
    response.body_mut().read_to_string(&mut body).await?;

    if status == StatusCode::UNAUTHORIZED {
        bail!("GitHub authorization expired. Sign in with GitHub again.");
    }

    if let Some(sso_url) = sso_url {
        bail!("GitHub organization SSO authorization is required: {sso_url}");
    }

    bail!("GitHub request failed with status {status}: {body}");
}

async fn read_json_response<T: for<'de> Deserialize<'de>>(
    mut response: Response<AsyncBody>,
) -> Result<T> {
    let mut body = String::new();
    response.body_mut().read_to_string(&mut body).await?;
    serde_json::from_str(&body).context("failed to parse GitHub response")
}

pub(crate) fn github_sso_url_from_error(text: &str) -> Option<String> {
    text.split(';')
        .flat_map(|part| part.split(','))
        .find_map(|part| {
            let part = part.trim();
            part.strip_prefix("url=").map(ToString::to_string)
        })
        .or_else(|| {
            text.split_whitespace()
                .find(|part| part.starts_with("https://github.com/orgs/"))
                .map(|part| part.trim_end_matches('.').to_string())
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_github_askpass_prompts() {
        assert_eq!(
            GitHubPromptKind::parse("Username for 'https://github.com':"),
            Some(GitHubPromptKind::Username)
        );
        assert_eq!(
            GitHubPromptKind::parse("Password for 'https://github.com':"),
            Some(GitHubPromptKind::Password)
        );
        assert_eq!(GitHubPromptKind::parse("Password for example.com"), None);
    }

    #[test]
    fn parses_sso_url_from_header() {
        assert_eq!(
            github_sso_url_from_error(
                "required; url=https://github.com/orgs/acme/sso?authorization_request=123"
            ),
            Some("https://github.com/orgs/acme/sso?authorization_request=123".to_string())
        );
    }
}
