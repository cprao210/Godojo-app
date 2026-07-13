/**
 * RateLimiter - Token bucket rate limiter for LLM API calls
 * Prevents 429 errors on free-tier API plans by queuing requests
 * when the bucket is empty.
 *
 * Also includes a circuit breaker: after 3 consecutive 429 errors within
 * 60 seconds, the provider is marked OPEN for 120 seconds. isCircuitOpen()
 * lets callers skip a provider immediately without a wasted network round-trip.
 */
export class RateLimiter {
    private tokens: number;
    private readonly maxTokens: number;
    private readonly refillRatePerSecond: number;
    private lastRefillTime: number;
    private waitQueue: Array<() => void> = [];
    private refillTimer: ReturnType<typeof setInterval> | null = null;

    // Circuit breaker state
    private consecutiveRateLimitErrors: number = 0;
    private firstErrorTimeInWindow: number = 0;
    private circuitOpenUntil: number = 0;
    private static readonly CIRCUIT_ERROR_WINDOW_MS = 60_000;   // 60s window to count errors
    private static readonly CIRCUIT_ERROR_THRESHOLD = 3;         // errors before OPEN
    private static readonly CIRCUIT_COOLDOWN_MS = 120_000;       // 120s cooldown when OPEN

    /**
     * @param maxTokens - Maximum burst capacity (e.g. 30 for Groq free tier)
     * @param refillRatePerSecond - Tokens added per second (e.g. 0.5 = 30/min)
     */
    constructor(maxTokens: number, refillRatePerSecond: number) {
        this.maxTokens = maxTokens;
        this.tokens = maxTokens;
        this.refillRatePerSecond = refillRatePerSecond;
        this.lastRefillTime = Date.now();

        // Refill tokens periodically
        this.refillTimer = setInterval(() => this.refill(), 1000);
    }

    /**
     * Acquire a token. Resolves immediately if available, otherwise waits.
     */
    public async acquire(): Promise<void> {
        this.refill();

        if (this.tokens >= 1) {
            this.tokens -= 1;
            return;
        }

        // Wait for a token to become available
        return new Promise<void>((resolve) => {
            this.waitQueue.push(resolve);
        });
    }

    /**
     * Check whether the circuit breaker is open (provider is cooling down).
     * Call this BEFORE attempting an API request to skip the provider immediately.
     */
    public isCircuitOpen(): boolean {
        const now = Date.now();
        if (this.circuitOpenUntil > 0 && now < this.circuitOpenUntil) {
            return true;
        }
        // Auto-reset when cooldown expires
        if (this.circuitOpenUntil > 0 && now >= this.circuitOpenUntil) {
            this.circuitOpenUntil = 0;
            this.consecutiveRateLimitErrors = 0;
            this.firstErrorTimeInWindow = 0;
        }
        return false;
    }

    /**
     * Call this when a 429 / rate-limit error is received from the provider.
     * Tracks errors in a rolling 60-second window and opens the circuit after
     * CIRCUIT_ERROR_THRESHOLD consecutive errors.
     */
    public markRateLimitError(): void {
        const now = Date.now();

        // Reset window if the first error was more than 60s ago
        if (this.firstErrorTimeInWindow > 0 && (now - this.firstErrorTimeInWindow) > RateLimiter.CIRCUIT_ERROR_WINDOW_MS) {
            this.consecutiveRateLimitErrors = 0;
            this.firstErrorTimeInWindow = 0;
        }

        if (this.consecutiveRateLimitErrors === 0) {
            this.firstErrorTimeInWindow = now;
        }

        this.consecutiveRateLimitErrors++;
        console.warn(`[RateLimiter] 429 error recorded (${this.consecutiveRateLimitErrors}/${RateLimiter.CIRCUIT_ERROR_THRESHOLD})`);

        if (this.consecutiveRateLimitErrors >= RateLimiter.CIRCUIT_ERROR_THRESHOLD) {
            this.circuitOpenUntil = now + RateLimiter.CIRCUIT_COOLDOWN_MS;
            console.warn(`[RateLimiter] Circuit OPEN — provider cooling down for ${RateLimiter.CIRCUIT_COOLDOWN_MS / 1000}s`);
        }
    }

    /**
     * Call this on a successful response to reset the error counter.
     */
    public markSuccess(): void {
        if (this.consecutiveRateLimitErrors > 0) {
            this.consecutiveRateLimitErrors = 0;
            this.firstErrorTimeInWindow = 0;
        }
    }

    private refill(): void {
        const now = Date.now();
        const elapsed = (now - this.lastRefillTime) / 1000;
        const newTokens = elapsed * this.refillRatePerSecond;

        if (newTokens >= 1) {
            this.tokens = Math.min(this.maxTokens, this.tokens + Math.floor(newTokens));
            this.lastRefillTime = now;

            // Wake up waiting requests
            while (this.waitQueue.length > 0 && this.tokens >= 1) {
                this.tokens -= 1;
                const resolve = this.waitQueue.shift()!;
                resolve();
            }
        }
    }

    public destroy(): void {
        if (this.refillTimer) {
            clearInterval(this.refillTimer);
            this.refillTimer = null;
        }
        // Release all waiting requests
        while (this.waitQueue.length > 0) {
            const resolve = this.waitQueue.shift()!;
            resolve();
        }
    }
}

/**
 * Pre-configured rate limiters for known providers.
 * These match documented free-tier limits.
 */
export function createProviderRateLimiters() {
    return {
        groq: new RateLimiter(6, 0.1),        // 6 req/min
        gemini: new RateLimiter(120, 2.0),    // 120 req/min
        openai: new RateLimiter(120, 2.0),    // 120 req/min
        claude: new RateLimiter(120, 2.0),    // 120 req/min
    };
}
