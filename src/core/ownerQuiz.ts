/**
 * "Is this really you?" — a light identity check made of questions only the owner can answer.
 *
 * It is not a password: the point is that a chat which has been talked into doing something drastic (by a
 * web page, a README, a pasted instruction) cannot pass it, because the answer lives in the owner's head.
 *
 * Answers are never stored. Each question keeps a random salt and sha256(salt + normalised answer), so the
 * file tells an attacker nothing about the owner, and neither does anyone reading this repository.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "./config.js";
import { randomId, randomToken, safeEqual, sha256 } from "./util.js";

export interface QuizItem {
  id: string;
  question: string;
  salt: string;
  hash: string;
  /** Accepted alternatives are stored as extra hashes (same salt), e.g. a short and a long form. */
  altHashes?: string[];
  addedAt: string;
  asked?: number;
  lastAskedAt?: number;
}

interface QuizFile {
  items: QuizItem[];
  /** Epoch ms until which the owner counts as verified. */
  verifiedUntil?: number;
  pending?: { id: string; askedAt: number; tries: number };
}

const file = (dir = dataDir()) => path.join(dir, "owner-quiz.json");

/** How long one correct answer counts for. */
export const VERIFIED_MINUTES = 30;
const MAX_TRIES = 3;

function read(dir?: string): QuizFile {
  const f = file(dir);
  if (!existsSync(f)) return { items: [] };
  try {
    const parsed = JSON.parse(readFileSync(f, "utf8")) as QuizFile;
    return { items: Array.isArray(parsed.items) ? parsed.items : [], verifiedUntil: parsed.verifiedUntil, pending: parsed.pending };
  } catch {
    return { items: [] };
  }
}

function write(q: QuizFile, dir = dataDir()) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file(dir), JSON.stringify(q, null, 2) + "\n", { mode: 0o600 });
}

/**
 * Answers are compared loosely on purpose: the owner is typing from memory, in a chat, possibly on a phone.
 * Case, spaces, punctuation and full-width characters are all levelled out.
 */
export function normaliseAnswer(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s　]+/g, "")
    .replace(/[.,!?;:'"`~()[\]{}<>。，！？、；：「」『』（）]/g, "");
}

const digest = (salt: string, answer: string) => sha256(`${salt}:${normaliseAnswer(answer)}`);

export function addQuestion(question: string, answer: string, alternatives: string[] = [], dir?: string): QuizItem {
  const q = read(dir);
  const salt = randomToken(12);
  const item: QuizItem = {
    id: randomId("q", 3),
    question: question.trim(),
    salt,
    hash: digest(salt, answer),
    altHashes: alternatives.filter((a) => a.trim()).map((a) => digest(salt, a)),
    addedAt: new Date().toISOString(),
  };
  q.items.push(item);
  write(q, dir);
  return item;
}

export function removeQuestion(id: string, dir?: string): boolean {
  const q = read(dir);
  const before = q.items.length;
  q.items = q.items.filter((i) => i.id !== id);
  write(q, dir);
  return q.items.length < before;
}

export function listQuestions(dir?: string): Array<Pick<QuizItem, "id" | "question" | "asked">> {
  return read(dir).items.map((i) => ({ id: i.id, question: i.question, asked: i.asked ?? 0 }));
}

export function isVerified(dir?: string): boolean {
  const until = read(dir).verifiedUntil ?? 0;
  return until > Date.now();
}

export function clearVerification(dir?: string) {
  const q = read(dir);
  delete q.verifiedUntil;
  delete q.pending;
  write(q, dir);
}

/** Picks a question, preferring ones asked least often and not the one asked last. */
export function askQuestion(dir?: string): { id: string; question: string; of: number } | null {
  const q = read(dir);
  if (!q.items.length) return null;
  const lastId = q.pending?.id;
  const pool = q.items.length > 1 ? q.items.filter((i) => i.id !== lastId) : q.items;
  const fewest = Math.min(...pool.map((i) => i.asked ?? 0));
  const candidates = pool.filter((i) => (i.asked ?? 0) === fewest);
  const pick = candidates[Math.floor(Math.random() * candidates.length)]!;
  pick.asked = (pick.asked ?? 0) + 1;
  pick.lastAskedAt = Date.now();
  q.pending = { id: pick.id, askedAt: Date.now(), tries: 0 };
  write(q, dir);
  return { id: pick.id, question: pick.question, of: q.items.length };
}

export type AnswerResult = { ok: true; verifiedUntil: number } | { ok: false; reason: string; triesLeft: number };

export function answerQuestion(answer: string, dir?: string): AnswerResult {
  const q = read(dir);
  if (!q.pending) return { ok: false, reason: "no question is waiting — ask for one first", triesLeft: MAX_TRIES };
  const item = q.items.find((i) => i.id === q.pending!.id);
  if (!item) return { ok: false, reason: "that question no longer exists", triesLeft: MAX_TRIES };
  // A question left hanging for an hour is stale; a later answer should not unlock anything.
  if (Date.now() - q.pending.askedAt > 3600_000) {
    delete q.pending;
    write(q, dir);
    return { ok: false, reason: "that question is too old — ask for a new one", triesLeft: MAX_TRIES };
  }
  const given = digest(item.salt, answer);
  const hit = safeEqual(given, item.hash) || (item.altHashes ?? []).some((h) => safeEqual(given, h));
  if (hit) {
    q.verifiedUntil = Date.now() + VERIFIED_MINUTES * 60_000;
    delete q.pending;
    write(q, dir);
    return { ok: true, verifiedUntil: q.verifiedUntil };
  }
  q.pending.tries++;
  const triesLeft = MAX_TRIES - q.pending.tries;
  if (triesLeft <= 0) delete q.pending;
  write(q, dir);
  return { ok: false, reason: triesLeft > 0 ? "that is not it" : "too many tries — ask for a new question", triesLeft: Math.max(0, triesLeft) };
}

export function questionCount(dir?: string): number {
  return read(dir).items.length;
}
