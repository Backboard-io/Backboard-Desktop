// Test preload. Disables process-lifetime runtime caches so mocked-Backboard
// tests are deterministic and never read or write the user's real files or
// leak module-level state across cases.
process.env.BACKBOARD_DISABLE_ASSISTANT_CACHE = "1";
process.env.BACKBOARD_DISABLE_RUNTIME_CACHES = "1";
