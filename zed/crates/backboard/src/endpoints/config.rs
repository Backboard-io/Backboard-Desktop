use std::{collections::HashMap, path::PathBuf};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt as _;

use anyhow::{Context as _, Result};
use serde::{Deserialize, Serialize};

pub const PROD_API_URL: &str = "https://app.backboard.io/api";
pub const DEV_API_URL: &str = "https://dev.app.backboard.io/api";
pub const LOCAL_API_URL: &str = "http://localhost:8000";

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct BackboardConfig {
    #[serde(default = "default_env")]
    pub env: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub api_url: Option<String>,
    #[serde(default)]
    pub default_provider: Option<String>,
    #[serde(default)]
    pub default_model: Option<String>,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub assistant_id: Option<String>,
    #[serde(default)]
    pub env_keys: HashMap<String, String>,
}

fn default_env() -> String {
    "prod".into()
}

impl BackboardConfig {
    pub fn load() -> Result<Self> {
        let path = config_path()?;
        let contents = std::fs::read_to_string(&path)
            .with_context(|| format!("reading Backboard config at {}", path.display()))?;
        let mut config: Self = serde_json::from_str(&contents)
            .with_context(|| format!("parsing Backboard config at {}", path.display()))?;
        config.promote_legacy_default_env();
        Ok(config)
    }

    pub fn load_or_default() -> Self {
        Self::load().unwrap_or_default()
    }

    pub fn save_api_key_for_current_env(api_key: impl Into<String>) -> Result<Self> {
        let mut config = Self::load_or_default();
        config.promote_legacy_default_env();
        let api_key = api_key.into().trim().to_string();
        let env = config.env.to_lowercase();

        config.env_keys.insert(env, api_key.clone());
        config.api_key = Some(api_key);
        config.save()?;

        Ok(config)
    }

    pub fn clear_api_key_for_current_env() -> Result<Self> {
        let mut config = Self::load_or_default();
        config.promote_legacy_default_env();
        let env = config.env.to_lowercase();

        config.api_key = None;
        config.env_keys.remove(&env);
        config.save()?;

        Ok(config)
    }

    pub fn save_model_selection(
        provider: impl Into<String>,
        model: impl Into<String>,
    ) -> Result<Self> {
        let mut config = Self::load_or_default();
        config.default_provider = Some(provider.into());
        config.default_model = Some(model.into());
        config.save()?;
        Ok(config)
    }

    pub fn save_session(assistant_id: Option<String>, thread_id: Option<String>) -> Result<Self> {
        let mut config = Self::load_or_default();
        if assistant_id.is_some() {
            config.assistant_id = assistant_id;
        }
        if thread_id.is_some() {
            config.thread_id = thread_id;
        }
        config.save()?;
        Ok(config)
    }

    pub fn save(&self) -> Result<()> {
        let path = config_path()?;
        let dir = path
            .parent()
            .context("Backboard config path does not have a parent directory")?;

        std::fs::create_dir_all(dir)
            .with_context(|| format!("creating Backboard config dir at {}", dir.display()))?;
        std::fs::write(&path, serde_json::to_vec_pretty(self)?)
            .with_context(|| format!("writing Backboard config at {}", path.display()))?;

        #[cfg(unix)]
        {
            let permissions = std::fs::Permissions::from_mode(0o600);
            let _ = std::fs::set_permissions(&path, permissions);
        }

        Ok(())
    }

    pub fn base_url(&self) -> String {
        self.api_url
            .clone()
            .unwrap_or_else(|| match self.env.to_lowercase().as_str() {
                "prod" | "production" => PROD_API_URL.into(),
                "local" => LOCAL_API_URL.into(),
                _ => DEV_API_URL.into(),
            })
            .trim_end_matches('/')
            .to_string()
    }

    pub fn api_key(&self) -> Option<String> {
        self.api_key
            .as_deref()
            .and_then(non_empty_api_key)
            .or_else(|| {
                self.env_keys
                    .get(&self.env.to_lowercase())
                    .and_then(|key| non_empty_api_key(key))
            })
            .or_else(|| {
                std::env::var("BACKBOARD_API_KEY")
                    .ok()
                    .and_then(|key| non_empty_api_key(&key))
            })
    }

    fn promote_legacy_default_env(&mut self) {
        if self.api_url.is_none() && self.env.eq_ignore_ascii_case("dev") {
            if let Some(api_key) = self.env_keys.get("dev").cloned() {
                self.env_keys.entry("prod".to_string()).or_insert(api_key);
            }
            self.env = default_env();
        }
    }
}

fn non_empty_api_key(key: &str) -> Option<String> {
    let key = key.trim();
    (!key.is_empty()).then(|| key.to_string())
}

impl Default for BackboardConfig {
    fn default() -> Self {
        Self {
            env: default_env(),
            api_key: None,
            api_url: None,
            default_provider: None,
            default_model: None,
            thread_id: None,
            assistant_id: None,
            env_keys: HashMap::default(),
        }
    }
}

pub fn config_path() -> Result<PathBuf> {
    let home = std::env::var_os("HOME").context("HOME is not set")?;
    Ok(PathBuf::from(home).join(".backboard").join("config.json"))
}
