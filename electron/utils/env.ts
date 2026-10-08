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

/**
 * The native audio module (Rust) still reads NATIVELY_* flags itself
 * (NATIVELY_ECHO_MODE, NATIVELY_VERBOSE, gate/ERLE tuning, …). Copy every
 * GODOJO_* flag onto its NATIVELY_* twin before the module loads, so
 * developers can use the GoDojo names everywhere without a native rebuild.
 * An explicitly set NATIVELY_* value is left untouched.
 */
export function mirrorGodojoEnvForNativeModule(env: NodeJS.ProcessEnv = process.env): void {
    for (const [key, value] of Object.entries(env)) {
        if (!key.startsWith('GODOJO_') || value === undefined) continue;
        const legacy = `NATIVELY_${key.slice('GODOJO_'.length)}`;
        if (env[legacy] === undefined) env[legacy] = value;
    }
}
