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

const MODEL_PAGE_SIZE: usize = 100;

fn list_models_query_params(
    provider: Option<&str>,
    model_type: Option<&str>,
    skip: usize,
    limit: usize,
) -> Vec<(&'static str, String)> {
    let mut params = Vec::new();
    if let Some(model_type) = model_type {
        params.push(("model_type", model_type.to_string()));
    }
    params.push(("skip", skip.to_string()));
    params.push(("limit", limit.to_string()));
    if let Some(provider) = provider {
        params.push(("provider", provider.to_string()));
    }
    params
}

impl BackboardClient {
    pub async fn list_models(
        &self,
        provider: Option<&str>,
        model_type: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Vec<BackboardModel>> {
        let max_records = limit.unwrap_or(u32::MAX) as usize;
        let mut skip = 0usize;
        let mut models = Vec::new();

        while models.len() < max_records {
            let current_limit = MODEL_PAGE_SIZE.min(max_records - models.len());
            let params = list_models_query_params(provider, model_type, skip, current_limit);

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

    pub async fn list_models_by_provider(
        &self,
        provider_name: &str,
        limit: Option<u32>,
    ) -> Result<Vec<BackboardModel>> {
        let max_records = limit.unwrap_or(u32::MAX) as usize;
        let mut skip = 0usize;
        let mut models = Vec::new();
        let route = routes::models_by_provider(provider_name);

        while models.len() < max_records {
            let current_limit = MODEL_PAGE_SIZE.min(max_records - models.len());
            let params = [
                ("skip", skip.to_string()),
                ("limit", current_limit.to_string()),
            ];

            let page: ListModelsResponse = self
                .json(
                    self.client
                        .get(self.url(&route))
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
