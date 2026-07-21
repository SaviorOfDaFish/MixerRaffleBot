require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags
} = require('discord.js');

const REQUIRED_VARIABLES = [
  'DISCORD_TOKEN',
  'CLIENT_ID',
  'GUILD_ID',
  'OWNER_ID',
  'GUESS_CHANNEL_ID',
  'ADMIN_CHANNEL_ID'
];

const missingVariables = REQUIRED_VARIABLES.filter((name) => !process.env[name]);
if (missingVariables.length > 0) {
  console.error(`Missing required environment variables: ${missingVariables.join(', ')}`);
  process.exit(1);
}

const databasePath = process.env.DATABASE_PATH || './data/raffle.db';
const startingTicketNumber = Number.parseInt(
  process.env.STARTING_TICKET_NUMBER || '158114',
  10
);

if (!Number.isSafeInteger(startingTicketNumber)) {
  console.error('STARTING_TICKET_NUMBER must be a valid whole number.');
  process.exit(1);
}

fs.mkdirSync(path.dirname(databasePath), { recursive: true });

const db = new Database(databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS guesses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_user_id TEXT NOT NULL,
    discord_username TEXT NOT NULL,
    raw_guess TEXT NOT NULL,
    normalized_guess TEXT NOT NULL,
    submitted_at TEXT NOT NULL
  );
`);

const insertSetting = db.prepare(`
  INSERT OR IGNORE INTO settings (key, value)
  VALUES (?, ?)
`);

insertSetting.run('next_ticket_number', String(startingTicketNumber));

const insertGuess = db.prepare(`
  INSERT INTO guesses (
    discord_user_id,
    discord_username,
    raw_guess,
    normalized_guess,
    submitted_at
  ) VALUES (?, ?, ?, ?, ?)
`);

function normalizeCardName(value) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  console.log(`SQLite database: ${databasePath}`);
  console.log(`Next physical ticket begins at: ${startingTicketNumber}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === 'raffleping') {
      await interaction.reply({
        content: `🎟️ The raffle bot is online. Database: \`${databasePath}\``,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (interaction.commandName === 'guess') {
      if (interaction.channelId !== process.env.GUESS_CHANNEL_ID) {
        await interaction.reply({
          content: `Please submit guesses in <#${process.env.GUESS_CHANNEL_ID}>.`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const rawGuess = interaction.options.getString('card', true).trim();
      const normalizedGuess = normalizeCardName(rawGuess);

      if (!normalizedGuess) {
        await interaction.reply({
          content: 'Please enter a full Magic card name.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      insertGuess.run(
        interaction.user.id,
        interaction.user.username,
        rawGuess,
        normalizedGuess,
        new Date().toISOString()
      );

      await interaction.reply({
        content:
          '✅ Your private guess was received and saved. Nobody else can see your answer.\n\n' +
          '**This is the starter test version:** it records guesses but does not judge answers or award tickets yet.',
        flags: MessageFlags.Ephemeral
      });
    }
  } catch (error) {
    console.error('Interaction error:', error);

    const errorMessage = {
      content: 'Something went wrong while processing that command. Please try again.',
      flags: MessageFlags.Ephemeral
    };

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(errorMessage).catch(() => {});
    } else {
      await interaction.reply(errorMessage).catch(() => {});
    }
  }
});

process.on('SIGINT', () => {
  db.close();
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  db.close();
  client.destroy();
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);
