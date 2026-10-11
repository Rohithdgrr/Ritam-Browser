//! Input classification and scheme policy for the omnibox
//! (`contracts/ipc.md` §4).
//!
//! This is the *single* implementation of URL-vs-search. The runtime calls it
//! for omnibox input and the content-webview navigation handler calls
//! [`scheme_allows_navigation`] for every navigation, so the front door and
//! the back door can never disagree.
//!
//! Pure functions only: no I/O, no Tauri, no engine. Unit-tested as a table.

use url::Url;

/// Default search engine template; `{query}` is replaced by the
/// percent-encoded input. Kept here (not in settings) because v0.1 has no
/// settings surface yet — Devi's settings command surface is Phase 3.
pub const SEARCH_TEMPLATE: &str = "https://duckduckgo.com/?q={query}";

/// Schemes the omnibox understands by name. Anything else is treated as an
/// external protocol (ask the user first), except `host:port`-shaped input.
const KNOWN_SCHEMES: &[&str] = &[
    "http", "https", "about", "file", "javascript", "data", "vbscript", "blob", "mailto", "tel",
    "sms", "ftp", "ftps", "ws", "wss", "magnet", "bitcoin", "ethereum", "irc", "ircs",
];

/// Schemes that may never be reached from the omnibox, by contract.
/// `blob:` is deliberately absent: it is not reachable from user input
/// (it always originates inside a page) and the webview never navigates
/// top-level to it.
const BLOCKED_FROM_OMNIBOX: &[&str] = &["file", "javascript", "data", "vbscript"];

/// The outcome of classifying one piece of omnibox input.
///
/// `Navigate`/`Search` carry a fully-formed URL string that is safe to hand
/// to the webview. `External` carries the raw input: the runtime must ask
/// before launching anything (§4.3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NavTarget {
    Navigate { url: String },
    Search { query: String, url: String },
    External { url: String, scheme: String },
    Rejected { code: &'static str, message: String },
}

impl NavTarget {
    pub fn code(&self) -> Option<&'static str> {
        match self {
            NavTarget::Rejected { code, .. } => Some(code),
            _ => None,
        }
    }
}

/// Classify trimmed-or-untrimmed omnibox input per contract §4.1.
pub fn classify(input: &str) -> NavTarget {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return NavTarget::Rejected {
            code: "invalid_input",
            message: "empty input".to_string(),
        };
    }
    // Any whitespace means "a sentence", never a URL: search.
    if trimmed.chars().any(char::is_whitespace) {
        return search(trimmed);
    }
    // 1. explicit scheme?
    if let Some(scheme) = scheme_of(trimmed) {
        let scheme = scheme.to_ascii_lowercase();
        if KNOWN_SCHEMES.contains(&scheme.as_str()) {
            return classify_scheme(&scheme, trimmed);
        }
        // Unknown scheme: `myapp://open` and `C:/Users/x` are external
        // protocols, `example.com:8080` only *looks* like a scheme, and an
        // opaque body (`user:pass@host`) is not a protocol at all — normal
        // browsers search that, so rule 3 applies.
        if !looks_like_host_with_port(trimmed) {
            let body = &trimmed[scheme.len() + 1..];
            if body.starts_with("//") || body.starts_with('/') || body.starts_with('\\') {
                return NavTarget::External {
                    url: trimmed.to_string(),
                    scheme,
                };
            }
        }
    }
    // 2. bare host?
    if let Some(url) = bare_host_url(trimmed) {
        return NavTarget::Navigate { url };
    }
    // 3. otherwise: search.
    search(trimmed)
}

fn search(query: &str) -> NavTarget {
    NavTarget::Search {
        query: query.to_string(),
        url: SEARCH_TEMPLATE.replace("{query}", &percent_encode(query)),
    }
}

fn classify_scheme(scheme: &str, input: &str) -> NavTarget {
    match scheme {
        "http" | "https" => match Url::parse(input) {
            Ok(u) if u.host_str().is_some() => NavTarget::Navigate {
                url: u.to_string(),
            },
            Ok(_) => NavTarget::Rejected {
                code: "invalid_input",
                message: "URL has no host".to_string(),
            },
            Err(e) => NavTarget::Rejected {
                code: "invalid_input",
                message: format!("not a valid URL: {e}"),
            },
        },
        "about" => {
            if input.eq_ignore_ascii_case("about:blank") {
                NavTarget::Navigate {
                    url: "about:blank".to_string(),
                }
            } else {
                NavTarget::Rejected {
                    code: "unsupported_scheme",
                    message: format!("`{input}` is not supported; only about:blank is"),
                }
            }
        }
        _ if BLOCKED_FROM_OMNIBOX.contains(&scheme) => NavTarget::Rejected {
            code: "unsupported_scheme",
            message: format!("the `{scheme}:` scheme cannot be opened from the address bar"),
        },
        _ => NavTarget::External {
            url: input.to_string(),
            scheme: scheme.to_string(),
        },
    }
}

/// `scheme:` prefix only when it is well-formed and appears before any
/// path/query/fragment separator.
fn scheme_of(input: &str) -> Option<&str> {
    let colon = input.find(':')?;
    let head = &input[..colon];
    if head.is_empty() || head.len() > 32 {
        return None;
    }
    let mut chars = head.chars();
    let first = chars.next()?;
    if !first.is_ascii_alphabetic() {
        return None;
    }
    if !chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')) {
        return None;
    }
    // A scheme must terminate before any path/query/fragment marker.
    if input[colon + 1..]
        .chars()
        .next()
        .is_some_and(|c| matches!(c, '/' | '?' | '#'))
        && !head.contains('.')
    {
        // `//host/...` or `?q`/`#f` right after the colon still is a scheme.
        return Some(head);
    }
    Some(head)
}

/// `host:8080` / `host.example:8080` shape — the classic false positive for
/// scheme detection (`localhost:8080` must not become scheme `localhost`).
fn looks_like_host_with_port(input: &str) -> bool {
    let (host, port) = match authority(input).rsplit_once(':') {
        Some((h, p)) => (h, p),
        None => return false,
    };
    !host.is_empty() && port.chars().all(|c| c.is_ascii_digit()) && !port.is_empty()
}

/// Authority portion: everything before the first path/query/fragment marker,
/// so `host:3000/app` still reads as host + port (contract §4.1 rule 2).
fn authority(input: &str) -> &str {
    input.split(['/', '?', '#']).next().unwrap_or(input)
}

/// Turn bare-host input into an https URL; loopback/private hosts with an
/// explicit port get http (the common local-dev case), per contract §4.1.
fn bare_host_url(input: &str) -> Option<String> {
    let candidate = input.strip_prefix("//").unwrap_or(input);
    if !looks_like_a_host(candidate) {
        return None;
    }
    let scheme = if has_port(candidate) && is_loopback_or_private(host_part(candidate)) {
        "http"
    } else {
        "https"
    };
    let url = Url::parse(&format!("{scheme}://{candidate}")).ok()?;
    url.host_str()?;
    Some(url.to_string())
}

fn looks_like_a_host(input: &str) -> bool {
    if input.is_empty() || input.contains('@') {
        // userinfo (`user:pass@host`) is out of v0.1 scope: search instead of
        // guessing at credentials.
        return false;
    }
    if input == "localhost" || input.starts_with("localhost:") {
        return true;
    }
    if is_ipv4(host_part(input)) {
        return true;
    }
    // A dot is the practical signal ("example.com", "en.wikipedia.org");
    // a single word is a search, matching normal browser expectations.
    host_part(input).contains('.')
}

fn host_part(input: &str) -> &str {
    let no_path = authority(input);
    let no_port = match no_path.rsplit_once(':') {
        Some((h, p)) if !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) => h,
        _ => no_path,
    };
    no_port.strip_prefix('[').unwrap_or(no_port).split(']').next().unwrap_or(no_port)
}

fn has_port(input: &str) -> bool {
    matches!(authority(input).rsplit_once(':'), Some((_, p)) if !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

fn is_ipv4(host: &str) -> bool {
    let parts: Vec<&str> = host.split('.').collect();
    parts.len() == 4
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.len() <= 3 && p.chars().all(|c| c.is_ascii_digit()))
}

/// Loopback or RFC1918/link-local host (contract §4.1 http exception).
pub fn is_loopback_or_private(host: &str) -> bool {
    let h = host.trim_start_matches('[').trim_end_matches(']');
    if h == "localhost" || h.ends_with(".localhost") || h == "::1" || h == "0.0.0.0" {
        return true;
    }
    let octets: Vec<Option<u8>> = h.split('.').map(|p| p.parse::<u8>().ok()).collect();
    if octets.len() != 4 || octets.iter().any(|o| o.is_none()) {
        return false;
    }
    let o: Vec<u8> = octets.into_iter().map(|o| o.unwrap()).collect();
    o[0] == 127 || o[0] == 10 || (o[0] == 192 && o[1] == 168) || (o[0] == 172 && (16..=31).contains(&o[1]))
}

/// The policy the webview navigation handler enforces on *every* navigation
/// (contract §4.2), including redirects and in-page link clicks.
pub fn scheme_allows_navigation(url: &Url) -> bool {
    match url.scheme() {
        "http" | "https" => url.host_str().is_some(),
        "about" => url.as_str().eq_ignore_ascii_case("about:blank"),
        // The chrome/new-tab page is served from the app origin; only that
        // one internal page is allowed inside a content tab.
        "tauri" | "asset" => true,
        _ => false,
    }
}

/// Percent-encode a search query (RFC 3986 unreserved set kept as-is).
pub fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nav(input: &str) -> String {
        match classify(input) {
            NavTarget::Navigate { url } => format!("nav:{url}"),
            NavTarget::Search { url, .. } => format!("search:{url}"),
            NavTarget::External { scheme, .. } => format!("external:{scheme}"),
            NavTarget::Rejected { code, .. } => format!("rejected:{code}"),
        }
    }

    #[test]
    fn classification_table() {
        let cases = [
            // (input, expected)
            ("example.com", "nav:https://example.com/"),
            ("https://example.com/", "nav:https://example.com/"),
            ("http://example.com/a?b=1", "nav:http://example.com/a?b=1"),
            ("en.wikipedia.org/wiki/Rust", "nav:https://en.wikipedia.org/wiki/Rust"),
            ("localhost:8080", "nav:http://localhost:8080/"),
            ("127.0.0.1:3000/app", "nav:http://127.0.0.1:3000/app"),
            ("192.168.1.5:8080", "nav:http://192.168.1.5:8080/"),
            ("10.0.0.1", "nav:https://10.0.0.1/"),
            ("about:blank", "nav:about:blank"),
            ("rust borrow checker", "search:https://duckduckgo.com/?q=rust%20borrow%20checker"),
            ("what is a monad?", "search:https://duckduckgo.com/?q=what%20is%20a%20monad%3F"),
            ("rust", "search:https://duckduckgo.com/?q=rust"),
            ("mailto:someone@example.com", "external:mailto"),
            ("tel:+15551234567", "external:tel"),
            ("myapp://open", "external:myapp"),
            ("file:///C:/secret.txt", "rejected:unsupported_scheme"),
            ("javascript:alert(1)", "rejected:unsupported_scheme"),
            ("data:text/html,<script>1</script>", "rejected:unsupported_scheme"),
            ("about:config", "rejected:unsupported_scheme"),
            ("", "rejected:invalid_input"),
            ("   ", "rejected:invalid_input"),
            ("C:/Users/rohit", "external:c"),
        ];
        for (input, expected) in cases {
            assert_eq!(nav(input), expected, "input: {input:?}");
        }
    }

    #[test]
    fn trimming_is_applied() {
        assert_eq!(
            nav("  example.com  "),
            "nav:https://example.com/"
        );
    }

    #[test]
    fn single_words_and_emails_are_searches() {
        assert!(nav("rustlang").starts_with("search:"));
        assert!(nav("someone@example.com").starts_with("search:"));
        assert!(nav("user:pass@host").starts_with("search:"));
    }

    #[test]
    fn query_encoding_keeps_unreserved() {
        assert_eq!(percent_encode("a b&c=d?e/f"), "a%20b%26c%3Dd%3Fe%2Ff");
        assert_eq!(percent_encode("naïve"), "na%C3%AFve");
    }

    #[test]
    fn navigation_policy_matches_contract() {
        // An input that cannot even be parsed (e.g. `https://` with no host)
        // can never be allowed to navigate.
        let allowed =
            |u: &str| Url::parse(u).map(|u| scheme_allows_navigation(&u)).unwrap_or(false);
        assert!(allowed("https://example.com/"));
        assert!(allowed("about:blank"));
        assert!(!allowed("about:config"));
        assert!(!allowed("file:///C:/x"));
        assert!(!allowed("javascript:alert(1)"));
        assert!(!allowed("https://"));
    }

    #[test]
    fn loopback_and_private_detection() {
        assert!(is_loopback_or_private("localhost"));
        assert!(is_loopback_or_private("127.0.0.1"));
        assert!(is_loopback_or_private("10.1.2.3"));
        assert!(is_loopback_or_private("192.168.0.10"));
        assert!(is_loopback_or_private("172.16.9.9"));
        assert!(!is_loopback_or_private("172.32.0.1"));
        assert!(!is_loopback_or_private("example.com"));
        assert!(!is_loopback_or_private("8.8.8.8"));
    }
}
