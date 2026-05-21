const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType,
} = require('discord.js');
const db = require('../database');

// Milestone definitions — pct is the MINIMUM progress to see this thread
const MILESTONES = [
  { pct: 0,   label: '📖 Start — Open to everyone',    emoji: '📖' },
  { pct: 25,  label: '¼ First quarter (25%+)',          emoji: '🟡' },
  { pct: 50,  label: '½ Halfway (50%+)',                emoji: '🟠' },
  { pct: 75,  label: '¾ Final stretch (75%+)',          emoji: '🔴' },
  { pct: 100, label: '✅ Finished — Full spoilers',     emoji: '✅' },
];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('discuss')
    .setDescription('Spoiler-safe discussion threads for the current book')
    .addSubcommand(sub =>
      sub.setName('create')
        .setDescription('Create milestone discussion threads for the current book (admin only)')
        .addIntegerOption(opt =>
          opt.setName('book_id')
            .setDescription('Book to create threads for (defaults to current)')
            .setRequired(false)))
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('See which discussion threads you can access based on your progress'))
    .addSubcommand(sub =>
      sub.setName('archive')
        .setDescription('Archive all threads for a finished book (admin only)')
        .addIntegerOption(opt =>
          opt.setName('book_id')
            .setDescription('Book ID')
            .setRequired(true))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    // ── CREATE ────────────────────────────────────────────────────────────────
    if (sub === 'create') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
        return interaction.reply({ content: '❌ You need **Manage Channels** permission to create discussion threads.', ephemeral: true });
      }

      const bookId = interaction.options.getInteger('book_id');
      const book   = bookId
        ? db.books.get.get(bookId, interaction.guildId)
        : db.books.getCurrent.get(interaction.guildId);

      if (!book) return interaction.reply({ content: '❌ No book found. Set a current book first.', ephemeral: true });

      // Check for existing threads
      const existing = db.threads.getForBook.all(interaction.guildId, book.id);
      if (existing.length) {
        return interaction.reply({
          content: `⚠️ Discussion threads already exist for **${book.title}**. Use \`/discuss list\` to see them.`,
          ephemeral: true,
        });
      }

      await interaction.deferReply();

      const channel = interaction.channel;
      const createdThreads = [];

      for (const milestone of MILESTONES) {
        try {
          const thread = await channel.threads.create({
            name: `${milestone.emoji} ${book.title} — ${milestone.label}`,
            type: ChannelType.PublicThread,
            reason: `Book club discussion thread for ${book.title}`,
          });

          // Opening message in each thread
          const openMsg = buildThreadOpener(book, milestone);
          await thread.send({ embeds: [openMsg] });

          db.threads.add.run(
            interaction.guildId,
            book.id,
            thread.id,
            milestone.pct,
            milestone.label,
          );

          createdThreads.push({ thread, milestone });
        } catch (err) {
          console.error(`Failed to create thread for milestone ${milestone.pct}:`, err);
        }
      }

      const lines = createdThreads.map(({ thread, milestone }) =>
        `${milestone.emoji} <#${thread.id}> — unlocks at ${milestone.pct === 0 ? 'any progress' : `${milestone.pct}%`}`
      );

      const embed = new EmbedBuilder()
        .setColor(0x6B46C1)
        .setTitle(`💬 Discussion threads created — ${book.title}`)
        .setDescription(lines.join('\n'))
        .addFields({
          name: 'How it works',
          value:
            'Members can see all threads, but the bot will warn anyone posting in a thread they haven\'t "unlocked" yet.\n\n' +
            'Lock your progress with `/progress log` to earn access to higher threads.',
        })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    // ── LIST ──────────────────────────────────────────────────────────────────
    if (sub === 'list') {
      const book = db.books.getCurrent.get(interaction.guildId);
      if (!book) {
        return interaction.reply({ content: '📭 No current book set.', ephemeral: true });
      }

      const threads   = db.threads.getForBook.all(interaction.guildId, book.id);
      if (!threads.length) {
        return interaction.reply({
          content: `📭 No discussion threads for **${book.title}** yet. An admin can create them with \`/discuss create\`.`,
          ephemeral: true,
        });
      }

      const progress = db.progress.get.get(interaction.guildId, interaction.user.id, book.id);
      const dnf      = db.dnf.get.get(interaction.guildId, interaction.user.id, book.id);
      const userPct  = progress?.percent ?? dnf?.stopped_at_percent ?? 0;

      const lines = threads.map(t => {
        const unlocked = userPct >= t.milestone_pct;
        const icon     = unlocked ? '🔓' : '🔒';
        const label    = unlocked
          ? `<#${t.thread_id}>`
          : `~~${t.label}~~ (need ${t.milestone_pct}%)`;
        return `${icon} ${label}`;
      });

      const embed = new EmbedBuilder()
        .setColor(0x6B46C1)
        .setTitle(`💬 Discussion — ${book.title}`)
        .setDescription(lines.join('\n'))
        .addFields({
          name: 'Your progress',
          value: userPct > 0
            ? `You're at **${Math.round(userPct)}%** — log more with \`/progress log\``
            : '📭 Log your progress with `/progress log` to unlock milestone threads',
        })
        .setTimestamp();

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // ── ARCHIVE ───────────────────────────────────────────────────────────────
    if (sub === 'archive') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
        return interaction.reply({ content: '❌ You need **Manage Channels** permission.', ephemeral: true });
      }

      const bookId = interaction.options.getInteger('book_id');
      const book   = db.books.get.get(bookId, interaction.guildId);
      if (!book) return interaction.reply({ content: `❌ No book with ID \`${bookId}\`.`, ephemeral: true });

      const threads = db.threads.getForBook.all(interaction.guildId, book.id);
      if (!threads.length) {
        return interaction.reply({ content: `📭 No threads found for **${book.title}**.`, ephemeral: true });
      }

      await interaction.deferReply();
      let archived = 0;

      for (const t of threads) {
        try {
          const thread = await interaction.guild.channels.fetch(t.thread_id);
          if (thread) {
            await thread.setArchived(true);
            archived++;
          }
        } catch {
          // Thread may already be gone
        }
      }

      db.threads.clearForBook.run(interaction.guildId, book.id);

      return interaction.editReply(`📦 Archived **${archived}** discussion thread${archived !== 1 ? 's' : ''} for **${book.title}**.`);
    }
  },

  // ── Called from index.js on every message in a thread ─────────────────────
  async handleThreadMessage(message) {
    if (message.author.bot) return;
    if (!message.channel.isThread()) return;

    const threadRecord = db.threads.getByThread.get(message.channel.id);
    if (!threadRecord || threadRecord.milestone_pct === 0) return; // open thread, no check needed

    const progress = db.progress.get.get(threadRecord.guild_id, message.author.id, threadRecord.book_id);
    const dnf      = db.dnf.get.get(threadRecord.guild_id, message.author.id, threadRecord.book_id);
    const userPct  = progress?.percent ?? dnf?.stopped_at_percent ?? 0;

    if (userPct < threadRecord.milestone_pct) {
      // Delete the message and DM the user
      await message.delete().catch(() => {});
      await message.author.send(
        `⚠️ **Spoiler protection** — your message in **#${message.channel.name}** was removed.\n\n` +
        `That thread requires **${threadRecord.milestone_pct}%** progress and you're at **${Math.round(userPct)}%**.\n` +
        `Log your progress with \`/progress log\` and post again once you've caught up! 📖`
      ).catch(() => {});
    }
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildThreadOpener(book, milestone) {
  const spoilerWarnings = {
    0:   'This thread is open to everyone — keep it **spoiler-free**! Jump to the higher threads to discuss specific plot points.',
    25:  'This thread is for readers who are **25% or more** through the book. Mild spoilers for the first quarter are okay here.',
    50:  'This thread is for readers who are **halfway or more** through the book. Spoilers up to the 50% mark are fair game.',
    75:  'This thread is for readers in the **final stretch (75%+)**. Major plot spoilers ahead — you\'ve been warned!',
    100: '🚨 **FULL SPOILERS** — This thread is for people who have **finished** the book. Everything is fair game here.',
  };

  return new EmbedBuilder()
    .setColor(milestone.pct === 100 ? 0xed4245 : milestone.pct >= 75 ? 0xff9900 : 0x6B46C1)
    .setTitle(`${milestone.emoji} ${book.title} — ${milestone.label}`)
    .setDescription(spoilerWarnings[milestone.pct])
    .addFields(
      { name: '📖 Book', value: `**${book.title}** by ${book.author}`, inline: true },
      { name: '🔓 Unlocks at', value: milestone.pct === 0 ? 'Any progress' : `${milestone.pct}%`, inline: true },
    )
    .setFooter({ text: 'The bot will remove messages from readers who haven\'t reached this milestone yet.' })
    .setTimestamp();
}
