
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const inputPath = path.join(__dirname, 'src/components/icon.png');
const outputAssets = path.join(__dirname, 'assets/iconTemplate.png');
const outputComponents = path.join(__dirname, 'src/components/iconTemplate.png');

async function processIcon() {
    try {
        console.log(`Processing ${inputPath}...`);

        // Resize to 22px height (standard for macOS tray)
        // IMPORTANT: Ensure it stays as PNG with transparency
        // We will make it a "Template" by ensuring it leverages alpha channel correctly.
        // If the user's icon is full color, converting to strictly grayscale might be safer for "Template" behavior,
        // but macOS often handles color templates by treating non-transparent pixels as the shape.

        await sharp(inputPath)
            .resize({ height: 22 }) // 22px is a good safe height for tray
            .png()
            .toFile(outputAssets);

        console.log(`Saved to ${outputAssets}`);

        // Copy to src/components as well
        fs.copyFileSync(outputAssets, outputComponents);
        console.log(`Copied to ${outputComponents}`);

    } catch (error) {
        console.error('Error processing icon:', error);
        process.exit(1);
    }
}

processIcon();
