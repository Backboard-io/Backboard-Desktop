use std::path::Path;

use anyhow::{Context as _, Result};
use reqwest::multipart::{Form, Part};
use serde_json::Value;

use super::{BackboardClient, routes};

impl BackboardClient {
    pub async fn upload_document(&self, assistant_id: &str, file_path: &Path) -> Result<Value> {
        let file_name = file_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("document")
            .to_string();
        let bytes = std::fs::read(file_path)
            .with_context(|| format!("reading document {}", file_path.display()))?;
        let form = Form::new().part("file", Part::bytes(bytes).file_name(file_name));
        self.json(
            self.client
                .post(self.url(&routes::assistant_documents(assistant_id)))
                .header("X-API-Key", self.api_key_header()?)
                .multipart(form),
        )
        .await
    }
}
