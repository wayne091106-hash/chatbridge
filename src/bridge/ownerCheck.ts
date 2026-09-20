/**
 * The "is this really you?" tools.
 *
 * The chat asks the PC for a question, shows it to whoever is typing, and sends their reply back. The
 * answer never reaches the model in any useful form — it is hashed here and compared — and the model is
 * told not to guess, because the whole point is that only the owner can pass.
 */
import * as z from "zod";
import type { Runtime } from "../core/runtime.js";
import { answerQuestion, askQuestion, isVerified, questionCount, VERIFIED_MINUTES } from "../core/ownerQuiz.js";
import type { DefineTool } from "./tools.js";

export function registerOwnerCheck(define: DefineTool, rt: Runtime) {
  define(
    "owner_challenge",
    {
      title: "Ask the owner to identify themselves",
      description:
        "Get a personal question that only the owner of this PC can answer. Show it to the user word for word and wait for their reply — never answer it yourself, never guess, and never look for the answer on the PC. Then pass their reply to owner_answer.",
      input: {},
      effect: "read",
    },
    async () => {
      if (!questionCount()) return "No questions are set up on this PC, so there is nothing to check. Tell the user they can add some with `chatbridge quiz add`.";
      if (isVerified()) return "The owner is already verified for now — carry on with what you were doing.";
      const q = askQuestion();
      if (!q) return "No questions are set up on this PC.";
      return `Ask the user exactly this, and nothing else:\n\n${q.question}\n\nThen call owner_answer with what they type. Do not answer it yourself.`;
    },
  );

  define(
    "owner_answer",
    {
      title: "Check the owner's answer",
      description: "Send the user's reply to the question from owner_challenge, exactly as they wrote it. Do not correct, translate or complete it.",
      input: { answer: z.string().min(1).max(200).describe("What the user typed, verbatim") },
      effect: "read",
      privateArgs: true,
    },
    async (a) => {
      const r = answerQuestion(a.answer);
      if (r.ok) return `Correct — the owner is verified for the next ${VERIFIED_MINUTES} minutes. Carry on.`;
      return r.triesLeft > 0
        ? `That is not the answer (${r.triesLeft} tries left). Tell the user, and offer to try another question with owner_challenge.`
        : `That is not the answer, and there are no tries left on that question. Tell the user plainly that the check failed; do not carry on with what was blocked.`;
    },
  );
}
