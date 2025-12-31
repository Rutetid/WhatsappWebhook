const express = require("express");
require("dotenv").config();
const mongoose = require("mongoose");
const axios = require("axios");

const app = express();

// CORS middleware - allows frontend to make requests
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");

  // Handle preflight requests
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  next();
});

app.use(express.json());

const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN;

// MongoDB Connection
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("✓ Connected to MongoDB Atlas"))
  .catch((err) => console.error("✗ MongoDB connection error:", err));

// Message Schema
const messageSchema = new mongoose.Schema({
  messageId: {
    type: String,
    required: true,
    unique: true,
  },
  conversationId: {
    type: String,
    required: true,
    index: true, // Index for fast conversation queries
  },
  from: {
    type: String,
    required: true,
    index: true,
  },
  fromName: {
    type: String,
    default: "Unknown",
  },
  to: {
    type: String,
    required: true,
    index: true,
  },
  body: {
    type: String,
    required: true,
  },
  timestamp: {
    type: Date,
    default: Date.now,
    index: -1, // Descending index for chronological sorting (newest first)
  },
  direction: {
    type: String,
    enum: ["incoming", "outgoing"],
    required: true,
  },
  status: {
    type: String,
    default: "delivered",
  },
});

// Compound index for efficient conversation queries (sorted by time)
messageSchema.index({ conversationId: 1, timestamp: 1 });

const Message = mongoose.model("Message", messageSchema);

app.get("/", (req, res) => {
  const {
    "hub.mode": mode,
    "hub.challenge": challenge,
    "hub.verify_token": token,
  } = req.query;

  if (mode === "subscribe" && token === verifyToken) {
    console.log("WEBHOOK VERIFIED");
    res.status(200).send(challenge);
  } else {
    res.status(403).end();
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    mongodb:
      mongoose.connection.readyState === 1 ? "connected" : "disconnected",
    timestamp: new Date().toISOString(),
  });
});

app.post("/", async (req, res) => {
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`\n\nWebhook received ${timestamp}\n`);
  console.log(JSON.stringify(req.body, null, 2));

  try {
    // Extract message data from WhatsApp webhook payload
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;
    const contacts = value?.contacts;

    if (messages && messages.length > 0) {
      const message = messages[0];

      // Only process text messages
      if (message.type === "text") {
        // Get sender's name from contacts array
        const senderName = contacts?.[0]?.profile?.name || "Unknown";

        // Create conversation ID: use the other person's phone number
        // This way all messages with the same contact share the same conversationId
        const conversationId = message.from;

        const messageData = {
          messageId: message.id,
          conversationId: conversationId,
          from: message.from,
          fromName: senderName,
          to: value.metadata.phone_number_id,
          body: message.text.body,
          timestamp: new Date(parseInt(message.timestamp) * 1000),
          direction: "incoming",
          status: "received",
        };

        // Save to MongoDB
        const newMessage = new Message(messageData);
        await newMessage.save();
        console.log("✓ Message saved to MongoDB:", messageData.body);
      } else {
        console.log(`Skipping non-text message type: ${message.type}`);
      }
    }
  } catch (error) {
    if (error.code === 11000) {
      console.log("Message already exists in database (duplicate)");
    } else {
      console.error("Error saving message:", error);
    }
  }

  res.status(200).end();
});

// Helper function to save outgoing messages
async function saveOutgoingMessage(to, messageBody, messageId) {
  try {
    const messageData = {
      messageId: messageId || `out_${Date.now()}`,
      conversationId: to, // Use recipient's phone as conversationId
      from: process.env.WHATSAPP_PHONE_NUMBER_ID,
      to: to,
      body: messageBody,
      timestamp: new Date(),
      direction: "outgoing",
      status: "sent",
    };

    const newMessage = new Message(messageData);
    await newMessage.save();
    console.log("✓ Outgoing message saved to MongoDB");
    return newMessage;
  } catch (error) {
    console.error("Error saving outgoing message:", error);
    throw error;
  }
}

// API endpoint to get all conversations (unique contacts)
app.get("/api/conversations", async (req, res) => {
  try {
    const conversations = await Message.aggregate([
      {
        $sort: { timestamp: -1 },
      },
      {
        $group: {
          _id: "$conversationId",
          lastMessage: { $first: "$body" },
          lastMessageTime: { $first: "$timestamp" },
          fromName: { $first: "$fromName" },
          unreadCount: {
            $sum: {
              $cond: [{ $eq: ["$direction", "incoming"] }, 1, 0],
            },
          },
        },
      },
      {
        $sort: { lastMessageTime: -1 },
      },
    ]);

    res.json({ success: true, conversations });
  } catch (error) {
    console.error("Error fetching conversations:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API endpoint to get all messages for a specific conversation
app.get("/api/messages/:conversationId", async (req, res) => {
  try {
    const { conversationId } = req.params;
    const messages = await Message.find({ conversationId })
      .sort({ timestamp: 1 }) // Oldest first for chat display
      .exec();

    res.json({ success: true, messages });
  } catch (error) {
    console.error("Error fetching messages:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST endpoint to send messages from frontend to WhatsApp
app.post("/api/send-message", async (req, res) => {
  try {
    const { to, message } = req.body;

    // Validate input
    if (!to || !message) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: 'to' and 'message'",
      });
    }

    // WhatsApp API URL
    const whatsappApiUrl = `https://graph.facebook.com/v23.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

    // Prepare WhatsApp API payload
    const whatsappPayload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: to,
      type: "text",
      text: {
        body: message,
      },
    };

    // Send message to WhatsApp API
    const whatsappResponse = await axios.post(whatsappApiUrl, whatsappPayload, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      },
    });

    // If WhatsApp API responds successfully, save to MongoDB
    if (whatsappResponse.data && whatsappResponse.data.messages) {
      const messageId = whatsappResponse.data.messages[0].id;

      const messageData = {
        messageId: messageId,
        conversationId: to,
        from: process.env.WHATSAPP_PHONE_NUMBER_ID,
        to: to,
        body: message,
        timestamp: new Date(),
        direction: "outgoing",
        status: "sent",
      };

      const newMessage = new Message(messageData);
      await newMessage.save();

      console.log("✓ Message sent to WhatsApp and saved to MongoDB");

      res.json({
        success: true,
        message: "Message sent successfully",
        messageId: messageId,
        whatsappResponse: whatsappResponse.data,
      });
    } else {
      res.status(500).json({
        success: false,
        error: "WhatsApp API did not return expected response",
      });
    }
  } catch (error) {
    console.error(
      "Error sending message:",
      error.response?.data || error.message
    );

    // Return error to frontend
    res.status(error.response?.status || 500).json({
      success: false,
      error: "Failed to send message",
      details: error.response?.data || error.message,
    });
  }
});

app.listen(port, () => {
  console.log(`\nListening on port ${port}\n`);
});
