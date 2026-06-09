use anyhow::{Context as _, anyhow};
use askpass::EncryptedPassword;
use client::Client;
use futures::AsyncReadExt as _;
use gpui::{AsyncApp, Context, SharedString};
use http_client::{AsyncBody, Method, Request, StatusCode};
use serde::Deserialize;
use std::sync::Arc;
use std::time::{Duration, Instant};
use util::ResultExt as _;

const GITHUB_CREDENTIALS_URL: &str = "backboard://github.com";
const GITHUB_REPOSITORIES_PER_PAGE: usize = 100;
const GITHUB_OAUTH_CLIENT_ID_ENV_VAR: &str = "BACKBOARD_GITHUB_OAUTH_CLIENT_ID";
const DEFAULT_GITHUB_OAUTH_CLIENT_ID: &str = "Ov23liepbvyEF8BpG4Tb";
const GITHUB_OAUTH_SCOPES: &str = "repo read:org";
const GITHUB_DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const GITHUB_ACCESS_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";

#[derive(Clone, Debug)]
pub enum GitHubAccountStatus {
    Checking,
    SignedOut,
    SigningIn {
        user_code: SharedString,
    },
    SignedIn {
        login: SharedString,
        repositories: Vec<GitHubRepository>,
    },
    Error(SharedString),
}

#[derive(Clone, Debug)]
pub struct GitHubRepository {
    pub name_with_owner: String,
    pub clone_url: String,
    pub is_private: bool,
}

#[derive(Clone, Debug)]
pub struct StoredGitHubCredential {
    pub login: String,
    access_token: String,
}

#[derive(Clone, Debug)]
struct GitHubCredentials {
    github_login: String,
    access_token: String,
}

pub struct GitHubAccountStore {
    client: Arc<Client>,
    status: GitHubAccountStatus,
}

impl GitHubAccountStore {
    pub fn new(client: Arc<Client>, cx: &mut Context<Self>) -> Self {
        let mut this = Self {
            client,
            status: GitHubAccountStatus::Checking,
        };
        this.refresh(cx);
        this
    }

    pub fn status(&self) -> &GitHubAccountStatus {
        &self.status
    }

    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        self.status = GitHubAccountStatus::Checking;
        cx.notify();

        let client = self.client.clone();
        cx.spawn(async move |this, cx| {
            let status = load_status(client, cx).await;
            this.update(cx, |this, cx| {
                this.status = status;
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub fn sign_in(&mut self, cx: &mut Context<Self>) {
        if matches!(self.status, GitHubAccountStatus::SigningIn { .. }) {
            return;
        }

        self.status = GitHubAccountStatus::Checking;
        cx.notify();

        let client = self.client.clone();
        cx.spawn(async move |this, cx| {
            let status = async {
                let authorization = request_device_authorization(client.clone()).await?;
                let user_code = authorization.user_code.clone();
                let verification_uri = authorization.verification_uri.clone();
                this.update(cx, |this, cx| {
                    this.status = GitHubAccountStatus::SigningIn {
                        user_code: user_code.into(),
                    };
                    cx.notify();
                })
                .ok();
                cx.update(|cx| cx.open_url(&verification_uri));

                let credentials =
                    poll_device_authorization(client.clone(), authorization, cx).await?;
                write_stored_credentials(client.clone(), &credentials, cx).await?;
                Ok::<GitHubAccountStatus, anyhow::Error>(
                    fetch_signed_in_status(
                        client,
                        credentials.github_login,
                        credentials.access_token,
                    )
                    .await,
                )
            }
            .await
            .unwrap_or_else(|error| GitHubAccountStatus::Error(error.to_string().into()));

            this.update(cx, |this, cx| {
                this.status = status;
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
}

pub async fn stored_credentials(
    cx: &mut AsyncApp,
) -> anyhow::Result<Option<StoredGitHubCredential>> {
    let client = cx.update(|cx| Client::global(cx));
    let credentials_provider = client.credentials_provider();
    let Some((login, access_token)) = credentials_provider
        .read_credentials(GITHUB_CREDENTIALS_URL, cx)
        .await?
    else {
        return Ok(None);
    };

    Ok(Some(StoredGitHubCredential {
        login,
        access_token: String::from_utf8(access_token)
            .context("stored GitHub token is not valid UTF-8")?,
    }))
}

pub async fn delete_stored_credentials(cx: &mut AsyncApp) -> anyhow::Result<()> {
    let client = cx.update(|cx| Client::global(cx));
    client
        .credentials_provider()
        .delete_credentials(GITHUB_CREDENTIALS_URL, cx)
        .await
}

pub async fn askpass_response_for_prompt(
    prompt: &str,
    cx: &mut AsyncApp,
) -> anyhow::Result<Option<EncryptedPassword>> {
    let lower_prompt = prompt.to_lowercase();
    if !is_github_askpass_prompt(&lower_prompt) {
        return Ok(None);
    }

    let Some(credentials) = stored_credentials(cx).await? else {
        return Ok(None);
    };

    encrypted_response_for_prompt(&lower_prompt, credentials)
}

pub fn filter_repositories(
    repositories: &[GitHubRepository],
    query: &str,
) -> Vec<GitHubRepository> {
    let query = query.trim().to_lowercase();
    repositories
        .iter()
        .filter(|repository| {
            query.is_empty()
                || repository
                    .name_with_owner
                    .to_lowercase()
                    .contains(query.as_str())
        })
        .take(100)
        .cloned()
        .collect()
}

async fn load_status(client: Arc<Client>, cx: &mut AsyncApp) -> GitHubAccountStatus {
    let credentials = match stored_credentials(cx).await {
        Ok(Some(credentials)) => credentials,
        Ok(None) => return GitHubAccountStatus::SignedOut,
        Err(error) => return GitHubAccountStatus::Error(error.to_string().into()),
    };

    let login = credentials.login;
    let access_token = credentials.access_token;
    match fetch_signed_in_status(client, login, access_token).await {
        GitHubAccountStatus::Error(error) if error.as_ref().contains("GitHub sign-in expired") => {
            delete_stored_credentials(cx).await.log_err();
            GitHubAccountStatus::SignedOut
        }
        status => status,
    }
}

async fn fetch_signed_in_status(
    client: Arc<Client>,
    login: String,
    access_token: String,
) -> GitHubAccountStatus {
    match fetch_github_repositories(client, &access_token).await {
        Ok(repositories) => GitHubAccountStatus::SignedIn {
            login: login.into(),
            repositories,
        },
        Err(GitHubRepositoryFetchError::Unauthorized) => {
            GitHubAccountStatus::Error("GitHub sign-in expired. Sign in again.".into())
        }
        Err(GitHubRepositoryFetchError::Forbidden(body)) => {
            GitHubAccountStatus::Error(github_forbidden_message(&body).into())
        }
        Err(GitHubRepositoryFetchError::Other(error)) => {
            GitHubAccountStatus::Error(error.to_string().into())
        }
    }
}

async fn write_stored_credentials(
    client: Arc<Client>,
    credentials: &GitHubCredentials,
    cx: &mut AsyncApp,
) -> anyhow::Result<()> {
    client
        .credentials_provider()
        .write_credentials(
            GITHUB_CREDENTIALS_URL,
            &credentials.github_login,
            credentials.access_token.as_bytes(),
            cx,
        )
        .await
}

#[derive(Debug)]
enum GitHubRepositoryFetchError {
    Unauthorized,
    Forbidden(String),
    Other(anyhow::Error),
}

impl From<anyhow::Error> for GitHubRepositoryFetchError {
    fn from(error: anyhow::Error) -> Self {
        Self::Other(error)
    }
}

#[derive(Deserialize)]
struct GitHubDeviceAuthorization {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    #[serde(default = "default_github_device_poll_interval")]
    interval: u64,
}

#[derive(Deserialize)]
struct GitHubAccessTokenResponse {
    access_token: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Deserialize)]
struct GitHubUserResponse {
    login: String,
}

fn default_github_device_poll_interval() -> u64 {
    5
}

fn github_oauth_client_id() -> anyhow::Result<String> {
    std::env::var(GITHUB_OAUTH_CLIENT_ID_ENV_VAR)
        .ok()
        .or_else(|| option_env!("BACKBOARD_GITHUB_OAUTH_CLIENT_ID").map(str::to_string))
        .or_else(|| Some(DEFAULT_GITHUB_OAUTH_CLIENT_ID.to_string()))
        .filter(|client_id| !client_id.trim().is_empty())
        .ok_or_else(|| {
            anyhow!(
                "GitHub sign-in is not configured. Build Backboard with {GITHUB_OAUTH_CLIENT_ID_ENV_VAR} set to a GitHub OAuth app client ID with device flow enabled."
            )
        })
}

pub(crate) fn is_github_askpass_prompt(prompt: &str) -> bool {
    let lower_prompt = prompt.to_lowercase();
    lower_prompt.contains("github.com")
        && (lower_prompt.contains("username") || lower_prompt.contains("password"))
}

pub(crate) async fn sign_in_and_store(
    client: Arc<Client>,
    cx: &mut AsyncApp,
    on_user_code: impl FnOnce(SharedString, &mut AsyncApp) + Send + 'static,
) -> anyhow::Result<StoredGitHubCredential> {
    let authorization = request_device_authorization(client.clone()).await?;
    let verification_uri = authorization.verification_uri.clone();
    on_user_code(authorization.user_code.clone().into(), cx);
    cx.update(|cx| cx.open_url(&verification_uri));

    let credentials = poll_device_authorization(client.clone(), authorization, cx).await?;
    write_stored_credentials(client, &credentials, cx).await?;
    Ok(StoredGitHubCredential {
        login: credentials.github_login,
        access_token: credentials.access_token,
    })
}

pub(crate) fn encrypted_response_for_prompt(
    lower_prompt: &str,
    credentials: StoredGitHubCredential,
) -> anyhow::Result<Option<EncryptedPassword>> {
    let response = if lower_prompt.contains("username") {
        credentials.login
    } else if lower_prompt.contains("password") {
        credentials.access_token
    } else {
        return Ok(None);
    };

    Ok(Some(EncryptedPassword::try_from(response.as_ref())?))
}

async fn request_device_authorization(
    client: Arc<Client>,
) -> anyhow::Result<GitHubDeviceAuthorization> {
    let client_id = github_oauth_client_id()?;
    let body = format!(
        "client_id={client_id}&scope={}",
        GITHUB_OAUTH_SCOPES.replace(' ', "%20").replace(':', "%3A")
    );
    let request = Request::builder()
        .method(Method::POST)
        .uri(GITHUB_DEVICE_CODE_URL)
        .header("Accept", "application/json")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("User-Agent", "Backboard")
        .body(AsyncBody::from(body))
        .context("failed to build GitHub device authorization request")?;

    let mut response = client
        .http_client()
        .send(request)
        .await
        .context("failed to start GitHub sign-in")?;
    let mut body = String::new();
    response
        .body_mut()
        .read_to_string(&mut body)
        .await
        .context("failed to read GitHub sign-in response")?;

    if !response.status().is_success() {
        anyhow::bail!("GitHub sign-in failed: {body}");
    }

    serde_json::from_str(&body).context("failed to parse GitHub sign-in response")
}

async fn poll_device_authorization(
    client: Arc<Client>,
    authorization: GitHubDeviceAuthorization,
    cx: &mut AsyncApp,
) -> anyhow::Result<GitHubCredentials> {
    let client_id = github_oauth_client_id()?;
    let started_at = Instant::now();
    let mut interval = Duration::from_secs(authorization.interval.max(1));
    let expires_in = Duration::from_secs(authorization.expires_in);

    loop {
        cx.background_executor().timer(interval).await;
        if started_at.elapsed() >= expires_in {
            anyhow::bail!("GitHub sign-in expired. Try again.");
        }

        let body = format!(
            "client_id={client_id}&device_code={}&grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code",
            authorization.device_code
        );
        let request = Request::builder()
            .method(Method::POST)
            .uri(GITHUB_ACCESS_TOKEN_URL)
            .header("Accept", "application/json")
            .header("Content-Type", "application/x-www-form-urlencoded")
            .header("User-Agent", "Backboard")
            .body(AsyncBody::from(body))
            .context("failed to build GitHub token request")?;

        let mut response = client
            .http_client()
            .send(request)
            .await
            .context("failed to finish GitHub sign-in")?;
        let mut body = String::new();
        response
            .body_mut()
            .read_to_string(&mut body)
            .await
            .context("failed to read GitHub token response")?;

        if !response.status().is_success() {
            anyhow::bail!("GitHub sign-in failed: {body}");
        }

        let response: GitHubAccessTokenResponse =
            serde_json::from_str(&body).context("failed to parse GitHub token response")?;

        if let Some(access_token) = response.access_token {
            let github_login = fetch_github_login(client, &access_token).await?;
            return Ok(GitHubCredentials {
                github_login,
                access_token,
            });
        }

        match response.error.as_deref() {
            Some("authorization_pending") => {}
            Some("slow_down") => {
                interval += Duration::from_secs(5);
            }
            Some("expired_token") | Some("token_expired") => {
                anyhow::bail!("GitHub sign-in expired. Try again.");
            }
            Some("access_denied") => {
                anyhow::bail!("GitHub sign-in was cancelled.");
            }
            Some("device_flow_disabled") => {
                anyhow::bail!(
                    "GitHub sign-in is not enabled for this OAuth app. Enable device flow in the GitHub OAuth app settings."
                );
            }
            Some(error) => {
                let description = response
                    .error_description
                    .unwrap_or_else(|| error.to_string());
                anyhow::bail!("GitHub sign-in failed: {description}");
            }
            None => anyhow::bail!("GitHub did not return an access token."),
        }
    }
}

async fn fetch_github_login(client: Arc<Client>, access_token: &str) -> anyhow::Result<String> {
    let authorization_header = format!("Bearer {access_token}");
    let request = Request::builder()
        .method(Method::GET)
        .uri("https://api.github.com/user")
        .header("Authorization", authorization_header.as_str())
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "Backboard")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .body(AsyncBody::default())
        .context("failed to build GitHub user request")?;

    let mut response = client
        .http_client()
        .send(request)
        .await
        .context("failed to load GitHub user")?;
    let status = response.status();
    let mut body = String::new();
    response
        .body_mut()
        .read_to_string(&mut body)
        .await
        .context("failed to read GitHub user response")?;

    if status == StatusCode::UNAUTHORIZED {
        anyhow::bail!("GitHub sign-in expired. Sign in again.");
    }

    if !status.is_success() {
        anyhow::bail!("GitHub returned {status}: {body}");
    }

    let user: GitHubUserResponse =
        serde_json::from_str(&body).context("failed to parse GitHub user response")?;
    Ok(user.login)
}
async fn fetch_github_repositories(
    client: Arc<Client>,
    access_token: &str,
) -> Result<Vec<GitHubRepository>, GitHubRepositoryFetchError> {
    let http_client = client.http_client();
    let authorization_header = format!("Bearer {access_token}");
    let mut repositories = Vec::new();
    let mut page = 1;

    loop {
        let request = Request::builder()
            .method(Method::GET)
            .uri(format!(
                "https://api.github.com/user/repos?per_page={GITHUB_REPOSITORIES_PER_PAGE}&page={page}&affiliation=owner,collaborator,organization_member"
            ))
            .header("Authorization", authorization_header.as_str())
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", "Backboard")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .body(AsyncBody::default())
            .context("failed to build GitHub repositories request")?;

        let mut response = http_client
            .send(request)
            .await
            .context("failed to load GitHub repositories")?;

        if response.status() == StatusCode::UNAUTHORIZED {
            return Err(GitHubRepositoryFetchError::Unauthorized);
        }

        if response.status() == StatusCode::FORBIDDEN {
            let mut body = String::new();
            response.body_mut().read_to_string(&mut body).await.ok();
            return Err(GitHubRepositoryFetchError::Forbidden(body));
        }

        if !response.status().is_success() {
            let status = response.status();
            let mut body = String::new();
            response.body_mut().read_to_string(&mut body).await.ok();
            return Err(anyhow!("GitHub returned {status}: {body}").into());
        }

        let mut body = String::new();
        response
            .body_mut()
            .read_to_string(&mut body)
            .await
            .context("failed to read GitHub repositories response")?;
        let page_repositories = parse_github_repositories(&body)?;
        let is_last_page = page_repositories.len() < GITHUB_REPOSITORIES_PER_PAGE;
        repositories.extend(page_repositories);

        if is_last_page {
            break;
        }

        page += 1;
    }

    repositories.sort_by_key(|repository| repository.name_with_owner.to_lowercase());
    Ok(repositories)
}

fn github_forbidden_message(body: &str) -> SharedString {
    if body.contains("resource protected by organization SAML enforcement") {
        "GitHub requires organization SSO authorization for this account. Authorize Backboard in GitHub, then retry.".into()
    } else {
        "GitHub refused repository access. Check organization SSO authorization and retry.".into()
    }
}

fn parse_github_repositories(body: &str) -> anyhow::Result<Vec<GitHubRepository>> {
    #[derive(Deserialize)]
    struct GitHubApiRepository {
        full_name: String,
        clone_url: String,
        #[serde(rename = "private")]
        is_private: bool,
    }

    let repositories: Vec<GitHubApiRepository> =
        serde_json::from_str(body).context("failed to parse GitHub repositories response")?;

    Ok(repositories
        .into_iter()
        .map(|repository| GitHubRepository {
            name_with_owner: repository.full_name,
            clone_url: repository.clone_url,
            is_private: repository.is_private,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_github_repositories() {
        let repositories = parse_github_repositories(
            r#"[
                {"full_name":"zed-industries/zed","clone_url":"https://github.com/zed-industries/zed.git","private":false},
                {"full_name":"backboard/private","clone_url":"https://github.com/backboard/private.git","private":true}
            ]"#,
        )
        .expect("repositories should parse");

        assert_eq!(repositories.len(), 2);
        assert_eq!(repositories[0].name_with_owner, "zed-industries/zed");
        assert!(!repositories[0].is_private);
        assert!(repositories[1].is_private);
    }

    #[test]
    fn filters_repositories_by_owner_or_name() {
        let repositories = vec![
            GitHubRepository {
                name_with_owner: "zed-industries/zed".into(),
                clone_url: "https://github.com/zed-industries/zed.git".into(),
                is_private: false,
            },
            GitHubRepository {
                name_with_owner: "backboard/private".into(),
                clone_url: "https://github.com/backboard/private.git".into(),
                is_private: true,
            },
        ];

        let filtered = filter_repositories(&repositories, "PRIVATE");
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].name_with_owner, "backboard/private");
    }
}
