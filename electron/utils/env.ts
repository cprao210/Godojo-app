// env.ts
//
// Developer/build environment flags are named GODOJO_*. They used to be
// NATIVELY_* (the codebase GoDojo started from), so the old names are still
// accepted — existing dev setups and CI keep working, and the new name wins
// when both are set.

/** Read GODOJO_<name>, falling back to the legacy NATIVELY_<name>. */
export function readEnv(name: string): string | undefined {
    return process.env[`GODOJO_${name}`] ?? process.env[`NATIVELY_${name}`];
}
