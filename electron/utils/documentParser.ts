// Extracts plain text from file buffers using only packages already in the project.
import { PDFParse, TextResult } from 'pdf-parse';

export async function extractTextFromBuffer(data: Buffer, mimeType: string): Promise<string | TextResult> {

    // ── PDF ──────────────────────────────────────────────────────────────────
    if (mimeType === 'application/pdf') {
        try {
            const uint8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            const parsed = new PDFParse(uint8);
            const result = await parsed.getText();
            return result.text ?? '';
        } catch (e: any) {
            console.error('[documentParser] PDF extraction failed:', e.message);
            return '';
        }
    }

    // ── DOCX ─────────────────────────────────────────────────────────────────
    if (
        mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        mimeType === 'application/msword'
    ) {
        try {
            const mammoth = require('mammoth');
            const result = await mammoth.extractRawText({ buffer: data });
            return result.value ?? '';
        } catch (e: any) {
            console.error('[documentParser] DOCX extraction failed:', e.message);
            return '';
        }
    }

    // ── PPTX ─────────────────────────────────────────────────────────────────
    if (
        mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
        mimeType === 'application/vnd.ms-powerpoint'
    ) {
        try {
            const JSZip = require('jszip');
            const zip = await JSZip.loadAsync(data);
            const texts: string[] = [];

            const slideFiles = Object.keys(zip.files)
                .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
                .sort(); // ensure slide order

            for (const fileName of slideFiles) {
                const xml: string = await zip.files[fileName].async('string');
                // Extract text runs <a:t>...</a:t>
                const runs = xml.match(/<a:t[^>]*>([^<]+)<\/a:t>/g) ?? [];
                const slideText = runs
                    .map(r => r.replace(/<[^>]+>/g, ''))
                    .join(' ')
                    .trim();
                if (slideText) texts.push(slideText);
            }

            return texts.join('\n\n');
        } catch (e: any) {
            console.error('[documentParser] PPTX extraction failed:', e.message);
            return '';
        }
    }

    // ── Plain text / fallback ─────────────────────────────────────────────────
    return data.toString('utf-8');
}