import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import fsPromises from 'fs/promises';
import axios from 'axios';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import ytdl from 'ytdl-core';
import { GoogleGenerativeAI } from '@google/generative-ai';

ffmpeg.setFfmpegPath(ffmpegStatic ?? undefined);

const app = express();
const PORT = Number(process.env.PORT ?? 4000);
const ROOT_DIR = process.cwd();
const DATA_DIR = path.resolve(ROOT_DIR, 'data');
const CLIENT_DIST = path.resolve(ROOT_DIR, 'client', 'dist');

await fsPromises.mkdir(DATA_DIR, { recursive: true });

app.use(cors());
app.use(express.json({ limit: '25mb' }));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, DATA_DIR);
  },
  filename: (_req, file, cb) => {
    const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
    const safeName = file.originalname.replace(/[^a-zA-Z0-9.\-]+/g, '_');
    cb(null, `${timestamp}-${safeName}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 1_500_000_000 // ~1.5GB
  }
});

type CleanupMode = 'orthography' | 'grammar';

type AssemblyTranscript = {
  id: string;
  text: string;
  utterances?: Array<{
    start: number;
    end: number;
    text: string;
    speaker?: string;
  }>;
  words?: Array<{
    start: number;
    end: number;
    text: string;
  }>;
  [key: string]: unknown;
};

type CleanupResult = {
  cleanedText: string;
  corrections: Array<{
    before: string;
    after: string;
    reason: string;
    timestamp?: number | null;
  }>;
};

function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res, next).catch(next);
  };
}

function isCleanupMode(value: unknown): value is CleanupMode {
  return value === 'orthography' || value === 'grammar';
}

function requireKeys(body: Record<string, unknown>): { assemblyKey: string; googleKey: string } {
  const assemblyKey = typeof body.assemblyKey === 'string' ? body.assemblyKey.trim() : '';
  const googleKey = typeof body.googleKey === 'string' ? body.googleKey.trim() : '';
  if (!assemblyKey || !googleKey) {
    throw new Error('Both AssemblyAI and Google API keys are required.');
  }
  return { assemblyKey, googleKey };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function convertToWavIfNeeded(filePath: string): Promise<string> {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.wav' || extension === '.mp3' || extension === '.m4a') {
    return filePath;
  }

  const convertedPath = filePath.replace(extension, '.wav');
  await new Promise<void>((resolve, reject) => {
    ffmpeg(filePath)
      .output(convertedPath)
      .audioCodec('pcm_s16le')
      .on('end', () => resolve())
      .on('error', (error) => reject(error))
      .run();
  });

  return convertedPath;
}

async function uploadToAssemblyAI(filePath: string, apiKey: string) {
  const fileStream = fs.createReadStream(filePath);
  const response = await axios.post('https://api.assemblyai.com/v2/upload', fileStream, {
    headers: {
      authorization: apiKey,
      'Transfer-Encoding': 'chunked'
    },
    maxContentLength: Infinity,
    maxBodyLength: Infinity
  });
  return response.data.upload_url as string;
}

async function requestTranscript(uploadUrl: string, apiKey: string) {
  const response = await axios.post(
    'https://api.assemblyai.com/v2/transcript',
    {
      audio_url: uploadUrl,
      speaker_labels: true,
      punctuate: true
    },
    {
      headers: {
        authorization: apiKey,
        'Content-Type': 'application/json'
      }
    }
  );

  return response.data.id as string;
}

async function pollTranscript(transcriptId: string, apiKey: string): Promise<AssemblyTranscript> {
  for (;;) {
    const response = await axios.get(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
      headers: { authorization: apiKey }
    });
    const data = response.data as AssemblyTranscript & { status: string; error?: string };
    if (data.status === 'completed') {
      return data;
    }
    if (data.status === 'error') {
      throw new Error(data.error || 'AssemblyAI transcription failed.');
    }
    await delay(5000);
  }
}

async function fetchYoutubeAudio(url: string, destination: string) {
  const info = await ytdl.getInfo(url);
  const title = info.videoDetails.title.replace(/[^a-zA-Z0-9.\-]+/g, '_');
  const targetPath = path.join(destination, `${title}-${Date.now()}.mp3`);
  const writeStream = fs.createWriteStream(targetPath);

  await new Promise<void>((resolve, reject) => {
    ytdl(url, { quality: 'highestaudio' })
      .pipe(writeStream)
      .on('finish', () => resolve())
      .on('error', (error) => reject(error));
  });

  return targetPath;
}

function createGenerativeModel(googleKey: string, mode: CleanupMode) {
  const systemInstruction =
    'You are an expert transcript editor. Clean up transcripts for readability while preserving the speakers\' intent.';
  const client = new GoogleGenerativeAI(googleKey);
  return client.getGenerativeModel({
    model: 'gemini-2.5-pro',
    systemInstruction,
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json'
    }
  });
}

function buildCleanupPrompt(text: string, mode: CleanupMode) {
  const modeInstructions =
    mode === 'orthography'
      ? 'Focus exclusively on fixing orthography: casing, punctuation, spacing, and speaker labels. Do not alter wording or grammar.'
      : 'Fix orthography plus light grammar issues that improve clarity while preserving meaning and speaker voice. Avoid rewriting or summarizing.';

  return `Clean the following transcript according to the rules below.\n\nRules:\n- ${modeInstructions}\n- Preserve speaker labels if present.\n- Return a JSON object with keys: cleanedText (string) and corrections (array).\n- Each correction object must include before, after, reason, and timestamp (seconds, number or null if unavailable).\n- Corrections should list only the portions that changed.\n\nTranscript:\n\n${text}`;
}

function parseCleanupResponse(raw: string): CleanupResult {
  const trimmed = raw.trim();
  const match = trimmed.match(/\{[\s\S]*\}/);
  const jsonString = match ? match[0] : trimmed;
  const parsed = JSON.parse(jsonString) as CleanupResult;
  if (!parsed.cleanedText || !Array.isArray(parsed.corrections)) {
    throw new Error('Model response missing required fields.');
  }
  return parsed;
}

function toSrtTimestamp(ms: number) {
  const date = new Date(ms);
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const seconds = String(date.getUTCSeconds()).padStart(2, '0');
  const milliseconds = String(date.getUTCMilliseconds()).padStart(3, '0');
  return `${hours}:${minutes}:${seconds},${milliseconds}`;
}

function toVttTimestamp(ms: number) {
  const date = new Date(ms);
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const seconds = String(date.getUTCSeconds()).padStart(2, '0');
  const milliseconds = String(Math.floor(date.getUTCMilliseconds() / 10)).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}.${milliseconds}`;
}

function buildSrt(transcript: AssemblyTranscript) {
  if (!transcript.utterances || !transcript.utterances.length) {
    return null;
  }

  return transcript.utterances
    .map((utterance, index) => {
      const start = toSrtTimestamp(utterance.start);
      const end = toSrtTimestamp(utterance.end);
      const speaker = utterance.speaker ? `${utterance.speaker}: ` : '';
      return `${index + 1}\n${start} --> ${end}\n${speaker}${utterance.text}\n`;
    })
    .join('\n');
}

function buildVtt(transcript: AssemblyTranscript) {
  if (!transcript.utterances || !transcript.utterances.length) {
    return null;
  }

  const cues = transcript.utterances
    .map((utterance) => {
      const start = toVttTimestamp(utterance.start);
      const end = toVttTimestamp(utterance.end);
      const speaker = utterance.speaker ? `${utterance.speaker}: ` : '';
      return `${start} --> ${end}\n${speaker}${utterance.text}\n`;
    })
    .join('\n');

  return `WEBVTT\n\n${cues}`;
}

async function cleanTranscript(text: string, mode: CleanupMode, googleKey: string): Promise<CleanupResult> {
  const model = createGenerativeModel(googleKey, mode);
  const prompt = buildCleanupPrompt(text, mode);
  const result = await model.generateContent([
    {
      role: 'user',
      parts: [{ text: prompt }]
    }
  ]);
  const responseText = result.response.text();
  try {
    return parseCleanupResponse(responseText);
  } catch (error) {
    console.error('Gemini cleanup response parse error', error, responseText);
    throw new Error('Unable to parse cleanup response from Gemini.');
  }
}

async function processTranscript(
  text: string,
  mode: CleanupMode,
  googleKey: string,
  transcriptData?: AssemblyTranscript
) {
  const cleanup = await cleanTranscript(text, mode, googleKey);

  return {
    rawText: text,
    cleanedText: cleanup.cleanedText,
    corrections: cleanup.corrections ?? [],
    downloads: {
      txt: cleanup.cleanedText,
      srt: transcriptData ? buildSrt(transcriptData) : null,
      vtt: transcriptData ? buildVtt(transcriptData) : null
    }
  };
}

app.post(
  '/api/clean',
  asyncHandler(async (req, res) => {
    const { text, cleanupMode } = req.body as { text?: string; cleanupMode?: CleanupMode };
    if (!text || typeof text !== 'string') {
      res.status(400).send('A transcript text value is required.');
      return;
    }
    if (!isCleanupMode(cleanupMode)) {
      res.status(400).send('Invalid cleanup mode.');
      return;
    }
    const { googleKey, assemblyKey } = requireKeys(req.body as Record<string, unknown>);
    void assemblyKey; // assembly key unused for cleanup-only route but enforced for consistency.

    const response = await processTranscript(text, cleanupMode, googleKey);
    res.json(response);
  })
);

app.post(
  '/api/transcribe/upload',
  upload.single('media'),
  asyncHandler(async (req, res) => {
    const { cleanupMode } = req.body as { cleanupMode?: CleanupMode };
    if (!isCleanupMode(cleanupMode)) {
      res.status(400).send('Invalid cleanup mode.');
      return;
    }
    const { assemblyKey, googleKey } = requireKeys(req.body as Record<string, unknown>);
    if (!req.file) {
      res.status(400).send('A media file is required.');
      return;
    }

    const savedPath = req.file.path;
    const normalizedPath = await convertToWavIfNeeded(savedPath);
    const uploadUrl = await uploadToAssemblyAI(normalizedPath, assemblyKey);
    const transcriptId = await requestTranscript(uploadUrl, assemblyKey);
    const transcript = await pollTranscript(transcriptId, assemblyKey);

    const jsonPath = path.join(DATA_DIR, `${transcriptId}.json`);
    await fsPromises.writeFile(jsonPath, JSON.stringify(transcript, null, 2), 'utf8');

    const response = await processTranscript(transcript.text, cleanupMode, googleKey, transcript);
    res.json(response);
  })
);

app.post(
  '/api/transcribe/youtube',
  asyncHandler(async (req, res) => {
    const { url, cleanupMode } = req.body as { url?: string; cleanupMode?: CleanupMode };
    if (!url || typeof url !== 'string') {
      res.status(400).send('A YouTube URL is required.');
      return;
    }
    if (!isCleanupMode(cleanupMode)) {
      res.status(400).send('Invalid cleanup mode.');
      return;
    }
    const { assemblyKey, googleKey } = requireKeys(req.body as Record<string, unknown>);

    const audioPath = await fetchYoutubeAudio(url, DATA_DIR);
    const uploadUrl = await uploadToAssemblyAI(audioPath, assemblyKey);
    const transcriptId = await requestTranscript(uploadUrl, assemblyKey);
    const transcript = await pollTranscript(transcriptId, assemblyKey);

    const jsonPath = path.join(DATA_DIR, `${transcriptId}.json`);
    await fsPromises.writeFile(jsonPath, JSON.stringify(transcript, null, 2), 'utf8');

    const response = await processTranscript(transcript.text, cleanupMode, googleKey, transcript);
    res.json(response);
  })
);

if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
}

app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(error);
  res.status(500).send(error.message || 'Unexpected server error.');
});

app.listen(PORT, () => {
  console.log(`Transcript AI Codex server running on http://localhost:${PORT}`);
});
