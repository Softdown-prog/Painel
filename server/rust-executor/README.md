# Rust executor — shadow policy prototype

This does not replace the production Node executor. It implements a pure Rust subset of policy decisions for approved read-only operations and bounded JSON probes. The candidate_allowed output is advisory. The enforcement_allowed field is always false.

The prototype has no Docker socket, network listener, shell execution, privileged operations or deployment. It is intended to establish a testable Rust baseline before parity testing against the existing Node policy and before a separate least-privileged host broker is designed. The VPS and other projects remain unchanged.

Run locally: cargo fmt --manifest-path server/rust-executor/Cargo.toml -- --check; cargo clippy --manifest-path server/rust-executor/Cargo.toml -- -D warnings; cargo test --manifest-path server/rust-executor/Cargo.toml

Next: compare fixtures against Node authorization, prove limits and denial behavior, benchmark CPU/RSS/p95 in staging, and only then evaluate replacing parts of the existing executor.
