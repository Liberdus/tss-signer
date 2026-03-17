import express, { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import fs from "fs/promises";
import path from "path";
import { verifySignedCoordinatorRequest } from "./auth";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Entry {
  key: string;
  value: string;
}
interface Index {
  key: string;
}
interface PartySignup {
  number: number;
  uuid: string;
}
interface Params {
  parties: string;
  threshold: string;
}

type Result<T> = { Ok: T } | { Err: string | null };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _paramsCache: Promise<Params> | null = null;
function loadParams(): Promise<Params> {
  if (!_paramsCache) {
    _paramsCache = fs
      .readFile(path.join(__dirname, "../../", "params.json"), "utf8")
      .then((data) => JSON.parse(data) as Params);
  }
  return _paramsCache;
}

// ---------------------------------------------------------------------------
// In-memory KV store — relay bus for TSS round messages
// ---------------------------------------------------------------------------

const db = new Map<string, string>();
db.set("signup-keygen", JSON.stringify({ number: 0, uuid: uuidv4() }));
db.set("signup-sign", JSON.stringify({ number: 0, uuid: uuidv4() }));

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerRoutes(app: express.Application): void {
  // POST /get — fetch a relay entry by key
  app.post(
    "/get",
    verifySignedCoordinatorRequest,
    (req: Request<{}, {}, Index>, res: Response<Result<Entry>>) => {
      const { key } = req.body;
      const v = db.get(key);
      if (v !== undefined) {
        res.json({ Ok: { key, value: v } });
      } else {
        res.status(404).json({ Err: null });
      }
    }
  );

  // POST /set — store a relay entry
  app.post(
    "/set",
    verifySignedCoordinatorRequest,
    (req: Request<{}, {}, Entry>, res: Response<Result<null>>) => {
      const { key, value } = req.body;
      db.set(key, value);
      res.json({ Ok: null });
    }
  );

  // POST /signupkeygen — round-robin keygen party signup
  app.post(
    "/signupkeygen",
    verifySignedCoordinatorRequest,
    async (_req: Request, res: Response<Result<PartySignup>>) => {
      try {
        const { parties } = await loadParams();
        const max = parseInt(parties, 10);
        const key = _req.body;

        const raw = db.get(key);
        let current: PartySignup | null = null;
        if (raw !== undefined) {
          try { current = JSON.parse(raw); } catch { /* ignore */ }
        }

        let next: PartySignup;
        if (current && current.number < max) {
          next = { number: current.number + 1, uuid: current.uuid };
        } else {
          next = { number: 1, uuid: uuidv4() };
        }

        db.set(key, JSON.stringify(next));
        console.log("signup-keygen →", key, JSON.stringify(next));
        res.json({ Ok: next });
      } catch (e) {
        console.error(e);
        res.status(404).json({ Err: null });
      }
    }
  );

  // POST /signupsign — round-robin sign party signup
  app.post(
    "/signupsign",
    verifySignedCoordinatorRequest,
    async (_req: Request, res: Response<Result<PartySignup>>) => {
      try {
        const { parties } = await loadParams();
        const max = parseInt(parties, 10);
        const key = _req.body;

        const raw = db.get(key);
        let current: PartySignup | null = null;
        if (raw !== undefined) {
          try { current = JSON.parse(raw); } catch { /* ignore */ }
        }

        let next: PartySignup;
        if (current && current.number < max) {
          next = { number: current.number + 1, uuid: current.uuid };
        } else {
          next = { number: 1, uuid: uuidv4() };
        }

        db.set(key, JSON.stringify(next));
        console.log("signup-sign →", key, JSON.stringify(next));
        res.json({ Ok: next });
      } catch (e) {
        console.error(e);
        res.status(404).json({ Err: null });
      }
    }
  );

  // POST /future-timestamp — first-write-wins distributed timestamp agreement
  app.post(
    "/future-timestamp",
    verifySignedCoordinatorRequest,
    (req: Request<{}, {}, Entry>, res: Response<{ timestamp: number }>) => {
      const { key, value } = req.body;
      const dbKey = "future-timestamp" + key;
      const dbValue = db.get(dbKey);
      if (dbValue == null) {
        db.set(dbKey, value);
        res.json({ timestamp: parseInt(value) });
        return;
      }
      res.json({ timestamp: parseInt(dbValue) });
    }
  );
}
