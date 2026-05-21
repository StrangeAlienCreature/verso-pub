const axios = require('axios');
const cheerio = require('cheerio');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const BROWSER_HEADERS = {
  'User-Agent':      USER_AGENT,
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
};

function extractAsin(url) {
  const match = url.match(/\/(?:dp|product|gp\/product)\/([A-Z0-9]{10})/i);
  return match ? match[1].toUpperCase() : null;
}

// ThriftBooks URL: /w/book-title_author-name/product-id/
// Returns { title, author } extracted from the URL slug.
function extractFromThriftBooksUrl(url) {
  const match = url.match(/thriftbooks\.com\/w\/([^/]+)\//i);
  if (!match) return {};
  const slug = match[1];
  const lastUnderscore = slug.lastIndexOf('_');
  const slugToWords = s => s.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  if (lastUnderscore === -1) return { title: slugToWords(slug) };
  return {
    title:  slugToWords(slug.slice(0, lastUnderscore)),
    author: slugToWords(slug.slice(lastUnderscore + 1)),
  };
}

// Extract title slug from Amazon URL e.g. /Crescent-City-House-Earth/dp/...
function extractTitleSlugFromAmazonUrl(url) {
  const match = url.match(/amazon\.com(?:\..*?)?\/([A-Za-z0-9-]+)\/(?:dp|product)/i);
  if (!match) return null;
  const slug = match[1].replace(/-/g, ' ').trim();
  // Ignore slugs that look like ASINs or are too short
  return slug.length > 4 && !/^[A-Z0-9]{10}$/i.test(slug) ? slug : null;
}

async function fetchOpenLibrary(isbn) {
  const { data } = await axios.get(
    `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`,
    { headers: { 'User-Agent': USER_AGENT }, timeout: 8000 }
  );
  const book = data[`ISBN:${isbn}`];
  if (!book) return null;
  const genres = (book.subjects || [])
    .map(s => (typeof s === 'string' ? s : s.name || '').trim())
    .filter(s => s && s.length <= 35 && !/^\d/.test(s))
    .slice(0, 3);
  return {
    title:       book.title,
    author:      book.authors?.[0]?.name || '',
    coverUrl:    book.cover?.large || book.cover?.medium || null,
    description: (book.description?.value ?? book.description) || null,
    totalPages:  book.number_of_pages || null,
    genres,
  };
}

async function fetchGoogleBooks(query) {
  const { data } = await axios.get(
    `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=1`,
    { headers: { 'User-Agent': USER_AGENT }, timeout: 8000 }
  );
  const item = data.items?.[0]?.volumeInfo;
  if (!item) return null;
  const genres = (item.categories || [])
    .flatMap(c => c.split('/').map(p => p.trim()))
    .filter(s => s && s.length <= 35)
    .slice(0, 3);
  return {
    title:       item.title,
    author:      item.authors?.[0] || '',
    coverUrl:    item.imageLinks?.thumbnail?.replace('http:', 'https:') || null,
    description: item.description || null,
    totalPages:  item.pageCount || null,
    genres,
  };
}

/**
 * Scrape book metadata from a Goodreads, StoryGraph, Amazon, or ThriftBooks URL.
 * Falls back to og:meta tags which work on most book pages.
 */
async function scrapeBookFromUrl(url) {
  const { data: html } = await axios.get(url, {
    headers: BROWSER_HEADERS,
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
  let genres      = [];

  // ── Goodreads ──────────────────────────────────────────────────────────────
  if (url.includes('goodreads.com')) {
    author =
      $('[data-testid="name"]').first().text().trim() ||
      $('[itemprop="author"] [itemprop="name"]').first().text().trim() ||
      $('.authorName span[itemprop="name"]').first().text().trim();

    const pagesText =
      $('[data-testid="pagesFormat"]').text() ||
      $('[itemprop="numberOfPages"]').text();
    const pagesMatch = pagesText.match(/(\d+)\s*pages/i);
    if (pagesMatch) totalPages = parseInt(pagesMatch[1]);

    // GR often appends "by Author Name" to og:title
    title = title.replace(/\s+by\s+.+$/, '').trim();
  }

  // ── StoryGraph ─────────────────────────────────────────────────────────────
  else if (url.includes('thestorygraph.com')) {
    // og:title is typically "Book Title by Author Name | The StoryGraph"
    // Extract author from that before stripping it
    const rawTitle = ogTitle || '';
    const stripped = rawTitle.replace(/\s*\|\s*The StoryGraph$/i, '').trim();
    const byIdx = stripped.lastIndexOf(' by ');
    if (byIdx > 0) {
      title  = stripped.slice(0, byIdx).trim();
      author = stripped.slice(byIdx + 4).trim();
    } else {
      title = stripped;
    }

    // CSS selector fallbacks in case the og:title format changes
    if (!author) {
      author =
        $('[class*="book-title-author"] a').first().text().trim() ||
        $('a[href*="/authors/"]').first().text().trim() ||
        $('p.font-bold').first().text().trim();
    }

    const pagesText = $('p').filter((_, el) => $(el).text().includes('pages')).first().text();
    const pagesMatch = pagesText.match(/(\d+)\s*pages/i);
    if (pagesMatch) totalPages = parseInt(pagesMatch[1]);
  }

  // ── ThriftBooks ────────────────────────────────────────────────────────────
  // ThriftBooks blocks scraper requests (406), so extract title+author from the
  // URL slug and look up full metadata via Google Books instead.
  else if (url.includes('thriftbooks.com')) {
    const { title: slugTitle, author: slugAuthor } = extractFromThriftBooksUrl(url);
    if (slugTitle) {
      const query = slugAuthor ? `intitle:${slugTitle} inauthor:${slugAuthor}` : `intitle:${slugTitle}`;
      const gbData = await fetchGoogleBooks(query).catch(() => null);
      if (gbData) return { ...gbData, sourceUrl: url };
      // Google Books found nothing — return what we have from the URL
      return {
        title:       slugTitle.slice(0, 200),
        author:      (slugAuthor || 'Unknown Author').slice(0, 200),
        coverUrl:    null,
        description: null,
        totalPages:  null,
        sourceUrl:   url,
      };
    }
    throw new Error('Could not extract book info from that ThriftBooks URL.');
  }

  // ── Amazon ─────────────────────────────────────────────────────────────────
  else if (url.includes('amazon.com') || url.includes('amazon.co')) {
    const asin = extractAsin(url);

    // Print-book ASINs are ISBN-10s — try Open Library first, then Google Books
    if (asin && !/^B/i.test(asin)) {
      const olData = await fetchOpenLibrary(asin).catch(() => null);
      if (olData) {
        if (!olData.description) {
          const gbData = await fetchGoogleBooks(`isbn:${asin}`).catch(() => null);
          if (gbData?.description) olData.description = gbData.description;
        }
        return { ...olData, sourceUrl: url };
      }

      const gbData = await fetchGoogleBooks(`isbn:${asin}`).catch(() => null);
      if (gbData) return { ...gbData, sourceUrl: url };
    }

    // Kindle ASIN (B...) — search Google Books by title slug from URL
    if (asin && /^B/i.test(asin)) {
      const titleSlug = extractTitleSlugFromAmazonUrl(url);
      if (titleSlug) {
        const gbData = await fetchGoogleBooks(`intitle:${titleSlug}`).catch(() => null);
        if (gbData) return { ...gbData, sourceUrl: url };
      }
    }

    // Last resort: best-effort HTML parse (often blocked by Amazon)
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
        'Amazon blocked the request. Try a Goodreads or StoryGraph link instead.'
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

  // Supplement missing/short description and genres via Google Books
  if ((!description || description.length < 200 || !genres.length) && title) {
    const q = [title, author].filter(Boolean).join(' ');
    const gbData = await fetchGoogleBooks(q).catch(() => null);
    if (gbData) {
      if (gbData.description && gbData.description.length > (description?.length ?? 0)) {
        description = gbData.description;
      }
      if (!genres.length && gbData.genres?.length) genres = gbData.genres;
    }
  }

  return {
    title:       title.slice(0, 200),
    author:      author.slice(0, 200) || 'Unknown Author',
    coverUrl,
    description: description ? description.slice(0, 1500) : null,
    totalPages,
    genres,
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
  if (url.includes('thriftbooks.com'))   return 'ThriftBooks';
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

/**
 * Look up a book by ISBN-10 or ISBN-13.
 * Tries Open Library first (no rate limits), falls back to Google Books.
 */
async function fetchBookByIsbn(raw) {
  const isbn = raw.replace(/[-\s]/g, '');
  if (!/^\d{9}[\dX]$|^\d{13}$/.test(isbn)) return null;

  const olData = await fetchOpenLibrary(isbn).catch(() => null);
  if (olData) {
    if (!olData.description) {
      const gbIsbn = await fetchGoogleBooks(`isbn:${isbn}`).catch(() => null);
      if (gbIsbn?.description) {
        olData.description = gbIsbn.description;
      } else if (olData.title) {
        const gbTitle = await fetchGoogleBooks([olData.title, olData.author].filter(Boolean).join(' ')).catch(() => null);
        if (gbTitle?.description) olData.description = gbTitle.description;
      }
    }
    return olData;
  }

  const gbData = await fetchGoogleBooks(`isbn:${isbn}`).catch(() => null);
  if (gbData) return gbData;

  return null;
}

module.exports = { scrapeBookFromUrl, detectPlatform, fetchGoodreadsCurrentlyReading, fetchBookByIsbn };
