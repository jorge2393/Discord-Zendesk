import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import {
  InteractionType,
  InteractionResponseType,
  verifyKeyMiddleware,
} from 'discord-interactions';
import { getRandomEmoji } from './utils.js';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { createZendeskTicket, updateZendeskTicket } from './zendesk.js';
import fs from 'fs';
import axios from 'axios'; // Import axios for making HTTP requests

// Create an express app
const app = express();
// Get port, or default to 3000
const PORT = process.env.PORT || 3000;

// Function to log events
function logEvent(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `${timestamp}: ${message}\n`;
  fs.appendFile('app.log', logMessage, (err) => {
    if (err) console.error('Error writing to log file:', err);
  });
}

// Initialize Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Login to Discord client
client.login(process.env.DISCORD_TOKEN);

// Listen for new thread creations
client.on(Events.ThreadCreate, async (thread) => {
  if (thread.parentId === process.env.DISCORD_SUPPORT_FORUM_ID) {
    try {
      const ticket = await createZendeskTicket(thread.name, { });
      await thread.send(`ZENDESK_TICKET_ID:${ticket.id}`);
      
      logEvent(`New thread created: ${thread.id}, Zendesk ticket: ${ticket.id}`);

      // Integrate the curl command using axios
      const zendeskApiUrl = `https://crossmint.zendesk.com/api/v2/tickets/${ticket.id}.json`;
      const zendeskApiKey = process.env.ZENDESK_API_TOKEN;
      const zendeskEmail = process.env.ZENDESK_EMAIL;

      const response = await axios.put(zendeskApiUrl, {
        ticket: {
          custom_fields: [
            {
              id: 30319722169997,
              value: thread.id
            }
          ],
          group_id: 31036620834573
        }
      }, {
        headers: {
          'Content-Type': 'application/json'
        },
        auth: {
          username: `jorge@paella.dev/token`,
          password: process.env.ZENDESK_API_TOKEN
        }
      });

      console.log('Zendesk ticket updated successfully:', response.data);
    } catch (error) {
      console.error('Error creating or updating Zendesk ticket:', error);
      await thread.send('Failed to create or update Zendesk ticket. Please try again later.');
      logEvent(`Error creating or updating Zendesk ticket for thread: ${thread.id}`);
    }
  }
});

// Listen for new messages in Discord threads
client.on(Events.MessageCreate, async (message) => {
  if (message.channel.isThread() && message.channel.parentId === process.env.DISCORD_SUPPORT_FORUM_ID) {
    if (!message.author.bot) {
      try {
        // Wait for a short time to ensure the ticket ID message has been sent
        await new Promise(resolve => setTimeout(resolve, 1000));

        let ticketId = null;
        let attempts = 0;
        const maxAttempts = 3;

        while (!ticketId && attempts < maxAttempts) {
          ticketId = await getZendeskTicketIdFromThread(message.channel);
          if (!ticketId) {
            attempts++;
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retrying
          }
        }

        if (ticketId) {
          const messageContent = `${message.content}\n\n*Message from Discord*`;
          await updateZendeskTicket(ticketId, messageContent);
          logEvent(`Updated Zendesk ticket: ${ticketId} for thread: ${message.channel.id}`);
        } else {
          console.error(`Failed to retrieve Zendesk ticket ID for thread: ${message.channel.id}`);
          logEvent(`Failed to retrieve Zendesk ticket ID for thread: ${message.channel.id}`);
        }
      } catch (error) {
        console.error('Error updating Zendesk ticket:', error);
        logEvent(`Error updating Zendesk ticket for thread: ${message.channel.id}`);
      }
    }
  }
});

// Zendesk webhook endpoint
app.post('/zendesk-webhook', bodyParser.json(), async (req, res) => {
  const { threadID, comment_description, commenter_id } = req.body;

  // Log the incoming payload
  logEvent(`Received webhook payload: ${JSON.stringify(req.body)}`);

  try {
    // Fetch open threads in the support forum channel
    const channel = await client.channels.fetch(process.env.DISCORD_SUPPORT_FORUM_ID);
    const threads = await channel.threads.fetchActive(); // Fetch active threads

    // Log the fetched active threads
    logEvent(`Fetched active threads: ${JSON.stringify(threads.threads.map(t => t.id))}`);

    // Log the threadID from the payload
    logEvent(`Thread ID from payload: ${threadID}`);

    // Check if the threadID matches any open thread
    const thread = threads.threads.find(t => t.id === threadID);
    if (thread) {
      // Log the matching thread
      logEvent(`Matching thread found: ${thread.id}`);

      // Prepare the message to send to the Discord webhook
      const webhookPayload = {
        "content": comment_description
      };

      // Determine the webhook URL based on the commenter_id
      let webhookUrl;
      if (commenter_id === '27124286946829') {
        webhookUrl = `https://discord.com/api/webhooks/1295717953408471070/GXg3pap-POFYJIMyAk90xrRJWJujCY3jsfJkZgQy0ofVXxXPd64iSZ4sb94Vgy38Xdwl?thread_id=${thread.id}`;
      } else if (commenter_id === '10715210359693') {
        webhookUrl = `https://discord.com/api/webhooks/1303768721902407812/g39XVwC03djHVSum95p6NGDKMPF8xX5EMvxBQw5nUXXpqm2UMoLlAxPiO1UUaSctJITY?thread_id=${thread.id}`;
      } else {
        logEvent(`No valid webhook URL for commenter_id: ${commenter_id}`);
        return res.sendStatus(400); // Respond with a 400 Bad Request
      }

      const webhookResponse = await axios.post(webhookUrl, webhookPayload);
      logEvent(`Sent message to Discord webhook: ${comment_description}`);
      logEvent(`Response from Discord webhook: ${webhookResponse.status}`);
    } else {
      logEvent(`No matching thread found for ID: ${threadID}`);
    }

    res.sendStatus(200); // Respond with a 200 OK
  } catch (error) {
    console.error('Error processing Zendesk webhook:', error);
    logEvent(`Error processing Zendesk webhook: ${error.message}`);
    res.sendStatus(500); // Respond with a 500 Internal Server Error
  }
});

/**
 * Interactions endpoint URL where Discord will send HTTP requests
 * Parse request body and verifies incoming requests using discord-interactions package
 */
app.post('/interactions', verifyKeyMiddleware(process.env.PUBLIC_KEY), async function (req, res) {
  // Interaction type and data
  const { type, data } = req.body;

  /**
   * Handle verification requests
   */
  if (type === InteractionType.PING) {
    logEvent('Received PING interaction');
    return res.send({ type: InteractionResponseType.PONG });
  }

  /**
   * Handle slash command requests
   * See https://discord.com/developers/docs/interactions/application-commands#slash-commands
   */
  if (type === InteractionType.APPLICATION_COMMAND) {
    const { name } = data;

    // "test" command
    if (name === 'test') {
      logEvent('Received test command');
      // Send a message into the channel where command was triggered from
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          // Fetches a random emoji to send from a helper function
          content: `hello world ${getRandomEmoji()}`,
        },
      });
    }

    console.error(`unknown command: ${name}`);
    logEvent(`Received unknown command: ${name}`);
    return res.status(400).json({ error: 'unknown command' });
  }

  console.error('unknown interaction type', type);
  logEvent(`Received unknown interaction type: ${type}`);
  return res.status(400).json({ error: 'unknown interaction type' });
});

app.listen(PORT, () => {
  console.log('Listening on port', PORT);
  logEvent(`Server started on port ${PORT}`);
});

// Helper function to get Zendesk ticket ID from thread
async function getZendeskTicketIdFromThread(thread) {
  const messages = await thread.messages.fetch({ limit: 100 }); // Fetch more messages to ensure we don't miss it
  for (const message of messages.values()) {
    if (message.content.startsWith('ZENDESK_TICKET_ID:')) {
      return message.content.split(':')[1].trim();
    }
  }
  return null; // Return null instead of throwing an error
}

client.on('error', console.error);
client.once('ready', () => {
  console.log('Discord bot is ready!');
});
