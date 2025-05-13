import express, { Request, Response } from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';

// --- Types matching your Rust models ---
interface Entry  { key: string; value: string; }
interface Index  { key: string; }
interface PartySignup { number: number; uuid: string; }
interface Params { parties: string; threshold: string; }

// --- A simple Result<T> type ---
type Result<T> = { Ok: T } | { Err: null };

// --- In-memory DB ---
const db = new Map<string,string>();

// Initialize signup entries at startup
const KEYGEN_KEY = 'signup-keygen';
const SIGN_KEY   = 'signup-sign';
db.set(KEYGEN_KEY, JSON.stringify({ number: 0, uuid: uuidv4() } as PartySignup));
db.set(SIGN_KEY,   JSON.stringify({ number: 0, uuid: uuidv4() } as PartySignup));

// --- Express app setup ---
const app = express();
app.use(cors({ origin: true, methods: ['GET','POST','PATCH'], credentials: true }));

app.use(express.text({ type: 'application/json' }));
app.use((req, res, next) => {
  if (req.body && typeof req.body === 'string') {
    try {
      req.body = JSON.parse(req.body);
    } catch (e) {
      // Log but continue
      console.warn('Failed to parse JSON body', e);
    }
  }
  next();
});

// POST /get  — fetch an Entry by key
app.post('/get', (req: Request<{}, {}, Index>, res: Response<Result<Entry>>) => {
  const { key } = req.body;
  const v = db.get(key);
  if (v !== undefined) {
    const entry: Entry = { key, value: v };
    res.json({ Ok: entry });
  } else {
    res.status(404).json({ Err: null });
  }
});

// POST /set  — store an Entry
app.post('/set', (req: Request<{}, {}, Entry>, res: Response<Result<null>>) => {
  const { key, value } = req.body;
  db.set(key, value);
  res.json({ Ok: null });
});

// Helper to load params.json
async function loadParams(): Promise<Params> {
  const data = await fs.readFile(path.join(__dirname, '../../', 'params.json'), 'utf8');
  return JSON.parse(data) as Params;
}

// POST /signupkeygen  — round-robin keygen signup
app.post('/signupkeygen', async (_req, res: Response<Result<PartySignup>>) => {
  try {
    const { parties } = await loadParams();
    const max = parseInt(parties, 10);

    console.log("Signup keygen request body:", _req.body);
    const key = _req.body;

    const raw = db.get(key)!;
    let current: PartySignup | null = null;
    try {
      current = JSON.parse(raw);
    } catch (e) {
      console.error('Failed to parse current signup: creating new one');
    }

    let next: PartySignup;
    if (current && current.number < max) {
      next = { number: current.number + 1, uuid: current.uuid };
    } else {
      next = { number: 1, uuid: uuidv4() };
    }

    db.set(key, JSON.stringify(next));
    console.log('signup-keygen →', key, JSON.stringify(next));
    res.json({ Ok: next });
  } catch (e) {
    console.error(e);
    res.status(404).json({ Err: null });
  }
});

// POST /signupsign  — round-robin sign signup
app.post('/signupsign', async (_req, res: Response<Result<PartySignup>>) => {
  try {
    const { threshold } = await loadParams();
    const max = parseInt(threshold, 10) + 1;
    const key = _req.body;
    console.log("Signup sign request body:", _req.body);

    const raw = db.get(key)!;
    let current: PartySignup | null = null;
    try {
      current = JSON.parse(raw);
    } catch (e) {
      console.error('Failed to parse current signup: creating new one');
    }

    let next: PartySignup;
    if (current && current.number < max) {
      next = { number: current.number + 1, uuid: current.uuid };
    } else {
      next = { number: 1, uuid: uuidv4() };
    }

    db.set(key, JSON.stringify(next));
    console.log('signup-sign →', key, JSON.stringify(next));
    res.json({ Ok: next });
  } catch (e) {
    console.error(e);
    res.status(404).json({ Err: null });
  }
});

// Start the server
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
