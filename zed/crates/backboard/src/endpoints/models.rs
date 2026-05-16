use anyhow::Result;
use serde_json::Value;

use super::{BackboardClient, BackboardModel, routes};

impl BackboardClient {
    pub async fn list_models(
        &self,
        provider: Option<&str>,
        model_type: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Vec<BackboardModel>> {
        let mut params = vec![
            ("model_type", model_type.unwrap_or("llm").to_string()),
            ("limit", limit.unwrap_or(15000).to_string()),
        ];
        if let Some(provider) = provider {
            params.push(("provider", provider.to_string()));
        }
        let data: Value = self
            .json(
                self.client
                    .get(self.url(routes::MODELS))
                    .headers(self.json_headers()?)
                    .query(&params),
            )
            .await?;
        let values = data
            .get("models")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        values
            .into_iter()
            .map(serde_json::from_value)
            .collect::<serde_json::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub async fn list_providers(&self) -> Result<Vec<String>> {
        let data: Value = self
            .json(
                self.client
                    .get(self.url(routes::MODEL_PROVIDERS))
                    .headers(self.json_headers()?),
            )
            .await?;
        Ok(data
            .get("providers")
            .and_then(Value::as_array)
            .map(|providers| {
                providers
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default())
    }
}
