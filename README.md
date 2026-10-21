# ⚙️ Getu Server (`getu-server`)

> High-performance Node.js & TypeScript backend for automated job applications, live multi-source vacancy discovery, ATS resume tailoring, real-time link freshness verification, and Playwright automation.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22.x-green?logo=node.js)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-4.21-lightgrey?logo=express)](https://expressjs.com/)
[![Playwright](https://img.shields.io/badge/Playwright-1.50-orange?logo=playwright)](https://playwright.dev/)
[![Vitest](https://img.shields.io/badge/Vitest-3.0-yellow?logo=vitest)](https://vitest.dev/)
[![Docker](https://img.shields.io/badge/Docker-Ready-blue?logo=docker)](https://www.docker.com/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## 📖 Overview

`getu-server` powers the Getu job application platform. It aggregates live tech vacancies across 16+ portals, validates application URLs with strict freshness verification, computes candidate qualification & skill match scores, generates tailored ATS-optimized resumes in PDF and DOCX, and executes end-to-end headless browser job applications.

---

## 🌟 Core Modules & Architecture

```
┌───────────────────────────────────────────────────────────────┐
│                          getu-server                          │
├───────────────┬───────────────────────────────┬───────────────┤
│  Live Search  │        Matching Engine        │  Automation   │
│  & Registry   │   • Skills Dictionary         │  & Playwright │
│  • 16+ Portals│   • BCA / B.Tech Eligibility  │  • Easy Apply │
│  • Freshness  │   • Delhi NCR Geo Clustering  │  • Form Fill  │
│  • De-duping  │   • ATS Keyword Coverage      │  • CAPTCHA Pa │
├───────────────┴───────────────────────────────┴───────────────┤
│                        Storage Layer                          │
│   • FileStoreAdapter (Zero-config local JSON persistence)     │
│   • SupabaseAdapter  (PostgreSQL cloud database)              │
└───────────────────────────────────────────────────────────────┘
```

### 1. 🔍 Live Multi-Source Job Discovery (`liveSearchService.ts`)
- **Portal Coverage**: Real-time integration and indexing across **LinkedIn**, **Naukri**, **Indeed**, **Internshala**, **Unstop**, **Foundit**, **TimesJobs**, **Cutshort**, **Instahyre**, **Wellfound**, **Glassdoor**, **Greenhouse**, **Lever**, **Ashby**, and company career sites.
- **Bulk Hiring Campaigns**: Curated authentic drives for TCS NQT, Cognizant GenC, Infosys Off-Campus, HCLTech Walk-in, Wipro Walk-in, and Accenture ASE.
- **De-Duplication Algorithm**: Canonicalizes identical job postings appearing on multiple job portals into a single record with multi-source URLs.
- **Link Freshness Verification**: Fast, non-destructive HTTP HEAD validation to confirm that vacancies are currently open (HTTP 200/300) or closed/expired (HTTP 404/410).

### 2. 🎯 Qualification & Candidate Match Engine (`matchingEngine.ts`)
- Multi-dimensional scoring: **Skills** (35%), **Experience** (25%), **Education** (15%), **Location** (15%), and **Title** (10%).
- Full eligibility recognition for **BCA**, **MCA**, **B.Tech**, **B.Sc (IT)** graduates.
- Entry-level / Fresher bonus: 100% experience eligibility for candidates with 0-1 years applying to junior roles.
- Delhi NCR locality grouping (Delhi, Noida, Greater Noida, Gurugram, Faridabad, Ghaziabad).

### 3. 🤖 Headless Automation & Browser Pool (`worker.ts` & `browserPool.ts`)
- Automated browser form-filling powered by **Playwright**.
- Two operating modes:
  - `dry-run`: Scans forms, answers screening questions, attaches tailored resume, but stops short of final submit.
  - `production`: Executes verified submissions with confirmation screenshots.
- Anti-bot and human-in-the-loop protection: Automatically detects CAPTCHAs and OTP challenges, pauses, and notifies the candidate.

### 4. 📄 Resume Tailoring & ATS Scoring (`resumes/`)
- Dynamically generates customized PDF (`pdfkit`) and Word DOCX (`docx`) files tailored to specific job descriptions.
- Calculates ATS keyword match scores, formatting compliance, and readability metrics.

---

## 🛠️ API Reference

### Jobs & Discovery Endpoints
| Method | Route | Description |
| :--- | :--- | :--- |
| `GET` | `/api/jobs` | Query jobs with filters (keyword, location, exp, salary, education, freshness) |
| `GET` | `/api/jobs/sources` | Returns all registered job sources, categories, and connection statuses |
| `GET` | `/api/jobs/export` | Export filtered jobs as formatted `CSV` or `JSON` |
| `POST` | `/api/jobs/live-search` | Trigger background multi-source discovery scan |
| `POST` | `/api/jobs/:id/verify` | Real-time HTTP HEAD live freshness verification of application URL |
| `POST` | `/api/jobs/:id/bookmark` | Bookmark / shortlist job opportunity |
| `DELETE`| `/api/jobs/:id/bookmark`| Remove job from candidate shortlist |
| `POST` | `/api/jobs/:id/track-application` | Update application stage (`applied`, `interviewing`, `offered`) & notes |

### Automation & Candidate Endpoints
| Method | Route | Description |
| :--- | :--- | :--- |
| `GET` | `/api/profile` | Retrieve candidate profile, skills, projects, and education |
| `PUT` | `/api/profile` | Update candidate profile & target roles |
| `GET` | `/api/resumes` | List candidate master resumes and customized versions |
| `POST` | `/api/automation/start` | Launch automated application batch runner |
| `GET` | `/api/automation/status`| Poll runner status, active steps, and progress logs |
| `GET` | `/health` | Health check and system operational mode |

---

## 🚀 Getting Started

### Prerequisites
- **Node.js**: `v20.x` or `v22.x`
- **npm**: `v10.x` or higher
- **Chromium / Playwright**: For automated browser testing

### 1. Installation
```bash
# Clone repository
git clone https://github.com/deepaksah11/getu-server.git
cd getu-server

# Install dependencies
npm install

# Install Playwright browser binaries
npx playwright install chromium
```

### 2. Configure Environment
Create a `.env` file in the root directory:
```bash
cp .env.example .env
```

Key environment options:
```env
PORT=5000
CLIENT_URL=http://localhost:5173
DATA_STORE=file
AUTOMATION_MODE=dry-run
AI_ENGINE=offline
LOG_LEVEL=info
```

### 3. Run Development Server
```bash
# Start server with tsx hot-reloading
npm run dev
```
The API server will listen on [http://localhost:5000](http://localhost:5000).

---

## 🧪 Testing & Type Checking

```bash
# Run unit & integration test suites
npm test

# Run tests in watch mode
npm run test:watch

# Validate TypeScript compilation
npm run typecheck
```

---

## 🐳 Docker & Cloud Deployment

### 1. Run with Docker Compose
```bash
# Build and run container with persistent ./data volume
docker-compose up -d --build

# View container logs
docker-compose logs -f
```

### 2. Standalone Docker Build
```bash
docker build -t getu-server:latest .
docker run -d -p 5000:5000 -v $(pwd)/data:/app/data --name getu-server getu-server:latest
```

### 3. Deploy to Render / Railway
1. Create a new **Web Service** pointing to your `getu-server` GitHub repository.
2. Select **Docker** as the Environment / Runtime.
3. Configure Environment Variables:
   - `PORT=5000`
   - `CLIENT_URL=https://your-frontend-domain.vercel.app`
   - `DATA_STORE=file` (or `supabase` with your connection keys)
   - `AUTOMATION_MODE=dry-run`
   - `AI_ENGINE=offline`
4. Deploy service!

---

## 📂 Project Structure

```
getu-server/
├── data/                   # Persistent local database & generated assets
│   ├── db.json             # Seeded database (jobs, profiles, applications)
│   ├── resumes/            # Generated PDF / DOCX resumes
│   └── screenshots/        # Submission confirmation screenshots
├── src/
│   ├── ai/                 # Skills dictionary & deterministic answer engine
│   ├── automation/         # Headless browser runners & live search
│   │   ├── browser/        # Playwright browser pooling & contexts
│   │   ├── engine/         # Form fillers, multi-step runners & verifiers
│   │   ├── liveSearch/     # Multi-source registry & link freshness engine
│   │   ├── platforms/      # Adapters (LinkedIn, Naukri, Internshala, etc.)
│   │   └── security/       # Session store & encrypted credential vault
│   ├── config/             # Environment validation, paths & Pino logger
│   ├── db/                 # Repository layer (FileStore & Supabase)
│   ├── matching/           # Candidate match calculation & eligibility checker
│   ├── queue/              # Application queue state machine & orchestrator
│   ├── resumes/            # ATS scoring, DOCX and PDF generators
│   ├── routes/             # Express API routes
│   ├── test/               # Vitest unit, API, and automation test suites
│   ├── types/              # Domain TypeScript interfaces
│   └── index.ts            # Application entrypoint & HTTP server
├── Dockerfile              # Production container with Playwright dependencies
├── docker-compose.yml      # Local container orchestration
├── package.json            # Scripts & dependencies
└── tsconfig.json           # TypeScript configuration
```

---

## 📜 Available Scripts

| Script | Command | Description |
| :--- | :--- | :--- |
| `npm run dev` | `tsx watch src/index.ts` | Runs server with hot reload |
| `npm run build` | `tsc` | Compiles TypeScript into `/dist` |
| `npm start` | `node dist/index.js` | Runs production compiled server |
| `npm test` | `vitest run` | Executes all test suites |
| `npm run typecheck` | `tsc --noEmit` | Validates TypeScript types |

---

## 🤝 Contributing & License

Distributed under the **MIT License**. Contributions, issues, and feature requests are welcome!
