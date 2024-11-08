import axios from 'axios';

const ZENDESK_API_URL = `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;

const zendeskApi = axios.create({
  baseURL: ZENDESK_API_URL,
  auth: {
    username: `${process.env.ZENDESK_EMAIL}/token`,
    password: process.env.ZENDESK_API_TOKEN
  },
  headers: {
    'Content-Type': 'application/json',
  },
});

export async function createZendeskTicket(subject, discordThreadId) {
  try {
    const response = await zendeskApi.post('/tickets.json', {
      ticket: {
        subject: subject,
        comment: { body: "New Discord Ticket" },
      },
    });
    return response.data.ticket;
  } catch (error) {
    console.error('Error creating Zendesk ticket:', error);
    throw error;
  }
}

export async function updateZendeskTicket(ticketId, comment) {
  try {
    await zendeskApi.put(`/tickets/${ticketId}.json`, {
      ticket: {
        comment: { body: comment },
        status: "open"
      },
    });
  } catch (error) {
    console.error('Error updating Zendesk ticket:', error);
    throw error;
  }
}

export async function handleZendeskWebhook(req, res) {
  const { ticket } = req.body;
  if (!ticket) {
    return res.status(400).send('Invalid webhook payload');
  }

  const discordThreadId = ticket.custom_fields.find(field => field.id === 'discord_thread_id')?.value;
  if (!discordThreadId) {
    return res.status(400).send('Discord thread ID not found');
  }

  try {
    const thread = await client.channels.fetch(discordThreadId);
    await thread.send(`Ticket updated: ${ticket.subject}\nStatus: ${ticket.status}`);
    res.status(200).send('Webhook processed successfully');
  } catch (error) {
    console.error('Error processing Zendesk webhook:', error);
    res.status(500).send('Error processing webhook');
  }
}
