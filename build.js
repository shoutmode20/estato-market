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
            outdir: 'dist',
            format: 'esm',
            splitting: true,
            define: {
                'process.env.NODE_ENV': '"production"'
            },
            logLevel: 'info',
        });

        const elapsed = Date.now() - start;
        const size = (fs.statSync('dist/main.js').size / 1024).toFixed(1);
        console.log(`✅ Code Splitting enabled. Main chunk complete in ${elapsed}ms → dist/main.js (${size} KB)`);

        console.log('📦 Copying static assets to public/ for Vercel...');
        const publicDir = path.join(__dirname, 'public');
        if (!fs.existsSync(publicDir)) {
            fs.mkdirSync(publicDir, { recursive: true });
        }

        const filesToCopy = ['index.html', 'manifest.json', 'sw.js', 'robots.txt'];
        const dirsToCopy = ['css', 'assets', 'dist'];

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

        // Explicitly only copy config.js (do not expose raw js modules)
        const publicJsDir = path.join(publicDir, 'js');
        if (!fs.existsSync(publicJsDir)) fs.mkdirSync(publicJsDir, { recursive: true });
        if (fs.existsSync(path.join(__dirname, 'js/config.js'))) {
            fs.copyFileSync(path.join(__dirname, 'js/config.js'), path.join(publicJsDir, 'config.js'));
        }

        // Overwrite public/index.html to use the code-split ESM production build
        const indexPath = path.join(publicDir, 'index.html');
        if (fs.existsSync(indexPath)) {
            let html = fs.readFileSync(indexPath, 'utf-8');
            // Replace dev module src with production dist/main.js (must keep type="module" for ESM chunks)
            html = html.replace(
                /<script type="module" src="\/js\/modules\/main\.js[^>]*><\/script>/,
                '<script type="module" src="/dist/main.js"></script>'
            );
            fs.writeFileSync(indexPath, html);
        }

        // Post-build Manifest Sync: Update SW cache with all dist/ chunks
        const swPath = path.join(publicDir, 'sw.js');
        if (fs.existsSync(swPath)) {
            console.log('🔄 Injecting production chunks into Service Worker cache list...');
            let swContent = fs.readFileSync(swPath, 'utf-8');
            
            // Collect all files from dist directory
            const distFiles = fs.readdirSync(path.join(publicDir, 'dist'))
                .filter(f => f.endsWith('.js') || f.endsWith('.css'))
                .map(f => `'./dist/${f}'`);
            
            // Regex to find and replace the ASSETS array in sw.js
            const assetsRegex = /const ASSETS = \[([\s\S]*?)\];/;
            const match = swContent.match(assetsRegex);
            if (match) {
                const currentAssets = match[1].split(',').map(s => s.trim()).filter(Boolean);
                // Filter out external URLs and existing ./dist entries to refresh them
                const stableAssets = currentAssets.filter(a => !a.includes('./dist/') && (a.startsWith("'.") || a.startsWith("'https")));
                const newAssets = [...new Set([...stableAssets, ...distFiles])];
                
                swContent = swContent.replace(assetsRegex, `const ASSETS = [\n    ${newAssets.join(',\n    ')}\n];`);
                fs.writeFileSync(swPath, swContent);
                console.log(`✅ SW Cache updated with ${distFiles.length} production chunks.`);
            }
        }

        console.log('✅ Build fully complete and ready for deployment in public/');

    } catch (err) {
        console.error('❌ Build failed:', err.message);
        process.exit(1);
    }
})();
