use std::pin::Pin;

use anyhow::Result;
use futures::Stream;
use serde_json::Value;

use super::{BackboardClient, SubmitToolOutputsRequest, routes};
use crate::endpoints::stream::retrying_sse_json_stream;

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
        let client = self.client.clone();
        let url = self.url(&routes::run_submit_tool_outputs_stream(thread_id, run_id));
        let headers = self.json_headers()?;
        let body = serde_json::to_vec(&request)?;
        Ok(retrying_sse_json_stream(move || {
            client
                .post(url.clone())
                .headers(headers.clone())
                .body(body.clone())
        }))
    }
}
