const {
  SlashCommandBuilder,
  EmbedBuilder,
} = require('discord.js');
const db = require('../database');

const NUM_EMOJI = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣'];

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
    .setName('poll')
    .setDescription('Run a vote for the next book')
    // ── /poll start ───────────────────────────────────────────────────────
    .addSubcommand(sub =>
      sub.setName('start')
        .setDescription('Start a new book poll (uses books from the library)')
        .addStringOption(opt =>
          opt.setName('book_ids')
            .setDescription('Comma-separated book IDs to include (e.g. 1,2,3). Leave blank to pick the last 5.')
            .setRequired(false))
        .addStringOption(opt =>
          opt.setName('title')
            .setDescription('Optional poll title')
            .setRequired(false)))
    // ── /poll status ──────────────────────────────────────────────────────
    .addSubcommand(sub =>
      sub.setName('status')
        .setDescription('Check current standings of the active poll'))
    // ── /poll close ───────────────────────────────────────────────────────
    .addSubcommand(sub =>
      sub.setName('close')
        .setDescription('Close the active poll and announce the winner'))
    // ── /poll reset ───────────────────────────────────────────────────────
    .addSubcommand(sub =>
      sub.setName('reset')
        .setDescription('Force-clear a stuck or orphaned active poll (admin use)')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    // ── START ─────────────────────────────────────────────────────────────────
    if (sub === 'start') {
      // Check if a poll is already running
      const existing = db.polls.getActive.get(interaction.guildId);
      if (existing) {
        return interaction.reply({
          content: `⚠️ There's already an active poll in this server! Use \`/poll close\` to close it first, or \`/poll status\` to check standings.`,
          ephemeral: true,
        });
      }

      await interaction.deferReply();

      // Figure out which books to include
      let books = [];
      const idsInput = interaction.options.getString('book_ids');

      if (idsInput) {
        const ids = idsInput.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
        for (const id of ids) {
          const book = db.books.get.get(id, interaction.guildId);
          if (book) books.push(book);
        }
        if (!books.length) {
          return interaction.editReply('❌ None of those book IDs were found in this server\'s library.');
        }
      } else {
        // Default: last 5 non-current books
        const all = db.books.list.all(interaction.guildId).filter(b => !b.is_current);
        books = all.slice(0, 9);
      }

      if (books.length < 2) {
        return interaction.editReply('❌ Need at least 2 books to run a poll. Add more with `/book add <url>`.');
      }

      // Cap at 9 options (we have 9 number emojis)
      books = books.slice(0, 9);

      const pollTitle = interaction.options.getString('title') || '📊 Book Club Vote — What should we read next?';

      // Build embed
      const lines = books.map((b, i) => {
        let entry = `${NUM_EMOJI[i]} **${b.title}**\n*${b.author}*${b.total_pages ? ` · ${b.total_pages}p` : ''}`;
        const desc = truncateLines(b.description, 3);
        if (desc) entry += `\n${desc}`;
        const genres = formatGenres(b.genres);
        if (genres) entry += `\n${genres}`;
        return entry;
      });

      const embed = new EmbedBuilder()
        .setColor(0x6B46C1)
        .setTitle(pollTitle)
        .setDescription(lines.join('\n\n'))
        .setFooter({ text: 'React with the number to vote! · Poll closes when an admin runs /poll close' })
        .setTimestamp();

      // Add cover thumbnails from first book if available
      const firstCover = books.find(b => b.cover_url);
      if (firstCover) embed.setThumbnail(firstCover.cover_url);

      const message = await interaction.editReply({ embeds: [embed] });

      // Create poll record
      const pollResult = db.polls.create.run(interaction.guildId, interaction.channelId);
      const pollId = pollResult.lastInsertRowid;
      db.polls.setMessageId.run(message.id, pollId);

      // Add options and react
      for (let i = 0; i < books.length; i++) {
        db.polls.addOption.run(pollId, books[i].id, NUM_EMOJI[i]);
        await message.react(NUM_EMOJI[i]);
      }

      return; // reactions act as the confirmation
    }

    // ── STATUS ────────────────────────────────────────────────────────────────
    if (sub === 'status') {
      const poll = db.polls.getActive.get(interaction.guildId);
      if (!poll) {
        return interaction.reply({ content: '📭 No active poll right now. Start one with `/poll start`!', ephemeral: true });
      }

      const options = db.polls.getOptions.all(poll.id);
      await syncVotesFromMessage(interaction.client, poll, options);
      const updated = db.polls.getOptions.all(poll.id);

      const embed = buildStandingsEmbed(updated, '📊 Current Poll Standings', 0x6B46C1);
      return interaction.reply({ embeds: [embed] });
    }

    // ── RESET ─────────────────────────────────────────────────────────────────
    if (sub === 'reset') {
      const poll = db.polls.getActive.get(interaction.guildId);
      if (!poll) {
        return interaction.reply({ content: '📭 No active poll to reset.', ephemeral: true });
      }
      db.polls.close.run(poll.id);
      return interaction.reply({
        content: '🔄 Stuck poll has been cleared. You can now start a new one with `/poll start`.',
        ephemeral: true,
      });
    }

    // ── CLOSE ─────────────────────────────────────────────────────────────────
    if (sub === 'close') {
      const poll = db.polls.getActive.get(interaction.guildId);
      if (!poll) {
        return interaction.reply({ content: '📭 No active poll to close.', ephemeral: true });
      }

      const options = db.polls.getOptions.all(poll.id);
      await syncVotesFromMessage(interaction.client, poll, options);
      db.polls.close.run(poll.id);

      const updated = db.polls.getOptions.all(poll.id);
      const winner  = updated.sort((a, b) => b.votes - a.votes)[0];

      // Set the winner as current book
      if (winner) {
        db.books.setCurrent.run(winner.book_id, interaction.guildId);
      }

      const embed = buildStandingsEmbed(updated, '🏆 Poll Closed — Results', 0xF6C90E);

      if (winner) {
        embed.addFields({
          name: '🎉 Winner',
          value: `**${winner.title}** is now set as the current book!\nLog your progress with \`/progress log\`.`,
        });
      }

      return interaction.reply({ embeds: [embed] });
    }
  },

  // Exported so index.js can call this on reaction events
  async handleReactionAdd(reaction, user) {
    const messageId = reaction.message.id;
    const poll = db.polls.getByMessage.get(messageId);
    if (!poll || poll.status !== 'active') return;

    const emoji  = reaction.emoji.name;
    const option = db.polls.getOptionByEmoji.get(poll.id, emoji);
    if (!option) return;

    // Just record — we sync all votes when status/close is called
    // (counting via Discord reactions is the source of truth)
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Fetch real vote counts from the Discord message reactions and sync to DB.
 */
async function syncVotesFromMessage(client, poll, options) {
  try {
    const channel = await client.channels.fetch(poll.channel_id);
    const message = await channel.messages.fetch(poll.message_id);

    for (const option of options) {
      const reaction = message.reactions.cache.get(option.emoji);
      // Subtract 1 for the bot's own reaction
      const votes = reaction ? Math.max(0, reaction.count - 1) : 0;
      db.polls.updateVotes.run(votes, poll.id, option.emoji);
    }
  } catch {
    // Message may have been deleted — use stored vote counts as fallback
  }
}

function buildStandingsEmbed(options, title, color) {
  const sorted = [...options].sort((a, b) => b.votes - a.votes);
  const total  = sorted.reduce((sum, o) => sum + o.votes, 0);

  const lines = sorted.map((o) => {
    const pct = total > 0 ? Math.round((o.votes / total) * 100) : 0;
    const bar = buildBar(pct);
    return `${o.emoji} **${o.title}** — ${o.votes} vote${o.votes !== 1 ? 's' : ''} (${pct}%)\n${bar}`;
  });

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(lines.length ? lines.join('\n\n') : '*No options found — the poll may be corrupted. Use `/poll reset` to clear it.*')
    .setTimestamp();
}

function buildBar(pct) {
  const filled = Math.round(pct / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ${pct}%`;
}
