//! Advisory Rust policy kernel for the existing Node executor. Never executes host operations.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub name: String,
    pub id: String,
    #[serde(default)]
    pub labels: BTreeMap<String, String>,
}
#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct Probe {
    pub method: String,
    pub url: String,
    pub target: Option<Target>,
}
#[derive(Serialize, Debug)]
pub struct Decision {
    pub candidate_allowed: bool,
    pub enforcement_allowed: bool,
    pub reason: &'static str,
}
const OWNER: &str = "com.softload.panel.managed";
const SLUG: &str = "com.softload.panel.slug";
fn decide(allow: bool, reason: &'static str) -> Decision {
    Decision {
        candidate_allowed: allow,
        enforcement_allowed: false,
        reason,
    }
}
fn valid_slug(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 40
        && !v.starts_with('-')
        && !v.ends_with('-')
        && !v.contains("--")
        && v.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
fn owned(target: &Target, requested: &str) -> bool {
    let name = target.name.strip_prefix('/').unwrap_or(&target.name);
    if name != requested && target.id != requested {
        return false;
    }
    let Some(rest) = name.strip_prefix("softload-") else {
        return false;
    };
    let Some((kind, suffix)) = rest.split_once('-') else {
        return false;
    };
    if !matches!(kind, "app" | "candidate" | "backup") || !valid_slug(suffix) {
        return false;
    }
    if target.labels.get(OWNER).map(String::as_str) != Some("true")
        || target.labels.get(SLUG).map(String::as_str) != Some(suffix)
    {
        return false;
    }
    if kind == "candidate"
        && target
            .labels
            .get("com.softload.panel.release-role")
            .map(String::as_str)
            != Some("candidate")
    {
        return false;
    }
    true
}
/// Candidate authorization based on only the read-only Node policy subset.
/// Caller-supplied target is for fixtures and must NEVER be trusted for enforcement.
pub fn evaluate(p: &Probe) -> Decision {
    if p.method != "GET" {
        return decide(false, "mutations-disabled-shadow-mode");
    }
    if matches!(
        p.url.as_str(),
        "/v1.45/containers/json?all=1&view=inventory"
            | "/v1.45/containers/json?view=inventory&all=1"
    ) {
        return decide(true, "inventory-projection");
    }
    if p.url == "/v1.45/images/json" {
        return decide(true, "image-list");
    }
    if p.url == "/v1.45/system/df?type=images" {
        return decide(true, "image-df");
    }
    let Some(path) = p.url.strip_prefix("/v1.45/containers/") else {
        return decide(false, "not-allowlisted");
    };
    let Some(id) = path.strip_suffix("/json") else {
        return decide(false, "not-allowlisted");
    };
    if id.is_empty()
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return decide(false, "invalid-target");
    }
    let Some(ref target) = p.target else {
        return decide(false, "unverified-container");
    };
    decide(owned(target, id), "managed-container-read")
}
#[cfg(test)]
mod tests {
    use super::*;
    fn req(method: &str, url: &str) -> Probe {
        Probe {
            method: method.into(),
            url: url.into(),
            target: None,
        }
    }
    #[test]
    fn shadow_mode_never_enforces() {
        let d = evaluate(&req("GET", "/v1.45/containers/json?all=1&view=inventory"));
        assert!(d.candidate_allowed);
        assert!(!d.enforcement_allowed);
    }
    #[test]
    fn mutations_and_unsafe_routes_denied() {
        for (method, url) in [
            ("POST", "/v1.45/containers/softload-app-a/restart"),
            ("DELETE", "/v1.45/containers/softload-app-a?force=0&v=0"),
            ("POST", "/v1.45/containers/create?name=softload-app-a"),
            ("GET", "/v1.45/containers/softload-caddy/json"),
            ("GET", "/v1.45/volumes"),
            ("GET", "/v1.45/containers/json?all=0&view=inventory"),
        ] {
            assert!(
                !evaluate(&req(method, url)).candidate_allowed,
                "{method} {url}"
            );
        }
    }
    #[test]
    fn managed_container_requires_both_labels() {
        let mut p = req("GET", "/v1.45/containers/softload-app-demo/json");
        p.target = Some(Target {
            name: "/softload-app-demo".into(),
            id: "abc".into(),
            labels: BTreeMap::from([(OWNER.into(), "true".into()), (SLUG.into(), "demo".into())]),
        });
        assert!(evaluate(&p).candidate_allowed);
        p.target.as_mut().unwrap().labels.remove(OWNER);
        assert!(!evaluate(&p).candidate_allowed);
    }
    #[test]
    fn fake_metadata_does_not_grant_other_container_access() {
        let mut p = req("GET", "/v1.45/containers/softload-app-demo/json");
        p.target = Some(Target {
            name: "/softload-app-other".into(),
            id: "abcd".into(),
            labels: BTreeMap::from([(OWNER.into(), "true".into()), (SLUG.into(), "other".into())]),
        });
        assert!(!evaluate(&p).candidate_allowed);
    }
}
