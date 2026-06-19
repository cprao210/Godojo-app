// Normalized LMS Adaptive Echo Canceller
//
// Takes a far-end reference (system audio — what the speakers are playing) and a
// near-end input (microphone — which contains an acoustic echo of the reference)
// and returns a cleaned near-end signal with the echo subtracted.
//
// Algorithm: NLMS (Normalized Least Mean Squares)
//   y[n]   = w^T * x[n]          (echo estimate)
//   e[n]   = d[n] - y[n]         (error = desired mic − estimate)
//   w[n+1] = w[n] + μ·e[n]·x[n] / (‖x[n]‖² + ε)   (weight update)
//
// Variable step size μ:
//   - Starts at MU_INIT (0.50) for fast initial adaptation (~1 s to converge)
//   - Decays linearly to MU_STEADY (0.05) over MU_DECAY_FRAMES frames (~1.5 s)
//   - Fixed μ=0.05 takes 10+ s to converge on sparse speech; 0.50 locks in ~1 s
//
// Weight update gating:
//   - If the reference power is near-zero (all-zero padding from missing reference),
//     the weight update is skipped to prevent the filter from training toward zero.
//   - This is critical during the SCK 5–7 s startup window.
//
// TAPS = 1024 → 64 ms at 16 kHz — covers built-in speaker reverb paths that
// extend beyond 32 ms, including MacBooks at medium-high volume.
// Both signals must be 16 kHz mono i16 PCM before calling process().

const TAPS: usize = 1024;
const MU_INIT: f32 = 0.50;        // aggressive start — fast initial convergence
const MU_STEADY: f32 = 0.05;      // stable steady-state
const MU_DECAY_FRAMES: usize = 75; // ~1.5 s at one frame per 20 ms
const MIN_REF_POWER: f32 = 1e-4;  // below this, skip weight update (padded zeros)
const EPS: f32 = 1e-6;
const DTD_RATIO: f32 = 3.0;       // double-talk: freeze weights when mic energy > 3× reference
const WIENER_ALPHA: f32 = 0.3;    // Wiener post-filter strength (0 = off, 1 = max suppression)

pub struct AecFilter {
    w: Vec<f32>,           // adaptive weights
    x: Vec<f32>,           // circular reference history
    xi: usize,             // write index into x
    frame_count: usize,    // for variable-μ decay and diagnostics
}

impl AecFilter {
    pub fn new() -> Self {
        Self {
            w: vec![0.0; TAPS],
            x: vec![0.0; TAPS],
            xi: 0,
            frame_count: 0,
        }
    }

    pub fn frame_count(&self) -> usize {
        self.frame_count
    }

    fn current_mu(&self) -> f32 {
        if self.frame_count >= MU_DECAY_FRAMES {
            MU_STEADY
        } else {
            let t = self.frame_count as f32 / MU_DECAY_FRAMES as f32;
            MU_INIT + (MU_STEADY - MU_INIT) * t
        }
    }

    /// Process one frame. `reference` = far-end (system audio),
    /// `mic` = near-end (microphone with echo). Returns cleaned mic samples.
    ///
    /// Weight updates are skipped when reference power is below MIN_REF_POWER
    /// to avoid corrupting the filter with zero-padded reference gaps (e.g.
    /// during the SCK 5–7 s startup window).
    pub fn process(&mut self, reference: &[i16], mic: &[i16]) -> Vec<i16> {
        let n = reference.len().min(mic.len());
        let mut out = Vec::with_capacity(n);
        let mu = self.current_mu();
        self.frame_count += 1;

        // Double-talk detection: freeze weight updates when mic dominates reference
        let ref_e: f32 = reference[..n].iter().map(|&s| { let f = s as f32 / 32768.0; f * f }).sum::<f32>() / n as f32;
        let mic_e: f32 = mic[..n].iter().map(|&s| { let f = s as f32 / 32768.0; f * f }).sum::<f32>() / n as f32;
        let dtd = mic_e > DTD_RATIO * (ref_e + EPS);

        for i in 0..n {
            let x_s = reference[i] as f32 / 32768.0;
            let d = mic[i] as f32 / 32768.0;

            // Write newest reference sample into circular buffer
            self.x[self.xi] = x_s;

            // Echo estimate and reference power
            let mut echo_est = 0.0_f32;
            let mut power = 0.0_f32;
            for k in 0..TAPS {
                let idx = (self.xi + TAPS - k) % TAPS;
                echo_est += self.w[k] * self.x[idx];
                power += self.x[idx] * self.x[idx];
            }

            let e = d - echo_est;

            // Only update weights when the reference carries real signal.
            // Skipping on near-zero power prevents the all-zero padding (used
            // when AEC_REF_BUF has no data) from pushing filter weights to zero.
            if power >= MIN_REF_POWER && !dtd {
                let norm_inv = mu / (power + EPS);
                for k in 0..TAPS {
                    let idx = (self.xi + TAPS - k) % TAPS;
                    self.w[k] += norm_inv * e * self.x[idx];
                }
            }

            self.xi = (self.xi + 1) % TAPS;

            // Wiener post-filter: suppress residual echo proportional to reference power
            let norm_ref = power / TAPS as f32;
            let e_sq = e * e;
            let gain = e_sq / (e_sq + WIENER_ALPHA * norm_ref + EPS);
            out.push((e * gain * 32768.0).clamp(-32768.0, 32767.0) as i16);
        }

        out
    }
}
