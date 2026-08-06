const path = require('path');
const fs = require('fs');

// CI guard — set SKIP_DOWNLOAD_MODELS=1 in any workflow that doesn't need models.
// download-models.js is called by postinstall which runs on every npm ci,
// so without this guard every CI job would download ~500MB of model weights.
if (process.env.SKIP_DOWNLOAD_MODELS === '1') {
    console.log('[download-models] SKIP_DOWNLOAD_MODELS=1 — skipping model download.');
    process.exit(0);
}

async function downloadModels() {
    const { pipeline, env } = await import('@xenova/transformers');
    const modelsDir = path.join(__dirname, '../resources/models');

    // Ensure the directory exists
    if (!fs.existsSync(modelsDir)) {
        fs.mkdirSync(modelsDir, { recursive: true });
    }

    // Let Transformers.js handle the download but specify the local directory cache
    env.cacheDir = modelsDir;

    try {
        // 1. Embedding model (RAG)
        console.log('[download-models] Downloading Xenova/all-MiniLM-L6-v2...');
        await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
        console.log('[download-models] all-MiniLM-L6-v2 downloaded.');

        // 2. Zero-shot classification model (Intent Classifier)
        console.log('[download-models] Downloading Xenova/mobilebert-uncased-mnli...');
        await pipeline('zero-shot-classification', 'Xenova/mobilebert-uncased-mnli');
        console.log('[download-models] mobilebert-uncased-mnli downloaded.');

        console.log('[download-models] All models downloaded successfully!');
    } catch (e) {
        console.error('[download-models] Error downloading model:', e);
        process.exit(1);
    }
}

downloadModels().catch((e) => {
    console.error('[download-models] Fatal error:', e);
    process.exit(1);
});