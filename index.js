#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import { cac } from 'cac';
import PQueue from 'p-queue';
import sanitize from 'sanitize-filename';
import cliProgress from 'cli-progress';
import colors from 'colors';

// --- Constants ---
const BASE_URL = "https://civitai.com/api/v1";
const DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Node.js CLI) CivitAI-Downloader/3.0",
    "Content-Type": "application/json"
};
const DEFAULTS = {
    nsfw: 'X',
    sort: 'Newest',
    limit: 10,
    output: 'downloads',
    concurrency: 5,
    quality: 'HD',
    excludeTags: ''
};

// --- Entry Point ---
async function main() {
    const cli = cac('civit-downloader');

    cli.command('<username>', 'Download images from a specific user')
        .option('--tags <string>', 'Filter logic (e.g. "cat OR dog")')
        .option('--exclude-tags <string>', 'Tags to exclude (e.g. "bad, ugly")')
        .option('--nsfw <string>', `NSFW Level (None, Soft, Mature, X) [default: ${DEFAULTS.nsfw}]`)
        .option('--sort <string>', `Sort order [default: ${DEFAULTS.sort}]`)
        .option('--limit <number>', `Max matches [default: ${DEFAULTS.limit}]`)
        .option('--output <dir>', `Output dir [default: ${DEFAULTS.output}]`)
        .option('--concurrency <number>', `Threads [default: ${DEFAULTS.concurrency}]`)
        .option('--api-key <string>', 'API Key')
        .option('--quality <string>', `SD/HD [default: ${DEFAULTS.quality}]`)
        .option('--config <path>', 'Config file', { default: 'config.json' })
        .option('--offline', 'Local cache only', { default: false })
        .example('  $ civit-downloader ArtMaster --limit 50')
        .example('  $ civit-downloader ArtMaster --tags "elf AND forest" --exclude-tags "goblin"')
        .example('  $ civit-downloader ArtMaster --nsfw X --concurrency 10')
        .action(async (username, options) => {
            try {
                // 1. Config (Data)
                const config = await createConfiguration(username, options);
                logConfiguration(config);

                // 2. Services (Logic/State)
                const filter = new TagFilter(config.tags, config.excludeTags);
                const cache = new MetadataCache(config.output, config.username);
                
                // 3. Orchestrator
                const downloader = new CivitDownloader(config, filter, cache);
                await downloader.run();
            } catch (err) {
                console.error(colors.red(`Error: ${err.message}`));
                process.exit(1);
            }
        });

    cli.help();
    cli.version('1.0.0'); // Good practice to add version
    cli.parse();
}

// --- Orchestrator ---
class CivitDownloader {
    constructor(config, filter, cache) {
        this.cfg = config;
        this.filter = filter;
        this.cache = cache;
        
        this.queue = new PQueue({ concurrency: config.concurrency });
        this.stats = { scanned: 0, matches: 0, downloaded: 0, skipped: 0 };
        
        // UI
        this.multibar = new cliProgress.MultiBar({
            clearOnComplete: false,
            hideCursor: true,
            format: '{bar} | {percentage}% | {value}/{total} | {msg}'
        }, cliProgress.Presets.shades_grey);
        this.scanBar = null;
        this.downloadBar = null;
    }

    async run() {
        this.initialize();

        try {
            if (this.cfg.offline) {
                await this.runOfflineStrategy();
            } else {
                await this.runOnlineStrategy();
            }
            
            await this.finalize();
        } catch (error) {
            this.multibar.stop();
            this.cache.save();
            console.error(colors.red(`\n✖  Fatal Error: ${error.message}`));
        }
    }

    initialize() {
        this.cache.ensureDir();
        this.cache.loadMetadata();
        this.cache.loadFiles();
        
        if (this.cfg.offline && this.cache.isEmpty()) {
            throw new Error(`Offline mode enabled but no metadata found in ${this.cache.paths.metadata}`);
        }

        this.scanBar = this.multibar.create(this.cfg.limit, 0, { 
            msg: colors.yellow(this.cfg.offline ? 'Filtering Cache...' : 'Scanning API...') 
        });
        this.downloadBar = this.multibar.create(this.cfg.limit, 0, { 
            msg: colors.cyan('Overall Progress') 
        });
    }

    async runOfflineStrategy() {
        const items = this.cache.getAll();
        this.processBatch(items);
    }

    async runOnlineStrategy() {
        let nextUrl = `${BASE_URL}/images?username=${this.cfg.username}&sort=${this.cfg.sort}&nsfw=${this.cfg.nsfw}&limit=200`;

        while (nextUrl && !this.isLimitReached()) {
            const response = await this.fetchPage(nextUrl);
            if (!response) break;

            const { items, metadata } = response;
            if (this.isUserEmpty(items)) return;

            this.cache.upsertBatch(items);
            this.processBatch(items);
            this.cache.save();

            nextUrl = this.stats.matches >= this.cfg.limit ? null : metadata.nextPage;
        }
    }

    processBatch(items) {
        for (const item of items) {
            if (this.isLimitReached()) break;

            this.updateScanStats();

            if (!this.filter.test(item.meta?.prompt)) continue;

            this.stats.matches++;
            this.scanBar.update(this.stats.matches, { 
                msg: colors.yellow(`Matches: ${this.stats.matches}/${this.cfg.limit} (Found!)`) 
            });
            
            if (this.cache.hasFile(item.id)) {
                this.stats.skipped++;
                this.downloadBar.increment();
                
                continue;
            }

            this.enqueueDownload(item);
        }
    }

    isLimitReached() {
        return this.stats.matches >= this.cfg.limit;
    }

    enqueueDownload(item) {
        this.stats.downloaded++;
        this.queue.add(async () => {
            try {
                await this.downloadItem(item);
            } catch (e) {
                this.multibar.log(colors.red(`✖ Error downloading ${item.id}: ${e.message}\n`));
            } finally {
                this.downloadBar.increment();
            }
        });
    }

    async downloadItem(item) {
        const imageUrl = resolveImageUrl(item.url, this.cfg.quality);
        const ext = resolveExtension(imageUrl);
        const filename = sanitize(`${item.id}${ext}`);
        const filePath = path.join(this.cache.paths.dir, filename);
        
        if (fs.existsSync(filePath)) return;

        const dlBar = this.multibar.create(100, 0, { msg: `DL ${item.id}` });

        try {
            const { data, headers } = await axios({
                url: imageUrl,
                method: 'GET',
                responseType: 'stream'
            });

            pipeToFile(data, headers['content-length'], filePath, dlBar);
            await streamFinished(data, dlBar, this.multibar);
        } catch (error) {
            dlBar.stop();
            this.multibar.remove(dlBar);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            throw error;
        }
    }

    // --- Helpers ---

    updateScanStats() {
        this.stats.scanned++;
        if (this.stats.scanned % 50 === 0) {
            this.scanBar.update(this.stats.matches, { 
                msg: colors.yellow(`Matches: ${this.stats.matches}/${this.cfg.limit} (Scanned: ${this.stats.scanned})`) 
            });
        }
    }

    isUserEmpty(items) {
        if (this.stats.scanned === 0 && items.length === 0) {
            this.multibar.stop();
            console.log(colors.red(`\n✖  User '${this.cfg.username}' has no images.`));
            return true;
        }
        return false;
    }

    async fetchPage(url) {
        const headers = { ...DEFAULT_HEADERS };
        if (this.cfg.apiKey) headers['Authorization'] = `Bearer ${this.cfg.apiKey}`;

        try {
            const { data } = await axios.get(url, { headers });
            return data;
        } catch (err) {
            this.multibar.stop();

            if (err.response?.status === 404) {
                console.log(colors.red(`\n✖  User '${this.cfg.username}' not found (404).`));
            } else if ([401, 403].includes(err.response?.status)) {
                console.log(colors.red(`\n✖  Authorization failed. Check API Key.`));
            } else {
                console.log(colors.red(`\n✖  API Error: ${err.message}`));
            }
            
            this.cache.save();
            
            return null;
        }
    }

    async finalize() {
        if (this.stats.matches < this.cfg.limit) {
            if (!this.cfg.offline) this.scanBar.setTotal(this.stats.matches);
            this.downloadBar.setTotal(this.stats.matches);
        }
        
        this.scanBar.update(this.stats.matches, { 
            msg: colors.green('Processing Complete - Waiting for downloads...') 
        });

        await this.queue.onIdle();
        this.multibar.stop();
        this.cache.save();
        
        printSummaryLog(this.stats, this.cache.paths.dir, this.cfg.offline);
    }
}

// --- Data Service: Metadata & Files ---
class MetadataCache {
    constructor(outputDir, username) {
        this.paths = this.resolvePaths(outputDir, username);
        this.data = new Map(); // JSON cache
        this.files = new Set(); // Physical files
    }

    resolvePaths(output, username) {
        const targetDir = path.join(output, sanitize(username));
        return {
            dir: targetDir,
            metadata: path.join(targetDir, 'metadata.json')
        };
    }

    ensureDir() {
        if (!fs.existsSync(this.paths.dir)) {
            fs.mkdirSync(this.paths.dir, { recursive: true });
        }
    }

    loadMetadata() {
        if (!fs.existsSync(this.paths.metadata)) return;
        try {
            const raw = fs.readFileSync(this.paths.metadata, 'utf8');
            this.data = new Map(JSON.parse(raw).map(item => [item.id, item]));
        } catch (e) {
            console.error(colors.yellow(`⚠  Corrupt metadata file, starting fresh.`));
        }
    }

    loadFiles() {
        // Reads disk to check what we actually have
        const files = fs.readdirSync(this.paths.dir);
        // Store only ID (filename without ext) for O(1) format-agnostic lookup
        this.files = new Set(files.map(f => path.parse(f).name));
    }

    save() {
        try {
            const arr = Array.from(this.data.values());
            fs.writeFileSync(this.paths.metadata, JSON.stringify(arr, null, 2));
        } catch (e) {
            console.error(colors.red(`✖  Failed to save metadata: ${e.message}`));
        }
    }

    upsertBatch(items) {
        for (const item of items) {
            this.data.set(item.id, item);
        }
    }

    getAll() {
        return Array.from(this.data.values());
    }

    isEmpty() {
        return this.data.size === 0;
    }

    hasFile(id) {
        return this.files.has(id.toString());
    }
}

// --- Logic Service: Filtering ---
class TagFilter {
    constructor(includeQuery, excludeString) {
        this.predicate = this.compile(includeQuery, excludeString);
    }

    test(prompt) {
        return this.predicate(prompt || "");
    }

    compile(query, excludeString) {
        const exclusions = this.parseExclusions(excludeString);
        const { terms, expression } = this.parseInclusions(query);

        if (exclusions.length === 0 && terms.length === 0) return () => true;

        try {
            return new Function('Terms', 'Exclusions', 'prompt', `
                for (let i = 0; i < Exclusions.length; i++) {
                    if (Exclusions[i].test(prompt)) return false;
                }
                return ${expression};
            `).bind(null, terms, exclusions);
        } catch (e) {
            console.error(colors.red(`✖  Invalid Logic Syntax: "${query}"`));
            process.exit(1);
        }
    }

    parseExclusions(str) {
        if (!str) return [];
        return str.split(',')
            .map(t => t.trim().replace(/^['"]|['"]$/g, ''))
            .filter(Boolean)
            // FIX: Added \d* to allow exclusions like "1girl" if you exclude "girl"
            .map(t => new RegExp(`\\b\\d*${this.escapeRegex(t)}\\b`, 'i'));
    }

    parseInclusions(query) {
        if (!query || !query.trim()) return { terms: [], expression: "true" };

        const terms = [];
        let expression = "";
        
        const tokens = query.split(/\s+(AND|OR|NOT)\s+|\s*(\(|\))\s*/i).filter(t => t && t.trim());
        
        tokens.forEach(token => {
            const upper = token.toUpperCase().trim();
            if (['AND', 'OR', 'NOT', '(', ')'].includes(upper)) {
                expression += this.mapOperator(upper);
            } else {
                const index = terms.length;
                const cleanTag = token.replace(/^['"]|['"]$/g, ''); 
                
                // --- THE FIX IS HERE ---
                // \b   -> Start of word boundary
                // \d* -> Allow optional digits (e.g., 1, 2, 10)
                // Tag  -> The actual tag
                // \b   -> End of word boundary
                //terms.push(new RegExp(`\\b\\d*${this.escapeRegex(cleanTag)}\\b`, 'i'));
		terms.push(new RegExp(`\\b\\d*${this.escapeRegex(cleanTag)}s?\\b`, 'i'));
                
                expression += `Terms[${index}].test(prompt)`;
            }
        });

        return { terms, expression };
    }

    mapOperator(op) {
        if (op === 'AND') return ' && ';
        if (op === 'OR') return ' || ';
        if (op === 'NOT') return ' !';
        return op;
    }

    escapeRegex(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
}

// --- Configuration Factory ---
async function createConfiguration(username, options) {
    const fileConfig = loadConfigFile(options.config);
    const config = { ...DEFAULTS, ...fileConfig, ...cleanOptions(options) };
    
    // Validation / Normalization
    config.username = username;
    
    return config;
}

function loadConfigFile(configPath) {
    const fullPath = path.resolve(process.cwd(), configPath);
    if (!fs.existsSync(fullPath)) return {};
    try {
        console.log(colors.green(`✔  Loaded config from: ${configPath}`));
        return JSON.parse(fs.readFileSync(fullPath, 'utf8')) || {};
    } catch (e) {
        console.error(colors.red(`✖  Failed to parse config: ${e.message}`));
        return {};
    }
}

function cleanOptions(options) {
    const clean = {};
    for (const key in options) {
        if (options[key] !== undefined) clean[key] = options[key];
    }
    return clean;
}

// --- Utils & Network ---

function resolveImageUrl(url, quality) {
    return quality === 'HD' ? url.replace(/width=\d+/, "original=true") : url;
}

function resolveExtension(url) {
    if (url.endsWith('.png')) return '.png';
    if (url.endsWith('.webp')) return '.webp';
    return '.jpeg';
}

function pipeToFile(stream, totalLength, filePath, bar) {
    const writer = fs.createWriteStream(filePath);
    let downloaded = 0;
    
    stream.on('data', (chunk) => {
        downloaded += chunk.length;
        if (totalLength) {
            bar.update(Math.round((downloaded / totalLength) * 100));
        }
    });
    
    stream.pipe(writer);
}

function streamFinished(stream, bar, multibar) {
    return new Promise((resolve, reject) => {
        stream.on('end', () => {
            bar.stop();
            multibar.remove(bar);
            resolve();
        });
        stream.on('error', (err) => {
            bar.stop();
            multibar.remove(bar);
            reject(err);
        });
    });
}

function logConfiguration(cfg) {
    console.log(colors.gray('------------------------------------------------'));
    console.log(colors.bold('⚙  Current Configuration:'));
    
    const keyMsg = cfg.apiKey 
        ? colors.green(`Active (...${cfg.apiKey.slice(-4)})`) 
        : colors.yellow('Not Provided');

    console.log(`  • Target User:  ${colors.cyan(cfg.username)}`);
    console.log(`  • API Key:      ${keyMsg}`);
    console.log(`  • Logic Filter: ${cfg.tags ? colors.cyan(cfg.tags) : colors.gray('None')}`);
    console.log(`  • Exclusions:   ${cfg.excludeTags ? colors.red(cfg.excludeTags) : colors.gray('None')}`);
    console.log(`  • Mode:         ${cfg.offline ? colors.yellow('OFFLINE') : colors.green('ONLINE')}`);
    console.log(`  • Match Limit:  ${colors.yellow(cfg.limit)} items`);
    console.log(`  • Output Path:  ${cfg.output}`);
    console.log(colors.gray('------------------------------------------------\n'));
}

function printSummaryLog(stats, dir, isOffline) {
    console.log('\n' + colors.bold('--- Summary ---'));
    console.log(`Source:        ${isOffline ? colors.yellow('Local Cache') : colors.green('CivitAI API')}`);
    console.log(`Items Scanned: ${colors.cyan(stats.scanned)}`);
    console.log(`Matches Found: ${colors.cyan(stats.matches)}`);
    console.log(`Downloaded:    ${colors.green(stats.downloaded)}`);
    console.log(`Skipped (Old): ${colors.yellow(stats.skipped)}`);
    console.log(`Location:      ${colors.underline(path.resolve(dir))}`);
    console.log(`Metadata:      ${colors.gray(path.join(dir, 'metadata.json'))}`);
}

main();
