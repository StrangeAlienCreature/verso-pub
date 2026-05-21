const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../database');
const handleDnf = require('./dnfHandler');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('progress')
    .setDescription('Track and view reading progress')
    .addSubcommand(sub =>
      sub.setName('log')
        .setDescription("Log how far you've read")
        .addStringOption(opt =>
          opt.setName('amount')
            .setDescription('Page number (e.g. 150), percentage (e.g. 45%), or fraction (e.g. 150/400)')
            .setRequired(true))
        .addIntegerOption(opt =>
          opt.setName('book_id')
            .setDescription('Book ID (defaults to the current book)')
            .setRequired(false))
        .addStringOption(opt =>
          opt.setName('note')
            .setDescription('Optional note (spoiler-free!)')
            .setRequired(false)))
    .addSubcommand(sub =>
      sub.setName('view')
        .setDescription("View your (or someone else's) reading progress")
        .addUserOption(opt =>
          opt.setName('user')
            .setDescription('User to check (defaults to you)')
            .setRequired(false))
        .addIntegerOption(opt =>
          opt.setName('book_id')
            .setDescription('Specific book ID (defaults to current book)')
            .setRequired(false)))
    .addSubcommand(sub =>
      sub.setName('board')
        .setDescription('Leaderboard for the current book')
        .addIntegerOption(opt =>
          opt.setName('book_id')
            .setDescription('Book ID (defaults to current book)')
            .setRequired(false)))
    .addSubcommand(sub =>
      sub.setName('dnf')
        .setDescription('Mark a book as Did Not Finish')
        .addIntegerOption(opt =>
          opt.setName('book_id')
            .setDescription('Book to DNF (defaults to current book)')
            .setRequired(false))
        .addStringOption(opt =>
          opt.setName('stopped_at')
            .setDescription('How far you got before stopping (e.g. 45%, 120, 120/400)')
            .setRequired(false))
        .addStringOption(opt =>
          opt.setName('note')
            .setDescription('Why you stopped (optional, spoiler-free)')
            .setRequired(false))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'dnf') return handleDnf(interaction);

    // ── LOG ───────────────────────────────────────────────────────────────────
    if (sub === 'log') {
      const amount = interaction.options.getString('amount');
      const bookId = interaction.options.getInteger('book_id');
      const note   = interaction.options.getString('note');

      let book;
      if (bookId) {
        book = db.books.get.get(bookId, interaction.guildId);
        if (!book) return interaction.reply({ content: `\u274c No book with ID \`${bookId}\`.`, ephemeral: true });
      } else {
        book = db.books.getCurrent.get(interaction.guildId);
        if (!book) {
          return interaction.reply({
            content: '\u274c No current book set. Use `/book current id:<id>` to set one, or specify a `book_id`.',
            ephemeral: true,
          });
        }
      }

      const parsed = parseAmount(amount, book.total_pages);
      if (!parsed) {
        return interaction.reply({
          content: [
            "\u274c Couldn't parse that progress amount. Try one of:",
            '\u2022 **Page number:** `150`',
            '\u2022 **Percentage:** `45%`',
            '\u2022 **Fraction:** `150/400`',
          ].join('\n'),
          ephemeral: true,
        });
      }

      const { page, totalPages, percent } = parsed;

      db.progress.upsert.run({
        guild_id:     interaction.guildId,
        user_id:      interaction.user.id,
        book_id:      book.id,
        current_page: page,
        total_pages:  totalPages || book.total_pages,
        percent:      percent,
        note:         note || null,
      });

      db.progress.log.run(interaction.guildId, interaction.user.id, book.id, percent, note);

      const effectiveTotal = totalPages || book.total_pages;
      const bar = buildProgressBar(percent);

      const lines = [
        `\uD83D\uDCD6 **${book.title}**`,
        '',
        bar,
        '',
        page && effectiveTotal
          ? `Page **${page}** of **${effectiveTotal}** (${Math.round(percent)}%)`
          : page
          ? `Page **${page}**`
          : `**${Math.round(percent)}%** complete`,
      ];
      if (note) lines.push(`\n\uD83D\uDCAC *"${note}"*`);

      const embed = new EmbedBuilder()
        .setColor(percentToColor(percent))
        .setTitle('\u2705 Progress logged!')
        .setDescription(lines.join('\n'))
        .setFooter({ text: interaction.user.displayName })
        .setTimestamp();

      if (book.cover_url) embed.setThumbnail(book.cover_url);
      if (percent >= 100) embed.setTitle('\uD83C\uDF89 You finished the book!').setColor(0xF6C90E);

      return interaction.reply({ embeds: [embed] });
    }

    // ── VIEW ──────────────────────────────────────────────────────────────────
    if (sub === 'view') {
      const target = interaction.options.getUser('user') || interaction.user;
      const bookId = interaction.options.getInteger('book_id');

      let book;
      if (bookId) {
        book = db.books.get.get(bookId, interaction.guildId);
        if (!book) return interaction.reply({ content: `\u274c No book with ID \`${bookId}\`.`, ephemeral: true });
      } else {
        book = db.books.getCurrent.get(interaction.guildId);
      }

      if (book) {
        const prog = db.progress.get.get(interaction.guildId, target.id, book.id);
        const dnf  = db.dnf.get.get(interaction.guildId, target.id, book.id);

        if (!prog && !dnf) {
          return interaction.reply({
            content: `\uD83D\uDCED ${target.id === interaction.user.id ? "You haven't" : `${target.displayName} hasn't`} logged progress for **${book.title}** yet.`,
            ephemeral: true,
          });
        }

        if (dnf) {
          const pct = dnf.stopped_at_percent;
          const embed = new EmbedBuilder()
            .setColor(0x949ba4)
            .setTitle(`\uD83D\uDCD5 DNF \u2014 ${book.title}`)
            .setDescription(`Stopped at **${pct !== null ? Math.round(pct) + '%' : 'unknown point'}**`)
            .setFooter({ text: target.displayName })
            .setTimestamp();
          if (dnf.note) embed.addFields({ name: 'Note', value: dnf.note });
          if (book.cover_url) embed.setThumbnail(book.cover_url);
          return interaction.reply({ embeds: [embed] });
        }

        const embed = buildProgressEmbed(prog, book, target);
        return interaction.reply({ embeds: [embed] });
      } else {
        const allProgress = db.progress.getUserAll.all(interaction.guildId, target.id);
        if (!allProgress.length) {
          return interaction.reply({
            content: '\uD83D\uDCED No progress logged yet. Use `/progress log` to track your reading!',
            ephemeral: true,
          });
        }

        const lines = allProgress.map(p => {
          const pct = p.percent !== null ? `${Math.round(p.percent)}%` : `page ${p.current_page}`;
          return `\uD83D\uDCDA **${p.title}** \u2014 ${pct} \u00b7 *${timeSince(p.updated_at)}*`;
        });

        const embed = new EmbedBuilder()
          .setColor(0x6B46C1)
          .setTitle(`\uD83D\uDCD6 ${target.displayName}'s Reading History`)
          .setDescription(lines.join('\n'))
          .setTimestamp();

        return interaction.reply({ embeds: [embed] });
      }
    }

    // ── BOARD ─────────────────────────────────────────────────────────────────
    if (sub === 'board') {
      const bookId = interaction.options.getInteger('book_id');

      let book;
      if (bookId) {
        book = db.books.get.get(bookId, interaction.guildId);
        if (!book) return interaction.reply({ content: `\u274c No book with ID \`${bookId}\`.`, ephemeral: true });
      } else {
        book = db.books.getCurrent.get(interaction.guildId);
      }

      if (!book) {
        return interaction.reply({ content: '\uD83D\uDCED No current book set. Use `/book current id:<id>` first.', ephemeral: true });
      }

      const allProgress = db.progress.getForBook.all(interaction.guildId, book.id);
      const dnfList     = db.dnf.getForBook.all(interaction.guildId, book.id);

      if (!allProgress.length && !dnfList.length) {
        return interaction.reply({ content: `\uD83D\uDCED No one has logged progress for **${book.title}** yet!` });
      }

      const medals = ['\uD83E\uDD47', '\uD83E\uDD48', '\uD83E\uDD49'];
      const lines  = [];

      for (let i = 0; i < allProgress.length; i++) {
        const p     = allProgress[i];
        const medal = medals[i] || `${i + 1}.`;
        const pct   = p.percent !== null ? Math.round(p.percent) : null;
        const bar   = buildProgressBar(pct, 8);
        const label = pct !== null ? `${pct}%` : (p.current_page ? `page ${p.current_page}` : '?');

        const member = await interaction.guild.members.fetch(p.user_id).catch(() => null);
        const name   = member?.displayName || `User ${p.user_id.slice(-4)}`;

        lines.push(`${medal} **${name}** \u2014 ${label}\n${bar}`);
      }

      if (dnfList.length) {
        lines.push('');
        lines.push(`\uD83D\uDCD5 **Did Not Finish (${dnfList.length})**`);
        for (const d of dnfList) {
          const member = await interaction.guild.members.fetch(d.user_id).catch(() => null);
          const name   = member?.displayName || `User ${d.user_id.slice(-4)}`;
          const pct    = d.stopped_at_percent !== null ? ` \u2014 stopped at ${Math.round(d.stopped_at_percent)}%` : '';
          lines.push(`\u00a0\u00a0${name}${pct}`);
        }
      }

      const embed = new EmbedBuilder()
        .setColor(0x6B46C1)
        .setTitle(`\uD83D\uDCCA Reading Leaderboard \u2014 ${book.title}`)
        .setDescription(lines.join('\n\n'))
        .setFooter({ text: `${allProgress.length} reader${allProgress.length !== 1 ? 's' : ''} logged${dnfList.length ? ` \u00b7 ${dnfList.length} DNF` : ''}` })
        .setTimestamp();

      if (book.cover_url) embed.setThumbnail(book.cover_url);
      return interaction.reply({ embeds: [embed] });
    }
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseAmount(input, bookTotalPages) {
  input = input.trim();
  if (input.endsWith('%')) {
    const pct = parseFloat(input);
    if (isNaN(pct) || pct < 0 || pct > 100) return null;
    const page = bookTotalPages ? Math.round((pct / 100) * bookTotalPages) : null;
    return { page, totalPages: null, percent: pct };
  }
  if (input.includes('/')) {
    const [a, b] = input.split('/').map(Number);
    if (isNaN(a) || isNaN(b) || b <= 0) return null;
    const pct = Math.min(100, (a / b) * 100);
    return { page: a, totalPages: b, percent: pct };
  }
  const page = parseInt(input);
  if (isNaN(page) || page < 0) return null;
  const total = bookTotalPages || null;
  const pct   = total ? Math.min(100, (page / total) * 100) : null;
  return { page, totalPages: null, percent: pct };
}

function buildProgressBar(percent, length = 12) {
  if (percent === null) return '\u2591'.repeat(length) + ' ?%';
  const filled = Math.round((Math.min(100, percent) / 100) * length);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(length - filled) + ` ${Math.round(percent)}%`;
}

function percentToColor(pct) {
  if (pct === null) return 0x6B46C1;
  if (pct >= 100)   return 0xF6C90E;
  if (pct >= 75)    return 0x22C55E;
  if (pct >= 50)    return 0x3B82F6;
  if (pct >= 25)    return 0xA855F7;
  return 0x6B46C1;
}

function buildProgressEmbed(prog, book, user) {
  const pct = prog.percent;
  const bar = buildProgressBar(pct);
  const effectiveTotal = prog.total_pages || book.total_pages;
  const details = prog.current_page && effectiveTotal
    ? `Page **${prog.current_page}** of **${effectiveTotal}** (${Math.round(pct)}%)`
    : prog.current_page
    ? `Page **${prog.current_page}**`
    : pct !== null
    ? `**${Math.round(pct)}%** complete`
    : 'No data';

  const embed = new EmbedBuilder()
    .setColor(percentToColor(pct))
    .setTitle(`\uD83D\uDCD6 ${user.displayName}'s Progress \u2014 ${book.title}`)
    .setDescription(`${bar}\n\n${details}`)
    .setTimestamp(new Date(prog.updated_at));

  if (book.cover_url) embed.setThumbnail(book.cover_url);
  if (prog.note)      embed.addFields({ name: '\uD83D\uDCAC Note', value: prog.note });
  return embed;
}

function timeSince(dateStr) {
  const ms   = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60)  return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)   return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
