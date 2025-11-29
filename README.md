# CivitAI User Downloader (CLI)

A fast, lightweight Node.js CLI tool to download images from a specific user on CivitAI. It features powerful metadata filtering (Logic AND/OR/NOT), exclusion lists, concurrency control, and local caching.

## 🚀 Features

* **Logic Filtering:** Filter images using complex logic like `"cat OR dog"`, `"1girl AND (cat_ears OR fox_ears)"`.
* **Smart Exclusions:** Automatically handles variations (e.g., excluding "boy" also excludes "1boy", "2boy").
* **Persistence config:** Instead of typing flags every time, you can create a config.json in the root directory.
* **High Performance:** Uses concurrent downloads (multi-threading) to maximize speed.
* **Resumable/Offline Mode:** Caches metadata locally. You can re-run filters on previously fetched metadata without hitting the API again.
* **API Key Support:** Supports CivitAI API keys to bypass rate limits and access restricted content.

## 📋 Prerequisites

* **Node.js**: Version 20.0.0 or higher.
* **pnpm** (Recommended) or npm/yarn.

## 🛠️ Installation

1. **Clone the repository:**

```bash
git clone https://github.com/Rryowa/civitai-user-downloader.git
cd civitai-user-downloader
```

1. **Install dependencies:**

```bash
pnpm install
# or
npm install
```

## 📖 Usage

The basic syntax is `civit-downloader <username> [options]`.

### Basic Example

Download the last 50 images from user `ArtMaster`, utilizing 10 concurrent threads:

```bash
node index.js ArtMaster --limit 50 --concurrency 10
```

## Useful knowledge

### Advanced Filtering (Logic)

```bash
node index.js ArtMaster \
  --tags "elf AND (forest OR nature)" \
  --exclude-tags "dark skin, gore" \
  --limit 100
```

The tool supports JavaScript-like logic.
    OR: cat OR dog (Match if either tag exists)
    AND: cat AND maid (Match only if both exist)
    NOT: NOT 3d (Match if "3d" is NOT present)
    Grouping: (cat OR dog) AND NOT 3d

**More logic = slower filtering.**

### Persistence config

Instead of typing flags every time, you can create a config.json in the root directory.

| Option | Default | Description |
| :--- | :--- | :--- |
| `username` | **Required** | The username on CivitAI to scrape. |
| `--tags` | `""` | Logic string to include images (e.g., `"1girl AND blue_eyes"`). |
| `--exclude-tags` | `""` | Comma-separated list of tags to skip. |
| `--nsfw` | `X` | Content rating (`None`, `Soft`, `Mature`, `X`). |
| `--sort` | `Newest` | Sort order (`Newest`, `Oldest`, `Most Reactions`, etc.). |
| `--limit` | `10` | Maximum number of images to find/download. |
| `--output` | `downloads` | Directory where images will be saved. |
| `--concurrency` | `5` | Number of simultaneous downloads (Speed). |
| `--quality` | `HD` | Image quality (`HD` = Original, `SD` = Optimized). |
| `--api-key` | `null` | Your CivitAI API Key. |
| `--offline` | `false` | Scan only local metadata cache (no new API calls). |

```json
{
  "tags": "futa or futanari",
  "excludeTags": "extra arms, extra eyes, body horror, gore, political, vore, plump, blood, anthro, furry,",
  "nsfw": "X",
  "sort": "Newest",
  "limit": 10,
  "output": "./civitai",
  "concurrency": 6,
  "quality": "HD",
  "apiKey": "xxxxx"
}
```
