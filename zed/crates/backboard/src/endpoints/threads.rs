use std::pin::Pin;

use anyhow::Result;
use futures::Stream;
use serde_json::{Value, json};

use super::{BackboardClient, SendMessageRequest, routes};
use crate::endpoints::stream::{message_form, sse_json_stream};

impl BackboardClient {
    pub async fn create_thread(&self, assistant_id: &str) -> Result<Value> {
        self.json(
            self.client
                .post(self.url(&routes::assistant_threads(assistant_id)))
                .headers(self.json_headers()?)
                .body(serde_json::to_vec(&json!({}))?),
        )
        .await
    }

    pub async fn get_thread(&self, thread_id: &str) -> Result<Value> {
        self.json(
            self.client
                .get(self.url(&routes::thread(thread_id)))
                .headers(self.json_headers()?),
        )
        .await
    }

    pub async fn list_threads(&self, assistant_id: Option<&str>) -> Result<Vec<Value>> {
        let path =
            assistant_id.map_or_else(|| routes::THREADS.to_string(), routes::assistant_threads);
        self.json(
            self.client
                .get(self.url(&path))
                .headers(self.json_headers()?),
        )
        .await
    }

    pub async fn send_message(
        &self,
        thread_id: &str,
        request: SendMessageRequest,
    ) -> Result<Value> {
        self.json(
            self.client
                .post(self.url(&routes::thread_messages(thread_id)))
                .header("X-API-Key", self.api_key_header()?)
                .form(&message_form(request, false)?),
        )
        .await
    }

    pub async fn send_message_stream(
        &self,
        thread_id: &str,
        request: SendMessageRequest,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<Value>> + Send>>> {
        let response = self
            .client
            .post(self.url(&routes::thread_messages(thread_id)))
            .header("X-API-Key", self.api_key_header()?)
            .form(&message_form(request, true)?)
            .send()
            .await?;
        let response = self.ensure_success(response).await?;
        Ok(Box::pin(sse_json_stream(response)))
    }

    pub async fn cancel_run(&self, thread_id: &str, run_id: &str) -> Result<bool> {
        let response = self
            .client
            .post(self.url(&routes::run_cancel(thread_id, run_id)))
            .headers(self.json_headers()?)
            .send()
            .await?;
        Ok(response.status().is_success())
    }
}
