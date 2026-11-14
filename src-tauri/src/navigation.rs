//! URL validation for the IPC boundary. The frontend normalizes input for UX;
//! this module is the security boundary that rejects dangerous schemes before
//! they reach the webview or the database.

use crate::error::AppError;

pub const HOME_URL: &str = "govind://home";

/// Validate a URL for *navigation*. Allows http(s), the internal home page, and about:blank.
pub fn validate_navigation_url(raw: &str) -> Result<String, AppError> {
    let input = raw.trim();
    if input.is_empty() || input.len() > 2048 {
        return Err(AppError::InvalidInput("url is empty or too long".into()));
    }
    if input == HOME_URL {
        return Ok(HOME_URL.to_string());
    }
    if input.eq_ignore_ascii_case("about:blank") {
        return Ok("about:blank".to_string());
    }
    validate_http_url(input).map(str::to_string)
}

/// Validate a URL for *persistence* (bookmarks, history). Same allowlist, govind:// included.
pub fn validate_saved_url(raw: &str) -> Result<String, AppError> {
    let input = raw.trim();
    if input.is_empty() || input.len() > 2048 {
        return Err(AppError::InvalidInput("url is empty or too long".into()));
    }
    if input == HOME_URL || input.starts_with("govind://") {
        return Ok(input.to_string());
    }
    validate_http_url(input).map(str::to_string)
}

fn validate_http_url(input: &str) -> Result<&str, AppError> {
    let lower = input.to_ascii_lowercase();
    let rest = if let Some(r) = lower.strip_prefix("https://") {
        &input[input.len() - r.len()..]
    } else if let Some(r) = lower.strip_prefix("http://") {
        &input[input.len() - r.len()..]
    } else {
        return Err(AppError::InvalidInput(
            "only http://, https:// and govind:// URLs are allowed".into(),
        ));
    };

    // Authority section runs until the first path/query/fragment delimiter.
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    // Strip userinfo, then port — what remains must be a plausible host.
    let host = authority.rsplit('@').next().unwrap_or("");
    let host = host.split(':').next().unwrap_or("").trim_matches(['[', ']']);
    if host.is_empty() || host.contains(char::is_whitespace) || host.contains('\0') {
        return Err(AppError::InvalidInput("url has no valid host".into()));
    }
    Ok(input)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_http_https_home() {
        assert!(validate_navigation_url("https://example.com").is_ok());
        assert!(validate_navigation_url("http://localhost:3000/dev").is_ok());
        assert!(validate_navigation_url("govind://home").is_ok());
        assert!(validate_navigation_url("about:blank").is_ok());
    }

    #[test]
    fn rejects_dangerous_schemes() {
        assert!(validate_navigation_url("javascript:alert(1)").is_err());
        assert!(validate_navigation_url("file:///etc/passwd").is_err());
        assert!(validate_navigation_url("data:text/html,<h1>x</h1>").is_err());
        assert!(validate_navigation_url("vbscript:msgbox(1)").is_err());
    }

    #[test]
    fn rejects_missing_host() {
        assert!(validate_navigation_url("https://").is_err());
        assert!(validate_navigation_url("https:///path").is_err());
        assert!(validate_navigation_url("http://").is_err());
    }

    #[test]
    fn saved_urls_allow_govind_assets() {
        assert!(validate_saved_url("govind://assets/govind-welcome.txt").is_ok());
        assert!(validate_saved_url("https://example.com").is_ok());
        assert!(validate_saved_url("javascript:x").is_err());
    }

    #[test]
    fn rejects_oversized_urls() {
        let big = format!("https://example.com/{}", "a".repeat(3000));
        assert!(validate_navigation_url(&big).is_err());
    }
}
