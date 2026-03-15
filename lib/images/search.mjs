/**
 * Image search and download — currently backed by DuckDuckGo.
 * Generic interface so the backend can be swapped or extended later.
 */
import { createWriteStream, mkdirSync } from 'fs';
import { pipeline } from 'stream/promises';
import { join } from 'path';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchWithRetry(url, opts, retries = 4) {
  const delays = [2000, 5000, 10000, 20000];
  for (let i = 0; i <= retries; i++) {
    const res = await fetch(url, opts);
    if (res.status !== 429 && res.status !== 403) return res;
    if (i === retries) throw new Error(`Image search rate limit — try again in a minute (HTTP ${res.status})`);
    await sleep(delays[i]);
  }
}

async function getDDGToken(query) {
  const res = await fetchWithRetry(
    `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`,
    { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' } }
  );
  const html = await res.text();
  const match = html.match(/vqd=(['"])([\d-]+)\1/);
  if (!match) throw new Error('Could not get search token — DuckDuckGo may have changed its API');
  return match[2];
}

export async function searchImages(query, count = 10) {
  const vqd = await getDDGToken(query);
  await sleep(1500); // avoid rate limiting
  const url = `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}&f=,,,&p=1`;
  const res = await fetchWithRetry(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Referer': 'https://duckduckgo.com/',
      'Accept': 'application/json',
    }
  });
  const data = await res.json();
  return (data.results ?? []).slice(0, Math.min(count, 20)).map(r => ({
    title: r.title,
    url: r.image,
    width: r.width,
    height: r.height,
    source: r.source,
  }));
}

export async function downloadImage(url, filename, outputDir) {
  const dir = outputDir ?? join(process.cwd(), 'images');
  mkdirSync(dir, { recursive: true });

  const rawName = url.split('/').pop().split('?')[0].replace(/[^a-zA-Z0-9._-]/g, '_');
  const name = filename ?? (rawName.length > 0 ? rawName : 'image.jpg');
  const outPath = join(dir, name);

  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);

  const ct = res.headers.get('content-type') ?? '';
  if (ct && !ct.startsWith('image/') && !ct.startsWith('application/octet-stream'))
    throw new Error(`URL returned ${ct}, not an image — try a different URL`);

  const reader = res.body.getReader();
  const { value: firstChunk } = await reader.read();
  if (!firstChunk || firstChunk.length === 0) throw new Error('Empty response from URL');
  const prefix = Buffer.from(firstChunk).toString('utf8', 0, 64);
  if (/^\s*<(!DOCTYPE|html)/i.test(prefix))
    throw new Error('URL returned an HTML page, not an image — try a different URL');

  await pipeline(
    (async function* () {
      yield firstChunk;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        yield value;
      }
    })(),
    createWriteStream(outPath)
  );

  return outPath;
}
