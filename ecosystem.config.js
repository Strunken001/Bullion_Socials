module.exports = {
    apps: [
        {
            name: 'bullionsocials',
            script: 'server.js',
            // Windows Server — use node interpreter explicitly
            interpreter: 'node',

            // Restart policy
            watch: false,   // never watch files in production
            autorestart: true,
            max_restarts: 10,
            restart_delay: 3000,    // wait 3s before restarting
            min_uptime: 5000,    // must stay up 5s to count as successful start

            // Memory limit — if Chromium leaks, PM2 will restart before OOM
            max_memory_restart: '3G',

            // Environment variables Playwright + Node need on Windows Server
            env: {
                NODE_ENV: 'production',
                PORT: 3000,

                // Tell Playwright where Chromium is installed.
                // Run `npx playwright install chromium` first, then check the path it prints.
                // Common Windows path — adjust if yours is different:
                // PLAYWRIGHT_BROWSERS_PATH: 'C:\\Users\\Administrator\\AppData\\Local\\ms-playwright',

                // SwiftShader on Windows needs this to find the DLLs
                // (Playwright sets this internally but PM2 can lose it)
                PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '0',

                // Increase Node's default UV thread pool — sharp uses it heavily for frame decode
                UV_THREADPOOL_SIZE: '16',

                // Prevent Node from running out of heap on long sessions
                NODE_OPTIONS: '--max-old-space-size=2048',
            },

            // Log files — check these when things go wrong
            output: './logs/out.log',
            error: './logs/err.log',
            log_date_format: 'YYYY-MM-DD HH:mm:ss',
            merge_logs: true,
        },
    ],
};