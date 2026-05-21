const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const db = require('../database');
const { scrapeBookFromUrl, fetchBookByIsbn, searchBooksByTitle } = require('../utils/scraper');

const NUM_EMOJI = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];

// Button custom ID prefixes — userId is appended so only the requester can confirm
const BTN_ADD    = 'book_confirm_add';
const BTN_NEXT   = 'book_confirm_next';
const BTN_CANCEL = 'book_confirm_cancel';

// In-memory store for pending search confirmations: userId → { results, index, pages, guildId }
const pendingSearches = new Map();

function truncateLines(text, lines) {
  if (!text) return null;
  const limit = lines * 65;
  return text.length <= limit ? text : text.slice(0, limit).replace(/\s+\S*$/, '') + '…';
}

function formatGenres(genresJson) {
  if (!genresJson) return null;
  try {
    const arr = typeof genresJson === 'string' ? JSON.parse(genresJson) : genresJson;
    return arr.length ? arr.map(g => `\`${g}\``).join(' ') : null;
  } catch { return null; }
}

function formatPublishedDate(dateStr) {
  if (!dateStr) return null;
  const parts = dateStr.split('-');
  if (parts.length === 1) return parts[0];
  try {
    const d = new Date(dateStr.length === 7 ? dateStr + '-01' : dateStr);
    return d.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return dateStr; }
}

function formatAddedAt(addedAt) {
  if (!addedAt) return null;
  try {
    const d = new Date(addedAt.replace(' ', 'T') + 'Z');
    return d.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return null; }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('book')
    .setDescription('Manage the server book list')
    // ── /book add ─────────────────────────────────────────────────────────
    .addSubcommandGroup(group =>
      group.setName('add')
        .setDescription('Add a book to the server library')
        .addSubcommand(sub =>
          sub.setName('search')
            .setDescription('Search for a book by title to add')
            .addStringOption(opt =>
              opt.setName('name')
                .setDescription('Book title to search for')
                .setRequired(true))
            .addIntegerOption(opt =>
              opt.setName('pages')
                .setDescription('Total pages (override if not detected)')
                .setRequired(false)))
        .addSubcommand(sub =>
          sub.setName('url')
            .setDescription('Add a book via URL (Goodreads, ThriftBooks, Amazon)')
            .addStringOption(opt =>
              opt.setName('url')
                .setDescription('Paste the book URL')
                .setRequired(true))
            .addIntegerOption(opt =>
              opt.setName('pages')
                .setDescription('Total pages (if not automatically detected)')
                .setRequired(false)))
        .addSubcommand(sub =>
          sub.setName('isbn')
            .setDescription('Add a book by ISBN')
            .addStringOption(opt =>
              opt.setName('isbn')
                .setDescription('ISBN-10 or ISBN-13 (hyphens optional, e.g. 9780765326355)')
                .setRequired(true))
            .addIntegerOption(opt =>
              opt.setName('pages')
                .setDescription('Total pages (if not automatically detected)')
                .setRequired(false))))
    // ── /book list ────────────────────────────────────────────────────────
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('Show all books in the server library'))
    // ── /book current ─────────────────────────────────────────────────────
    .addSubcommand(sub =>
      sub.setName('current')
        .setDescription('View or set the current book being read')
        .addIntegerOption(opt =>
          opt.setName('id')
            .setDescription('Book ID to set as current (leave blank to just view)')
            .setRequired(false)))
    // ── /book info ────────────────────────────────────────────────────────
    .addSubcommand(sub =>
      sub.setName('info')
        .setDescription('View details for a specific book')
        .addIntegerOption(opt =>
          opt.setName('id')
            .setDescription('Book ID')
            .setRequired(true)))
    // ── /book setpages ────────────────────────────────────────────────────
    .addSubcommand(sub =>
      sub.setName('setpages')
        .setDescription('Update the total page count for a book')
        .addIntegerOption(opt =>
          opt.setName('id').setDescription('Book ID').setRequired(true))
        .addIntegerOption(opt =>
          opt.setName('pages').setDescription('Total pages').setRequired(true)))
    // ── /book remove ──────────────────────────────────────────────────────
    .addSubcommand(sub =>
      sub.setName('remove')
        .setDescription('Remove a book from the server library')
        .addIntegerOption(opt =>
          opt.setName('id')
            .setDescription('Book ID to remove')
            .setRequired(true))),

  async execute(interaction) {
    const subGroup = interaction.options.getSubcommandGroup(false);
    const sub      = interaction.options.getSubcommand();

    // ── ADD ──────────────────────────────────────────────────────────────────
    if (subGroup === 'add') {
      await interaction.deferReply();
      const pages = interaction.options.getInteger('pages');

      // ── SEARCH ─────────────────────────────────────────────────────────────
      if (sub === 'search') {
        const query = interaction.options.getString('name').trim();
        let results;
        try {
          results = await searchBooksByTitle(query, 5);
        } catch (err) {
          return interaction.editReply(`❌ Search failed: ${err.message}`);
        }

        if (!results.length) {
          return interaction.editReply(`❌ No books found for **"${query}"**. Try a different title, or use \`/book add isbn\`.`);
        }

        pendingSearches.set(interaction.user.id, {
          results,
          index: 0,
          pages,
          guildId: interaction.guildId,
        });

        const { embed, components } = buildSearchConfirmEmbed(results[0], 0, results.length, interaction.user.id);
        return interaction.editReply({ embeds: [embed], components });
      }

      // ── URL / ISBN ──────────────────────────────────────────────────────────
      let bookData;
      try {
        if (sub === 'isbn') {
          const isbn = interaction.options.getString('isbn').trim();
          bookData = await fetchBookByIsbn(isbn);
          if (!bookData) return interaction.editReply(`❌ No book found for ISBN \`${isbn}\`. Double-check the number and try again.`);
          bookData.sourceUrl = `https://books.google.com/books?q=isbn:${isbn.replace(/[-\s]/g, '')}`;
        } else {
          const url = interaction.options.getString('url').trim();
          bookData  = await scrapeBookFromUrl(url);
        }
      } catch (err) {
        return interaction.editReply(`❌ **Couldn't fetch book info:** ${err.message}\n\nTry \`/book add isbn\` or \`/book add search\` instead.`);
      }

      if (pages) bookData.totalPages = pages;

      const result = db.books.add.run({
        guild_id:       interaction.guildId,
        title:          bookData.title,
        author:         bookData.author,
        cover_url:      bookData.coverUrl,
        description:    bookData.description,
        source_url:     bookData.sourceUrl,
        total_pages:    bookData.totalPages,
        added_by:       interaction.user.id,
        genres:         JSON.stringify(bookData.genres || []),
        published_date: bookData.publishedDate || null,
      });

      const embed = new EmbedBuilder()
        .setColor(0x6B46C1)
        .setTitle(`📚 Added: ${bookData.title}`)
        .addFields(
          { name: 'Author',   value: bookData.author,                         inline: true },
          { name: 'Book ID',  value: `\`${result.lastInsertRowid}\``,         inline: true },
        )
        .setFooter({ text: `Added by ${interaction.user.displayName}` })
        .setTimestamp();

      if (bookData.totalPages) embed.addFields({ name: 'Pages', value: `${bookData.totalPages}`, inline: true });
      const genreText = formatGenres(bookData.genres);
      if (genreText) embed.addFields({ name: 'Genres', value: genreText, inline: false });
      if (bookData.description) embed.setDescription(truncateLines(bookData.description, 6));
      if (bookData.coverUrl) embed.setThumbnail(bookData.coverUrl);

      const buttons = buildBookButtons(bookData.title, bookData.author);
      return interaction.editReply({ embeds: [embed], components: [buttons] });
    }

    // ── LIST ─────────────────────────────────────────────────────────────────
    if (sub === 'list') {
      const books = db.books.list.all(interaction.guildId);

      if (!books.length) {
        return interaction.reply({ content: '📭 The library is empty. Add a book with `/book add search`, `/book add url`, or `/book add isbn`!', ephemeral: true });
      }

      const current = books.find(b => b.is_current);
      const rest    = books.filter(b => !b.is_current);
      const allBooks = [...(current ? [current] : []), ...rest];
      const shown    = allBooks.slice(0, 10);
      const overflow = allBooks.length - shown.length;

      let upcomingLabelGiven = false;
      const embeds = shown.map(b => {
        const isCurrent = !!b.is_current;
        const meta = [`by **${b.author}**`];
        if (b.total_pages) meta.push(`${b.total_pages}p`);
        meta.push(`ID \`${b.id}\``);

        const embed = new EmbedBuilder()
          .setColor(isCurrent ? 0x22C55E : 0x6B46C1)
          .setTitle(b.title)
          .setDescription(meta.join(' · '));

        if (b.cover_url) embed.setThumbnail(b.cover_url);

        if (isCurrent) {
          embed.setAuthor({ name: '📖 Currently Reading' });
        } else if (!upcomingLabelGiven) {
          upcomingLabelGiven = true;
          embed.setAuthor({ name: `📚 Upcoming (${rest.length} book${rest.length !== 1 ? 's' : ''})` });
        }

        return embed;
      });

      const footerText = overflow
        ? `+${overflow} more not shown · /book info <id> for details`
        : 'Use /book info <id> for details · /poll start to run a vote';
      embeds[embeds.length - 1].setFooter({ text: footerText }).setTimestamp();

      return interaction.reply({
        content: `## 📚 ${interaction.guild.name} Book Club Library`,
        embeds,
      });
    }

    // ── CURRENT ───────────────────────────────────────────────────────────────
    if (sub === 'current') {
      const bookId = interaction.options.getInteger('id');

      if (bookId) {
        const book = db.books.get.get(bookId, interaction.guildId);
        if (!book) return interaction.reply({ content: `❌ No book with ID \`${bookId}\` found.`, ephemeral: true });

        db.books.setCurrent.run(bookId, interaction.guildId);

        const embed = buildBookEmbed(book, `✅ Now reading: ${book.title}`);
        const buttons = buildBookButtons(book.title, book.author);
        return interaction.reply({ embeds: [embed], components: [buttons] });
      }

      const current = db.books.getCurrent.get(interaction.guildId);
      if (!current) {
        return interaction.reply({ content: '📭 No current book set. Use `/book current id:<book_id>` to set one.', ephemeral: true });
      }

      const embed = buildBookEmbed(current, `📖 Currently Reading`);
      const buttons = buildBookButtons(current.title, current.author);
      return interaction.reply({ embeds: [embed], components: [buttons] });
    }

    // ── INFO ──────────────────────────────────────────────────────────────────
    if (sub === 'info') {
      const bookId = interaction.options.getInteger('id');
      const book   = db.books.get.get(bookId, interaction.guildId);

      if (!book) return interaction.reply({ content: `❌ No book with ID \`${bookId}\` found.`, ephemeral: true });

      const embed = buildBookEmbed(book, book.is_current ? `📖 ${book.title} (Current Book)` : `📚 ${book.title}`);
      const buttons = buildBookButtons(book.title, book.author);
      return interaction.reply({ embeds: [embed], components: [buttons] });
    }

    // ── SETPAGES ──────────────────────────────────────────────────────────────
    if (sub === 'setpages') {
      const bookId = interaction.options.getInteger('id');
      const pages  = interaction.options.getInteger('pages');
      const book   = db.books.get.get(bookId, interaction.guildId);

      if (!book) return interaction.reply({ content: `❌ No book with ID \`${bookId}\` found.`, ephemeral: true });

      db.books.updatePages.run(pages, bookId, interaction.guildId);
      return interaction.reply(`✅ Updated **${book.title}** to **${pages} pages**.`);
    }

    // ── REMOVE ────────────────────────────────────────────────────────────────
    if (sub === 'remove') {
      const bookId = interaction.options.getInteger('id');
      const book   = db.books.get.get(bookId, interaction.guildId);

      if (!book) return interaction.reply({ content: `❌ No book with ID \`${bookId}\` found.`, ephemeral: true });

      db.books.remove.run(bookId, interaction.guildId);
      return interaction.reply(`🗑️ Removed **${book.title}** from the library.`);
    }
  },

  async handleInteraction(interaction) {
    if (!interaction.isButton()) return;
    const { customId, user, guildId } = interaction;

    // ── CONFIRM ADD ───────────────────────────────────────────────────────────
    if (customId.startsWith(`${BTN_ADD}:`)) {
      const ownerId = customId.split(':')[1];
      if (user.id !== ownerId) {
        return interaction.reply({ content: '❌ This isn\'t your search — run `/book add search` to start your own.', ephemeral: true });
      }

      const pending = pendingSearches.get(ownerId);
      if (!pending) {
        return interaction.reply({ content: '❌ This search has expired. Please run `/book add search` again.', ephemeral: true });
      }

      const bookData = pending.results[pending.index];
      if (pending.pages) bookData.totalPages = pending.pages;
      pendingSearches.delete(ownerId);

      const result = db.books.add.run({
        guild_id:       guildId,
        title:          bookData.title,
        author:         bookData.author,
        cover_url:      bookData.coverUrl,
        description:    bookData.description,
        source_url:     bookData.sourceUrl,
        total_pages:    bookData.totalPages,
        added_by:       user.id,
        genres:         JSON.stringify(bookData.genres || []),
        published_date: bookData.publishedDate || null,
      });

      const embed = new EmbedBuilder()
        .setColor(0x6B46C1)
        .setAuthor({ name: 'Book Added!' })
        .setTitle(bookData.title)
        .setURL(bookData.sourceUrl);

      const desc = truncateLines(bookData.description, 6);
      if (desc) embed.setDescription(desc);

      embed.addFields(
        { name: 'Author',  value: bookData.author || 'Unknown',            inline: true },
        { name: 'Pages',   value: bookData.totalPages ? `${bookData.totalPages}` : 'Unknown', inline: true },
        { name: 'Book ID', value: `\`${result.lastInsertRowid}\``,         inline: true },
      );

      const pub = formatPublishedDate(bookData.publishedDate);
      if (pub) embed.addFields({ name: 'Published', value: pub, inline: true });
      embed.addFields(
        { name: 'Submitted By', value: `<@${user.id}>`,                            inline: true },
        { name: 'Submitted On', value: new Date().toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' }), inline: true },
      );

      const genreText = formatGenres(bookData.genres);
      if (genreText) embed.addFields({ name: 'Genres', value: genreText });
      if (bookData.coverUrl) embed.setImage(bookData.coverUrl);
      embed.setTimestamp();

      const buttons = buildBookButtons(bookData.title, bookData.author);
      return interaction.update({ embeds: [embed], components: [buttons] });
    }

    // ── NEXT RESULT ───────────────────────────────────────────────────────────
    if (customId.startsWith(`${BTN_NEXT}:`)) {
      const ownerId = customId.split(':')[1];
      if (user.id !== ownerId) {
        return interaction.reply({ content: '❌ This isn\'t your search — run `/book add search` to start your own.', ephemeral: true });
      }

      const pending = pendingSearches.get(ownerId);
      if (!pending) {
        return interaction.reply({ content: '❌ This search has expired. Please run `/book add search` again.', ephemeral: true });
      }

      pending.index = (pending.index + 1) % pending.results.length;
      const { embed, components } = buildSearchConfirmEmbed(pending.results[pending.index], pending.index, pending.results.length, ownerId);
      return interaction.update({ embeds: [embed], components });
    }

    // ── CANCEL ────────────────────────────────────────────────────────────────
    if (customId.startsWith(`${BTN_CANCEL}:`)) {
      const ownerId = customId.split(':')[1];
      if (user.id !== ownerId) {
        return interaction.reply({ content: '❌ This isn\'t your search.', ephemeral: true });
      }

      pendingSearches.delete(ownerId);
      const embed = new EmbedBuilder().setColor(0x6B46C1).setTitle('Search cancelled.');
      return interaction.update({ embeds: [embed], components: [] });
    }
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildSearchConfirmEmbed(bookData, index, total, userId) {
  const embed = new EmbedBuilder()
    .setColor(0x6B46C1)
    .setAuthor({ name: `Result ${index + 1} of ${total} · Is this the right book?` })
    .setTitle(bookData.title)
    .setURL(bookData.sourceUrl);

  const desc = truncateLines(bookData.description, 6);
  if (desc) embed.setDescription(desc);

  embed.addFields(
    { name: 'Author', value: bookData.author || 'Unknown', inline: true },
    { name: 'Pages',  value: bookData.totalPages ? `${bookData.totalPages}` : 'Unknown', inline: true },
  );

  const pub = formatPublishedDate(bookData.publishedDate);
  if (pub) embed.addFields({ name: 'Published', value: pub, inline: true });

  const genreText = formatGenres(bookData.genres);
  if (genreText) embed.addFields({ name: 'Genres', value: genreText });

  if (bookData.coverUrl) embed.setImage(bookData.coverUrl);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${BTN_ADD}:${userId}`)
      .setLabel('Yes, add this book')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${BTN_NEXT}:${userId}`)
      .setLabel(total > 1 ? `Next result` : 'Search again')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${BTN_CANCEL}:${userId}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Danger),
  );

  return { embed, components: [row] };
}

function buildBookEmbed(book, title) {
  const embed = new EmbedBuilder()
    .setColor(book.is_current ? 0x22C55E : 0x6B46C1)
    .setTitle(title);

  if (book.source_url && !book.source_url.includes('googleapis.com')) {
    embed.setURL(book.source_url);
  }

  const descText = truncateLines(book.description, 6);
  if (descText) embed.setDescription(descText);

  // Row 1: Author | Pages | Book ID
  embed.addFields({ name: 'Author', value: book.author || 'Unknown', inline: true });
  if (book.total_pages) embed.addFields({ name: 'Pages', value: `${book.total_pages}`, inline: true });
  embed.addFields({ name: 'Book ID', value: `\`${book.id}\``, inline: true });

  // Row 2: Published | Submitted By | Submitted On
  const pub = formatPublishedDate(book.published_date);
  if (pub) embed.addFields({ name: 'Published', value: pub, inline: true });
  if (book.added_by) embed.addFields({ name: 'Submitted By', value: `<@${book.added_by}>`, inline: true });
  const addedOn = formatAddedAt(book.added_at);
  if (addedOn) embed.addFields({ name: 'Submitted On', value: addedOn, inline: true });

  // Row 3: Status
  embed.addFields({ name: 'Status', value: book.is_current ? '📖 Currently Reading' : '📚 Upcoming', inline: true });

  const genreText = formatGenres(book.genres);
  if (genreText) embed.addFields({ name: 'Genres', value: genreText });

  if (book.cover_url) embed.setImage(book.cover_url);
  embed.setTimestamp();
  return embed;
}

function buildBookButtons(title, author) {
  const query = encodeURIComponent(`${title} ${author}`);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Amazon')
      .setStyle(ButtonStyle.Link)
      .setURL(`https://www.amazon.com/s?k=${query}`),
    new ButtonBuilder()
      .setLabel('ThriftBooks')
      .setStyle(ButtonStyle.Link)
      .setURL(`https://www.thriftbooks.com/browse/?b.search=${query}`),
    new ButtonBuilder()
      .setLabel('Barnes & Noble')
      .setStyle(ButtonStyle.Link)
      .setURL(`https://www.barnesandnoble.com/s/${query}`),
    new ButtonBuilder()
      .setLabel('Goodreads')
      .setStyle(ButtonStyle.Link)
      .setURL(`https://www.goodreads.com/search?q=${query}`),
  );
}
