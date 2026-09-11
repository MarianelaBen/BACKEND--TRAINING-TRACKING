import { randomUUID } from 'node:crypto';
import { mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExerciseCatalogItem } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';

export const EXERCISE_VIDEO_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../uploads/exercises',
);

await mkdir(EXERCISE_VIDEO_DIR, { recursive: true });

const EXTENSION_BY_MIME: Record<string, string> = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
};

const upload = multer({
  storage: multer.diskStorage({
    destination: EXERCISE_VIDEO_DIR,
    filename: (_req, file, callback) => {
      callback(null, `${randomUUID()}${EXTENSION_BY_MIME[file.mimetype]}`);
    },
  }),
  limits: { fileSize: 100 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (!EXTENSION_BY_MIME[file.mimetype]) {
      callback(new Error('El video tiene que ser MP4, WebM o MOV'));
      return;
    }
    callback(null, true);
  },
});

export function uploadExerciseVideo(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  upload.single('video')(req, res, (error: unknown) => {
    if (!error) {
      next();
      return;
    }
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: 'El video no puede superar los 100 MB' });
      return;
    }
    res.status(400).json({
      error: error instanceof Error ? error.message : 'No se pudo leer el video',
    });
  });
}

export function exerciseVideoUrl(filename: string | null): string | null {
  return filename
    ? `/uploads/exercises/${encodeURIComponent(filename)}`
    : null;
}

export function toExerciseCatalogItem(item: ExerciseCatalogItem) {
  const { videoFilename, ...publicItem } = item;
  return {
    ...publicItem,
    videoUrl: exerciseVideoUrl(videoFilename),
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

export async function removeExerciseVideo(filename: string | null) {
  if (!filename) return;
  try {
    await unlink(path.join(EXERCISE_VIDEO_DIR, path.basename(filename)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
