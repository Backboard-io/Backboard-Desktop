use anyhow::Result;
use serde::Deserialize;
use serde_json::Value;

use super::{BackboardClient, BackboardModel, routes};

#[derive(Debug, Default, Deserialize)]
struct ListModelsResponse {
    #[serde(default)]
    models: Vec<BackboardModel>,
    #[serde(default)]
    total: Option<u64>,
}

impl BackboardClient {
    pub async fn list_models(
        &self,
        provider: Option<&str>,
        model_type: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Vec<BackboardModel>> {
        let max_records = limit.unwrap_or(u32::MAX) as usize;
        let page_size = 100usize;
        let mut skip = 0usize;
        let mut models = Vec::new();

        while models.len() < max_records {
            let current_limit = page_size.min(max_records - models.len());
            let mut params = vec![
                ("model_type", model_type.unwrap_or("llm").to_string()),
                ("skip", skip.to_string()),
                ("limit", current_limit.to_string()),
            ];
            if let Some(provider) = provider {
                params.push(("provider", provider.to_string()));
            }

            let page: ListModelsResponse = self
                .json(
                    self.client
                        .get(self.url(routes::MODELS))
                        .headers(self.json_headers()?)
                        .query(&params),
                )
                .await?;
            let received = page.models.len();
            models.extend(page.models);

            if received == 0 {
                break;
            }
            skip += received;
            if let Some(total) = page.total {
                if skip as u64 >= total {
                    break;
                }
            }
        }

        Ok(models)
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
