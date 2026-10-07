import fs from 'node:fs';
let html;
export const statusPageHtml = () => (html ||= fs.readFileSync(new URL('./status-page.html', import.meta.url), 'utf8'));
