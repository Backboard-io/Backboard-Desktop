mod assistants;
mod billing;
mod client;
mod config;
mod documents;
mod memories;
mod models;
mod routes;
mod stream;
mod threads;
mod tools;
mod types;

pub use client::{BackboardClient, BackboardError};
pub use config::{BackboardConfig, DEV_API_URL, LOCAL_API_URL, PROD_API_URL, config_path};
pub use types::{
    BackboardModel, CreateAssistantRequest, RecentUsageQuery, SendMessageRequest,
    SubmitToolOutputsRequest, UpdateAssistantRequest,
};
