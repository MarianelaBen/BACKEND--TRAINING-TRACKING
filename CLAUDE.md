# CLAUDE.md — chino-api (backend)

Backend de "Entrená con Chino". Este repo es SOLO la API. El front vive en un
repo aparte (`chino-web`) y le pega por HTTP.

## Qué es el producto

App de entrenamiento personalizado con dos roles:
- **Coach** (Chino): arma rutinas, las asigna a los días de cada alumno, ve
  adherencia e historial.
- **Alumno**: ve qué entrenar hoy, marca series, corre el descanso; su historial
  se arma solo con lo que marca.

La UI ya está resuelta en prototipos. Este repo aporta lo que falta: datos,
cuentas y la lógica que sincroniza ambas vistas.

## Stack

- Node + TypeScript + Express
- Prisma sobre PostgreSQL
- Auth por sesión/token con contraseñas hasheadas (argon2 o bcrypt)

## Contrato con el frontend (importante)

- El front es una app separada en otro dominio. Hay que habilitar **CORS** para
  el origen del front (variable `CORS_ORIGIN`).
- **Tipos compartidos:** como los repos están separados, definí los tipos de la
  API (Rutina, Bloque, Ejercicio, Sesión, etc.) en un archivo claro dentro de
  `src/types/` y mantené el front en sincronía a mano. Si duele, más adelante se
  puede publicar un paquete privado, pero para arrancar, a mano.
- **Auth entre dominios distintos:** si usás cookies de sesión, van a necesitar
  `SameSite=None; Secure` + CORS con credenciales. Alternativa más simple:
  auth por token en el header `Authorization`. Elegí una y dejala documentada.
  (Otra opción a nivel infra: servir front y API bajo el mismo dominio con un
  reverse proxy en Coolify, y así evitar CORS y el lío de cookies cross-domain.)

## Reglas

- **El rol se valida SIEMPRE en el backend.** Cada endpoint chequea si el
  usuario es coach o alumno y si tiene permiso sobre ese recurso concreto.
- Nada de secrets en el código. Todo por variables de entorno (ver `.env.example`).
- TypeScript estricto, sin `any` salvo necesidad real.
- Trabajar por etapas chicas y verificables.

## Modelo de datos

Ver `prisma/schema.prisma`. Sale directo de los prototipos: rutinas → bloques →
ejercicios; asignaciones de rutina a alumno por día; sesiones e historial que se
generan con lo que el alumno marca; marcas (progresión por ejercicio); chat.

## Orden sugerido

1. Esquema Prisma + migración inicial + seed con datos de los prototipos.
2. Auth (registro/login, sesiones, roles) + middleware de rol.
3. Endpoints de lectura para la vista alumno (rutina del día, semana).
4. Endpoint para marcar series → genera/actualiza sesión e historial.
5. Endpoints del coach (alumnos, ficha, adherencia).
6. Asignar rutina a alumno por día.
7. Chat.
8. Dockerfile + deploy en Coolify + backups de la DB.

## Nota de voz

Los textos que van al alumno (notas de bloque, mensajes) son en español
rioplatense, informales, en la voz de Chino: "Dale", "Bajá el press", "No hay
apuro". Directo y humano.
