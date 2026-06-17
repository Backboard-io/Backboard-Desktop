use anyhow::Result;
use serde_json::{Value, json};

use super::{BackboardClient, routes};

impl BackboardClient {
    pub async fn list_memories(&self, assistant_id: &str) -> Result<Vec<Value>> {
        self.json(
            self.client
                .get(self.url(&routes::assistant_memories(assistant_id)))
                .headers(self.json_headers()?),
        )
        .await
    }

    pub async fn add_memory(
        &self,
        assistant_id: &str,
        content: impl Into<String>,
        tags: Vec<String>,
    ) -> Result<Value> {
        self.json(
            self.client
                .post(self.url(&routes::assistant_memories(assistant_id)))
                .headers(self.json_headers()?)
                .body(serde_json::to_vec(
                    &json!({ "content": content.into(), "tags": tags }),
                )?),
        )
        .await
    }
}
