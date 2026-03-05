# GeoTracker PWA (Full Stack)

PWA mobile-first de tracking com autenticação real e CRUD de usuários em PostgreSQL.

## Stack

- Frontend: HTML, CSS, Vanilla JS, Leaflet + OpenStreetMap
- Backend: Node.js + Express
- Banco: PostgreSQL
- Auth: JWT + bcrypt

## Campos de Usuario

- Nome (`firstName`)
- Sobrenome (`lastName`)
- Email (`email`)
- Senha (`password`)

## API CRUD de Usuarios

- `POST /api/users` cria usuario
- `GET /api/users` lista usuarios (autenticado)
- `GET /api/users/:id` busca usuario por id (autenticado)
- `PUT /api/users/:id` atualiza usuario (autenticado, dono da conta)
- `DELETE /api/users/:id` remove usuario (autenticado, dono da conta)

## Auth

- `POST /api/auth/login`
- `GET /api/auth/me`

## Tracking

- `POST /api/location` (autenticado)

## Variaveis de ambiente

Use o arquivo `.env` (ja criado) ou copie de `.env.example`.

```env
PORT=8080
JWT_SECRET=geo_tracker_prod_secret_change_me
DB_HOST=72.60.158.28
DB_PORT=9182
DB_USER=bielmicro
DB_PASSWORD=Piloofab123!
DB_NAME=db-prd-tracker
DB_SSL=false
```

## Rodar local

```bash
npm install
npm start
```

Acesse: `http://localhost:8080`

## Deploy no Easypanel

- Runtime: Node
- Install command: `npm install`
- Start command: `npm start`
- Porta: `8080`
- Garanta as env vars acima no app

## Observacoes

- O schema do banco e criado automaticamente ao iniciar (`users` e `locations`).
- As senhas sao armazenadas com hash (`bcrypt`).
- O frontend agora permite cadastro e login reais.
