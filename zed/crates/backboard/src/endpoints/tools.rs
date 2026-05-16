use std::pin::Pin;

use anyhow::Result;
use futures::Stream;
use serde_json::Value;

use super::{BackboardClient, SubmitToolOutputsRequest, routes};
use crate::endpoints::stream::sse_json_stream;

impl BackboardClient {
    pub async fn submit_tool_outputs(
        &self,
        thread_id: &str,
        run_id: &str,
        request: SubmitToolOutputsRequest,
    ) -> Result<Value> {
        self.json(
            self.client
                .post(self.url(&routes::run_submit_tool_outputs(thread_id, run_id)))
                .headers(self.json_headers()?)
                .body(serde_json::to_vec(&request)?),
        )
        .await
    }

    pub async fn submit_tool_outputs_stream(
        &self,
        thread_id: &str,
        run_id: &str,
        request: SubmitToolOutputsRequest,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<Value>> + Send>>> {
        let response = self
            .client
            .post(self.url(&routes::run_submit_tool_outputs_stream(thread_id, run_id)))
            .headers(self.json_headers()?)
            .body(serde_json::to_vec(&request)?)
            .send()
            .await?;
        let response = self.ensure_success(response).await?;
        Ok(Box::pin(sse_json_stream(response)))
    }
}
