#![forbid(unsafe_code)]

use std::io::{self, Read};

const MAX_INPUT: usize = 65_536;
const MAX_SAFE: u64 = 9_007_199_254_740_991;

fn number(value: &str) -> Option<u64> {
    if value.is_empty() || !value.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    value.parse::<u64>().ok().filter(|value| *value <= MAX_SAFE)
}

fn memory(input: &str) -> Option<String> {
    let mut fields = input.splitn(3, '\n');
    let total = number(fields.next()?)?;
    let free = number(fields.next()?)?;
    let meminfo = fields.next()?;
    let available = meminfo.lines().find_map(|line| {
        let mut fields = line.strip_prefix("MemAvailable:")?.split_whitespace();
        let value = number(fields.next()?)?;
        if fields.next()? != "kB" || fields.next().is_some() {
            return None;
        }
        Some(value)
    });
    let measured = available
        .and_then(|kb| kb.checked_mul(1024))
        .filter(|bytes| *bytes <= total);
    let (available, source) = match measured {
        Some(bytes) => (bytes, "memavailable"),
        None => (free.min(total), "os-freemem"),
    };
    Some(format!(
        "{{\"total\":{total},\"used\":{},\"available\":{available},\"source\":\"{source}\"}}",
        total - available
    ))
}

fn host(value: &str) -> bool {
    (4..=253).contains(&value.len())
        && value
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'.' || c == b'-')
}

fn slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 40
        && value.split('-').all(|part| {
            !part.is_empty() && part.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        })
}

fn route(input: &str) -> Option<String> {
    let mut lines = input.lines();
    let requested = lines.next()?;
    if !host(requested) {
        return Some("null".to_owned());
    }
    let rows: Vec<_> = lines.collect();
    if rows.len() > 256 {
        return None;
    }
    for row in rows {
        let mut fields = row.split('\t');
        let registered = fields.next()?;
        let name = fields.next()?;
        let port = fields.next()?;
        if fields.next().is_some() {
            return None;
        }
        if registered != requested {
            continue;
        }
        let valid_port = number(port).filter(|value| (1024..=65535).contains(value));
        return Some(match valid_port {
            Some(port) if slug(name) => format!("{{\"slug\":\"{name}\",\"port\":{port}}}"),
            _ => "null".to_owned(),
        });
    }
    Some("null".to_owned())
}

fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 1 {
        std::process::exit(2);
    }
    if args[0] == "version" {
        println!("{{\"protocol\":1,\"engine\":\"rust\",\"version\":\"0.1.0\"}}");
        return;
    }
    if !matches!(args[0].as_str(), "memory" | "route") {
        std::process::exit(2);
    }
    let mut input = String::new();
    if io::stdin()
        .take((MAX_INPUT + 1) as u64)
        .read_to_string(&mut input)
        .is_err()
        || input.len() > MAX_INPUT
    {
        std::process::exit(2);
    }
    let result = match args[0].as_str() {
        "memory" => memory(&input),
        "route" => route(&input),
        _ => None,
    };
    match result {
        Some(value) => println!("{value}"),
        None => std::process::exit(2),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measured_memory_excludes_reclaimable_cache() {
        assert_eq!(memory("8192\n1024\nMemAvailable: 6 kB\n"),
            Some("{\"total\":8192,\"used\":2048,\"available\":6144,\"source\":\"memavailable\"}".into()));
    }

    #[test]
    fn unavailable_invalid_and_overflowing_memory_use_bounded_fallback() {
        for data in ["", "MemAvailable: 999999999999999 kB", "MemAvailable: 8 MB"] {
            assert_eq!(memory(&format!("1000\n2000\n{data}")),
                Some("{\"total\":1000,\"used\":0,\"available\":1000,\"source\":\"os-freemem\"}".into()));
        }
        assert!(memory("18446744073709551615\n1\n").is_none());
        assert!(memory("-1\n1\n").is_none());
        assert!(memory("1\nNaN\n").is_none());
    }

    #[test]
    fn routes_are_exact_and_isolated() {
        let table = "alpha.example.test\talpha\t3000\nbeta.example.test\tbeta\t4000\n";
        assert_eq!(route(&format!("beta.example.test\n{table}")),
            Some("{\"slug\":\"beta\",\"port\":4000}".into()));
        for request in ["evil.test", "alpha.example.test.evil", "127.0.0.1:22", "../alpha"] {
            assert_eq!(route(&format!("{request}\n{table}")), Some("null".into()));
        }
    }

    #[test]
    fn invalid_target_and_duplicate_first_match_cannot_authorize_another_route() {
        for target in ["../alpha\t3000", "alpha\t22", "alpha\t65536", "alpha\t3000\textra"] {
            let result = route(&format!("alpha.example.test\nalpha.example.test\t{target}"));
            assert!(result == Some("null".into()) || result.is_none());
        }
        assert_eq!(route("alpha.example.test\nalpha.example.test\tbad--slug\t3000\nalpha.example.test\talpha\t3000"),
            Some("null".into()));
    }

    #[test]
    fn bounded_route_table_and_slug() {
        assert!(route(&format!("alpha.example.test\n{}", "other.example.test\tx\t3000\n".repeat(257))).is_none());
        assert!(!slug(&"a".repeat(41)));
        assert!(!slug("a-"));
        assert!(!host("x\r\nInjected"));
    }
}
