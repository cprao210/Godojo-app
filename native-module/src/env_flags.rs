//! Developer/field-tuning environment flags.
//!
//! Flags are named `GODOJO_<NAME>` (e.g. `GODOJO_ECHO_MODE`, `GODOJO_VERBOSE`).
//! The legacy `NATIVELY_<NAME>` spelling (from the codebase GoDojo started as)
//! is still accepted so existing dev setups keep working; the GoDojo name wins
//! when both are set. Same rule as `readEnv` in the Electron main process.

/// Value of `GODOJO_<name>`, falling back to the legacy `NATIVELY_<name>`.
pub fn env_flag(name: &str) -> Option<String> {
    std::env::var(format!("GODOJO_{name}"))
        .ok()
        .or_else(|| std::env::var(format!("NATIVELY_{name}")).ok())
}

#[cfg(test)]
mod tests {
    use super::env_flag;

    #[test]
    fn godojo_name_wins_and_legacy_name_still_works() {
        // Unique names so parallel tests can't interfere.
        std::env::set_var("NATIVELY_ENVFLAG_TEST_A", "legacy");
        assert_eq!(env_flag("ENVFLAG_TEST_A").as_deref(), Some("legacy"));

        std::env::set_var("GODOJO_ENVFLAG_TEST_B", "new");
        std::env::set_var("NATIVELY_ENVFLAG_TEST_B", "legacy");
        assert_eq!(env_flag("ENVFLAG_TEST_B").as_deref(), Some("new"));

        assert_eq!(env_flag("ENVFLAG_TEST_UNSET"), None);
    }
}
