require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { DateTime } = require('luxon');
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

const missingVariables = REQUIRED_VARIABLES.filter(
  (name) => !process.env[name]
);

if (missingVariables.length > 0) {
  console.error(
    `Missing required environment variables: ${missingVariables.join(', ')}`
  );
  process.exit(1);
}

const MOUNTAIN_TIME_ZONE = 'America/Denver';

const databasePath =
  process.env.DATABASE_PATH || './data/raffle.db';

const startingTicketNumber = Number.parseInt(
  process.env.STARTING_TICKET_NUMBER || '158114',
  10
);

if (!Number.isSafeInteger(startingTicketNumber)) {
  console.error('STARTING_TICKET_NUMBER must be a valid whole number.');
  process.exit(1);
}

fs.mkdirSync(path.dirname(databasePath), {
  recursive: true
});

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
`);

/*
 * Upgrade databases created by earlier versions.
 * This preserves existing data on the Railway Volume.
 */
const guessColumns = db
  .prepare('PRAGMA table_info(guesses)')
  .all()
  .map((column) => column.name);

if (!guessColumns.includes('raffle_id')) {
  db.exec(`
    ALTER TABLE guesses
    ADD COLUMN raffle_id INTEGER
  `);
}

if (!guessColumns.includes('is_correct')) {
  db.exec(`
    ALTER TABLE guesses
    ADD COLUMN is_correct INTEGER NOT NULL DEFAULT 0
  `);
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_guesses_raffle_user
    ON guesses (raffle_id, discord_user_id);

  CREATE INDEX IF NOT EXISTS idx_tickets_user
    ON tickets (discord_user_id, ticket_number);
`);

const insertSetting = db.prepare(`
  INSERT OR IGNORE INTO settings (key, value)
  VALUES (?, ?)
`);

insertSetting.run(
  'next_ticket_number',
  String(startingTicketNumber)
);

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
  return db
    .prepare(`
      SELECT *
      FROM raffles
      WHERE status = 'open'
      ORDER BY id DESC
      LIMIT 1
    `)
    .get();
}

function getRaffleById(raffleId) {
  return db
    .prepare(`
      SELECT *
      FROM raffles
      WHERE id = ?
    `)
    .get(raffleId);
}

function parseAcceptedAnswers(cardName, aliasesText) {
  const rawAnswers = [cardName];

  if (aliasesText) {
    rawAnswers.push(...aliasesText.split(','));
  }

  return [
    ...new Set(
      rawAnswers
        .map((answer) => normalizeCardName(answer))
        .filter(Boolean)
    )
  ];
}

function getNextTicketNumber() {
  const setting = db
    .prepare(`
      SELECT value
      FROM settings
      WHERE key = 'next_ticket_number'
    `)
    .get();

  const ticketNumber = Number.parseInt(
    setting.value,
    10
  );

  if (!Number.isSafeInteger(ticketNumber)) {
    throw new Error(
      'The saved next ticket number is invalid.'
    );
  }

  return ticketNumber;
}

/*
 * Finds Thursday at 10:00 PM Mountain Time for the raffle week.
 * A raffle started after Thursday at 10 PM closes the following Thursday.
 */
function getScheduledCloseTime(raffle) {
  const startTime = DateTime
    .fromISO(raffle.started_at, {
      zone: 'utc'
    })
    .setZone(MOUNTAIN_TIME_ZONE);

  let daysUntilThursday =
    (4 - startTime.weekday + 7) % 7;

  const startedAfterThursdayClose =
    startTime.weekday === 4 &&
    (
      startTime.hour > 22 ||
      (
        startTime.hour === 22 &&
        (
          startTime.minute > 0 ||
          startTime.second > 0
        )
      )
    );

  if (startedAfterThursdayClose) {
    daysUntilThursday = 7;
  }

  return startTime
    .plus({
      days: daysUntilThursday
    })
    .set({
      hour: 22,
      minute: 0,
      second: 0,
      millisecond: 0
    });
}

function getRaffleWinners(raffleId) {
  return db
    .prepare(`
      SELECT *
      FROM raffle_winners
      WHERE raffle_id = ?
      ORDER BY placement
    `)
    .all(raffleId);
}

function getWinnerTickets(
  raffleId,
  discordUserId
) {
  return db
    .prepare(`
      SELECT ticket_number
      FROM tickets
      WHERE raffle_id = ?
        AND discord_user_id = ?
      ORDER BY ticket_number
    `)
    .all(
      raffleId,
      discordUserId
    )
    .map((row) => row.ticket_number);
}

function buildOwnerSummary(raffle) {
  const winners = getRaffleWinners(raffle.id);

  const closeDate = DateTime
    .fromISO(raffle.closed_at, {
      zone: 'utc'
    })
    .setZone(MOUNTAIN_TIME_ZONE)
    .toFormat('cccc, LLLL d, yyyy');

  const lines = [
    '## 🎟️ Weekly Blurred Raffle Summary',
    '',
    `**Raffle:** #${raffle.id}`,
    `**Card:** ${raffle.card_name}`,
    `**Closed:** ${closeDate}`,
    ''
  ];

  if (winners.length === 0) {
    lines.push(
      '**No players earned tickets this week.**'
    );

    lines.push(
      '',
      `**Next available ticket:** ${getNextTicketNumber()}`
    );

    return lines.join('\n');
  }

  const allTicketNumbers = [];

  for (const winner of winners) {
    const ticketNumbers = getWinnerTickets(
      raffle.id,
      winner.discord_user_id
    );

    allTicketNumbers.push(...ticketNumbers);

    const placementLabel =
      winner.placement === 1
        ? '🥇 First Correct'
        : `🎟️ Correct Winner #${winner.placement}`;

    lines.push(
      `**${placementLabel}: ${winner.discord_username}**`
    );

    for (const ticketNumber of ticketNumbers) {
      lines.push(`• Tear ticket **${ticketNumber}**`);
    }

    lines.push('');
  }

  lines.push('### Tickets to Tear');

  for (const ticketNumber of allTicketNumbers) {
    const matchingWinner = winners.find(
      (winner) =>
        getWinnerTickets(
          raffle.id,
          winner.discord_user_id
        ).includes(ticketNumber)
    );

    lines.push(
      `🎟️ **${ticketNumber}** — ${
        matchingWinner
          ? matchingWinner.discord_username
          : 'Unknown'
      }`
    );
  }

  lines.push(
    '',
    `**Total tickets to tear:** ${allTicketNumbers.length}`
  );

  if (allTicketNumbers.length > 0) {
    lines.push(
      `**Ticket range:** ${
        allTicketNumbers[0]
      }–${
        allTicketNumbers[
          allTicketNumbers.length - 1
        ]
      }`
    );
  }

  lines.push(
    `**Next available ticket:** ${getNextTicketNumber()}`
  );

  return lines.join('\n');
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
  )
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const awardCorrectGuess = db.transaction(
  (raffle, user, now) => {
    const existingWinner = db
      .prepare(`
        SELECT *
        FROM raffle_winners
        WHERE raffle_id = ?
          AND discord_user_id = ?
      `)
      .get(
        raffle.id,
        user.id
      );

    if (existingWinner) {
      const existingTickets = getWinnerTickets(
        raffle.id,
        user.id
      );

      return {
        type: 'already_won',
        placement: existingWinner.placement,
        tickets: existingTickets
      };
    }

    const winnerCount = db
      .prepare(`
        SELECT COUNT(*) AS count
        FROM raffle_winners
        WHERE raffle_id = ?
      `)
      .get(raffle.id).count;

    if (winnerCount >= 5) {
      return {
        type: 'correct_no_tickets'
      };
    }

    const placement = winnerCount + 1;

    const ticketCount =
      placement === 1 ? 2 : 1;

    const nextTicket =
      getNextTicketNumber();

    db.prepare(`
      INSERT INTO raffle_winners (
        raffle_id,
        discord_user_id,
        discord_username,
        placement,
        tickets_awarded,
        won_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
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
      )
      VALUES (?, ?, ?, ?, ?)
    `);

    const ticketNumbers = [];

    for (
      let offset = 0;
      offset < ticketCount;
      offset += 1
    ) {
      const ticketNumber =
        nextTicket + offset;

      insertTicket.run(
        ticketNumber,
        raffle.id,
        user.id,
        user.username,
        now
      );

      ticketNumbers.push(ticketNumber);
    }

    db.prepare(`
      UPDATE settings
      SET value = ?
      WHERE key = 'next_ticket_number'
    `).run(
      String(
        nextTicket + ticketCount
      )
    );

    return {
      type: 'winner',
      placement,
      tickets: ticketNumbers
    };
  }
);

/*
 * Completely deletes the currently open raffle and restores the
 * next ticket number to the first ticket awarded during that raffle.
 *
 * This is intended for test raffles or accidental starts.
 */
const resetActiveRaffleTransaction = db.transaction(
  (raffleId) => {
    const raffle = db
      .prepare(`
        SELECT *
        FROM raffles
        WHERE id = ?
          AND status = 'open'
      `)
      .get(raffleId);

    if (!raffle) {
      return {
        reset: false,
        reason: 'not_found'
      };
    }

    const ticketInfo = db
      .prepare(`
        SELECT
          MIN(ticket_number) AS first_ticket,
          COUNT(*) AS ticket_count
        FROM tickets
        WHERE raffle_id = ?
      `)
      .get(raffleId);

    const guessesDeleted = db
      .prepare(`
        SELECT COUNT(*) AS count
        FROM guesses
        WHERE raffle_id = ?
      `)
      .get(raffleId).count;

    const winnersDeleted = db
      .prepare(`
        SELECT COUNT(*) AS count
        FROM raffle_winners
        WHERE raffle_id = ?
      `)
      .get(raffleId).count;

    db.prepare(`
      DELETE FROM tickets
      WHERE raffle_id = ?
    `).run(raffleId);

    db.prepare(`
      DELETE FROM raffle_winners
      WHERE raffle_id = ?
    `).run(raffleId);

    db.prepare(`
      DELETE FROM guesses
      WHERE raffle_id = ?
    `).run(raffleId);

    db.prepare(`
      DELETE FROM raffles
      WHERE id = ?
    `).run(raffleId);

    if (
      ticketInfo.first_ticket !== null &&
      Number.isSafeInteger(ticketInfo.first_ticket)
    ) {
      db.prepare(`
        UPDATE settings
        SET value = ?
        WHERE key = 'next_ticket_number'
      `).run(
        String(ticketInfo.first_ticket)
      );
    }

    return {
      reset: true,
      raffleId,
      cardName: raffle.card_name,
      guessesDeleted,
      winnersDeleted,
      ticketsDeleted: ticketInfo.ticket_count,
      restoredTicketNumber:
        ticketInfo.first_ticket !== null
          ? ticketInfo.first_ticket
          : getNextTicketNumber()
    };
  }
);

const closeRaffleTransaction = db.transaction(
  (raffleId, closedAt) => {
    const raffle = db
      .prepare(`
        SELECT *
        FROM raffles
        WHERE id = ?
      `)
      .get(raffleId);

    if (!raffle) {
      return {
        closed: false,
        reason: 'not_found'
      };
    }

    if (raffle.status !== 'open') {
      return {
        closed: false,
        reason: 'already_closed'
      };
    }

    db.prepare(`
      UPDATE raffles
      SET status = 'closed',
          closed_at = ?
      WHERE id = ?
        AND status = 'open'
    `).run(
      closedAt,
      raffleId
    );

    return {
      closed: true
    };
  }
);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds
  ]
});

/*
 * Sends each new guess to the private admin channel.
 * This does not change scoring or ticket assignment.
 */
async function sendGuessToAdmin({
  raffle,
  user,
  rawGuess,
  resultText,
  placement = null,
  tickets = []
}) {
  try {
    const adminChannel = await client.channels.fetch(
      process.env.ADMIN_CHANNEL_ID
    );

    if (
      !adminChannel ||
      !adminChannel.isTextBased()
    ) {
      console.error(
        'ADMIN_CHANNEL_ID does not point to a text channel.'
      );
      return;
    }

    const totalGuesses = db
      .prepare(`
        SELECT COUNT(*) AS count
        FROM guesses
        WHERE raffle_id = ?
      `)
      .get(raffle.id).count;

    const lines = [
      '## 🎟️ New Raffle Guess',
      `**Player:** <@${user.id}>`,
      `**Username:** ${user.username}`,
      `**Guess:** ${rawGuess}`,
      `**Result:** ${resultText}`
    ];

    if (placement !== null) {
      lines.push(
        `**Winning position:** #${placement}`
      );
    }

    if (tickets.length > 0) {
      lines.push(
        `**Tickets:** ${tickets
          .map((ticket) => `🎟️ ${ticket}`)
          .join(', ')}`
      );
    }

    lines.push(
      `**Total guesses this raffle:** ${totalGuesses}`
    );

    await adminChannel.send({
      content: lines.join('\n'),
      allowedMentions: {
        users: [user.id]
      }
    });
  } catch (error) {
    console.error(
      'Could not send guess to admin channel:',
      error
    );
  }
}

let raffleClosingCheckRunning = false;

async function sendRaffleClosingMessages(
  raffle
) {
  const summary = buildOwnerSummary(raffle);

  try {
    const owner = await client.users.fetch(
      process.env.OWNER_ID
    );

    await owner.send({
      content: summary
    });

    console.log(
      `Sent raffle #${raffle.id} summary to the owner.`
    );
  } catch (error) {
    console.error(
      'Could not DM the raffle owner:',
      error
    );
  }

  try {
    const adminChannel =
      await client.channels.fetch(
        process.env.ADMIN_CHANNEL_ID
      );

    if (
      adminChannel &&
      adminChannel.isTextBased()
    ) {
      await adminChannel.send({
        content: summary,
        allowedMentions: {
          parse: []
        }
      });
    } else {
      console.error(
        'ADMIN_CHANNEL_ID does not point to a text channel.'
      );
    }
  } catch (error) {
    console.error(
      'Could not send raffle summary to the admin channel:',
      error
    );
  }

  try {
    const guessChannel =
      await client.channels.fetch(
        process.env.GUESS_CHANNEL_ID
      );

    if (
      guessChannel &&
      guessChannel.isTextBased()
    ) {
      const closingEmbed = new EmbedBuilder()
        .setTitle('⏰ Guessing Is Now Closed!')
        .setDescription(
          'This week’s Blurred MTG Raffle is now closed.\n\n' +
          'The mystery card, ticket winners, and raffle winner will be announced Friday!'
        )
        .setFooter({
          text: `Raffle #${raffle.id}`
        })
        .setTimestamp();

      await guessChannel.send({
        embeds: [closingEmbed]
      });
    }
  } catch (error) {
    console.error(
      'Could not post the closing announcement:',
      error
    );
  }
}

async function closeRaffle(
  raffleId,
  reason = 'automatic'
) {
  const now = new Date().toISOString();

  const result = closeRaffleTransaction(
    raffleId,
    now
  );

  if (!result.closed) {
    return false;
  }

  const closedRaffle =
    getRaffleById(raffleId);

  console.log(
    `Closed raffle #${raffleId}. Reason: ${reason}`
  );

  await sendRaffleClosingMessages(
    closedRaffle
  );

  return true;
}

async function checkForScheduledRaffleClose() {
  if (raffleClosingCheckRunning) {
    return;
  }

  raffleClosingCheckRunning = true;

  try {
    const raffle = getActiveRaffle();

    if (!raffle) {
      return;
    }

    const scheduledClose =
      getScheduledCloseTime(raffle);

    const currentTime =
      DateTime.now().setZone(
        MOUNTAIN_TIME_ZONE
      );

    if (currentTime >= scheduledClose) {
      await closeRaffle(
        raffle.id,
        'Thursday 10:00 PM Mountain Time'
      );
    }
  } catch (error) {
    console.error(
      'Automatic raffle closing check failed:',
      error
    );
  } finally {
    raffleClosingCheckRunning = false;
  }
}

client.once(
  Events.ClientReady,
  async (readyClient) => {
    console.log(
      `Logged in as ${readyClient.user.tag}`
    );

    console.log(
      `SQLite database: ${databasePath}`
    );

    console.log(
      `Next physical ticket: ${getNextTicketNumber()}`
    );

    console.log(
      'Automatic raffle closing: Thursday at 10:00 PM Mountain Time'
    );

    await checkForScheduledRaffleClose();

    setInterval(
      checkForScheduledRaffleClose,
      60 * 1000
    );
  }
);

client.on(
  Events.InteractionCreate,
  async (interaction) => {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    try {
      if (
        interaction.commandName ===
        'raffleping'
      ) {
        await interaction.reply({
          content:
            `🎟️ The raffle bot is online.\n` +
            `Database: \`${databasePath}\`\n` +
            'Automatic closing: Thursday at 10:00 PM Mountain Time.',
          flags: MessageFlags.Ephemeral
        });

        return;
      }

      if (
        interaction.commandName ===
        'startraffle'
      ) {
        if (!isOwner(interaction)) {
          await interaction.reply({
            content:
              'Only the raffle owner can start a challenge.',
            flags: MessageFlags.Ephemeral
          });

          return;
        }

        const currentRaffle =
          getActiveRaffle();

        if (currentRaffle) {
          const scheduledClose =
            getScheduledCloseTime(
              currentRaffle
            );

          await interaction.reply({
            content:
              `A raffle is already open: **${currentRaffle.card_name}**.\n` +
              `It is scheduled to close ${scheduledClose.toFormat(
                "cccc, LLLL d 'at' h:mm a ZZZZ"
              )}.`,
            flags: MessageFlags.Ephemeral
          });

          return;
        }

        const cardName = interaction.options
          .getString('card', true)
          .trim();

        const aliasesText =
          interaction.options
            .getString('aliases')
            ?.trim() || '';

        const acceptedAnswers =
          parseAcceptedAnswers(
            cardName,
            aliasesText
          );

        if (!normalizeCardName(cardName)) {
          await interaction.reply({
            content:
              'Please enter a valid full card name.',
            flags: MessageFlags.Ephemeral
          });

          return;
        }

        const now =
          new Date().toISOString();

        const result = db
          .prepare(`
            INSERT INTO raffles (
              card_name,
              accepted_answers_json,
              status,
              started_at,
              started_by_id
            )
            VALUES (?, ?, 'open', ?, ?)
          `)
          .run(
            cardName,
            JSON.stringify(
              acceptedAnswers
            ),
            now,
            interaction.user.id
          );

        const newRaffle =
          getRaffleById(
            result.lastInsertRowid
          );

        const scheduledClose =
          getScheduledCloseTime(
            newRaffle
          );

        const announcement =
          new EmbedBuilder()
            .setTitle(
              '🎟️ A New Blurred MTG Raffle Has Begun!'
            )
            .setDescription(
              'Think you know the mystery Magic card? Submit your answer privately with `/guess`.\n\n' +
              '**Ticket rewards**\n' +
              '🥇 First correct answer: **2 tickets**\n' +
              '🎟️ Next four correct answers: **1 ticket each**\n\n' +
              'Capitalization and punctuation do not matter. The full card name is required.\n\n' +
              `**Guessing closes:** ${scheduledClose.toFormat(
                "cccc 'at' h:mm a ZZZZ"
              )}`
            )
            .setFooter({
              text:
                `Raffle #${result.lastInsertRowid}`
            })
            .setTimestamp();

        const guessChannel =
          await client.channels.fetch(
            process.env.GUESS_CHANNEL_ID
          );

        if (
          !guessChannel ||
          !guessChannel.isTextBased()
        ) {
          throw new Error(
            'GUESS_CHANNEL_ID does not point to a text channel.'
          );
        }

        const roleMention =
          process.env.RAFFLE_ROLE_ID
            ? `<@&${process.env.RAFFLE_ROLE_ID}>\n`
            : '';

        await guessChannel.send({
          content:
            roleMention || undefined,
          embeds: [announcement],
          allowedMentions:
            process.env.RAFFLE_ROLE_ID
              ? {
                  roles: [
                    process.env
                      .RAFFLE_ROLE_ID
                  ]
                }
              : {
                  parse: []
                }
        });

        await interaction.reply({
          content:
            `✅ Raffle #${result.lastInsertRowid} is now open.\n` +
            `**Answer:** ${cardName}\n` +
            `**Closes:** ${scheduledClose.toFormat(
              "cccc, LLLL d 'at' h:mm a ZZZZ"
            )}\n` +
            `**Accepted answers:** ${acceptedAnswers.join(
              ' • '
            )}`,
          flags: MessageFlags.Ephemeral
        });

        return;
      }

      if (
        interaction.commandName ===
        'resetraffle'
      ) {
        if (!isOwner(interaction)) {
          await interaction.reply({
            content:
              'Only the raffle owner can reset a raffle.',
            flags: MessageFlags.Ephemeral
          });

          return;
        }

        const confirmation = interaction.options
          .getString('confirm', true)
          .trim();

        if (confirmation !== 'RESET') {
          await interaction.reply({
            content:
              'Reset cancelled. Enter **RESET** in all capital letters to confirm.',
            flags: MessageFlags.Ephemeral
          });

          return;
        }

        const activeRaffle = getActiveRaffle();

        if (!activeRaffle) {
          await interaction.reply({
            content:
              'There is no active raffle to reset.',
            flags: MessageFlags.Ephemeral
          });

          return;
        }

        const resetResult =
          resetActiveRaffleTransaction(
            activeRaffle.id
          );

        if (!resetResult.reset) {
          await interaction.reply({
            content:
              'The raffle could not be reset because it is no longer active.',
            flags: MessageFlags.Ephemeral
          });

          return;
        }

        await interaction.reply({
          content:
            `🗑️ **Raffle #${resetResult.raffleId} was reset.**\n\n` +
            `**Card:** ${resetResult.cardName}\n` +
            `**Guesses deleted:** ${resetResult.guessesDeleted}\n` +
            `**Winners deleted:** ${resetResult.winnersDeleted}\n` +
            `**Tickets deleted:** ${resetResult.ticketsDeleted}\n` +
            `**Next physical ticket restored to:** ${resetResult.restoredTicketNumber}\n\n` +
            'You may now use `/startraffle` to begin a new raffle.',
          flags: MessageFlags.Ephemeral
        });

        try {
          const adminChannel =
            await client.channels.fetch(
              process.env.ADMIN_CHANNEL_ID
            );

          if (
            adminChannel &&
            adminChannel.isTextBased()
          ) {
            await adminChannel.send({
              content:
                `🗑️ **Raffle Reset**\n` +
                `Raffle #${resetResult.raffleId} (${resetResult.cardName}) was reset by <@${interaction.user.id}>.\n` +
                `Deleted ${resetResult.guessesDeleted} guesses, ${resetResult.winnersDeleted} winners, and ${resetResult.ticketsDeleted} tickets.\n` +
                `Next physical ticket: **${resetResult.restoredTicketNumber}**`,
              allowedMentions: {
                users: [interaction.user.id]
              }
            });
          }
        } catch (error) {
          console.error(
            'Could not log raffle reset in admin channel:',
            error
          );
        }

        return;
      }

      if (
        interaction.commandName ===
        'guess'
      ) {
        if (
          interaction.channelId !==
          process.env.GUESS_CHANNEL_ID
        ) {
          await interaction.reply({
            content:
              `Please submit guesses in <#${process.env.GUESS_CHANNEL_ID}>.`,
            flags: MessageFlags.Ephemeral
          });

          return;
        }

        const raffle =
          getActiveRaffle();

        if (!raffle) {
          await interaction.reply({
            content:
              'There is no active blurred-card raffle right now.',
            flags: MessageFlags.Ephemeral
          });

          return;
        }

        const scheduledClose =
          getScheduledCloseTime(raffle);

        const currentMountainTime =
          DateTime.now().setZone(
            MOUNTAIN_TIME_ZONE
          );

        if (
          currentMountainTime >=
          scheduledClose
        ) {
          await closeRaffle(
            raffle.id,
            'Late guess triggered scheduled close'
          );

          await interaction.reply({
            content:
              '⏰ Guessing has closed for this week’s raffle.',
            flags: MessageFlags.Ephemeral
          });

          return;
        }

        const rawGuess =
          interaction.options
            .getString('card', true)
            .trim();

        const normalizedGuess =
          normalizeCardName(rawGuess);

        if (!normalizedGuess) {
          await interaction.reply({
            content:
              'Please enter a full Magic card name.',
            flags: MessageFlags.Ephemeral
          });

          return;
        }

        const acceptedAnswers =
          JSON.parse(
            raffle.accepted_answers_json
          );

        const isCorrect =
          acceptedAnswers.includes(
            normalizedGuess
          );

        const now =
          new Date().toISOString();

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
          await sendGuessToAdmin({
            raffle,
            user: interaction.user,
            rawGuess,
            resultText: '❌ Incorrect'
          });

          await interaction.reply({
            content:
              '❌ That is not the correct card. Your guess remains private, and you may try again.',
            flags: MessageFlags.Ephemeral
          });

          return;
        }

        const award =
          awardCorrectGuess(
            raffle,
            interaction.user,
            now
          );

        if (
          award.type ===
          'already_won'
        ) {
          await sendGuessToAdmin({
            raffle,
            user: interaction.user,
            rawGuess,
            resultText: '✅ Correct — already earned tickets',
            placement: award.placement,
            tickets: award.tickets
          });

          await interaction.reply({
            content:
              '✅ You already solved this week’s card and your tickets are safely recorded:\n' +
              award.tickets
                .map(
                  (ticket) =>
                    `🎟️ **${ticket}**`
                )
                .join('\n'),
            flags: MessageFlags.Ephemeral
          });

          return;
        }

        if (
          award.type ===
          'correct_no_tickets'
        ) {
          await sendGuessToAdmin({
            raffle,
            user: interaction.user,
            rawGuess,
            resultText: '✅ Correct — all ticket positions already filled'
          });

          await interaction.reply({
            content:
              '✅ You identified the correct card! All five ticket-winning positions have already been claimed. Please keep the answer secret until the reveal.',
            flags: MessageFlags.Ephemeral
          });

          return;
        }

        await sendGuessToAdmin({
          raffle,
          user: interaction.user,
          rawGuess,
          resultText: '✅ Correct — tickets awarded',
          placement: award.placement,
          tickets: award.tickets
        });

        const placementText =
          award.placement === 1
            ? 'You were the **first correct player**!'
            : `You earned winning position **#${award.placement}**!`;

        await interaction.reply({
          content:
            `🎉 **Correct!** ${placementText}\n\n` +
            `You earned **${award.tickets.length} raffle ticket${
              award.tickets.length === 1
                ? ''
                : 's'
            }**:\n` +
            award.tickets
              .map(
                (ticket) =>
                  `🎟️ **${ticket}**`
              )
              .join('\n') +
            '\n\nPlease keep the answer secret until the raffle closes!',
          flags: MessageFlags.Ephemeral
        });

        return;
      }

      if (
        interaction.commandName ===
        'mytickets'
      ) {
        const tickets = db
          .prepare(`
            SELECT
              ticket_number,
              raffle_id,
              awarded_at,
              status
            FROM tickets
            WHERE discord_user_id = ?
            ORDER BY ticket_number
          `)
          .all(interaction.user.id);

        if (tickets.length === 0) {
          await interaction.reply({
            content:
              '🎟️ You have not earned any raffle tickets yet.',
            flags: MessageFlags.Ephemeral
          });

          return;
        }

        const shown =
          tickets.slice(-50);

        const ticketLines =
          shown.map(
            (ticket) =>
              `🎟️ **${ticket.ticket_number}** — Raffle #${ticket.raffle_id}`
          );

        const olderMessage =
          tickets.length > shown.length
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

      if (
        interaction.commandName ===
        'rafflestatus'
      ) {
        if (!isOwner(interaction)) {
          await interaction.reply({
            content:
              'Only the raffle owner can view the private raffle status.',
            flags: MessageFlags.Ephemeral
          });

          return;
        }

        const raffle =
          getActiveRaffle();

        if (!raffle) {
          await interaction.reply({
            content:
              'There is no active raffle.',
            flags: MessageFlags.Ephemeral
          });

          return;
        }

        const winners =
          getRaffleWinners(raffle.id);

        const totalGuesses = db
          .prepare(`
            SELECT COUNT(*) AS count
            FROM guesses
            WHERE raffle_id = ?
          `)
          .get(raffle.id).count;

        const recentGuesses = db
          .prepare(`
            SELECT
              discord_username,
              raw_guess,
              is_correct,
              submitted_at
            FROM guesses
            WHERE raffle_id = ?
            ORDER BY id DESC
            LIMIT 10
          `)
          .all(raffle.id);

        const recentGuessLines =
          recentGuesses.length > 0
            ? recentGuesses
                .map(
                  (guess) =>
                    `${guess.is_correct ? '✅' : '❌'} ` +
                    `**${guess.discord_username}:** ${guess.raw_guess}`
                )
                .join('\n')
            : 'No guesses have been submitted yet.';

        const winnerLines =
          winners.length > 0
            ? winners
                .map((winner) => {
                  const ticketNumbers =
                    getWinnerTickets(
                      raffle.id,
                      winner.discord_user_id
                    ).join(', ');

                  return (
                    `**#${winner.placement} ${winner.discord_username}** — ` +
                    ticketNumbers
                  );
                })
                .join('\n')
            : 'No correct winners yet.';

        const scheduledClose =
          getScheduledCloseTime(
            raffle
          );

        await interaction.reply({
          content:
            `## 🎟️ Active Raffle #${raffle.id}\n` +
            `**Correct card:** ${raffle.card_name}\n` +
            `**Total guesses:** ${totalGuesses}\n` +
            `**Winning positions filled:** ${winners.length}/5\n` +
            `**Scheduled close:** ${scheduledClose.toFormat(
              "cccc, LLLL d 'at' h:mm a ZZZZ"
            )}\n\n` +
            `${winnerLines}\n\n` +
            `### Recent Guesses\n` +
            `${recentGuessLines}\n\n` +
            `**Next available physical ticket:** ${getNextTicketNumber()}`,
          flags: MessageFlags.Ephemeral
        });

        return;
      }
    } catch (error) {
      console.error(
        'Interaction error:',
        error
      );

      const errorMessage = {
        content:
          'Something went wrong while processing that command. Please try again.',
        flags: MessageFlags.Ephemeral
      };

      if (
        interaction.replied ||
        interaction.deferred
      ) {
        await interaction
          .followUp(errorMessage)
          .catch(() => {});
      } else {
        await interaction
          .reply(errorMessage)
          .catch(() => {});
      }
    }
  }
);

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
