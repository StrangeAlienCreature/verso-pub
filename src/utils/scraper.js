const axios = require('axios');
const cheerio = require('cheerio');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function extractAsin(url) {
  const match = url.match(/\/(?:dp|product|gp\/product)\/([A-Z0-9]{10})/i);
  return match ? match[1].toUpperCase() : null;
}

async function fetchOpenLibrary(isbn) {
  const { data } = await axios.get(
    `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`,
    { headers: { 'User-Agent': USER_AGENT }, timeout: 8000 }
  );
  const book = data[`ISBN:${isbn}`];
  if (!book) return null;
  return {
    title:       book.title,
    author:      book.authors?.[0]?.name || '',
    coverUrl:    book.cover?.large || book.cover?.medium || null,
    description: (book.description?.value ?? book.description) || null,
    totalPages:  book.number_of_pages || null,
  };
}

/**
 * Scrape book metadata from a Goodreads, StoryGraph, or Amazon URL.
 * Falls back to og:meta tags which work on most book pages.
 */
async function scrapeBookFromUrl(url) {
  const { data: html } = await axios.get(url, {
    headers: { 'User-Agent': USER_AGENT },
    timeout: 12000,
  }).catch(err => {
    throw new Error(`Could not load the page: ${err.message}`);
  });

  const $ = cheerio.load(html);

  // ── Shared: og/meta fallbacks ──────────────────────────────────────────────
  const ogTitle       = $('meta[property="og:title"]').attr('content')?.trim();
  const ogDescription = $('meta[property="og:description"]').attr('content')?.trim();
  const ogImage       = $('meta[property="og:image"]').attr('content')?.trim();

  let title       = ogTitle || $('title').text().trim();
  let author      = '';
  let coverUrl    = ogImage || null;
  let description = ogDescription || null;
  let totalPages  = null;

  // ── Goodreads ──────────────────────────────────────────────────────────────
  if (url.includes('goodreads.com')) {
    // Author — new GR layout
    author =
      $('[data-testid="name"]').first().text().trim() ||
      $('[itemprop="author"] [itemprop="name"]').first().text().trim() ||
      $('.authorName span[itemprop="name"]').first().text().trim();

    // Pages
    const pagesText =
      $('[data-testid="pagesFormat"]').text() ||
      $('[itemprop="numberOfPages"]').text();
    const pagesMatch = pagesText.match(/(\d+)\s*pages/i);
    if (pagesMatch) totalPages = parseInt(pagesMatch[1]);

    // Clean title — GR often appends "by Author Name"
    title = title.replace(/\s+by\s+.+$/, '').trim();
  }

  // ── StoryGraph ─────────────────────────────────────────────────────────────
  else if (url.includes('thestorygraph.com')) {
    // Book detail page
    author =
      $('.book-title-author-and-series a').first().text().trim() ||
      $('p.font-bold').first().text().trim();

    const pagesText = $('p.font-sans').filter((_, el) => $(el).text().includes('pages')).first().text();
    const pagesMatch = pagesText.match(/(\d+)\s*pages/i);
    if (pagesMatch) totalPages = parseInt(pagesMatch[1]);

    title = title.replace(/\s*\|\s*The StoryGraph$/, '').trim();
  }

  // ── Amazon ─────────────────────────────────────────────────────────────────
  else if (url.includes('amazon.com') || url.includes('amazon.co')) {
    // Amazon blocks scrapers aggressively, so try Open Library via ASIN first.
    // Print-book ASINs are ISBN-10s; Kindle ASINs start with 'B' and won't match.
    const asin = extractAsin(url);
    if (asin && !/^B/i.test(asin)) {
      const olData = await fetchOpenLibrary(asin).catch(() => null);
      if (olData) {
        return { ...olData, sourceUrl: url };
      }
    }

    // Fallback: best-effort HTML parse (may get blocked by Amazon)
    author =
      $('#bylineInfo .author a').first().text().trim() ||
      $('#bylineInfo span.a-color-secondary').first().text().replace(/^by\s+/i, '').trim();

    const printLength = ($('#detailBullets_feature_div').text() + $('#productDetailsTable').text());
    const pagesMatch = printLength.match(/(\d+)\s*pages/i);
    if (pagesMatch) totalPages = parseInt(pagesMatch[1]);

    title = title
      .replace(/\s*-\s*(Amazon\.com|Buy|Kindle).*$/i, '')
      .replace(/:\s+.{60,}$/, '')
      .trim();

    if (!author && !title) {
      throw new Error(
        "Amazon blocked the request (likely a CAPTCHA). " +
        "Try a Goodreads or StoryGraph link instead, or add the book manually with `/book add` and the `pages` option."
      );
    }
  }

  // ── Generic fallback author ────────────────────────────────────────────────
  if (!author) {
    author =
      $('meta[name="author"]').attr('content')?.trim() ||
      $('[itemprop="author"]').first().text().trim() ||
      '';
  }

  if (!title || title.length < 2) throw new Error('Could not extract a book title from that URL.');

  return {
    title:       title.slice(0, 200),
    author:      author.slice(0, 200) || 'Unknown Author',
    coverUrl,
    description: description ? description.slice(0, 600) : null,
    totalPages,
    sourceUrl:   url,
  };
}

/**
 * Determine what kind of book URL this is, for user-facing labels.
 */
function detectPlatform(url) {
  if (url.includes('goodreads.com'))     return 'Goodreads';
  if (url.includes('thestorygraph.com')) return 'StoryGraph';
  if (url.includes('amazon.com') || url.includes('amazon.co')) return 'Amazon';
  return 'Web';
}

/**
 * Try to fetch a user's currently-reading shelf from Goodreads via RSS.
 * Goodreads RSS feeds are still publicly available.
 */
async function fetchGoodreadsCurrentlyReading(userId) {
  const feedUrl = `https://www.goodreads.com/review/list_rss/${userId}?shelf=currently-reading`;
  try {
    const { data } = await axios.get(feedUrl, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 8000,
    });
    const $ = cheerio.load(data, { xmlMode: true });
    const books = [];
    $('item').each((_, el) => {
      const title   = $(el).find('title').text().trim();
      const link    = $(el).find('link').text().trim();
      const imgMatch = $(el).find('description').text().match(/src="([^"]+)"/);
      books.push({ title, link, cover: imgMatch ? imgMatch[1] : null });
    });
    return books.slice(0, 5);
  } catch {
    return null;
  }
}

module.exports = { scrapeBookFromUrl, detectPlatform, fetchGoodreadsCurrentlyReading };
