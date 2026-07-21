require('dotenv').config();

const {
  REST,
  Routes,
  SlashCommandBuilder
} = require('discord.js');

const REQUIRED_VARIABLES = [
  'DISCORD_TOKEN',
  'CLIENT_ID',
  'GUILD_ID'
];

const missingVariables = REQUIRED_VARIABLES.filter(
  (name) => !process.env[name]
);

if (missingVariables.length > 0) {
  console.error(
    `Missing required environment variables: ${missingVariables.join(', ')}`
  );
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName('raffleping')
    .setDescription('Check whether the raffle bot is online.'),

  new SlashCommandBuilder()
    .setName('startraffle')
    .setDescription('Start a new blurred MTG card raffle.')
    .addStringOption((option) =>
      option
        .setName('card')
        .setDescription('The full correct card name.')
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName('aliases')
        .setDescription(
          'Optional accepted answers separated by commas.'
        )
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('resetraffle')
    .setDescription(
      'Delete the active raffle and restore its ticket numbers.'
    )
    .addStringOption((option) =>
      option
        .setName('confirm')
        .setDescription(
          'Type RESET in all capital letters.'
        )
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('guess')
    .setDescription(
      'Privately guess the current blurred MTG card.'
    )
    .addStringOption((option) =>
      option
        .setName('card')
        .setDescription('Your full card-name guess.')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('mytickets')
    .setDescription(
      'View your raffle ticket numbers.'
    ),

  new SlashCommandBuilder()
    .setName('rafflestatus')
    .setDescription(
      'View the private status of the active raffle.'
    )
].map((command) => command.toJSON());

const rest = new REST({
  version: '10'
}).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log(
      'Registering guild slash commands...'
    );

    await rest.put(
      Routes.applicationGuildCommands(
        process.env.CLIENT_ID,
        process.env.GUILD_ID
      ),
      {
        body: commands
      }
    );

    console.log(
      'Slash commands registered successfully.'
    );
  } catch (error) {
    console.error(
      'Could not register slash commands:',
      error
    );
    process.exit(1);
  }
})();
