require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  Collection,
  Events,
} = require('discord.js');
const fs   = require('fs');
const path = require('path');

// ── Bot Client ────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
  // Partials allow us to receive reactions on messages not in the cache
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// ── Load Commands ─────────────────────────────────────────────────────────────
client.commands = new Collection();
const commandsDir = path.join(__dirname, 'commands');

for (const file of fs.readdirSync(commandsDir).filter(f => f.endsWith('.js'))) {
  const command = require(path.join(commandsDir, file));
  if ('data' in command && 'execute' in command) {
    client.commands.set(command.data.name, command);
    console.log(`📦 Loaded command: /${command.data.name}`);
  }
}

// ── Ready ─────────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, () => {
  console.log(`\n✅ Book Club Bot is online as ${client.user.tag}`);
  console.log(`📚 Serving ${client.guilds.cache.size} server(s)\n`);
  client.user.setActivity('📚 Reading together', { type: 3 /* Watching */ });
});

// ── Slash Command + Button + Modal Handler ────────────────────────────────────
client.on(Events.InteractionCreate, async interaction => {
  // Route buttons and modals to the appropriate handler
  if (interaction.isButton() || interaction.isModalSubmit()) {
    if (interaction.isButton() && interaction.customId.startsWith('book_')) {
      const book = client.commands.get('book');
      if (book?.handleInteraction) {
        await book.handleInteraction(interaction).catch(console.error);
      }
    } else {
      const setup = client.commands.get('setup');
      if (setup?.handleInteraction) {
        await setup.handleInteraction(interaction).catch(console.error);
      }
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(`Error in /${interaction.commandName}:`, error);

    const msg = { content: '❌ Something went wrong running that command.', ephemeral: true };
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(msg);
      } else {
        await interaction.reply(msg);
      }
    } catch {
      // Interaction may have expired
    }
  }
});

// ── Welcome message when bot joins a new server ───────────────────────────────
client.on(Events.GuildCreate, async guild => {
  console.log(`➕ Joined new server: ${guild.name} (${guild.id})`);
  const { sendWelcomeMessage } = require('./commands/setup');
  await sendWelcomeMessage(guild).catch(console.error);
});

// ── Reaction Handler (for polls) ──────────────────────────────────────────────
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (user.bot) return;

  // Fetch partial reaction/message if needed
  if (reaction.partial) {
    try { await reaction.fetch(); } catch { return; }
  }
  if (reaction.message.partial) {
    try { await reaction.message.fetch(); } catch { return; }
  }

  const { handleReactionAdd } = require('./commands/poll');
  await handleReactionAdd(reaction, user).catch(console.error);
});


// -- Thread message handler (spoiler protection) ------------------------------
client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;
  if (!message.channel.isThread()) return;
  const { handleThreadMessage } = require('./commands/discuss');
  await handleThreadMessage(message).catch(console.error);
});

// ── Start ─────────────────────────────────────────────────────────────────────
if (!process.env.DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN is not set in your .env file');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);
