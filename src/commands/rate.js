const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../database');

const STAR_DISPLAY = {
  0.5: '½⭐',  1: '⭐',  1.5: '⭐½',
  2: '⭐⭐', 2.5: '⭐⭐½', 3: '⭐⭐⭐',
  3.5: '⭐⭐⭐½', 4: '⭐⭐⭐⭐', 4.5: '⭐⭐⭐⭐½',
  5: '⭐⭐⭐⭐⭐',
};

function starsToEmoji(n) {
  const rounded = Math.round(n * 2) / 2;
  return STAR_DISPLAY[rounded] ?? '⭐'.repeat(Math.round(n));
}

function ratingBar(avg, count) {
  const filled = Math.round((avg / 5) * 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ${avg.toFixed(1)}/5`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rate')
    .setDescription('Rate and review books')
    // ── /rate book ────────────────────────────────────────────────────────
    .addSubcommand(sub =>
      sub.setName('book')
        .setDescription('Leave a star rating and optional review')
        .addNumberOption(opt =>
          opt.setName('stars')
            .setDescription('Rating from 0.5 to 5 stars')
            .setRequired(true)
            .setMinValue(0.5)
            .setMaxValue(5))
        .addStringOption(opt =>
          opt.setName('review')
            .setDescription('Your review (no spoilers in here — use the spoiler thread for those!)')
            .setRequired(false))
        .addIntegerOption(opt =>
          opt.setName('book_id')
            .setDescription('Book to rate (defaults to current book)')
            .setRequired(false)))
    // ── /rate view ────────────────────────────────────────────────────────
    .addSubcommand(sub =>
      sub.setName('view')
        .setDescription('See all ratings for a book')
        .addIntegerOption(opt =>
          opt.setName('book_id')
            .setDescription('Book to view (defaults to current book)')
            .setRequired(false)))
    // ── /rate remove ──────────────────────────────────────────────────────
    .addSubcommand(sub =>
      sub.setName('remove')
        .setDescription('Remove your rating for a book')
        .addIntegerOption(opt =>
          opt.setName('book_id')
            .setDescription('Book ID (defaults to current book)')
            .setRequired(false))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    // ── BOOK (rate) ───────────────────────────────────────────────────────────
    if (sub === 'book') {
      const starsRaw = interaction.options.getNumber('stars');
      const review   = interaction.options.getString('review');
      const bookId   = interaction.options.getInteger('book_id');

      // Round to nearest 0.5
      const stars = Math.round(starsRaw * 2) / 2;

      const book = resolveBook(bookId, interaction.guildId);
      if (!book) return noBookReply(interaction, bookId);

      // Check they've actually read (or DNF'd) the book
      const progress = db.progress.get.get(interaction.guildId, interaction.user.id, book.id);
      const dnf      = db.dnf.get.get(interaction.guildId, interaction.user.id, book.id);
      if (!progress && !dnf) {
        return interaction.reply({
          content: `📖 You need to log some progress on **${book.title}** before rating it.\nUse \`/progress log\` or \`/progress dnf\` first.`,
          ephemeral: true,
        });
      }

      db.ratings.upsert.run({
        guild_id: interaction.guildId,
        user_id:  interaction.user.id,
        book_id:  book.id,
        stars,
        review:   review ?? null,
      });

      const avg = db.ratings.getAverage.get(interaction.guildId, book.id);
      const bar = ratingBar(avg.avg, avg.count);

      const embed = new EmbedBuilder()
        .setColor(0x6B46C1)
        .setTitle(`${starsToEmoji(stars)} Rating saved — ${book.title}`)
        .addFields(
          { name: 'Your rating', value: `${starsToEmoji(stars)} (${stars}/5)`, inline: true },
          { name: 'Server average', value: `${bar} · ${avg.count} rating${avg.count !== 1 ? 's' : ''}`, inline: false },
        )
        .setFooter({ text: interaction.user.displayName })
        .setTimestamp();

      if (review)          embed.setDescription(`*"${review}"*`);
      if (book.cover_url)  embed.setThumbnail(book.cover_url);

      return interaction.reply({ embeds: [embed] });
    }

    // ── VIEW ──────────────────────────────────────────────────────────────────
    if (sub === 'view') {
      const bookId = interaction.options.getInteger('book_id');
      const book   = resolveBook(bookId, interaction.guildId);
      if (!book) return noBookReply(interaction, bookId);

      const allRatings = db.ratings.getForBook.all(interaction.guildId, book.id);
      const dnfCount   = db.dnf.getCountForBook.get(interaction.guildId, book.id)?.count ?? 0;

      if (!allRatings.length) {
        return interaction.reply({
          content: `📭 No ratings yet for **${book.title}**. Be the first with \`/rate book\`!`,
        });
      }

      const avg = db.ratings.getAverage.get(interaction.guildId, book.id);
      const bar = ratingBar(avg.avg, avg.count);

      // Build distribution
      const dist = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
      for (const r of allRatings) dist[Math.round(r.stars)] = (dist[Math.round(r.stars)] ?? 0) + 1;
      const distLines = [5, 4, 3, 2, 1].map(n => {
        const pct = Math.round((dist[n] / allRatings.length) * 10);
        return `${'⭐'.repeat(n)} ${'█'.repeat(pct)}${'░'.repeat(10 - pct)} ${dist[n]}`;
      });

      // Individual reviews (only those with text)
      const withReviews = allRatings.filter(r => r.review);
      const reviewLines = [];
      for (const r of withReviews.slice(0, 4)) {
        const member = await interaction.guild.members.fetch(r.user_id).catch(() => null);
        const name   = member?.displayName ?? 'Unknown';
        reviewLines.push(`${starsToEmoji(r.stars)} **${name}:** *"${r.review.slice(0, 120)}${r.review.length > 120 ? '…' : ''}"*`);
      }

      const embed = new EmbedBuilder()
        .setColor(0x6B46C1)
        .setTitle(`${starsToEmoji(Math.round(avg.avg * 2) / 2)} ${book.title} — Ratings`)
        .addFields(
          { name: 'Average', value: bar, inline: false },
          { name: 'Distribution', value: distLines.join('\n'), inline: false },
        )
        .setFooter({ text: `${avg.count} rating${avg.count !== 1 ? 's' : ''}${dnfCount ? ` · ${dnfCount} DNF` : ''}` })
        .setTimestamp();

      if (reviewLines.length) {
        embed.addFields({ name: '💬 Reviews', value: reviewLines.join('\n\n'), inline: false });
      }
      if (book.cover_url) embed.setThumbnail(book.cover_url);

      return interaction.reply({ embeds: [embed] });
    }

    // ── REMOVE ────────────────────────────────────────────────────────────────
    if (sub === 'remove') {
      const bookId = interaction.options.getInteger('book_id');
      const book   = resolveBook(bookId, interaction.guildId);
      if (!book) return noBookReply(interaction, bookId);

      const existing = db.ratings.get.get(interaction.guildId, interaction.user.id, book.id);
      if (!existing) {
        return interaction.reply({ content: `📭 You haven't rated **${book.title}** yet.`, ephemeral: true });
      }

      db.ratings.delete.run(interaction.guildId, interaction.user.id, book.id);
      return interaction.reply({ content: `🗑️ Your rating for **${book.title}** has been removed.`, ephemeral: true });
    }
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveBook(bookId, guildId) {
  if (bookId) return db.books.get.get(bookId, guildId);
  return db.books.getCurrent.get(guildId);
}

function noBookReply(interaction, bookId) {
  return interaction.reply({
    content: bookId
      ? `❌ No book with ID \`${bookId}\`.`
      : '❌ No current book set. Use `/book current id:<id>` or specify a `book_id`.',
    ephemeral: true,
  });
}
