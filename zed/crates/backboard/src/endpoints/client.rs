use anyhow::{Context as _, Result};
use reqwest::{Client, Response, StatusCode};
use thiserror::Error;

use super::BackboardConfig;

#[derive(Debug, Error)]
pub enum BackboardError {
    #[error("Backboard API key is missing. Run `backboard config set-api-key <key>`.")]
    MissingApiKey,
    #[error("Backboard API returned {status}: {body}")]
    Api { status: StatusCode, body: String },
}

#[derive(Clone)]
pub struct BackboardClient {
    pub(crate) client: Client,
    base_url: String,
    api_key: String,
}

impl BackboardClient {
    pub fn from_config(config: BackboardConfig) -> Result<Self> {
        let api_key = config.api_key().ok_or(BackboardError::MissingApiKey)?;
        Ok(Self::new(config.base_url(), api_key))
    }

    pub fn from_saved_config() -> Result<Self> {
        Self::from_config(BackboardConfig::load()?)
    }

    pub fn new(base_url: impl Into<String>, api_key: impl Into<String>) -> Self {
        Self {
            client: Client::new(),
            base_url: base_url.into().trim_end_matches('/').to_string(),
            api_key: api_key.into(),
        }
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub(crate) fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    pub(crate) fn json_headers(&self) -> Result<reqwest::header::HeaderMap> {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("X-API-Key", self.api_key_header()?);
        headers.insert(
            reqwest::header::CONTENT_TYPE,
            reqwest::header::HeaderValue::from_static("application/json"),
        );
        Ok(headers)
    }

    pub(crate) fn api_key_header(&self) -> Result<reqwest::header::HeaderValue> {
        reqwest::header::HeaderValue::from_str(&self.api_key)
            .context("Backboard API key is not a valid HTTP header value")
    }

    pub(crate) async fn json<T: serde::de::DeserializeOwned>(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<T> {
        let response = request.send().await?;
        let response = self.ensure_success(response).await?;
        parse_json_response(response).await
    }

    pub(crate) async fn ensure_success(&self, response: Response) -> Result<Response> {
        if response.status().is_success() {
            return Ok(response);
        }
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        Err(BackboardError::Api { status, body }.into())
    }
}

pub(crate) async fn parse_json_response<T: serde::de::DeserializeOwned>(
    response: Response,
) -> Result<T> {
    let text = response.text().await?;
    Ok(serde_json::from_str(&text)?)
}
