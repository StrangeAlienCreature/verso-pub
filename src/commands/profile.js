const {
  SlashCommandBuilder,
  EmbedBuilder,
} = require('discord.js');
const db = require('../database');
const { fetchGoodreadsCurrentlyReading } = require('../utils/scraper');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('profile')
    .setDescription('Connect your StoryGraph or Goodreads account')
    // ── /profile connect ──────────────────────────────────────────────────
    .addSubcommand(sub =>
      sub.setName('connect')
        .setDescription('Link your reading profile to Discord')
        .addStringOption(opt =>
          opt.setName('platform')
            .setDescription('Which platform to connect')
            .setRequired(true)
            .addChoices(
              { name: 'StoryGraph', value: 'storygraph' },
              { name: 'Goodreads',  value: 'goodreads'  },
            ))
        .addStringOption(opt =>
          opt.setName('username')
            .setDescription('Your username or profile ID')
            .setRequired(true)))
    // ── /profile view ─────────────────────────────────────────────────────
    .addSubcommand(sub =>
      sub.setName('view')
        .setDescription('View a member\'s connected reading profile')
        .addUserOption(opt =>
          opt.setName('user')
            .setDescription('User to look up (defaults to you)')
            .setRequired(false)))
    // ── /profile disconnect ───────────────────────────────────────────────
    .addSubcommand(sub =>
      sub.setName('disconnect')
        .setDescription('Unlink a reading platform')
        .addStringOption(opt =>
          opt.setName('platform')
            .setDescription('Platform to disconnect')
            .setRequired(true)
            .addChoices(
              { name: 'StoryGraph', value: 'storygraph' },
              { name: 'Goodreads',  value: 'goodreads'  },
            )))
    // ── /profile shelf ────────────────────────────────────────────────────
    .addSubcommand(sub =>
      sub.setName('shelf')
        .setDescription('Pull your currently-reading shelf from Goodreads')
        .addUserOption(opt =>
          opt.setName('user')
            .setDescription('User to check (defaults to you)')
            .setRequired(false))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    // ── CONNECT ───────────────────────────────────────────────────────────────
    if (sub === 'connect') {
      const platform = interaction.options.getString('platform');
      const username = interaction.options.getString('username').trim();

      const update = {};
      if (platform === 'storygraph') {
        update.storygraph_username = username;
        update.goodreads_user_id   = null;
        update.goodreads_username  = null;
      } else {
        update.storygraph_username = null;
        // Goodreads uses numeric user IDs for RSS, but let's accept either
        const isNumeric = /^\d+$/.test(username);
        update.goodreads_user_id  = isNumeric ? username : null;
        update.goodreads_username = username;
      }

      db.profiles.upsert.run({ user_id: interaction.user.id, ...update });

      const platformLabel = platform === 'storygraph' ? 'StoryGraph' : 'Goodreads';
      const profileUrl    = buildProfileUrl(platform, username);

      const embed = new EmbedBuilder()
        .setColor(0x6B46C1)
        .setTitle(`✅ ${platformLabel} connected!`)
        .setDescription(`Your ${platformLabel} profile has been linked.\n\n[View your profile](${profileUrl})`)
        .setFooter({ text: 'Use /profile view to see your full reading card' })
        .setTimestamp();

      // StoryGraph note — no public API
      if (platform === 'storygraph') {
        embed.addFields({
          name: 'ℹ️ Note',
          value: 'StoryGraph doesn\'t have a public API yet, so your profile link is saved for others to visit. Progress syncing isn\'t available, but you can log pages manually with `/progress log`.',
        });
      }

      // Goodreads note — test RSS
      if (platform === 'goodreads') {
        const isNumeric = /^\d+$/.test(username);
        if (!isNumeric) {
          embed.addFields({
            name: '⚠️ Tip for shelf sync',
            value: 'To enable `/profile shelf` (currently-reading feed), re-connect with your **numeric Goodreads user ID** instead of your username. You can find it in your profile URL: `goodreads.com/user/show/`**`12345678`**`-yourname`',
          });
        }
      }

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // ── VIEW ──────────────────────────────────────────────────────────────────
    if (sub === 'view') {
      const target  = interaction.options.getUser('user') || interaction.user;
      const profile = db.profiles.get.get(target.id);

      if (!profile || (!profile.storygraph_username && !profile.goodreads_username)) {
        const isSelf = target.id === interaction.user.id;
        return interaction.reply({
          content: isSelf
            ? '📭 You haven\'t connected any reading platforms yet. Use `/profile connect` to link StoryGraph or Goodreads!'
            : `📭 ${target.displayName} hasn't connected any reading platforms.`,
          ephemeral: true,
        });
      }

      // Build profile card
      const fields = [];

      if (profile.storygraph_username) {
        const url = buildProfileUrl('storygraph', profile.storygraph_username);
        fields.push({ name: '📚 StoryGraph', value: `[${profile.storygraph_username}](${url})`, inline: true });
      }

      if (profile.goodreads_username) {
        const url = buildProfileUrl('goodreads', profile.goodreads_user_id || profile.goodreads_username);
        fields.push({ name: '📖 Goodreads', value: `[${profile.goodreads_username}](${url})`, inline: true });
      }

      // Recent in-server progress
      const recentProgress = db.progress.getUserAll.all(interaction.guildId, target.id);
      if (recentProgress.length) {
        const lines = recentProgress.slice(0, 3).map(p => {
          const pct = p.percent !== null ? `${Math.round(p.percent)}%` : (p.current_page ? `page ${p.current_page}` : '?');
          return `📚 **${p.title}** — ${pct}`;
        });
        fields.push({ name: '📊 Recent Progress (this server)', value: lines.join('\n'), inline: false });
      }

      const member = await interaction.guild.members.fetch(target.id).catch(() => null);
      const embed  = new EmbedBuilder()
        .setColor(0x6B46C1)
        .setTitle(`📖 ${member?.displayName || target.displayName}'s Reading Profile`)
        .addFields(fields)
        .setThumbnail(target.displayAvatarURL())
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    }

    // ── DISCONNECT ────────────────────────────────────────────────────────────
    if (sub === 'disconnect') {
      const platform = interaction.options.getString('platform');
      const label    = platform === 'storygraph' ? 'StoryGraph' : 'Goodreads';

      if (platform === 'storygraph') {
        db.profiles.clearStorygraph.run(interaction.user.id);
      } else {
        db.profiles.clearGoodreads.run(interaction.user.id);
      }

      return interaction.reply({ content: `✅ ${label} account disconnected.`, ephemeral: true });
    }

    // ── SHELF ─────────────────────────────────────────────────────────────────
    if (sub === 'shelf') {
      const target  = interaction.options.getUser('user') || interaction.user;
      const profile = db.profiles.get.get(target.id);

      if (!profile?.goodreads_user_id) {
        const isSelf = target.id === interaction.user.id;
        return interaction.reply({
          content: isSelf
            ? '❌ Connect your Goodreads **numeric user ID** first with `/profile connect platform:Goodreads username:<your_id>`.\nFind it in your profile URL: `goodreads.com/user/show/`**`12345678`**`-name`'
            : `❌ ${target.displayName} hasn't linked their Goodreads ID.`,
          ephemeral: true,
        });
      }

      await interaction.deferReply();

      const books = await fetchGoodreadsCurrentlyReading(profile.goodreads_user_id);
      if (!books || !books.length) {
        return interaction.editReply(`📭 Couldn't find any currently-reading books for ${target.displayName}. Make sure their Goodreads shelf is public!`);
      }

      const lines = books.map(b => `📖 [${b.title}](${b.link})`);
      const member = await interaction.guild.members.fetch(target.id).catch(() => null);

      const embed = new EmbedBuilder()
        .setColor(0x6B46C1)
        .setTitle(`📚 ${member?.displayName || target.displayName} is currently reading`)
        .setDescription(lines.join('\n'))
        .setFooter({ text: 'Via Goodreads RSS feed' })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildProfileUrl(platform, username) {
  if (platform === 'storygraph') {
    return `https://app.thestorygraph.com/profile/${username}`;
  }
  if (platform === 'goodreads') {
    return /^\d+$/.test(username)
      ? `https://www.goodreads.com/user/show/${username}`
      : `https://www.goodreads.com/${username}`;
  }
  return '#';
}
