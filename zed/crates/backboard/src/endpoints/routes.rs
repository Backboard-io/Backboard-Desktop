pub const ASSISTANTS: &str = "/assistants";
pub const THREADS: &str = "/threads";
pub const MODELS: &str = "/models";
pub const MODEL_PROVIDERS: &str = "/models/providers";
pub const RECENT_USAGE: &str = "/billing/usage/recent";

pub fn assistant(assistant_id: &str) -> String {
    format!("/assistants/{assistant_id}")
}

pub fn assistant_threads(assistant_id: &str) -> String {
    format!("/assistants/{assistant_id}/threads")
}

pub fn assistant_documents(assistant_id: &str) -> String {
    format!("/assistants/{assistant_id}/documents")
}

pub fn assistant_memories(assistant_id: &str) -> String {
    format!("/assistants/{assistant_id}/memories")
}

pub fn thread(thread_id: &str) -> String {
    format!("/threads/{thread_id}")
}

pub fn thread_messages(thread_id: &str) -> String {
    format!("/threads/{thread_id}/messages")
}

pub fn run_submit_tool_outputs(thread_id: &str, run_id: &str) -> String {
    format!("/threads/{thread_id}/runs/{run_id}/submit-tool-outputs")
}

pub fn run_submit_tool_outputs_stream(thread_id: &str, run_id: &str) -> String {
    format!("/threads/{thread_id}/runs/{run_id}/submit-tool-outputs?stream=true")
}

pub fn run_cancel(thread_id: &str, run_id: &str) -> String {
    format!("/threads/{thread_id}/runs/{run_id}/cancel")
}
