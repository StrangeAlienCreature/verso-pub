// This file extends book.js with CW subcommand handling.
// Call handleCw(interaction) from book.js execute when sub === 'cw'

const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../database');

const COMMON_CWS = [
  'Violence', 'Death', 'Grief', 'Sexual content', 'Abuse',
  'Mental illness', 'Suicide', 'Addiction', 'Racism', 'War',
  'Animal harm', 'Child harm', 'Medical trauma', 'Pregnancy loss',
];

module.exports = async function handleCw(interaction) {
  const action = interaction.options.getString('action');
  const bookId = interaction.options.getInteger('book_id');
  const warning = interaction.options.getString('warning');

  let book;
  if (bookId) {
    book = db.books.get.get(bookId, interaction.guildId);
    if (!book) return interaction.reply({ content: `\u274c No book with ID \`${bookId}\`.`, ephemeral: true });
  } else {
    book = db.books.getCurrent.get(interaction.guildId);
    if (!book) return interaction.reply({ content: '\u274c No current book set.', ephemeral: true });
  }

  // ── ADD ──────────────────────────────────────────────────────────────────────
  if (action === 'add') {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
      return interaction.reply({ content: '\u274c You need **Manage Messages** permission to add content warnings.', ephemeral: true });
    }
    if (!warning) return interaction.reply({ content: '\u274c Provide a warning with the `warning` option.', ephemeral: true });

    db.cw.add.run(book.id, warning.trim(), interaction.user.id);

    const allCws = db.cw.getForBook.all(book.id);
    return interaction.reply({
      content: `\u26a0\ufe0f Added CW **"${warning}"** to **${book.title}**.\n\nAll warnings: ${allCws.map(w => `\`${w.warning}\``).join(', ')}`,
    });
  }

  // ── VIEW ──────────────────────────────────────────────────────────────────────
  if (action === 'view') {
    const cws = db.cw.getForBook.all(book.id);

    const embed = new EmbedBuilder()
      .setColor(0xff9900)
      .setTitle(`\u26a0\ufe0f Content Warnings \u2014 ${book.title}`)
      .setTimestamp();

    if (!cws.length) {
      embed.setDescription('No content warnings have been added for this book.\n\nAdmins can add them with `/book cw action:add`.');
    } else {
      embed.setDescription(cws.map(w => `\u2022 ${w.warning}`).join('\n'));
      embed.setFooter({ text: 'CWs are set by server admins, not guaranteed to be comprehensive' });
    }

    if (book.cover_url) embed.setThumbnail(book.cover_url);
    return interaction.reply({ embeds: [embed] });
  }

  // ── REMOVE ────────────────────────────────────────────────────────────────────
  if (action === 'remove') {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
      return interaction.reply({ content: '\u274c You need **Manage Messages** permission.', ephemeral: true });
    }

    const cws = db.cw.getForBook.all(book.id);
    if (!cws.length) return interaction.reply({ content: `\uD83D\uDCED No content warnings set for **${book.title}**.`, ephemeral: true });

    if (!warning) {
      // List them so admin can identify which to remove
      return interaction.reply({
        content: `Current CWs for **${book.title}**:\n${cws.map((w, i) => `\`${w.id}\` — ${w.warning}`).join('\n')}\n\nRe-run with \`warning:<ID number>\` to remove one, or \`warning:all\` to clear all.`,
        ephemeral: true,
      });
    }

    if (warning.toLowerCase() === 'all') {
      db.cw.clearAll.run(book.id);
      return interaction.reply(`\uD83D\uDDD1\ufe0f Cleared all content warnings for **${book.title}**.`);
    }

    const id = parseInt(warning);
    if (!isNaN(id)) {
      db.cw.remove.run(id, book.id);
      return interaction.reply({ content: `\u2705 Removed CW \`${id}\` from **${book.title}**.`, ephemeral: true });
    }

    return interaction.reply({ content: '\u274c Provide a warning ID or `all`.', ephemeral: true });
  }
};
