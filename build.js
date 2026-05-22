/**
 * Estato Build Script
 * Uses esbuild to bundle & minify the client-side JavaScript for production.
 * Output: dist/bundle.min.js  (used in production via index.html script tag)
 *
 * Run with: node build.js
 */

const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

// Ensure the dist directory exists
const distDir = path.join(__dirname, 'dist');
if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
}

(async () => {
    console.log('📦 Estato Build — Bundling client JS...');
    const start = Date.now();

    try {
        await esbuild.build({
            entryPoints: ['js/modules/main.js'],
            bundle: true,
            minify: true,
            sourcemap: false,
            outfile: 'dist/bundle.min.js',
            format: 'iife',
            globalName: 'EstatoApp',
            define: {
                'process.env.NODE_ENV': '"production"'
            },
            logLevel: 'info',
        });

        const elapsed = Date.now() - start;
        const size = (fs.statSync('dist/bundle.min.js').size / 1024).toFixed(1);
        console.log(`✅ Bundle complete in ${elapsed}ms → dist/bundle.min.js (${size} KB)`);
    } catch (err) {
        console.error('❌ Build failed:', err.message);
        process.exit(1);
    }
})();
