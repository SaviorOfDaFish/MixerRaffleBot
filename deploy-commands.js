require('dotenv').config();

const {
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder
} = require('discord.js');

const requiredVariables = ['DISCORD_TOKEN', 'CLIENT_ID', 'GUILD_ID'];
const missing = requiredVariables.filter((name) => !process.env[name]);

if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName('startraffle')
    .setDescription('Start a new blurred MTG raffle challenge.')
    .addStringOption((option) =>
      option
        .setName('card')
        .setDescription('The exact full name of the mystery Magic card.')
        .setRequired(true)
        .setMaxLength(150)
    )
    .addStringOption((option) =>
      option
        .setName('aliases')
        .setDescription('Optional alternate answers, separated by commas.')
        .setRequired(false)
        .setMaxLength(500)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('guess')
    .setDescription('Submit a private guess for the current blurred MTG card.')
    .addStringOption((option) =>
      option
        .setName('card')
        .setDescription('Enter the full name of the Magic card.')
        .setRequired(true)
        .setMaxLength(150)
    ),

  new SlashCommandBuilder()
    .setName('mytickets')
    .setDescription('Privately view all raffle tickets assigned to you.'),

  new SlashCommandBuilder()
    .setName('rafflestatus')
    .setDescription('View the active raffle, winners, and assigned tickets.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('raffleping')
    .setDescription('Check whether the raffle bot is online.')
].map((command) => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Registering guild slash commands...');
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('Slash commands registered successfully.');
  } catch (error) {
    console.error('Could not register slash commands:', error);
    process.exit(1);
  }
})();
