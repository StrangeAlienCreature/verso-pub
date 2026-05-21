const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
} = require('discord.js');
const db = require('../database');
const { scrapeBookFromUrl } = require('../utils/scraper');

// ── Wizard step state (in-memory, keyed by guildId+userId) ──────────────────
// Format: { step: 1|2|3, channelId, messageId }
const wizardSessions = new Map();

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Configure the Book Club bot for this server')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    // ── /setup wizard ─────────────────────────────────────────────────────
    .addSubcommand(sub =>
      sub.setName('wizard')
        .setDescription('Run the guided setup for your book club (admin only)'))
    // ── /setup nickname ───────────────────────────────────────────────────
    .addSubcommand(sub =>
      sub.setName('nickname')
        .setDescription("Change the bot's display name in this server")
        .addStringOption(opt =>
          opt.setName('name')
            .setDescription('New nickname (leave blank to reset to default)')
            .setRequired(false))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    // ── NICKNAME ──────────────────────────────────────────────────────────────
    if (sub === 'nickname') {
      const name = interaction.options.getString('name');

      try {
        await interaction.guild.members.me.setNickname(name ?? 'Verso');
        const display = name ?? 'Verso (default)';
        return interaction.reply({
          content: `✅ Bot display name updated to **${display}** in this server.`,
          ephemeral: true,
        });
      } catch (err) {
        return interaction.reply({
          content: `❌ Couldn't update the nickname. Make sure the bot's role is below yours in the role hierarchy.\n\`${err.message}\``,
          ephemeral: true,
        });
      }
    }

    // ── WIZARD ────────────────────────────────────────────────────────────────
    if (sub === 'wizard') {
      await sendWizardStep(interaction, 1);
    }
  },

  // ── Button + Modal handler (called from index.js) ─────────────────────────
  async handleInteraction(interaction) {
    // Wizard buttons
    if (interaction.isButton()) {
      const { customId } = interaction;

      if (customId === 'wizard_set_nickname') {
        const modal = new ModalBuilder()
          .setCustomId('modal_nickname')
          .setTitle('Set Bot Nickname');
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('nickname_input')
              .setLabel('Bot display name in this server')
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('e.g. Cozy Readers Bot')
              .setMaxLength(32)
              .setRequired(true)
          )
        );
        return interaction.showModal(modal);
      }

      if (customId === 'wizard_skip_nickname') {
        return sendWizardStep(interaction, 2, { update: true });
      }

      if (customId === 'wizard_add_book') {
        const modal = new ModalBuilder()
          .setCustomId('modal_add_book')
          .setTitle('Add Your First Book');
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('book_url_input')
              .setLabel('Book URL (Goodreads, StoryGraph, or Amazon)')
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('https://www.goodreads.com/book/show/…')
              .setRequired(true)
          )
        );
        return interaction.showModal(modal);
      }

      if (customId === 'wizard_skip_book') {
        return sendWizardStep(interaction, 3, { update: true });
      }

      if (customId === 'wizard_connect_storygraph') {
        const modal = new ModalBuilder()
          .setCustomId('modal_storygraph')
          .setTitle('Connect Your StoryGraph');
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('sg_username')
              .setLabel('Your StoryGraph username')
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('e.g. bookworm42')
              .setRequired(true)
          )
        );
        return interaction.showModal(modal);
      }

      if (customId === 'wizard_connect_goodreads') {
        const modal = new ModalBuilder()
          .setCustomId('modal_goodreads')
          .setTitle('Connect Your Goodreads');
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('gr_user_id')
              .setLabel('Your Goodreads numeric user ID')
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('e.g. 12345678  (from your profile URL)')
              .setRequired(true)
          )
        );
        return interaction.showModal(modal);
      }

      if (customId === 'wizard_skip_profile') {
        return sendWizardStep(interaction, 4, { update: true });
      }

      if (customId === 'wizard_done') {
        return interaction.update({
          embeds: [
            new EmbedBuilder()
              .setColor(0x23a55a)
              .setTitle('🎉 All set!')
              .setDescription(
                'Your book club is ready to go. Here\'s a quick cheat sheet:\n\n' +
                '`/book add <url>` — add a book from any URL\n' +
                '`/book list` — browse the library\n' +
                '`/poll start` — run a vote for next month\'s read\n' +
                '`/progress log 45%` — log your reading progress\n' +
                '`/progress board` — see the server leaderboard\n' +
                '`/profile connect` — link StoryGraph or Goodreads\n\n' +
                'Run `/setup wizard` anytime to revisit this flow.'
              )
              .setFooter({ text: 'Happy reading! 📚' }),
          ],
          components: [],
        });
      }
    }

    // Modal submissions
    if (interaction.isModalSubmit()) {
      const { customId } = interaction;

      if (customId === 'modal_nickname') {
        const name = interaction.fields.getTextInputValue('nickname_input');
        try {
          await interaction.guild.members.me.setNickname(name);
          await interaction.reply({ content: `✅ Nickname set to **${name}**!`, ephemeral: true });
        } catch {
          await interaction.reply({ content: '⚠️ Couldn\'t set nickname — continuing setup.', ephemeral: true });
        }
        return sendWizardStep(interaction, 2, { followUp: true });
      }

      if (customId === 'modal_add_book') {
        const url = interaction.fields.getTextInputValue('book_url_input');
        await interaction.deferReply({ ephemeral: true });

        try {
          const bookData = await scrapeBookFromUrl(url);
          db.books.add.run({
            guild_id:    interaction.guildId,
            title:       bookData.title,
            author:      bookData.author,
            cover_url:   bookData.coverUrl,
            description: bookData.description,
            source_url:  bookData.sourceUrl,
            total_pages: bookData.totalPages,
            added_by:    interaction.user.id,
          });
          await interaction.editReply(`✅ **${bookData.title}** by ${bookData.author} added to the library!`);
        } catch (err) {
          await interaction.editReply(`⚠️ Couldn't fetch that URL (${err.message}), but you can add books later with \`/book add\`.`);
        }
        return sendWizardStep(interaction, 3, { followUp: true });
      }

      if (customId === 'modal_storygraph') {
        const username = interaction.fields.getTextInputValue('sg_username');
        db.profiles.upsert.run({
          user_id: interaction.user.id,
          storygraph_username: username,
          goodreads_user_id: null,
          goodreads_username: null,
        });
        await interaction.reply({ content: `✅ StoryGraph connected as **${username}**!`, ephemeral: true });
        return sendWizardStep(interaction, 4, { followUp: true });
      }

      if (customId === 'modal_goodreads') {
        const userId = interaction.fields.getTextInputValue('gr_user_id').trim();
        db.profiles.upsert.run({
          user_id: interaction.user.id,
          storygraph_username: null,
          goodreads_user_id: /^\d+$/.test(userId) ? userId : null,
          goodreads_username: userId,
        });
        await interaction.reply({ content: `✅ Goodreads connected!`, ephemeral: true });
        return sendWizardStep(interaction, 4, { followUp: true });
      }
    }
  },
};

// ── Step builders ─────────────────────────────────────────────────────────────

async function sendWizardStep(interaction, step, opts = {}) {
  const payload = buildStep(step, interaction.guildId);

  if (opts.update) {
    return interaction.update(payload);
  }
  if (opts.followUp) {
    return interaction.followUp({ ...payload, ephemeral: false });
  }
  // Fresh reply (from /setup wizard)
  return interaction.reply({ ...payload, ephemeral: false });
}

function buildStep(step, guildId) {
  const steps = ['', '1 of 3', '2 of 3', '3 of 3', '✓ Done'];
  const progress = ['░░░░░', '██░░░', '████░', '█████'];

  const base = {
    fields: [
      {
        name: '📊 Progress',
        value: `\`${progress[Math.min(step - 1, 3)]}\` Step ${steps[step]}`,
        inline: false,
      },
    ],
  };

  if (step === 1) {
    return {
      embeds: [
        new EmbedBuilder()
          .setColor(0x6B46C1)
          .setTitle('📚 Welcome to Book Club Bot!')
          .setDescription(
            'Let\'s get your server set up in 3 quick steps.\n\n' +
            '**Step 1 — Bot nickname**\n' +
            'Give the bot a custom name for this server. By default it\'s called **Verso**, but you could name it after your group — *"Cozy Readers Bot"*, *"Page Turners"*, etc.\n\n' +
            'You can always change this later with `/setup nickname`.'
          )
          .addFields(base.fields),
      ],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('wizard_set_nickname')
            .setLabel('Set a nickname')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('✏️'),
          new ButtonBuilder()
            .setCustomId('wizard_skip_nickname')
            .setLabel('Keep default name')
            .setStyle(ButtonStyle.Secondary),
        ),
      ],
    };
  }

  if (step === 2) {
    const existingBooks = db.books.list.all(guildId);
    const hasBooks = existingBooks.length > 0;
    return {
      embeds: [
        new EmbedBuilder()
          .setColor(0x6B46C1)
          .setTitle('📖 Step 2 — Add your first book')
          .setDescription(
            hasBooks
              ? `You already have **${existingBooks.length}** book${existingBooks.length > 1 ? 's' : ''} in the library! You can add more anytime with \`/book add <url>\`.`
              : 'Paste a book URL from **Goodreads**, **StoryGraph**, or **Amazon** and the bot will automatically pull in the title, author, cover, and page count.'
          )
          .addFields(
            {
              name: 'Example URLs',
              value:
                '`goodreads.com/book/show/…`\n' +
                '`app.thestorygraph.com/books/…`\n' +
                '`amazon.com/dp/…`',
            },
            base.fields[0],
          ),
      ],
      components: [
        new ActionRowBuilder().addComponents(
          ...(hasBooks ? [] : [
            new ButtonBuilder()
              .setCustomId('wizard_add_book')
              .setLabel('Add a book by URL')
              .setStyle(ButtonStyle.Primary)
              .setEmoji('📚'),
          ]),
          new ButtonBuilder()
            .setCustomId('wizard_skip_book')
            .setLabel(hasBooks ? 'Continue' : 'Skip for now')
            .setStyle(hasBooks ? ButtonStyle.Primary : ButtonStyle.Secondary),
        ),
      ],
    };
  }

  if (step === 3) {
    return {
      embeds: [
        new EmbedBuilder()
          .setColor(0x6B46C1)
          .setTitle('🔗 Step 3 — Connect your reading profile')
          .setDescription(
            'Link your **StoryGraph** or **Goodreads** account to your Discord profile.\n\n' +
            '• Your progress and shelf will be visible to other members\n' +
            '• Other members can run `/profile view @you` to see your reading card\n' +
            '• With a Goodreads numeric ID, `/profile shelf` pulls your currently-reading feed\n\n' +
            '*This is just for you — other members can connect their own profiles anytime with `/profile connect`.*'
          )
          .addFields(base.fields),
      ],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('wizard_connect_storygraph')
            .setLabel('Connect StoryGraph')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('📗'),
          new ButtonBuilder()
            .setCustomId('wizard_connect_goodreads')
            .setLabel('Connect Goodreads')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('📘'),
          new ButtonBuilder()
            .setCustomId('wizard_skip_profile')
            .setLabel('Skip')
            .setStyle(ButtonStyle.Secondary),
        ),
      ],
    };
  }

  if (step === 4) {
    return {
      embeds: [
        new EmbedBuilder()
          .setColor(0x23a55a)
          .setTitle('🎉 You\'re all set!')
          .setDescription(
            'Your book club is ready. Here\'s what you can do:\n\n' +
            '`/book add <url>` — add a book from any URL\n' +
            '`/book list` — browse the library\n' +
            '`/poll start` — vote on the next read\n' +
            '`/progress log 45%` — log your progress\n' +
            '`/progress board` — server reading leaderboard\n' +
            '`/profile connect` — link reading accounts\n\n' +
            '📌 **Tip:** Pin `/book list` to your channel so members always know what\'s available.'
          )
          .addFields({ name: '📊 Progress', value: '`█████` Done!', inline: false }),
      ],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('wizard_done')
            .setLabel('Done')
            .setStyle(ButtonStyle.Success)
            .setEmoji('✓'),
        ),
      ],
    };
  }
}

// ── Auto-welcome when bot joins a new server ──────────────────────────────────

async function sendWelcomeMessage(guild) {
  guild.members.me?.setNickname('Verso').catch(() => {});

  await guild.channels.fetch().catch(() => {});

  // Try the system channel first, then fall back to first writable text channel
  const channel =
    guild.systemChannel ??
    guild.channels.cache
      .filter(c => c.isTextBased() && c.permissionsFor(guild.members.me)?.has('SendMessages'))
      .sort((a, b) => a.position - b.position)
      .first();

  if (!channel) return;

  const embed = new EmbedBuilder()
    .setColor(0x6B46C1)
    .setTitle('📚 Book Club Bot has arrived!')
    .setDescription(
      'Thanks for adding me! I help book clubs track reading progress, run polls, and connect reading profiles.\n\n' +
      '**To get started**, a server admin should run:\n' +
      '`/setup wizard` — guided 3-step setup\n\n' +
      '**Or jump straight in:**\n' +
      '`/book add <url>` — add a book from Goodreads, StoryGraph, or Amazon\n' +
      '`/poll start` — run a vote for the next book\n' +
      '`/progress log 45%` — log your reading progress'
    )
    .setFooter({ text: 'Run /setup wizard to customize the bot name and add your first book' });

  await channel.send({ embeds: [embed] }).catch(() => {});
}

module.exports.sendWelcomeMessage = sendWelcomeMessage;
