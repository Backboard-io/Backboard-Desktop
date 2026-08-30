use anyhow::Result;
use serde_json::Value;

use super::{BackboardClient, CreateAssistantRequest, UpdateAssistantRequest, routes};

impl BackboardClient {
    pub async fn create_assistant(&self, request: CreateAssistantRequest) -> Result<Value> {
        self.json(
            self.client
                .post(self.url(routes::ASSISTANTS))
                .headers(self.json_headers()?)
                .body(serde_json::to_vec(&request)?),
        )
        .await
    }

    pub async fn update_assistant(
        &self,
        assistant_id: &str,
        request: UpdateAssistantRequest,
    ) -> Result<Value> {
        self.json(
            self.client
                .put(self.url(&routes::assistant(assistant_id)))
                .headers(self.json_headers()?)
                .body(serde_json::to_vec(&request)?),
        )
        .await
    }

    pub async fn get_assistant(&self, assistant_id: &str) -> Result<Value> {
        self.json(
            self.client
                .get(self.url(&routes::assistant(assistant_id)))
                .headers(self.json_headers()?),
        )
        .await
    }

    pub async fn list_assistants(&self) -> Result<Vec<Value>> {
        self.json(
            self.client
                .get(self.url(routes::ASSISTANTS))
                .headers(self.json_headers()?),
        )
        .await
    }
}
