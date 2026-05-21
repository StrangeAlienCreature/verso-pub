const { EmbedBuilder } = require('discord.js');
const db = require('../database');

function parseAmount(input, bookTotalPages) {
  input = input.trim();
  if (input.endsWith('%')) {
    const pct = parseFloat(input);
    if (isNaN(pct) || pct < 0 || pct > 100) return null;
    return { page: null, percent: pct };
  }
  if (input.includes('/')) {
    const [a, b] = input.split('/').map(Number);
    if (isNaN(a) || isNaN(b) || b <= 0) return null;
    return { page: a, percent: Math.min(100, (a / b) * 100) };
  }
  const page = parseInt(input);
  if (isNaN(page) || page < 0) return null;
  const pct = bookTotalPages ? Math.min(100, (page / bookTotalPages) * 100) : null;
  return { page, percent: pct };
}

module.exports = async function handleDnf(interaction) {
  const bookId    = interaction.options.getInteger('book_id');
  const note      = interaction.options.getString('note');
  const stoppedAt = interaction.options.getString('stopped_at');

  let book;
  if (bookId) {
    book = db.books.get.get(bookId, interaction.guildId);
    if (!book) return interaction.reply({ content: `\u274c No book with ID \`${bookId}\`.`, ephemeral: true });
  } else {
    book = db.books.getCurrent.get(interaction.guildId);
    if (!book) return interaction.reply({ content: '\u274c No current book set.', ephemeral: true });
  }

  let stoppedPct = null;
  if (stoppedAt) {
    const parsed = parseAmount(stoppedAt, book.total_pages);
    stoppedPct = parsed?.percent ?? null;
  } else {
    const prog = db.progress.get.get(interaction.guildId, interaction.user.id, book.id);
    stoppedPct = prog?.percent ?? null;
  }

  db.dnf.upsert.run({
    guild_id:           interaction.guildId,
    user_id:            interaction.user.id,
    book_id:            book.id,
    stopped_at_percent: stoppedPct,
    note:               note ?? null,
  });

  const stopLabel = stoppedPct !== null ? `${Math.round(stoppedPct)}%` : 'an unknown point';
  const embed = new EmbedBuilder()
    .setColor(0x949ba4)
    .setTitle(`\uD83D\uDCD5 DNF \u2014 ${book.title}`)
    .setDescription(`No worries \u2014 not every book clicks.\n\nYou stopped at **${stopLabel}**. You can still leave a rating with \`/rate book\`.`)
    .setFooter({ text: `${interaction.user.displayName} \u00b7 Use /rate book to leave a review anyway` })
    .setTimestamp();

  if (note) embed.addFields({ name: '\uD83D\uDCAC Why you stopped', value: note });
  if (book.cover_url) embed.setThumbnail(book.cover_url);

  return interaction.reply({ embeds: [embed] });
};
