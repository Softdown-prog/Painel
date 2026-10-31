//! Bounded one-shot policy probe. No network, Docker socket or privileged side effects.
use std::io::{self, Read};
use vps_executor_shadow::{evaluate, Probe};

fn main() {
    let mut input = String::new();
    if let Err(error) = io::stdin().take(32769).read_to_string(&mut input) {
        eprintln!("unable to read probe: {error}");
        std::process::exit(2);
    }
    if input.len() > 32768 {
        eprintln!("probe exceeds 32KiB");
        std::process::exit(2);
    }
    let Ok(probe) = serde_json::from_str::<Probe>(&input) else {
        eprintln!("invalid probe");
        std::process::exit(2);
    };
    println!("{}", serde_json::to_string(&evaluate(&probe)).expect("serialize decision"));
}
