import { Chess } from 'chess.js';
import { z } from 'zod';
import { LESSON_GROUPS } from '../material.js';
import { tablebaseEligible } from '../tablebase/judge.js';

/** A Syzygy material key such as `KRPvKR`. */
export const MaterialKeySchema = z.string().regex(/^K[QRBNP]*vK[QRBNP]*$/);

const legalFen = (fen: string): boolean => {
  try {
    new Chess(fen);
    return true;
  } catch {
    return false;
  }
};

const sideToMove = (fen: string): 'white' | 'black' =>
  fen.trim().split(/\s+/)[1] === 'b' ? 'black' : 'white';

/**
 * One lesson of the endgame course (ADR-025 §6). The start position must be legal, have the
 * user to move and be tablebase-eligible (≤ 7 pieces, no castling rights).
 */
export const LessonSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    group: z.enum(LESSON_GROUPS),
    title: z.string().min(1).max(80),
    fen: z.string().min(1).max(100),
    userSide: z.enum(['white', 'black']),
    goal: z.enum(['win', 'draw']),
    /** win: user moves allowed; draw: opponent moves the user must hold out. */
    budget: z.number().int().min(1).max(200),
    /** Material keys needed to play the lesson offline. */
    tables: z.array(MaterialKeySchema).min(1),
    text: z.string().min(1),
    hints: z.array(z.string().min(1)).min(1),
    advanced: z.boolean().optional(),
  })
  .refine((l) => legalFen(l.fen), { message: 'illegal FEN', path: ['fen'] })
  .refine((l) => sideToMove(l.fen) === l.userSide, {
    message: 'the user must be to move',
    path: ['fen'],
  })
  .refine((l) => tablebaseEligible(l.fen), {
    message: 'not tablebase-eligible (> 7 pieces or castling rights)',
    path: ['fen'],
  });

export type Lesson = z.infer<typeof LessonSchema>;
