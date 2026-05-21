const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Post the book club guide in this channel'),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const embedBooks = new EmbedBuilder()
      .setColor(0x6B46C1)
      .setTitle('📚 Submitting & Browsing Books')
      .setDescription('Anyone can suggest books for the club library!')
      .addFields(
        {
          name: '🔍 Search by title',
          value: '`/book add search <title>`\nSearch by name — the bot shows results for you to confirm.',
        },
        {
          name: '🔗 Add by URL',
          value: '`/book add url <url>`\nPaste a Goodreads, ThriftBooks, or Amazon link.',
        },
        {
          name: '📖 Add by ISBN',
          value: '`/book add isbn <isbn>`\nUse the ISBN-10 or ISBN-13 from the back of the book.',
        },
        {
          name: '📋 Browse the library',
          value: [
            '`/book list` — All submitted books',
            '`/book current` — What we\'re reading right now',
            '`/book info <id>` — Details for a specific book',
          ].join('\n'),
        },
      )
      .setFooter({ text: 'Admins use /poll start to run a vote for the next pick' });

    const embedProgress = new EmbedBuilder()
      .setColor(0x6B46C1)
      .setTitle('📖 Tracking Your Reading')
      .addFields(
        {
          name: 'Log progress',
          value: [
            '`/progress log <amount>`',
            'Use a **page number** (`150`), **percentage** (`45%`), or **fraction** (`150/400`).',
            'Add an optional note with the `note` option — keep it spoiler-free!',
          ].join('\n'),
        },
        {
          name: 'View progress',
          value: [
            '`/progress view` — Your progress on the current book',
            '`/progress view user:@someone` — Check another member\'s progress',
            '`/progress board` — Leaderboard for the current book',
          ].join('\n'),
        },
        {
          name: 'Did Not Finish',
          value: '`/progress dnf` — Mark a book as DNF and record where you stopped.',
        },
      );

    const embedRatingsDiscuss = new EmbedBuilder()
      .setColor(0x6B46C1)
      .setTitle('⭐ Ratings & Discussion')
      .addFields(
        {
          name: 'Rate a book',
          value: [
            '`/rate book <stars>` — Rate from 0.5 to 5 stars',
            '`/rate view` — See everyone\'s ratings for the current book',
            '*You need to log progress (or DNF) before you can rate.*',
          ].join('\n'),
        },
        {
          name: 'Spoiler-safe discussion threads',
          value: [
            '`/discuss list` — See which threads you can access based on your progress',
            '',
            'Threads unlock at **25%**, **50%**, **75%**, and **100%** — so you only see spoilers you\'ve already read past!',
          ].join('\n'),
        },
        {
          name: 'Reading profile',
          value: [
            '`/profile connect` — Link your Goodreads or StoryGraph account',
            '`/profile view` — View your reading profile',
          ].join('\n'),
        },
      )
      .setFooter({ text: 'Tip: Pin this message so members can find it easily!' })
      .setTimestamp();

    await interaction.channel.send({ embeds: [embedBooks] });
    await interaction.channel.send({ embeds: [embedProgress] });
    await interaction.channel.send({ embeds: [embedRatingsDiscuss] });

    return interaction.editReply({ content: '✅ Help guide posted!' });
  },
};
