// Every outbound link the site uses, in one place.
export const GITHUB_ORG = "https://github.com/Backboard-io";
export const DOCS = "https://docs.backboard.io/";

// Backboard-Desktop is still a private repo (404 for visitors), so its button
// points at the org until the repo goes public. Flip this to true then.
const DESKTOP_REPO_PUBLIC = false;
export const DESKTOP_REPO = DESKTOP_REPO_PUBLIC
  ? "https://github.com/Backboard-io/Backboard-Desktop"
  : GITHUB_ORG;

export const CLI_REPO_URL = "https://github.com/Backboard-io/Backboard-R-CLI";
export const NASH_REPO = "https://github.com/Backboard-io/Nash";
export const NASH_URL = "https://hellonash.ai";

/** The site-wide "GitHub" link (header, footers). */
export const REPO = GITHUB_ORG;
