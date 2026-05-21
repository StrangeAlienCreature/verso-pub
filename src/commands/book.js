const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const db = require('../database');
const { scrapeBookFromUrl, fetchBookByIsbn } = require('../utils/scraper');

// Number emojis for display
const NUM_EMOJI = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];

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

module.exports = {
  data: new SlashCommandBuilder()
    .setName('book')
    .setDescription('Manage the server book list')
    // ── /book add ─────────────────────────────────────────────────────────
    .addSubcommandGroup(group =>
      group.setName('add')
        .setDescription('Add a book to the server library')
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
      let bookData;

      try {
        if (sub === 'isbn') {
          const isbn = interaction.options.getString('isbn').trim();
          bookData = await fetchBookByIsbn(isbn);
          if (!bookData) return interaction.editReply(`❌ No book found for ISBN \`${isbn}\`. Double-check the number and try again.`);
          bookData.sourceUrl = `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn.replace(/[-\s]/g, '')}`;
        } else {
          const url = interaction.options.getString('url').trim();
          bookData  = await scrapeBookFromUrl(url);
        }
      } catch (err) {
        return interaction.editReply(`❌ **Couldn't fetch book info:** ${err.message}\n\nTry \`/book add isbn\` instead.`);
      }

      if (pages) bookData.totalPages = pages;

      const result = db.books.add.run({
        guild_id:    interaction.guildId,
        title:       bookData.title,
        author:      bookData.author,
        cover_url:   bookData.coverUrl,
        description: bookData.description,
        source_url:  bookData.sourceUrl,
        total_pages: bookData.totalPages,
        added_by:    interaction.user.id,
        genres:      JSON.stringify(bookData.genres || []),
      });

      const embed = new EmbedBuilder()
        .setColor(0x6B46C1)
        .setTitle(`📚 Added: ${bookData.title}`)
        .addFields(
          { name: 'Author',   value: bookData.author,                           inline: true },
          { name: 'Book ID',  value: `\`${result.lastInsertRowid}\``,           inline: true },
        )
        .setFooter({ text: `Added by ${interaction.user.displayName}` })
        .setTimestamp();

      if (bookData.totalPages) embed.addFields({ name: 'Pages', value: `${bookData.totalPages}`, inline: true });
      const genreText = formatGenres(bookData.genres);
      if (genreText) embed.addFields({ name: 'Genres', value: genreText, inline: false });
      if (bookData.description) embed.setDescription(bookData.description);
      if (bookData.coverUrl) embed.setThumbnail(bookData.coverUrl);

      const buttons = buildBookButtons(bookData.title, bookData.author);
      return interaction.editReply({ embeds: [embed], components: [buttons] });
    }

    // ── LIST ─────────────────────────────────────────────────────────────────
    if (sub === 'list') {
      const books = db.books.list.all(interaction.guildId);

      if (!books.length) {
        return interaction.reply({ content: '📭 The library is empty. Add a book with `/book add url` or `/book add isbn`!', ephemeral: true });
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
};

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function buildBookEmbed(book, title) {
  const embed = new EmbedBuilder()
    .setColor(0x6B46C1)
    .setTitle(title)
    .addFields(
      { name: 'Author', value: book.author || 'Unknown', inline: true },
      { name: 'ID',     value: `\`${book.id}\``,          inline: true },
    );

  if (book.total_pages) embed.addFields({ name: 'Pages', value: `${book.total_pages}`, inline: true });
  const genreText = formatGenres(book.genres);
  if (genreText) embed.addFields({ name: 'Genres', value: genreText, inline: false });
  const descText = truncateLines(book.description, 15);
  if (descText) embed.setDescription(descText);
  if (book.cover_url) embed.setThumbnail(book.cover_url);

  embed.setTimestamp();
  return embed;
}
