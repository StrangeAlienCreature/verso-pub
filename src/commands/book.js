const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const db = require('../database');
const { scrapeBookFromUrl, detectPlatform } = require('../utils/scraper');

// Number emojis for display
const NUM_EMOJI = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('book')
    .setDescription('Manage the server book list')
    // ── /book add ─────────────────────────────────────────────────────────
    .addSubcommand(sub =>
      sub.setName('add')
        .setDescription('Add a book via URL (Goodreads, StoryGraph, or Amazon)')
        .addStringOption(opt =>
          opt.setName('url')
            .setDescription('Paste the book URL')
            .setRequired(true))
        .addIntegerOption(opt =>
          opt.setName('pages')
            .setDescription('Total pages (if not automatically detected)')
            .setRequired(false)))
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
    const sub = interaction.options.getSubcommand();

    // ── ADD ──────────────────────────────────────────────────────────────────
    if (sub === 'add') {
      await interaction.deferReply();

      const url   = interaction.options.getString('url');
      const pages = interaction.options.getInteger('pages');
      const platform = detectPlatform(url);

      let bookData;
      try {
        bookData = await scrapeBookFromUrl(url);
      } catch (err) {
        return interaction.editReply(`❌ **Couldn't fetch book info:** ${err.message}\n\nMake sure the URL is a public book page.`);
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
      });

      const embed = new EmbedBuilder()
        .setColor(0x6B46C1)
        .setTitle(`📚 Added: ${bookData.title}`)
        .addFields(
          { name: 'Author',   value: bookData.author,                           inline: true },
          { name: 'Book ID',  value: `\`${result.lastInsertRowid}\``,           inline: true },
          { name: 'Source',   value: platform,                                  inline: true },
        )
        .setFooter({ text: `Added by ${interaction.user.displayName}` })
        .setTimestamp();

      if (bookData.totalPages) embed.addFields({ name: 'Pages', value: `${bookData.totalPages}`, inline: true });
      if (bookData.description) embed.setDescription(bookData.description.slice(0, 600) + (bookData.description.length > 600 ? '…' : ''));
      if (bookData.coverUrl) embed.setThumbnail(bookData.coverUrl);

      return interaction.editReply({ embeds: [embed] });
    }

    // ── LIST ─────────────────────────────────────────────────────────────────
    if (sub === 'list') {
      const books = db.books.list.all(interaction.guildId);

      if (!books.length) {
        return interaction.reply({ content: '📭 The library is empty. Add a book with `/book add <url>`!', ephemeral: true });
      }

      const current = books.find(b => b.is_current);
      const rest    = books.filter(b => !b.is_current);

      const lines = [];
      if (current) {
        lines.push(`📖 **Currently Reading**`);
        lines.push(`\`${String(current.id).padStart(3)}\` **${current.title}** — ${current.author}` +
          (current.total_pages ? ` *(${current.total_pages}p)*` : ''));
        lines.push('');
      }

      if (rest.length) {
        lines.push(`📚 **Upcoming Books** (${rest.length} book${rest.length !== 1 ? 's' : ''})`);
        rest.forEach(b => {
          lines.push(`\`${String(b.id).padStart(3)}\` **${b.title}** — ${b.author}` +
            (b.total_pages ? ` *(${b.total_pages}p)*` : ''));
        });
      }

      const embed = new EmbedBuilder()
        .setColor(0x6B46C1)
        .setTitle(`📚 ${interaction.guild.name} Book Club Library`)
        .setDescription(lines.join('\n'))
        .setFooter({ text: 'Use /book info <id> for details · /poll start to run a vote' })
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    }

    // ── CURRENT ───────────────────────────────────────────────────────────────
    if (sub === 'current') {
      const bookId = interaction.options.getInteger('id');

      if (bookId) {
        const book = db.books.get.get(bookId, interaction.guildId);
        if (!book) return interaction.reply({ content: `❌ No book with ID \`${bookId}\` found.`, ephemeral: true });

        db.books.setCurrent.run(bookId, interaction.guildId);

        const embed = buildBookEmbed(book, `✅ Now reading: ${book.title}`);
        return interaction.reply({ embeds: [embed] });
      }

      const current = db.books.getCurrent.get(interaction.guildId);
      if (!current) {
        return interaction.reply({ content: '📭 No current book set. Use `/book current id:<book_id>` to set one.', ephemeral: true });
      }

      const embed = buildBookEmbed(current, `📖 Currently Reading`);
      return interaction.reply({ embeds: [embed] });
    }

    // ── INFO ──────────────────────────────────────────────────────────────────
    if (sub === 'info') {
      const bookId = interaction.options.getInteger('id');
      const book   = db.books.get.get(bookId, interaction.guildId);

      if (!book) return interaction.reply({ content: `❌ No book with ID \`${bookId}\` found.`, ephemeral: true });

      const embed = buildBookEmbed(book, book.is_current ? `📖 ${book.title} (Current Book)` : `📚 ${book.title}`);
      return interaction.reply({ embeds: [embed] });
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

function buildBookEmbed(book, title) {
  const embed = new EmbedBuilder()
    .setColor(0x6B46C1)
    .setTitle(title)
    .addFields(
      { name: 'Author', value: book.author || 'Unknown', inline: true },
      { name: 'ID',     value: `\`${book.id}\``,          inline: true },
    );

  if (book.total_pages) embed.addFields({ name: 'Pages', value: `${book.total_pages}`, inline: true });
  if (book.description) embed.setDescription(book.description.slice(0, 600) + (book.description?.length > 600 ? '…' : ''));
  if (book.cover_url)   embed.setThumbnail(book.cover_url);
  if (book.source_url)  embed.addFields({ name: 'Link', value: `[View Book](${book.source_url})`, inline: false });

  embed.setTimestamp();
  return embed;
}
