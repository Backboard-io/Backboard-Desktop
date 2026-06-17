use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Default, Serialize)]
pub struct CreateAssistantRequest {
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_fact_extraction_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_update_memory_prompt: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct UpdateAssistantRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<Value>>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SendMessageRequest {
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default = "default_memory")]
    pub memory: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<Value>>,
    #[serde(default = "default_web_search")]
    pub web_search: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_calls: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
}

fn default_memory() -> String {
    "Auto".into()
}

fn default_web_search() -> String {
    "off".into()
}

impl Default for SendMessageRequest {
    fn default() -> Self {
        Self {
            content: String::new(),
            provider: None,
            model: None,
            memory: default_memory(),
            thinking: None,
            tools: None,
            web_search: default_web_search(),
            mcp_calls: None,
            max_tokens: None,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct SubmitToolOutputsRequest {
    pub tool_outputs: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<Value>>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct RecentUsageQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    pub page_size: u32,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct BackboardModel {
    #[serde(default)]
    pub provider: String,
    #[serde(default, alias = "id", alias = "model_id")]
    pub name: String,
    #[serde(default)]
    pub model_type: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default, alias = "context_window", alias = "max_context_tokens")]
    pub context_limit: Option<u64>,
    #[serde(default)]
    pub supports_thinking: Option<bool>,
    #[serde(default)]
    pub input_cost_per_1m_tokens: Option<f64>,
    #[serde(default)]
    pub output_cost_per_1m_tokens: Option<f64>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn backboard_model_accepts_id_alias_for_name() {
        let model: BackboardModel = serde_json::from_value(json!({
            "provider": "deepseek",
            "id": "deepseek-chat",
            "context_window": 64000,
        }))
        .unwrap();

        assert_eq!(model.provider, "deepseek");
        assert_eq!(model.name, "deepseek-chat");
        assert_eq!(model.context_limit, Some(64000));
    }
}
