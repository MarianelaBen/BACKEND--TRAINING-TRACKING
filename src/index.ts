import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import type { NextFunction, Request, Response } from 'express';
import { authRouter } from './routes/auth.routes.js';
import { studentRouter } from './routes/student.routes.js';
import { coachRouter } from './routes/coach.routes.js';

const app = express();
app.use(express.json());
// Sin cookies de sesión: la auth es por token en el header Authorization,
// así que no hace falta credentials:true (eso es sólo para cookies cross-domain).
app.use(cors({ origin: process.env.CORS_ORIGIN }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/auth', authRouter);
app.use('/student', studentRouter);
app.use('/coach', coachRouter);

// Sin esto, un error no controlado cae en el handler default de Express y
// devuelve HTML en vez de JSON, rompiendo el contrato de la API.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'Error interno' });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`API escuchando en http://localhost:${port}`);
});