require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const {
  Client,
  EmbedBuilder,
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

  CREATE TABLE IF NOT EXISTS raffles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_name TEXT NOT NULL,
    accepted_answers_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    started_at TEXT NOT NULL,
    started_by_id TEXT NOT NULL,
    closed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS guesses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raffle_id INTEGER,
    discord_user_id TEXT NOT NULL,
    discord_username TEXT NOT NULL,
    raw_guess TEXT NOT NULL,
    normalized_guess TEXT NOT NULL,
    is_correct INTEGER NOT NULL DEFAULT 0,
    submitted_at TEXT NOT NULL,
    FOREIGN KEY (raffle_id) REFERENCES raffles(id)
  );

  CREATE TABLE IF NOT EXISTS raffle_winners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raffle_id INTEGER NOT NULL,
    discord_user_id TEXT NOT NULL,
    discord_username TEXT NOT NULL,
    placement INTEGER NOT NULL,
    tickets_awarded INTEGER NOT NULL,
    won_at TEXT NOT NULL,
    UNIQUE (raffle_id, discord_user_id),
    UNIQUE (raffle_id, placement),
    FOREIGN KEY (raffle_id) REFERENCES raffles(id)
  );

  CREATE TABLE IF NOT EXISTS tickets (
    ticket_number INTEGER PRIMARY KEY,
    raffle_id INTEGER NOT NULL,
    discord_user_id TEXT NOT NULL,
    discord_username TEXT NOT NULL,
    awarded_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    FOREIGN KEY (raffle_id) REFERENCES raffles(id)
  );

  CREATE INDEX IF NOT EXISTS idx_guesses_raffle_user
    ON guesses (raffle_id, discord_user_id);

  CREATE INDEX IF NOT EXISTS idx_tickets_user
    ON tickets (discord_user_id, ticket_number);
`);

// Upgrade databases made by the starter version without deleting any data.
const guessColumns = db.prepare('PRAGMA table_info(guesses)').all().map((column) => column.name);
if (!guessColumns.includes('raffle_id')) {
  db.exec('ALTER TABLE guesses ADD COLUMN raffle_id INTEGER');
}
if (!guessColumns.includes('is_correct')) {
  db.exec('ALTER TABLE guesses ADD COLUMN is_correct INTEGER NOT NULL DEFAULT 0');
}

const insertSetting = db.prepare(`
  INSERT OR IGNORE INTO settings (key, value)
  VALUES (?, ?)
`);
insertSetting.run('next_ticket_number', String(startingTicketNumber));

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

function isOwner(interaction) {
  return interaction.user.id === process.env.OWNER_ID;
}

function getActiveRaffle() {
  return db.prepare(`
    SELECT * FROM raffles
    WHERE status = 'open'
    ORDER BY id DESC
    LIMIT 1
  `).get();
}

function parseAcceptedAnswers(cardName, aliasesText) {
  const rawAnswers = [cardName];
  if (aliasesText) {
    rawAnswers.push(...aliasesText.split(','));
  }

  return [...new Set(
    rawAnswers
      .map((answer) => normalizeCardName(answer))
      .filter(Boolean)
  )];
}

const insertGuess = db.prepare(`
  INSERT INTO guesses (
    raffle_id,
    discord_user_id,
    discord_username,
    raw_guess,
    normalized_guess,
    is_correct,
    submitted_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const awardCorrectGuess = db.transaction((raffle, user, now) => {
  const existingWinner = db.prepare(`
    SELECT * FROM raffle_winners
    WHERE raffle_id = ? AND discord_user_id = ?
  `).get(raffle.id, user.id);

  if (existingWinner) {
    const existingTickets = db.prepare(`
      SELECT ticket_number FROM tickets
      WHERE raffle_id = ? AND discord_user_id = ?
      ORDER BY ticket_number
    `).all(raffle.id, user.id);

    return {
      type: 'already_won',
      placement: existingWinner.placement,
      tickets: existingTickets.map((row) => row.ticket_number)
    };
  }

  const winnerCount = db.prepare(`
    SELECT COUNT(*) AS count FROM raffle_winners
    WHERE raffle_id = ?
  `).get(raffle.id).count;

  if (winnerCount >= 5) {
    return { type: 'correct_no_tickets' };
  }

  const placement = winnerCount + 1;
  const ticketCount = placement === 1 ? 2 : 1;
  const nextTicket = Number.parseInt(
    db.prepare(`SELECT value FROM settings WHERE key = 'next_ticket_number'`).get().value,
    10
  );

  if (!Number.isSafeInteger(nextTicket)) {
    throw new Error('The saved next ticket number is invalid.');
  }

  db.prepare(`
    INSERT INTO raffle_winners (
      raffle_id,
      discord_user_id,
      discord_username,
      placement,
      tickets_awarded,
      won_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    raffle.id,
    user.id,
    user.username,
    placement,
    ticketCount,
    now
  );

  const insertTicket = db.prepare(`
    INSERT INTO tickets (
      ticket_number,
      raffle_id,
      discord_user_id,
      discord_username,
      awarded_at
    ) VALUES (?, ?, ?, ?, ?)
  `);

  const ticketNumbers = [];
  for (let offset = 0; offset < ticketCount; offset += 1) {
    const ticketNumber = nextTicket + offset;
    insertTicket.run(ticketNumber, raffle.id, user.id, user.username, now);
    ticketNumbers.push(ticketNumber);
  }

  db.prepare(`
    UPDATE settings SET value = ?
    WHERE key = 'next_ticket_number'
  `).run(String(nextTicket + ticketCount));

  return {
    type: 'winner',
    placement,
    tickets: ticketNumbers
  };
});

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (readyClient) => {
  const nextTicket = db.prepare(`
    SELECT value FROM settings WHERE key = 'next_ticket_number'
  `).get().value;

  console.log(`Logged in as ${readyClient.user.tag}`);
  console.log(`SQLite database: ${databasePath}`);
  console.log(`Next physical ticket: ${nextTicket}`);
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

    if (interaction.commandName === 'startraffle') {
      if (!isOwner(interaction)) {
        await interaction.reply({
          content: 'Only the raffle owner can start a challenge.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const currentRaffle = getActiveRaffle();
      if (currentRaffle) {
        await interaction.reply({
          content:
            `A raffle is already open: **${currentRaffle.card_name}**. ` +
            'We will add the close command in the next update.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const cardName = interaction.options.getString('card', true).trim();
      const aliasesText = interaction.options.getString('aliases')?.trim() || '';
      const acceptedAnswers = parseAcceptedAnswers(cardName, aliasesText);

      if (!normalizeCardName(cardName)) {
        await interaction.reply({
          content: 'Please enter a valid full card name.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const now = new Date().toISOString();
      const result = db.prepare(`
        INSERT INTO raffles (
          card_name,
          accepted_answers_json,
          status,
          started_at,
          started_by_id
        ) VALUES (?, ?, 'open', ?, ?)
      `).run(
        cardName,
        JSON.stringify(acceptedAnswers),
        now,
        interaction.user.id
      );

      const announcement = new EmbedBuilder()
        .setTitle('🎟️ A New Blurred MTG Raffle Has Begun!')
        .setDescription(
          'Think you know the mystery Magic card? Submit your answer privately with `/guess`.\n\n' +
          '**Ticket rewards**\n' +
          '🥇 First correct answer: **2 tickets**\n' +
          '🎟️ Next four correct answers: **1 ticket each**\n\n' +
          'Capitalization and punctuation do not matter. The full card name is required.'
        )
        .setFooter({ text: `Raffle #${result.lastInsertRowid}` })
        .setTimestamp();

      const guessChannel = await client.channels.fetch(process.env.GUESS_CHANNEL_ID);
      if (!guessChannel?.isTextBased()) {
        throw new Error('GUESS_CHANNEL_ID does not point to a text channel.');
      }

      const roleMention = process.env.RAFFLE_ROLE_ID
        ? `<@&${process.env.RAFFLE_ROLE_ID}>\n`
        : '';

      await guessChannel.send({
        content: roleMention || undefined,
        embeds: [announcement],
        allowedMentions: process.env.RAFFLE_ROLE_ID
          ? { roles: [process.env.RAFFLE_ROLE_ID] }
          : { parse: [] }
      });

      await interaction.reply({
        content:
          `✅ Raffle #${result.lastInsertRowid} is now open.\n` +
          `**Answer:** ${cardName}\n` +
          `**Accepted normalized answers:** ${acceptedAnswers.join(' • ')}`,
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

      const raffle = getActiveRaffle();
      if (!raffle) {
        await interaction.reply({
          content: 'There is no active blurred-card raffle right now.',
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

      const acceptedAnswers = JSON.parse(raffle.accepted_answers_json);
      const isCorrect = acceptedAnswers.includes(normalizedGuess);
      const now = new Date().toISOString();

      insertGuess.run(
        raffle.id,
        interaction.user.id,
        interaction.user.username,
        rawGuess,
        normalizedGuess,
        isCorrect ? 1 : 0,
        now
      );

      if (!isCorrect) {
        await interaction.reply({
          content: '❌ That is not the correct card. Your guess remains private, and you may try again.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const award = awardCorrectGuess(raffle, interaction.user, now);

      if (award.type === 'already_won') {
        await interaction.reply({
          content:
            '✅ You already solved this week’s card and your tickets are safely recorded:\n' +
            award.tickets.map((ticket) => `🎟️ **${ticket}**`).join('\n'),
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (award.type === 'correct_no_tickets') {
        await interaction.reply({
          content:
            '✅ You identified the correct card! All five ticket-winning positions have already been claimed. ' +
            'Please keep the answer secret until the reveal.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const placementText = award.placement === 1
        ? 'You were the **first correct player**!'
        : `You earned winning position **#${award.placement}**!`;

      await interaction.reply({
        content:
          `🎉 **Correct!** ${placementText}\n\n` +
          `You earned **${award.tickets.length} raffle ticket${award.tickets.length === 1 ? '' : 's'}**:\n` +
          award.tickets.map((ticket) => `🎟️ **${ticket}**`).join('\n') +
          '\n\nPlease keep the answer secret until the raffle closes!',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (interaction.commandName === 'mytickets') {
      const tickets = db.prepare(`
        SELECT ticket_number, raffle_id, awarded_at, status
        FROM tickets
        WHERE discord_user_id = ?
        ORDER BY ticket_number
      `).all(interaction.user.id);

      if (tickets.length === 0) {
        await interaction.reply({
          content: '🎟️ You have not earned any raffle tickets yet.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const shown = tickets.slice(-50);
      const ticketLines = shown.map(
        (ticket) => `🎟️ **${ticket.ticket_number}** — Raffle #${ticket.raffle_id}`
      );

      const olderMessage = tickets.length > shown.length
        ? `\n\nShowing your newest ${shown.length} of ${tickets.length} tickets.`
        : '';

      await interaction.reply({
        content:
          `## 🎟️ ${interaction.user.username}'s Raffle Tickets\n` +
          ticketLines.join('\n') +
          `\n\n**Total tickets:** ${tickets.length}` +
          olderMessage,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (interaction.commandName === 'rafflestatus') {
      if (!isOwner(interaction)) {
        await interaction.reply({
          content: 'Only the raffle owner can view the private raffle status.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const raffle = getActiveRaffle();
      if (!raffle) {
        await interaction.reply({
          content: 'There is no active raffle.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const winners = db.prepare(`
        SELECT * FROM raffle_winners
        WHERE raffle_id = ?
        ORDER BY placement
      `).all(raffle.id);

      const ticketLookup = db.prepare(`
        SELECT ticket_number FROM tickets
        WHERE raffle_id = ? AND discord_user_id = ?
        ORDER BY ticket_number
      `);

      const totalGuesses = db.prepare(`
        SELECT COUNT(*) AS count FROM guesses WHERE raffle_id = ?
      `).get(raffle.id).count;

      const winnerLines = winners.length
        ? winners.map((winner) => {
            const ticketNumbers = ticketLookup
              .all(raffle.id, winner.discord_user_id)
              .map((ticket) => ticket.ticket_number)
              .join(', ');
            return `**#${winner.placement} ${winner.discord_username}** — ${ticketNumbers}`;
          }).join('\n')
        : 'No correct winners yet.';

      const nextTicket = db.prepare(`
        SELECT value FROM settings WHERE key = 'next_ticket_number'
      `).get().value;

      await interaction.reply({
        content:
          `## 🎟️ Active Raffle #${raffle.id}\n` +
          `**Correct card:** ${raffle.card_name}\n` +
          `**Total guesses:** ${totalGuesses}\n` +
          `**Winning positions filled:** ${winners.length}/5\n\n` +
          `${winnerLines}\n\n` +
          `**Next available physical ticket:** ${nextTicket}`,
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
