use anyhow::Result;
use serde_json::Value;

use super::{BackboardClient, RecentUsageQuery, routes};
use crate::endpoints::client::parse_json_response;

impl BackboardClient {
    pub async fn get_recent_usage(&self, query: RecentUsageQuery) -> Result<Option<Value>> {
        let page_size = query.page_size.clamp(1, 100).to_string();
        let mut params = vec![("page", "1".to_string()), ("page_size", page_size)];
        if let Some(model_name) = query.model_name {
            params.push(("model_name", model_name));
        }
        if let Some(input_tokens) = query.input_tokens {
            params.push(("input_tokens", input_tokens.to_string()));
        }
        if let Some(output_tokens) = query.output_tokens {
            params.push(("output_tokens", output_tokens.to_string()));
        }
        let response = self
            .client
            .get(self.url(routes::RECENT_USAGE))
            .headers(self.json_headers()?)
            .query(&params)
            .send()
            .await?;
        if response.status().is_success() {
            Ok(Some(parse_json_response(response).await?))
        } else {
            Ok(None)
        }
    }
}
