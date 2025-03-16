import { WebSocket } from "ws";
import {
  RTClient,
  RTResponse,
  RTInputAudioItem,
  RTTextContent,
  RTAudioContent,
} from "rt-client";
import { DefaultAzureCredential } from "@azure/identity";
import { AzureKeyCredential } from "@azure/core-auth";
import { Logger } from "pino";
import { JsonDataService } from "./json-data-service.js";
import path from "path";

interface TextDelta {
  id: string;
  type: "text_delta";
  delta: string;
}

interface Transcription {
  id: string;
  type: "transcription";
  text: string;
}

interface UserMessage {
  id: string;
  type: "user_message";
  text: string;
}

interface SpeechStarted {
  type: "control";
  action: "speech_started";
}

interface Connected {
  type: "control";
  action: "connected";
  greeting: string;
}

interface TextDone {
  type: "control";
  action: "text_done";
  id: string;
}

type ControlMessage = SpeechStarted | Connected | TextDone;

type WSMessage = TextDelta | Transcription | UserMessage | ControlMessage;

export class RTSession {
  private client: RTClient;
  private ws: WebSocket;
  private readonly sessionId: string;
  private logger: Logger;
  private dataService: JsonDataService | null = null;

  constructor(ws: WebSocket, backend: string | undefined, logger: Logger) {
    this.sessionId = crypto.randomUUID();
    this.ws = ws;
    this.logger = logger.child({ sessionId: this.sessionId });
    this.client = this.initializeClient(backend);
    this.setupEventHandlers();
    this.initializeDataService();
    this.logger.info("New session created");
    this.initialize();
    process.on("unhandledRejection", (reason) => {
      this.logger.error({ reason }, "Unhandled promise rejection");
    });
  }

  private async initializeDataService() {
    try {
      // Path to the JSON data file
      const dataPath = path.resolve(process.cwd(), process.env.SCULPTURE_DATA_PATH || "data/sculptures.json");

      this.dataService = new JsonDataService(dataPath);
      const loaded = await this.dataService.loadData();

      if (loaded) {
        this.logger.info(`Successfully loaded sculpture data from ${dataPath}`);
      } else {
        this.logger.error(`Failed to load sculpture data from ${dataPath}`);
        this.dataService = null;
      }
    } catch (error) {
      this.logger.error({ error }, "Error initializing data service");
      this.dataService = null;
    }
  }

  async initialize() {
    this.logger.debug("Configuring realtime session");
    await this.client.configure({
      modalities: ["text", "audio"],
      input_audio_format: "pcm16",
      input_audio_transcription: {
        model: "whisper-1",
      },
      voice: "verse",
      turn_detection: {
        type: "server_vad",
      },
    });

    this.logger.debug("Realtime session configured successfully");
    /* Send greeting */
    const greeting: Connected = {
      type: "control",
      action: "connected",
      greeting: "Hey there! I'm your friendly sculpture guide. Feel free to ask me anything about sculptures!",
    };
    this.send(greeting);
    this.logger.debug("Realtime session configured successfully");
    this.startEventLoop();
  }

  private send(message: WSMessage) {
    this.ws.send(JSON.stringify(message));
  }

  private sendBinary(message: ArrayBuffer) {
    this.ws.send(Buffer.from(message), { binary: true });
  }

  private initializeClient(backend: string | undefined): RTClient {
    this.logger.debug({ backend }, "Initializing RT client");

    if (backend === "azure") {
      //let auth = new DefaultAzureCredential();
      let auth = new AzureKeyCredential(process.env.AZURE_OPENAI_API_KEY!);

      return new RTClient(
        new URL(process.env.AZURE_OPENAI_ENDPOINT!),
        auth,
        { deployment: process.env.AZURE_OPENAI_DEPLOYMENT! },
      );
    }
    return new RTClient(new AzureKeyCredential(process.env.OPENAI_API_KEY!), {
      model: process.env.OPENAI_MODEL!,
    });
  }

  private setupEventHandlers() {
    this.logger.debug("Client configured successfully");

    this.ws.on("message", this.handleMessage.bind(this));
    this.ws.on("close", this.handleClose.bind(this));
    this.ws.on("error", (error) => {
      this.logger.error({ error }, "WebSocket error occurred");
    });
  }

  private async handleMessage(message: Buffer, isBinary: boolean) {
    try {
      if (isBinary) {
        await this.handleBinaryMessage(message);
      } else {
        await this.handleTextMessage(message);
      }
    } catch (error) {
      this.logger.error({ error }, "Error handling message");
    }
  }

  private async handleBinaryMessage(message: Buffer) {
    try {
      await this.client.sendAudio(new Uint8Array(message));
    } catch (error) {
      this.logger.error({ error }, "Failed to send audio data");
      throw error;
    }
  }

  private async handleTextMessage(message: Buffer) {
    const messageString = message.toString("utf-8");
    const parsed: WSMessage = JSON.parse(messageString);
    this.logger.debug({ messageType: parsed.type }, "Received text message");

    if (parsed.type === "user_message") {
      try {
        // Extract potential sculpture-related info from the message if we have data service
        if (this.dataService && parsed.text) {
          await this.enrichWithSculptureData(parsed.text);
        }

        await this.client.sendItem({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: parsed.text }],
        });
        await this.client.generateResponse();
        this.logger.debug("User message processed successfully");
      } catch (error) {
        this.logger.error({ error }, "Failed to process user message");
        throw error;
      }
    }
  }

  private async enrichWithSculptureData(userMessage: string) {
    if (!this.dataService) return;

    try {
      // Extract potential search terms from user message
      const sculptureMentions = this.extractSculptureTerms(userMessage);
      const artistMentions = this.extractArtistTerms(userMessage);
      const materialMentions = this.extractMaterialTerms(userMessage);
      const periodMentions = this.extractPeriodTerms(userMessage);

      // Define a threshold for confidence - if we have multiple terms, use the multi-search
      let hasRelevantResults = false;
      let contextMessage = "";

      // Try to match specific sculpture names first
      if (sculptureMentions.length > 0) {
        for (const sculptureName of sculptureMentions) {
          const results = await this.dataService.findSculptureByName(sculptureName);
          if (results && results.length > 0) {
            hasRelevantResults = true;
            contextMessage += this.formatSculptureInfo(results);
            break; // Found a direct match, no need to check others
          }
        }
      }

      // If no direct sculpture match, try by artist
      if (!hasRelevantResults && artistMentions.length > 0) {
        for (const artist of artistMentions) {
          const results = await this.dataService.getSculpturesByArtist(artist);
          if (results && results.length > 0) {
            hasRelevantResults = true;
            contextMessage += this.formatArtistSculptureInfo(results);
            break;
          }
        }
      }

      // Try by material if still no matches
      if (!hasRelevantResults && materialMentions.length > 0) {
        for (const material of materialMentions) {
          const results = await this.dataService.getSculpturesByMaterial(material);
          if (results && results.length > 0) {
            hasRelevantResults = true;
            contextMessage += this.formatMaterialSculptureInfo(results);
            break;
          }
        }
      }

      // Try by period if still no matches
      if (!hasRelevantResults && periodMentions.length > 0) {
        for (const period of periodMentions) {
          const results = await this.dataService.getSculpturesByPeriod(period);
          if (results && results.length > 0) {
            hasRelevantResults = true;
            contextMessage += this.formatPeriodSculptureInfo(results);
            break;
          }
        }
      }

      // If we have any matches, send the information to the AI
      if (hasRelevantResults && contextMessage) {
        await this.client.sendItem({
          type: "message",
          role: "system",
          content: [{ type: "input_text", text: `Here is relevant information about the sculptures from the database: ${contextMessage}` }],
        });
        this.logger.debug("Added sculpture context to conversation");
      }
    } catch (error) {
      this.logger.error({ error }, "Error enriching message with sculpture data");
    }
  }

  private formatSculptureInfo(sculptures: any[]): string {
    let info = "\n\nSCULPTURE INFORMATION:\n";
    sculptures.forEach((sculpture) => {
      info += `Name: ${sculpture.name}\n`;
      if (sculpture.artist) info += `Artist: ${sculpture.artist}\n`;
      if (sculpture.year) info += `Year: ${sculpture.year}\n`;
      if (sculpture.material) info += `Material: ${sculpture.material}\n`;
      if (sculpture.location) info += `Location: ${sculpture.location}\n`;
      if (sculpture.description) info += `Description: ${sculpture.description}\n`;
      if (sculpture.imageUrl) info += `Image URL: ${sculpture.imageUrl}\n`;
      if (sculpture.visualDescription) info += `Visual Description: ${sculpture.visualDescription}\n`;
      info += "\n";
    });
    return info;
  }

  private formatArtistSculptureInfo(results: any[]): string {
    let info = "\n\nARTIST AND SCULPTURE INFORMATION:\n";
    results.forEach((result) => {
      const { sculpture, artist } = result;
      info += `Artist: ${artist.name}\n`;
      if (artist.birthYear) info += `Born: ${artist.birthYear}\n`;
      if (artist.deathYear) info += `Died: ${artist.deathYear}\n`;
      if (artist.nationality) info += `Nationality: ${artist.nationality}\n`;
      if (artist.bio) info += `Biography: ${artist.bio}\n`;

      info += `\nSculpture: ${sculpture.name}\n`;
      if (sculpture.year) info += `Year: ${sculpture.year}\n`;
      if (sculpture.material) info += `Material: ${sculpture.material}\n`;
      if (sculpture.location) info += `Location: ${sculpture.location}\n`;
      if (sculpture.description) info += `Description: ${sculpture.description}\n`;
      if (sculpture.imageUrl) info += `Image URL: ${sculpture.imageUrl}\n`;
      if (sculpture.visualDescription) info += `Visual Description: ${sculpture.visualDescription}\n`;
      info += "\n";
    });
    return info;
  }

  private formatMaterialSculptureInfo(results: any[]): string {
    let info = "\n\nMATERIAL AND SCULPTURE INFORMATION:\n";
    results.forEach((result) => {
      const { sculpture, material } = result;
      info += `Material: ${material.name}\n`;
      if (material.properties) info += `Properties: ${material.properties}\n`;
      if (material.uses) info += `Common Uses: ${material.uses}\n`;

      info += `\nSculpture: ${sculpture.name}\n`;
      if (sculpture.artist) info += `Artist: ${sculpture.artist}\n`;
      if (sculpture.year) info += `Year: ${sculpture.year}\n`;
      if (sculpture.location) info += `Location: ${sculpture.location}\n`;
      if (sculpture.description) info += `Description: ${sculpture.description}\n`;
      if (sculpture.imageUrl) info += `Image URL: ${sculpture.imageUrl}\n`;
      if (sculpture.visualDescription) info += `Visual Description: ${sculpture.visualDescription}\n`;
      info += "\n";
    });
    return info;
  }

  private formatPeriodSculptureInfo(results: any[]): string {
    let info = "\n\nPERIOD AND SCULPTURE INFORMATION:\n";
    results.forEach((result) => {
      const { sculpture, period } = result;
      info += `Period: ${period.name}\n`;
      if (period.startYear) info += `Started: ${period.startYear}\n`;
      if (period.endYear) info += `Ended: ${period.endYear}\n`;
      if (period.characteristics) info += `Characteristics: ${period.characteristics}\n`;

      info += `\nSculpture: ${sculpture.name}\n`;
      if (sculpture.artist) info += `Artist: ${sculpture.artist}\n`;
      if (sculpture.year) info += `Year: ${sculpture.year}\n`;
      if (sculpture.material) info += `Material: ${sculpture.material}\n`;
      if (sculpture.location) info += `Location: ${sculpture.location}\n`;
      if (sculpture.description) info += `Description: ${sculpture.description}\n`;
      if (sculpture.imageUrl) info += `Image URL: ${sculpture.imageUrl}\n`;
      if (sculpture.visualDescription) info += `Visual Description: ${sculpture.visualDescription}\n`;
      info += "\n";
    });
    return info;
  }

  // Simple keyword extraction functions - could be enhanced with NLP libraries
  private extractSculptureTerms(text: string): string[] {
    // Common sculpture names and keywords
    const commonSculptures = [
      "David", "Pieta", "Venus de Milo", "The Thinker", "Ecstasy of Saint Teresa",
      "Bust of Nefertiti", "Terracotta Army", "Winged Victory", "Perseus with the Head of Medusa",
      "Statue of Liberty", "Christ the Redeemer", "Burghers of Calais"
    ];

    return this.extractTermsFromText(text, commonSculptures);
  }

  private extractArtistTerms(text: string): string[] {
    // Common sculptor names
    const commonArtists = [
      "Michelangelo", "Bernini", "Rodin", "Donatello", "Alexandros", "Antioch",
      "Gian Lorenzo Bernini", "Auguste Rodin"
    ];

    return this.extractTermsFromText(text, commonArtists);
  }

  private extractMaterialTerms(text: string): string[] {
    // Common sculpture materials
    const commonMaterials = [
      "marble", "bronze", "stone", "wood", "clay", "terracotta", "steel"
    ];

    return this.extractTermsFromText(text, commonMaterials);
  }

  private extractPeriodTerms(text: string): string[] {
    // Common art periods
    const commonPeriods = [
      "Renaissance", "Baroque", "Classical", "Hellenistic", "Modern"
    ];

    return this.extractTermsFromText(text, commonPeriods);
  }

  private extractTermsFromText(text: string, terms: string[]): string[] {
    const lowerText = text.toLowerCase();
    return terms.filter(term =>
      lowerText.includes(term.toLowerCase())
    );
  }

  private async handleClose() {
    this.logger.info("Session closing");
    try {
      await this.client.close();
      this.logger.info("Session closed successfully");
    } catch (error) {
      this.logger.error({ error }, "Error closing session");
    }
  }

  private async handleTextContent(content: RTTextContent) {
    try {
      const contentId = `${content.itemId}-${content.contentIndex}`;
      for await (const text of content.textChunks()) {
        const deltaMessage: TextDelta = {
          id: contentId,
          type: "text_delta",
          delta: text,
        };
        this.send(deltaMessage);
      }
      this.send({ type: "control", action: "text_done", id: contentId });
      this.logger.debug("Text content processed successfully");
    } catch (error) {
      this.logger.error({ error }, "Error handling text content");
      throw error;
    }
  }

  private async handleAudioContent(content: RTAudioContent) {
    const handleAudioChunks = async () => {
      for await (const chunk of content.audioChunks()) {
        this.sendBinary(chunk.buffer instanceof ArrayBuffer ? chunk.buffer : new ArrayBuffer(chunk.buffer.byteLength).slice(0));
      }
    };

    const handleAudioTranscript = async () => {
      const contentId = `${content.itemId}-${content.contentIndex}`;
      for await (const chunk of content.transcriptChunks()) {
        this.send({ id: contentId, type: "text_delta", delta: chunk });
      }
      this.send({ type: "control", action: "text_done", id: contentId });
    };

    try {
      await Promise.all([handleAudioChunks(), handleAudioTranscript()]);
      this.logger.debug("Audio content processed successfully");
    } catch (error) {
      this.logger.error({ error }, "Error handling audio content");
      throw error;
    }
  }

  private async handleResponse(event: RTResponse) {
    try {
      for await (const item of event) {
        if (item.type === "message") {
          for await (const content of item) {
            if (content.type === "text") {
              await this.handleTextContent(content);
            } else if (content.type === "audio") {
              await this.handleAudioContent(content);
            }
          }
        }
      }
      this.logger.debug("Response handled successfully");
    } catch (error) {
      this.logger.error({ error }, "Error handling response");
      throw error;
    }
  }

  private async handleInputAudio(event: RTInputAudioItem) {
    try {
      this.send({ type: "control", action: "speech_started" });
      await event.waitForCompletion();
      const transcription: Transcription = {
        id: event.id,
        type: "transcription",
        text: event.transcription || "",
      };
      this.send(transcription);
      this.logger.debug(
        { transcriptionLength: transcription.text.length },
        "Input audio processed successfully",
      );
    } catch (error) {
      this.logger.error({ error }, "Error handling input audio");
      throw error;
    }
  }

  private async startEventLoop() {
    // Set up the agent with system message about sculptures - more friendly tone
    this.client.sendItem(
      {
        type: "message", role: "system", content: [
          { type: "input_text", text: "You are a friendly and enthusiastic sculpture guide named Art. Your tone is warm, engaging, and conversational - like a passionate friend sharing interesting stories about art. You love to make sculpture knowledge accessible and fun for everyone. Use casual language, occasional humor, and relatable examples when explaining complex concepts. When you receive questions about sculptures, use the database information provided to answer accurately, but present it in an engaging, conversational way. If specific information isn't available in the database, you may provide general knowledge, but clearly indicate this with phrases like 'Beyond our collection...' or 'Art historians generally believe...'" },
        ]
      }
    );

    // Add initial data about the sculpture knowledge base - friendlier style
    this.client.sendItem(
      {
        type: "message", role: "system", content: [
          { type: "input_text", text: "The database contains fascinating information about sculptures, including details about the artists, materials used, historical context, and where they are currently displayed. It also includes image URLs and detailed visual descriptions of each sculpture. For visually impaired users, emphasize these visual descriptions to help them form a mental image of the artwork. When discussing any sculpture, always include its visual aspects - describe colors, shapes, textures, expressions, poses, and other important visual elements in rich, evocative language. Share this information with enthusiasm and help users discover the amazing stories and visual beauty behind these works. Feel free to express appreciation for the craftsmanship and beauty of the sculptures you discuss. Respond as if you're giving a personal, immersive tour through a museum - knowledgeable but approachable and engaging, with special attention to helping visually impaired users experience the art through your descriptions." },
        ]
      }
    );

    try {
      this.logger.debug("Starting event loop");
      for await (const event of this.client.events()) {
        if (event.type === "response") {
          await this.handleResponse(event);
        } else if (event.type === "input_audio") {
          await this.handleInputAudio(event);
        }
      }
    } catch (error) {
      this.logger.error({ error }, "Error in event loop");
      throw error;
    }
  }
}
