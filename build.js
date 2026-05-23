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

        console.log('📦 Copying static assets to public/ for Vercel...');
        const publicDir = path.join(__dirname, 'public');
        if (!fs.existsSync(publicDir)) {
            fs.mkdirSync(publicDir, { recursive: true });
        }

        const filesToCopy = ['index.html', 'manifest.json', 'sw.js', 'robots.txt'];
        const dirsToCopy = ['css', 'js', 'assets', 'dist'];

        for (const file of filesToCopy) {
            if (fs.existsSync(path.join(__dirname, file))) {
                fs.copyFileSync(path.join(__dirname, file), path.join(publicDir, file));
            }
        }

        function copyDirRecursive(src, dest) {
            if (!fs.existsSync(src)) return;
            if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
            const entries = fs.readdirSync(src, { withFileTypes: true });
            for (let entry of entries) {
                const srcPath = path.join(src, entry.name);
                const destPath = path.join(dest, entry.name);
                if (entry.isDirectory()) {
                    copyDirRecursive(srcPath, destPath);
                } else {
                    fs.copyFileSync(srcPath, destPath);
                }
            }
        }

        for (const dir of dirsToCopy) {
            copyDirRecursive(path.join(__dirname, dir), path.join(publicDir, dir));
        }
        console.log('✅ Build fully complete and ready for deployment in public/');

    } catch (err) {
        console.error('❌ Build failed:', err.message);
        process.exit(1);
    }
})();
