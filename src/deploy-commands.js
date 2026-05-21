/**
 * Run this ONCE to register slash commands with Discord.
 *   node src/deploy-commands.js
 *
 * With GUILD_ID set: registers instantly to that server (great for testing).
 * Without GUILD_ID:  registers globally (may take up to 1 hour to propagate).
 */
require('dotenv').config();
const { REST, Routes } = require('discord.js');
const fs   = require('fs');
const path = require('path');

const commands = [];
const commandsDir = path.join(__dirname, 'commands');

for (const file of fs.readdirSync(commandsDir).filter(f => f.endsWith('.js'))) {
  const command = require(path.join(commandsDir, file));
  if ('data' in command) {
    commands.push(command.data.toJSON());
    console.log(`📦 Loaded: /${command.data.name}`);
  }
}

const rest = new REST().setToken(process.env.DISCORD_TOKEN);

(async () => {
  const clientId = process.env.CLIENT_ID;
  const guildId  = process.env.GUILD_ID;

  if (!clientId) {
    console.error('❌ CLIENT_ID is missing from .env');
    process.exit(1);
  }

  try {
    if (guildId) {
      console.log(`\n🚀 Deploying ${commands.length} commands to guild ${guildId}...`);
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
      console.log('✅ Guild commands registered instantly!');
    } else {
      console.log(`\n🌐 Deploying ${commands.length} commands globally...`);
      await rest.put(Routes.applicationCommands(clientId), { body: commands });
      console.log('✅ Global commands registered (may take up to 1 hour).');
    }
  } catch (err) {
    console.error('❌ Deployment failed:', err);
    process.exit(1);
  }
})();
